import QRCode from 'qrcode';

/**
 * UPI payment QR for an invoice.
 *
 * Encodes a `upi://pay` URI as defined by NPCI's deep-link spec. Every UPI app
 * reads the same format, so one QR works across GPay, PhonePe, Paytm and the
 * banks' own apps.
 *
 * The amount is pinned into the URI, so the customer scans and confirms rather
 * than typing a figure — which is where transposed digits come from.
 */

/**
 * A UPI ID is `handle@psp`. This checks shape only.
 *
 * It deliberately does NOT check the handle against a list of known PSPs:
 * banks add handles regularly, and rejecting an unrecognised-but-valid one
 * would block a legitimate payee. A wrong-but-well-formed ID cannot be caught
 * here — only by the payer's app failing to resolve it — which is why the ID
 * is shown as text beside the QR for a human to sanity-check.
 */
export const UPI_ID_PATTERN = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

export function isValidUpiId(value: string): boolean {
  return UPI_ID_PATTERN.test(value.trim());
}

export interface UpiPaymentRequest {
  upiId: string;
  /** Shown in the payer's app as who they are paying. */
  payeeName: string;
  /** Decimal string, exactly as stored. Never a float. */
  amount: string;
  /** Appears as the payment reference, e.g. the invoice number. */
  reference: string;
}

/**
 * Build the `upi://pay` URI.
 *
 * Amount is emitted at two decimal places: the UPI spec expects rupees to
 * paise, and sending the stored 4-decimal figure would be rejected by some
 * apps. The value is truncated rather than rounded up — billing a customer
 * one paisa more than the invoice says would make the QR disagree with the
 * document it is printed on.
 */
export function buildUpiUri({ upiId, payeeName, amount, reference }: UpiPaymentRequest): string {
  const [rupees, fraction = ''] = amount.split('.');
  const paise = `${fraction}00`.slice(0, 2);

  const params = new URLSearchParams({
    pa: upiId.trim(),
    pn: payeeName.trim(),
    am: `${rupees}.${paise}`,
    cu: 'INR',
    tn: reference.trim(),
  });

  // URLSearchParams encodes spaces as "+", which some UPI apps pass through
  // literally into the payee name. %20 is understood everywhere.
  return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * Render the QR as a data URI for embedding in the PDF.
 *
 * A data URI rather than a file: the PDF is rendered by headless Chromium with
 * no network access to our own storage, and an external image URL would
 * silently produce an invoice with a broken payment code.
 *
 * Error correction level M tolerates a printed page being scuffed or folded
 * while keeping the code small enough to stay crisp at 120px.
 */
export async function renderUpiQrDataUri(request: UpiPaymentRequest): Promise<string> {
  return QRCode.toDataURL(buildUpiUri(request), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
    color: { dark: '#0F172A', light: '#FFFFFF' },
  });
}
