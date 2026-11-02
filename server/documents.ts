import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { PDFDocument as PdfReader } from 'pdf-lib';
import { text, num, bool, rows, doctorRoles, currency, documentKinds, type Data, type Entity } from '../shared/model.js';
import { Context } from './context.js';
import { requireThat } from './store.js';

export async function validateUploadedFile(value: unknown) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Choose a readable synthetic file.');
  const file = value as Data;
  const bytes = Buffer.from(text(file, 'base64'), 'base64');
  requireThat(bytes.length > 16 && bytes.length <= 10 * 1024 * 1024, 'File must be readable and no larger than 10 MB.');
  let valid = false;
  try {
    const mime = text(file, 'mime');
    if (mime === 'application/pdf') {
      const doc = await PdfReader.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
      valid = doc.getPageCount() > 0;
    } else {
      const doc = await PdfReader.create();
      const image = mime === 'image/png' ? await doc.embedPng(bytes) : mime === 'image/jpeg' ? await doc.embedJpg(bytes) : undefined;
      valid = Boolean(image && image.width > 0 && image.height > 0);
    }
  } catch {
    valid = false;
  }
  requireThat(valid, 'The sample file is unreadable, encrypted or unsupported. Export a readable PDF, PNG or JPEG and try again.');
}
export async function makePdf(title: string, lines: string[], header: Data, barcode = ''): Promise<Buffer> {
  const qr = barcode ? await QRCode.toBuffer(barcode, { width: 100, margin: 1 }) : undefined;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `SAMPLE - ${title}`, Author: 'Samford synthetic workflow lab' } });
    const chunks: Buffer[] = [];
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(18).fillColor('#153d3a').text(text(header, 'name', 'Samford workflow lab'));
    doc.fontSize(10).fillColor('#526665').text(text(header, 'address', 'Synthetic campus')).text(text(header, 'phone', 'Sample contact'));
    if (qr) doc.image(qr, 450, 45, { width: 90, height: 90 });
    doc.moveDown().fontSize(13).fillColor('#b33d26').text('SAMPLE ONLY - NOT FOR CLINICAL USE');
    doc.fontSize(16).fillColor('#153d3a').text(title).moveDown();
    doc.fontSize(10).fillColor('#253b3a');
    for (const line of lines) doc.text(line, { lineGap: 4 }).moveDown(0.3);
    doc.moveDown().fontSize(9).fillColor('#b33d26').text(text(header, 'footer', 'Synthetic data. No legal clinical signature.'));
    doc.end();
  });
}
export function documentCommand(name: string, ctx: Context): boolean {
  switch (name) {
    case 'document.generate': {
      const patient = ctx.patient();
      const kind = ctx.t('kind');
      requireThat(doctorRoles.includes(ctx.actor.role) || documentKinds[ctx.actor.role]?.includes(kind), 'Your role cannot generate that clinical document.');
      const types: Record<string, string> = { Prescription: 'rx', 'OPD slip': 'visit', 'ID card': 'patient', 'OPD summary': 'note', Casesheet: 'note', Receipt: 'payment', Bill: 'bill', Result: 'result', 'Discharge summary': 'discharge', 'Referral letter': 'referral', 'Admission form': 'admission', Wristband: 'admission', 'Gate pass': 'admission', 'Sample label': 'sample', 'Dispatch manifest': 'sample' };
      const type = types[kind];
      let source: Entity | undefined;
      if (ctx.t('sourceId')) source = ctx.get(ctx.t('sourceId'), type);
      else if (type === 'patient') source = patient;
      else source = ctx.all(type).filter(e => e.patientId === patient.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      requireThat(source && (source.id === patient.id || source.patientId === patient.id), 'No matching document source is available for this patient.');
      if (type === 'rx') requireThat(source.status !== 'Draft', 'A draft prescription cannot be printed as approved.');
      if (type === 'result') requireThat(source.status === 'Released', 'Only a released result can be printed.');
      if (type === 'payment') requireThat(source.status === 'Paid', 'Only a successful payment has a receipt.');
      if (type === 'discharge') requireThat(['Approved', 'Nursing cleared'].includes(source.status), 'The discharge summary is not approved.');
      if (kind === 'Gate pass') requireThat(source.status === 'Discharged' && text(source.data, 'gatePass'), 'Complete discharge clearance before printing a gate pass.');
      if (kind === 'Dispatch manifest') requireThat(source.status === 'Dispatched', 'Dispatch the sample before printing its manifest.');
      const lines = [
        `Patient: ${text(patient.data, 'name')} | Age: ${num(patient.data, 'age')} | ${text(patient.data, 'sex')}`,
        `UHID: ${text(patient.data, 'uhid')}${bool(patient.data, 'mlc') ? ' | MLC' : ''}`,
        `Aadhaar: XXXX-XXXX-${text(patient.data, 'aadhaarLast4') || '----'}`,
        `Document generated: ${new Date(ctx.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
        `Source: ${source.id}, record version ${source.version}`
      ];
      if (source.doctorId) {
        const account = ctx.get(source.doctorId, 'account');
        lines.push(`Doctor: ${text(account.data, 'name')} | ${text(account.data, 'qualification')} | Registration: ${text(account.data, 'registration')}`);
      }
      if (type === 'rx') {
        lines.push(`Prescription version ${num(source.data, 'rxVersion')} | Synthetic attestation, not a legal signature`);
        for (const line of rows(source.data, 'lines')) lines.push(`${text(line, 'name')}: ${text(line, 'dose')}, ${text(line, 'frequency')}, ${text(line, 'route')}, ${num(line, 'days')} days; ${text(line, 'start')} to ${text(line, 'end')}; ${text(line, 'food')}. ${text(line, 'remark')}`);
        const followup = ctx.all('followup').find(e => text(e.data, 'visitId') === text(source.data, 'visitId') && bool(e.data, 'print'));
        if (followup) lines.push(`Follow-up: ${text(followup.data, 'date')} - ${text(followup.data, 'note')} (${followup.status}; recommendation is not a confirmed booking)`);
      } else if (type === 'note') {
        const sections = Array.isArray(ctx.p.sections) ? ctx.p.sections.filter((x): x is string => typeof x === 'string') : ['complaints', 'diagnosis', 'advice'];
        for (const section of sections) lines.push(`${section}: ${text(source.data, section)}`);
      } else if (type === 'payment' || type === 'bill') {
        const bill = type === 'bill' ? source : ctx.get(text(source.data, 'billId'), 'bill');
        requireThat(text(bill.data, 'discountStatus') !== 'Pending', 'The discount has not been approved.');
        lines.push(`Bill: ${text(bill.data, 'number')} | Receipt: ${text(source.data, 'receipt')} | Counter: ${text(source.data, 'counter')}`);
        for (const line of rows(bill.data, 'lines')) lines.push(`${text(line, 'name')} | Qty ${num(line, 'quantity', 1)} | ${currency(num(line, 'total'))} | HSN ${text(line, 'hsn')} | Taxable ${currency(num(line, 'taxable'))} | CGST ${currency(num(line, 'cgst'))} | SGST ${currency(num(line, 'sgst'))}`);
        lines.push(`Total: ${currency(num(bill.data, 'total'))} | Discount: ${currency(num(bill.data, 'discount'))}`);
        for (const payment of rows(source.data, 'payments')) lines.push(`${text(payment, 'mode')}: ${currency(num(payment, 'amount'))} (simulated)`);
      } else if (type === 'result') {
        if (text(source.data, 'testId') === 'xray') lines.push(`Radiology: ${text(source.data, 'narrative')}`);
        else lines.push(`${text(source.data, 'name')}: ${num(source.data, 'value')} ${text(source.data, 'unit')}; range ${num(source.data, 'low')}-${num(source.data, 'high')}`);
        lines.push(text(source.data, 'flag') === 'Critical' && ctx.actor.role === 'patient' ? 'Your doctor has been told.' : `Flag: ${text(source.data, 'flag')}`);
        lines.push(`Sample: ${text(source.data, 'sampleAt')} | Released: ${text(source.data, 'releasedAt')} | Verifier: ${text(source.data, 'verifiedBy')}`);
        if (text(source.data, 'previousId')) lines.push(`AMENDED v${num(source.data, 'reportVersion')}: ${text(source.data, 'amendmentReason')}`);
      } else if (type === 'visit') {
        lines.push(`Token ${num(source.data, 'token')} | ${text(source.data, 'room')} | ${text(source.data, 'date')} ${text(source.data, 'time')} | ${text(source.data, 'number')} | ${text(patient.data, 'payer')}`);
      } else if (type === 'discharge') {
        for (const key of ['diagnosis', 'course', 'procedures', 'condition', 'followup']) lines.push(`${key}: ${text(source.data, key)}`);
        for (const line of rows(source.data, 'lines')) lines.push(`${text(line, 'name')} ${text(line, 'dose')} ${text(line, 'frequency')} ${num(line, 'days')} days`);
      } else if (type === 'referral') lines.push(`To: ${text(source.data, 'hospital')} | Purpose: ${text(source.data, 'purpose')} | ${text(source.data, 'reason')}`);
      else if (type === 'admission') {
        lines.push(`IPD: ${text(source.data, 'number')} | ${source.status} | Bed: ${text(source.data, 'bedId') ? text(ctx.get(text(source.data, 'bedId')).data, 'name') : 'Not allotted'}`);
        lines.push(`Admitted: ${text(source.data, 'admittedAt')} | Relative: ${text(source.data, 'relative')}`);
        if (kind === 'Gate pass') lines.push(`Gate pass: ${text(source.data, 'gatePass')} | Released: ${text(source.data, 'dischargedAt')}`);
      } else if (type === 'sample') {
        lines.push(`Barcode: ${text(source.data, 'barcode')} | Container: ${text(source.data, 'container')} | Collected: ${text(source.data, 'collectedAt')}`);
        if (kind === 'Dispatch manifest') lines.push(`Outside lab: ${text(source.data, 'lab')} | Courier: ${text(source.data, 'courier')} | Dispatched: ${text(source.data, 'dispatchedAt')} | Sample count: 1`);
      }
      const prior = ctx.all('document').filter(e => text(e.data, 'sourceId') === source!.id && text(e.data, 'kind') === kind);
      if (prior.length) lines.unshift('DUPLICATE - reprint');
      const letterhead = ctx.get('letterhead', 'letterhead');
      const document = ctx.create('document', { name: `${kind} - ${text(patient.data, 'uhid')}`, kind, sourceId: source.id, sourceVersion: source.version, lines, barcode: type === 'sample' ? text(source.data, 'barcode') : text(patient.data, 'uhid'), letterhead: letterhead.data, mime: 'application/pdf', generated: true, duplicate: prior.length > 0, watermark: 'SAMPLE ONLY' }, 'Available', { patientId: patient.id, doctorId: source.doctorId });
      ctx.result = { documentId: document.id, downloadUrl: `/api/documents/${document.id}/file` }; break;
    }
    case 'document.share': {
      const document = ctx.targetOf('document');
      ctx.patient(document.patientId);
      if (ctx.t('channel') === 'WhatsApp') ctx.feature('WhatsApp');
      const message = ctx.message(document.patientId!, 'Document ready at the patient portal', `${document.id}-share`, ctx.t('channel'));
      ctx.result = { messageId: message?.id ?? '', simulated: true }; break;
    }
    case 'document.upload': {
      const patient = ctx.patient();
      const file = ctx.p.file;
      requireThat(file && typeof file === 'object' && !Array.isArray(file), 'Choose a synthetic sample document.');
      const mime = text(file, 'mime'); const filename = text(file, 'name'); const data = text(file, 'base64');
      requireThat(['application/pdf', 'image/png', 'image/jpeg'].includes(mime), 'Only PDF, PNG and JPEG samples are accepted.');
      requireThat(!/aadha+r|aadhar|uidai/i.test(filename), 'Aadhaar images must never be uploaded.');
      const buffer = Buffer.from(data, 'base64');
      requireThat(buffer.length > 16 && buffer.length <= 10 * 1024 * 1024, 'File must be readable and no larger than 10 MB.');
      const signatureValid = mime === 'application/pdf' ? buffer.subarray(0, 5).toString() === '%PDF-' : mime === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
      requireThat(signatureValid, 'The file contents do not match its format. Export a readable PDF or image.');
      const doc = ctx.create('document', { name: filename.replace(/[^\w .()-]/g, '_').slice(0, 100), kind: ctx.t('kind'), mime, file: buffer.toString('base64'), size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), synthetic: true, generated: false, watermark: 'SAMPLE upload - user supplied' }, 'Available', { patientId: patient.id, doctorId: ctx.actor.role === 'doctor' ? ctx.actor.id : undefined });
      if (ctx.t('kind') === 'Photo') ctx.update(patient, { photoId: doc.id, photoHistory: [...stringsSafe(patient.data.photoHistory), text(patient.data, 'photoId')].filter(Boolean) });
      break;
    }
    case 'document.void':
      ctx.update(ctx.targetOf('document'), { reason: ctx.t('reason') }, 'Filed by mistake'); break;
    case 'certificate.print': {
      const certificate = ctx.targetOf('certificate'); const patient = ctx.get(certificate.patientId!, 'patient');
      requireThat(certificate.doctorId, 'Only a doctor-issued certificate can be printed.');
      const doc = ctx.create('document', { name: text(certificate.data, 'number'), kind: 'Certificate', sourceId: certificate.id, mime: 'application/pdf', generated: true, watermark: 'SAMPLE ONLY',
        letterhead: ctx.get('letterhead').data, lines: [`Serial: ${text(certificate.data, 'number')}`, `Patient: ${text(patient.data, 'name')} | ${text(patient.data, 'uhid')}`, text(certificate.data, 'content'), `Issued by ${text(certificate.data, 'author')} / ${text(certificate.data, 'registration')}`, 'Synthetic certificate only - not legally valid'] }, 'Available', { patientId: certificate.patientId, doctorId: certificate.doctorId });
      ctx.result = { documentId: doc.id, downloadUrl: `/api/documents/${doc.id}/file` }; break;
    }
    default: return false;
  }
  return true;
}
function stringsSafe(value: unknown): string[] { return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []; }
