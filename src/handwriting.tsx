import { useEffect, useState } from 'react';
import { api } from './storage.js';
import { useI18n } from './i18n.js';
import { Pill, Icon, ErrorBox, displayTime } from './ui.js';
import { commandByName } from '../shared/commands.js';
import { text, num, hasRole, type CommandDef, type Data, type Entity, type Role, type Snapshot } from '../shared/model.js';
import { deliveryStateLabels, documentTypeLabels, recipientKindLabels } from '../shared/handwriting.js';

type Page = { index: number; pngSha256: string; widthPx: number; heightPx: number; url: string };
type Version = { version: number; createdAt: string; signedAt: string; reason: string | null; authorName: string; title: string; pages: Page[]; pdfSha256: string; pdfUrl: string;
  inkSha256: string | null; inkFormat: string | null; recordHash: string };
type Recipient = { kind: string; labId: string | null; name: string; state: string; version: number; updatedAt: string; note: string | null };
type HandwrittenDocument = { documentId: string; visitId: string; patientId: string; type: string; title: string; author: { doctorId: string; name: string }; latestVersion: number;
  routing: { pharmacy: boolean; labs: string[]; patient: boolean }; hints: Data | null; versions: Version[]; recipients: Recipient[] };
type Submit = (command: CommandDef, payload: Data, targetId: string | undefined, draftKey: string, actingRole?: Role) => Promise<void>;
const zoomLevels = [0, 0.5, 0.75, 1, 1.5, 2];
const ownKind: Partial<Record<Role, string>> = { pharmacist: 'PHARMACY', lab: 'LAB', patient: 'PATIENT' };

// Shows the exact signed pages. Recipients with an unopened copy record "viewed" when they open it.
export function HandwritingViewer({ documentId, snapshot, submit }: { documentId: string; snapshot: Snapshot; submit?: Submit }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<HandwrittenDocument>(); const [error, setError] = useState('');
  const [versionNumber, setVersionNumber] = useState(0); const [pageIndex, setPageIndex] = useState(0); const [zoom, setZoom] = useState(0); const [opening, setOpening] = useState(false);
  const [openedCopy, setOpenedCopy] = useState('');
  useEffect(() => {
    let active = true;
    api<HandwrittenDocument>(`/api/handwriting/documents/${documentId}`).then(result => {
      if (!active) return;
      setDoc(result); setVersionNumber(current => result.versions.some(version => version.version === current) ? current : result.latestVersion); setError('');
    }).catch(failure => { if (active) setError((failure as Error).message); });
    return () => { active = false; };
  }, [documentId, snapshot.revision]);
  const roles = (snapshot.actor.roles?.length ? snapshot.actor.roles : [snapshot.actor.role]) as Role[];
  const copy = snapshot.entities.find(entity => entity.type === 'handwritingDelivery' && text(entity.data, 'documentId') === documentId && num(entity.data, 'version') === doc?.latestVersion &&
    roles.some(role => ownKind[role] === text(entity.data, 'recipient')));
  const viewCommand = commandByName['handwriting.view'];
  const mustOpen = Boolean(copy && copy.status === 'Available' && openedCopy !== copy.id && submit && hasRole(snapshot.actor, viewCommand.roles));
  const actingRole = roles.find(role => ownKind[role] === text(copy?.data ?? {}, 'recipient'));
  if (error) return <ErrorBox message={error}/>;
  if (!doc) return <p className="micro" aria-busy="true">{t('Loading handwritten record...')}</p>;
  const version = doc.versions.find(item => item.version === versionNumber) ?? doc.versions.at(-1)!;
  const page = version.pages[Math.min(pageIndex, version.pages.length - 1)];
  const open = async () => {
    if (!copy || !submit) return;
    setOpening(true);
    try { await submit(viewCommand, {}, copy.id, `handwriting.view:${copy.id}`, actingRole); setOpenedCopy(copy.id); }
    catch (failure) { setError((failure as Error).message); }
    finally { setOpening(false); }
  };
  const hints = doc.hints ?? {};
  const medicines = Array.isArray(hints.medicines) ? hints.medicines as Data[] : []; const tests = Array.isArray(hints.tests) ? hints.tests as Data[] : [];
  return <section className="handwriting-viewer" data-handwriting-document={doc.documentId} data-version={version.version}>
    <div className="handwriting-head">
      <div><span className="eyebrow">{t(documentTypeLabels[doc.type] ?? doc.type)} · {t('Signed handwriting')}</span><h3>{version.title}</h3>
        <p className="micro">{version.authorName} · {t('Signed')} {displayTime(version.signedAt)} · {t('Received')} {displayTime(version.createdAt)}</p></div>
      <div className="handwriting-tools">
        {doc.versions.length > 1 && <label className="compact-field">{t('Version')}<select aria-label={t('Signed version')} value={version.version} onChange={event => { setVersionNumber(Number(event.target.value)); setPageIndex(0); }}>
          {doc.versions.map(item => <option key={item.version} value={item.version}>{`v${item.version}${item.version === doc.latestVersion ? ` (${t('latest')})` : ` (${t('replaced')})`}`}</option>)}</select></label>}
        {!mustOpen && <a className="button secondary small" href={version.pdfUrl} target="_blank" rel="noreferrer"><Icon name="file" size={16}/>{t('Open PDF')}</a>}
      </div>
    </div>
    {version.reason && <p className="notice">{t('Addendum reason')}: {version.reason}</p>}
    {version.version !== doc.latestVersion && <p className="notice boundary">{t('A newer signed version replaced this one. Act only on the latest version.')}</p>}
    {mustOpen ? <div className="handwriting-gate"><p>{t('Opening records that you viewed this exact signed copy. The doctor sees Viewed.')}</p>
      <button className="button primary" disabled={opening} onClick={() => void open()}>{t('Open handwritten copy')}</button></div> : <>
      <div className="handwriting-controls" role="toolbar" aria-label={t('Page controls')}>
        <button className="icon-btn" aria-label={t('Previous page')} disabled={pageIndex <= 0} onClick={() => setPageIndex(index => Math.max(0, index - 1))}>‹</button>
        <span data-page-indicator>{t('Page')} {page.index + 1} / {version.pages.length}</span>
        <button className="icon-btn" aria-label={t('Next page')} disabled={pageIndex >= version.pages.length - 1} onClick={() => setPageIndex(index => Math.min(version.pages.length - 1, index + 1))}>›</button>
        <span className="spacer"/>
        <button className="icon-btn" aria-label={t('Zoom out')} disabled={zoom === zoomLevels[1]} onClick={() => setZoom(current => current === 0 ? 0.75 : zoomLevels[Math.max(1, zoomLevels.indexOf(current) - 1)])}>−</button>
        <button className="text-button" aria-pressed={zoom === 0} onClick={() => setZoom(0)}>{t('Fit width')}</button>
        <button className="icon-btn" aria-label={t('Zoom in')} disabled={zoom === zoomLevels.at(-1)} onClick={() => setZoom(current => current === 0 ? 1 : zoomLevels[Math.min(zoomLevels.length - 1, zoomLevels.indexOf(current) + 1)])}>+</button>
        <span className="micro" data-zoom>{zoom === 0 ? t('Fit') : `${Math.round(zoom * 100)}%`}</span>
      </div>
      <div className={`handwriting-page ${zoom === 0 ? 'fit' : 'zoomed'}`}>
        <img src={page.url} alt={`${version.title} ${t('page')} ${page.index + 1} / ${version.pages.length}`} width={page.widthPx} height={page.heightPx}
          style={zoom === 0 ? undefined : { width: `${Math.round(page.widthPx * zoom)}px`, maxWidth: 'none', height: 'auto' }}/>
      </div>
    </>}
    {(medicines.length > 0 || tests.length > 0 || text(hints, 'diagnosis') || text(hints, 'notes')) && <details className="handwriting-hints"><summary>{t('Typed hints (unverified; the signed handwriting is authoritative)')}</summary><ul>
      {medicines.map((line, index) => <li key={`m${index}`}>{[text(line, 'name'), text(line, 'strength'), text(line, 'dose'), text(line, 'frequency'), typeof line.durationDays === 'number' ? `${line.durationDays} ${t('days')}` : ''].filter(Boolean).join(' · ')}</li>)}
      {tests.map((line, index) => <li key={`t${index}`}>{[text(line, 'name'), text(line, 'code')].filter(Boolean).join(' · ')}</li>)}
      {text(hints, 'diagnosis') && <li>{t('Diagnosis hint')}: {text(hints, 'diagnosis')}</li>}{text(hints, 'notes') && <li>{text(hints, 'notes')}</li>}
    </ul></details>}
    {doc.recipients.length > 0 && <div className="handwriting-recipients"><strong>{t('Delivery of the latest version')}</strong><ul>{doc.recipients.map(recipient => <li key={`${recipient.kind}-${recipient.labId ?? ''}`} data-recipient={`${recipient.kind}:${recipient.labId ?? ''}`}>
      <span>{recipient.name || t(recipientKindLabels[recipient.kind] ?? recipient.kind)}</span><Pill>{deliveryStateLabels[recipient.state] ?? recipient.state}</Pill>{recipient.note && <span className="micro">{recipient.note}</span>}<span className="micro">{displayTime(recipient.updatedAt)}</span></li>)}</ul></div>}
    <p className="micro">{t('SYNTHETIC SAMPLE - not for clinical use.')} {t('Record hash')} <code title={version.recordHash}>{version.recordHash.slice(0, 16)}…</code></p>
  </section>;
}
export function handwritingDocumentId(entity: Entity | undefined) {
  return entity && ['handwrittenDocument', 'handwritingDelivery', 'investigationResult'].includes(entity.type) ? text(entity.data, 'documentId') : '';
}
// Latest signed version of each handwritten document for one patient, newest first.
export function latestHandwritten(entities: Entity[], patientId: string) {
  const latest = new Map<string, Entity>();
  for (const entity of entities) if (entity.type === 'handwrittenDocument' && entity.patientId === patientId) {
    const current = latest.get(text(entity.data, 'documentId'));
    if (!current || num(entity.data, 'version') > num(current.data, 'version')) latest.set(text(entity.data, 'documentId'), entity);
  }
  return [...latest.values()].sort((a, b) => text(b.data, 'signedAt').localeCompare(text(a.data, 'signedAt')));
}
