import { randomUUID } from 'node:crypto';
import { text, num, bool, rows, istDate, type Data, type Entity } from '../shared/model.js';
import { Context } from './context.js';
import { requireThat } from './store.js';

const paise = (value: number) => Math.round(value * 100);
function requireCounter(ctx: Context) {
  requireThat(!ctx.all('counterClose').some(e => text(e.data, 'counter') === ctx.actor.counter && text(e.data, 'date') === istDate(ctx.now()) && ['Closed', 'Pending approval'].includes(e.status)), 'This counter is closed or awaiting reconciliation. Use another open counter or open the next day.');
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
      requireThat(target.status === 'Unpaid' && num(target.data, 'paid') === 0, 'This bill changed after the discount request.');
      const discount = Math.round(num(target.data, 'subtotal') * num(effect, 'percent') / 100);
      ctx.update(target, { discount, total: num(target.data, 'subtotal') - discount, discountStatus: 'Approved', approvalId: approval.id }); break;
    }
    case 'Refund': {
      const bill = ctx.get(text(target.data, 'billId'), 'bill');
      const credited = ctx.all('refund').filter(e => e.status === 'Completed' && text(e.data, 'billId') === bill.id).reduce((sum, e) => sum + num(e.data, 'amount'), 0);
      requireThat(credited + num(target.data, 'amount') <= num(bill.data, 'paid'), 'This refund would exceed the remaining paid amount.');
      const payment = ctx.all('payment').find(e => text(e.data, 'billId') === bill.id && e.status === 'Paid');
      ctx.update(target, { completedAt: ctx.now(), creditNumber: `CREDIT-${ctx.all('refund').filter(e => e.status === 'Completed').length + 1}`, originalModes: payment ? rows(payment.data, 'payments') : [], approvalId: approval.id }, 'Completed');
      ctx.update(bill, { refunded: num(bill.data, 'refunded') + num(target.data, 'amount') }); break;
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
    case 'Item price':
      requireThat(text(target.data, 'effective') > istDate(ctx.now()), 'The effective date passed. Propose a new future date.');
      ctx.update(target, { approvalId: approval.id }, 'Approved'); break;
    case 'Stock count': {
      const batch = ctx.get(text(target.data, 'batchId'), 'batch');
      requireThat(num(batch.data, 'quantity') === num(target.data, 'priorQuantity'), 'Stock moved since the count. Recount instead of overwriting newer stock.');
      ctx.update(batch, { quantity: num(target.data, 'counted') });
      ctx.update(target, { approvalId: approval.id }, 'Applied'); break;
    }
    case 'Cash difference': ctx.update(target, { approvalId: approval.id, closedAt: ctx.now() }, 'Closed'); break;
    case 'Claim deduction': ctx.update(target, { approvalId: approval.id, settledAt: ctx.now() }, 'Settled'); break;
    case 'Discharge credit': ctx.update(target, { creditApproved: true, creditApproval: approval.id }); break;
    default: requireThat(false, 'This approval type needs support. No change was applied.');
  }
}
export function commerceCommand(name: string, ctx: Context): boolean {
  const p = ctx.p;
  switch (name) {
    case 'counter.choose':
      ctx.actor.counter = ctx.t('counter'); ctx.actor.preferences.printer = ctx.t('printer'); ctx.store.savePerson(ctx.actor);
      ctx.result = { counter: ctx.actor.counter, printer: ctx.t('printer') }; break;
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
      const threshold = num(ctx.store.setting<Data>('rules', {}), 'discount', 10);
      if (ctx.n('percent') > threshold || num(bill.data, 'subtotal') * ctx.n('percent') / 100 > 50000) {
        ctx.update(bill, { discountStatus: 'Pending', discountReason: ctx.t('reason') });
        ctx.approval('Discount', bill.id, { percent: ctx.n('percent') }, ctx.t('reason'), Math.round(num(bill.data, 'subtotal') * ctx.n('percent') / 100));
      } else {
        const discount = Math.round(num(bill.data, 'subtotal') * ctx.n('percent') / 100);
        ctx.update(bill, { discount, total: num(bill.data, 'subtotal') - discount, discountReason: ctx.t('reason'), discountStatus: 'Approved' });
      } break;
    }
    case 'bill.pay': {
      const bill = ctx.targetOf('bill'); ctx.patient(bill.patientId);
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
      requireThat(ctx.n('amount') <= ctx.n('cover'), 'Requested amount exceeds the simulated cover. Review the payer share.');
      ctx.create('claim', { ...p, name: `${ctx.t('payer')} pre-authorisation`, requested: paise(ctx.n('amount')), cover: paise(ctx.n('cover')), simulated: true, history: [{ status: 'Draft', at: ctx.now(), actor: ctx.actor.id }] }, 'Draft', { patientId: patient.id, doctorId: admission.doctorId }); break;
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
      if (ctx.t('decision') === 'Approved') requireThat(paise(ctx.n('approvedAmount')) <= num(claim.data, 'cover') && ctx.n('approvedAmount') >= 0 && ctx.t('validUntil') >= istDate(ctx.now()), 'Enter an approved amount within cover and a valid expiry date.');
      ctx.update(claim, { approvedAmount: paise(ctx.n('approvedAmount')), validUntil: ctx.t('validUntil'), response: ctx.t('response'), history: [...rows(claim.data, 'history'), { status: ctx.t('decision'), at: ctx.now(), actor: ctx.actor.id }] }, ctx.t('decision')); break;
    }
    case 'claim.final': {
      const claim = ctx.targetOf('claim'); const admission = ctx.get(text(claim.data, 'admissionId'), 'admission');
      requireThat(admission.status === 'Discharged', 'Submit the final claim only after discharge.');
      ctx.update(claim, { claimedAt: ctx.now(), finalBillId: text(admission.data, 'finalBillId') }, 'Claim sent'); break;
    }
    case 'claim.settle': {
      const claim = ctx.targetOf('claim');
      requireThat(claim.status === 'Claim sent', 'Submit the final discharge claim before settlement.');
      const settled = paise(ctx.n('settled'));
      requireThat(settled <= num(claim.data, 'approvedAmount'), 'Settlement cannot exceed the approved amount.');
      const deduction = num(claim.data, 'approvedAmount') - settled;
      ctx.update(claim, { settled, deduction, deductionOwner: ctx.t('deductionOwner'), reason: ctx.t('reason') }, deduction ? 'Deduction approval pending' : 'Settled');
      if (deduction) ctx.approval('Claim deduction', claim.id, {}, ctx.t('reason'), deduction); break;
    }
    case 'refund.request': {
      const bill = ctx.get(ctx.t('billId'), 'bill');
      requireThat(bill.status === 'Paid', 'Only paid bill lines can be refunded.');
      const line = rows(bill.data, 'lines').find(line => text(line, 'id') === ctx.t('lineId'));
      requireThat(line, 'Choose a valid bill line ID.');
      const value = paise(ctx.n('amount'));
      const netLine = Math.round(num(line, 'total') * num(bill.data, 'total') / Math.max(1, num(bill.data, 'subtotal')));
      const prior = ctx.all('refund').filter(e => text(e.data, 'billId') === bill.id && text(e.data, 'lineId') === ctx.t('lineId') && e.status !== 'Declined').reduce((n, e) => n + num(e.data, 'amount'), 0);
      requireThat(value > 0 && value + prior <= netLine, 'Refund exceeds the remaining discounted paid amount for this line.');
      const refund = ctx.create('refund', { ...p, name: `Refund ${text(bill.data, 'number')}`, amount: value }, 'Pending approval', { patientId: bill.patientId });
      ctx.approval('Refund', refund.id, {}, ctx.t('reason'), value); break;
    }
    case 'counter.close': {
      requireCounter(ctx);
      const payments = ctx.all('payment').filter(e => e.status === 'Paid' && text(e.data, 'counter') === ctx.actor.counter && istDate(e.createdAt) === istDate(ctx.now()));
      const cash = payments.flatMap(e => rows(e.data, 'payments')).filter(p => text(p, 'mode') === 'Cash').reduce((sum, p) => sum + num(p, 'amount'), 0);
      const refunds = ctx.all('refund').filter(e => e.status === 'Completed' && istDate(text(e.data, 'completedAt')) === istDate(ctx.now()) && payments.some(p => text(p.data, 'billId') === text(e.data, 'billId'))).reduce((sum, e) => {
        const modes = rows(e.data, 'originalModes'); const total = modes.reduce((n, p) => n + num(p, 'amount'), 0);
        const cashPart = modes.filter(p => text(p, 'mode') === 'Cash').reduce((n, p) => n + num(p, 'amount'), 0);
        return sum + Math.round(num(e.data, 'amount') * cashPart / Math.max(1, total));
      }, 0);
      const counted = paise(ctx.n('countedCash')); const expected = cash - refunds; const difference = counted - expected;
      requireThat(difference === 0 || ctx.t('reason'), 'Enter a reason for the cash difference.');
      const needsApproval = Math.abs(difference) > paise(num(ctx.store.setting<Data>('rules', {}), 'cashDifference', 100));
      const close = ctx.create('counterClose', { ...p, name: `${ctx.actor.counter} ${istDate(ctx.now())}`, counter: ctx.actor.counter, date: istDate(ctx.now()), expected, counted, difference, receipts: payments.map(e => e.id), net: payments.reduce((n, e) => n + num(e.data, 'total'), 0) - refunds }, needsApproval ? 'Pending approval' : 'Closed');
      if (needsApproval) ctx.approval('Cash difference', close.id, {}, ctx.t('reason'), Math.abs(difference)); break;
    }
    case 'pharmacy.receive':
      ctx.update(ctx.targetOf('rx'), { receivedBy: ctx.actor.id, receivedAt: ctx.now() }, 'Received'); break;
    case 'pharmacy.question': {
      const rx = ctx.targetOf('rx'); const line = rows(rx.data, 'lines').find(l => text(l, 'id') === ctx.t('lineId'));
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
      const credit = Math.round(num(dispense.data, 'total') * quantity / num(dispense.data, 'quantity'));
      const batch = ctx.get(text(dispense.data, 'batchId'), 'batch');
      if (ctx.t('condition') === 'Unopened') ctx.update(batch, { quantity: num(batch.data, 'quantity') + quantity });
      else ctx.create('damaged', { name: text(item.data, 'name'), batchId: batch.id, quantity, reason: ctx.t('reason') }, 'Quarantined');
      ctx.update(dispense, { returned: num(dispense.data, 'returned') + quantity });
      const bill = ctx.get(text(dispense.data, 'billId'), 'bill');
      const ret = ctx.create('return', { ...p, name: `Return ${text(item.data, 'name')}`, dispenseId: dispense.id, batchId: batch.id, credit }, 'Credited', { patientId: dispense.patientId });
      if (bill.status === 'Paid') {
        const refund = ctx.create('refund', { name: 'Pharmacy return credit', billId: bill.id, lineId: text(rows(bill.data, 'lines')[0], 'id'), amount: credit, reason: ctx.t('reason'), returnId: ret.id }, 'Pending approval', { patientId: bill.patientId });
        ctx.approval('Refund', refund.id, {}, ctx.t('reason'), credit);
      } else ctx.update(bill, { total: num(bill.data, 'total') - credit, returnCredit: num(bill.data, 'returnCredit') + credit }, num(bill.data, 'total') - credit === 0 ? 'Paid' : bill.status);
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
      const proposal = ctx.create('tariff', { ...tariff.data, payer: ctx.t('payer'), rate: paise(ctx.n('rate')), effective: ctx.t('effective'), reason: ctx.t('reason'), previousId: tariff.id }, 'Pending approval');
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
      for (const id of Array.isArray(p.tests) ? p.tests : []) requireThat(typeof id === 'string' && ctx.get(id, 'test').status === 'Active', 'Use active catalog tests.');
      ctx.create('package', { ...p, price: paise(ctx.n('price')) }, 'Active'); break;
    case 'approval.decide': {
      const approval = ctx.targetOf('approval');
      requireThat(text(approval.data, 'requestedBy') !== ctx.actor.id, 'You cannot approve your own request. Sign in as a different manager.');
      if (ctx.t('decision') === 'Approve') approvalEffect(ctx, approval);
      else {
        const target = ctx.get(text(approval.data, 'targetId'));
        if (text(approval.data, 'kind') === 'Discount') ctx.update(target, { discountStatus: 'Declined', approvalReason: ctx.t('reason') });
        else if (text(approval.data, 'kind') !== 'Discharge credit') ctx.update(target, { approvalReason: ctx.t('reason') }, 'Declined');
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
