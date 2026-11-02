import type { ApiError, CommandRequest, Data, Receipt, Snapshot } from '../shared/model.js';
export type Pending = {
  id: string; actorId: string; name: string; label: string; request: CommandRequest;
  status: 'Queued' | 'In flight' | 'Retryable' | 'Conflict' | 'Rejected' | 'Accepted' | 'Discarded';
  attempts: number; error?: ApiError; receipt?: Receipt; anchorId?: string;
};
export type Vault = { snapshot?: Snapshot; snapshotReceivedAt?: number; pending: Pending[]; drafts: Record<string, Data>; offline: boolean };
type CipherRecord = { id: string; iv: Uint8Array; data: ArrayBuffer };
const empty = (): Vault => ({ pending: [], drafts: {}, offline: false });
let opened: Promise<IDBDatabase> | undefined;
function database() {
  return opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('samford-synthetic-vault', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('vaults', { keyPath: 'id' }); request.result.createObjectStore('keys'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser storage is unavailable. Nothing was marked saved. Allow storage or use another browser.'));
  });
}
async function get<T>(table: string, id: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readonly'); const request = tx.objectStore(table).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(new Error('Could not read the encrypted browser store. Your data was not reset.'));
  });
}
async function keyFor(id: string): Promise<CryptoKey> {
  const existing = await get<CryptoKey>('keys', id);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(key, id);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('Could not persist the browser encryption key. No work was saved.'));
  });
  return key;
}
export async function readVault(id: string): Promise<Vault> {
  const record = await get<CipherRecord>('vaults', id);
  if (!record) return empty();
  const key = await keyFor(id);
  try {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv) }, key, record.data);
    const vault = JSON.parse(new TextDecoder().decode(bytes)) as Vault;
    for (const item of vault.pending) if (item.status === 'In flight') item.status = 'Retryable';
    return vault;
  } catch {
    throw new Error('The saved browser data could not be decrypted. It was not deleted or replaced. Keep this browser profile and contact support.');
  }
}
export async function persistVault(id: string, vault: Vault) {
  const key = await keyFor(id); const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(vault)));
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('vaults', 'readwrite'); tx.objectStore('vaults').put({ id, iv, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('Browser storage could not save this work (possibly full). Keep the form open; no successful save was reported.'));
    tx.onabort = () => reject(new Error('Browser save was interrupted. Keep the form open and try again.'));
  });
}
export async function clearVault(id: string) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['vaults', 'keys'], 'readwrite'); tx.objectStore('vaults').delete(id); tx.objectStore('keys').delete(id);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('Browser cleanup failed. The cache was not reported wiped.'));
  });
}
export class HttpError extends Error {
  constructor(public status: number, public detail: ApiError) { super(detail.message); }
}
export async function api<T>(url: string, options: { method?: string; body?: unknown; activity?: boolean } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: options.method ?? 'GET', credentials: 'same-origin',
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json', 'X-Samford-Request': '1' } : {}), ...(options.activity ? { 'X-User-Action': '1' } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
  } catch { throw new HttpError(0, { code: 'OFFLINE', message: 'No network response. Your saved local work is safe; reconnect to send.', retryable: true }); }
  const result = await response.json();
  if (!response.ok) throw new HttpError(response.status, result);
  return result as T;
}
export function browserId() {
  const key = 'samford-browser-id'; let id = localStorage.getItem(key);
  if (!id) { id = `web-${crypto.randomUUID()}`; localStorage.setItem(key, id); }
  return id;
}
export function pendingCount(vault: Vault) { return vault.pending.filter(e => !['Accepted', 'Discarded'].includes(e.status)).length; }
