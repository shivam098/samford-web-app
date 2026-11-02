import React, { useEffect, useRef, useState } from 'react';
import { commands } from '../shared/commands.js';
import { text, num, bool, rows, strings, label, currency, istDate, featureEnabled, documentKinds, type Actor, type CommandDef, type Data, type Entity, type Field, type Json, type Snapshot } from '../shared/model.js';
import { ErrorBox, Icon, Pill } from './ui.js';
import { api, type Vault } from './storage.js';

export type FormContext = { patientId?: string; visitId?: string; admissionId?: string; targetId?: string; preset?: Data };
export type FormProps = {
  command: CommandDef; snapshot: Snapshot; context?: FormContext; vault: Vault;
  saveDraft: (key: string, value: Data) => Promise<void>;
  submit: (command: CommandDef, payload: Data, targetId: string | undefined, draftKey: string) => Promise<void>;
};
const localInput = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 16);
function defaults(command: CommandDef, snapshot: Snapshot, context: FormContext): Data {
  const data: Data = { ...(context.preset ?? {}) };
  const target = context.targetId ? snapshot.entities.find(e => e.id === context.targetId) : undefined;
  for (const field of command.fields) {
    if (data[field.key] !== undefined) continue;
    if (context[field.key as keyof FormContext] && typeof context[field.key as keyof FormContext] === 'string') data[field.key] = context[field.key as 'patientId' | 'visitId' | 'admissionId'] ?? '';
    else if (command.name === 'preferences.save' && snapshot.actor.preferences[field.key] !== undefined) data[field.key] = snapshot.actor.preferences[field.key];
    else if (target && ['account.edit', 'device.minimum'].includes(command.name) && target.data[field.key] !== undefined) data[field.key] = target.data[field.key];
    else if (field.default !== undefined) data[field.key] = field.default;
    else if (field.kind === 'boolean') data[field.key] = false;
    else if (field.kind === 'date') data[field.key] = istDate(snapshot.now);
    else if (field.kind === 'datetime') data[field.key] = localInput(snapshot.now);
    else if (field.kind === 'select') data[field.key] = field.options?.[0] ?? '';
    else if (['tests', 'checklist', 'medicines', 'payments'].includes(field.kind)) data[field.key] = [];
    else data[field.key] = '';
  }
  if (command.name === 'bill.pay' && target) data.payments = [{ mode: snapshot.actor.role === 'patient' ? 'UPI' : 'Cash', amount: (num(target.data, 'total') - num(target.data, 'paid')) / 100 }];
  if (command.name === 'sample.accept' && target) data.barcode = text(target.data, 'barcode');
  if (command.name === 'result.enter' && target && text(target.data, 'testId') === 'potassium') Object.assign(data, { unit: 'mmol/L', low: 3.5, high: 5.1 });
  if (command.name === 'visit.book' && snapshot.actor.role === 'patient' && snapshot.actor.patientIds.length === 1) data.patientId = snapshot.actor.patientIds[0];
  if (command.name === 'document.generate' && documentKinds[snapshot.actor.role]) data.kind = documentKinds[snapshot.actor.role]![0];
  return data;
}
function PenPad({ attach, clear }: { attach: (file: Data) => void; clear: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null); const drawing = useRef(false); const [hasInk, setHasInk] = useState(false);
  useEffect(() => { const canvas = ref.current!; const context = canvas.getContext('2d')!; context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }, []);
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = ref.current!; const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
  }
  return <div className="pen-pad"><p>Draw with a pointer, stylus or finger. Text recognition is simulated below; the reviewed image itself can be kept with the note.</p>
    <canvas ref={ref} width={800} height={300} aria-label="Synthetic handwriting pad" onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId); drawing.current = true;
      const { x, y } = point(event); const context = ref.current!.getContext('2d')!; context.beginPath(); context.moveTo(x, y); context.strokeStyle = '#23493f'; context.lineWidth = 3; context.lineCap = 'round';
    }} onPointerMove={event => { if (!drawing.current) return; const { x, y } = point(event); const context = ref.current!.getContext('2d')!; context.lineTo(x, y); context.stroke(); setHasInk(true); }}
    onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }}/>
    <div className="button-row"><button type="button" className="button secondary small" onClick={() => { const canvas = ref.current!; const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); setHasInk(false); clear(); }}>Clear this drawing</button>
      <button type="button" className="button primary small" disabled={!hasInk} onClick={() => attach({ name: 'synthetic-handwriting.png', mime: 'image/png', base64: ref.current!.toDataURL('image/png').split(',')[1] })}>Reviewed: attach handwriting image</button></div>
  </div>;
}
function entityOptions(field: Field, snapshot: Snapshot, payload: Data, context: FormContext, target?: Entity): { id: string; name: string }[] {
  if (field.source === 'doctor') {
    const department = text(payload, 'departmentId');
    return snapshot.people.filter(p => p.role === 'doctor' && p.state === 'Active' && (!department || !['receiverId', 'doctorId'].includes(field.key) || p.department === department)).map(p => ({ id: p.id, name: `${p.name} - ${p.department}` }));
  }
  if (field.source === 'staff') return snapshot.people.filter(p => !['patient', 'doctor', 'resident'].includes(p.role) && p.state === 'Active').map(p => ({ id: p.id, name: p.name }));
  const patientId = text(payload, 'patientId') || context.patientId || target?.patientId;
  const admissionId = text(payload, 'admissionId') || context.admissionId;
  return snapshot.entities.filter(e => e.type === field.source && (!field.states || field.states.includes(e.status)) &&
    (!patientId || !e.patientId || e.patientId === patientId) &&
    (!admissionId || !text(e.data, 'admissionId') || text(e.data, 'admissionId') === admissionId)
  ).map(e => ({ id: e.id, name: `${label(e)}${e.patientId ? ` - ${label(snapshot.entities.find(p => p.id === e.patientId) ?? e)}` : ''} (${e.status})${e.type === 'batch' ? ` | qty ${num(e.data, 'quantity')} | exp ${text(e.data, 'expiry')}` : ''}` }));
}
function MedicineEditor({ value, onChange, snapshot, context }: { value: Json | undefined; onChange: (value: Json) => void; snapshot: Snapshot; context: FormContext }) {
  const lines = Array.isArray(value) ? value.filter((line): line is Data => typeof line === 'object' && line !== null && !Array.isArray(line)) : [];
  const [copy, setCopy] = useState('');
  const sets = snapshot.entities.filter(e => e.type === 'set' && text(e.data, 'kind') === 'Medicines');
  const previous = snapshot.entities.filter(e => e.type === 'rx' && e.patientId === context.patientId);
  const update = (index: number, key: string, value: Json) => onChange(lines.map((line, i) => i === index ? { ...line, [key]: value, ...(key !== 'reviewed' ? { reviewed: false } : {}) } : line));
  return <div className="line-editor">
    <div className="inline-form"><select aria-label="Medicine set or previous prescription" value={copy} onChange={event => setCopy(event.target.value)}><option value="">Use a saved set / repeat a past prescription</option>{[...sets, ...previous].map(e => <option key={e.id} value={e.id}>{label(e)} · v{num(e.data, 'rxVersion', e.version)}</option>)}</select>
      <button type="button" className="button secondary small" disabled={!copy} onClick={() => { const selected = snapshot.entities.find(e => e.id === copy); if (selected) onChange(rows(selected.data, 'lines').map(line => ({ ...line, reviewed: false, id: '', dispensed: 0 }))); }}>Load for review</button></div>
    {lines.map((line, index) => <fieldset className="medicine-line" key={index}><legend>Medicine {index + 1}</legend>
      <label>Medicine<select aria-label={`Medicine ${index + 1}`} required value={text(line, 'itemId')} onChange={event => update(index, 'itemId', event.target.value)}>
        <option value="">Choose by salt or brand</option>{snapshot.entities.filter(e => e.type === 'item').map(item => <option value={item.id} key={item.id}>{label(item)} / {text(item.data, 'salt')} / {text(item.data, 'strength')}{item.status !== 'Active' ? ' - RETIRED' : ''}</option>)}
      </select></label>
      <div className="form-grid">
        <label>Dose<input aria-label={`Dose ${index + 1}`} required value={text(line, 'dose')} onChange={e => update(index, 'dose', e.target.value)}/></label>
        <label>Frequency<select aria-label={`Frequency ${index + 1}`} value={text(line, 'frequency', 'Once daily')} onChange={e => update(index, 'frequency', e.target.value)}>{['Once daily', 'Twice daily', 'Three times daily', 'Alternate days', 'Taper (see remark)', 'As needed'].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>Route<select value={text(line, 'route', 'Oral')} onChange={e => update(index, 'route', e.target.value)}>{['Oral', 'Topical', 'IV', 'IM', 'Inhaled'].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>Food<select value={text(line, 'food', 'After food')} onChange={e => update(index, 'food', e.target.value)}>{['After food', 'Before food', 'With food', 'Not applicable'].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>Days<input aria-label={`Days ${index + 1}`} type="number" min="1" max="365" required value={num(line, 'days', 1)} onChange={e => update(index, 'days', Number(e.target.value))}/></label>
        <label>Quantity<input aria-label={`Quantity ${index + 1}`} type="number" min="1" required value={num(line, 'quantity', 1)} onChange={e => update(index, 'quantity', Number(e.target.value))}/></label>
        <label>Start date<input type="date" required value={text(line, 'start', istDate(snapshot.now))} onChange={e => update(index, 'start', e.target.value)}/></label>
        <label>Remark / taper schedule<input value={text(line, 'remark')} onChange={e => update(index, 'remark', e.target.value)}/></label>
      </div>
      <div className="split"><label className="check"><input aria-label={`Reviewed medicine ${index + 1}`} type="checkbox" checked={bool(line, 'reviewed')} onChange={e => update(index, 'reviewed', e.target.checked)}/>I reviewed this medicine, dose and schedule</label><button type="button" className="text-button danger-text" onClick={() => onChange(lines.filter((_, i) => i !== index))}>Remove line</button></div>
    </fieldset>)}
    <button type="button" className="button secondary small" onClick={() => onChange([...lines, { itemId: '', dose: '1 tablet', frequency: 'Once daily', route: 'Oral', food: 'After food', days: 5, quantity: 5, start: istDate(snapshot.now), remark: '', reviewed: false }])}><Icon name="plus" size={16}/>Add medicine</button>
    <p className="micro">Synthetic prescribing only. Allergy and duplicate warnings are checked on acceptance; no clinical interaction engine is connected.</p>
  </div>;
}
function TestsEditor({ value, onChange, snapshot }: { value: Json | undefined; onChange: (value: Json) => void; snapshot: Snapshot }) {
  const [q, setQ] = useState(''); const selected = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  const tests = snapshot.entities.filter(e => e.type === 'test' && `${label(e)} ${text(e.data, 'loinc')}`.toLowerCase().includes(q.toLowerCase()));
  return <div><input aria-label="Search tests" placeholder="Search name or LOINC..." value={q} onChange={e => setQ(e.target.value)}/>
    <select aria-label="Test set" defaultValue="" onChange={e => { const set = snapshot.entities.find(item => item.id === e.target.value); if (set) onChange(strings(set.data, 'tests')); }}><option value="">Choose a saved test set</option>{snapshot.entities.filter(e => e.type === 'set' && text(e.data, 'kind') === 'Tests').map(e => <option key={e.id} value={e.id}>{label(e)}</option>)}</select>
    <div className="test-options">{tests.map(test => <label className="test-option" key={test.id}><input type="checkbox" checked={selected.includes(test.id)} onChange={e => onChange(e.target.checked ? [...selected, test.id] : selected.filter(id => id !== test.id))}/><span><strong>{label(test)}</strong><small>{text(test.data, 'loinc')} · {text(test.data, 'container')} · {currency(num(test.data, 'price'))}</small></span><Pill>{test.status}</Pill></label>)}</div>
    <p className="micro">{selected.length} selected. Typed search text alone never creates an order. Prices are read-only.</p>
  </div>;
}
function PaymentEditor({ value, onChange, actor }: { value: Json | undefined; onChange: (value: Json) => void; actor: Actor }) {
  const lines = Array.isArray(value) ? value.filter((x): x is Data => x !== null && typeof x === 'object' && !Array.isArray(x)) : [];
  return <div className="line-editor">{lines.map((line, index) => <div className="payment-line" key={index}>
    <label>Mode<select value={text(line, 'mode')} onChange={e => onChange(lines.map((x, i) => i === index ? { ...x, mode: e.target.value } : x))}>{(actor.role === 'patient' ? ['UPI', 'Card'] : ['Cash', 'UPI', 'Card']).map(mode => <option key={mode}>{mode}</option>)}</select></label>
    <label>Amount (INR)<input aria-label={`Payment amount ${index + 1}`} type="number" min="0.01" step="0.01" required value={num(line, 'amount')} onChange={e => onChange(lines.map((x, i) => i === index ? { ...x, amount: Number(e.target.value) } : x))}/></label>
    <button type="button" className="icon-btn" aria-label="Remove payment split" onClick={() => onChange(lines.filter((_, i) => i !== index))}><Icon name="close"/></button>
  </div>)}<button type="button" className="button secondary small" disabled={lines.length >= 3} onClick={() => onChange([...lines, { mode: actor.role === 'patient' ? 'Card' : 'UPI', amount: 0 }])}>Add split</button><p className="micro">No real money is collected. Try both Success and Failure outcomes.</p></div>;
}
export function ActionForm({ command, snapshot, context = {}, vault, saveDraft, submit }: FormProps) {
  const key = `${command.name}:${context.visitId || context.patientId || context.admissionId || context.targetId || 'new'}`;
  const [targetId, setTargetId] = useState(() => {
    const restored = text(vault.drafts[key] ?? {}, '_targetId');
    const candidate = context.targetId || restored;
    return snapshot.entities.some(e => e.id === candidate && e.type === command.target) ? candidate : '';
  });
  const [payload, setPayload] = useState<Data>(() => vault.drafts[key] ?? defaults(command, snapshot, context));
  const [error, setError] = useState(''); const [saveState, setSaveState] = useState(vault.drafts[key] ? 'Restored encrypted draft' : ''); const [submitting, setSubmitting] = useState(false);
  const [simulation, setSimulation] = useState('');
  const [slots, setSlots] = useState<Data[]>();
  const [slotError, setSlotError] = useState('');
  const target = snapshot.entities.find(e => e.id === targetId);
  const eligible = snapshot.entities.filter(e => e.type === command.target && (!command.from || command.from.includes(e.status)) && (!context.patientId || !e.patientId || e.patientId === context.patientId) && (!context.visitId || e.id === context.visitId || !text(e.data, 'visitId') || text(e.data, 'visitId') === context.visitId));
  useEffect(() => {
    if (!['visit.book', 'visit.move', 'followup.book', 'followup.request'].includes(command.name) || !text(payload, 'doctorId') || !text(payload, 'date') || vault.offline) { setSlots(undefined); return; }
    let active = true;
    const params = new URLSearchParams({ doctorId: text(payload, 'doctorId'), date: text(payload, 'date'), ...(command.name === 'visit.move' && targetId ? { excludeVisitId: targetId } : {}) });
    void api<Data[]>(`/api/slots?${params}`).then(result => { if (active) { setSlots(result); setSlotError(''); } }).catch(error => { if (active) { setSlots(undefined); setSlotError(error.message); } });
    return () => { active = false; };
  }, [command.name, text(payload, 'doctorId'), text(payload, 'date'), targetId, vault.offline]);
  function change(key: string, value: Json) {
    const next = { ...payload, [key]: value }; setPayload(next); setSaveState('Saving draft...');
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
  async function onSubmit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setSubmitting(true);
    const clean = { ...payload }; delete clean._targetId;
    for (const field of command.fields) {
      if (field.kind === 'datetime' && typeof clean[field.key] === 'string' && clean[field.key]) clean[field.key] = new Date(`${clean[field.key]}:00+05:30`).toISOString();
      if (!field.required && (clean[field.key] === '' || clean[field.key] === null)) delete clean[field.key];
    }
    try { await submit(command, clean, command.target ? targetId : undefined, key); setSaveState('Saved on this browser. Check sync for hospital acceptance.'); }
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
      const type = ({ Prescription: 'rx', Result: 'result', Receipt: 'payment', Bill: 'bill', 'OPD slip': 'visit', 'OPD summary': 'note', Casesheet: 'note', 'Discharge summary': 'discharge', 'Referral letter': 'referral', 'Admission form': 'admission', Wristband: 'admission', 'Gate pass': 'admission', 'Sample label': 'sample', 'Dispatch manifest': 'sample' } as Record<string, string>)[text(payload, 'kind')];
      return snapshot.entities.filter(e => e.type === type && (!text(payload, 'patientId') || e.patientId === text(payload, 'patientId'))).map(e => ({ id: e.id, name: `${label(e)} (${e.status})` }));
    }
    return undefined;
  }
  function fieldControl(field: Field) {
    const value = payload[field.key];
    const inputId = `${command.name}-${field.key}`;
    if (field.key === 'time' && field.kind === 'time' && slots) return <div><select id={inputId} value={typeof value === 'string' ? value : ''} required={field.required} onChange={event => change(field.key, event.target.value)}>
      <option value="">Choose a free shared slot...</option>{slots.map(slot => <option key={text(slot, 'time')} value={text(slot, 'time')} disabled={slot.state !== 'Free'}>{text(slot, 'time')} - {text(slot, 'state')}{slot.extra ? ' (extra, reason required)' : ''}{slot.reason ? `: ${text(slot, 'reason')}` : ''}</option>)}
    </select><small>{slots.filter(slot => slot.state === 'Free').length} free slots. This is not a reservation until the hospital accepts.</small></div>;
    if (field.kind === 'boolean') return <label className="check"><input id={inputId} type="checkbox" checked={value === true} required={field.required} onChange={e => change(field.key, e.target.checked)}/>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>;
    if (field.kind === 'medicines') return <MedicineEditor value={value} onChange={v => change(field.key, v)} snapshot={snapshot} context={formContext}/>;
    if (field.kind === 'tests') return <TestsEditor value={value} onChange={v => change(field.key, v)} snapshot={snapshot}/>;
    if (field.kind === 'payments') return <PaymentEditor value={value} onChange={v => change(field.key, v)} actor={snapshot.actor}/>;
    if (field.kind === 'checklist') return <div className="checklist">{field.options?.map(option => <label className="check" key={option}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={e => change(field.key, e.target.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value : []).filter(v => v !== option))}/>{option}</label>)}</div>;
    if (field.kind === 'entity' || field.kind === 'select' || lineOptions(field)) {
      let options = field.kind === 'entity' ? entityOptions(field, snapshot, payload, context, target) : lineOptions(field) ?? (field.options ?? []).map(option => ({ id: option, name: option }));
      if (command.name === 'note.save' && field.key === 'mode' && !featureEnabled(snapshot, 'Dictation')) options = options.filter(option => option.id !== 'Dictation simulation');
      if (command.name === 'document.share' && field.key === 'channel' && !featureEnabled(snapshot, 'WhatsApp')) options = options.filter(option => option.id !== 'WhatsApp');
      if (command.name === 'document.generate' && field.key === 'kind' && documentKinds[snapshot.actor.role]) options = options.filter(option => documentKinds[snapshot.actor.role]!.includes(option.id));
      return <select id={inputId} value={typeof value === 'string' ? value : ''} required={field.required} onChange={e => change(field.key, e.target.value)}><option value="">{field.required ? 'Choose...' : 'Not selected / latest'}</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select>;
    }
    if (field.kind === 'file') return <div><input id={inputId} type="file" accept=".pdf,.png,.jpg,.jpeg" required={Boolean(field.required && !value)} onChange={async event => {
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > 10 * 1024 * 1024) { setError('Choose a sample document up to 10 MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => change(field.key, { name: file.name, mime: file.type, base64: String(reader.result).split(',')[1] });
      reader.onerror = () => setError('File could not be read. Choose a readable sample file.');
      reader.readAsDataURL(file);
    }}/>{value && typeof value === 'object' && !Array.isArray(value) ? <p className="micro">Draft attachment: {text(value, 'name')}</p> : null}</div>;
    if (field.kind === 'csv') return <div><div className="inline-form"><button type="button" className="button secondary small" onClick={() => {
      const content = command.name === 'account.import' ? 'name,staffId,registration,login,mobile,email,departmentId,role,qualification,room\nDemo new doctor,SAMPLE-NEW-1,SAMPLE-REG-NEW,new-doctor,9000099991,new-doctor@sample.invalid,general,doctor,Sample qualification,Room 3' : 'departmentId,doctorId,date,shift,reason\n' + `general,doctor-a,${istDate(snapshot.now)},Night,Sample rota`;
      change(field.key, content);
    }}>Load editable sample CSV</button><input aria-label="Read CSV file" type="file" accept=".csv,text/csv" onChange={async e => { const file = e.target.files?.[0]; if (file) { if (file.size > 1000000) setError('CSV must be under 1 MB.'); else change(field.key, await file.text()); } }}/></div><textarea id={inputId} rows={8} required value={typeof value === 'string' ? value : ''} onChange={e => change(field.key, e.target.value)}/></div>;
    if (field.kind === 'textarea') return <textarea id={inputId} rows={3} required={field.required} value={typeof value === 'string' ? value : ''} onChange={e => change(field.key, e.target.value)}/>;
    return <input id={inputId} type={field.kind === 'datetime' ? 'datetime-local' : ['number', 'date', 'time', 'password'].includes(field.kind) ? field.kind : 'text'} autoComplete="off" step={field.kind === 'number' ? 'any' : undefined} required={field.required} min={field.min} max={field.max} value={typeof value === 'number' || typeof value === 'string' ? value : ''} onChange={e => change(field.key, field.kind === 'number' ? e.target.value === '' ? '' : Number(e.target.value) : e.target.value)}/>;
  }
  const affected = command.name === 'availability.request' ? snapshot.entities.filter(e => e.type === 'visit' && e.doctorId === snapshot.actor.id && text(e.data, 'date') >= text(payload, 'date') && text(e.data, 'date') <= text(payload, 'endDate') && !['Cancelled', 'Done'].includes(e.status)).length : 0;
  return <form className="action-form" data-command={command.name} onSubmit={onSubmit}>
    <div className="form-heading"><h3>{command.label}</h3><span className="micro">Validated API action</span></div><p className="form-help">{command.help}</p>
    {command.target && <label className="field">Work item <span aria-hidden="true">*</span><select aria-label="Work item" value={targetId || text(payload, '_targetId')} required onChange={e => targetChanged(e.target.value)}><option value="">Choose a {command.target}...</option>{eligible.map(e => <option key={e.id} value={e.id}>{label(e)} ({e.status})</option>)}</select>{!eligible.length && <small className="warning-text">No eligible item yet. Complete the preceding handoff, then refresh.</small>}</label>}
    {selectedPatient && <div className="form-patient"><Icon name="people" size={18}/><span><strong>{label(selectedPatient)}</strong> · {text(selectedPatient.data, 'uhid')} · {num(selectedPatient.data, 'age')}y {text(selectedPatient.data, 'sex')}</span></div>}
    {command.name === 'availability.request' && <div className="notice">{affected} booked visits affected. This request does not move or cancel them.</div>}
    {command.name === 'note.save' && <div className="note-tools">
      <label>Load template<select defaultValue="" onChange={e => { const template = snapshot.entities.find(item => item.id === e.target.value); if (template) change('illness', text(template.data, 'content')); }}><option value="">Select a published template...</option>{snapshot.entities.filter(e => e.type === 'template').map(e => <option key={e.id} value={e.id}>{label(e)}</option>)}</select></label>
      {writeMode === 'Pen simulation' && <PenPad attach={file => change('handwriting', file)} clear={() => change('handwriting', null)}/>}
      {['Dictation simulation', 'Pen simulation'].includes(writeMode) && <div className="notice"><strong>{writeMode} - no live recognition</strong><p>Enter the simulated recognized text. Nothing is used until you review it.</p><textarea aria-label="Simulated recognized text" value={simulation} onChange={e => setSimulation(e.target.value)}/><button type="button" className="button secondary small" disabled={!simulation} onClick={() => change('illness', `${text(payload, 'illness')}${text(payload, 'illness') ? '\n' : ''}${simulation}`)}>Reviewed: use this text</button></div>}
    </div>}
    {command.fields.map(field => <div className={`field ${['medicines', 'tests', 'checklist', 'payments'].includes(field.kind) ? 'full' : ''}`} key={field.key}>
      {field.kind !== 'boolean' && <label htmlFor={`${command.name}-${field.key}`}>{field.label}{field.kind === 'datetime' ? ' (IST)' : ''}{field.required && <span aria-hidden="true"> *</span>}</label>}
      {fieldControl(field)}{field.help && <small>{field.help}</small>}
    </div>)}
    <ErrorBox message={error}/>
    <ErrorBox message={slotError}/>
    <footer className="form-footer"><span className="micro" role="status">{saveState || 'Changes are saved locally before submission.'}</span><button className="button primary" disabled={submitting || (Boolean(command.target) && !eligible.length)}>{submitting ? 'Saving...' : command.label}<Icon name="arrow" size={17}/></button></footer>
  </form>;
}
export function ActionPanel({ journeyId, snapshot, context, ...rest }: Omit<FormProps, 'command'> & { journeyId: string }) {
  const allowed = commands.filter(command => command.journeys.includes(journeyId) && command.roles.includes(snapshot.actor.role) && (!command.name.startsWith('video.') || featureEnabled(snapshot, 'Video')));
  const [selected, setSelected] = useState(allowed[0]?.name ?? '');
  const command = allowed.find(c => c.name === selected) ?? allowed[0];
  if (!command) return <div className="notice">This is a read-only view for your role. Use the filters, reports or account sign-in controls.</div>;
  return <div className="action-panel"><label className="action-selector">What would you like to do?<select value={command.name} onChange={e => setSelected(e.target.value)}>{allowed.map(c => <option key={c.name} value={c.name}>{c.label}</option>)}</select></label><ActionForm key={`${command.name}:${context?.targetId ?? ''}`} command={command} snapshot={snapshot} context={context} {...rest}/></div>;
}
