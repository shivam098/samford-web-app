import { num, type Data } from './model.js';
export const payerNames = ['Self', 'Ayushman', 'CGHS', 'TPA', 'Corporate'];
export const coveredChargeTypes = ['Bed', 'Consultation', 'Pharmacy', 'Laboratory', 'Procedure'];
export const cashDenominations = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
export function denominationTotal(counts: Data) { return cashDenominations.reduce((total, denomination) => total + denomination * num(counts, String(denomination)), 0); }
