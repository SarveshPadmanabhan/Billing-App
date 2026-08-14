import { describe, it, expect } from 'vitest';
import { calculateDocument, calculateBalance, CalculationError } from './calculation.js';

/**
 * TICKET-017 / TICKET-025 acceptance: authoritative calculations, deterministic
 * rounding, rejection of invalid input.
 *
 * Edge cases drawn from Security & Access Document §28–§31 and §34.
 */

describe('calculateDocument — basics', () => {
  it('computes a single line with no discount or tax', () => {
    const result = calculateDocument([{ description: 'Consulting', quantity: 10, unitPrice: 100 }]);

    expect(result.subtotal).toBe('1000.0000');
    expect(result.discountAmount).toBe('0.0000');
    expect(result.taxAmount).toBe('0.0000');
    expect(result.totalAmount).toBe('1000.0000');
    expect(result.items[0]!.lineTotal).toBe('1000.0000');
  });

  it('applies tax per line', () => {
    const result = calculateDocument([
      { description: 'Item', quantity: 1, unitPrice: '100', taxRate: '18' },
    ]);

    expect(result.subtotal).toBe('100.0000');
    expect(result.taxAmount).toBe('18.0000');
    expect(result.totalAmount).toBe('118.0000');
  });

  it('applies a percentage line discount before tax', () => {
    const result = calculateDocument([
      { description: 'Item', quantity: 1, unitPrice: '100', discountRate: '10', taxRate: '18' },
    ]);

    // 100 − 10 = 90 net; tax 18% of 90 = 16.20; total 106.20
    expect(result.items[0]!.discountAmount).toBe('10.0000');
    expect(result.subtotal).toBe('90.0000');
    expect(result.taxAmount).toBe('16.2000');
    expect(result.totalAmount).toBe('106.2000');
  });

  it('applies an absolute line discount', () => {
    const result = calculateDocument([
      { description: 'Item', quantity: 2, unitPrice: '50', discountAmount: '15' },
    ]);

    expect(result.subtotal).toBe('85.0000');
    expect(result.totalAmount).toBe('85.0000');
  });

  it('sums multiple lines with different tax rates', () => {
    const result = calculateDocument([
      { description: 'A', quantity: 2, unitPrice: '100', taxRate: '18' }, // 200 + 36
      { description: 'B', quantity: 1, unitPrice: '50', taxRate: '5' }, //  50 + 2.50
      { description: 'C', quantity: 3, unitPrice: '10', taxRate: '0' }, //  30 + 0
    ]);

    expect(result.subtotal).toBe('280.0000');
    expect(result.taxAmount).toBe('38.5000');
    expect(result.totalAmount).toBe('318.5000');
  });

  it('assigns sequential positions', () => {
    const result = calculateDocument([
      { description: 'A', quantity: 1, unitPrice: '1' },
      { description: 'B', quantity: 1, unitPrice: '1' },
      { description: 'C', quantity: 1, unitPrice: '1' },
    ]);
    expect(result.items.map((i) => i.position)).toEqual([1, 2, 3]);
  });
});

describe('calculateDocument — document-level discount', () => {
  it('applies a percentage discount to the subtotal', () => {
    const result = calculateDocument(
      [{ description: 'Item', quantity: 1, unitPrice: '1000' }],
      { rate: '10' },
    );

    expect(result.subtotal).toBe('1000.0000');
    expect(result.discountAmount).toBe('100.0000');
    expect(result.totalAmount).toBe('900.0000');
  });

  it('apportions tax when a document discount applies', () => {
    // Subtotal 1000, 10% doc discount -> taxable 900. Tax was 180 (18%),
    // apportioned by 0.9 -> 162. Total 900 + 162 = 1062.
    const result = calculateDocument(
      [{ description: 'Item', quantity: 1, unitPrice: '1000', taxRate: '18' }],
      { rate: '10' },
    );

    expect(result.discountAmount).toBe('100.0000');
    expect(result.taxAmount).toBe('162.0000');
    expect(result.totalAmount).toBe('1062.0000');
  });

  it('keeps per-line tax summing exactly to the document tax', () => {
    const result = calculateDocument(
      [
        { description: 'A', quantity: 1, unitPrice: '333.33', taxRate: '18' },
        { description: 'B', quantity: 1, unitPrice: '333.33', taxRate: '18' },
        { description: 'C', quantity: 1, unitPrice: '333.34', taxRate: '18' },
      ],
      { rate: '7.5' },
    );

    const lineTaxSum = result.items.reduce((sum, i) => sum + Number(i.taxAmount), 0);
    expect(lineTaxSum.toFixed(4)).toBe(Number(result.taxAmount).toFixed(4));
  });

  it('applies an absolute document discount', () => {
    const result = calculateDocument(
      [{ description: 'Item', quantity: 1, unitPrice: '500' }],
      { amount: '50' },
    );
    expect(result.totalAmount).toBe('450.0000');
  });
});

describe('calculateDocument — rejects invalid input (Security Doc §34)', () => {
  it('rejects an empty document', () => {
    expect(() => calculateDocument([])).toThrow(CalculationError);
  });

  it('rejects zero and negative quantities', () => {
    expect(() => calculateDocument([{ description: 'X', quantity: 0, unitPrice: '10' }])).toThrow(
      /Quantity must be greater than zero/,
    );
    expect(() => calculateDocument([{ description: 'X', quantity: -1, unitPrice: '10' }])).toThrow(
      /Quantity must be greater than zero/,
    );
  });

  it('rejects a negative unit price', () => {
    expect(() => calculateDocument([{ description: 'X', quantity: 1, unitPrice: '-10' }])).toThrow(
      /must not be negative/,
    );
  });

  it('rejects a discount over 100%', () => {
    expect(() =>
      calculateDocument([{ description: 'X', quantity: 1, unitPrice: '10', discountRate: '101' }]),
    ).toThrow(/between 0 and 100/);
  });

  it('rejects a line discount exceeding the line amount', () => {
    expect(() =>
      calculateDocument([{ description: 'X', quantity: 1, unitPrice: '10', discountAmount: '11' }]),
    ).toThrow(/must not exceed the line amount/);
  });

  it('rejects a document discount exceeding the subtotal', () => {
    expect(() =>
      calculateDocument([{ description: 'X', quantity: 1, unitPrice: '100' }], { amount: '101' }),
    ).toThrow(/must not exceed the subtotal/);
  });

  it('rejects a negative tax rate and one above 100', () => {
    expect(() =>
      calculateDocument([{ description: 'X', quantity: 1, unitPrice: '10', taxRate: '-5' }]),
    ).toThrow(/between 0 and 100/);
    expect(() =>
      calculateDocument([{ description: 'X', quantity: 1, unitPrice: '10', taxRate: '101' }]),
    ).toThrow(/between 0 and 100/);
  });

  it('rejects both a discount rate and amount on one line', () => {
    expect(() =>
      calculateDocument([
        { description: 'X', quantity: 1, unitPrice: '10', discountRate: '5', discountAmount: '1' },
      ]),
    ).toThrow(/not both/);
  });

  it('rejects a blank description', () => {
    expect(() => calculateDocument([{ description: '   ', quantity: 1, unitPrice: '10' }])).toThrow(
      /Description is required/,
    );
  });

  it('reports the offending field path', () => {
    try {
      calculateDocument([
        { description: 'ok', quantity: 1, unitPrice: '1' },
        { description: 'bad', quantity: -1, unitPrice: '1' },
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CalculationError);
      expect((error as CalculationError).field).toBe('items[1].quantity');
    }
  });

  it('caps the number of line items', () => {
    const many = Array.from({ length: 501 }, () => ({
      description: 'X',
      quantity: 1,
      unitPrice: '1',
    }));
    expect(() => calculateDocument(many)).toThrow(/at most 500/);
  });
});

describe('calculateDocument — rounding and precision (Security Doc §31)', () => {
  it('handles 100% tax', () => {
    const result = calculateDocument([
      { description: 'X', quantity: 1, unitPrice: '100', taxRate: '100' },
    ]);
    expect(result.totalAmount).toBe('200.0000');
  });

  it('handles a 100% line discount', () => {
    const result = calculateDocument([
      { description: 'Free', quantity: 1, unitPrice: '100', discountRate: '100', taxRate: '18' },
    ]);
    expect(result.subtotal).toBe('0.0000');
    expect(result.taxAmount).toBe('0.0000');
    expect(result.totalAmount).toBe('0.0000');
  });

  it('handles the smallest representable amounts', () => {
    const result = calculateDocument([{ description: 'X', quantity: 1, unitPrice: '0.01' }]);
    expect(result.totalAmount).toBe('0.0100');
  });

  it('handles decimal quantities', () => {
    // 2.5 hours at 99.99
    const result = calculateDocument([
      { description: 'Hours', quantity: '2.5', unitPrice: '99.99' },
    ]);
    expect(result.subtotal).toBe('249.9750');
  });

  it('avoids float drift across many lines', () => {
    const items = Array.from({ length: 100 }, () => ({
      description: 'Cent',
      quantity: 1,
      unitPrice: '0.01',
    }));
    const result = calculateDocument(items);
    expect(result.subtotal).toBe('1.0000');
  });

  it('rounds tax half-up deterministically', () => {
    // 0.125 × 18% = 0.0225 -> 0.0225 exactly at 4dp
    const result = calculateDocument([
      { description: 'X', quantity: 1, unitPrice: '0.125', taxRate: '18' },
    ]);
    expect(result.taxAmount).toBe('0.0225');
  });

  it('is deterministic across repeated runs', () => {
    const input = [
      { description: 'A', quantity: '3.7', unitPrice: '19.99', discountRate: '7.5', taxRate: '18' },
      { description: 'B', quantity: '1', unitPrice: '0.03', taxRate: '5' },
    ];
    const first = calculateDocument(input, { rate: '2.5' });
    for (let i = 0; i < 20; i += 1) {
      expect(calculateDocument(input, { rate: '2.5' })).toEqual(first);
    }
  });

  it('handles large values within NUMERIC(19,4)', () => {
    const result = calculateDocument([
      { description: 'Big', quantity: 1, unitPrice: '999999999999.9999' },
    ]);
    expect(result.totalAmount).toBe('999999999999.9999');
  });

  it('rejects values beyond NUMERIC(19,4)', () => {
    expect(() =>
      calculateDocument([{ description: 'X', quantity: 1, unitPrice: '9999999999999999' }]),
    ).toThrow();
  });
});

describe('calculateBalance (TICKET-034)', () => {
  it('reports a full balance when nothing is paid', () => {
    const b = calculateBalance('1000.0000', []);
    expect(b.amountPaid).toBe('0.0000');
    expect(b.amountDue).toBe('1000.0000');
    expect(b.isFullyPaid).toBe(false);
  });

  it('handles a partial payment', () => {
    const b = calculateBalance('1000.0000', ['400.0000']);
    expect(b.amountPaid).toBe('400.0000');
    expect(b.amountDue).toBe('600.0000');
    expect(b.isFullyPaid).toBe(false);
  });

  it('handles multiple payments summing to the total', () => {
    const b = calculateBalance('1000.0000', ['400.0000', '350.0000', '250.0000']);
    expect(b.amountPaid).toBe('1000.0000');
    expect(b.amountDue).toBe('0.0000');
    expect(b.isFullyPaid).toBe(true);
  });

  it('never reports a negative balance', () => {
    const b = calculateBalance('100.0000', ['150.0000']);
    expect(b.amountDue).toBe('0.0000');
    expect(b.isOverpaid).toBe(true);
  });

  it('does not drift across many small payments', () => {
    const payments = Array.from({ length: 300 }, () => '0.01');
    const b = calculateBalance('3.0000', payments);
    expect(b.amountPaid).toBe('3.0000');
    expect(b.amountDue).toBe('0.0000');
    expect(b.isFullyPaid).toBe(true);
  });

  it('treats a zero-total document as not fully paid', () => {
    // A zero invoice is a data problem, not a paid invoice; do not let it
    // silently flip to PAID.
    const b = calculateBalance('0.0000', []);
    expect(b.isFullyPaid).toBe(false);
  });
});
