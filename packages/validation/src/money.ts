import { Decimal } from 'decimal.js';

/**
 * Money primitives.
 *
 * Rules (Technical Architecture Doc §11, Security Doc §16):
 *   - Storage is NUMERIC(19,4); the application mirrors that with 4 dp.
 *   - All arithmetic goes through decimal.js. Never `+`, `*` on money numbers.
 *   - Money crosses boundaries as a string, never a JS number.
 *
 * Rounding policy: ROUND_HALF_UP at 4 decimal places, applied once per
 * computed field (line total, tax, subtotal, grand total). This is the policy
 * the Security Doc §31 asks us to fix before launch — it is defined here in
 * one place so it cannot drift between modules.
 */

export const MONEY_SCALE = 4;
export const MONEY_ROUNDING = Decimal.ROUND_HALF_UP;

// NUMERIC(19,4) => 15 integer digits + 4 fractional.
const MAX_MONEY = new Decimal('999999999999999.9999');
const MIN_MONEY = new Decimal('-999999999999999.9999');

Decimal.set({ precision: 34, rounding: MONEY_ROUNDING, toExpNeg: -9e15, toExpPos: 9e15 });

export type MoneyInput = string | number | Decimal;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Parse untrusted input into a Decimal.
 *
 * Rejects NaN, Infinity, and out-of-range values rather than letting them
 * reach the database. A `number` input is accepted for ergonomics but is
 * stringified first so an already-lossy float is at least not compounded.
 */
export function toDecimal(value: MoneyInput, field = 'amount'): Decimal {
  let decimal: Decimal;
  try {
    decimal = value instanceof Decimal ? value : new Decimal(String(value).trim());
  } catch {
    throw new MoneyError(`${field} is not a valid number`);
  }
  if (!decimal.isFinite()) {
    throw new MoneyError(`${field} must be a finite number`);
  }
  if (decimal.greaterThan(MAX_MONEY) || decimal.lessThan(MIN_MONEY)) {
    throw new MoneyError(`${field} is outside the supported range`);
  }
  return decimal;
}

/** Round to storage scale and render as a fixed-point string. */
export function money(value: MoneyInput, field = 'amount'): string {
  return toDecimal(value, field).toDecimalPlaces(MONEY_SCALE, MONEY_ROUNDING).toFixed(MONEY_SCALE);
}

export const ZERO_MONEY = money(0);

export function addMoney(...values: MoneyInput[]): string {
  return money(values.reduce<Decimal>((sum, v) => sum.plus(toDecimal(v)), new Decimal(0)));
}

export function subtractMoney(a: MoneyInput, b: MoneyInput): string {
  return money(toDecimal(a).minus(toDecimal(b)));
}

export function multiplyMoney(a: MoneyInput, b: MoneyInput): string {
  return money(toDecimal(a).times(toDecimal(b)));
}

/** Percentage of an amount, e.g. percentOf('100', '18') === '18.0000'. */
export function percentOf(amount: MoneyInput, rate: MoneyInput): string {
  return money(toDecimal(amount).times(toDecimal(rate)).dividedBy(100));
}

export function compareMoney(a: MoneyInput, b: MoneyInput): -1 | 0 | 1 {
  return toDecimal(a).comparedTo(toDecimal(b)) as -1 | 0 | 1;
}

export const isNegative = (v: MoneyInput) => toDecimal(v).isNegative();
export const isZero = (v: MoneyInput) => toDecimal(v).isZero();
export const isPositive = (v: MoneyInput) => toDecimal(v).greaterThan(0);
export const maxMoney = (a: MoneyInput, b: MoneyInput) =>
  compareMoney(a, b) >= 0 ? money(a) : money(b);
