import React from 'react';
import { label, type Entity, type Json } from '../shared/model.js';
import { useI18n } from './i18n.js';
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/></>,
    people: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M7 3v4M17 3v4M7 14h2M12 14h2M7 18h2"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    bell: <><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4"/></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    plus: <path d="M12 4v16M4 12h16"/>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
    sync: <><path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/></>,
    shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z"/><path d="m8 12 3 3 5-6"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    chart: <><path d="M3 3v18h18M7 17v-6M12 17V6M17 17v-9"/></>,
    file: <><path d="M5 2h10l4 4v16H5zM14 2v5h5M8 11h8M8 15h8M8 19h5"/></>,
    close: <path d="m6 6 12 12M6 18 12 6"/>,
    logout: <><path d="M10 3H3v18h7M8 12h13m-4-4 4 4-4 4"/></>,
    heart: <><path d="M12 21S2 14 2 8a5 5 0 0 1 10-2A5 5 0 0 1 22 8c0 6-10 13-10 13"/><path d="M4 11h4l2-4 4 8 2-4h4"/></>,
    lock: <><rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v3"/></>,
    flask: <><path d="M9 2h6M10 2v7L4 20h16L14 9V2M7 15h10"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.grid}</svg>;
}
export function Logo() { return <a className="brand" href="#home"><span className="brand-mark"><Icon name="plus" size={27}/></span><span>samford<span className="brand-sub">WORKFLOW LAB</span></span></a>; }
export function Pill({ children, tone = '' }: { children: React.ReactNode; tone?: string }) {
  const { t } = useI18n();
  const value = typeof children === 'string' ? children : '';
  const style = tone || (/Critical|Failed|Rejected|Conflict|Expired|Blocked|Declined|Cancelled/.test(value) ? 'danger' : /Pending|Requested|Held|Waiting|Draft|Queued|Part|Offered/.test(value) ? 'warning' : /Approved|Done|Completed|Active|Paid|Delivered|Released|Accepted|Available|Received|Free/.test(value) ? 'good' : 'neutral');
  return <span className={`pill ${style}`}>{typeof children === 'string' ? t(children) : children}</span>;
}
export function Empty({ title = 'Nothing waiting', children }: { title?: string; children?: React.ReactNode }) {
  const { t, language } = useI18n();
  return <div className="empty"><span className="empty-icon"><Icon name="check" size={26}/></span><h3>{t(title)}</h3><p>{children ? typeof children === 'string' ? t(children) : children : language === 'Hindi' ? 'जिम्मेदार डेस्क से नया कार्य आने पर वह यहाँ दिखेगा।' : 'New work will appear here when the responsible desk sends it.'}</p></div>;
}
export function ErrorBox({ message }: { message?: string }) {
  const { t, language } = useI18n();
  return message ? <div className="error-box" role="alert"><Icon name="shield"/><span>{language === 'Hindi' && <strong>कार्रवाई पूरी नहीं हुई। विवरण जाँचें: </strong>}{t(message)}</span></div> : null;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const { t } = useI18n();
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => { ref.current?.showModal(); const dialog = ref.current; return () => { dialog?.close(); }; }, []);
  return <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2>{t(title)}</h2><button className="icon-btn" onClick={onClose} aria-label={t('Close dialog')}><Icon name="close"/></button></header><div className="modal-body">{children}</div>
  </dialog>;
}
export function displayTime(value: string) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
export function human(key: string) { return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/Id$/, ' ID').replace(/^./, c => c.toUpperCase()); }
export function Value({ value, entities = [] }: { value: Json | undefined; entities?: Entity[] }): React.ReactNode {
  if (value === undefined || value === null || value === '') return <span className="muted">Not recorded</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? <div className="value-list">{value.map((item, index) => <div key={index}><Value value={item} entities={entities}/></div>)}</div> : <span className="muted">None</span>;
  if (typeof value === 'object') return <dl className="mini-details">{Object.entries(value).filter(([key]) => !['file', 'base64', 'codeHash'].includes(key)).map(([key, item]) => <React.Fragment key={key}><dt>{human(key)}</dt><dd><Value value={item} entities={entities}/></dd></React.Fragment>)}</dl>;
  if (typeof value === 'string') {
    const linked = entities.find(e => e.id === value);
    if (linked) return <span title={value}>{label(linked)}</span>;
    if (/^\d{4}-\d\d-\d\dT/.test(value)) return displayTime(value);
  }
  return String(value);
}
export function Detail({ entity, entities }: { entity: Entity; entities: Entity[] }) {
  return <section className="entity-detail"><div className="detail-title"><h3>{label(entity)}</h3><Pill>{entity.status}</Pill></div>
    <p className="micro">Record <code>{entity.id}</code> · v{entity.version} · Changed by {entity.updatedBy} · {displayTime(entity.updatedAt)} IST</p>
    <dl>{Object.entries(entity.data).filter(([key]) => !['file', 'base64', 'codeHash', 'trackingHash', 'letterhead', 'name'].includes(key)).map(([key, value]) => <React.Fragment key={key}><dt>{human(key)}</dt><dd><Value value={value} entities={entities}/></dd></React.Fragment>)}</dl>
  </section>;
}
