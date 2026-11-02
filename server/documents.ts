import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { PDFDocument as PdfReader } from 'pdf-lib';
import { text, num, bool, rows, doctorRoles, currency, documentKinds, type Data, type Entity } from '../shared/model.js';
import { Context } from './context.js';
import { requireThat } from './store.js';
import { resolve as resolvePath } from 'node:path';
import { printLanguage, translate, type Language } from '../shared/i18n.js';

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
export async function makePdf(title: string, lines: string[], header: Data, barcode = '', language: Language = 'English'): Promise<Buffer> {
  const qr = barcode ? await QRCode.toBuffer(barcode, { width: 100, margin: 1 }) : undefined;
  const t = (value: string) => translate(value, language);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, pdfVersion: '1.7', tagged: true, lang: language === 'Hindi' ? 'hi-IN' : 'en-IN',
      info: { Title: `SAMPLE - ${t(title)}`, Author: 'Samford synthetic workflow lab' } });
    const chunks: Buffer[] = [];
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font(resolvePath('assets', 'fonts', 'NotoSansDevanagari.ttf'));
    const root = doc.struct('Document'); doc.addStructure(root);
    const write = (value: string, size: number, color: string, width = 499) => {
      // Indic shaping reorders glyphs; ActualText retains the original logical Unicode for accessible readers.
      root.add(doc.struct('P', { actual: value, lang: language === 'Hindi' ? 'hi-IN' : 'en-IN' }, () => {
        doc.fontSize(size).fillColor(color).text(value, { width, lineGap: 4 });
      }));
    };
    write(text(header, 'name', 'Samford workflow lab'), 18, '#153d3a', 370);
    write(text(header, 'address', 'Synthetic campus'), 10, '#526665', 370);
    write(text(header, 'phone', 'Sample contact'), 10, '#526665', 370);
    if (qr) { doc.markContent('Artifact', { type: 'Layout' }); doc.image(qr, 450, 45, { width: 90, height: 90 }); doc.endMarkedContent(); }
    doc.moveDown();
    write(`${language === 'Hindi' ? 'SAMPLE / ' : ''}${t('SAMPLE ONLY - NOT FOR CLINICAL USE')}`, 13, '#b33d26', 390);
    write(t(title), 16, '#153d3a'); doc.moveDown();
    for (const line of lines) { write(line, 10, '#253b3a'); doc.moveDown(0.3); }
    doc.moveDown();
    write(language === 'Hindi' ? 'नमूना डेटा। यह कानूनी चिकित्सकीय हस्ताक्षर नहीं है।' : 'Synthetic data. No legal clinical signature.', 9, '#b33d26');
    if (text(header, 'footer')) write(text(header, 'footer'), 9, '#b33d26');
    root.end();
    doc.end();
  });
}
export function documentCommand(name: string, ctx: Context): boolean {
  switch (name) {
    case 'document.generate': {
      const patient = ctx.patient();
      const kind = ctx.t('kind');
      requireThat(doctorRoles.includes(ctx.actor.role) || documentKinds[ctx.actor.role]?.includes(kind), 'Your role cannot generate that clinical document.');
      const types: Record<string, string> = { Prescription: 'rx', 'OPD slip': 'visit', 'ID card': 'patient', 'OPD summary': 'note', Casesheet: 'note', Receipt: 'payment', Bill: 'bill', 'Credit note': 'refund', Result: 'result', 'Discharge summary': 'discharge', 'Referral letter': 'referral', 'Admission form': 'admission', Wristband: 'admission', 'Gate pass': 'admission', 'Sample label': 'sample', 'Dispatch manifest': 'sample', 'Consent form': 'consent' };
      const type = types[kind];
      let source: Entity | undefined;
      if (ctx.t('sourceId')) source = ctx.get(ctx.t('sourceId'), type);
      else if (type === 'patient') source = patient;
      else source = ctx.all(type).filter(e => e.patientId === patient.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      requireThat(source && (source.id === patient.id || source.patientId === patient.id), 'No matching document source is available for this patient.');
      const language: Language = type === 'consent' ? text(source.data, 'language') === 'Hindi' ? 'Hindi' : 'English' : ctx.t('language') === 'Hindi' ? 'Hindi' : ctx.t('language') === 'English' ? 'English' : printLanguage(ctx.actor);
      const t = (value: string) => translate(value, language);
      if (type === 'rx') requireThat(source.status !== 'Draft', 'A draft prescription cannot be printed as approved.');
      if (type === 'note') requireThat(source.status === 'Reviewed', 'The consultant must review a resident draft before it can be printed as an approved summary.');
      if (type === 'result') requireThat(source.status === 'Released', 'Only a released result can be printed.');
      if (type === 'payment') requireThat(source.status === 'Paid', 'Only a successful payment has a receipt.');
      if (type === 'refund') requireThat(source.status === 'Completed', 'Only a completed credit/refund can be printed as a credit note.');
      if (type === 'discharge') requireThat(['Approved', 'Nursing cleared'].includes(source.status), 'The discharge summary is not approved.');
      if (kind === 'Gate pass') requireThat(source.status === 'Discharged' && text(source.data, 'gatePass'), 'Complete discharge clearance before printing a gate pass.');
      if (kind === 'Dispatch manifest') requireThat(source.status === 'Dispatched', 'Dispatch the sample before printing its manifest.');
      const lines = [
        `${t('Patient')}: ${text(patient.data, 'name')} | ${t('Age')}: ${num(patient.data, 'age')} | ${t(text(patient.data, 'sex'))}`,
        `UHID: ${text(patient.data, 'uhid')}${bool(patient.data, 'mlc') ? ' | MLC' : ''}`,
        `${t('Aadhaar')}: XXXX-XXXX-${text(patient.data, 'aadhaarLast4') || '----'}`,
        `${t('Document generated')}: ${new Date(ctx.now()).toLocaleString(language === 'Hindi' ? 'hi-IN' : 'en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
        `${t('Source')}: ${source.id}, ${t('Record version')} ${source.version}`
      ];
      if (source.doctorId) {
        const account = ctx.get(source.doctorId, 'account');
        lines.push(`${t('Doctor')}: ${text(account.data, 'name')} | ${text(account.data, 'qualification')} | ${t('Registration')}: ${text(account.data, 'registration')}`);
      }
      if (type === 'rx' && text(source.data, 'source') === 'Paper') lines.push(`${t('Paper prescriber')}: ${text(source.data, 'prescriberName')} | ${t('Registration')}: ${text(source.data, 'prescriberRegistration')} | ${t('Date')}: ${text(source.data, 'prescriptionDate')} | ${t('Transcribed by')}: ${text(source.data, 'enteredBy')}`);
      if (type === 'rx') {
        lines.push(`${t('Prescription version')} ${num(source.data, 'rxVersion')} | ${t('Synthetic attestation, not a legal signature')}`);
        for (const line of rows(source.data, 'lines')) lines.push(`${text(line, 'name')}: ${text(line, 'dose')}, ${t(text(line, 'frequency'))}, ${t(text(line, 'route'))}, ${num(line, 'days')} ${t('Days')}; ${text(line, 'start')} - ${text(line, 'end')}; ${t(text(line, 'food'))}. ${text(line, 'remark')}`);
        const followup = ctx.all('followup').find(e => text(e.data, 'visitId') === text(source.data, 'visitId') && bool(e.data, 'print'));
        if (followup) lines.push(`${t('Follow-up')}: ${text(followup.data, 'date')} - ${text(followup.data, 'note')} (${t(followup.status)}; ${language === 'Hindi' ? 'सुझाव पक्की बुकिंग नहीं है' : 'recommendation is not a confirmed booking'})`);
      } else if (type === 'note') {
        const sections = Array.isArray(ctx.p.sections) ? ctx.p.sections.filter((x): x is string => typeof x === 'string') : ['complaints', 'diagnosis', 'advice'];
        for (const section of sections) lines.push(`${t(section)}: ${text(source.data, section)}`);
      } else if (type === 'payment' || type === 'bill') {
        const bill = type === 'bill' ? source : ctx.get(text(source.data, 'billId'), 'bill');
        requireThat(text(bill.data, 'discountStatus') !== 'Pending', 'The discount has not been approved.');
        lines.push(`${t('Bill')}: ${text(bill.data, 'number')} | ${t('Receipt')}: ${text(source.data, 'receipt')} | ${t('Counter')}: ${text(source.data, 'counter')}`);
        for (const line of rows(bill.data, 'lines')) lines.push(`${text(line, 'name')} | ${t('Quantity')} ${num(line, 'quantity', 1)} | ${currency(num(line, 'netTotal', num(line, 'total')))} | HSN ${text(line, 'hsn')} | ${t('Taxable')} ${currency(num(line, 'taxable'))} | CGST ${currency(num(line, 'cgst'))} | SGST ${currency(num(line, 'sgst'))}`);
        lines.push(`${t('Total')}: ${currency(num(bill.data, 'total'))} | ${t('Discount')}: ${currency(num(bill.data, 'discount'))}`);
        for (const payment of rows(source.data, 'payments')) lines.push(`${t(text(payment, 'mode'))}: ${currency(num(payment, 'amount'))} (${language === 'Hindi' ? 'अनुकरण' : 'simulated'})`);
      } else if (type === 'refund') {
        lines.push(`${t('Credit note')}: ${text(source.data, 'creditNumber')} | ${t('Bill')}: ${text(ctx.get(text(source.data, 'billId')).data, 'number')}`);
        lines.push(`${t('Total')}: ${currency(num(source.data, 'amount'))} | ${t('Reason')}: ${text(source.data, 'reason')}`);
        for (const mode of rows(source.data, 'refundModes')) lines.push(`${t(text(mode, 'mode'))}: ${currency(num(mode, 'amount'))} (${language === 'Hindi' ? 'नमूना वापसी' : 'simulated refund'})`);
      } else if (type === 'result') {
        if (text(source.data, 'testId') === 'xray') lines.push(`${t('Radiology')}: ${text(source.data, 'narrative')}`);
        else lines.push(`${text(source.data, 'name')}: ${num(source.data, 'value')} ${text(source.data, 'unit')}; ${t('Range')} ${num(source.data, 'low')}-${num(source.data, 'high')}`);
        lines.push(text(source.data, 'flag') === 'Critical' && ctx.actor.role === 'patient' ? t('Your doctor has been told.') : `${t('Flag')}: ${t(text(source.data, 'flag'))}`);
        lines.push(`${t('Sample')}: ${text(source.data, 'sampleAt')} | ${t('Released')}: ${text(source.data, 'releasedAt')} | ${t('Verifier')}: ${text(source.data, 'verifiedBy')}`);
        if (text(source.data, 'previousId')) lines.push(`${t('AMENDED')} v${num(source.data, 'reportVersion')}: ${text(source.data, 'amendmentReason')}`);
      } else if (type === 'visit') {
        lines.push(`${t('Token')} ${num(source.data, 'token')} | ${text(source.data, 'room')} | ${text(source.data, 'date')} ${text(source.data, 'time')} | ${text(source.data, 'number')} | ${text(patient.data, 'payer')}`);
      } else if (type === 'discharge') {
        for (const [key, caption] of [['diagnosis', 'Diagnosis'], ['course', 'Course in hospital'], ['procedures', 'Procedures'], ['condition', 'Condition at discharge'], ['followup', 'Follow-up']]) lines.push(`${t(caption)}: ${text(source.data, key)}`);
        for (const line of rows(source.data, 'lines')) lines.push(`${text(line, 'name')} ${text(line, 'dose')} ${t(text(line, 'frequency'))} ${num(line, 'days')} ${t('Days')}`);
      } else if (type === 'referral') lines.push(`${t('To')}: ${text(source.data, 'hospital')} | ${t('Purpose')}: ${t(text(source.data, 'purpose'))} | ${text(source.data, 'reason')}`);
      else if (type === 'admission') {
        lines.push(`IPD: ${text(source.data, 'number')} | ${t(source.status)} | ${language === 'Hindi' ? 'बेड' : 'Bed'}: ${text(source.data, 'bedId') ? text(ctx.get(text(source.data, 'bedId')).data, 'name') : language === 'Hindi' ? 'आवंटन बाकी' : 'Not allotted'}`);
        lines.push(`${t('Admitted')}: ${text(source.data, 'admittedAt')} | ${t('Relative')}: ${text(source.data, 'relative')}`);
        if (kind === 'Gate pass') lines.push(`${t('Gate pass')}: ${text(source.data, 'gatePass')} | ${t('Released')}: ${text(source.data, 'dischargedAt')}`);
      } else if (type === 'sample') {
        lines.push(`${t('Barcode')}: ${text(source.data, 'barcode')} | ${t('Container')}: ${text(source.data, 'container')} | ${t('Collected')}: ${text(source.data, 'collectedAt')}`);
        if (kind === 'Dispatch manifest') lines.push(`${t('Outside lab')}: ${text(source.data, 'lab')} | ${t('Courier')}: ${text(source.data, 'courier')} | ${t('Dispatched')}: ${text(source.data, 'dispatchedAt')} | ${t('Sample count')}: 1`);
      } else if (type === 'consent') {
        lines.push(`${t('Consent')}: ${t(text(source.data, 'kind'))} | ${t('Status')}: ${t(source.status)}`);
        lines.push(`${t('Signer')}: ${text(source.data, 'signer')} | ${t('Witness')}: ${text(source.data, 'witness')} | ${t('Signed at')}: ${text(source.data, 'signedAt')}`);
        lines.push(language === 'Hindi' ? 'यह सहमति का नमूना रिकॉर्ड है। वास्तविक हस्ताक्षर या कानूनी सहमति का प्रमाण नहीं है।' : 'This is a simulated consent record, not evidence of a real signature or legal consent.');
      }
      const prior = ctx.all('document').filter(e => text(e.data, 'sourceId') === source!.id && text(e.data, 'kind') === kind && text(e.data, 'language', 'English') === language);
      if (prior.length) lines.unshift(t('DUPLICATE - reprint'));
      const letterhead = ctx.get('letterhead', 'letterhead');
      const document = ctx.create('document', { name: `${t(kind)} - ${text(patient.data, 'uhid')}`, kind, language, authoredContentTranslated: false, sourceId: source.id, sourceVersion: source.version, lines, barcode: type === 'sample' ? text(source.data, 'barcode') : text(patient.data, 'uhid'), letterhead: letterhead.data, mime: 'application/pdf', generated: true, duplicate: prior.length > 0, watermark: 'SAMPLE ONLY' }, 'Available', { patientId: patient.id, doctorId: source.doctorId });
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
      const language = text(certificate.data, 'language') === 'Hindi' ? 'Hindi' : 'English'; const t = (value: string) => translate(value, language);
      const doc = ctx.create('document', { name: text(certificate.data, 'number'), kind: 'Certificate', language, sourceId: certificate.id, mime: 'application/pdf', generated: true, watermark: 'SAMPLE ONLY',
        letterhead: ctx.get('letterhead').data, lines: [`${t('Serial')}: ${text(certificate.data, 'number')}`, `${t('Patient')}: ${text(patient.data, 'name')} | ${text(patient.data, 'uhid')}`, text(certificate.data, 'content'), `${t('Issued by')} ${text(certificate.data, 'author')} / ${text(certificate.data, 'registration')}`,
          language === 'Hindi' ? 'केवल नमूना प्रमाणपत्र — कानूनी रूप से मान्य नहीं' : 'Synthetic certificate only - not legally valid'] }, 'Available', { patientId: certificate.patientId, doctorId: certificate.doctorId });
      ctx.result = { documentId: doc.id, downloadUrl: `/api/documents/${doc.id}/file` }; break;
    }
    default: return false;
  }
  return true;
}
function stringsSafe(value: unknown): string[] { return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []; }
