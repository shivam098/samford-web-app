import { useEffect, useRef, useState } from 'react';
import { bool, num, rows, strings, text, label, currency, type Data, type Json, type Snapshot, type Entity } from '../shared/model.js';
import { defaultHomeLayout, homeCards, repeatedRosterDates } from '../shared/home.js';
import { api } from './storage.js';
import { ErrorBox, Icon, Pill, displayTime } from './ui.js';
import { cashDenominations, denominationTotal } from '../shared/finance.js';
import { useI18n } from './i18n.js';

export function HomeLayoutEditor({ value, onChange, locked = ['referrals', 'results'] }: { value: Json | undefined; onChange: (value: Data) => void; locked?: string[] }) {
  const { t, language } = useI18n();
  const layout = value && typeof value === 'object' && !Array.isArray(value) ? value : defaultHomeLayout();
  const cards = rows(layout, 'cards'); const dragging = useRef('');
  const change = (id: string, patch: Data) => onChange({ cards: cards.map(card => text(card, 'id') === id ? { ...card, ...patch } : card) });
  const move = (id: string, to: number) => {
    const from = cards.findIndex(card => card.id === id);
    if (from < 0 || to < 0 || to >= cards.length || from === to) return;
    const next = [...cards]; const [card] = next.splice(from, 1); next.splice(to, 0, card); onChange({ cards: next });
  };
  return <div className="home-layout-editor" aria-label={t('Arrange Home cards')}><p className="micro">{language === 'Hindi' ? 'कार्ड खींचकर क्रम बदलें, या ऊपर / नीचे बटन दबाएँ। लॉक कार्ड दिखते रहेंगे।' : 'Drag a card to reorder it, or use Move up / Move down. Locked cards stay visible.'}</p>
    {cards.map((card, index) => {
      const id = text(card, 'id'); const name = homeCards.find(item => item.id === id)?.label ?? id; const isLocked = locked.includes(id);
      return <div key={id} className="layout-card" data-home-card={id} draggable onDragStart={event => { dragging.current = id; event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); move(event.dataTransfer.getData('text/plain') || dragging.current, index); dragging.current = ''; }}>
        <span className="drag-handle" aria-label={`${language === 'Hindi' ? 'खींचें' : 'Drag'} ${t(name)}`}><Icon name="grid" size={18}/></span><strong>{t(name)}</strong>
        <label className="check"><input aria-label={`${language === 'Hindi' ? 'दिखाएँ' : 'Show'} ${t(name)}`} type="checkbox" checked={isLocked || bool(card, 'visible')} disabled={isLocked} onChange={event => change(id, { visible: event.target.checked })}/>{t(isLocked ? 'Locked visible' : 'Visible')}</label>
        <label className="layout-rows">{t('Rows')}<input aria-label={`${t(name)} ${language === 'Hindi' ? 'पंक्तियों की संख्या' : 'row count'}`} type="number" min={1} max={20} value={num(card, 'rows', 5)} onChange={event => change(id, { rows: Number(event.target.value) })}/></label>
        <button type="button" className="button secondary small" aria-label={language === 'Hindi' ? `${t(name)} ऊपर` : `Move ${name} up`} disabled={index === 0} onClick={() => move(id, index - 1)}>{t('Up')}</button>
        <button type="button" className="button secondary small" aria-label={language === 'Hindi' ? `${t(name)} नीचे` : `Move ${name} down`} disabled={index === cards.length - 1} onClick={() => move(id, index + 1)}>{t('Down')}</button>
      </div>;
    })}
  </div>;
}
export function HandoverEditor({ value, onChange, targetId, snapshot, allowWaiting }: { value: Json | undefined; onChange: (value: Json) => void; targetId: string; snapshot: Snapshot; allowWaiting: boolean }) {
  const [summary, setSummary] = useState<Data>(); const [error, setError] = useState('');
  useEffect(() => {
    setSummary(undefined); setError('');
    if (!targetId) return;
    let active = true;
    void api<Data>(`/api/accounts/${targetId}/handover`).then(data => { if (active) setSummary(data); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [targetId, snapshot.revision]);
  const selected = Array.isArray(value) ? value.filter((row): row is Data => row !== null && typeof row === 'object' && !Array.isArray(row)) : [];
  function update(group: string, patch: Data) {
    const previous = selected.find(row => row.group === group) ?? { group, receiverType: '', receiverId: '' };
    onChange([...selected.filter(row => row.group !== group), { ...previous, ...patch }]);
  }
  if (!targetId) return <p className="micro">Choose the clinical account to inspect its current groups and unsent counts.</p>;
  return <div className="handover-editor"><ErrorBox message={error}/>{summary ? <>
    <p className="micro">Only counts and hospital IDs are shown. Every non-empty group needs its own explicit recipient for deactivation. Authors are never reassigned.</p>
    {rows(summary, 'groups').map(group => {
      const row = selected.find(row => row.group === group.key) ?? {};
      return <fieldset key={text(group, 'key')} data-handover-group={text(group, 'key')}><legend>{text(group, 'label')} <Pill>{`${num(group, 'count')} open`}</Pill></legend>
        <p className="micro">Hospital IDs: {strings(group, 'hospitalIds').join(', ') || 'None'}</p>
        <div className="form-grid"><label>Recipient type<select aria-label={`${text(group, 'label')} recipient type`} value={text(row, 'receiverType')} onChange={event => update(text(group, 'key'), { receiverType: event.target.value, receiverId: '' })}>
          <option value="">{num(group, 'count') ? 'Choose a recipient...' : 'No open work (optional future recipient)'}</option><option>Doctor</option><option>Department queue</option>{allowWaiting && <option>Leave waiting</option>}
        </select></label>{row.receiverType === 'Doctor' && <label>Receiving consultant<select aria-label={`${text(group, 'label')} receiving consultant`} value={text(row, 'receiverId')} onChange={event => update(text(group, 'key'), { receiverId: event.target.value })}><option value="">Choose consultant...</option>{snapshot.people.filter(person => person.role === 'doctor' && person.state === 'Active' && person.id !== targetId).map(person => <option key={person.id} value={person.id}>{person.name} - {person.department}</option>)}</select></label>}</div>
      </fieldset>;
    })}
    <div className="notice"><strong>Unsent work on devices</strong>{rows(summary, 'devices').length ? rows(summary, 'devices').map(device => <p key={text(device, 'id')}>{text(device, 'name')}: {num(device, 'unsent')} unsent · {text(device, 'status')}</p>) : <p>No registered device reports.</p>}<p>New work is checked again inside the final transaction. Nothing is silently dropped.</p></div>
  </> : !error && <p className="micro">Loading handover counts...</p>}</div>;
}
export function RosterPreview({ payload, snapshot }: { payload: Data; snapshot: Snapshot }) {
  const dates = repeatedRosterDates(text(payload, 'month'), strings(payload, 'weekdays'));
  const conflicts = snapshot.entities.filter(entity => entity.type === 'roster' && entity.department === text(payload, 'departmentId') && dates.includes(text(entity.data, 'date')) && text(entity.data, 'shift') === text(payload, 'shift') && text(entity.data, 'doctorId') !== text(payload, 'doctorId'));
  return <div className="notice"><strong>Weekly pattern preview: {dates.length} dates</strong><p>{dates.join(', ') || 'Choose a month and weekdays.'}</p><p>{conflicts.length} conflicting assignments{conflicts.length ? `: ${conflicts.map(entry => `${text(entry.data, 'date')} (${snapshot.people.find(person => person.id === text(entry.data, 'doctorId'))?.name ?? text(entry.data, 'doctorId')})`).join('; ')}` : '. Existing identical cells are retained.'}</p></div>;
}
export function RosterCalendar({ snapshot }: { snapshot: Snapshot }) {
  const [month, setMonth] = useState(snapshot.now.slice(0, 7));
  const dates = repeatedRosterDates(month, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  const departments = snapshot.entities.filter(entity => entity.type === 'department' && (snapshot.actor.role !== 'head' || entity.id === snapshot.actor.department));
  return <section className="panel"><div className="panel-heading"><h2>Published clinical duty roster</h2><label>Month<input aria-label="Published roster month" type="month" value={month} onChange={event => setMonth(event.target.value)}/></label></div>
    <div className="records-table"><table><thead><tr><th>Department / shift</th>{dates.map(date => <th key={date}>{date.slice(-2)}</th>)}</tr></thead><tbody>{departments.flatMap(department => ['Day', 'Night', 'On call'].map(shift => <tr key={`${department.id}-${shift}`}><td>{label(department)} · {shift}</td>{dates.map(date => {
      const entry = snapshot.entities.find(entity => entity.type === 'roster' && entity.department === department.id && text(entity.data, 'date') === date && text(entity.data, 'shift') === shift);
      return <td key={date}>{entry ? snapshot.people.find(person => person.id === text(entry.data, 'doctorId'))?.name ?? 'Assigned consultant' : 'Unassigned'}</td>;
    })}</tr>))}</tbody></table></div>
  </section>;
}
export function PayerRatesEditor({ value, onChange }: { value: Json | undefined; onChange: (value: Data) => void }) {
  const rates = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return <div className="form-grid">{['Self', 'Ayushman', 'CGHS', 'TPA', 'Corporate'].map(payer => <label key={payer}>{payer} rate (INR)<input aria-label={`${payer} package rate`} type="number" min="0" step="0.01" value={typeof rates[payer] === 'number' ? rates[payer] : ''} onChange={event => { const next = { ...rates }; if (event.target.value === '') delete next[payer]; else next[payer] = Number(event.target.value); onChange(next); }}/></label>)}</div>;
}
export function DenominationEditor({ value, onChange }: { value: Json | undefined; onChange: (value: Data) => void }) {
  const counts = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return <div><div className="form-grid">{cashDenominations.map(denomination => <label key={denomination}>INR {denomination} count<input aria-label={`INR ${denomination} count`} type="number" min={0} step={1} value={num(counts, String(denomination))} onChange={event => onChange({ ...counts, [String(denomination)]: Number(event.target.value) })}/></label>)}</div>
    <p className="notice">Counted cash: <strong>{currency(denominationTotal(counts) * 100)}</strong></p></div>;
}
export function CounterPreview({ snapshot, counted }: { snapshot: Snapshot; counted: number }) {
  const [summary, setSummary] = useState<Data>(); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<Data>('/api/counters/summary').then(data => { if (active) { setSummary(data); setError(''); } }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [snapshot.actor.counter, snapshot.revision]);
  return <div className="notice"><strong>Counter reconciliation preview</strong><ErrorBox message={error}/>{summary && <>
    <p>{text(summary, 'counter')} · {text(summary, 'date')}</p>{rows(summary, 'modes').map(mode => <p key={text(mode, 'mode')}>{text(mode, 'mode')}: received {currency(num(mode, 'collected'))}, refunded {currency(num(mode, 'refunded'))}, net {currency(num(mode, 'net'))}</p>)}
    <p>Expected cash: {currency(num(summary, 'expectedCash'))} · Your variance: <strong>{currency(Math.round(counted * 100) - num(summary, 'expectedCash'))}</strong></p>
    <p>Totals are checked again at close. The report exports to accounts; no ledger is kept.</p>
  </>}</div>;
}
export function AdmissionEstimate({ admissionId, revision }: { admissionId: string; revision: number }) {
  const [estimate, setEstimate] = useState<Data>(); const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setEstimate(undefined); setError('');
    void api<Data>(`/api/admissions/${admissionId}/estimate`).then(data => { if (active) setEstimate(data); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [admissionId, revision]);
  return <div className="notice"><strong>Read-only current billing estimate</strong><ErrorBox message={error}/>{estimate && <>
    {estimate.packageQuote && typeof estimate.packageQuote === 'object' && !Array.isArray(estimate.packageQuote) && <p>Package: {text(estimate.packageQuote, 'name')} · {currency(num(estimate.packageQuote, 'rate'))}</p>}
    <p>Charges: {currency(num(estimate, 'gross'))} · Approved insurer share: {currency(num(estimate, 'insurerShare'))} · Coverage valid until {text(estimate, 'coverageValidUntil') || 'No current approval'}</p>
    <p>Recorded advance: {currency(num(estimate, 'recordedAdvance'))} · <strong>Patient due: {currency(num(estimate, 'patientDue'))}</strong></p>
    <p>Estimate only, not a payment or discharge approval.</p>
  </>}</div>;
}
export function DecisionContext({ target, snapshot }: { target?: Entity; snapshot: Snapshot }) {
  const { t, language } = useI18n();
  if (!target || !['approval', 'question', 'result', 'referral', 'rx', 'discharge', 'operation'].includes(target.type)) return null;
  const person = (id: string) => snapshot.people.find(person => person.id === id)?.name ?? id;
  return <section className="decision-context" aria-label={language === 'Hindi' ? 'निर्णय से पहले वर्तमान विवरण' : 'Current details before decision'}><div className="detail-title"><h3>{label(target)}</h3><Pill>{target.status}</Pill></div>
    {target.type === 'approval' && <><p><strong>Requested by:</strong> {person(text(target.data, 'requestedBy'))}</p><p><strong>Amount:</strong> {currency(num(target.data, 'amount'))}</p><p>{text(target.data, 'reason')}</p>{target.createdBy === snapshot.actor.id && <p className="danger-text">You requested this. A different person must approve.</p>}</>}
    {target.type === 'question' && <><p><strong>{language === 'Hindi' ? 'प्रश्न' : 'Question'}:</strong> {text(target.data, 'question') || text(target.data, 'reason')}</p>
      {text(target.data, 'proposedItemId') && <p><strong>{language === 'Hindi' ? 'प्रस्तावित विकल्प' : 'Proposed substitute'}:</strong> {label(snapshot.entities.find(entity => entity.id === text(target.data, 'proposedItemId')) ?? target)} · {language === 'Hindi' ? 'पर्चा संस्करण' : 'Rx version'} {num(target.data, 'rxVersion')}</p>}</>}
    {target.type === 'result' && <><p><strong>{text(target.data, 'value') || num(target.data, 'value')}</strong> {text(target.data, 'unit')} · {t('Range')} {num(target.data, 'low')}–{num(target.data, 'high')} · <Pill>{text(target.data, 'flag')}</Pill></p><p>{t('Released')}: {displayTime(text(target.data, 'releasedAt'))} · {t('Verifier')}: {person(text(target.data, 'verifiedBy'))}</p>{text(target.data, 'amendmentReason') && <p>{t('AMENDED')}: {text(target.data, 'amendmentReason')}</p>}</>}
    {target.type === 'referral' && <><p>{t('Doctor')}: {person(text(target.data, 'senderId') || target.createdBy)} · <Pill>{text(target.data, 'urgency')}</Pill></p><p>{t('Purpose')}: {t(text(target.data, 'purpose'))}</p><p>{text(target.data, 'reason')}</p></>}
    {target.type === 'rx' && <><p>{t('Prescription version')}: {num(target.data, 'rxVersion')} · {text(target.data, 'prescriberName') || person(target.doctorId ?? target.createdBy)}</p>{rows(target.data, 'lines').map(line => <p key={text(line, 'id')}><strong>{text(line, 'name')}</strong>: {text(line, 'dose')} · {t(text(line, 'frequency'))} · {num(line, 'days')} {t('Days')} · {t('Quantity')} {num(line, 'quantity')} ({num(line, 'dispensed')} {t('Dispensed')})</p>)}</>}
    {target.type === 'discharge' && <><p>{language === 'Hindi' ? 'मसौदे का लेखक' : 'Draft author'}: {person(text(target.data, 'authorId') || target.createdBy)}</p><p>{t('Diagnosis')}: {text(target.data, 'diagnosis')}</p><p>{text(target.data, 'course')}</p><p>{t('Condition at discharge')}: {text(target.data, 'condition')}</p>{rows(target.data, 'lines').map(line => <p key={text(line, 'id')}>{text(line, 'name')} · {text(line, 'dose')} · {num(line, 'days')} {t('Days')}</p>)}</>}
    {target.type === 'operation' && <><p>{t('Procedures')}: {text(target.data, 'procedure')} · <Pill>{text(target.data, 'urgency', 'Routine')}</Pill></p><p>{language === 'Hindi' ? 'सर्जन' : 'Surgeon'}: {person(text(target.data, 'surgeonId'))}</p><p>{text(target.data, 'theatre')} · {displayTime(text(target.data, 'start'))} – {displayTime(text(target.data, 'end'))}</p>{text(target.data, 'slotChangeReason') && <p>{t('Reason')}: {text(target.data, 'slotChangeReason')}</p>}</>}
  </section>;
}
