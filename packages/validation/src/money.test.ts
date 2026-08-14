import { describe, it, expect } from 'vitest';
import {
  money,
  addMoney,
  subtractMoney,
  multiplyMoney,
  percentOf,
  compareMoney,
  MoneyError,
  toDecimal,
} from './money.js';

describe('money', () => {
  it('renders at 4 decimal places', () => {
    expect(money('10')).toBe('10.0000');
    expect(money('0.1')).toBe('0.1000');
    expect(money(0)).toBe('0.0000');
  });

  it('avoids binary floating-point drift', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
    expect(addMoney('0.1', '0.2')).toBe('0.3000');
    // 1.005 * 100 === 100.49999999999999 in IEEE-754.
    expect(multiplyMoney('1.005', '100')).toBe('100.5000');
  });

  it('rounds half away from zero at 4 dp', () => {
    expect(money('0.00005')).toBe('0.0001');
    expect(money('0.000049')).toBe('0.0000');
    expect(money('-0.00005')).toBe('-0.0001');
  });

  it('handles the small values called out in Security Doc §31', () => {
    for (const v of ['0.01', '0.10', '0.99']) {
      expect(money(v)).toBe(Number(v).toFixed(4));
    }
  });

  it('computes percentages exactly', () => {
    expect(percentOf('100', '18')).toBe('18.0000');
    expect(percentOf('99.99', '7.5')).toBe('7.4993'); // 7.49925 -> half-up
    expect(percentOf('100', '0')).toBe('0.0000');
    expect(percentOf('100', '100')).toBe('100.0000');
  });

  it('adds a long line-item list without drift', () => {
    const cents = Array.from({ length: 1000 }, () => '0.01');
    expect(addMoney(...cents)).toBe('10.0000');
  });

  it('subtracts and compares', () => {
    expect(subtractMoney('100', '33.33')).toBe('66.6700');
    expect(compareMoney('10.0000', '10')).toBe(0);
    expect(compareMoney('10.0001', '10')).toBe(1);
    expect(compareMoney('9.9999', '10')).toBe(-1);
  });

  it('supports large values within NUMERIC(19,4)', () => {
    expect(money('999999999999999.9999')).toBe('999999999999999.9999');
  });

  it('rejects values beyond NUMERIC(19,4)', () => {
    expect(() => money('1000000000000000')).toThrow(MoneyError);
    expect(() => money('-1000000000000000')).toThrow(MoneyError);
  });

  it('rejects non-finite and malformed input', () => {
    expect(() => money(Number.NaN)).toThrow(MoneyError);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => money('abc')).toThrow(MoneyError);
    expect(() => money('')).toThrow(MoneyError);
  });

  it('names the offending field in the error', () => {
    expect(() => toDecimal('abc', 'unitPrice')).toThrow(/unitPrice/);
  });
});
