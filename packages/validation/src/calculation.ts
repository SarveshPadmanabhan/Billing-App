import { Decimal } from 'decimal.js';
import {
  toDecimal,
  money,
  addMoney,
  subtractMoney,
  percentOf,
  MONEY_SCALE,
  MONEY_ROUNDING,
  MoneyError,
} from './money.js';

/**
 * Authoritative document calculation engine (TICKET-017 and TICKET-025).
 *
 * Shared by quotations and invoices: the arithmetic is identical, so a single
 * implementation prevents the two documents from ever disagreeing — which
 * matters because a quotation converts into an invoice and the totals must
 * carry across unchanged.
 *
 * This is the ONLY place document totals are computed. The API recomputes from
 * line items on every write and ignores any total the client sends
 * (Security Doc §16, §41 rule 2).
 *
 * ---------------------------------------------------------------------------
 * Order of operations (fixed, documented, and tested):
 *
 *   per line:
 *     gross        = quantity × unitPrice
 *     lineDiscount = gross × discountRate%        (or an explicit amount)
 *     net          = gross − lineDiscount
 *     lineTax      = net × taxRate%
 *     lineTotal    = net + lineTax
 *
 *   document:
 *     subtotal        = Σ line net          (after line discounts, before tax)
 *     docDiscount     = subtotal × docDiscountRate%  (or an explicit amount)
 *     taxableBase     = subtotal − docDiscount
 *     taxAmount       = Σ line tax, each apportioned by the document discount
 *     totalAmount     = taxableBase + taxAmount
 *
 * Why tax is apportioned rather than recomputed on the discounted base: lines
 * may carry different tax rates, so a single blended rate cannot be recovered
 * from the document total. Each line's tax is scaled by the same ratio the
 * document discount applies to the subtotal, which keeps per-line tax
 * attributable — a requirement for GST/VAT reporting later.
 *
 * Rounding: each computed field is rounded once, at 4 dp, ROUND_HALF_UP.
 * Intermediate values stay at full decimal.js precision so error cannot
 * accumulate across many lines.
 * ---------------------------------------------------------------------------
 */

export interface LineItemInput {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  /** Percentage 0–100. Mutually exclusive with discountAmount. */
  discountRate?: string | number | null;
  /** Absolute amount. Mutually exclusive with discountRate. */
  discountAmount?: string | number | null;
  /** Percentage 0–100. */
  taxRate?: string | number | null;
  unit?: string | null;
}

export interface DocumentDiscountInput {
  /** Percentage 0–100. Mutually exclusive with amount. */
  rate?: string | number | null;
  /** Absolute amount. Mutually exclusive with rate. */
  amount?: string | number | null;
}

export interface CalculatedLineItem {
  position: number;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  discountRate: string;
  discountAmount: string;
  taxRate: string;
  taxAmount: string;
  /** Net + tax for this line, before any document-level discount. */
  lineTotal: string;
}

export interface CalculatedDocument {
  items: CalculatedLineItem[];
  /** Sum of line nets — after line discounts, before tax. */
  subtotal: string;
  /** Document-level discount only. Line discounts are already in subtotal. */
  discountAmount: string;
  /** Sum of apportioned line taxes. */
  taxAmount: string;
  /** taxableBase + taxAmount. */
  totalAmount: string;
}

export class CalculationError extends MoneyError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'CalculationError';
    this.field = field;
  }
}

const HUNDRED = new Decimal(100);
const MAX_LINE_ITEMS = 500;

function round(value: Decimal): Decimal {
  return value.toDecimalPlaces(MONEY_SCALE, MONEY_ROUNDING);
}

/**
 * Validate and normalise one line item.
 * Rejects the abuse cases in Security Doc §34: negative quantity, negative
 * price, discount over 100%, discount exceeding the line, negative tax.
 */
function calculateLine(item: LineItemInput, index: number): {
  calculated: CalculatedLineItem;
  net: Decimal;
  tax: Decimal;
} {
  const where = `items[${index}]`;

  if (!item.description || item.description.trim().length === 0) {
    throw new CalculationError(`${where}.description`, 'Description is required');
  }

  const quantity = toDecimal(item.quantity, `${where}.quantity`);
  if (quantity.lessThanOrEqualTo(0)) {
    throw new CalculationError(`${where}.quantity`, 'Quantity must be greater than zero');
  }

  const unitPrice = toDecimal(item.unitPrice, `${where}.unitPrice`);
  if (unitPrice.isNegative()) {
    throw new CalculationError(`${where}.unitPrice`, 'Unit price must not be negative');
  }

  const gross = quantity.times(unitPrice);

  // --- line discount ---
  if (
    item.discountRate !== undefined && item.discountRate !== null &&
    item.discountAmount !== undefined && item.discountAmount !== null
  ) {
    throw new CalculationError(
      `${where}.discount`,
      'Provide either a discount rate or a discount amount, not both',
    );
  }

  let discountRate = new Decimal(0);
  let lineDiscount = new Decimal(0);

  if (item.discountRate !== undefined && item.discountRate !== null) {
    discountRate = toDecimal(item.discountRate, `${where}.discountRate`);
    if (discountRate.isNegative() || discountRate.greaterThan(HUNDRED)) {
      throw new CalculationError(`${where}.discountRate`, 'Discount rate must be between 0 and 100');
    }
    lineDiscount = round(gross.times(discountRate).dividedBy(HUNDRED));
  } else if (item.discountAmount !== undefined && item.discountAmount !== null) {
    lineDiscount = toDecimal(item.discountAmount, `${where}.discountAmount`);
    if (lineDiscount.isNegative()) {
      throw new CalculationError(`${where}.discountAmount`, 'Discount must not be negative');
    }
    if (lineDiscount.greaterThan(gross)) {
      throw new CalculationError(
        `${where}.discountAmount`,
        'Discount must not exceed the line amount',
      );
    }
    lineDiscount = round(lineDiscount);
    // Record the equivalent rate for display; gross can be 0 when price is 0.
    discountRate = gross.isZero() ? new Decimal(0) : lineDiscount.dividedBy(gross).times(HUNDRED);
  }

  const net = round(gross.minus(lineDiscount));
  if (net.isNegative()) {
    throw new CalculationError(`${where}.discount`, 'Discount must not exceed the line amount');
  }

  // --- line tax ---
  let taxRate = new Decimal(0);
  if (item.taxRate !== undefined && item.taxRate !== null) {
    taxRate = toDecimal(item.taxRate, `${where}.taxRate`);
    if (taxRate.isNegative() || taxRate.greaterThan(HUNDRED)) {
      throw new CalculationError(`${where}.taxRate`, 'Tax rate must be between 0 and 100');
    }
  }
  const tax = round(net.times(taxRate).dividedBy(HUNDRED));

  return {
    calculated: {
      position: index + 1,
      description: item.description.trim(),
      quantity: quantity.toFixed(MONEY_SCALE),
      unit: item.unit?.trim() || null,
      unitPrice: unitPrice.toFixed(MONEY_SCALE),
      discountRate: round(discountRate).toFixed(MONEY_SCALE),
      discountAmount: lineDiscount.toFixed(MONEY_SCALE),
      taxRate: taxRate.toFixed(MONEY_SCALE),
      taxAmount: tax.toFixed(MONEY_SCALE),
      lineTotal: round(net.plus(tax)).toFixed(MONEY_SCALE),
    },
    net,
    tax,
  };
}

/**
 * Compute a full document from its line items.
 *
 * @throws CalculationError with a `field` path suitable for field-level
 *         validation errors in the API response.
 */
export function calculateDocument(
  items: readonly LineItemInput[],
  documentDiscount?: DocumentDiscountInput | null,
): CalculatedDocument {
  if (!Array.isArray(items) || items.length === 0) {
    throw new CalculationError('items', 'At least one line item is required');
  }
  if (items.length > MAX_LINE_ITEMS) {
    throw new CalculationError('items', `A document may contain at most ${MAX_LINE_ITEMS} items`);
  }

  const lines = items.map((item, index) => calculateLine(item, index));

  const subtotal = round(lines.reduce((sum, l) => sum.plus(l.net), new Decimal(0)));

  // --- document-level discount ---
  if (
    documentDiscount?.rate !== undefined && documentDiscount?.rate !== null &&
    documentDiscount?.amount !== undefined && documentDiscount?.amount !== null
  ) {
    throw new CalculationError(
      'discount',
      'Provide either a discount rate or a discount amount, not both',
    );
  }

  let docDiscount = new Decimal(0);

  if (documentDiscount?.rate !== undefined && documentDiscount?.rate !== null) {
    const rate = toDecimal(documentDiscount.rate, 'discount.rate');
    if (rate.isNegative() || rate.greaterThan(HUNDRED)) {
      throw new CalculationError('discount.rate', 'Discount rate must be between 0 and 100');
    }
    docDiscount = round(subtotal.times(rate).dividedBy(HUNDRED));
  } else if (documentDiscount?.amount !== undefined && documentDiscount?.amount !== null) {
    docDiscount = toDecimal(documentDiscount.amount, 'discount.amount');
    if (docDiscount.isNegative()) {
      throw new CalculationError('discount.amount', 'Discount must not be negative');
    }
    if (docDiscount.greaterThan(subtotal)) {
      throw new CalculationError('discount.amount', 'Discount must not exceed the subtotal');
    }
    docDiscount = round(docDiscount);
  }

  const taxableBase = round(subtotal.minus(docDiscount));

  /**
   * Apportion each line's tax by the document discount.
   *
   * ratio = taxableBase / subtotal. With no document discount the ratio is 1
   * and line taxes pass through unchanged. A zero subtotal (all lines free)
   * yields zero tax rather than a division by zero.
   */
  const ratio = subtotal.isZero() ? new Decimal(0) : taxableBase.dividedBy(subtotal);

  const items_ = lines.map((line) => line.calculated);
  let taxAmount = new Decimal(0);

  if (docDiscount.isZero()) {
    taxAmount = round(lines.reduce((sum, l) => sum.plus(l.tax), new Decimal(0)));
  } else {
    // Scale each line's tax, then round once per line so the per-line figures
    // stored on the document still sum exactly to the document tax.
    lines.forEach((line, index) => {
      const scaled = round(line.tax.times(ratio));
      taxAmount = taxAmount.plus(scaled);
      items_[index]!.taxAmount = scaled.toFixed(MONEY_SCALE);
      const scaledNet = round(line.net.times(ratio));
      items_[index]!.lineTotal = round(scaledNet.plus(scaled)).toFixed(MONEY_SCALE);
    });
    taxAmount = round(taxAmount);
  }

  const totalAmount = round(taxableBase.plus(taxAmount));

  if (totalAmount.isNegative()) {
    throw new CalculationError('total', 'Document total must not be negative');
  }

  return {
    items: items_,
    subtotal: subtotal.toFixed(MONEY_SCALE),
    discountAmount: docDiscount.toFixed(MONEY_SCALE),
    taxAmount: taxAmount.toFixed(MONEY_SCALE),
    totalAmount: totalAmount.toFixed(MONEY_SCALE),
  };
}

/**
 * Recompute a document's balance after payments (TICKET-034).
 *
 * `amountDue` is stored, not derived on read, so the dashboard, reports, and
 * invoice view cannot disagree. This function is the single definition of that
 * value; nothing else may compute it.
 */
export function calculateBalance(
  totalAmount: string,
  allocatedPayments: readonly string[],
): { amountPaid: string; amountDue: string; isFullyPaid: boolean; isOverpaid: boolean } {
  const total = toDecimal(totalAmount, 'totalAmount');
  const paid = allocatedPayments.reduce(
    (sum, amount) => sum.plus(toDecimal(amount, 'payment')),
    new Decimal(0),
  );

  const amountPaid = round(paid);
  const amountDue = round(total.minus(amountPaid));

  return {
    amountPaid: amountPaid.toFixed(MONEY_SCALE),
    // Balance never goes negative in storage; overpayment is rejected upstream,
    // and this clamp is a second guard (Security Doc §30).
    amountDue: amountDue.isNegative() ? money(0) : amountDue.toFixed(MONEY_SCALE),
    isFullyPaid: amountDue.lessThanOrEqualTo(0) && total.greaterThan(0),
    isOverpaid: amountDue.isNegative(),
  };
}
