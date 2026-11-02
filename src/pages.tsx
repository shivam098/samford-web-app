import React, { useEffect, useState } from 'react';
import { commands } from '../shared/commands.js';
import { journeys, journeyById } from '../shared/journeys.js';
import { adminRoles, doctorRoles, label, text, num, bool, currency, istDate, actorReportKinds, hasRole, featureEnabled, type Data, type Entity, type Snapshot, type CommandDef } from '../shared/model.js';
import { ActionPanel, type FormContext, type FormProps } from './forms.js';
import { api, type Vault, type Pending } from './storage.js';
import { Icon, Pill, Empty, ErrorBox, Detail, Modal, displayTime, human, Value } from './ui.js';
import { RosterCalendar, AdmissionEstimate } from './workflow-fields.js';
import { useI18n } from './i18n.js';
import { localizedJourney } from '../shared/i18n.js';
export type PageProps = {
  snapshot: Snapshot; vault: Vault;
  saveDraft: FormProps['saveDraft']; submit: FormProps['submit']; refresh: () => Promise<void>;
  showAction: (command: CommandDef, context?: FormContext) => void;
};
const visitStatus = ['All', 'Booked', 'Waiting', 'Called', 'In consultation', 'Held', 'Done', 'Cancelled', 'Missed'];
function savedVisitFilter(snapshot: Snapshot): Data {
  try {
    const raw = sessionStorage.getItem(`samford-visit-filter:${snapshot.actor.id}`);
    const saved: Data = raw ? JSON.parse(raw) : {};
    return text(saved, 'day') === istDate(snapshot.now) ? saved : {};
  } catch { return {}; }
}
export function Heading({ eyebrow, title, children, actions, journeyId }: { eyebrow: string; title: string; children?: React.ReactNode; actions?: React.ReactNode; journeyId?: string }) {
  const { t } = useI18n();
  return <header className="page-heading" data-journey-id={journeyId}><div><p className="eyebrow">{t(eyebrow)}</p><h1>{t(title)}</h1>{children && <p className="lead">{typeof children === 'string' ? t(children) : children}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</header>;
}
export function JourneyCards({ snapshot, query = '' }: { snapshot: Snapshot; query?: string }) {
  const { t, language } = useI18n();
  const allowed = journeys.filter(j => hasRole(snapshot.actor, j.roles) && (j.id !== 'DJ23' || featureEnabled(snapshot, 'Video')) && `${j.id} ${j.title} ${j.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="journey-groups">{[...new Set(allowed.map(j => j.group))].map(group => <section key={group}><h2 className="group-heading">{t(group)}</h2><div className="journey-grid">{allowed.filter(j => j.group === group).map(j => {
    const localized = localizedJourney(j, language);
    return <a className="journey-card" href={`#journey/${j.id}`} key={j.id}><span className="journey-id">{j.id}</span><h3>{localized.title}</h3><p>{localized.description}</p><span className="card-link">{language === 'Hindi' ? 'कार्य खोलें' : 'Open workflow'} <Icon name="arrow" size={16}/></span></a>;
  })}</div></section>)}</div>;
}
export function Home(props: PageProps) {
  const { t, language } = useI18n();
  const { snapshot, showAction } = props; const { actor, entities, summary } = snapshot;
  const doctor = doctorRoles.includes(actor.role); const admin = adminRoles.includes(actor.role); const patient = actor.role === 'patient';
  const name = actor.name.replace('Demo ', '');
  const [query, setQuery] = useState('');
  const present = entities.find(e => e.type === 'presence' && e.doctorId === actor.id);
  const visits = entities.filter(e => e.type === 'visit' && (!doctor || e.doctorId === actor.id) && text(e.data, 'date') === istDate(snapshot.now) && !['Done', 'Cancelled'].includes(e.status)).sort((a, b) => Number(bool(b.data, 'priority')) - Number(bool(a.data, 'priority')) || num(a.data, 'token') - num(b.data, 'token'));
  const cards = doctor ? [
    { key: 'visits', title: 'Today’s visits', number: visits.length, href: '#patients', note: 'Your clinic queue', icon: 'people' },
    { key: 'referrals', title: 'New referrals', number: snapshot.notifications.filter(e => e.href === 'DJ21').length, href: '#journey/DJ21', note: 'Waiting for your answer', icon: 'arrow' },
    { key: 'results', title: 'Results to review', number: snapshot.notifications.filter(e => e.href === 'DJ20').length, href: '#journey/DJ20', note: 'Review is separate from release', icon: 'flask' },
    { key: 'admissions', title: 'My admissions', number: num(summary, 'admissions'), href: '#journey/DJ18', note: 'Active inpatient care', icon: 'heart' },
    { key: 'pending', title: 'Local pending work', number: props.vault.pending.filter(item => !['Accepted', 'Discarded'].includes(item.status)).length, href: '#sync', note: 'Saved here, not yet accepted', icon: 'sync' }
  ] : admin ? [
    { key: 'requests', title: 'Access requests', number: num(summary, 'requests'), href: '#journey/AJ03', note: 'Review and approve', icon: 'people' },
    { key: 'invites', title: 'Invited accounts', number: num(summary, 'invites'), href: '#journey/AJ04', note: 'Awaiting first sign-in', icon: 'shield' },
    { key: 'help', title: 'Help requests', number: num(summary, 'help'), href: '#journey/AJ17', note: 'No clinical impersonation', icon: 'file' },
    { key: 'jobs', title: 'Failed job runs', number: num(summary, 'failedJobs'), href: '#journey/AJ23', note: 'Inspect run history', icon: 'sync' }
  ].filter(card => journeyById[card.href.split('/')[1]]?.roles.includes(actor.role)) : patient ? [
    { key: 'visits', title: 'Appointments', number: entities.filter(e => e.type === 'visit' && e.status === 'Booked').length, href: '#journey/SJ35', note: 'Shared hospital slots', icon: 'calendar' },
    { key: 'results', title: 'Released reports', number: entities.filter(e => e.type === 'result' && e.status === 'Released').length, href: '#journey/SJ36', note: 'Only released results appear', icon: 'file' },
    { key: 'due', title: 'Amount due', number: currency(num(summary, 'duePaise')), href: '#journey/SJ37', note: 'All payments are simulated', icon: 'chart' }
  ] : [
    { key: 'work', title: 'Open work', number: entities.filter(e => !['Active', 'Available', 'Free', 'Paid', 'Completed', 'Done', 'Released', 'Closed', 'Discharged', 'Published'].includes(e.status)).length, href: '#workflows', note: 'Across your authorized desk', icon: 'grid' },
    { key: 'visits', title: 'Check-ins today', number: visits.length, href: '#workflows', note: 'Shared live worklists', icon: 'people' },
    { key: 'admissions', title: 'Active admissions', number: num(summary, 'admissions'), href: '#workflows', note: 'Linked hospital handoffs', icon: 'heart' },
    { key: 'approvals', title: 'Awaiting approval', number: num(summary, 'approvals'), href: '#workflows', note: 'Independent decisions', icon: 'shield' }
  ];
  const order = text(actor.preferences, 'homeOrder').split(',');
  const hidden = text(actor.preferences, 'hiddenCards').split(',');
  const arranged = doctor ? cards.filter(c => !hidden.includes(c.key) || ['referrals', 'results'].includes(c.key)).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : cards;
  const cardRows = actor.preferences.cardRows && typeof actor.preferences.cardRows === 'object' && !Array.isArray(actor.preferences.cardRows) ? actor.preferences.cardRows : {};
  const homePreviews: Record<string, { text: string; detail: string; href: string }[]> = {
    visits: visits.map(visit => ({ text: `${num(visit.data, 'token') || 'Booked'} · ${label(entities.find(entity => entity.id === visit.patientId) ?? visit)}`, detail: `${text(visit.data, 'time')} · ${visit.status}`, href: `#visit/${visit.id}` })),
    referrals: snapshot.notifications.filter(item => item.href === 'DJ21').map(item => ({ text: item.text, detail: 'Waiting for your answer', href: '#journey/DJ21' })),
    results: snapshot.notifications.filter(item => item.href === 'DJ20').map(item => ({ text: item.text, detail: 'Release is not review', href: '#journey/DJ20' })),
    admissions: entities.filter(entity => entity.type === 'admission' && entity.status === 'Admitted' && (entity.doctorId === actor.id || entity.doctorId === text(actor.preferences, 'coverDoctor')))
      .map(admission => ({ text: label(entities.find(entity => entity.id === admission.patientId) ?? admission), detail: label(entities.find(entity => entity.id === text(admission.data, 'bedId')) ?? admission), href: '#journey/DJ18' })),
    pending: props.vault.pending.filter(item => !['Accepted', 'Discarded'].includes(item.status)).map(item => ({ text: item.label, detail: item.status, href: '#sync' }))
  };
  return <>
    <Heading eyebrow={`${new Intl.DateTimeFormat('en-IN', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(snapshot.now))} / SAMPLE CAMPUS`}
      title={doctor ? language === 'Hindi' ? `${name}, आज की देखभाल के लिए तैयार।` : `A good day of care, ${name}.` : patient ? t('Your care, in one place.') : `Welcome to your desk, ${name}.`}
      actions={doctor ? <button className="button primary" onClick={() => showAction(commands.find(c => c.name === 'presence.set')!)}><span className="status-dot"/>{t('I’m here')}</button> : <a className="button primary" href="#workflows">{language === 'Hindi' ? 'कार्य खोलें' : 'Open workflows'}<Icon name="arrow" size={17}/></a>}>
      {doctor ? language === 'Hindi' ? 'आपके मरीज़, टीम के कार्य और महत्वपूर्ण सूचनाएँ।' : 'Your patients, team handoffs and important updates. Ready when you are.' : patient ? t('Appointments, reports and payments for your linked sample family.') : 'One connected hospital. Work received here changes the next desk’s queue.'}
    </Heading>
    <div className="activity-strip"><span><Icon name="calendar" size={17}/>{t('Signed in today')} <strong>{summary.firstSignIn ? displayTime(text(summary, 'firstSignIn')) : language === 'Hindi' ? 'आज सर्वर पर साइन-इन नहीं हुआ' : 'No server sign-in today'}</strong>{summary.firstSignIn !== summary.latestSignIn && summary.latestSignIn ? ` · ${language === 'Hindi' ? 'नवीनतम' : 'latest'} ${displayTime(text(summary, 'latestSignIn'))}` : ''}</span><span>{present && <Pill>{present.status}</Pill>}<span className="micro">{t('App activity, not attendance')}</span></span></div>
    <div className={`stats-grid ${doctor ? 'doctor-home-grid' : ''}`}>{arranged.map(card => doctor ? <section className="stat-card home-work-card" data-home-card={card.key} key={card.key}>
      <a href={card.href} className="home-card-heading"><div className="stat-top"><span>{t(card.title)}</span><Icon name={card.icon}/></div><strong className="stat-number">{card.key === 'admissions' ? homePreviews.admissions.length : card.number}</strong><span className="micro">{t(card.note)}</span></a>
      <div className="home-preview">{homePreviews[card.key]?.length ? homePreviews[card.key].slice(0, num(cardRows, card.key, num(actor.preferences, 'rows', 5))).map((item, index) => <a href={item.href} key={`${item.href}-${index}`}><strong>{item.text}</strong><small>{t(item.detail)}</small><Icon name="arrow" size={14}/></a>) : <p className="micro">{t('Nothing waiting')}</p>}</div>
    </section> : <a className="stat-card" href={card.href} key={card.key}><div className="stat-top"><span>{t(card.title)}</span><Icon name={card.icon}/></div><strong className="stat-number">{card.number}</strong><span className="micro">{t(card.note)}</span><Icon name="arrow" size={17}/></a>)}</div>
    {doctor && snapshot.notifications.some(item => !['DJ20', 'DJ21'].includes(item.href)) && <section className="panel"><div className="panel-heading"><h2>{t('Other team handoffs')}</h2></div>{snapshot.notifications.filter(item => !['DJ20', 'DJ21'].includes(item.href)).map(item => <a href={`#journey/${item.href}`} className="notification-row" key={item.id}><Icon name="bell" size={18}/><span>{t(item.text)}</span><Icon name="arrow" size={15}/></a>)}</section>}
    {entities.filter(e => e.type === 'announcement').map(e => <aside className="notice" key={e.id}><strong>{text(e.data, 'title')}</strong><p>{text(e.data, 'content')}</p></aside>)}
    {!doctor && <div className="section-title"><h2>{patient ? t('Your portal') : 'Find a workflow'}</h2><div className="search-field"><Icon name="search"/><input aria-label={t('Search')} placeholder={language === 'Hindi' ? 'कार्य या कार्य आईडी खोजें…' : 'Search task or journey ID...'} value={query} onChange={e => setQuery(e.target.value)}/></div></div>}
    {!doctor && <JourneyCards snapshot={snapshot} query={query}/>}
    {doctor && <section className="quick-links"><h2>{t('Keep your day moving')}</h2><div>{(text(actor.preferences, 'shortcuts') ? text(actor.preferences, 'shortcuts').split(',').map(id => id.trim()).filter(id => journeyById[id]?.roles.includes(actor.role)) : ['DJ04', 'DJ10', 'DJ18', 'DJ24', 'DJ27']).map(id => <a href={`#journey/${id}`} key={id}><Icon name={id === 'DJ04' ? 'calendar' : id === 'DJ18' ? 'heart' : 'file'}/><span>{localizedJourney(journeyById[id], language).title}</span><Icon name="arrow" size={16}/></a>)}</div></section>}
  </>;
}
export function VisitRow({ visit, snapshot }: { visit: Entity; snapshot: Snapshot }) {
  const patient = snapshot.entities.find(e => e.id === visit.patientId);
  return <a className="patient-row" href={doctorRoles.includes(snapshot.actor.role) ? `#visit/${visit.id}` : '#journey/SJ04'}>
    <span className={`token ${bool(visit.data, 'priority') ? 'urgent' : ''}`}>{num(visit.data, 'token') || '–'}</span><div className="patient-row-name"><strong>{patient ? label(patient) : 'Authorized patient'}</strong><small>{patient ? `${num(patient.data, 'age')}y ${text(patient.data, 'sex')} · ${text(patient.data, 'uhid')}` : ''}</small></div><div className="patient-row-time"><span>{text(visit.data, 'time')}</span><small>{text(visit.data, 'mode')}</small></div><Pill>{visit.status}</Pill><Icon name="arrow" size={17}/></a>;
}
export function Patients(props: PageProps) {
  const { t, language } = useI18n();
  const { snapshot } = props; const saved = savedVisitFilter(snapshot);
  const [q, setQ] = useState(text(saved, 'q')); const [status, setStatus] = useState(text(saved, 'status', 'All')); const [mode, setMode] = useState(text(saved, 'mode', 'All'));
  const [date, setDate] = useState(text(saved, 'date', istDate(snapshot.now)));
  const [opd, setOpd] = useState(text(saved, 'opd', 'All')); const [transcript, setTranscript] = useState('');
  const visits = snapshot.entities.filter(e => e.type === 'visit' && e.doctorId === snapshot.actor.id && (!date || text(e.data, 'date') === date) && (status === 'All' || e.status === status) && (mode === 'All' || text(e.data, 'mode') === mode) && (opd === 'All' || text(e.data, 'opdType') === opd) && `${JSON.stringify(e.data)} ${JSON.stringify(snapshot.entities.find(p => p.id === e.patientId)?.data)}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => Number(bool(b.data, 'priority')) - Number(bool(a.data, 'priority')) || (text(snapshot.actor.preferences, 'sort') === 'Time' ? text(a.data, 'time').localeCompare(text(b.data, 'time')) : num(a.data, 'token') - num(b.data, 'token')));
  useEffect(() => { sessionStorage.setItem(`samford-visit-filter:${snapshot.actor.id}`, JSON.stringify({ day: istDate(snapshot.now), date, status, mode, opd, q, ids: visits.map(e => e.id) })); }, [snapshot.actor.id, date, status, mode, opd, q, visits.map(e => e.id).join(',')]);
  const next = visits.find(e => e.status === 'Waiting' && text(e.data, 'skipUntil') <= snapshot.now);
  return <><Heading eyebrow="DOCTOR / PATIENTS" title="Your clinic, at a glance." actions={<button className="button primary" disabled={!next} onClick={() => next && props.showAction(commands.find(c => c.name === 'visit.call')!, { targetId: next.id, patientId: next.patientId })}>{t('Call next')}{next ? ` · ${num(next.data, 'token')}` : ''}<Icon name="arrow" size={17}/></button>}>Search never widens access. Confirm the patient before opening a consultation.</Heading>
    <div className="filters"><label>{t('Search')}<input value={q} onChange={e => setQ(e.target.value)} placeholder={language === 'Hindi' ? 'नाम, मोबाइल, UHID या ओपीडी नंबर' : 'Name, mobile, UHID or OPD number'}/></label><label>{t('Date')}<input type="date" value={date} onChange={e => setDate(e.target.value)}/></label>
      <label>{t('Status')}<select value={status} onChange={e => setStatus(e.target.value)}>{visitStatus.map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>
      <label>{t('Mode')}<select value={mode} onChange={e => setMode(e.target.value)}>{['All', 'Walk-in', 'Video', 'Telephone'].map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>
      <label>{t('OPD type')}<select value={opd} onChange={e => setOpd(e.target.value)}>{['All', 'General', 'Private'].map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>
    </div>
    <details className="simulation-details"><summary>{t('Voice-search simulator (no recording)')}</summary><div className="inline-form"><input aria-label={t('Simulated search transcript')} value={transcript} onChange={e => setTranscript(e.target.value)} placeholder={t('Type the recognized search words')}/><button className="button secondary small" onClick={() => setQ(transcript)} disabled={!transcript}>{t('Use transcript')}</button></div></details>
    <section className="panel"><div className="panel-heading"><h2>{visits.length} {t('matching visits')}</h2><button className="button secondary small" onClick={() => void props.refresh()}>{t('Refresh')}</button></div>{visits.length ? visits.map(e => <VisitRow key={e.id} visit={e} snapshot={snapshot}/>) : <Empty title="No matching visits">{t('Change your filters, or check in a patient at the desk. Other doctors’ visits are not included.')}</Empty>}</section>
  </>;
}
export function Calendar(props: PageProps) {
  const { t, language } = useI18n();
  const [month, setMonth] = useState(istDate(props.snapshot.now).slice(0, 7)); const [date, setDate] = useState(istDate(props.snapshot.now));
  const first = new Date(`${month}-01T12:00:00Z`); const days = new Date(first.getUTCFullYear(), first.getUTCMonth() + 1, 0).getDate(); const offset = (first.getUTCDay() + 6) % 7;
  const mine = props.snapshot.entities.filter(e => (e.doctorId === props.snapshot.actor.id || text(e.data, 'doctorId') === props.snapshot.actor.id) && ['visit', 'roster', 'availability', 'session'].includes(e.type));
  return <><Heading eyebrow={language === 'Hindi' ? 'डॉक्टर / कैलेंडर' : 'DOCTOR / CALENDAR'} title={language === 'Hindi' ? 'अपने दिन की योजना बनाएँ।' : 'Make room for your day.'} actions={<button className="button primary" onClick={() => props.showAction(commands.find(c => c.name === 'availability.request')!)}>{t('Request an availability change')}<Icon name="plus" size={17}/></button>}>{language === 'Hindi' ? 'अनुरोध स्वीकृत अवकाश नहीं है। डेस्क बदलाव की पुष्टि करके मरीज़ों की बुकिंग बदलता है।' : 'Requested availability is not approved leave. The front desk confirms changes and moves patients.'}</Heading>
    <section className="panel"><div className="panel-heading"><h2>{language === 'Hindi' ? 'ओपीडी और ऑन-कॉल कैलेंडर' : 'OPD & on-call calendar'}</h2><input aria-label={language === 'Hindi' ? 'कैलेंडर माह' : 'Calendar month'} type="month" value={month} onChange={e => setMonth(e.target.value)}/></div>
      <div className="calendar-grid">{(language === 'Hindi' ? ['सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि', 'रवि'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).map(day => <strong key={day} className="weekday">{day}</strong>)}{Array.from({ length: offset }, (_, i) => <span key={`empty-${i}`}/>)}{Array.from({ length: days }, (_, i) => {
        const key = `${month}-${String(i + 1).padStart(2, '0')}`; const records = mine.filter(e => text(e.data, 'date') === key);
        const requests = records.filter(e => e.type === 'availability');
        return <button key={key} className={`calendar-day ${key === date ? 'selected' : ''} ${key === istDate(props.snapshot.now) ? 'today' : ''}`} onClick={() => setDate(key)}><strong>{i + 1}</strong>{records.some(e => e.type === 'session') && <small>{t('OPD')}</small>}{records.some(e => e.type === 'roster') && <small className="oncall">{language === 'Hindi' ? 'ऑन-कॉल' : 'On call'}</small>}{requests.map(e => <small key={e.id}>{t(e.status)}: {t(text(e.data, 'kind'))}</small>)}{records.filter(e => e.type === 'visit').length > 0 && <span>{records.filter(e => e.type === 'visit').length} {language === 'Hindi' ? 'विज़िट' : 'visits'}</span>}</button>;
      })}</div>
    </section><section className="panel"><div className="panel-heading"><h2>{date}</h2><a href="#journey/DJ04" className="text-button">Track availability requests<Icon name="arrow" size={16}/></a></div>{mine.filter(e => e.type === 'visit' && text(e.data, 'date') === date).map(e => <VisitRow key={e.id} visit={e} snapshot={props.snapshot}/>)}{!mine.some(e => e.type === 'visit' && text(e.data, 'date') === date) && <Empty title="No appointments on this date"/>}</section>
  </>;
}
export function Records({ entities, snapshot, selected, onSelect }: { entities: Entity[]; snapshot: Snapshot; selected?: string; onSelect: (entity: Entity) => void }) {
  const { t } = useI18n();
  if (!entities.length) return <Empty/>;
  return <div className="records-table"><table><thead><tr><th>{t('Work item')}</th><th>{t('Patient / reference')}</th><th>{t('Status')}</th><th>{t('Updated (IST)')}</th></tr></thead><tbody>{entities.map(e => {
    const patient = snapshot.entities.find(p => p.id === e.patientId);
    return <tr key={e.id} className={selected === e.id ? 'selected' : ''}><td><button className="record-link" data-record-id={e.id} onClick={() => onSelect(e)}>{label(e)}</button><small>{human(e.type)} · v{e.version}</small></td><td>{patient ? <><span>{label(patient)}</span><small>{text(patient.data, 'uhid')}</small></> : <span className="muted">{e.doctorId ? snapshot.people.find(p => p.id === e.doctorId)?.name : e.id.slice(-8)}</span>}</td><td><Pill>{e.status}</Pill></td><td><small>{displayTime(e.updatedAt)}</small></td></tr>;
  })}</tbody></table></div>;
}
export function JourneyPage({ id, ...props }: PageProps & { id: string }) {
  const { t, language } = useI18n();
  const journey = journeyById[id]; const { snapshot } = props;
  const [q, setQ] = useState(''); const [type, setType] = useState('All'); const [status, setStatus] = useState('All'); const [selectedId, setSelectedId] = useState('');
  const [history, setHistory] = useState<Entity[] | null>(null); const [error, setError] = useState('');
  const [qr, setQr] = useState<{ image: string; url: string }>();
  const allowed = journey && hasRole(snapshot.actor, journey.roles);
  useEffect(() => {
    if (id === 'DJ02') api<{ image: string; url: string }>(`/api/profile/${snapshot.actor.id}/qr`).then(setQr).catch(error => setError(error.message));
  }, [id, snapshot.actor.id]);
  if (!journey || !allowed) return <Empty title="This workflow is outside your role">Switch to the responsible named demo persona to perform this work.</Empty>;
  const localized = localizedJourney(journey, language);
  const all = snapshot.entities.filter(e => journey.collection.includes(e.type));
  const priority = (e: Entity) => bool(e.data, 'emergency') || ['Urgent', 'Emergency', 'STAT'].includes(text(e.data, 'urgency') || text(e.data, 'priority')) || text(e.data, 'flag') === 'Critical';
  const filtered = all.filter(e => (type === 'All' || e.type === type) && (status === 'All' || e.status === status) && `${label(e)} ${e.id} ${JSON.stringify(e.data)}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => Number(priority(b)) - Number(priority(a)) || b.updatedAt.localeCompare(a.updatedAt));
  const selected = snapshot.entities.find(e => e.id === selectedId);
  const context: FormContext = selected ? {
    targetId: selected.id, patientId: selected.type === 'patient' ? selected.id : selected.patientId,
    visitId: selected.type === 'visit' ? selected.id : text(selected.data, 'visitId') || undefined,
    admissionId: selected.type === 'admission' ? selected.id : text(selected.data, 'admissionId') || undefined
  } : {};
  const specialReport = ['AJ18', 'AJ19', 'SJ30'].includes(id);
  const canAct = commands.some(c => c.journeys.includes(id) && hasRole(snapshot.actor, c.roles));
  return <>
    <Heading journeyId={id} eyebrow={`${t(journey.group).toUpperCase()} / ${id}`} title={localized.title} actions={<button className="button secondary" onClick={() => void props.refresh()}><Icon name="sync" size={17}/>{t('Refresh')}</button>}>{localized.description}</Heading>
    {journey.boundary && <aside className="notice boundary"><Icon name="shield"/><span><strong>Simulation boundary / demo assumption</strong><br/>{journey.boundary}</span></aside>}
    {id === 'AJ13' && <RosterCalendar snapshot={snapshot}/>}
    {selected && ['SJ08', 'SJ16', 'SJ19', 'DJ19'].includes(id) && (selected.type === 'admission' || text(selected.data, 'admissionId')) && <AdmissionEstimate admissionId={selected.type === 'admission' ? selected.id : text(selected.data, 'admissionId')} revision={snapshot.revision}/>}
    <ErrorBox message={error}/>
    {specialReport ? <Reports snapshot={snapshot} initial={id === 'AJ18' ? 'activity' : id === 'AJ19' ? 'referrals' : 'census'}/> : id === 'AJ20' ? <Audit snapshot={snapshot}/> : <>
      {['DJ01', 'AJ01', 'SJ01', 'SJ34'].includes(id) && <div className="notice">You are signed in as {snapshot.actor.name}. To test access requests, password setup or patient OTP, sign out and choose <strong>Test sign-in / onboarding</strong>. Public demo shortcuts are explicitly simulated persona sign-ins.</div>}
      {id === 'DJ02' && qr && <section className="profile-qr"><img src={qr.image} alt={t('Synthetic public doctor profile QR')}/><div><h2>{t('Your public profile')}</h2><p>{t('No patient information, login or password in this code.')}</p><a href={qr.url} target="_blank" rel="noreferrer">{t('Open sample profile')}<Icon name="arrow" size={15}/></a></div></section>}
      {id === 'DJ02' && <DoctorMonthlyNumbers snapshot={snapshot}/>}
      {id === 'DJ24' && <div className="notice">{props.vault.pending.filter(e => !['Accepted', 'Discarded'].includes(e.status)).length} {t('unsent actions')} · {Object.keys(props.vault.drafts).length} {t('saved draft forms')}. <a href="#sync">{t('Review local work before signing out.')}</a> {t('The 22:00 reset changes presence only.')}</div>}
      {id === 'SJ05' && <div className="board-links">{all.filter(e => e.type === 'board').map(e => <a className="button secondary" href={`#board/${e.id}`} target="_blank" rel="noreferrer" key={e.id}>Open {label(e)}<Icon name="arrow" size={16}/></a>)}</div>}
      {id === 'AJ23' && <div className="stats-grid">{all.filter(e => e.type === 'integration').map(e => <section className="stat-card" key={e.id}><h3>{label(e)}</h3><Pill>{e.status}</Pill><p>{text(e.data, 'nextAction')}</p><span className="micro">Checked {displayTime(text(e.data, 'checkedAt'))}</span></section>)}</div>}
      <div className={`workflow-columns ${!canAct ? 'read-only' : ''}`}><section className="panel records-panel">
        <div className="panel-heading"><h2>{t('Shared worklist')} <span className="count">{filtered.length}</span></h2>{!doctorRoles.includes(snapshot.actor.role) && snapshot.actor.role !== 'patient' && <a className="text-button" href={`/api/export/entities?${new URLSearchParams({ types: type === 'All' ? journey.collection.join(',') : type, q, status: status === 'All' ? '' : status })}`}>Export this list</a>}</div>
        <div className="compact-filters"><input aria-label={t('Search')} placeholder={language === 'Hindi' ? 'नाम या संदर्भ खोजें…' : 'Search name or reference...'} value={q} onChange={e => setQ(e.target.value)}/><select aria-label={t('Record type')} value={type} onChange={e => setType(e.target.value)}><option value="All">{t('All')}</option>{journey.collection.map(kind => <option key={kind} value={kind}>{t(human(kind))}</option>)}</select><select aria-label={t('Record status')} value={status} onChange={e => setStatus(e.target.value)}><option value="All">{t('All')}</option>{[...new Set(all.map(e => e.status))].map(s => <option key={s} value={s}>{t(s)}</option>)}</select></div>
        <Records entities={filtered} snapshot={snapshot} selected={selectedId} onSelect={e => setSelectedId(e.id)}/>
        {selected && <><div className="selected-toolbar"><h3>{t('Selected work item')}</h3><button className="text-button" onClick={async () => { try { setHistory(await api<Entity[]>(`/api/history/${selected.id}`)); } catch (error) { setError((error as Error).message); } }}>{t('Version history')}</button>
          {selected.type === 'visit' && doctorRoles.includes(snapshot.actor.role) && <a className="button primary small" href={`#visit/${selected.id}`}>{t('Open visit workspace')}</a>}
          {selected.type === 'document' && selected.status === 'Available' && <a className="button secondary small" href={`/api/documents/${selected.id}/file`} target="_blank" rel="noreferrer">{t('Open document')}</a>}
          {selected.type === 'article' && text(selected.data, 'journey') && <a className="text-button" href={`#journey/${text(selected.data, 'journey')}`}>{t('Show me in the app')}</a>}
        </div><Detail entity={selected} entities={snapshot.entities}/></>}
      </section>{canAct && <aside className="panel form-panel"><ActionPanel key={`${id}:${selectedId}`} journeyId={id} snapshot={snapshot} context={context} vault={props.vault} saveDraft={props.saveDraft} submit={props.submit}/></aside>}</div>
    </>}
    {history && <Modal title={t('Immutable version history')} wide onClose={() => setHistory(null)}>{history.map(e => <Detail key={e.version} entity={e} entities={snapshot.entities}/>)}</Modal>}
  </>;
}
export function VisitWorkspace({ id, ...props }: PageProps & { id: string }) {
  const { t, language } = useI18n();
  const { snapshot } = props; const visit = snapshot.entities.find(e => e.id === id && e.type === 'visit');
  const [tab, setTab] = useState('Overview');
  if (!visit || !doctorRoles.includes(snapshot.actor.role)) return <Empty title="Visit unavailable in your care scope"/>;
  const patient = snapshot.entities.find(e => e.id === visit.patientId)!;
  const allergies = snapshot.entities.filter(e => e.type === 'allergy' && e.patientId === patient.id && e.status === 'Active');
  const related = snapshot.entities.filter(e => e.patientId === patient.id);
  const context = { visitId: id, patientId: patient.id, targetId: id };
  const tabJourney: Record<string, string> = { Notes: 'DJ09', Vitals: 'DJ08', Medicines: 'DJ10', Tests: 'DJ11', Reports: 'DJ20' };
  const tabTypes: Record<string, string[]> = { Overview: ['history', 'allergy', 'followup'], Notes: ['note'], Vitals: ['vital'], Medicines: ['rx', 'dispense'], Tests: ['order', 'sample'], Reports: ['result', 'review'] };
  let filteredIds: string[] = [];
  try { filteredIds = JSON.parse(sessionStorage.getItem(`samford-visit-filter:${snapshot.actor.id}`) ?? '{}').ids ?? []; } catch { filteredIds = []; }
  const index = filteredIds.indexOf(id);
  const call = commands.find(c => c.name === 'visit.call')!; const open = commands.find(c => c.name === 'visit.open')!;
  const action = (name: string) => props.showAction(commands.find(c => c.name === name)!, context);
  return <>
    <div className="breadcrumb"><a href="#patients">{t('Patients')}</a><span>/</span><span>{text(visit.data, 'number')}</span></div>
    <header className="patient-banner"><div className="patient-avatar">{text(patient.data, 'name').split(' ').at(-1)}</div><div><h1>{label(patient)}</h1><p>{num(patient.data, 'age')} {t('years')} · {t(text(patient.data, 'sex'))} · <strong>{text(patient.data, 'uhid')}</strong> · {t('Mobile ending')} {text(patient.data, 'mobile').slice(-4)}</p><span className={`allergy-banner ${allergies.some(e => text(e.data, 'substance') !== 'No known allergies') ? 'has-allergy' : ''}`}>{t('Allergies')}: {allergies.length ? allergies.map(e => text(e.data, 'substance')).join(', ') : t('Not yet recorded')}</span></div><div className="patient-status"><Pill>{visit.status}</Pill><span>{t('Token')} {num(visit.data, 'token')} · {text(visit.data, 'room')}</span></div></header>
    <div className="visit-toolbar"><span>{text(visit.data, 'date')} · {text(visit.data, 'time')} · {text(visit.data, 'mode')} / {text(visit.data, 'opdType')}</span><div>
      <button className="text-button" disabled={index <= 0} onClick={() => { location.hash = `visit/${filteredIds[index - 1]}`; }}>{t('Previous')}</button>
      <button className="text-button" onClick={() => void props.refresh()}>{t('Refresh')}</button>
      <button className="text-button" disabled={index < 0 || index >= filteredIds.length - 1} onClick={() => { location.hash = `visit/${filteredIds[index + 1]}`; }}>{t('Next')}</button>
    </div></div>
    {visit.status !== 'In consultation' && !['Done', 'Cancelled'].includes(visit.status) && <section className="confirm-patient"><div><strong>{t('Confirm the person in front of you')}</strong><p>{t('Check name, UHID, mobile ending and allergy status. Calling a token is not starting a consultation.')}</p></div><div>{call.from?.includes(visit.status) && <button className="button secondary" onClick={() => action('visit.call')}>{language === 'Hindi' ? 'टोकन बुलाएँ' : 'Call token'} {num(visit.data, 'token')}</button>}{open.from?.includes(visit.status) && <button className="button primary" onClick={() => action('visit.open')}>{t('Patient has arrived · confirm')}</button>}<a className="text-button" href="#patients">{t('Not this patient')}</a></div></section>}
    <nav className="workspace-tabs" aria-label={language === 'Hindi' ? 'विज़िट कार्यस्थल' : 'Visit workspace'}>{['Overview', 'Notes', 'Vitals', 'Medicines', 'Tests', 'Reports'].map(value => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{t(value)}</button>)}</nav>
    <div className="visit-body">
      {tab === 'Overview' ? <div className="overview-grid">
        <section className="panel"><div className="panel-heading"><h2>{t('Important now')}</h2><Icon name="heart"/></div><dl className="summary-list"><dt>{t('Allergy status')}</dt><dd>{allergies.length ? allergies.map(e => `${text(e.data, 'substance')}: ${text(e.data, 'reaction')}`).join('; ') : t('Not recorded - review before prescribing')}</dd><dt>{t('Latest note')}</dt><dd>{related.filter(e => e.type === 'note').at(-1)?.data.complaints?.toString() || t('No note saved yet')}</dd><dt>{t('Vitals')}</dt><dd>{related.some(e => e.type === 'vital') ? `${related.filter(e => e.type === 'vital').length} ${t('readings in the chart')}` : t('Not taken yet')}</dd><dt>{t('New reports')}</dt><dd>{related.filter(e => e.type === 'result' && e.status === 'Released').length} {t('Released')}</dd></dl></section>
        <section className="panel"><div className="panel-heading"><h2>{t('Consultation checklist')}</h2><Icon name="check"/></div><div className="finish-checklist">{[['Notes', 'note'], ['Medicines', 'rx'], ['Tests', 'order'], ['Follow-up', 'followup'], ['Referral', 'referral']].map(([title, type]) => <div key={type}><span className={related.some(e => e.type === type && (!text(e.data, 'visitId') || text(e.data, 'visitId') === visit.id)) ? 'complete-check' : 'optional-check'}><Icon name="check" size={15}/></span><strong>{t(title)}</strong><span>{related.filter(e => e.type === type && (!text(e.data, 'visitId') || text(e.data, 'visitId') === visit.id)).length || t('Not added')}</span></div>)}</div></section>
      </div> : <div className="workflow-columns"><section className="panel"><div className="panel-heading"><h2>{t(tab)} · {t('History')}</h2></div>{related.filter(e => tabTypes[tab].includes(e.type)).length ? related.filter(e => tabTypes[tab].includes(e.type)).map(e => <details className="record-details" key={e.id}><summary><span>{label(e)}</span><Pill>{e.status}</Pill></summary><Detail entity={e} entities={snapshot.entities}/></details>) : <Empty title={language === 'Hindi' ? `${t(tab)}: अभी कोई रिकॉर्ड नहीं` : `No ${tab.toLowerCase()} yet`}/>}</section><aside className="panel form-panel"><ActionPanel key={tab} journeyId={tabJourney[tab]} {...props} context={context}/></aside></div>}
    </div>
    <section className="visit-actions"><h2>{t('Visit actions')} <span className="micro">{t('Use in any order')}</span></h2><div className="action-grid">{[
      ['Follow-up', 'followup.request', 'calendar'], ['Refer', 'referral.send', 'arrow'], ['History', 'history.add', 'file'],
      ['Allergies', 'allergy.add', 'shield'], ['Hold / cancel / move', 'visit.hold', 'more'], ['Print / share', 'document.generate', 'file'],
      ['Admit / OT', 'admission.request', 'heart'], ['Link ABHA', 'abha.request', 'shield']
    ].map(([title, name, icon]) => <button key={name} onClick={() => action(name)} disabled={!hasRole(snapshot.actor, commands.find(c => c.name === name)?.roles ?? [])}><Icon name={icon}/><span>{t(title)}</span><Icon name="arrow" size={15}/></button>)}</div><div className="finish-bar"><span className="micro">{language === 'Hindi' ? 'मंज़ूरी, पहुँच और पूरा होना अलग हैं। बाकी भुगतान परामर्श पूरा करने को नहीं रोकता।' : 'Approval, delivery and completion remain separate. Pending payment does not block finishing.'}</span><button className="button primary" disabled={!['In consultation', 'Held'].includes(visit.status)} onClick={() => action('visit.done')}>{t('Done & next')}<Icon name="arrow" size={17}/></button></div></section>
  </>;
}
function DoctorMonthlyNumbers({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useI18n();
  const [month, setMonth] = useState(istDate(snapshot.now).slice(0, 7)); const [record, setRecord] = useState<Data>(); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { setError(t('Choose a valid month.')); setRecord(undefined); return; }
    const [year, value] = month.split('-').map(Number);
    const to = `${month}-${new Date(Date.UTC(year, value, 0)).getUTCDate()}`;
    api<{ records: Data[] }>(`/api/reports/activity?${new URLSearchParams({ from: `${month}-01`, to })}`).then(result => {
      if (active) { setRecord(result.records.find(row => row.doctorId === snapshot.actor.id)); setError(''); }
    }).catch(error => { if (active) { setError(error.message); setRecord(undefined); } });
    return () => { active = false; };
  }, [month, snapshot.revision, snapshot.actor.id]);
  return <section className="panel padded" data-monthly-numbers><div className="panel-heading"><h2>{t('Your monthly numbers')}</h2><input aria-label={t('Activity month')} type="month" value={month} onChange={event => setMonth(event.target.value)}/></div><ErrorBox message={error}/>
    {record && <dl className="summary-list">{[['signInDays', 'Days signed in'], ['patientsAttended', 'Patients attended'], ['prescriptions', 'Prescriptions'], ['referralsSent', 'Referrals sent'], ['referralsReceived', 'Referrals received']].map(([key, title]) => <React.Fragment key={key}><dt>{t(title)}</dt><dd data-metric={key}>{num(record, key)}</dd></React.Fragment>)}</dl>}<p className="micro">{t('App activity, not attendance')}</p></section>;
}
export function Reports({ snapshot, initial = 'activity' }: { snapshot: Snapshot; initial?: string }) {
  const kinds = actorReportKinds(snapshot.actor);
  const [kind, setKind] = useState(kinds.includes(initial) ? initial : kinds[0] ?? ''); const [from, setFrom] = useState(istDate(snapshot.now).slice(0, 7) + '-01'); const [to, setTo] = useState(istDate(snapshot.now)); const [department, setDepartment] = useState('');
  const [data, setData] = useState<Data[]>([]); const [error, setError] = useState('');
  const params = new URLSearchParams({ from, to, department }); const url = `/api/reports/${kind}?${params}`;
  useEffect(() => { api<{ records: Data[] }>(url).then(r => { setData(r.records); setError(''); }).catch(e => setError(e.message)); }, [url, snapshot.revision]);
  return <section className="panel"><div className="panel-heading"><h2>{kind === 'activity' ? 'Doctor activity (app use, not attendance)' : `${human(kind)} report`}</h2><a className="button secondary small" href={`${url}&format=csv`}>Export audited CSV<Icon name="file" size={16}/></a></div><div className="filters">
    <label>Report<select value={kind} onChange={e => setKind(e.target.value)}>{kinds.map(v => <option value={v} key={v}>{human(v)}</option>)}</select></label>
    <label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>Through<input type="date" value={to} onChange={e => setTo(e.target.value)}/></label><label>Department<select value={department} onChange={e => setDepartment(e.target.value)} disabled={snapshot.actor.role === 'head'}><option value="">All authorized</option>{snapshot.entities.filter(e => e.type === 'department').map(e => <option value={e.id} key={e.id}>{label(e)}</option>)}</select></label></div><ErrorBox message={error}/>
    {data.length ? <div className="records-table"><table><thead><tr>{Object.keys(data[0]).filter(k => k !== 'calendar').map(key => <th key={key}>{human(key)}</th>)}</tr></thead><tbody>{data.map((row, i) => <tr key={i}>{Object.entries(row).filter(([key]) => key !== 'calendar').map(([key, value]) => <td key={key}><Value value={value}/></td>)}</tr>)}</tbody></table></div> : <Empty title="No data in this range"/>}
    {kind === 'activity' && data.map((row, i) => Array.isArray(row.calendar) && row.calendar.length > 0 ? <details key={i} className="record-details"><summary>{String(row.doctor)} - daily activity calendar</summary><Value value={row.calendar}/></details> : null)}
    <p className="micro table-foot">Data received up to {displayTime(snapshot.now)} IST. Counts are derived from accepted events, not screen visits.</p>
  </section>;
}
export function Audit({ snapshot }: { snapshot: Snapshot }) {
  const [action, setAction] = useState(''); const [actor, setActor] = useState(''); const [entries, setEntries] = useState<Data[]>([]); const [error, setError] = useState('');
  const url = `/api/audit?${new URLSearchParams({ action, actor })}`;
  useEffect(() => { api<Data[]>(url).then(setEntries).catch(e => setError(e.message)); }, [url, snapshot.revision]);
  return <section className="panel"><div className="panel-heading"><h2>Append-only activity trail</h2><a className="button secondary small" href={`${url}&format=csv`}>Export audited CSV</a></div><div className="filters"><label>Action<input value={action} onChange={e => setAction(e.target.value)} placeholder="e.g. result.release"/></label><label>Actor<select value={actor} onChange={e => setActor(e.target.value)}><option value="">All actors</option>{snapshot.people.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}<option>System</option></select></label></div><ErrorBox message={error}/>{entries.map(entry => <details className="audit-entry" key={String(entry.seq)}><summary><code>#{String(entry.seq)}</code><strong>{String(entry.action)}</strong><span>{String(entry.actor)}</span><Pill>{String(entry.result)}</Pill><small>{displayTime(String(entry.at))}</small></summary><Value value={entry}/></details>)}</section>;
}
export function SyncPage({ vault, toggleOffline, retry, resolve, fault, error }: {
  vault: Vault; toggleOffline: () => Promise<void>; retry: () => void;
  resolve: (item: Pending, decision: 'Keep hospital' | 'New reviewed action' | 'Discard') => Promise<void>;
  fault: (name: string) => Promise<void>; error: string;
}) {
  const { t, language } = useI18n();
  const [selected, setSelected] = useState<Pending>();
  const [offline, setOffline] = useState(vault.offline);
  const [savingNetwork, setSavingNetwork] = useState(false);
  const [localError, setLocalError] = useState('');
  useEffect(() => { setOffline(vault.offline); }, [vault.offline]);
  return <><Heading eyebrow={language === 'Hindi' ? 'स्थानीय संग्रह / सिंक' : 'LOCAL STORAGE / SYNC'} title="Saved first. Sent with confidence." actions={<button className="button primary" onClick={retry} disabled={vault.offline || !vault.pending.some(item => ['Queued', 'Retryable'].includes(item.status))}><Icon name="sync" size={17}/>{t('Try now')}</button>}>Browser save, hospital acceptance, recipient acknowledgement and clinical completion are different facts.</Heading>
    <div className="sync-controls"><label className="check"><input type="checkbox" checked={offline} disabled={savingNetwork} onChange={async event => {
      setOffline(event.target.checked); setSavingNetwork(true); setLocalError('');
      try { await toggleOffline(); } catch (error) { setOffline(vault.offline); setLocalError((error as Error).message); } finally { setSavingNetwork(false); }
    }}/>{t('Simulate no network for this persona')}{savingNetwork && ` (${t('Saving...')})`}</label><label>{t('Next send fault')}<select defaultValue="None" onChange={event => void fault(event.target.value).catch(error => setLocalError(error.message))}>{['None', 'Fail before acceptance', 'Lose reply after acceptance', 'Conflict', 'Reject'].map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label></div><ErrorBox message={localError || error}/>
    <aside className="notice">{language === 'Hindi' ? 'मसौदे और भेजने की कतार इस ब्राउज़र के IndexedDB में AES-GCM से एन्क्रिप्ट हैं और हर पहचान के लिए अलग हैं। यह उत्पादन स्तर की डिवाइस सुरक्षा नहीं है। ब्राउज़र डेटा साफ़ करने पर ये स्थानीय प्रतियाँ हटती हैं।' : 'Drafts and queued operations are AES-GCM encrypted in this browser’s IndexedDB, isolated by persona. This public sample is not a production device-security solution. Clearing browser data removes these local copies.'}</aside>
    <section className="panel"><div className="panel-heading"><h2>{t('Operation history')}</h2><span className="micro">{language === 'Hindi' ? 'अस्वीकृत कार्य समीक्षा के लिए रहते हैं; स्वतंत्र कार्य आगे भेजे जाते हैं।' : 'Saved order; rejected items stay for review while independent work continues'}</span></div>{vault.pending.length ? [...vault.pending].reverse().map(item => <div className="sync-row" key={item.id}><span className={`sync-stage ${item.status === 'Accepted' ? 'good' : ''}`}><Icon name={item.status === 'Accepted' ? 'check' : 'sync'}/></span><div><strong>{t(item.label)}</strong><small>{language === 'Hindi' ? 'सहेजा' : 'Saved'} {displayTime(item.request.createdAt)} · {language === 'Hindi' ? 'प्रयास' : 'attempt'} {item.attempts} · {item.id.slice(0, 8)}</small>{item.error && <p className="danger-text">{item.error.message}</p>}{item.receipt && <small>{language === 'Hindi' ? 'अस्पताल की स्वीकृति' : 'Hospital accepted'} {displayTime(item.receipt.acceptedAt)}. {language === 'Hindi' ? 'प्राप्तकर्ता की स्थिति साझा कार्य सूची में है।' : 'Recipient state is in the shared worklist.'}</small>}</div><Pill>{item.status}</Pill><button className="button secondary small" onClick={() => setSelected(item)}>{t('Inspect')}</button></div>) : <Empty title="No queued operations">{language === 'Hindi' ? 'टिकाऊ स्थानीय सहेजने के बाद ही कार्रवाइयाँ यहाँ दिखती हैं।' : 'Actions appear here only after a durable local save.'}</Empty>}</section>
    {selected && <Modal title={`${t(selected.label)} - ${t(selected.status)}`} onClose={() => setSelected(undefined)} wide><div className="conflict-comparison"><section><h3>{t('Your saved action')}</h3><Value value={selected.request.payload}/></section><section><h3>{t('Hospital’s current record')}</h3>{selected.error?.current ? <Detail entity={selected.error.current} entities={vault.snapshot?.entities ?? []}/> : <p>{language === 'Hindi' ? selected.receipt ? 'स्वीकृत। प्राप्ति और पूरा होने की स्थिति कार्य सूची में जाँचें।' : 'टकराव वाला रिकॉर्ड नहीं मिला। आपकी प्रविष्टि सुरक्षित है।' : selected.receipt ? 'Accepted. Inspect the worklist for receipt and fulfillment states.' : 'No conflicting record supplied. Your input is retained.'}</p>}</section></div>
      {!['Accepted', 'Discarded'].includes(selected.status) && <div className="modal-actions">{selected.status === 'Conflict' && <button className="button secondary" onClick={() => void resolve(selected, 'Keep hospital').then(() => setSelected(undefined))}>{t('Keep hospital version')}</button>}
        {['Conflict', 'Rejected'].includes(selected.status) && <button className="button primary" onClick={() => void resolve(selected, 'New reviewed action').then(() => setSelected(undefined))}>{t('Review in form as a new action')}</button>}
        <button className="button secondary" onClick={() => void resolve(selected, 'Discard').then(() => setSelected(undefined))}>{t('Discard this unsent intent')}</button></div>}</Modal>}
  </>;
}
export function Board({ id }: { id: string }) {
  const [data, setData] = useState<Data>(); const [error, setError] = useState('');
  useEffect(() => { const read = () => api<Data>(`/api/board/${id}`).then(setData).catch(e => setError(e.message)); void read(); const interval = setInterval(read, 2000); return () => clearInterval(interval); }, [id]);
  return <main className="waiting-board"><div className="board-heading"><p className="eyebrow">SAMFORD / SAMPLE WAITING AREA</p><h1>{data?.active ? String(data.name) : 'Board not active'}</h1><p>Token numbers only. Please have your slip ready.</p></div><ErrorBox message={error}/>
    {data?.active && Array.isArray(data.doctors) && <div className="board-grid">{data.doctors.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      return <section className="board-doctor" key={index}><h2>{String(row.doctor)}</h2><p>{String(row.room)} · {String(row.presence)}</p><span>NOW CALLING</span><strong className="board-token">{String(row.currentToken ?? '—')}</strong><p>Up next: {Array.isArray(row.nextTokens) ? row.nextTokens.join(' · ') || 'No waiting tokens' : ''}</p>{Array.isArray(row.missedTokens) && row.missedTokens.length > 0 && <p>Missed: {row.missedTokens.join(' · ')}. Please see the counter.</p>}</section>;
    })}</div>}
    <footer>PUBLIC SYNTHETIC DEMO · No patient names, initials, UHIDs or mobile numbers are sent to this screen.</footer>
  </main>;
}
