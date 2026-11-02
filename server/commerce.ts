import { randomUUID } from 'node:crypto';
import { text, num, bool, rows, istDate, type Data, type Entity } from '../shared/model.js';
import { Context } from './context.js';
import { requireThat } from './store.js';
import { checkedMedicines } from './clinical.js';
import { documentCommand } from './documents.js';
import { packageQuote, readPayerRates, completeRefund, refundNeedsApproval, linePaidShare, parseDenominations, counterSummary, discountBill, requireUnusedAdvance } from './finance.js';
import { denominationTotal, coveredChargeTypes } from '../shared/finance.js';

const paise = (value: number) => Math.round(value * 100);
function requireCounter(ctx: Context) {
  requireThat(!ctx.all('counterClose').some(e => text(e.data, 'counter') === ctx.actor.counter && text(e.data, 'date') === istDate(ctx.now()) && ['Closed', 'Accounts sent', 'Pending approval'].includes(e.status)), 'This counter is closed or awaiting reconciliation. Use another open counter or open the next day.');
}
function issueBatch(ctx: Context, batchId: string, itemId: string, quantity: number, store = 'Pharmacy') {
  const batch = ctx.get(batchId, 'batch');
  requireThat(text(batch.data, 'itemId') === itemId && text(batch.data, 'store') === store, `Choose a matching batch from ${store}.`);
  requireThat(text(batch.data, 'expiry') >= istDate(ctx.now()) && batch.status === 'Available', 'This batch is expired or unavailable. Choose an unexpired available batch.');
  requireThat(Number.isInteger(quantity) && quantity > 0 && quantity <= num(batch.data, 'quantity'), 'The requested quantity exceeds available stock.');
  ctx.update(batch, { quantity: num(batch.data, 'quantity') - quantity });
  return batch;
}
function approvalEffect(ctx: Context, approval: Entity) {
  const kind = text(approval.data, 'kind'); const target = ctx.get(text(approval.data, 'targetId'));
  const effect = approval.data.effect;
  requireThat(effect && typeof effect === 'object' && !Array.isArray(effect), 'Approval effect is unavailable. Raise a new request.');
  switch (kind) {
    case 'Discount': {
      discountBill(ctx, target, num(effect, 'percent'), text(approval.data, 'reason'), approval.id); break;
    }
    case 'Refund': {
      completeRefund(ctx, target, approval.id); break;
    }
    case 'Purchase': ctx.update(target, { approvalId: approval.id }, 'Approved'); break;
    case 'Write-off': {
      const batch = ctx.get(text(target.data, 'batchId'), 'batch'); const quantity = num(target.data, 'quantity');
      requireThat(quantity <= num(batch.data, 'quantity'), 'Stock changed after the request. Reconcile and request again.');
      ctx.update(batch, { quantity: num(batch.data, 'quantity') - quantity });
      ctx.update(target, { approvalId: approval.id, completedAt: ctx.now() }, 'Completed'); break;
    }
    case 'Tariff':
      requireThat(text(target.data, 'effective') > istDate(ctx.now()), 'The effective date is no longer in the future. Submit a revised price proposal.');
      ctx.update(target, { approvalId: approval.id }, 'Active'); break;
    case 'Package':
      ctx.update(target, { approvalId: approval.id }, 'Active'); break;
    case 'Package rates':
      requireThat(text(target.data, 'effective') > istDate(ctx.now()), 'The package rate’s effective date passed. Submit a revised future date.');
      ctx.update(target, { approvalId: approval.id }, 'Active'); break;
    case 'Item price':
      requireThat(text(target.data, 'effective') > istDate(ctx.now()), 'The effective date passed. Propose a new future date.');
      ctx.update(target, { approvalId: approval.id }, 'Approved'); break;
    case 'Stock count': {
      const batch = ctx.get(text(target.data, 'batchId'), 'batch');
      requireThat(num(batch.data, 'quantity') === num(target.data, 'priorQuantity'), 'Stock moved since the count. Recount instead of overwriting newer stock.');
      ctx.update(batch, { quantity: num(target.data, 'counted') });
      ctx.update(target, { approvalId: approval.id }, 'Applied'); break;
    }
    case 'Cash difference': ctx.update(target, { approvalId: approval.id, closedAt: ctx.now(), signedOffBy: ctx.actor.id, signedOffAt: ctx.now() }, 'Closed'); break;
    case 'Claim deduction': {
      ctx.update(target, { approvalId: approval.id, settledAt: ctx.now() }, 'Settled');
      if (text(target.data, 'deductionOwner') === 'Patient') {
        const bill = ctx.charge(target.patientId!, 'Approved insurer deduction - patient share', num(target.data, 'deduction'), `${target.id}-deduction`, { claimId: target.id }, text(target.data, 'admissionId'));
        ctx.update(bill, { postSettlement: true, approvalId: approval.id });
      } else ctx.create('accountsAdjustment', { name: 'Approved hospital-owned insurer deduction', claimId: target.id, amount: num(target.data, 'deduction'), owner: 'Hospital', approvalId: approval.id, ledgerMaintained: false }, 'Ready for accounts', { patientId: target.patientId });
      break;
    }
    case 'Discharge credit': ctx.update(target, { creditApproved: true, creditApproval: approval.id }); break;
    default: requireThat(false, 'This approval type needs support. No change was applied.');
  }
}
export function commerceCommand(name: string, ctx: Context): boolean {
  const p = ctx.p;
  switch (name) {
    case 'counter.choose': {
      const person = ctx.store.person(ctx.actor.id);
      person.counter = ctx.t('counter'); person.preferences = { ...person.preferences, printer: ctx.t('printer') }; ctx.store.savePerson(person);
      ctx.result = { counter: person.counter, printer: ctx.t('printer') }; break;
    }
    case 'bill.service': {
      const patient = ctx.patient(); const selected = ctx.get(ctx.t('tariffId'), 'tariff');
      const tariff = ctx.tariff(text(selected.data, 'code'), text(patient.data, 'payer'));
      const localHour = Number(new Date(new Date(ctx.now()).getTime() + 330 * 60000).toISOString().slice(11, 13));
      const unit = num(tariff.data, 'rate') + (ctx.b('emergency') ? num(tariff.data, 'emergencyExtra') : 0) + (localHour >= 22 || localHour < 6 ? num(tariff.data, 'nightExtra') : 0);
      const admission = ctx.all('admission').find(e => e.patientId === patient.id && e.status === 'Admitted');
      ctx.bill(patient.id, text(tariff.data, 'name'), [{ id: randomUUID(), name: text(tariff.data, 'name'), quantity: ctx.n('quantity'), unit, total: unit * ctx.n('quantity'), tariffId: tariff.id }], ctx.request.operationId, admission?.id); break;
    }
    case 'bill.discount': {
      const bill = ctx.targetOf('bill');
      requireThat(num(bill.data, 'paid') === 0 && text(bill.data, 'discountStatus') !== 'Pending', 'This bill is paid or already awaiting discount approval.');
      const threshold = ctx.actor.role === 'pharmacist' ? 5 : num(ctx.store.setting<Data>('rules', {}), 'discount', 10);
      if (ctx.n('percent') > threshold || num(bill.data, 'subtotal') * ctx.n('percent') / 100 > 50000) {
        ctx.update(bill, { discountStatus: 'Pending', discountReason: ctx.t('reason') });
        ctx.approval('Discount', bill.id, { percent: ctx.n('percent') }, ctx.t('reason'), Math.round(num(bill.data, 'subtotal') * ctx.n('percent') / 100));
      } else {
        discountBill(ctx, bill, ctx.n('percent'), ctx.t('reason'));
      } break;
    }
    case 'bill.pay': {
      const bill = ctx.targetOf('bill'); ctx.patient(bill.patientId);
      if (bool(bill.data, 'isAdvance')) requireThat(!text(ctx.get(text(bill.data, 'admissionId'), 'admission').data, 'finalBillId'), 'A final bill already exists. Pay that bill instead of this earlier deposit request.');
      requireThat(text(bill.data, 'discountStatus') !== 'Pending', 'This discount still needs approval. Payment and printing are on hold.');
      if (ctx.actor.role !== 'patient') requireCounter(ctx);
      const payments = rows(p, 'payments');
      requireThat(payments.length > 0 && payments.length <= 3, 'Enter one or more payment modes.');
      requireThat(new Set(payments.map(x => text(x, 'mode'))).size === payments.length, 'Use each payment mode only once.');
      for (const payment of payments) requireThat((ctx.actor.role === 'patient' ? ['UPI', 'Card'] : ['Cash', 'UPI', 'Card']).includes(text(payment, 'mode')) && num(payment, 'amount') > 0, 'Enter positive amounts for valid payment modes.');
      const total = payments.reduce((sum, payment) => sum + paise(num(payment, 'amount')), 0);
      requireThat(total === num(bill.data, 'total') - num(bill.data, 'paid'), 'The split payments must exactly match the amount due.');
      const failed = ctx.t('outcome') === 'Failure' || ctx.store.setting<Data>('faults', {}).provider === 'Failure';
      const counter = ctx.actor.role === 'patient' ? 'Online' : ctx.actor.counter;
      const payment = ctx.create('payment', { name: failed ? 'Failed simulated payment' : 'Payment receipt', billId: bill.id, admissionId: text(bill.data, 'admissionId'), isAdvance: bool(bill.data, 'isAdvance'), payments: payments.map(line => ({ mode: text(line, 'mode'), amount: paise(num(line, 'amount')) })), total, counter, simulated: true, receipt: failed ? '' : `RECEIPT-${ctx.all('payment').filter(e => e.status === 'Paid').length + 1}`, failure: failed ? 'Simulated provider declined. No money was collected.' : '' }, failed ? 'Failed' : 'Paid', { patientId: bill.patientId });
      if (!failed) {
        ctx.update(bill, { paid: num(bill.data, 'paid') + total, paidAt: ctx.now(), receiptId: payment.id }, 'Paid');
        for (const order of ctx.all('order').filter(e => e.status === 'Payment pending' && (text(e.data, 'billId') === bill.id || text(e.data, 'packageId') === text(bill.data, 'sourceId')))) ctx.update(order, { clearedAt: ctx.now() }, 'Cleared');
        ctx.message(bill.patientId!, 'Payment receipt available', payment.id, 'SMS', 'bills');
      }
      ctx.result = { outcome: failed ? 'Failed' : 'Paid', paymentId: payment.id }; break;
    }
    case 'claim.create': {
      const patient = ctx.patient(); const admission = ctx.get(ctx.t('admissionId'), 'admission');
      requireThat(admission.patientId === patient.id, 'The patient and admission must match.');
      requireThat(ctx.t('payer') === text(patient.data, 'payer'), 'Use the payer registered for this patient.');
      const quote = packageQuote(ctx.store, ctx.t('packageId'), ctx.t('payer'));
      if (['Ayushman', 'CGHS'].includes(ctx.t('payer'))) {
        requireThat(text(quote, 'kind') === 'Scheme treatment', 'Choose a scheme-treatment master package.');
        requireThat(paise(ctx.n('amount')) === num(quote, 'rate'), 'The requested scheme amount must equal the published package rate. Cashiers cannot type a different price.');
      }
      requireThat(!ctx.all('claim').some(claim => text(claim.data, 'admissionId') === admission.id && !['Rejected', 'Eligibility failed', 'Cancelled'].includes(claim.status) &&
        (!text(claim.data, 'validUntil') || text(claim.data, 'validUntil') >= istDate(ctx.now()))), 'This admission already has an open or valid claim. Continue that claim instead of creating duplicate cover.');
      const outcome = ctx.store.setting<Data>('faults', {}).provider === 'Failure' ? 'Provider unavailable' : ctx.t('eligibilityOutcome', 'Eligible');
      requireThat(outcome !== 'Eligible' || ctx.n('amount') <= ctx.n('cover'), 'Requested amount exceeds the simulated cover. Review the payer share.');
      const state = outcome === 'Eligible' ? 'Draft' : 'Eligibility failed';
      ctx.create('claim', { ...p, name: `${ctx.t('payer')} pre-authorisation`, amount: paise(ctx.n('amount')), requested: paise(ctx.n('amount')), cover: paise(ctx.n('cover')), packageQuote: quote,
        diagnosisFromDoctor: text(admission.data, 'diagnosis'), simulated: true, eligibilityAttempts: [{ at: ctx.now(), outcome, actor: ctx.actor.id, simulated: true }],
        history: [{ status: state, at: ctx.now(), actor: ctx.actor.id }] }, state, { patientId: patient.id, doctorId: admission.doctorId });
      ctx.result = { eligibility: outcome }; break;
    }
    case 'claim.retryEligibility': {
      const claim = ctx.targetOf('claim');
      const outcome = ctx.store.setting<Data>('faults', {}).provider === 'Failure' ? 'Provider unavailable' : ctx.t('outcome');
      requireThat(outcome !== 'Eligible' || paise(ctx.n('cover')) >= num(claim.data, 'requested'), 'Available cover is below the request. Reconcile the package or request before retrying.');
      ctx.update(claim, { cover: paise(ctx.n('cover')), eligibilityAttempts: [...rows(claim.data, 'eligibilityAttempts'), { at: ctx.now(), outcome, reason: ctx.t('reason'), actor: ctx.actor.id, simulated: true }] }, outcome === 'Eligible' ? 'Draft' : 'Eligibility failed'); break;
    }
    case 'claim.reconcilePackage': {
      const claim = ctx.targetOf('claim'); const admission = ctx.get(text(claim.data, 'admissionId'), 'admission');
      requireThat(!text(admission.data, 'finalBillId'), 'A final bill already exists. Do not silently rewrite its agreed package.');
      const quote = packageQuote(ctx.store, ctx.t('packageId'), text(claim.data, 'payer'));
      if (['Ayushman', 'CGHS'].includes(text(claim.data, 'payer'))) requireThat(text(quote, 'kind') === 'Scheme treatment', 'Choose a scheme-treatment master package.');
      ctx.update(claim, { packageId: ctx.t('packageId'), packageQuote: quote, amount: num(quote, 'rate'), requested: num(quote, 'rate'), approvedAmount: 0, validUntil: '',
        history: [...rows(claim.data, 'history'), { status: 'Package reconciled; fresh approval required', at: ctx.now(), actor: ctx.actor.id, reason: ctx.t('reason') }] }, 'Draft'); break;
    }
    case 'claim.send': {
      const claim = ctx.targetOf('claim');
      ctx.update(claim, { documents: ctx.t('documents'), history: [...rows(claim.data, 'history'), { status: 'Sent', at: ctx.now(), actor: ctx.actor.id, reply: ctx.t('documents') }] }, 'Sent'); break;
    }
    case 'claim.question': {
      const claim = ctx.targetOf('claim');
      ctx.create('question', { ...p, kind: 'Insurance', name: 'Insurer clarification for consultant', sourceId: claim.id }, 'Open', { patientId: claim.patientId, doctorId: claim.doctorId }); break;
    }
    case 'claim.response': {
      const claim = ctx.targetOf('claim');
      if (ctx.t('decision') === 'Approved') requireThat(paise(ctx.n('approvedAmount')) <= Math.min(num(claim.data, 'cover'), num(claim.data, 'requested')) && ctx.n('approvedAmount') >= 0 && ctx.t('validUntil') >= istDate(ctx.now()), 'Enter an approved amount within requested cover and a valid expiry date.');
      ctx.update(claim, { approvedAmount: paise(ctx.n('approvedAmount')), validUntil: ctx.t('validUntil'), response: ctx.t('response'), history: [...rows(claim.data, 'history'), { status: ctx.t('decision'), at: ctx.now(), actor: ctx.actor.id }] }, ctx.t('decision')); break;
    }
    case 'claim.final': {
      const claim = ctx.targetOf('claim'); const admission = ctx.get(text(claim.data, 'admissionId'), 'admission');
      requireThat(admission.status === 'Discharged', 'Submit the final claim only after discharge.');
      const bill = ctx.get(text(admission.data, 'finalBillId'), 'bill');
      ctx.update(claim, { claimedAt: ctx.now(), finalBillId: bill.id, claimedAmount: Math.min(num(claim.data, 'approvedAmount'), num(bill.data, 'insurerShare')) }, 'Claim sent'); break;
    }
    case 'claim.settle': {
      const claim = ctx.targetOf('claim');
      requireThat(claim.status === 'Claim sent', 'Submit the final discharge claim before settlement.');
      const settled = paise(ctx.n('settled'));
      const claimed = num(claim.data, 'claimedAmount', num(claim.data, 'approvedAmount'));
      requireThat(settled <= claimed, 'Settlement cannot exceed the final claimed amount.');
      const deduction = claimed - settled;
      ctx.update(claim, { settled, deduction, deductionOwner: ctx.t('deductionOwner'), reason: ctx.t('reason') }, deduction ? 'Deduction approval pending' : 'Settled');
      if (deduction) ctx.approval('Claim deduction', claim.id, {}, ctx.t('reason'), deduction); break;
    }
    case 'refund.request': {
      const bill = ctx.get(ctx.t('billId'), 'bill');
      requireThat(bill.status === 'Paid', 'Only paid bill lines can be refunded.');
      const line = rows(bill.data, 'lines').find(line => text(line, 'id') === ctx.t('lineId'));
      requireThat(line, 'Choose a valid bill line ID.');
      const value = paise(ctx.n('amount'));
      requireUnusedAdvance(ctx, bill, value);
      const netLine = linePaidShare(bill, ctx.t('lineId'));
      const prior = ctx.all('refund').filter(e => text(e.data, 'billId') === bill.id && text(e.data, 'lineId') === ctx.t('lineId') && e.status !== 'Declined').reduce((n, e) => n + num(e.data, 'amount'), 0);
      requireThat(value > 0 && value + prior <= netLine, 'Refund exceeds the remaining discounted paid amount for this line.');
      const refund = ctx.create('refund', { ...p, name: `Refund ${text(bill.data, 'number')}`, amount: value, counter: ctx.actor.counter }, 'Pending approval', { patientId: bill.patientId });
      if (ctx.t('returnId')) {
        const returned = ctx.get(ctx.t('returnId'), 'return');
        requireThat(returned.status === 'Credit needs review' && text(returned.data, 'dispenseId') === text(bill.data, 'sourceId') && num(returned.data, 'credit') === value, 'Choose this bill’s unresolved pharmacy credit with the exact recorded amount.');
        ctx.update(returned, { pendingRefundId: refund.id }, 'Refund approval pending');
      }
      if (refundNeedsApproval(ctx, bill, value)) ctx.approval('Refund', refund.id, {}, ctx.t('reason'), value);
      else completeRefund(ctx, refund);
      break;
    }
    case 'counter.close': {
      requireCounter(ctx);
      const denominations = parseDenominations(p.denominations);
      requireThat(denominationTotal(denominations) === ctx.n('countedCash'), 'Counted cash must equal the denomination breakdown.');
      const summary = counterSummary(ctx.store, ctx.actor.counter);
      const counted = paise(ctx.n('countedCash')); const expected = num(summary, 'expectedCash'); const difference = counted - expected;
      requireThat(difference === 0 || ctx.t('reason'), 'Enter a reason for the cash difference.');
      const needsApproval = Math.abs(difference) > paise(num(ctx.store.setting<Data>('rules', {}), 'cashDifference', 100));
      const close = ctx.create('counterClose', { ...summary, ...p, countedCash: counted, denominations, name: `${ctx.actor.counter} ${istDate(ctx.now())}`, expected, counted, difference,
        signedOffBy: needsApproval ? '' : ctx.actor.id, signedOffAt: needsApproval ? '' : ctx.now() }, needsApproval ? 'Pending approval' : 'Closed');
      if (needsApproval) ctx.approval('Cash difference', close.id, {}, ctx.t('reason'), Math.abs(difference)); break;
    }
    case 'counter.sendAccounts': {
      const close = ctx.targetOf('counterClose');
      requireThat(ctx.actor.role === 'manager' || close.createdBy === ctx.actor.id, 'Only the counter owner or operations may send this report.');
      const failed = ctx.store.setting<Data>('faults', {}).provider === 'Failure';
      ctx.update(close, { accountsAttempts: [...rows(close.data, 'accountsAttempts'), { at: ctx.now(), by: ctx.actor.id, status: failed ? 'Failed' : 'Delivered', simulated: true }], ledgerMaintained: false }, failed ? 'Closed' : 'Accounts sent');
      ctx.result = { delivery: failed ? 'Failed - retry after restoring the simulated provider' : 'Simulated delivery only; no ledger created' }; break;
    }
    case 'pharmacy.receive':
      ctx.update(ctx.targetOf('rx'), { receivedBy: ctx.actor.id, receivedAt: ctx.now() }, 'Received'); break;
    case 'pharmacy.paperRx': {
      const patient = ctx.patient();
      requireThat(ctx.t('prescriptionDate') <= istDate(ctx.now()), 'The paper prescription cannot be dated in the future.');
      const lines = checkedMedicines(ctx, patient.id, rows(p, 'lines'));
      const upload = new Context(ctx.store, ctx.actor, { ...ctx.request, payload: { patientId: patient.id, kind: 'Paper prescription', file: p.file, synthetic: true } });
      documentCommand('document.upload', upload); ctx.touched.push(...upload.touched);
      ctx.create('rx', { name: `Paper prescription - ${ctx.t('prescriberName')}`, source: 'Paper', prescriberName: ctx.t('prescriberName'), prescriberRegistration: ctx.t('registration'),
        prescriptionDate: ctx.t('prescriptionDate'), scanDocumentId: upload.touched[0], lines, rxVersion: 1, enteredBy: ctx.actor.id,
        authorId: `paper:${ctx.t('registration')}`, receivedAt: ctx.now(), receivedBy: ctx.actor.id, attestation: 'Synthetic paper transcription; not a new clinical prescription' },
      'Received', { patientId: patient.id, doctorId: ctx.t('reviewingDoctorId') || undefined });
      break;
    }
    case 'pharmacy.question': {
      const rx = ctx.targetOf('rx'); const line = rows(rx.data, 'lines').find(l => text(l, 'id') === ctx.t('lineId'));
      requireThat(rx.doctorId && ctx.store.person(rx.doctorId).state === 'Active', 'No active in-app consultant can authorize this paper prescription’s substitution. Keep the original or obtain a newly reviewed prescription.');
      requireThat(line, 'Choose an existing prescription line.');
      const original = ctx.get(text(line, 'itemId'), 'item'); const proposed = ctx.get(ctx.t('proposedItemId'), 'item');
      requireThat(proposed.status === 'Active' && proposed.id !== original.id && text(original.data, 'salt') === text(proposed.data, 'salt') && text(original.data, 'strength') === text(proposed.data, 'strength'), 'The proposed substitute must be a different active item with the same salt and strength.');
      ctx.create('question', { ...p, name: 'Pharmacy substitution question', kind: 'Pharmacy', sourceId: rx.id, rxVersion: num(rx.data, 'rxVersion'), question: ctx.t('reason') }, 'Open', { patientId: rx.patientId, doctorId: rx.doctorId }); break;
    }
    case 'pharmacy.dispense': {
      const rx = ctx.targetOf('rx'); const lines = rows(rx.data, 'lines'); const line = lines.find(l => text(l, 'id') === ctx.t('lineId'));
      requireThat(line, 'Choose a current prescription line.');
      const quantity = ctx.n('quantity'); requireThat(quantity + num(line, 'dispensed') <= num(line, 'quantity'), 'This quantity exceeds the remaining prescribed quantity.');
      const batch = ctx.get(ctx.t('batchId'), 'batch');
      const near = new Date(text(batch.data, 'expiry')).getTime() - new Date(istDate(ctx.now())).getTime() < 30 * 86400000;
      requireThat(!near || ctx.b('nearExpiry'), 'This batch expires within 30 days. Review and confirm the warning.');
      issueBatch(ctx, batch.id, text(line, 'itemId'), quantity);
      const item = ctx.get(text(line, 'itemId'), 'item');
      requireThat(num(batch.data, 'mrp') <= num(item.data, 'mrp'), 'Batch price exceeds the item MRP. Correct the master before issuing.');
      const total = quantity * num(batch.data, 'mrp'); const taxable = Math.round(total / (1 + num(item.data, 'gst') / 100));
      const gst = total - taxable; const cgst = Math.floor(gst / 2);
      const admission = ctx.all('admission').find(e => e.patientId === rx.patientId && e.status === 'Admitted');
      const dispense = ctx.create('dispense', { name: text(item.data, 'name'), rxId: rx.id, rxVersion: num(rx.data, 'rxVersion'), lineId: ctx.t('lineId'), itemId: item.id, batchId: batch.id, batch: text(batch.data, 'batch'), expiry: text(batch.data, 'expiry'), quantity, returned: 0, mrp: num(batch.data, 'mrp'), taxable, cgst, sgst: gst - cgst, total, hsn: text(item.data, 'hsn'), gstin: 'SAMPLE-GSTIN', drugLicence: 'SAMPLE-LICENCE', admissionId: admission?.id ?? '' }, 'Issued', { patientId: rx.patientId, doctorId: rx.doctorId });
      line.dispensed = num(line, 'dispensed') + quantity;
      ctx.update(rx, { lines, receivedAt: text(rx.data, 'receivedAt') || ctx.now() }, lines.every(l => num(l, 'dispensed') >= num(l, 'quantity')) ? 'Dispensed' : 'Part dispensed');
      const bill = ctx.charge(rx.patientId!, `Pharmacy: ${text(item.data, 'name')}`, total, dispense.id, { batch: text(batch.data, 'batch'), expiry: text(batch.data, 'expiry'), quantity, taxable, cgst, sgst: gst - cgst, hsn: text(item.data, 'hsn'), gstin: 'SAMPLE-GSTIN', drugLicence: 'SAMPLE-LICENCE' }, admission?.id);
      ctx.update(dispense, { billId: bill.id });
      if (text(item.data, 'schedule') === 'H1') ctx.create('register', { name: 'Schedule H1 dispense', kind: 'H1', dispenseId: dispense.id }, 'Recorded', { patientId: rx.patientId });
      break;
    }
    case 'pharmacy.return': {
      const dispense = ctx.targetOf('dispense'); const quantity = ctx.n('quantity'); const item = ctx.get(text(dispense.data, 'itemId'), 'item');
      requireThat(new Date(ctx.now()).getTime() - new Date(dispense.createdAt).getTime() <= 7 * 86400000, 'This issue is outside the seven-day return window.');
      requireThat(quantity <= num(dispense.data, 'quantity') - num(dispense.data, 'returned'), 'You cannot return more than the remaining issued quantity.');
      requireThat(!bool(item.data, 'coldChain'), 'Cold-chain items cannot be returned for resale.');
      const bill = ctx.get(text(dispense.data, 'billId'), 'bill');
      const originalNet = num(bill.data, 'total') + num(bill.data, 'returnCredit');
      const priorCredits = ctx.all('return').filter(entry => text(entry.data, 'dispenseId') === dispense.id).reduce((sum, entry) => sum + num(entry.data, 'credit'), 0);
      const remaining = num(dispense.data, 'quantity') - num(dispense.data, 'returned');
      const credit = quantity === remaining ? originalNet - priorCredits : Math.floor(originalNet * quantity / num(dispense.data, 'quantity'));
      requireThat(credit >= 0 && credit + priorCredits <= originalNet, 'This return would exceed the original discounted charge.');
      const batch = ctx.get(text(dispense.data, 'batchId'), 'batch');
      if (ctx.t('condition') === 'Unopened') ctx.update(batch, { quantity: num(batch.data, 'quantity') + quantity });
      else ctx.create('damaged', { name: text(item.data, 'name'), batchId: batch.id, quantity, reason: ctx.t('reason') }, 'Quarantined');
      ctx.update(dispense, { returned: num(dispense.data, 'returned') + quantity });
      const ret = ctx.create('return', { ...p, name: `Return ${text(item.data, 'name')}`, dispenseId: dispense.id, batchId: batch.id, credit }, bill.status === 'Paid' && credit > 0 ? 'Refund approval pending' : 'Credited', { patientId: dispense.patientId });
      if (bill.status === 'Paid' && credit > 0) {
        const refund = ctx.create('refund', { name: 'Pharmacy return credit', billId: bill.id, lineId: text(rows(bill.data, 'lines')[0], 'id'), amount: credit, reason: ctx.t('reason'), returnId: ret.id, counter: ctx.actor.counter }, 'Pending approval', { patientId: bill.patientId });
        if (refundNeedsApproval(ctx, bill, credit)) ctx.approval('Refund', refund.id, {}, ctx.t('reason'), credit);
        else completeRefund(ctx, refund);
      } else if (bill.status !== 'Paid') {
        const sourceLine = rows(bill.data, 'lines')[0] ?? {};
        const taxable = originalNet ? Math.round(num(sourceLine, 'taxable') * credit / originalNet) : 0;
        const tax = credit - taxable;
        ctx.update(bill, { total: num(bill.data, 'total') - credit, returnCredit: num(bill.data, 'returnCredit') + credit,
          lines: [...rows(bill.data, 'lines'), { id: randomUUID(), name: 'Accepted pharmacy return', quantity, total: -credit, taxable: -taxable, cgst: -Math.floor(tax / 2), sgst: -(tax - Math.floor(tax / 2)), returnId: ret.id }] },
        num(bill.data, 'total') - credit === 0 ? 'Paid' : bill.status);
      }
      break;
    }
    case 'ward.request': {
      const admission = ctx.admission(); const order = ctx.get(ctx.t('orderId'), 'wardOrder');
      requireThat(order.status === 'Active' && text(order.data, 'kind') === 'Medicine' && text(order.data, 'admissionId') === admission.id, 'Choose a signed medicine order for this admission.');
      ctx.create('wardRequest', { ...p, name: text(order.data, 'instruction'), itemId: text(order.data, 'itemId'), issued: 0 }, 'Requested', { patientId: admission.patientId, doctorId: admission.doctorId }); break;
    }
    case 'ward.issue': {
      const request = ctx.targetOf('wardRequest'); const admission = ctx.get(text(request.data, 'admissionId'), 'admission');
      requireThat(admission.status === 'Admitted', 'Ward issues need an active admission.');
      requireThat(ctx.n('quantity') <= num(request.data, 'quantity') - num(request.data, 'issued'), 'Quantity exceeds the remaining ward request.');
      const batch = issueBatch(ctx, ctx.t('batchId'), text(request.data, 'itemId'), ctx.n('quantity'));
      const total = ctx.n('quantity') * num(batch.data, 'mrp');
      const issue = ctx.create('dispense', { name: 'Ward medicine issue', wardRequestId: request.id, admissionId: admission.id, itemId: text(request.data, 'itemId'), batchId: batch.id, quantity: ctx.n('quantity'), returned: 0, total }, 'Issued', { patientId: admission.patientId, doctorId: admission.doctorId });
      const bill = ctx.charge(admission.patientId!, 'Ward pharmacy issue', total, issue.id, { quantity: ctx.n('quantity'), batch: text(batch.data, 'batch') }, admission.id);
      ctx.update(issue, { billId: bill.id });
      const issued = num(request.data, 'issued') + ctx.n('quantity'); ctx.update(request, { issued }, issued === num(request.data, 'quantity') ? 'Issued' : 'Part issued'); break;
    }
    case 'requisition.create': {
      const item = ctx.get(ctx.t('itemId'), 'item'); requireThat(item.status === 'Active', 'Choose an active item.');
      ctx.create('requisition', { ...p, name: `Requisition ${text(item.data, 'name')}`, issued: 0, accepted: 0 }, 'Requested'); break;
    }
    case 'purchase.create': {
      const req = ctx.get(ctx.t('requisitionId'), 'requisition'); const vendor = ctx.get(ctx.t('vendorId'), 'vendor');
      requireThat(vendor.status === 'Active', 'This vendor is blocked. Choose an active vendor.');
      requireThat(ctx.n('quantity') <= num(req.data, 'quantity') - num(req.data, 'accepted'), 'PO quantity exceeds the remaining requisition.');
      const total = paise(ctx.n('unitCost')) * ctx.n('quantity'); const needs = total > paise(num(ctx.store.setting<Data>('rules', {}), 'purchase', 50000));
      const po = ctx.create('purchase', { ...p, name: `PO ${ctx.all('purchase').length + 1}`, itemId: text(req.data, 'itemId'), unitCost: paise(ctx.n('unitCost')), total, received: 0 }, needs ? 'Pending approval' : 'Approved');
      if (needs) ctx.approval('Purchase', po.id, {}, ctx.t('reason'), total); break;
    }
    case 'purchase.send':
      requireThat(ctx.get(text(ctx.targetOf('purchase').data, 'vendorId'), 'vendor').status === 'Active', 'Vendor was blocked. Choose an authorized replacement before ordering.');
      ctx.update(ctx.targetOf('purchase'), { sentAt: ctx.now(), simulated: true }, 'Sent'); break;
    case 'grn.receive': {
      const po = ctx.targetOf('purchase'); const item = ctx.get(text(po.data, 'itemId'), 'item');
      requireThat(ctx.n('quantity') + ctx.n('damaged') + num(po.data, 'received') <= num(po.data, 'quantity'), 'Receipt exceeds the remaining PO quantity.');
      const expiry = new Date(ctx.t('expiry')).getTime(); const today = new Date(istDate(ctx.now())).getTime();
      requireThat(expiry > today, 'Cannot receive expired stock.');
      requireThat(expiry - today >= 180 * 86400000 || (ctx.b('shortExpiry') && ctx.t('reason')), 'Short-expiry receipt requires explicit acceptance and a reason.');
      const held = paise(ctx.n('mrp')) !== num(item.data, 'mrp');
      ctx.create('grn', { ...p, name: `GRN ${ctx.t('invoice')}`, purchaseId: po.id, itemId: item.id, mrp: paise(ctx.n('mrp')), holdReason: held ? 'MRP differs from the item master. Correct master and re-receive.' : '' }, held ? 'Held' : 'Received');
      if (!held) {
        const received = num(po.data, 'received') + ctx.n('quantity') + ctx.n('damaged');
        ctx.create('batch', { name: `${ctx.t('batch')} central`, itemId: item.id, batch: ctx.t('batch'), quantity: ctx.n('quantity'), expiry: ctx.t('expiry'), mrp: paise(ctx.n('mrp')), store: 'Central', purchaseId: po.id }, 'Available');
        ctx.update(po, { received }, received === num(po.data, 'quantity') ? 'Received' : 'Part received');
      } break;
    }
    case 'stock.issue': {
      const req = ctx.get(ctx.t('requisitionId'), 'requisition');
      requireThat(ctx.n('quantity') <= num(req.data, 'quantity') - num(req.data, 'issued'), 'Issue exceeds remaining requisition.');
      const batch = issueBatch(ctx, ctx.t('batchId'), text(req.data, 'itemId'), ctx.n('quantity'), 'Central');
      ctx.create('stockTransfer', { ...p, name: `Transfer ${text(batch.data, 'batch')}`, itemId: text(req.data, 'itemId'), sourceBatchId: batch.id, batch: text(batch.data, 'batch'), expiry: text(batch.data, 'expiry'), mrp: num(batch.data, 'mrp'), from: 'Central', to: 'Pharmacy' }, 'In transit');
      ctx.update(req, { issued: num(req.data, 'issued') + ctx.n('quantity') }, 'In transit'); break;
    }
    case 'stock.accept': {
      const transfer = ctx.targetOf('stockTransfer');
      const batch = ctx.all('batch').find(e => text(e.data, 'itemId') === text(transfer.data, 'itemId') && text(e.data, 'batch') === text(transfer.data, 'batch') && text(e.data, 'store') === 'Pharmacy');
      if (batch) ctx.update(batch, { quantity: num(batch.data, 'quantity') + num(transfer.data, 'quantity') });
      else ctx.create('batch', { ...transfer.data, name: `${text(transfer.data, 'batch')} pharmacy`, store: 'Pharmacy' }, 'Available');
      ctx.update(transfer, { acceptedAt: ctx.now(), acceptedBy: ctx.actor.id }, 'Accepted');
      const req = ctx.get(text(transfer.data, 'requisitionId'), 'requisition'); const accepted = num(req.data, 'accepted') + num(transfer.data, 'quantity');
      ctx.update(req, { accepted }, accepted === num(req.data, 'quantity') ? 'Completed' : 'Part received'); break;
    }
    case 'stock.writeoff': {
      const batch = ctx.get(ctx.t('batchId'), 'batch'); requireThat(ctx.n('quantity') <= num(batch.data, 'quantity'), 'Write-off exceeds the available batch quantity.');
      const writeoff = ctx.create('writeoff', { ...p, name: `Write-off ${text(batch.data, 'batch')}`, value: ctx.n('quantity') * num(batch.data, 'mrp') }, 'Pending approval');
      ctx.approval('Write-off', writeoff.id, {}, ctx.t('reason'), ctx.n('quantity') * num(batch.data, 'mrp')); break;
    }
    case 'stock.reconcile': {
      const batch = ctx.targetOf('batch'); requireThat(Number.isInteger(ctx.n('counted')), 'Stock count must be a whole number.');
      const difference = ctx.n('counted') - num(batch.data, 'quantity'); const value = Math.abs(difference) * num(batch.data, 'mrp');
      const count = ctx.create('stockCount', { ...p, name: `Count ${text(batch.data, 'batch')}`, batchId: batch.id, priorQuantity: num(batch.data, 'quantity'), difference, value }, value > 100000 ? 'Pending approval' : 'Applied');
      if (value > 100000) ctx.approval('Stock count', count.id, {}, ctx.t('reason'), value);
      else ctx.update(batch, { quantity: ctx.n('counted') }); break;
    }
    case 'vendor.save':
      ctx.create('vendor', p, 'Active'); break;
    case 'vendor.block':
      ctx.update(ctx.targetOf('vendor'), { reason: ctx.t('reason') }, 'Blocked'); break;
    case 'asset.save':
      requireThat(!ctx.all('asset').some(e => text(e.data, 'number') === ctx.t('number')), 'Asset number already exists.');
      ctx.create('asset', { ...p, history: [] }, 'Available'); break;
    case 'asset.service': {
      const asset = ctx.targetOf('asset');
      ctx.update(asset, { serviceDue: ctx.t('serviceDue'), history: [...rows(asset.data, 'history'), { at: ctx.now(), note: ctx.t('note'), actor: ctx.actor.id, status: ctx.t('status') }] }, ctx.t('status')); break;
    }
    case 'tariff.propose': {
      const tariff = ctx.get(ctx.t('tariffId'), 'tariff');
      requireThat(ctx.t('effective') > istDate(ctx.now()), 'A price change must start on a future date.');
      const proposal = ctx.create('tariff', { ...tariff.data, payer: ctx.t('payer'), rate: paise(ctx.n('rate')),
        nightExtra: typeof p.nightExtra === 'number' ? paise(ctx.n('nightExtra')) : num(tariff.data, 'nightExtra'), emergencyExtra: typeof p.emergencyExtra === 'number' ? paise(ctx.n('emergencyExtra')) : num(tariff.data, 'emergencyExtra'),
        effective: ctx.t('effective'), reason: ctx.t('reason'), previousId: tariff.id }, 'Pending approval');
      ctx.approval('Tariff', proposal.id, {}, ctx.t('reason'), paise(ctx.n('rate'))); break;
    }
    case 'item.create':
      ctx.create('item', { ...p, mrp: paise(ctx.n('mrp')) }, 'Active'); break;
    case 'item.retire':
      ctx.update(ctx.targetOf('item'), { retiredReason: ctx.t('reason') }, 'Retired'); break;
    case 'item.price': {
      const item = ctx.targetOf('item');
      requireThat(ctx.t('effective') > istDate(ctx.now()), 'MRP corrections must start on a future date.');
      const change = ctx.create('itemPrice', { ...p, name: `MRP ${text(item.data, 'name')}`, itemId: item.id, mrp: paise(ctx.n('mrp')) }, 'Pending approval');
      ctx.approval('Item price', change.id, {}, ctx.t('reason'), paise(ctx.n('mrp'))); break;
    }
    case 'payer.create':
      ctx.create('payer', p, 'Active'); break;
    case 'bed.create':
      requireThat(!ctx.all('bed').some(e => text(e.data, 'name') === ctx.t('name')), 'Bed number already exists.');
      ctx.create('bed', { ...p, dailyRate: paise(ctx.n('dailyRate')) }, 'Free'); break;
    case 'package.create':
    {
      for (const id of Array.isArray(p.tests) ? p.tests : []) requireThat(typeof id === 'string' && ctx.get(id, 'test').status === 'Active', 'Use active catalog tests.');
      const rawRates = p.payerRates && typeof p.payerRates === 'object' && !Array.isArray(p.payerRates) ? p.payerRates : {};
      const rates = readPayerRates(rawRates, paise(ctx.n('price')));
      const kind = ctx.t('kind', 'Health check-up');
      requireThat(kind !== 'Health check-up' || (Array.isArray(p.tests) && p.tests.length > 0), 'A health check-up package needs at least one test.');
      if (kind === 'Scheme treatment') requireThat(Array.isArray(p.coveredTypes) && p.coveredTypes.length > 0 && p.coveredTypes.every(value => typeof value === 'string' && coveredChargeTypes.includes(value)) && (rates.Ayushman !== undefined || rates.CGHS !== undefined), 'A scheme package needs an Ayushman/CGHS rate and explicit covered charge types.');
      const pkg = ctx.create('package', { ...p, kind, price: paise(ctx.n('price')), payerRates: rates }, 'Pending approval');
      ctx.approval('Package', pkg.id, {}, 'New package and rate publication', paise(ctx.n('price'))); break;
    }
    case 'package.proposeRates': {
      const pkg = ctx.get(ctx.t('packageId'), 'package');
      requireThat(ctx.t('effective') > istDate(ctx.now()), 'New package rates must take effect on a future date.');
      const raw = p.payerRates; requireThat(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length, 'Enter at least one future payer rate.');
      const priorRate = ctx.all('packageRate').filter(rate => text(rate.data, 'packageId') === pkg.id && rate.status === 'Active' && text(rate.data, 'effective') <= istDate(ctx.now())).sort((a, b) => text(b.data, 'effective').localeCompare(text(a.data, 'effective')))[0];
      const rawPrior = priorRate?.data.payerRates ?? pkg.data.payerRates;
      const prior = rawPrior && typeof rawPrior === 'object' && !Array.isArray(rawPrior) ? rawPrior : { Self: num(pkg.data, 'price') };
      const proposal = ctx.create('packageRate', { name: `Rates: ${text(pkg.data, 'name')}`, packageId: pkg.id, payerRates: { ...prior, ...readPayerRates(raw) }, effective: ctx.t('effective'), reason: ctx.t('reason') }, 'Pending approval');
      ctx.approval('Package rates', proposal.id, {}, ctx.t('reason')); break;
    }
    case 'approval.decide': {
      const approval = ctx.targetOf('approval');
      requireThat(text(approval.data, 'requestedBy') !== ctx.actor.id, 'You cannot approve your own request. Sign in as a different manager.');
      if (ctx.t('decision') === 'Approve') approvalEffect(ctx, approval);
      else {
        const target = ctx.get(text(approval.data, 'targetId'));
        if (text(approval.data, 'kind') === 'Discount') ctx.update(target, { discountStatus: 'Declined', approvalReason: ctx.t('reason') });
        else if (text(approval.data, 'kind') !== 'Discharge credit') {
          ctx.update(target, { approvalReason: ctx.t('reason') }, 'Declined');
          if (text(approval.data, 'kind') === 'Refund' && text(target.data, 'returnId')) ctx.update(ctx.get(text(target.data, 'returnId'), 'return'), { reviewReason: ctx.t('reason') }, 'Credit needs review');
        }
      }
      ctx.update(approval, { decidedBy: ctx.actor.id, decidedAt: ctx.now(), decisionReason: ctx.t('reason') }, ctx.t('decision') === 'Approve' ? 'Approved' : 'Declined'); break;
    }
    case 'rules.save':
      ctx.store.set('rules', { ...p, changedBy: ctx.actor.id, changedAt: ctx.now() }); break;
    case 'job.run': {
      const job = ctx.targetOf('job'); const outcome = ctx.t('outcome');
      ctx.create('jobRun', { name: `${text(job.data, 'name')} ${ctx.now()}`, jobId: job.id, job: text(job.data, 'name'), ranAt: ctx.now(), simulated: true }, outcome);
      ctx.update(job, { lastRun: ctx.now(), result: outcome, nextRun: new Date(new Date(ctx.now()).getTime() + 86400000).toISOString() });
      if (outcome === 'Success' && text(job.data, 'name') === 'Appointment reminders') {
        for (const visit of ctx.all('visit').filter(e => e.status === 'Booked' && text(e.data, 'date') >= istDate(ctx.now()))) ctx.message(visit.patientId!, 'Appointment reminder', `${visit.id}-${istDate(ctx.now())}`, 'WhatsApp', 'appointments');
      }
      break;
    }
    case 'patient.updates':
      for (const id of ctx.actor.patientIds) {
        const prior = ctx.all('updates').find(e => e.patientId === id);
        if (prior) ctx.update(prior, p); else ctx.create('updates', { ...p, name: 'WhatsApp preferences' }, 'Active', { patientId: id });
      }
      break;
    default: return false;
  }
  return true;
}
