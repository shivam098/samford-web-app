import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { commands, commandByName } from '../shared/commands.js';
import { journeys } from '../shared/journeys.js';
import { adminRoles, doctorRoles, roleNames, roleLabel, hasRole, text, type Actor, type Data, type CommandDef, type CommandRequest, type Receipt, type Snapshot } from '../shared/model.js';
import { ActionForm, type FormContext } from './forms.js';
import { Home, Patients, Calendar, JourneyPage, JourneyCards, VisitWorkspace, SyncPage, Board, Heading, type PageProps } from './pages.js';
import { Logo, Icon, Pill, ErrorBox, Modal, Empty, Value } from './ui.js';
import { api, HttpError, readVault, persistVault, clearVault, browserId, pendingCount, type Vault, type Pending } from './storage.js';
import './styles.css';
import { LanguageProvider, LanguageSelect, useI18n } from './i18n.js';
import { type Language } from '../shared/i18n.js';

type Bootstrap = { publicDemo: boolean; warning: string; personas: Pick<Actor, 'id' | 'name' | 'role' | 'roles' | 'department' | 'state' | 'mobile'>[]; departments: { id: string; name: string }[]; demoPassword: string; demoPin: string; version: number };
const emptyVault = (): Vault => ({ pending: [], drafts: {}, offline: false });
function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(1) || 'home');
  useEffect(() => { const changed = () => { setRoute(location.hash.slice(1) || 'home'); window.scrollTo(0, 0); }; window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  return route;
}
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="fatal"><Logo/><h1>The workspace could not be displayed.</h1><p>Your stored drafts were not deleted. Reload to reconnect, or keep this browser profile and ask for help.</p><ErrorBox message={this.state.error}/><button className="button primary" onClick={() => location.reload()}>Reload safely</button></main>;
    return this.props.children;
  }
}
function Landing({ bootstrap, signIn, error, busy }: { bootstrap?: Bootstrap; signIn: (actor: Actor) => Promise<void>; error: string; busy: boolean }) {
  const { t } = useI18n();
  const [portal, setPortal] = useState('Doctor'); const [manual, setManual] = useState(false); const [localError, setLocalError] = useState('');
  const [working, setWorking] = useState('');
  const portalRoles = (actor: { role: string }) => portal === 'Doctor' ? ['doctor', 'resident'].includes(actor.role) : portal === 'Administration' ? ['superadmin', 'admin', 'it', 'head', 'auditor'].includes(actor.role) : portal === 'Patient' ? actor.role === 'patient' : !['doctor', 'resident', 'superadmin', 'admin', 'it', 'head', 'auditor', 'patient'].includes(actor.role);
  return <div className="landing"><header className="landing-header"><Logo/><div><LanguageSelect/><span className="sample-chip">{t('SYNTHETIC DATA ONLY')}</span><button className="button secondary small" onClick={() => setManual(true)}>{t('Test sign-in / onboarding')}<Icon name="arrow" size={16}/></button></div></header>
    <main className="landing-main"><section className="hero"><p className="eyebrow"><span className="status-dot"/>{t('A CONNECTED HOSPITAL, READY TO TRY')}</p><h1>{t('A better day.')}<br/><em>{t('For every desk.')}</em></h1><p className="hero-copy">{t('Follow a patient’s journey from the first appointment to the last handoff. Real workflows. Shared sample records. No live clinical systems.')}</p><div className="hero-meta"><span><strong>4</strong> connected experiences</span><span><strong>87</strong> journey definitions</span><span><Icon name="sync" size={18}/><strong>Saved-first</strong> local work</span></div>
      <div className="public-warning"><Icon name="shield" size={22}/><div><strong>{t('Public shared demo · no password required')}</strong><p>{t('Anyone with this link can choose a demo persona and change the shared sample data. Use synthetic information only. This is not production authentication or clinical software.')}</p></div></div>
      <div className="flow-preview"><span>Front desk</span><Icon name="arrow" size={14}/><span>Doctor</span><Icon name="arrow" size={14}/><span>Lab / pharmacy</span><Icon name="arrow" size={14}/><span>Patient</span></div>
    </section><section className="persona-panel"><div className="panel-heading"><div><p className="eyebrow">{t('CHOOSE YOUR WORKSPACE')}</p><h2>{t('Step into a demo role.')}</h2></div><Icon name="grid"/></div><nav className="portal-tabs">{['Doctor', 'Staff', 'Administration', 'Patient'].map(name => <button key={name} className={portal === name ? 'active' : ''} onClick={() => setPortal(name)}>{t(name)}</button>)}</nav>
      <ErrorBox message={localError || error}/>{bootstrap ? <div className="persona-list">{bootstrap.personas.filter(portalRoles).map(persona => <button className="persona-card" data-persona-id={persona.id} key={persona.id} disabled={Boolean(working) || busy || persona.state !== 'Active'} onClick={async () => {
        setWorking(persona.id); setLocalError('');
        try { const result = await api<{ actor: Actor }>('/api/auth/demo', { method: 'POST', body: { actorId: persona.id, deviceId: browserId() } }); await signIn(result.actor); }
        catch (error) { setLocalError((error as Error).message); } finally { setWorking(''); }
      }}><span className={`persona-avatar ${portal.toLowerCase()}`}><Icon name={portal === 'Doctor' ? 'heart' : portal === 'Administration' ? 'shield' : portal === 'Patient' ? 'people' : 'grid'} size={22}/></span><span><strong>{persona.name}</strong><small>{t(roleLabel(persona))} · {persona.department}{persona.state !== 'Active' ? ` · ${t(persona.state)}` : ''}</small></span>{working === persona.id ? <span className="spinner"/> : <Icon name="arrow" size={18}/>}</button>)}</div> : <div className="empty"><span className="spinner"/><p>Connecting to the local mock hospital...</p></div>}
      <footer className="persona-footer"><Icon name="lock" size={16}/><span>{t('Each named persona has its own server-enforced role. Switching never changes the author of queued work.')}</span></footer>
    </section></main><footer className="landing-footer"><span>Samford workflow lab / Sample campus, Ranchi</span><span>Built for feedback. Not for patient care.</span></footer>
    {manual && bootstrap && <Modal title="Test sign-in & onboarding journeys" onClose={() => setManual(false)} wide><SignInLab bootstrap={bootstrap} complete={signIn}/></Modal>}
  </div>;
}
function SignInLab({ bootstrap, complete }: { bootstrap: Bootstrap; complete: (actor: Actor) => Promise<void> }) {
  const { t, language } = useI18n();
  const [mode, setMode] = useState('Password sign-in'); const [login, setLogin] = useState(localStorage.getItem('samford-remember-login') || 'doctor-a'); const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(Boolean(localStorage.getItem('samford-remember-login')));
  const [challenge, setChallenge] = useState<Data>(); const [code, setCode] = useState(''); const [captcha, setCaptcha] = useState<Data>(); const [answer, setAnswer] = useState('');
  const [mobile, setMobile] = useState('9000000001'); const [error, setError] = useState(''); const [request, setRequest] = useState<Data>({ name: '', staffId: '', mobile: '', departmentId: 'general', registration: '' });
  const [tracking, setTracking] = useState<Data>(); const [trackingResult, setTrackingResult] = useState<Data>();
  const [loading, setLoading] = useState(false);
  async function run(work: () => Promise<void>) { setLoading(true); setError(''); try { await work(); } catch (error) { setError((error as Error).message); } finally { setLoading(false); } }
  useEffect(() => { if (mode === 'Patient OTP') void run(async () => setCaptcha(await api<Data>('/api/auth/captcha'))); }, [mode]);
  return <div className="signin-lab"><nav className="portal-tabs">{['Password sign-in', 'Patient OTP', 'Ask for access', 'Track access', 'Forgot password'].map(m => <button key={m} className={m === mode ? 'active' : ''} onClick={() => { setMode(m); setChallenge(undefined); setError(''); }}>{t(m)}</button>)}</nav><ErrorBox message={error}/>
    {challenge ? <form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await api<{ actor: Actor }>('/api/auth/otp', { method: 'POST', body: { challengeId: challenge.challengeId, code } }); await complete(result.actor); }); }}>
      <div className="notice"><strong>{language === 'Hindi' ? 'नमूना दूसरी जाँच' : 'Simulated second check'}</strong><p>{language === 'Hindi' ? 'नीचे दिखाया नमूना कोड इस्तेमाल करें। वास्तविक SMS या ऑथेंटिकेटर सेवा नहीं जुड़ी है।' : text(challenge, 'message')}</p><code className="demo-code">{text(challenge, 'simulatedCode')}</code><p>{language === 'Hindi' ? 'कोड पाँच मिनट में समाप्त होता है। गलत कोड से लॉकआउट का परीक्षण कर सकते हैं।' : 'Expires in five minutes. Wrong codes exercise lockout. No real SMS or authenticator service.'}</p></div><label className="field">{t('Six-digit code')}<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" required value={code} onChange={e => setCode(e.target.value)}/></label><button className="button primary" disabled={loading}>{t('Verify code')}</button><button type="button" className="text-button" onClick={() => setChallenge(undefined)}>{t('Start again / resend')}</button>
    </form> : mode === 'Password sign-in' ? <form onSubmit={event => { event.preventDefault(); void run(async () => {
      if (remember) localStorage.setItem('samford-remember-login', login); else localStorage.removeItem('samford-remember-login');
      setChallenge(await api<Data>('/api/auth/start', { method: 'POST', body: { login, password, deviceId: browserId() } })); setPassword('');
    }); }}>
      <p className="form-help">Exercise the full password, second-check and one-time-invite journey. Seeded sample accounts use <code>{bootstrap.demoPassword}</code>. Newly invited users must use the temporary password shown to their admin.</p>
      <label className="field">{t('Login ID, e-mail or mobile')}<input required value={login} onChange={e => setLogin(e.target.value)} autoComplete="username"/></label><label className="field">{t('Password')}<input type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/></label>
      <label className="check"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/>{t('Remember only the login ID on this browser')}</label>
      <p className="micro">{language === 'Hindi' ? 'यह ऐप पासवर्ड सहेजकर नहीं रखता।' : 'The password is never persisted by this app.'}</p><button className="button primary" disabled={loading}>{t('Continue to second check')}<Icon name="arrow" size={17}/></button>
    </form> : mode === 'Patient OTP' ? <form onSubmit={event => { event.preventDefault(); void run(async () => setChallenge(await api<Data>('/api/auth/patient', { method: 'POST', body: { mobile, captchaId: captcha?.id, answer, deviceId: browserId() } }))); }}>
      <p>{language === 'Hindi' ? 'दर्ज नमूना मोबाइल इस्तेमाल करें। नमूना परिवार A: ' : 'Use a registered synthetic mobile. Demo family A: '}<code>9000000001</code>{language === 'Hindi' ? '। तीन गलत OTP पर यह मोबाइल 30 मिनट के लिए लॉक होता है।' : '. Three wrong OTPs lock this mobile for 30 minutes.'}</p>
      <label className="field">{t('Mobile')}<input required value={mobile} inputMode="numeric" onChange={e => setMobile(e.target.value)}/></label><label className="field">{language === 'Hindi' ? 'नमूना कैप्चा' : 'Sample captcha'}: {text(captcha ?? {}, 'question')}<input required value={answer} onChange={e => setAnswer(e.target.value)}/></label><button className="button primary" disabled={loading}>{t('Request simulated OTP')}</button>
    </form> : mode === 'Ask for access' ? <form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await api<Data>('/api/access', { method: 'POST', body: request }); setTracking(result); localStorage.setItem('samford-access-request', JSON.stringify(result)); setMode('Track access'); }); }}>
      <p>{language === 'Hindi' ? 'प्रशासन अनुरोध की समीक्षा करता है। विभाग चुनने से अनुमति नहीं मिलती।' : 'Administration reviews your request. Choosing a department does not grant access.'}</p>{['name', 'staffId', 'mobile', 'registration'].map(key => <label className="field" key={key}>{t(({ name: 'Full synthetic name', staffId: 'Staff ID', mobile: 'Synthetic mobile', registration: 'Medical council registration (sample)' } as Record<string, string>)[key])}<input required value={text(request, key)} onChange={e => setRequest({ ...request, [key]: e.target.value })}/></label>)}
      <label className="field">{t('Suggested department')}<select value={text(request, 'departmentId')} onChange={e => setRequest({ ...request, departmentId: e.target.value })}>{bootstrap.departments.map(dep => <option value={dep.id} key={dep.id}>{dep.name}</option>)}</select></label><button className="button primary" disabled={loading}>{t('Send access request')}</button>
    </form> : mode === 'Track access' ? <section><p>Your tracking code is retained only in this browser. Administration hands over the one-time password separately.</p>
      {tracking && <div className="notice"><strong>Request received</strong><code>{text(tracking, 'id')}</code><p>Tracking key: <code>{text(tracking, 'trackingKey')}</code></p></div>}
      <button className="button primary" onClick={() => void run(async () => { const data = tracking ?? JSON.parse(localStorage.getItem('samford-access-request') ?? '{}') as Data; setTrackingResult(await api<Data>('/api/access/track', { method: 'POST', body: data })); })}>{t('Refresh request status')}</button>{trackingResult && <div className="notice"><Value value={trackingResult}/></div>}
    </section> : <section className="notice"><h3>Call hospital IT support</h3><p>There is no self-service password reset. IT must call back on the registered number, confirm staff ID, and issue a one-time password. In this demo, use the IT support persona and the Password recovery workflow.</p><p>Locked accounts are recovered through the same verified support process.</p></section>}
  </div>;
}
function Onboarding({ actor, refreshActor }: { actor: Actor; refreshActor: () => Promise<void> }) {
  const { t, language } = useI18n();
  const [password, setPassword] = useState(''); const [error, setError] = useState('');
  return <main className="onboarding"><Logo/><section className="panel"><p className="eyebrow">{language === 'Hindi' ? 'पहला साइन-इन' : 'FIRST SIGN-IN'}</p><h1>{t(actor.temporary ? 'Make this login yours.' : 'Confirm your profile.')}</h1><p>{language === 'Hindi' ? 'यह पूरा होने तक मरीज़ के कार्यस्थल उपलब्ध नहीं हैं।' : 'Patient screens stay unavailable until this is complete.'}</p><ErrorBox message={error}/>
    {actor.temporary ? <form onSubmit={e => { e.preventDefault(); void api('/api/auth/password', { method: 'POST', body: { password } }).then(() => { setPassword(''); return refreshActor(); }).catch(error => setError(error.message)); }}><label className="field">{t('New personal password')}<input type="password" required minLength={10} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"/></label><p className="micro">{language === 'Hindi' ? 'डिफ़ॉल्ट न्यूनतम 10 अक्षर हैं। लॉगिन, स्टाफ आईडी या पिछले पाँच पासवर्ड न दोहराएँ। केवल नया नमूना पासवर्ड इस्तेमाल करें।' : 'Minimum 10 characters by default. Not your login or staff ID; do not reuse the last five passwords. Use a new synthetic password, never a real credential.'}</p><button className="button primary">{t('Set personal password')}</button></form>
    : <form onSubmit={e => { e.preventDefault(); void api('/api/auth/confirm', { method: 'POST', body: { confirmed: true } }).then(refreshActor).catch(error => setError(error.message)); }}><dl className="summary-list"><dt>{language === 'Hindi' ? 'नाम' : 'Name'}</dt><dd>{actor.name}</dd><dt>{language === 'Hindi' ? 'भूमिका' : 'Role'}</dt><dd>{t(roleNames[actor.role])}</dd><dt>{t('Department')}</dt><dd>{actor.department}</dd><dt>{language === 'Hindi' ? 'स्टाफ आईडी' : 'Staff ID'}</dt><dd>{actor.staffId}</dd><dt>{language === 'Hindi' ? 'परिसर' : 'Campus'}</dt><dd>Sample campus, Ranchi</dd></dl><label className="check"><input type="checkbox" required/>{language === 'Hindi' ? 'मैंने प्रोफ़ाइल जाँच ली है। सुधार के लिए प्रशासक से अनुरोध करूँगा/करूँगी।' : 'I checked my profile. I will request any corrections from the administrator.'}</label><button className="button primary">{t('Confirm profile & continue')}</button></form>}
  </section></main>;
}
function App() {
  const { language, setLanguage, t } = useI18n();
  const route = useRoute(); const [bootstrap, setBootstrap] = useState<Bootstrap>(); const [actor, setActor] = useState<Actor>(); const [vault, setVault] = useState<Vault>(emptyVault);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [locked, setLocked] = useState(false); const [blocked, setBlocked] = useState('');
  const [action, setAction] = useState<{ command: CommandDef; context: FormContext }>(); const [receipt, setReceipt] = useState<Receipt>(); const [bell, setBell] = useState(false); const [mobileMenu, setMobileMenu] = useState(false);
  const [search, setSearch] = useState(''); const [pin, setPin] = useState(''); const [pinError, setPinError] = useState(''); const [retryTick, setRetryTick] = useState(0);
  const vaultRef = useRef(vault); const actorRef = useRef(actor); const serial = useRef<Promise<void>>(Promise.resolve()); const syncing = useRef(false);
  const [syncingUi, setSyncingUi] = useState(false);
  actorRef.current = actor;
  useEffect(() => {
    if (!actor) return;
    if (!doctorRoles.includes(actor.role) && actor.role !== 'patient') { setLanguage('English'); return; }
    const pending = [...vault.pending].reverse().find(item => item.actorId === actor.id && ['preferences.language', 'preferences.save'].includes(item.name) && !['Accepted', 'Discarded', 'Rejected'].includes(item.status));
    const chosen = pending ? text(pending.request.payload, 'language') : text(actor.preferences, 'language');
    if (chosen === 'English' || chosen === 'Hindi') setLanguage(chosen);
  }, [actor?.id, actor?.preferences.language, vault.pending.map(item => `${item.id}:${item.status}`).join(',')]);
  const mutateVault = useCallback((update: (current: Vault) => Vault): Promise<void> => {
    const actorId = actorRef.current?.id;
    if (!actorId) return Promise.reject(new Error('Choose a persona before saving.'));
    const work = async () => {
      if (actorRef.current?.id !== actorId) throw new Error('Persona changed. The previous actor’s work was not reassigned.');
      const next = update(structuredClone(vaultRef.current));
      await persistVault(actorId, next);
      vaultRef.current = next; setVault(next);
    };
    const promise = serial.current.then(work, work); serial.current = promise; return promise;
  }, []);
  async function enter(next: Actor) {
    setLoading(true); setError(''); setBlocked(''); setLocked(false); location.hash = 'home';
    try {
      const cached = await readVault(next.id);
      actorRef.current = next; setActor(next); vaultRef.current = cached; setVault(cached);
      localStorage.setItem('samford-last-persona', JSON.stringify({ id: next.id, name: next.name, role: next.role }));
      if (!next.temporary && next.profileConfirmed) {
        const snapshot = await api<Snapshot>('/api/state', { activity: true });
        if (snapshot.actor.id !== next.id) throw new Error('Another tab changed the active persona. Reload before continuing.');
        await mutateVault(current => ({ ...current, snapshot, snapshotReceivedAt: Date.now() }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The authorized workspace could not be loaded. Saved work was retained.';
      setError(message); setBlocked(message); throw error;
    } finally {
      setLoading(false);
    }
  }
  async function refreshActor() {
    const me = await api<{ actor: Actor; locked: boolean }>('/api/auth/me', { activity: true });
    await enter(me.actor); setLocked(me.locked);
  }
  const refresh = useCallback(async () => {
    const current = actorRef.current; if (!current || vaultRef.current.offline) return;
    try {
      const snapshot = await api<Snapshot>('/api/state');
      if (snapshot.actor.id !== current.id) { setBlocked('Another browser tab changed the active persona. Reload to select the correct session; your original work remains attributed to its author.'); return; }
      setActor(snapshot.actor); await mutateVault(v => ({ ...v, snapshot, snapshotReceivedAt: Date.now() })); setError('');
    } catch (error) {
      if (error instanceof HttpError && error.status === 423) setLocked(true);
      else if (error instanceof HttpError && [401, 403, 426].includes(error.status)) setBlocked(error.message);
      else setError((error as Error).message);
    }
  }, [mutateVault]);
  useEffect(() => {
    let active = true;
    void api<Bootstrap>('/api/bootstrap').then(value => { if (active) setBootstrap(value); }).catch(e => { if (active) setError(e.message); });
    void api<{ actor: Actor; locked: boolean }>('/api/auth/me').then(async me => {
      if (!active) return; const cached = await readVault(me.actor.id); actorRef.current = me.actor; setActor(me.actor); vaultRef.current = cached; setVault(cached); setLocked(me.locked);
      if (!me.locked && !me.actor.temporary && me.actor.profileConfirmed && !cached.offline) await refresh();
    }).catch(async error => {
      if (error instanceof HttpError && error.status === 0) {
        const last = JSON.parse(localStorage.getItem('samford-last-persona') ?? '{}') as { id?: string };
        if (last.id) {
          const cached = await readVault(last.id);
          if (cached.snapshot) {
            actorRef.current = cached.snapshot.actor; setActor(cached.snapshot.actor); vaultRef.current = cached; setVault(cached);
            setError('Offline saved copy. Current hospital access cannot be checked; writes stay local until reauthenticated.');
          }
        }
      } else if (error instanceof HttpError && error.detail.code !== 'SIGN_IN') setError(error.message);
    }).finally(() => { if (active) setLoading(false); });
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => { if (active) setError('Offline app-shell caching is unavailable in this browser. Local drafts still use IndexedDB.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!actor || locked || blocked || actor.temporary || !actor.profileConfirmed || vault.offline) return;
    const timer = setInterval(() => void refresh(), 4000);
    const online = () => { setRetryTick(n => n + 1); void refresh(); };
    window.addEventListener('online', online);
    let lastPing = 0;
    const activity = () => {
      if (Date.now() - lastPing > 45000) {
        lastPing = Date.now();
        void api('/api/auth/me', { activity: true }).catch(e => { if (e instanceof HttpError && e.status === 423) setLocked(true); });
      }
    };
    window.addEventListener('pointerdown', activity); window.addEventListener('keydown', activity);
    return () => { clearInterval(timer); window.removeEventListener('online', online); window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity); };
  }, [actor?.id, actor?.temporary, actor?.profileConfirmed, locked, blocked, vault.offline, refresh]);
  const signature = vault.pending.map(e => `${e.id}:${e.status}`).join(',');
  useEffect(() => {
    const scale = Number(text(actor?.preferences ?? {}, 'textSize', '100%').replace('%', ''));
    document.documentElement.style.fontSize = `${Number.isFinite(scale) ? scale : 100}%`;
    return () => { document.documentElement.style.fontSize = ''; };
  }, [actor?.preferences.textSize]);
  useEffect(() => {
    if (!actor || locked || blocked || vault.offline || syncing.current || !navigator.onLine || actor.temporary || !actor.profileConfirmed) return;
    const first = vault.pending.find(e => ['Queued', 'Retryable'].includes(e.status));
    if (!first) return;
    const timer = setTimeout(async () => {
      if (syncing.current) return;
      syncing.current = true; setSyncingUi(true);
      try {
        const item = vaultRef.current.pending.find(e => e.id === first.id)!;
        if (item.actorId !== actorRef.current?.id) throw new Error('Queued action belongs to a different persona. It was not sent.');
        await mutateVault(v => ({ ...v, pending: v.pending.map(e => e.id === item.id ? { ...e, status: 'In flight', attempts: e.attempts + 1 } : e) }));
        const result = await api<Receipt>(`/api/commands/${item.name}`, { method: 'POST', body: item.request });
        const safeReceipt = structuredClone(result);
        const hasOnce = Boolean(result.data?.temporaryPassword || result.data?.temporarySlips || result.data?.simulatedCode);
        if (safeReceipt.data) for (const key of ['temporaryPassword', 'temporarySlips', 'simulatedCode']) delete safeReceipt.data[key];
        await mutateVault(v => ({ ...v, pending: v.pending.map(e => e.id === item.id ? { ...e, status: 'Accepted', receipt: safeReceipt, error: undefined } : e) }));
        if (hasOnce) setReceipt(result);
        else if (result.data?.documentId) setReceipt(result);
        if (result.data?.nextVisitId) location.hash = `visit/${result.data.nextVisitId}`;
        await refresh();
        const versions = result.data?.versions;
        if (item.anchorId && versions && typeof versions === 'object' && !Array.isArray(versions) && typeof versions[item.anchorId] === 'number') {
          const version = versions[item.anchorId] as number;
          await mutateVault(v => ({ ...v, pending: v.pending.map(e => e.status === 'Queued' && e.attempts === 0 && e.anchorId === item.anchorId && e.request.expectedVersion === item.request.expectedVersion ? { ...e, request: { ...e.request, expectedVersion: version } } : e) }));
        }
        void api('/api/sync/device', { method: 'POST', body: { unsent: pendingCount(vaultRef.current) } }).catch(e => setError(e.message));
      } catch (error) {
        const detail = error instanceof HttpError ? error.detail : { message: (error as Error).message, code: 'LOCAL_FAILURE', retryable: false };
        const status = error instanceof HttpError && error.status === 409 ? 'Conflict' : detail.retryable ? 'Retryable' : 'Rejected';
        await mutateVault(v => ({ ...v, pending: v.pending.map(e => e.id === first.id ? { ...e, status, error: detail } : e) })).catch(e => setError(e.message));
        if (error instanceof HttpError && [401, 403, 423, 426].includes(error.status)) setBlocked(error.message);
      } finally { syncing.current = false; setSyncingUi(false); setRetryTick(n => n + 1); }
    }, first.status === 'Retryable' ? Math.min(30000, 2000 * 2 ** Math.min(first.attempts, 4)) : 50);
    return () => clearTimeout(timer);
  }, [actor?.id, locked, blocked, vault.offline, signature, retryTick, mutateVault, refresh]);
  const submit: FormPropsSubmit = async (command, payload, targetId, draftKey, actingRole) => {
    const snap = vaultRef.current.snapshot; const actor = actorRef.current;
    if (!snap || !actor) throw new Error('Choose a persona before saving.');
    if (command.name === 'visit.done') {
      const noteKey = `note.save:${targetId}`;
      if (vaultRef.current.drafts[noteKey]) throw new Error('A note draft still exists for this visit. Save it before Done & next.');
    }
    const anchorId = command.target ? targetId : text(payload, 'visitId') || text(payload, 'admissionId') || text(payload, 'patientId') || undefined;
    const anchor = snap.entities.find(e => e.id === anchorId);
    const contextVersions: Record<string, number> = {};
    if (command.name === 'rx.approve' && anchor?.patientId) {
      const patient = snap.entities.find(e => e.id === anchor.patientId); if (patient) contextVersions[patient.id] = patient.version;
      const prior = snap.entities.find(e => e.type === 'rx' && text(e.data, 'visitId') === anchor.id); if (prior) contextVersions[prior.id] = prior.version;
    }
    if (command.name === 'operation.emergencySchedule') {
      const planned = snap.entities.find(entity => entity.id === text(payload, 'plannedId'));
      if (planned) contextVersions[planned.id] = planned.version;
    }
    const id = crypto.randomUUID();
    const reportedTime = new Date(new Date(snap.now).getTime() + Date.now() - (vaultRef.current.snapshotReceivedAt ?? Date.now())).toISOString();
    const request: CommandRequest = { operationId: id, actorId: actor.id, actingRole, targetId, expectedVersion: anchor?.version, createdAt: reportedTime, deviceId: browserId(), payload, contextVersions };
    const queued: Pending = { id, actorId: actor.id, name: command.name, label: command.label, request, status: 'Queued', attempts: 0, anchorId };
    await mutateVault(v => { const drafts = { ...v.drafts }; delete drafts[draftKey]; return { ...v, drafts, pending: [...v.pending, queued] }; });
    setAction(undefined); setError('');
  };
  async function signOut() {
    setError('');
    if (pendingCount(vaultRef.current)) { setError('Sign-out is blocked while work is unsent. Open Sync & recovery to send, review or explicitly discard it.'); location.hash = 'sync'; return; }
    try {
      await api('/api/auth/logout', { method: 'POST', body: { unsent: 0 } });
      setActor(undefined); actorRef.current = undefined; setVault(emptyVault()); vaultRef.current = emptyVault(); setBlocked(''); setLocked(false); setAction(undefined); localStorage.removeItem('samford-last-persona');
      setBootstrap(await api<Bootstrap>('/api/bootstrap')); location.hash = 'home';
    } catch (e) { setError((e as Error).message); }
  }
  const saveDraft = (key: string, value: Data) => mutateVault(v => ({ ...v, drafts: { ...v.drafts, [key]: value } }));
  const retryNow = () => {
    void mutateVault(v => ({ ...v, pending: v.pending.map(item => item.status === 'Retryable' ? { ...item, status: 'Queued' } : item) })).then(() => setRetryTick(n => n + 1)).catch(error => setError(error.message));
  };
  async function resolvePending(item: Pending, decision: 'Keep hospital' | 'New reviewed action' | 'Discard') {
    await mutateVault(v => ({ ...v, pending: v.pending.map(e => e.id === item.id ? { ...e, status: 'Discarded' } : e) }));
    await refresh();
    if (decision === 'New reviewed action') {
      const command = commandByName[item.name]; const payload = structuredClone(item.request.payload);
      if (Array.isArray(payload.lines)) payload.lines = payload.lines.map(line => typeof line === 'object' && line && !Array.isArray(line) ? { ...line, reviewed: false } : line);
      if ('reviewed' in payload) payload.reviewed = false;
      setAction({ command, context: { targetId: item.request.targetId, patientId: text(payload, 'patientId') || undefined, visitId: text(payload, 'visitId') || undefined, admissionId: text(payload, 'admissionId') || undefined, preset: payload } });
    }
  }
  if (route.startsWith('board/')) return <Board id={route.slice(6)}/>;
  if (!actor) return <Landing bootstrap={bootstrap} signIn={enter} error={error} busy={loading}/>;
  if (loading) return <main className="fatal" aria-busy="true"><Logo/><h1>{language === 'Hindi' ? 'अधिकृत कार्यस्थल खोल रहे हैं…' : 'Opening the authorized workspace...'}</h1><p>{language === 'Hindi' ? 'वर्तमान अनुमति जाँचने तक पुराने रिकॉर्ड नहीं दिखाए जाते।' : 'Cached records stay hidden until current access has been checked.'}</p></main>;
  if (actor.temporary || !actor.profileConfirmed) return <Onboarding actor={actor} refreshActor={refreshActor}/>;
  if (locked || blocked) return <main className="lock-screen"><Logo/><section className="panel"><span className="lock-icon"><Icon name="lock" size={32}/></span><h1>{t('Workspace locked')}</h1><p>{t('No patient information is displayed while locked. Your saved work remains in this browser.')}</p><ErrorBox message={blocked || pinError}/>{!blocked ? <form onSubmit={e => { e.preventDefault(); void api('/api/auth/unlock', { method: 'POST', body: { pin } }).then(async () => { setPin(''); setPinError(''); setLocked(false); await refresh(); }).catch(e => setPinError(e.message)); }}><label className="field">{t('Demo unlock PIN')}<input type="password" value={pin} onChange={e => setPin(e.target.value)} required/></label><p className="micro">{t('Synthetic local unlock: 2468. No biometrics are captured.')}</p><button className="button primary">{t('Unlock workspace')}</button></form> : <>
      <button className="button primary" onClick={() => { setActor(undefined); actorRef.current = undefined; setBlocked(''); setLocked(false); void api<Bootstrap>('/api/bootstrap').then(setBootstrap).catch(e => setError(e.message)); }}>Return to demo sign-in (retain recovery)</button>
      <p className="micro">{pendingCount(vault)} local actions retained under their original author.</p>
      {blocked.includes('removal') && <button className="button secondary" onClick={async () => {
        if (!window.confirm(`Wipe only this persona's Samford cache? ${pendingCount(vault)} unsent items will be reported lost. This does not touch other files.`)) return;
        try { await api('/api/device/wipe-ack', { method: 'POST', body: { confirmed: true, unsentLost: pendingCount(vault) } }); await clearVault(actor.id); setActor(undefined); actorRef.current = undefined; setBlocked(''); } catch (e) { setError((e as Error).message); }
      }}>Confirm requested browser-app wipe</button>}
    </>}</section></main>;
  const snapshot = vault.snapshot;
  if (!snapshot) return <main className="fatal"><Logo/><h1>{loading ? 'Opening your workspace...' : 'No authorized snapshot available.'}</h1><ErrorBox message={error}/><button className="button primary" onClick={() => void refresh()}>Reconnect</button><button className="text-button" onClick={() => void signOut()}>Sign out</button></main>;
  const doctor = doctorRoles.includes(actor.role); const admin = adminRoles.includes(actor.role); const patient = actor.role === 'patient';
  const portalName = doctor ? 'Doctor workspace' : admin ? 'Administration' : patient ? 'Patient portal' : 'Staff workspace';
  const hindi = language === 'Hindi';
  const changeLanguage = (value: Language) => {
    const command = commandByName['preferences.language'];
    void submit(command, { language: value }, undefined, 'preferences.language:header', actor.role).catch(error => setError(error.message));
  };
  const nav = doctor ? [
    { href: 'home', title: hindi ? 'होम' : 'Home', icon: 'home' }, { href: 'patients', title: hindi ? 'मरीज़' : 'Patients', icon: 'people' }, { href: 'calendar', title: hindi ? 'कैलेंडर' : 'Calendar', icon: 'calendar' }, { href: 'workflows', title: hindi ? 'और' : 'More', icon: 'grid' }
  ] : patient ? [{ href: 'home', title: t('Home'), icon: 'home' }, { href: 'journey/SJ35', title: t('Book appointment'), icon: 'calendar' }, { href: 'journey/SJ36', title: t('My documents'), icon: 'file' }, { href: 'journey/SJ37', title: t('Payments & updates'), icon: 'chart' }]
    : [{ href: 'home', title: 'Home', icon: 'home' }, { href: 'workflows', title: 'All workflows', icon: 'grid' }, ...journeys.filter(j => hasRole(actor, j.roles) && !['AJ01', 'AJ02', 'SJ01'].includes(j.id)).map(j => ({ href: `journey/${j.id}`, title: j.title, icon: j.id.includes('AJ') ? 'file' : 'grid' }))];
  const pageProps: PageProps = { snapshot, vault, saveDraft, submit, refresh, showAction: (command, context = {}) => setAction({ command, context }) };
  let content: React.ReactNode;
  if (route.startsWith('visit/')) content = <VisitWorkspace key={route} id={route.slice(6)} {...pageProps}/>;
  else if (route.startsWith('journey/')) content = route === 'journey/DJ25' ? <SyncPage vault={vault} toggleOffline={() => mutateVault(v => ({ ...v, offline: !v.offline }))} retry={retryNow} resolve={resolvePending} fault={async next => { await api('/api/demo/fault', { method: 'POST', body: { next } }); }} error={error}/>
    : <JourneyPage key={route} id={route.slice(8)} {...pageProps}/>;
  else if (route === 'patients') content = doctor ? <Patients {...pageProps}/> : <JourneyPage id={patient ? 'SJ36' : 'SJ02'} {...pageProps}/>;
  else if (route === 'calendar') content = doctor ? <Calendar {...pageProps}/> : <Empty title="This workflow is outside your role"/>;
  else if (route === 'workflows') content = <><Heading eyebrow={`${portalName.toUpperCase()} / WORKFLOWS`} title={doctor ? 'Everything for your day.' : 'The right task, the right role.'}>Every journey here is backed by shared state and validated API commands. Provider effects are simulated.</Heading><div className="search-field workflow-search"><Icon name="search"/><input aria-label="Search workflows" placeholder="Search a task or journey ID..." value={search} onChange={e => setSearch(e.target.value)}/></div><JourneyCards snapshot={snapshot} query={search}/></>;
  else if (route === 'sync') content = <SyncPage vault={vault} toggleOffline={() => mutateVault(v => ({ ...v, offline: !v.offline }))} retry={retryNow} resolve={resolvePending} fault={async next => { await api('/api/demo/fault', { method: 'POST', body: { next } }); }} error={error}/>;
  else if (route === 'demo') content = <DemoControls actor={actor} refresh={refresh} resetLocal={() => { setActor(undefined); actorRef.current = undefined; setVault(emptyVault()); void api<Bootstrap>('/api/bootstrap').then(setBootstrap).catch(e => setError(e.message)); }}/>;
  else if (route === 'api') content = <ContractPage/>;
  else content = <Home {...pageProps}/>;
  return <div data-revision={snapshot.revision} className={`app-shell ${text(actor.preferences, 'theme') === 'Dark' ? 'dark' : ''} ${doctor ? 'doctor-shell' : ''}`}>
    <a className="skip-link" href="#main-content">{t('Skip to workspace')}</a>
    <aside className={`sidebar ${mobileMenu ? 'open' : ''}`}><Logo/><div className="workspace-label"><span className="status-dot"/>{t(portalName)}<small>Sample campus · Ranchi</small></div><nav aria-label="Primary navigation">{nav.map(link => <a key={link.href} className={route === link.href ? 'active' : ''} href={`#${link.href}`} onClick={() => setMobileMenu(false)}><Icon name={link.icon} size={19}/><span>{link.title}</span>{route === link.href && <span className="nav-active-dot"/>}</a>)}</nav>
      <div className="sidebar-bottom"><a href="#sync"><Icon name="sync" size={18}/>{t('Sync & recovery')}{pendingCount(vault) > 0 && <span className="count">{pendingCount(vault)}</span>}</a><a href="#demo"><Icon name="shield" size={18}/>{t('Demo controls')}</a><a href="#api"><Icon name="file" size={18}/>{t('APIs & coverage')}</a><div className="sidebar-note">{hindi ? 'सार्वजनिक नमूना डेमो' : 'PUBLIC SYNTHETIC DEMO'}<br/><span>{hindi ? 'वास्तविक रिकॉर्ड या लाइव सेवा नहीं।' : 'No real records. No live integrations.'}</span></div></div>
    </aside>
    {mobileMenu && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobileMenu(false)}/>}
    <div className="main-shell"><header className="topbar"><div className="topbar-left"><button className="icon-btn menu-button" aria-label="Open navigation" onClick={() => setMobileMenu(!mobileMenu)}><Icon name="grid"/></button><span className="topbar-portal">{t(portalName)}</span><span className="topbar-divider"/><span className="sample-chip">{t('SAMPLE DATA')}</span></div><div className="topbar-right">
      {(doctor || patient) && <LanguageSelect onChange={changeLanguage}/>}
      <a className={`sync-pill ${vault.offline ? 'offline' : ''}`} href="#sync"><Icon name="sync" size={15}/>{vault.offline ? t('Offline simulation') : syncingUi ? t('Sending...') : pendingCount(vault) ? `${pendingCount(vault)} ${hindi ? 'भेजना बाकी' : 'not sent'}` : t('Hospital connected')}</a>
      {doctor && <button className="icon-btn notification-button" aria-label={`${t('Notifications')} ${snapshot.notifications.length}`} onClick={() => setBell(true)}><Icon name="bell"/>{snapshot.notifications.length > 0 && <span>{snapshot.notifications.length}</span>}</button>}
      <button className="persona-switch" onClick={() => void signOut()} title="Sign out before switching persona"><span className="avatar">{actor.name.replace('Demo ', '').slice(0, 1)}</span><span><strong>{actor.name}</strong><small>{roleLabel(actor)} · {t('Switch persona')}</small></span><Icon name="logout" size={17}/></button>
    </div></header>
    <main id="main-content" className="main-content"><ErrorBox message={error && route !== 'sync' ? error : ''}/>{content}<footer className="app-footer"><span>{hindi ? 'नमूना डेटा · सभी समय IST · वास्तविक चिकित्सकीय निर्णय नहीं' : 'Sample data · All times IST · No live clinical decisions'}</span><button className="text-button" onClick={() => void api('/api/auth/lock', { method: 'POST', body: {} }).then(() => setLocked(true)).catch(e => setError(e.message))}><Icon name="lock" size={15}/>{t('Lock workspace')}</button></footer></main>
    {doctor && <nav className="mobile-tabs" aria-label="Doctor bottom tabs">{nav.map(link => <a href={`#${link.href}`} className={route === link.href ? 'active' : ''} key={link.href}><Icon name={link.icon}/><span>{link.title}</span></a>)}</nav>}
    </div>
    {action && <Modal title={t(action.command.label)} wide={['rx.approve', 'discharge.draft', 'set.publish', 'set.personal'].includes(action.command.name)} onClose={() => setAction(undefined)}>
      {action.command.journeys.some(id => ['DJ06', 'DJ14', 'DJ15', 'DJ16'].includes(id)) && <label className="action-selector">{t('Related action')}<select value={action.command.name} onChange={e => setAction({ ...action, command: commandByName[e.target.value] })}>{commands.filter(c => hasRole(actor, c.roles) && c.journeys.some(id => action.command.journeys.includes(id))).map(c => <option key={c.name} value={c.name}>{t(c.label)}</option>)}</select></label>}
      <ActionForm key={`${action.command.name}-${action.context.targetId || ''}`} command={action.command} snapshot={snapshot} context={action.context} vault={vault} saveDraft={saveDraft} submit={submit}/>
    </Modal>}
    {receipt && <Modal title={receipt.data?.temporaryPassword || receipt.data?.temporarySlips ? 'One-time handover - shown once' : receipt.data?.simulatedCode ? 'Simulated OTP - no external send' : 'Document ready'} onClose={() => setReceipt(undefined)}><p>{receipt.message}</p><Value value={receipt.data}/>{receipt.data?.downloadUrl && <a className="button primary" href={String(receipt.data.downloadUrl)} target="_blank" rel="noreferrer">Open sample PDF<Icon name="file" size={17}/></a>}<p className="micro">One-time credentials and OTP values are not retained in the operation history after you close this dialog.</p></Modal>}
    {bell && <Modal title="Notifications" onClose={() => setBell(false)}>{snapshot.notifications.length ? snapshot.notifications.map(n => <a className="notification-row" href={`#journey/${n.href}`} onClick={() => setBell(false)} key={n.id}><Icon name="bell"/><span>{n.text}</span><Pill>{n.critical ? 'Priority' : 'Waiting'}</Pill></a>) : <Empty/>}<div className="notice">Lock-screen preview: “A new update is waiting. Unlock to view.” No patient or doctor names are shown while locked.</div></Modal>}
  </div>;
}
type FormPropsSubmit = PageProps['submit'];
function DemoControls({ actor, refresh, resetLocal }: { actor: Actor; refresh: () => Promise<void>; resetLocal: () => void }) {
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [minutes, setMinutes] = useState(15); const [confirm, setConfirm] = useState('');
  const admin = hasRole(actor, ['superadmin', 'manager']);
  async function run(url: string, body: unknown) { setError(''); setMessage(''); try { const result = await api<Data>(url, { method: 'POST', body }); setMessage(text(result, 'message', 'Simulation setting saved.')); await refresh(); } catch (e) { setError((e as Error).message); } }
  return <><Heading eyebrow="TRAINING / SIMULATION" title="Test the difficult moments.">Use explicit faults to test failures, lost replies, conflicts and recovery. No provider receives real requests.</Heading><ErrorBox message={error}/>{message && <div className="notice">{message}</div>}
    <div className="demo-grid"><section className="panel padded"><h2>Local network & retries</h2><p>Save offline, reload the browser and reconnect. A lost reply retries the same operation ID; conflicts need a reviewed decision.</p><a className="button primary" href="#sync">Open sync & recovery<Icon name="arrow" size={17}/></a></section>
    <section className="panel padded"><h2>Provider boundary</h2><p>SMS, WhatsApp, payments, ETHER, video and ABDM are simulated. No live adapters or real credentials are configured.</p>{admin ? <div className="button-row"><button className="button secondary" onClick={() => void run('/api/demo/fault', { provider: 'Failure' })}>Simulate shared outage</button><button className="button primary" onClick={() => void run('/api/demo/fault', { provider: 'Success' })}>Restore simulated provider</button></div> : <p className="micro">Shared provider controls belong to demo operations / super admin.</p>}</section>
    {admin && <section className="panel padded"><h2>Advance the shared demo clock</h2><p>Exercises overdue critical calls, referral escalation, session expiry, reactivation and the 22:00 presence reset. This affects every tester; you may need to sign in again.</p><label className="field">Minutes forward<input type="number" value={minutes} min="0" max="44640" onChange={e => setMinutes(Number(e.target.value))}/></label><button className="button secondary" onClick={() => void run('/api/demo/clock', { minutes })}>Advance demo clock</button></section>}
    {actor.role === 'superadmin' && <section className="panel padded danger-panel"><h2>Reset shared sample records</h2><p>Resets the synthetic SQLite records and signs out all testers. Prior audit stays. Browser drafts are not silently erased, so review or discard old queued actions deliberately.</p><label className="field">Type RESET SHARED SYNTHETIC DATA<input value={confirm} onChange={e => setConfirm(e.target.value)}/></label><button className="button danger" disabled={confirm !== 'RESET SHARED SYNTHETIC DATA'} onClick={async () => { try { await api('/api/demo/reset', { method: 'POST', body: { confirm } }); resetLocal(); } catch (e) { setError((e as Error).message); } }}>Reset shared synthetic data</button></section>}
    </div><aside className="notice"><strong>Demo assumptions, not hospital approval</strong><p>Staff-owned synthetic billing reconciles AD08/SD06. Admin AJ22 manages staff identities for this demo. Clinical signing, regulatory compliance, ETHER migration, provider contracts and production policy remain open. Web pages cannot block OS screenshots, enforce native device encryption or remotely erase personal files.</p></aside>
  </>;
}
function ContractPage() {
  const [query, setQuery] = useState(''); const [error, setError] = useState(''); const [contract, setContract] = useState<Data>();
  useEffect(() => { api<Data>('/api/contracts').then(setContract).catch(e => setError(e.message)); }, []);
  return <><Heading eyebrow="DEVELOPER / TRACEABILITY" title="Every action has a contract.">OpenAPI 3.1 plus a journey-to-UI/API map. Rendering a route is not proof of behavioral coverage; executed evidence is saved in test-artifacts.</Heading><ErrorBox message={error}/><div className="button-row"><a className="button primary" href="/api/contracts" target="_blank" rel="noreferrer">Open full OpenAPI JSON</a><a className="button secondary" href="/api/traceability" target="_blank" rel="noreferrer">Open machine-readable journey map</a></div>
    <div className="notice"><strong>87 journey definitions · {commands.length} validated commands</strong><p>All commands require a named role session. Requests bind actor, device, operation ID and expected version. Accepted is not recipient acknowledged or completed. Money is integer paise in records; user-entered INR is converted at the API boundary.</p></div><div className="search-field"><Icon name="search"/><input placeholder="Find journey, endpoint or action..." value={query} onChange={e => setQuery(e.target.value)}/></div>
    <div className="contract-list">{journeys.filter(j => `${j.id} ${j.title}`.toLowerCase().includes(query.toLowerCase()) || commands.some(c => c.journeys.includes(j.id) && c.name.includes(query))).map(j => <details className="record-details" key={j.id}><summary><code>{j.id}</code><strong>{j.title}</strong><span>{commands.filter(c => c.journeys.includes(j.id)).length} commands</span></summary><p>{j.description}</p><code>UI: /#journey/{j.id}</code>{commands.filter(c => c.journeys.includes(j.id)).map(c => <div className="contract-command" key={c.name}><code>POST /api/commands/{c.name}</code><p>{c.help}</p><small>Roles: {c.roles.join(', ')}{c.from ? ` · From: ${c.from.join(', ')}` : ''}</small></div>)}{j.boundary && <p className="warning-text">{j.boundary}</p>}</details>)}</div>
    {!contract && !error && <p>Loading contract...</p>}
  </>;
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><LanguageProvider><App/></LanguageProvider></ErrorBoundary>);
