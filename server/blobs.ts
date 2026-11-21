import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { blobLimits } from '../shared/mobile-contract.js';
import type { Store } from './store.js';
import { fail } from './api-error.js';

export const mediaTypes = { png: 'image/png', pdf: 'application/pdf', ink: 'application/vnd.samford.ink+json' } as const;
export type MediaType = typeof mediaTypes[keyof typeof mediaTypes];
export type BlobInfo = { sha256: string; mediaType: MediaType; size: number; width: number | null; height: number | null; createdAt: string; createdBy: string };
export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function inspectPng(bytes: Buffer): { width: number; height: number } {
  const invalid = (reason: string): never => fail(422, 'BLOB_INVALID', `This is not a valid PNG page image (${reason}).`);
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(pngSignature)) invalid('signature');
  let offset = 8; let width = 0; let height = 0; let image = false; let end = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > bytes.length) invalid('truncated chunk');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) invalid(`${type} checksum`);
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) invalid('missing header');
      width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
      const depth = bytes[24]; const color = bytes[25];
      const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowed[color]?.includes(depth)) invalid('colour format');
    }
    if (type === 'IDAT') image = true;
    offset += 12 + length;
    if (type === 'IEND') { end = true; break; }
  }
  if (!image || !end || offset !== bytes.length) invalid('missing image data or end marker');
  if (width < blobLimits.minSide || height < blobLimits.minSide || width > blobLimits.maxSide || height > blobLimits.maxSide) {
    fail(422, 'BLOB_INVALID', `Page images must be ${blobLimits.minSide}-${blobLimits.maxSide} pixels on each side.`);
  }
  return { width, height };
}
export async function inspectPdf(bytes: Buffer) {
  const head = bytes.subarray(0, 8).toString('latin1');
  if (!/^%PDF-[12]\.\d/.test(head) || !bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1').includes('%%EOF')) fail(422, 'BLOB_INVALID', 'This is not a valid PDF (header or end marker missing).');
  let pages = 0;
  try { pages = (await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false })).getPageCount(); }
  catch { fail(422, 'BLOB_INVALID', 'The PDF could not be read. Encrypted or damaged PDFs are not accepted.'); }
  if (pages < 1) fail(422, 'BLOB_INVALID', 'The PDF has no pages.');
}
export function inspectInk(bytes: Buffer) {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(422, 'BLOB_INVALID', 'The ink file is not valid UTF-8 JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(422, 'BLOB_INVALID', 'The ink file must be a JSON object.');
}
export function blobInfo(store: Store, sha256: string): BlobInfo | undefined {
  const row = store.db.prepare('SELECT sha256, media_type, size, width, height, created_at, created_by FROM blobs WHERE sha256=?').get(sha256);
  if (!row) return undefined;
  return { sha256: String(row.sha256), mediaType: String(row.media_type) as MediaType, size: Number(row.size), width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height), createdAt: String(row.created_at), createdBy: String(row.created_by) };
}
export function blobBytes(store: Store, sha256: string): Buffer | undefined {
  const row = store.db.prepare('SELECT bytes FROM blobs WHERE sha256=?').get(sha256);
  return row ? Buffer.from(row.bytes as Uint8Array) : undefined;
}
// Validates before storage; identical bytes are stored once regardless of uploader.
export async function storeBlob(store: Store, sha256: string, mediaType: string, bytes: Buffer, actorId: string): Promise<{ info: BlobInfo; created: boolean }> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(400, 'BAD_REQUEST', 'The blob path must be a lowercase hexadecimal SHA-256.');
  if (!Object.values(mediaTypes).includes(mediaType as MediaType)) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use image/png, application/pdf or application/vnd.samford.ink+json.');
  const limit = mediaType === mediaTypes.png ? blobLimits.png : mediaType === mediaTypes.pdf ? blobLimits.pdf : blobLimits.ink;
  if (bytes.length > limit) fail(413, 'PAYLOAD_TOO_LARGE', `This ${mediaType} is larger than ${Math.round(limit / 1048576)} MiB.`);
  if (bytes.length === 0) fail(422, 'BLOB_INVALID', 'The blob is empty.');
  if (sha256Hex(bytes) !== sha256) fail(422, 'HASH_MISMATCH', 'The uploaded bytes do not match the SHA-256 in the path. Recompute the hash and upload again.');
  const existing = blobInfo(store, sha256);
  if (existing) {
    if (existing.mediaType !== mediaType) fail(422, 'BLOB_TYPE_MISMATCH', `These bytes are already stored as ${existing.mediaType}.`);
    return { info: existing, created: false };
  }
  let dimensions: { width: number; height: number } | undefined;
  if (mediaType === mediaTypes.png) dimensions = inspectPng(bytes);
  else if (mediaType === mediaTypes.pdf) await inspectPdf(bytes);
  else inspectInk(bytes);
  const createdAt = store.now();
  store.db.prepare('INSERT OR IGNORE INTO blobs(sha256, media_type, size, width, height, created_at, created_by, bytes) VALUES(?,?,?,?,?,?,?,?)')
    .run(sha256, mediaType, bytes.length, dimensions?.width ?? null, dimensions?.height ?? null, createdAt, actorId, bytes);
  return { info: blobInfo(store, sha256)!, created: true };
}
export function storeTrustedBlob(store: Store, mediaType: MediaType, bytes: Buffer, actorId: string, dimensions?: { width: number; height: number }) {
  const sha256 = sha256Hex(bytes);
  store.db.prepare('INSERT OR IGNORE INTO blobs(sha256, media_type, size, width, height, created_at, created_by, bytes) VALUES(?,?,?,?,?,?,?,?)')
    .run(sha256, mediaType, bytes.length, dimensions?.width ?? null, dimensions?.height ?? null, store.now(), actorId, bytes);
  return sha256;
}
const secrets = new WeakMap<Store, Buffer>();
function secret(store: Store): Buffer {
  const cached = secrets.get(store);
  if (cached) return cached;
  let value = store.setting<string>('signingSecret', '');
  if (!/^[0-9a-f]{64}$/.test(value)) { value = randomBytes(32).toString('hex'); store.set('signingSecret', value); }
  const key = Buffer.from(value, 'hex');
  secrets.set(store, key);
  return key;
}
// Call after the settings table is cleared so a new secret is generated and persisted.
export function forgetSecret(store: Store) { secrets.delete(store); }
export const signedUrlSeconds = 900;
export function signBlob(store: Store, sha256: string): { exp: number; sig: string } {
  // Expiry is quantized so URLs stay stable briefly, which helps image caches.
  const now = Math.floor(Date.parse(store.now()) / 1000);
  const exp = Math.ceil((now + signedUrlSeconds) / 60) * 60;
  return { exp, sig: createHmac('sha256', secret(store)).update(`${sha256}.${exp}`).digest('hex').slice(0, 40) };
}
export function verifySignature(store: Store, sha256: string, exp: number, sig: string): boolean {
  if (!Number.isInteger(exp) || !/^[0-9a-f]{40}$/.test(sig) || exp * 1000 < Date.parse(store.now())) return false;
  const expected = Buffer.from(createHmac('sha256', secret(store)).update(`${sha256}.${exp}`).digest('hex').slice(0, 40));
  return timingSafeEqual(expected, Buffer.from(sig));
}
// Encrypts replayable responses that contain tokens or demo OTP codes.
export function sealText(store: Store, value: string): string {
  const key = createHash('sha256').update(secret(store)).update('idempotency').digest();
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function openText(store: Store, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64'); const key = createHash('sha256').update(secret(store)).update('idempotency').digest();
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
