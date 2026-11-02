import { randomUUID } from 'node:crypto';
import { text, num, bool, rows, strings, istDate, type Data, type Entity } from '../shared/model.js';
import { payerNames, cashDenominations, denominationTotal } from '../shared/finance.js';
import type { Context } from './context.js';
import { Store, requireThat } from './store.js';

export function readPayerRates(input: Data, fallbackSelf?: number): Data {
  const rates: Data = {};
  for (const [payer, value] of Object.entries(input)) {
    requireThat(payerNames.includes(payer) && typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Use non-negative rates for listed payer groups.');
    const paise = Math.round(value * 100);
    requireThat(Number.isSafeInteger(paise), 'This rate exceeds the supported money range.');
    rates[payer] = paise;
  }
  if (fallbackSelf !== undefined && rates.Self === undefined) rates.Self = fallbackSelf;
  return rates;
}
export function packageQuote(store: Store, packageId: string, payer: string): Data {
  const pkg = store.get(packageId, 'package');
  requireThat(pkg.status === 'Active', 'Choose an active package.');
  const changes = store.all('packageRate').filter(entry => text(entry.data, 'packageId') === packageId && entry.status === 'Active' && text(entry.data, 'effective') <= istDate(store.now()))
    .sort((a, b) => text(b.data, 'effective').localeCompare(text(a.data, 'effective')));
  const current = changes[0];
  const raw = current?.data.payerRates ?? pkg.data.payerRates;
  const rates = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : payer === 'Self' ? { Self: num(pkg.data, 'price') } : {};
  requireThat(typeof rates[payer] === 'number', `This package has no published ${payer} rate. Ask the master-data owner to publish one.`);
  return { packageId: pkg.id, name: text(pkg.data, 'name'), kind: text(pkg.data, 'kind', 'Health check-up'), payer, rate: num(rates, payer), coveredTypes: strings(pkg.data, 'coveredTypes'),
    sourceVersion: current?.version ?? pkg.version, rateId: current?.id ?? pkg.id, quotedAt: store.now() };
}
export function chargeType(ctx: Context, bill: Entity): string {
  const sourceId = text(bill.data, 'sourceId');
  const source = ctx.store.all().find(entity => entity.id === sourceId);
  if (source?.type === 'dispense') return 'Pharmacy';
  if (source?.type === 'order') return 'Laboratory';
  if (source?.type === 'operation') return 'Procedure';
  if (source?.type === 'visit') return 'Consultation';
  const tariffId = text(rows(bill.data, 'lines')[0] ?? {}, 'tariffId');
  if (tariffId) {
    const code = text(ctx.get(tariffId, 'tariff').data, 'code');
    if (code === 'consultation') return 'Consultation';
    if (code === 'operation') return 'Procedure';
    if (ctx.all('test').some(test => test.id === code)) return 'Laboratory';
  }
  return 'Other';
}
export function admissionCharges(ctx: Context, admission: Entity): { lines: Data[]; bills: Entity[]; advances: number; agreement?: Entity; quote?: Data; insurerShare: number } {
  const bills = ctx.all('bill').filter(bill => text(bill.data, 'admissionId') === admission.id && !['Cancelled', 'Consolidated'].includes(bill.status) && !bool(bill.data, 'postSettlement'));
  const patient = ctx.get(admission.patientId!, 'patient');
  const payer = text(patient.data, 'payer', 'Self');
  const agreement = ctx.all('claim').filter(claim => text(claim.data, 'admissionId') === admission.id && text(claim.data, 'payer') === payer && !['Eligibility failed', 'Cancelled'].includes(claim.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const rawQuote = agreement?.data.packageQuote;
  const quote = rawQuote && typeof rawQuote === 'object' && !Array.isArray(rawQuote) ? rawQuote : undefined;
  const scheme = ['Ayushman', 'CGHS'].includes(payer);
  if (scheme) requireThat(quote && text(quote, 'kind') === 'Scheme treatment', 'Scheme billing needs an explicitly reviewed master package. Reconcile this admission’s package before preparing its final bill.');
  const included = scheme && quote ? strings(quote, 'coveredTypes') : [];
  const lines: Data[] = bills.filter(bill => !bool(bill.data, 'isAdvance') && !included.includes(chargeType(ctx, bill)) && num(bill.data, 'total') > num(bill.data, 'paid'))
    .map(bill => ({ id: randomUUID(), name: text(bill.data, 'name'), total: num(bill.data, 'total') - num(bill.data, 'paid'), componentBillId: bill.id, quantity: 1 }));
  if (scheme && quote) lines.push({ id: randomUUID(), name: `Scheme package: ${text(quote, 'name')}`, packageId: text(quote, 'packageId'), tariffSnapshot: quote, quantity: 1, total: num(quote, 'rate') });
  if (!included.includes('Bed')) for (const interval of rows(admission.data, 'bedHistory')) {
    const to = text(interval, 'to') || ctx.now();
    const hours = Math.max(1, Math.ceil((Date.parse(to) - Date.parse(text(interval, 'from'))) / 3600000));
    lines.push({ id: randomUUID(), name: `Bed: ${text(interval, 'name')}`, from: text(interval, 'from'), to, quantity: hours, unit: 'hours', dailyRate: num(interval, 'rate'), total: Math.round(hours * num(interval, 'rate') / 24) });
  }
  const gross = lines.reduce((sum, line) => sum + num(line, 'total'), 0);
  const approved = agreement && ['Approved', 'Claim sent', 'Deduction approval pending', 'Settled'].includes(agreement.status) && text(agreement.data, 'validUntil') >= istDate(ctx.now()) ? num(agreement.data, 'approvedAmount') : 0;
  const insurerShare = Math.min(gross, approved);
  const deposits = bills.filter(bill => bool(bill.data, 'isAdvance'));
  const reservedRefunds = ctx.all('refund').filter(refund => deposits.some(bill => bill.id === text(refund.data, 'billId')) && refund.status !== 'Declined');
  const advances = deposits.reduce((sum, bill) => sum + num(bill.data, 'paid'), 0) - reservedRefunds.reduce((sum, refund) => sum + num(refund.data, 'amount'), 0);
  requireThat(advances >= 0, 'Deposit refunds exceed the recorded payments. Reconcile them before final billing.');
  return { lines, bills, advances, agreement, quote, insurerShare };
}
export function linePaidShare(bill: Entity, lineId: string): number {
  const lines = rows(bill.data, 'lines').filter(line => num(line, 'total') > 0);
  const allocations = allocateMoney(num(bill.data, 'total'), lines.map(line => ({ key: text(line, 'id'), weight: num(line, 'netTotal', num(line, 'total')) })));
  return allocations.find(row => row.key === lineId)?.amount ?? 0;
}
export function discountBill(ctx: Context, bill: Entity, percent: number, reason: string, approvalId = '') {
  requireThat(bill.status === 'Unpaid' && num(bill.data, 'paid') === 0 && num(bill.data, 'returnCredit') === 0, 'Apply a discount before payment or returns. Existing credits must not be overwritten.');
  const discount = Math.round(num(bill.data, 'subtotal') * percent / 100);
  const lines = rows(bill.data, 'lines');
  const portions = allocateMoney(discount, lines.filter(line => num(line, 'total') > 0).map(line => ({ key: text(line, 'id'), weight: num(line, 'total') })));
  const adjusted = lines.map(line => {
    const gross = num(line, 'total'); const net = gross - (portions.find(part => part.key === text(line, 'id'))?.amount ?? 0);
    if (gross <= 0) return line;
    if (typeof line.taxable !== 'number') return { ...line, netTotal: net };
    const grossTaxable = num(line, 'grossTaxable', num(line, 'taxable')); const taxable = Math.round(grossTaxable * net / gross); const tax = net - taxable;
    return { ...line, grossTaxable, netTotal: net, taxable, cgst: Math.floor(tax / 2), sgst: tax - Math.floor(tax / 2) };
  });
  const updated = ctx.update(bill, { discount, total: num(bill.data, 'subtotal') - discount, lines: adjusted, discountReason: reason, discountStatus: 'Approved', approvalId });
  const order = ctx.all('order').find(order => order.id === text(bill.data, 'sourceId'));
  if (order) ctx.update(order, { originalAmount: num(order.data, 'originalAmount', num(order.data, 'amount')), amount: num(updated.data, 'total'), discount, patientPays: num(updated.data, 'total') });
}
function allocateMoney(amount: number, inputs: { key: string; weight: number }[]) {
  const total = inputs.reduce((sum, row) => sum + row.weight, 0);
  requireThat(Number.isSafeInteger(amount) && amount >= 0 && Number.isSafeInteger(total) && total > 0, 'Payment allocation is unavailable. Reconcile the original receipt.');
  const values = inputs.map(row => ({ key: row.key, amount: Number(BigInt(amount) * BigInt(row.weight) / BigInt(total)),
    remainder: Number(BigInt(amount) * BigInt(row.weight) % BigInt(total)) }));
  let remainder = amount - values.reduce((sum, row) => sum + row.amount, 0);
  for (const row of [...values].sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key))) { if (remainder <= 0) break; row.amount++; remainder--; }
  return values.map(({ key, amount }) => ({ key, amount }));
}
export function completeRefund(ctx: Context, refund: Entity, approvalId = '') {
  const bill = ctx.get(text(refund.data, 'billId'), 'bill');
  requireUnusedAdvance(ctx, bill, num(refund.data, 'amount'), refund.id);
  const prior = ctx.all('refund').filter(item => item.id !== refund.id && item.status === 'Completed' && text(item.data, 'billId') === bill.id);
  const refunded = prior.reduce((sum, item) => sum + num(item.data, 'amount'), 0);
  requireThat(refunded + num(refund.data, 'amount') <= num(bill.data, 'paid'), 'Refund exceeds the remaining amount actually paid.');
  const receipts = ctx.all('payment').filter(payment => text(payment.data, 'billId') === bill.id && payment.status === 'Paid');
  const payments = receipts.flatMap(payment => rows(payment.data, 'payments'));
  const priorModes = prior.flatMap(item => {
    const recorded = rows(item.data, 'refundModes');
    if (recorded.length) return recorded;
    return allocateMoney(num(item.data, 'amount'), rows(item.data, 'originalModes').map(mode => ({ key: text(mode, 'mode'), weight: num(mode, 'amount') }))).map(mode => ({ mode: mode.key, amount: mode.amount }));
  });
  const modes = ['Cash', 'UPI', 'Card'].map(mode => ({ key: mode, weight: payments.filter(payment => text(payment, 'mode') === mode).reduce((sum, payment) => sum + num(payment, 'amount'), 0) -
    priorModes.filter(payment => text(payment, 'mode') === mode).reduce((sum, payment) => sum + num(payment, 'amount'), 0) })).filter(row => row.weight > 0);
  const refundModes = allocateMoney(num(refund.data, 'amount'), modes).filter(row => row.amount > 0).map(row => ({ mode: row.key, amount: row.amount }));
  ctx.update(refund, { completedAt: ctx.now(), creditNumber: `CREDIT-${ctx.all('refund').filter(item => item.status === 'Completed').length + 1}`, originalModes: payments, refundModes, approvalId,
    counter: text(refund.data, 'counter') || text(receipts[0]?.data ?? {}, 'counter'),
    decision: approvalId ? 'Independently approved' : bool(refund.data, 'automaticOnlineCancellation') ? 'Eligible online cancellation' : 'Within non-cash refund limit' }, 'Completed');
  ctx.update(bill, { refunded: refunded + num(refund.data, 'amount') });
  if (text(refund.data, 'returnId')) ctx.update(ctx.get(text(refund.data, 'returnId'), 'return'), { completedRefundId: refund.id }, 'Credited');
}
export function requireUnusedAdvance(ctx: Context, bill: Entity, amount: number, excludingRefund = '') {
  if (!bool(bill.data, 'isAdvance')) return;
  const admission = ctx.get(text(bill.data, 'admissionId'), 'admission');
  const finalId = text(admission.data, 'finalBillId');
  const applied = finalId ? num(ctx.get(finalId, 'bill').data, 'appliedAdvance') : 0;
  const deposits = ctx.all('bill').filter(entry => bool(entry.data, 'isAdvance') && text(entry.data, 'admissionId') === admission.id);
  const reserved = ctx.all('refund').filter(entry => entry.id !== excludingRefund && entry.status !== 'Declined' && deposits.some(deposit => deposit.id === text(entry.data, 'billId')));
  const remaining = deposits.reduce((sum, entry) => sum + num(entry.data, 'paid'), 0) - applied - reserved.reduce((sum, entry) => sum + num(entry.data, 'amount'), 0);
  requireThat(amount <= remaining, 'This deposit is already applied to the final bill or reserved for another refund. Only the unused balance can be refunded.');
}
export function refundNeedsApproval(ctx: Context, bill: Entity, amount: number) {
  const payments = ctx.all('payment').filter(payment => text(payment.data, 'billId') === bill.id && payment.status === 'Paid').flatMap(payment => rows(payment.data, 'payments'));
  return payments.some(payment => text(payment, 'mode') === 'Cash' && num(payment, 'amount') > 0) || amount > Math.round(num(ctx.store.setting<Data>('rules', {}), 'refund', 500) * 100);
}
export function parseDenominations(value: unknown): Data {
  let counts: Data = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) counts = value as Data;
  else if (typeof value === 'string') {
    if (value.trim() === '0') return {};
    for (const part of value.split(',')) {
      const match = part.trim().match(/^(\d+)\s*[x×:]\s*(\d+)$/);
      requireThat(match, 'Enter note counts using the denomination controls (legacy format: 500x2,100x1).');
      counts[match[1]] = num(counts, match[1]) + Number(match[2]);
    }
  } else requireThat(false, 'Provide a counted denomination breakdown.');
  requireThat(Object.entries(counts).every(([denomination, count]) => cashDenominations.includes(Number(denomination)) && typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 1000000), 'Use non-negative whole counts for listed denominations.');
  requireThat(Number.isSafeInteger(Math.round(denominationTotal(counts) * 100)), 'Cash total exceeds the supported range.');
  return counts;
}
export function counterSummary(store: Store, counter: string): Data {
  const date = istDate(store.now());
  const allPayments = store.all('payment').filter(payment => payment.status === 'Paid');
  const payments = allPayments.filter(payment => text(payment.data, 'counter') === counter && istDate(payment.createdAt) === date);
  const refunds = store.all('refund').filter(refund => refund.status === 'Completed' && istDate(text(refund.data, 'completedAt')) === date &&
    (text(refund.data, 'counter') || text(allPayments.find(payment => text(payment.data, 'billId') === text(refund.data, 'billId'))?.data ?? {}, 'counter')) === counter);
  const modes = ['Cash', 'UPI', 'Card'].map(mode => {
    const collected = payments.flatMap(payment => rows(payment.data, 'payments')).filter(part => text(part, 'mode') === mode).reduce((sum, part) => sum + num(part, 'amount'), 0);
    const refunded = refunds.reduce((sum, refund) => {
      const exact = rows(refund.data, 'refundModes');
      const amounts = exact.length ? exact : allocateMoney(num(refund.data, 'amount'), rows(refund.data, 'originalModes').map(part => ({ key: text(part, 'mode'), weight: num(part, 'amount') }))).map(part => ({ mode: part.key, amount: part.amount }));
      return sum + amounts.filter(part => text(part, 'mode') === mode).reduce((total, part) => total + num(part, 'amount'), 0);
    }, 0);
    return { mode, collected, refunded, net: collected - refunded };
  });
  const bills = store.all('bill').filter(bill => text(bill.data, 'counter') === counter && istDate(bill.createdAt) === date);
  return { counter, date, modes, expectedCash: modes.find(part => part.mode === 'Cash')!.net, net: modes.reduce((total, part) => total + part.net, 0),
    receiptIds: payments.map(payment => payment.id), refundIds: refunds.map(refund => refund.id), discounts: bills.reduce((sum, bill) => sum + num(bill.data, 'discount'), 0),
    cancelledBills: bills.filter(bill => bill.status === 'Cancelled').length, generatedAt: store.now() };
}
