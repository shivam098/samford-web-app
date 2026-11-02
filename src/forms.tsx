import React, { useEffect, useRef, useState } from 'react';
import { commands } from '../shared/commands.js';
import { text, num, bool, rows, strings, label, currency, istDate, featureEnabled, actorDocumentKinds, hasRole, actorRoles, roleNames, documentKinds, doctorRoles, type Role, type Actor, type CommandDef, type Data, type Entity, type Field, type Json, type Snapshot } from '../shared/model.js';
import { ErrorBox, Icon, Pill } from './ui.js';
import { HomeLayoutEditor, HandoverEditor, RosterPreview, PayerRatesEditor, DenominationEditor, CounterPreview, DecisionContext } from './workflow-fields.js';
import { defaultHomeLayout, layoutFromPreferences } from '../shared/home.js';
import { denominationTotal } from '../shared/finance.js';
import { useI18n } from './i18n.js';
import { commandHint, printLanguage, translate, type Language } from '../shared/i18n.js';
import { api, type Vault } from './storage.js';

export type FormContext = { patientId?: string; visitId?: string; admissionId?: string; targetId?: string; preset?: Data };
export type FormProps = {
  command: CommandDef; snapshot: Snapshot; context?: FormContext; vault: Vault;
  saveDraft: (key: string, value: Data) => Promise<void>;
  submit: (command: CommandDef, payload: Data, targetId: string | undefined, draftKey: string, actingRole?: Role) => Promise<void>;
};
const localInput = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 16);
function defaults(command: CommandDef, snapshot: Snapshot, context: FormContext): Data {
  const data: Data = { ...(context.preset ?? {}) };
  const target = context.targetId ? snapshot.entities.find(e => e.id === context.targetId) : undefined;
  for (const field of command.fields) {
    if (data[field.key] !== undefined) continue;
    if (context[field.key as keyof FormContext] && typeof context[field.key as keyof FormContext] === 'string') data[field.key] = context[field.key as 'patientId' | 'visitId' | 'admissionId'] ?? '';
    else if (['preferences.save', 'preferences.language'].includes(command.name) && snapshot.actor.preferences[field.key] !== undefined) data[field.key] = snapshot.actor.preferences[field.key];
    else if (command.name === 'document.generate' && field.key === 'language') data[field.key] = printLanguage(snapshot.actor);
    else if (target && ['account.edit', 'account.role', 'device.minimum'].includes(command.name) && target.data[field.key] !== undefined) data[field.key] = target.data[field.key];
    else if (field.default !== undefined) data[field.key] = field.default;
    else if (field.kind === 'homeLayout') data[field.key] = command.name === 'preferences.save' ? layoutFromPreferences(snapshot.actor.preferences) : defaultHomeLayout();
    else if (field.kind === 'handovers') data[field.key] = [];
    else if (field.kind === 'payerRates') data[field.key] = {};
    else if (field.kind === 'denominations') data[field.key] = {};
    else if (field.key === 'month') data[field.key] = istDate(snapshot.now).slice(0, 7);
    else if (field.kind === 'boolean') data[field.key] = false;
    else if (field.kind === 'date') data[field.key] = field.required ? istDate(snapshot.now) : '';
    else if (field.kind === 'datetime') data[field.key] = field.required ? localInput(snapshot.now) : '';
    else if (field.kind === 'select') data[field.key] = field.options?.[0] ?? '';
    else if (['tests', 'checklist', 'medicines', 'payments'].includes(field.kind)) data[field.key] = [];
    else data[field.key] = '';
  }
  if (command.name === 'bill.pay' && target) data.payments = [{ mode: snapshot.actor.role === 'patient' ? 'UPI' : 'Cash', amount: (num(target.data, 'total') - num(target.data, 'paid')) / 100 }];
  if (command.name === 'sample.accept' && target) data.barcode = text(target.data, 'barcode');
  if (command.name === 'result.enter' && target && text(target.data, 'testId') === 'potassium') Object.assign(data, { unit: 'mmol/L', low: 3.5, high: 5.1 });
  if (command.name === 'visit.book' && snapshot.actor.role === 'patient' && snapshot.actor.patientIds.length === 1) data.patientId = snapshot.actor.patientIds[0];
  if (command.name === 'document.generate' && actorDocumentKinds(snapshot.actor)) data.kind = actorDocumentKinds(snapshot.actor)![0] ?? '';
  return data;
}
function PenPad({ attach, clear }: { attach: (file: Data) => void; clear: () => void }) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null); const drawing = useRef(false); const [hasInk, setHasInk] = useState(false);
  useEffect(() => { const canvas = ref.current!; const context = canvas.getContext('2d')!; context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }, []);
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = ref.current!; const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
  }
  return <div className="pen-pad"><p>{language === 'Hindi' ? 'पॉइंटर, स्टाइलस या उँगली से लिखें। पाठ पहचान का केवल अनुकरण है; जाँची हुई छवि नोट के साथ सहेज सकते हैं।' : 'Draw with a pointer, stylus or finger. Text recognition is simulated below; the reviewed image itself can be kept with the note.'}</p>
    <canvas ref={ref} width={800} height={300} aria-label={t('Synthetic handwriting pad')} onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId); drawing.current = true;
      const { x, y } = point(event); const context = ref.current!.getContext('2d')!; context.beginPath(); context.moveTo(x, y); context.strokeStyle = '#23493f'; context.lineWidth = 3; context.lineCap = 'round';
    }} onPointerMove={event => { if (!drawing.current) return; const { x, y } = point(event); const context = ref.current!.getContext('2d')!; context.lineTo(x, y); context.stroke(); setHasInk(true); }}
    onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }}/>
    <div className="button-row"><button type="button" className="button secondary small" onClick={() => { const canvas = ref.current!; const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); setHasInk(false); clear(); }}>{t('Clear this drawing')}</button>
      <button type="button" className="button primary small" disabled={!hasInk} onClick={() => attach({ name: 'synthetic-handwriting.png', mime: 'image/png', base64: ref.current!.toDataURL('image/png').split(',')[1] })}>{t('Reviewed: attach handwriting image')}</button></div>
  </div>;
}
function entityOptions(field: Field, snapshot: Snapshot, payload: Data, context: FormContext, target?: Entity, language: Language = 'English'): { id: string; name: string }[] {
  if (field.source === 'doctor') {
    const department = text(payload, 'departmentId');
    return snapshot.people.filter(p => p.role === 'doctor' && p.state === 'Active' && (!department || !['receiverId', 'doctorId'].includes(field.key) || p.department === department)).map(p => ({ id: p.id, name: `${p.name} - ${p.department}` }));
  }
  if (field.source === 'staff') return snapshot.people.filter(p => !['patient', 'doctor', 'resident'].includes(p.role) && p.state === 'Active').map(p => ({ id: p.id, name: p.name }));
  const patientId = text(payload, 'patientId') || context.patientId || target?.patientId;
  const admissionId = text(payload, 'admissionId') || context.admissionId;
  return snapshot.entities.filter(e => e.type === field.source && (!field.states || field.states.includes(e.status)) &&
    (field.crossPatient || !patientId || !e.patientId || e.patientId === patientId) &&
    (field.crossPatient || !admissionId || !text(e.data, 'admissionId') || text(e.data, 'admissionId') === admissionId)
  ).map(e => ({ id: e.id, name: `${label(e)}${e.patientId ? ` - ${label(snapshot.entities.find(p => p.id === e.patientId) ?? e)}` : ''} (${translate(e.status, language)})${e.type === 'batch' ? ` | qty ${num(e.data, 'quantity')} | exp ${text(e.data, 'expiry')}` : ''}` }));
}
function MedicineEditor({ value, onChange, snapshot, context }: { value: Json | undefined; onChange: (value: Json) => void; snapshot: Snapshot; context: FormContext }) {
  const { t, language } = useI18n();
  const lines = Array.isArray(value) ? value.filter((line): line is Data => typeof line === 'object' && line !== null && !Array.isArray(line)) : [];
  const [copy, setCopy] = useState('');
  const sets = snapshot.entities.filter(e => e.type === 'set' && text(e.data, 'kind') === 'Medicines');
  const previous = snapshot.entities.filter(e => e.type === 'rx' && e.patientId === context.patientId);
  const update = (index: number, key: string, value: Json) => onChange(lines.map((line, i) => i === index ? { ...line, [key]: value, ...(key !== 'reviewed' ? { reviewed: false } : {}) } : line));
  return <div className="line-editor">
    <div className="inline-form"><select aria-label={t('Use a saved set / repeat a past prescription')} value={copy} onChange={event => setCopy(event.target.value)}><option value="">{t('Use a saved set / repeat a past prescription')}</option>{[...sets, ...previous].map(e => <option key={e.id} value={e.id}>{label(e)} · v{num(e.data, 'rxVersion', e.version)}</option>)}</select>
      <button type="button" className="button secondary small" disabled={!copy} onClick={() => { const selected = snapshot.entities.find(e => e.id === copy); if (selected) onChange(rows(selected.data, 'lines').map(line => ({ ...line, reviewed: false, id: '', dispensed: 0 }))); }}>{t('Load for review')}</button></div>
    {lines.map((line, index) => <fieldset className="medicine-line" key={index}><legend>{t('Medicine')} {index + 1}</legend>
      <label>{t('Medicine')}<select aria-label={`${t('Medicine')} ${index + 1}`} required value={text(line, 'itemId')} onChange={event => update(index, 'itemId', event.target.value)}>
        <option value="">{t('Choose by salt or brand')}</option>{snapshot.entities.filter(e => e.type === 'item').map(item => <option value={item.id} key={item.id}>{label(item)} / {text(item.data, 'salt')} / {text(item.data, 'strength')}{item.status !== 'Active' ? ` - ${language === 'Hindi' ? 'अब उपलब्ध नहीं' : 'RETIRED'}` : ''}</option>)}
      </select></label>
      <div className="form-grid">
        <label>{t('Dose')}<input aria-label={`${t('Dose')} ${index + 1}`} required value={text(line, 'dose')} onChange={e => update(index, 'dose', e.target.value)}/></label>
        <label>{t('Frequency')}<select aria-label={`${t('Frequency')} ${index + 1}`} value={text(line, 'frequency', 'Once daily')} onChange={e => update(index, 'frequency', e.target.value)}>{['Once daily', 'Twice daily', 'Three times daily', 'Alternate days', 'Taper (see remark)', 'As needed'].map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>
        <label>{t('Route')}<select value={text(line, 'route', 'Oral')} onChange={e => update(index, 'route', e.target.value)}>{['Oral', 'Topical', 'IV', 'IM', 'Inhaled'].map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>
        <label>{t('Food')}<select value={text(line, 'food', 'After food')} onChange={e => update(index, 'food', e.target.value)}>{['After food', 'Before food', 'With food', 'Not applicable'].map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>
        <label>{t('Days')}<input aria-label={`${t('Days')} ${index + 1}`} type="number" min="1" max="365" required value={num(line, 'days', 1)} onChange={e => update(index, 'days', Number(e.target.value))}/></label>
        <label>{t('Quantity')}<input aria-label={`${t('Quantity')} ${index + 1}`} type="number" min="1" required value={num(line, 'quantity', 1)} onChange={e => update(index, 'quantity', Number(e.target.value))}/></label>
        <label>{t('Start date')}<input type="date" required value={text(line, 'start', istDate(snapshot.now))} onChange={e => update(index, 'start', e.target.value)}/></label>
        <label>{t('Remark / taper schedule')}<input value={text(line, 'remark')} onChange={e => update(index, 'remark', e.target.value)}/></label>
      </div>
      <div className="split"><label className="check"><input aria-label={`${language === 'Hindi' ? 'जाँची हुई दवा' : 'Reviewed medicine'} ${index + 1}`} type="checkbox" checked={bool(line, 'reviewed')} onChange={e => update(index, 'reviewed', e.target.checked)}/>{t('I reviewed this medicine, dose and schedule')}</label><button type="button" className="text-button danger-text" onClick={() => onChange(lines.filter((_, i) => i !== index))}>{t('Remove line')}</button></div>
    </fieldset>)}
    <button type="button" className="button secondary small" onClick={() => onChange([...lines, { itemId: '', dose: '1 tablet', frequency: 'Once daily', route: 'Oral', food: 'After food', days: 5, quantity: 5, start: istDate(snapshot.now), remark: '', reviewed: false }])}><Icon name="plus" size={16}/>{t('Add medicine')}</button>
    <p className="micro">{language === 'Hindi' ? 'केवल नमूना पर्चा। स्वीकृति के समय एलर्जी और दोहराव जाँचे जाते हैं; वास्तविक दवा-परस्पर-प्रभाव सेवा जुड़ी नहीं है।' : 'Synthetic prescribing only. Allergy and duplicate warnings are checked on acceptance; no clinical interaction engine is connected.'}</p>
  </div>;
}
function TestsEditor({ value, onChange, snapshot }: { value: Json | undefined; onChange: (value: Json) => void; snapshot: Snapshot }) {
  const { t, language } = useI18n();
  const [q, setQ] = useState(''); const selected = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  const tests = snapshot.entities.filter(e => e.type === 'test' && `${label(e)} ${text(e.data, 'loinc')}`.toLowerCase().includes(q.toLowerCase()));
  return <div><input aria-label={t('Search tests')} placeholder={language === 'Hindi' ? 'नाम या LOINC कोड खोजें…' : 'Search name or LOINC...'} value={q} onChange={e => setQ(e.target.value)}/>
    <select aria-label={t('Choose a saved test set')} defaultValue="" onChange={e => { const set = snapshot.entities.find(item => item.id === e.target.value); if (set) onChange(strings(set.data, 'tests')); }}><option value="">{t('Choose a saved test set')}</option>{snapshot.entities.filter(e => e.type === 'set' && text(e.data, 'kind') === 'Tests').map(e => <option key={e.id} value={e.id}>{label(e)}</option>)}</select>
    <div className="test-options">{tests.map(test => <label className="test-option" key={test.id}><input type="checkbox" checked={selected.includes(test.id)} onChange={e => onChange(e.target.checked ? [...selected, test.id] : selected.filter(id => id !== test.id))}/><span><strong>{label(test)}</strong><small>{text(test.data, 'loinc')} · {text(test.data, 'container')} · {currency(num(test.data, 'price'))}</small></span><Pill>{test.status}</Pill></label>)}</div>
    <p className="micro">{selected.length} {language === 'Hindi' ? 'चुनी गईं। केवल खोजने से आदेश नहीं बनता। कीमतें केवल पढ़ने के लिए हैं।' : 'selected. Typed search text alone never creates an order. Prices are read-only.'}</p>
  </div>;
}
function PaymentEditor({ value, onChange, actor }: { value: Json | undefined; onChange: (value: Json) => void; actor: Actor }) {
  const { t, language } = useI18n();
  const lines = Array.isArray(value) ? value.filter((x): x is Data => x !== null && typeof x === 'object' && !Array.isArray(x)) : [];
  return <div className="line-editor">{lines.map((line, index) => <div className="payment-line" key={index}>
    <label>{t('Mode')}<select value={text(line, 'mode')} onChange={e => onChange(lines.map((x, i) => i === index ? { ...x, mode: e.target.value } : x))}>{(actor.role === 'patient' ? ['UPI', 'Card'] : ['Cash', 'UPI', 'Card']).map(mode => <option key={mode} value={mode}>{t(mode)}</option>)}</select></label>
    <label>{t('Amount (INR)')}<input aria-label={`${language === 'Hindi' ? t('Payment amount') : 'Payment amount'} ${index + 1}`} type="number" min="0.01" step="0.01" required value={num(line, 'amount')} onChange={e => onChange(lines.map((x, i) => i === index ? { ...x, amount: Number(e.target.value) } : x))}/></label>
    <button type="button" className="icon-btn" aria-label={t('Remove payment split')} onClick={() => onChange(lines.filter((_, i) => i !== index))}><Icon name="close"/></button>
  </div>)}<button type="button" className="button secondary small" disabled={lines.length >= 3} onClick={() => onChange([...lines, { mode: actor.role === 'patient' ? 'Card' : 'UPI', amount: 0 }])}>{t('Add split')}</button><p className="micro">{t('No real money is collected. Try both Success and Failure outcomes.')}</p></div>;
}
export function ActionForm({ command, snapshot, context = {}, vault, saveDraft, submit }: FormProps) {
  const { t, language } = useI18n();
  const key = `${command.name}:${context.visitId || context.patientId || context.admissionId || context.targetId || 'new'}`;
  const [targetId, setTargetId] = useState(() => {
    const restored = text(vault.drafts[key] ?? {}, '_targetId');
    const candidate = context.targetId || restored;
    return snapshot.entities.some(e => e.id === candidate && e.type === command.target) ? candidate : '';
  });
  const [payload, setPayload] = useState<Data>(() => vault.drafts[key] ?? defaults(command, snapshot, context));
  const [error, setError] = useState(''); const [saveState, setSaveState] = useState(vault.drafts[key] ? 'Restored encrypted draft' : ''); const [submitting, setSubmitting] = useState(false);
  const [simulation, setSimulation] = useState('');
  const [actingRole, setActingRole] = useState<Role>(snapshot.actor.role);
  const actionRoles = actorRoles(snapshot.actor).filter(role => command.roles.includes(role) && (command.name !== 'document.generate' || doctorRoles.includes(role) || documentKinds[role]?.includes(text(payload, 'kind'))));
  const effectiveRole = actionRoles.includes(actingRole) ? actingRole : actionRoles[0];
  const [slots, setSlots] = useState<Data[]>();
  const [slotError, setSlotError] = useState('');
  const [quote, setQuote] = useState<Data>(); const [quoteError, setQuoteError] = useState('');
  const target = snapshot.entities.find(e => e.id === targetId);
  const eligible = snapshot.entities.filter(e => e.type === command.target && (!command.from || command.from.includes(e.status)) && (!context.patientId || !e.patientId || e.patientId === context.patientId) && (!context.visitId || e.id === context.visitId || !text(e.data, 'visitId') || text(e.data, 'visitId') === context.visitId));
  useEffect(() => {
    if (!['visit.book', 'visit.move', 'followup.book', 'followup.request'].includes(command.name) || !text(payload, 'doctorId') || !text(payload, 'date') || vault.offline) { setSlots(undefined); return; }
    let active = true;
    const params = new URLSearchParams({ doctorId: text(payload, 'doctorId'), date: text(payload, 'date'), ...(command.name === 'visit.move' && targetId ? { excludeVisitId: targetId } : {}) });
    void api<Data[]>(`/api/slots?${params}`).then(result => { if (active) { setSlots(result); setSlotError(''); } }).catch(error => { if (active) { setSlots(undefined); setSlotError(error.message); } });
    return () => { active = false; };
  }, [command.name, text(payload, 'doctorId'), text(payload, 'date'), targetId, vault.offline]);
  const quotePayer = text(payload, 'payer') || text(snapshot.entities.find(entity => entity.id === text(payload, 'patientId'))?.data ?? {}, 'payer', 'Self');
  useEffect(() => {
    if (!['claim.create', 'claim.reconcilePackage', 'package.sell', 'daycare.start'].includes(command.name) || !text(payload, 'packageId') || vault.offline) { setQuote(undefined); return; }
    let active = true;
    const payer = command.name === 'claim.reconcilePackage' ? text(target?.data ?? {}, 'payer', quotePayer) : quotePayer;
    void api<Data>(`/api/packages/${encodeURIComponent(text(payload, 'packageId'))}/quote?${new URLSearchParams({ payer })}`).then(result => {
      if (!active) return; setQuote(result); setQuoteError('');
      if (command.name === 'claim.create' && ['Ayushman', 'CGHS'].includes(payer)) setPayload(current => ({ ...current, amount: num(result, 'rate') / 100 }));
    }).catch(error => { if (active) { setQuote(undefined); setQuoteError(error.message); } });
    return () => { active = false; };
  }, [command.name, text(payload, 'packageId'), quotePayer, targetId, vault.offline]);
  function change(key: string, value: Json) {
    const next = { ...payload, [key]: value };
    if (key === 'lockedCards' && Array.isArray(value) && next.layout && typeof next.layout === 'object' && !Array.isArray(next.layout)) next.layout = { cards: rows(next.layout, 'cards').map(card => value.includes(text(card, 'id')) ? { ...card, visible: true } : card) };
    if (key === 'denominations' && value && typeof value === 'object' && !Array.isArray(value)) next.countedCash = denominationTotal(value);
    if (key === 'patientId' && command.name === 'claim.create') {
      const payer = text(snapshot.entities.find(entity => entity.id === value)?.data ?? {}, 'payer');
      if (['Ayushman', 'CGHS', 'TPA', 'Corporate'].includes(payer)) next.payer = payer;
    }
    setPayload(next); setSaveState('Saving draft...');
    void saveDraft(`${command.name}:${context.visitId || context.patientId || context.admissionId || context.targetId || 'new'}`, { ...next, _targetId: targetId }).then(() => setSaveState('Draft saved on this browser')).catch(error => { setError(String(error.message)); setSaveState('Not saved'); });
  }
  function targetChanged(id: string) {
    setTargetId(id);
    const targetContext = { ...context, targetId: id };
    const next = defaults(command, snapshot, targetContext);
    setPayload(next); setError(''); setSaveState('');
  }
  const selectedPatient = snapshot.entities.find(e => e.id === (text(payload, 'patientId') || context.patientId || target?.patientId));
  const visitEntity = snapshot.entities.find(e => e.id === (text(payload, 'visitId') || context.visitId));
  const formContext: FormContext = { ...context, patientId: selectedPatient?.id ?? visitEntity?.patientId };
  const writeMode = text(payload, 'mode');
  const consentSource = command.name === 'document.generate' && text(payload, 'kind') === 'Consent form'
    ? snapshot.entities.filter(entity => entity.type === 'consent' && entity.patientId === selectedPatient?.id && entity.status === 'Signed' && (!text(payload, 'sourceId') || entity.id === text(payload, 'sourceId')))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
  const consentLanguage = consentSource ? text(consentSource.data, 'language', 'English') : '';
  async function onSubmit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setSubmitting(true);
    const clean = { ...payload }; delete clean._targetId;
    if (consentLanguage) clean.language = consentLanguage;
    for (const field of command.fields) {
      if (field.kind === 'datetime' && typeof clean[field.key] === 'string' && clean[field.key]) clean[field.key] = new Date(`${clean[field.key]}:00+05:30`).toISOString();
      if (!field.required && (clean[field.key] === '' || clean[field.key] === null)) delete clean[field.key];
    }
    try { await submit(command, clean, command.target ? targetId : undefined, key, effectiveRole); setSaveState('Saved on this browser. Check sync for hospital acceptance.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save this action. Keep the form open.'); }
    finally { setSubmitting(false); }
  }
  function lineOptions(field: Field) {
    if (field.key === 'lineId') {
      const source = target?.type === 'rx' ? target : snapshot.entities.find(e => e.id === text(payload, 'billId'));
      if (source) return rows(source.data, 'lines').map(line => ({ id: text(line, 'id'), name: `${text(line, 'name')} | remaining ${num(line, 'quantity') - num(line, 'dispensed')} | ${text(line, 'id')}` }));
    }
    if (field.key === 'orderId' && command.name === 'package.skip' && target) return strings(target.data, 'orderIds').map(id => { const order = snapshot.entities.find(e => e.id === id); return { id, name: order ? `${label(order)} (${order.status})` : id }; });
    if (field.key === 'sourceId' && command.name === 'document.generate') {
      const type = ({ Prescription: 'rx', Result: 'result', Receipt: 'payment', Bill: 'bill', 'Credit note': 'refund', 'OPD slip': 'visit', 'OPD summary': 'note', Casesheet: 'note', 'Discharge summary': 'discharge', 'Referral letter': 'referral', 'Admission form': 'admission', Wristband: 'admission', 'Gate pass': 'admission', 'Sample label': 'sample', 'Dispatch manifest': 'sample', 'Consent form': 'consent' } as Record<string, string>)[text(payload, 'kind')];
      return snapshot.entities.filter(e => e.type === type && (!text(payload, 'patientId') || e.patientId === text(payload, 'patientId'))).map(e => ({ id: e.id, name: `${label(e)} (${e.status})` }));
    }
    return undefined;
  }
  function fieldControl(field: Field) {
    const value = payload[field.key];
    const inputId = `${command.name}-${field.key}`;
    if (field.key === 'language' && consentLanguage) return <div><select id={inputId} value={consentLanguage} disabled><option value={consentLanguage}>{t(consentLanguage)}</option></select><small>{language === 'Hindi' ? 'सहमति पत्र की दर्ज भाषा सुरक्षित रहती है; प्रिंट में उसे नहीं बदला जा सकता।' : 'The signed consent’s recorded language is preserved; printing cannot change it.'}</small></div>;
    if (field.kind === 'homeLayout') {
      const policy = snapshot.settings.home;
      const locked = command.name === 'home.defaults' ? ['referrals', 'results', ...strings(payload, 'lockedCards')] : policy && typeof policy === 'object' && !Array.isArray(policy) ? strings(policy, 'lockedCards') : ['referrals', 'results'];
      return <HomeLayoutEditor value={value} onChange={layout => change(field.key, layout)} locked={locked}/>;
    }
    if (field.kind === 'handovers') return <HandoverEditor value={value} onChange={next => change(field.key, next)} targetId={targetId} snapshot={snapshot} allowWaiting={command.name === 'account.suspend'}/>;
    if (field.kind === 'payerRates') return <PayerRatesEditor value={value} onChange={next => change(field.key, next)}/>;
    if (field.kind === 'denominations') return <DenominationEditor value={value} onChange={next => change(field.key, next)}/>;
    if (field.key === 'time' && field.kind === 'time' && slots) return <div><select id={inputId} value={typeof value === 'string' ? value : ''} required={field.required} onChange={event => change(field.key, event.target.value)}>
      <option value="">{language === 'Hindi' ? 'साझा सूची से खाली स्लॉट चुनें…' : 'Choose a free shared slot...'}</option>{slots.map(slot => <option key={text(slot, 'time')} value={text(slot, 'time')} disabled={slot.state !== 'Free'}>{text(slot, 'time')} - {t(text(slot, 'state'))}{slot.extra ? language === 'Hindi' ? ' (अतिरिक्त, कारण आवश्यक)' : ' (extra, reason required)' : ''}{slot.reason ? `: ${t(text(slot, 'reason'))}` : ''}</option>)}
    </select><small>{slots.filter(slot => slot.state === 'Free').length} {language === 'Hindi' ? 'खाली स्लॉट। अस्पताल की स्वीकृति तक आरक्षण नहीं है।' : 'free slots. This is not a reservation until the hospital accepts.'}</small></div>;
    if (field.kind === 'boolean') return <label className="check"><input id={inputId} type="checkbox" checked={value === true} required={field.required} onChange={e => change(field.key, e.target.checked)}/>{t(field.label)}{field.required && <span aria-hidden="true"> *</span>}</label>;
    if (field.kind === 'medicines') return <MedicineEditor value={value} onChange={v => change(field.key, v)} snapshot={snapshot} context={formContext}/>;
    if (field.kind === 'tests') return <TestsEditor value={value} onChange={v => change(field.key, v)} snapshot={snapshot}/>;
    if (field.kind === 'payments') return <PaymentEditor value={value} onChange={v => change(field.key, v)} actor={snapshot.actor}/>;
    if (field.kind === 'checklist') return <div className="checklist">{field.options?.map(option => <label className="check" key={option}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={e => change(field.key, e.target.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value : []).filter(v => v !== option))}/>{t(option)}</label>)}</div>;
    if (field.kind === 'entity' || field.kind === 'select' || lineOptions(field)) {
      let options = field.kind === 'entity' ? entityOptions(field, snapshot, payload, context, target, language) : lineOptions(field) ?? (field.options ?? []).map(option => ({ id: option, name: option }));
      if (command.name === 'note.save' && field.key === 'mode' && !featureEnabled(snapshot, 'Dictation')) options = options.filter(option => option.id !== 'Dictation simulation');
      if (command.name === 'document.share' && field.key === 'channel' && !featureEnabled(snapshot, 'WhatsApp')) options = options.filter(option => option.id !== 'WhatsApp');
      if (command.name === 'document.generate' && field.key === 'kind' && actorDocumentKinds(snapshot.actor)) options = options.filter(option => actorDocumentKinds(snapshot.actor)!.includes(option.id));
      return <select id={inputId} value={typeof value === 'string' ? value : ''} required={field.required} onChange={e => change(field.key, e.target.value)}><option value="">{field.required ? t('Choose...') : t('Not selected / latest')}</option>{options.map(option => <option key={option.id} value={option.id}>{t(option.name)}</option>)}</select>;
    }
    if (field.kind === 'file') return <div><input id={inputId} type="file" accept=".pdf,.png,.jpg,.jpeg" required={Boolean(field.required && !value)} onChange={async event => {
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > 10 * 1024 * 1024) { setError('Choose a sample document up to 10 MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => change(field.key, { name: file.name, mime: file.type, base64: String(reader.result).split(',')[1] });
      reader.onerror = () => setError('File could not be read. Choose a readable sample file.');
      reader.readAsDataURL(file);
    }}/>{value && typeof value === 'object' && !Array.isArray(value) ? <p className="micro">{language === 'Hindi' ? 'मसौदे का संलग्नक' : 'Draft attachment'}: {text(value, 'name')}</p> : null}</div>;
    if (field.kind === 'csv') return <div><div className="inline-form"><button type="button" className="button secondary small" onClick={() => {
      const content = command.name === 'account.import' ? 'name,staffId,registration,login,mobile,email,departmentId,role,qualification,room\nDemo new doctor,SAMPLE-NEW-1,SAMPLE-REG-NEW,new-doctor,9000099991,new-doctor@sample.invalid,general,doctor,Sample qualification,Room 3' : 'departmentId,doctorId,date,shift,reason\n' + `general,doctor-a,${istDate(snapshot.now)},Night,Sample rota`;
      change(field.key, content);
    }}>Load editable sample CSV</button><input aria-label="Read CSV file" type="file" accept=".csv,text/csv" onChange={async e => { const file = e.target.files?.[0]; if (file) { if (file.size > 1000000) setError('CSV must be under 1 MB.'); else change(field.key, await file.text()); } }}/></div><textarea id={inputId} rows={8} required value={typeof value === 'string' ? value : ''} onChange={e => change(field.key, e.target.value)}/></div>;
    if (field.kind === 'textarea') return <textarea id={inputId} rows={3} required={field.required} value={typeof value === 'string' ? value : ''} onChange={e => change(field.key, e.target.value)}/>;
    return <input id={inputId} type={field.kind === 'datetime' ? 'datetime-local' : ['number', 'date', 'time', 'password'].includes(field.kind) ? field.kind : 'text'} autoComplete="off" step={field.kind === 'number' ? 'any' : undefined} required={field.required} min={field.min} max={field.max}
      readOnly={command.name === 'claim.create' && field.key === 'amount' && Boolean(quote) && ['Ayushman', 'CGHS'].includes(quotePayer)}
      value={typeof value === 'number' || typeof value === 'string' ? value : ''} onChange={e => change(field.key, field.kind === 'number' ? e.target.value === '' ? '' : Number(e.target.value) : e.target.value)}/>;
  }
  const affected = command.name === 'availability.request' ? snapshot.entities.filter(e => e.type === 'visit' && e.doctorId === snapshot.actor.id && text(e.data, 'date') >= text(payload, 'date') && text(e.data, 'date') <= text(payload, 'endDate') && !['Cancelled', 'Done'].includes(e.status)).length : 0;
  return <form className="action-form" data-command={command.name} onSubmit={onSubmit}>
    <div className="form-heading"><h3>{t(command.label)}</h3><span className="micro">{t('Validated API action')}</span></div><p className="form-help">{commandHint(command, language)}</p>
    {actionRoles.length > 1 && <label className="field">Acting staff role<select aria-label="Acting staff role" value={effectiveRole} onChange={event => setActingRole(event.target.value as Role)}>{actionRoles.map(role => <option value={role} key={role}>{roleNames[role]}</option>)}</select><small>Your identity remains {snapshot.actor.name}. Independent approvals still require a different person.</small></label>}
    {command.target && <label className="field">{t('Work item')} <span aria-hidden="true">*</span><select aria-label={t('Work item')} value={targetId || text(payload, '_targetId')} required onChange={e => targetChanged(e.target.value)}><option value="">{language === 'Hindi' ? 'कार्य चुनें…' : `Choose a ${command.target}...`}</option>{eligible.map(e => <option key={e.id} value={e.id}>{label(e)} ({t(e.status)})</option>)}</select>{!eligible.length && <small className="warning-text">{language === 'Hindi' ? 'अभी कोई उपयुक्त कार्य नहीं है। पिछला चरण पूरा करके सूची ताज़ा करें।' : 'No eligible item yet. Complete the preceding handoff, then refresh.'}</small>}</label>}
    {selectedPatient && <div className="form-patient"><Icon name="people" size={18}/><span><strong>{label(selectedPatient)}</strong> · {text(selectedPatient.data, 'uhid')} · {num(selectedPatient.data, 'age')}y {text(selectedPatient.data, 'sex')}</span></div>}
    {target && <DecisionContext target={target} snapshot={snapshot}/>}
    {command.name === 'operation.emergencySchedule' && text(payload, 'plannedId') && <DecisionContext target={snapshot.entities.find(entity => entity.id === text(payload, 'plannedId'))} snapshot={snapshot}/>}
    {command.name === 'availability.request' && <div className="notice">{affected} {language === 'Hindi' ? 'बुक की हुई विज़िट प्रभावित हैं। यह अनुरोध उन्हें बदलता या रद्द नहीं करता।' : 'booked visits affected. This request does not move or cancel them.'}</div>}
    {quote && <div className="notice">Published {text(quote, 'payer')} package rate: <strong>{currency(num(quote, 'rate'))}</strong> · {text(quote, 'name')} · master version {num(quote, 'sourceVersion')}. The server rechecks the quote at submission.</div>}
    <ErrorBox message={quoteError}/>
    {command.name === 'note.save' && <div className="note-tools">
      <label>{t('Load template')}<select defaultValue="" onChange={e => { const template = snapshot.entities.find(item => item.id === e.target.value); if (template) change('illness', text(template.data, 'content')); }}><option value="">{t('Select a published template...')}</option>{snapshot.entities.filter(e => e.type === 'template').map(e => <option key={e.id} value={e.id}>{label(e)}</option>)}</select></label>
      {writeMode === 'Pen simulation' && <PenPad attach={file => change('handwriting', file)} clear={() => change('handwriting', null)}/>}
      {['Dictation simulation', 'Pen simulation'].includes(writeMode) && <div className="notice"><strong>{t(writeMode)} - {language === 'Hindi' ? 'वास्तविक पहचान सेवा नहीं' : 'no live recognition'}</strong><p>{language === 'Hindi' ? 'पहचाने गए पाठ का नमूना दर्ज करें। समीक्षा के बाद ही उसका उपयोग होगा।' : 'Enter the simulated recognized text. Nothing is used until you review it.'}</p><textarea aria-label={t('Simulated recognized text')} value={simulation} onChange={e => setSimulation(e.target.value)}/><button type="button" className="button secondary small" disabled={!simulation} onClick={() => change('illness', `${text(payload, 'illness')}${text(payload, 'illness') ? '\n' : ''}${simulation}`)}>{t('Reviewed: use this text')}</button></div>}
    </div>}
    {command.fields.filter(field => !field.hidden).map(field => <div data-field-key={field.key} className={`field ${['medicines', 'tests', 'checklist', 'payments', 'homeLayout', 'handovers', 'payerRates'].includes(field.kind) ? 'full' : ''}`} key={field.key}>
      {field.kind !== 'boolean' && <label htmlFor={`${command.name}-${field.key}`}>{t(field.label)}{field.kind === 'datetime' ? ' (IST)' : ''}{field.required && <span aria-hidden="true"> *</span>}</label>}
      {fieldControl(field)}{field.help && <small>{field.key === 'pin' && language === 'Hindi' ? 'नमूना स्वीकृति पिन: 2468। यह कानूनी चिकित्सकीय हस्ताक्षर नहीं है।' : t(field.help)}</small>}
    </div>)}
    {command.name === 'roster.repeat' && <RosterPreview payload={payload} snapshot={snapshot}/>}
    {command.name === 'counter.close' && <CounterPreview snapshot={snapshot} counted={num(payload, 'countedCash')}/>}
    <ErrorBox message={error}/>
    <ErrorBox message={slotError}/>
    <footer className="form-footer"><span className="micro" role="status">{t(saveState || 'Changes are saved locally before submission.')}</span><button className="button primary" disabled={submitting || (Boolean(command.target) && !eligible.length)}>{submitting ? t('Saving...') : t(command.label)}<Icon name="arrow" size={17}/></button></footer>
  </form>;
}
export function ActionPanel({ journeyId, snapshot, context, ...rest }: Omit<FormProps, 'command'> & { journeyId: string }) {
  const { t, language } = useI18n();
  const allowed = commands.filter(command => command.journeys.includes(journeyId) && hasRole(snapshot.actor, command.roles) && (!command.name.startsWith('video.') || featureEnabled(snapshot, 'Video')));
  const [selected, setSelected] = useState(allowed[0]?.name ?? '');
  const command = allowed.find(c => c.name === selected) ?? allowed[0];
  if (!command) return <div className="notice">{language === 'Hindi' ? 'आपकी भूमिका में यह केवल पढ़ने के लिए है। फ़िल्टर, रिपोर्ट या साइन-इन नियंत्रण इस्तेमाल करें।' : 'This is a read-only view for your role. Use the filters, reports or account sign-in controls.'}</div>;
  return <div className="action-panel"><label className="action-selector">{t('What would you like to do?')}<select value={command.name} onChange={e => setSelected(e.target.value)}>{allowed.map(c => <option key={c.name} value={c.name}>{t(c.label)}</option>)}</select></label><ActionForm key={`${command.name}:${context?.targetId ?? ''}`} command={command} snapshot={snapshot} context={context} {...rest}/></div>;
}
