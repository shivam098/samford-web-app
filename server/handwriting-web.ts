import type { Express } from 'express';
import { Store, DomainError } from './store.js';
import type { Auth } from './auth.js';
import { visible } from './context.js';
import { versionsOf, deliveriesOf, documentDto } from './handwriting.js';
import { blobInfo, blobBytes, mediaTypes } from './blobs.js';

// Cookie-authenticated web views of handwritten records. Access follows the same visibility rules as the web worklists.
export function handwritingWebRoutes(app: Express, store: Store, auth: Auth) {
  app.get('/api/handwriting/documents/:documentId', (req, res) => {
    const actor = auth.get(req).actor; const documentId = String(req.params.documentId);
    const versions = versionsOf(store, documentId).filter(version => visible(store, actor, version));
    const deliveries = deliveriesOf(store, documentId).filter(delivery => visible(store, actor, delivery));
    if (!versions.length) throw new DomainError(404, 'NOT_FOUND', 'This handwritten document is outside your scope.');
    const farFuture = Math.floor(Date.parse(store.now()) / 1000) + 365 * 86400;
    res.json(documentDto(versions, deliveries, { kind: 'DOCTOR', doctorId: actor.id }, sha256 => ({ url: `/api/handwriting/blobs/${sha256}`, exp: farFuture })));
  });
  app.get('/api/handwriting/blobs/:sha256', (req, res) => {
    const actor = auth.get(req).actor; const sha256 = String(req.params.sha256);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new DomainError(404, 'NOT_FOUND', 'File not found.');
    // Patients use the owner index; staff stop at the first visible referencing record.
    const rows = actor.role === 'patient' && actor.patientIds.length
      ? store.db.prepare(`SELECT document_entity_id FROM blob_refs WHERE sha256=? AND patient_id IN (${actor.patientIds.map(() => '?').join(',')})`).all(sha256, ...actor.patientIds)
      : actor.role === 'patient' ? [] : store.db.prepare('SELECT document_entity_id FROM blob_refs WHERE sha256=?').all(sha256);
    const allowed = rows.some(ref => { const entity = store.maybe(String(ref.document_entity_id)); return Boolean(entity && visible(store, actor, entity)); });
    const info = blobInfo(store, sha256); const bytes = blobBytes(store, sha256);
    if (!allowed || !info || !bytes) throw new DomainError(404, 'NOT_FOUND', 'File not found in your scope.');
    if (String(req.headers['if-none-match'] ?? '') === `"${sha256}"`) { res.set('ETag', `"${sha256}"`).status(304).end(); return; }
    res.set({ 'Content-Type': info.mediaType, 'Content-Length': String(bytes.length), ETag: `"${sha256}"`, 'Cache-Control': 'private, max-age=31536000, immutable',
      ...(info.mediaType === mediaTypes.pdf ? { 'Content-Disposition': `inline; filename="samford-handwritten-${sha256.slice(0, 12)}.pdf"` } : {}) });
    res.end(bytes);
  });
}
