import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Store, DomainError } from './store.js';
import { applicationVersion } from '../shared/version.js';
import { mobileApiVersion } from '../shared/mobile-contract.js';
import { num, type Data } from '../shared/model.js';

export type MobileOptions = { relaxedLimits?: boolean; testSupport?: boolean };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Data, public retryable = status >= 500 || status === 429) { super(message); }
}
export function minimumVersions(store: Store) {
  const value = store.setting<Data>('mobileMinVersions', {});
  return { doctor: num(value, 'doctor', 1), patient: num(value, 'patient', 1) };
}
export function mobileRouter(store: Store, _options: MobileOptions): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.set({ 'X-Request-Id': requestId, 'X-Samford-Api-Version': mobileApiVersion });
    next();
    void req;
  });
  router.get('/meta', (_req, res) => {
    const minimum = minimumVersions(store);
    res.json({ apiVersion: mobileApiVersion, serverVersion: applicationVersion, synthetic: true, minDoctorAppVersion: minimum.doctor, minPatientAppVersion: minimum.patient,
      serverTime: store.now(), docsUrl: 'https://github.com/shivam098/samford-web-app/blob/main/docs/mobile-sync.md' });
  });
  router.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'This mobile API route does not exist. Check the contract version.')));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, error));
  return router;
}
export function sendError(res: Response, error: unknown) {
  const requestId = String(res.locals.requestId ?? randomUUID());
  let status = 500; let code = 'INTERNAL_ERROR'; let message = 'The mock backend could not complete this request. Retry later; keep unsent work on the device.';
  let details: Data | undefined; let retryable = true;
  if (error instanceof ApiError) ({ status, code, message, details, retryable } = error);
  else if (error instanceof DomainError) { status = error.status; code = error.code === 'VALIDATION_FAILED' ? 'VALIDATION_FAILED' : error.code; message = error.message; retryable = status >= 500 || status === 429; }
  else {
    const bodyError = error as { status?: number; type?: string };
    if (bodyError.status === 413) { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'This request is larger than the allowed limit.'; retryable = false; }
    else if (bodyError.status === 400) { status = 400; code = 'BAD_REQUEST'; message = 'The request body is not valid JSON.'; retryable = false; }
    else console.error(`Mobile request failure ${requestId}: ${error instanceof Error ? error.name : 'Unknown error'}`);
  }
  if (res.headersSent) return;
  if (status === 429 && details?.retryAfterSeconds) res.set('Retry-After', String(details.retryAfterSeconds));
  res.status(status).json({ error: { code, message, retryable, ...(details ? { details } : {}), requestId } });
}
