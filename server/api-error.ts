import type { Data } from '../shared/model.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Data, public retryable = status >= 500 || status === 429) { super(message); }
}
export function fail(status: number, code: string, message: string, details?: Data, retryable?: boolean): never {
  throw new ApiError(status, code, message, details, retryable);
}
