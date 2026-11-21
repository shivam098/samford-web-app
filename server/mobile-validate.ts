import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { mobileOpenApi } from '../shared/mobile-contract.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(mobileOpenApi as object, 'contract');
const validators = new Map<string, ValidateFunction>();

export function contractSchema(name: string): ValidateFunction {
  let validator = validators.get(name);
  if (!validator) {
    validator = ajv.getSchema(`contract#/components/schemas/${name}`);
    if (!validator) throw new Error(`Unknown contract schema ${name}`);
    validators.set(name, validator);
  }
  return validator;
}
export function contractErrors(name: string, value: unknown): { path: string; message: string }[] {
  const validator = contractSchema(name);
  if (validator(value)) return [];
  return (validator.errors ?? []).slice(0, 20).map(error => ({ path: error.instancePath || '/', message: error.message ?? 'is invalid' }));
}
