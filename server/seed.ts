import { credential } from './auth.js';
import { Store } from './store.js';
import { type Actor, type Data, type Entity, type Role, istDate, doctorRoles } from '../shared/model.js';

export function seed(store: Store) {
  if (store.setting('seedVersion', 0)) return;
  store.transact(() => {
    const now = store.now();
    const day = istDate(now);
    const future = (days: number) => istDate(new Date(new Date(now).getTime() + days * 86400000).toISOString());
    const add = (id: string, type: string, data: Data, status = 'Active', extra: Partial<Entity> = {}) =>
      store.create(type, data, 'System', { id, status, ...extra });
    add('general', 'department', { name: 'General medicine', shortName: 'GEN', referrals: true, duty: true });
    add('surgery', 'department', { name: 'Surgery', shortName: 'SUR', referrals: true, duty: true });
    add('dental', 'department', { name: 'Dental', shortName: 'DEN', referrals: true, duty: true });
    const person = (id: string, name: string, role: Role, department = 'general', verifier = false, patientIds: string[] = []) => {
      const actor: Actor = { id, name, role, department, state: 'Active', login: id, staffId: `SAMPLE-${id.toUpperCase()}`,
        mobile: role === 'patient' ? '9000000001' : `900001${String(store.people().length + 1).padStart(4, '0')}`,
        patientIds, verifier, profileConfirmed: true, temporary: false, counter: ['pharmacist'].includes(role) ? 'Pharmacy' : 'OPD 1', appVersion: 1,
        preferences: { theme: 'Light', language: 'English', textSize: '100%', printLanguage: 'English', rows: 5, homeOrder: 'visits,referrals,results,admissions,pending', sort: 'Token' } };
      store.savePerson(actor, credential());
      add(id, 'account', { name, role, departmentId: department, staffId: actor.staffId, registration: doctorRoles.includes(role) ? `SAMPLE-REG-${id}` : '', qualification: 'Sample qualification', room: department === 'surgery' ? 'Room 2' : 'Room 1', phone: actor.mobile, email: `${id}@sample.invalid` }, 'Active', { department });
      if (doctorRoles.includes(role)) add(`presence-${id}`, 'presence', { name, status: 'Offline', reportedAt: now, systemReset: '' }, 'Offline', { doctorId: id, department });
    };
    person('doctor-a', 'Demo doctor A', 'doctor');
    person('doctor-b', 'Demo doctor B', 'doctor', 'surgery');
    person('resident', 'Demo resident', 'resident');
    const resident = store.person('resident'); resident.preferences.coverDoctor = 'doctor-a'; store.savePerson(resident);
    person('super', 'Demo super admin', 'superadmin');
    person('super-two', 'Demo second super admin', 'superadmin');
    person('admin', 'Demo hospital admin', 'admin');
    person('head', 'Demo department head', 'head');
    person('it', 'Demo IT support', 'it');
    person('auditor', 'Demo auditor', 'auditor');
    for (const [id, name, role] of [
      ['desk', 'Demo front desk', 'desk'], ['cashier', 'Demo cashier', 'cashier'], ['pharmacy', 'Demo pharmacist', 'pharmacist'],
      ['store', 'Demo store keeper', 'store'], ['nurse', 'Demo ward nurse', 'nurse'], ['lab', 'Demo lab entry', 'lab'],
      ['ot', 'Demo OT coordinator', 'ot'], ['mrd', 'Demo records coder', 'mrd'], ['services', 'Demo support services', 'services'],
      ['services-two', 'Demo second support', 'services'], ['manager', 'Demo operations manager', 'manager'], ['manager-two', 'Demo second manager', 'manager']
    ] as [string, string, Role][]) person(id, name, role);
    person('verifier', 'Demo lab verifier', 'lab', 'general', true);
    person('family', 'Demo family portal', 'patient', 'general', false, ['patient-a', 'patient-child']);
    person('other-family', 'Demo unrelated family', 'patient', 'general', false, ['patient-c']);
    const other = store.person('other-family'); other.mobile = '9000000003'; store.savePerson(other);
    for (const [id, name, age, sex, mobile, payer] of [
      ['patient-a', 'Demo patient A', 36, 'Female', '9000000001', 'Self'],
      ['patient-b', 'Demo patient B', 58, 'Male', '9000000002', 'Ayushman'],
      ['patient-c', 'Demo patient C', 45, 'Female', '9000000003', 'Self'],
      ['patient-child', 'Demo child A', 4, 'Male', '9000000001', 'Self']
    ] as [string, string, number, string, string, string][]) {
      add(id, 'patient', { name, age, sex, mobile, payer, address: 'Sample district', category: 'General', uhid: `SMP-${id.toUpperCase()}`, aadhaarLast4: '1234', allergyVersion: 1, mlc: false, unknown: false });
    }
    add('allergy-a', 'allergy', { name: 'Penicillin allergy', substance: 'Penicillin', reaction: 'Sample rash', certainty: 'Confirmed' }, 'Active', { patientId: 'patient-a', doctorId: 'doctor-a' });
    for (let offset = 0; offset < 15; offset++) {
      const date = future(offset);
      for (const id of ['doctor-a', 'doctor-b']) add(`session-${id}-${date}`, 'session', { name: `${id} ${date}`, doctorId: id, date, start: '08:00', end: '20:00', slotMinutes: 10, room: id === 'doctor-a' ? 'Room 1' : 'Room 2' }, 'Published', { doctorId: id, department: id === 'doctor-a' ? 'general' : 'surgery' });
    }
    const visit = (id: string, p: string, doc: string, time: string, token: number, status: string, mode = 'Walk-in') => {
      add(id, 'visit', { number: `OPD-${id.toUpperCase()}`, name: `${id} - ${time}`, date: day, time, token, mode, opdType: 'General', visitType: 'New', room: doc === 'doctor-a' ? 'Room 1' : 'Room 2', priority: false, checkinAt: status === 'Waiting' ? now : '', moves: [] }, status, { patientId: p, doctorId: doc, department: doc === 'doctor-a' ? 'general' : 'surgery' });
    };
    visit('visit-a', 'patient-a', 'doctor-a', '09:00', 1, 'Waiting');
    visit('visit-b', 'patient-b', 'doctor-a', '09:10', 2, 'Waiting');
    visit('visit-c', 'patient-c', 'doctor-b', '09:00', 1, 'Waiting');
    visit('visit-video', 'patient-child', 'doctor-a', '11:00', 3, 'Booked', 'Video');
    const item = (id: string, name: string, salt: string, strength: string, mrp: number, extra: Data = {}) =>
      add(id, 'item', { name, salt, strength, form: 'Tablet', mrp, gst: 12, hsn: 'SAMPLE-3004', reorder: 20, schedule: 'Normal', coldChain: false, ...extra });
    item('medicine-a', 'Sample Paracetamol 500', 'Paracetamol', '500 mg', 560);
    item('medicine-b', 'Sample Amoxicillin 500', 'Penicillin', '500 mg', 1000);
    item('medicine-alt', 'Sample Paracetamol alternative', 'Paracetamol', '500 mg', 560);
    item('medicine-retired', 'Retired sample medicine', 'Sample', '10 mg', 100);
    store.update(store.get('medicine-retired'), 'System', {}, 'Retired');
    add('batch-a', 'batch', { name: 'PARA-01 pharmacy', itemId: 'medicine-a', batch: 'PARA-01', expiry: future(400), quantity: 300, store: 'Pharmacy', mrp: 560 }, 'Available');
    add('batch-b', 'batch', { name: 'AMOX-01 pharmacy', itemId: 'medicine-b', batch: 'AMOX-01', expiry: future(360), quantity: 100, store: 'Pharmacy', mrp: 1000 }, 'Available');
    add('batch-alt', 'batch', { name: 'PARA-ALT pharmacy', itemId: 'medicine-alt', batch: 'PARA-ALT', expiry: future(400), quantity: 100, store: 'Pharmacy', mrp: 560 }, 'Available');
    add('batch-expired', 'batch', { name: 'Expired sample - blocked', itemId: 'medicine-a', batch: 'PARA-OLD', expiry: future(-1), quantity: 10, store: 'Pharmacy', mrp: 560 }, 'Expired');
    add('batch-central', 'batch', { name: 'PARA-C central store', itemId: 'medicine-a', batch: 'PARA-C', expiry: future(400), quantity: 500, store: 'Central', mrp: 560 }, 'Available');
    for (const [id, name, code, price, container] of [
      ['cbc', 'Complete blood count', '57021-8', 35000, 'Purple EDTA'],
      ['potassium', 'Potassium', '2823-3', 25000, 'Yellow serum'],
      ['thyroid', 'Thyroid profile', '24348-5', 51000, 'Yellow serum'],
      ['xray', 'Chest X-ray', '30746-2', 45000, 'Imaging']
    ]) {
      add(String(id), 'test', { name: String(name), loinc: String(code), price: Number(price), container: String(container), unit: id === 'potassium' ? 'mmol/L' : 'sample unit', fasting: id === 'thyroid' ? 'As advised' : 'Not required' });
      add(`tariff-${id}`, 'tariff', { name: String(name), code: String(id), rate: Number(price), payer: 'Self', effective: '2020-01-01', nightExtra: 0, emergencyExtra: 0 }, 'Active');
    }
    add('retired-test', 'test', { name: 'Retired sample test', loinc: 'SAMPLE-RETIRED', price: 10000, container: 'Sample' }, 'Retired');
    const executiveExtras = ['glucose', 'lipids', 'creatinine', 'liver-panel', 'urinalysis', 'ecg', 'calcium', 'vision'];
    for (const [index, id] of executiveExtras.entries()) {
      add(id, 'test', { name: `Sample ${id.replaceAll('-', ' ')}`, loinc: `SAMPLE-${index + 1}`, price: 20000, container: ['ecg', 'vision'].includes(id) ? 'Procedure' : 'Sample container', unit: 'sample unit', fasting: 'Per sample instructions' });
      add(`tariff-${id}`, 'tariff', { name: `Sample ${id}`, code: id, rate: 20000, payer: 'Self', effective: '2020-01-01', nightExtra: 0, emergencyExtra: 0 });
    }
    add('tariff-consultation', 'tariff', { name: 'Consultation', code: 'consultation', rate: 50000, payer: 'Self', effective: '2020-01-01', nightExtra: 0, emergencyExtra: 0 });
    add('tariff-transport', 'tariff', { name: 'Transport per km', code: 'transport', rate: 2500, payer: 'Self', effective: '2020-01-01', nightExtra: 0, emergencyExtra: 0 });
    add('tariff-operation', 'tariff', { name: 'Sample operation', code: 'operation', rate: 500000, payer: 'Self', effective: '2020-01-01', nightExtra: 0, emergencyExtra: 0 });
    for (const [id, name, category, rate] of [
      ['bed-1', 'Ward 3 Bed 12', 'General', 200000], ['bed-2', 'Ward 3 Bed 16', 'General', 200000], ['bed-3', 'Private 1', 'Private', 400000],
      ['icu-1', 'ICU 1', 'ICU', 700000], ['icu-2', 'ICU 2', 'ICU', 700000], ['day-bed', 'Day-care chair 1', 'Day care', 50000]
    ]) add(String(id), 'bed', { name: String(name), ward: category === 'General' ? 'Ward 3' : String(category), category: String(category), dailyRate: Number(rate) }, 'Free');
    add('bed-cleaning', 'bed', { name: 'Ward 3 Bed 18 (cleaning)', ward: 'Ward 3', category: 'General', dailyRate: 200000 }, 'Cleaning');
    add('vendor-1', 'vendor', { name: 'Sample supplies', gstin: 'SAMPLE-GST', licence: 'SAMPLE-LICENCE', contact: 'Local demo only', terms: '30 days' });
    add('asset-1', 'asset', { name: 'Sample monitor', number: 'ASSET-001', location: 'OT 1', warranty: future(365), serviceDue: future(20), history: [] }, 'Available');
    add('vehicle-1', 'vehicle', { name: 'Sample advanced ambulance', kind: 'Advanced ambulance', serviceDue: future(60) }, 'Free');
    add('vehicle-2', 'vehicle', { name: 'Sample basic ambulance', kind: 'Basic ambulance', serviceDue: future(60) }, 'Free');
    add('vehicle-overdue', 'vehicle', { name: 'Service overdue vehicle', kind: 'Car', serviceDue: future(-1) }, 'Free');
    add('cabinet-1', 'cabinet', { name: 'Cabinet 1' }, 'Free');
    add('cabinet-2', 'cabinet', { name: 'Cabinet 2' }, 'Free');
    add('package-basic', 'package', { name: 'Basic sample package', tests: ['cbc', 'thyroid'], price: 75000 });
    add('package-executive', 'package', { name: 'Executive sample package', tests: ['cbc', 'thyroid', 'potassium', 'xray', ...executiveExtras], price: 240000 });
    add('board-1', 'board', { name: 'Waiting area', doctorId: '', view: 'OPD status', enabled: true }, 'Active');
    add('article-start', 'article', { title: 'Your first synthetic visit', content: 'Open Patients. Call a token and confirm the patient. Save a note, approve a prescription and send tests. Switch to pharmacy or lab to complete the handoff. Only synthetic data may be entered.', journey: 'DJ06', readBy: [], helpful: [] }, 'Published');
    add('template-opd', 'template', { name: 'General OPD', kind: 'OPD', content: 'Presenting concern:\nExamination:\nAssessment:\nPlan:', reviewer: 'Demo clinical reviewer' }, 'Published', { department: 'general' });
    add('letterhead', 'letterhead', { name: 'Samford - Synthetic workflow lab', address: 'Sample campus, Ranchi', phone: 'SAMPLE-NUMBER', footer: 'SAMPLE ONLY - not for clinical use', version: 1 }, 'Published');
    for (const dep of ['general', 'surgery', 'dental']) for (const feature of ['Video', 'Dictation', 'WhatsApp', 'Ocular', 'Dental', 'Obstetric']) {
      add(`feature-${dep}-${feature}`, 'feature', { feature, state: ['Ocular', 'Dental', 'Obstetric'].includes(feature) && dep !== 'dental' ? 'Off' : 'On', pilotDoctors: '' }, 'Active', { department: dep });
    }
    for (const name of ['Appointment reminders', 'Expiry alerts', 'Day-end reminders', 'Daily MIS']) add(`job-${name.toLowerCase().replaceAll(' ', '-')}`, 'job', { name, schedule: 'Daily (demo scheduler)', lastRun: '', nextRun: future(1), result: 'Not run' }, 'Enabled');
    for (const name of ['ETHER', 'Messaging', 'Payment', 'ABDM', 'Video']) add(`integration-${name}`, 'integration', { name, simulated: true, nextAction: name === 'ETHER' ? 'Call the ETHER vendor; no live adapter is configured.' : 'Inspect simulated attempts or ask hospital IT.', checkedAt: now }, 'Simulated healthy');
    store.set('policy', { minPassword: 10, history: 5, temporaryHours: 24, attempts: 5, doctorIdle: 5, portalIdle: 15 });
    store.set('rules', { discount: 10, purchase: 50000, cashDifference: 100 });
    store.set('faults', { next: 'None', provider: 'Success' });
    store.set('lastPresenceDate', future(-1));
    store.set('seedVersion', 1);
    store.audit('System', 'system', 'demo.seed', 'synthetic', null, { version: 1 });
  });
}
