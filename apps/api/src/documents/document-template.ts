/**
 * Shared HTML template for quotation and invoice PDFs
 * (TICKET-020 and TICKET-029).
 *
 * One template for both document types: the layout, tax presentation and
 * totals block are identical, and a single implementation keeps a converted
 * quotation and its invoice visually consistent.
 *
 * Tax presentation: each line shows its post-discount taxable value alongside
 * its tax rate and tax amount, so the document supports per-line tax
 * reporting (GST/VAT). This matters because the calculation engine apportions
 * document-level discounts across lines — without the taxable column, the
 * per-line tax figures would appear unexplained.
 *
 * All values arrive pre-formatted as strings. This module performs no
 * arithmetic whatsoever; doing any here would risk contradicting the stored
 * figures, which are authoritative.
 */

export interface TemplateLineItem {
  position: number;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  discountAmount: string;
  /** Post-discount, pre-tax value. The base each line's tax was computed on. */
  taxableValue: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
}

export interface TemplateData {
  kind: 'INVOICE' | 'QUOTATION';
  documentNumber: string;
  status: string;

  organisation: {
    name: string;
    legalName: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    addressLines: string[];
    taxNumber: string | null;
    logoDataUri: string | null;
  };

  customer: {
    name: string;
    email: string | null;
    phone: string | null;
    addressLines: string[];
    taxNumber: string | null;
  };

  dates: {
    issueLabel: string;
    issueDate: string;
    /** "Valid until" for quotations, "Due date" for invoices. */
    secondaryLabel: string | null;
    secondaryDate: string | null;
  };

  currency: string;
  items: TemplateLineItem[];

  totals: {
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    totalAmount: string;
    /** Invoices only. */
    amountPaid?: string;
    amountDue?: string;
  };

  notes: string | null;
  terms: string | null;
  generatedAt: string;
}

/** Escape untrusted text before interpolation (customer names, notes, …). */
function esc(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Group the integer part for readability. Display only — no rounding. */
function formatMoney(amount: string, currency: string): string {
  const [whole = '0', fraction = '0000'] = amount.split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const grouped = Number(digits).toLocaleString('en-IN');
  return `${currency} ${negative ? '-' : ''}${grouped}.${fraction.slice(0, 2)}`;
}

/** Trim trailing zeros from a quantity: 2.5000 -> 2.5, 3.0000 -> 3. */
function formatQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

const STATUS_COLOURS: Record<string, { bg: string; fg: string }> = {
  DRAFT: { bg: '#F1F5F9', fg: '#475569' },
  SENT: { bg: '#EFF6FF', fg: '#2563EB' },
  ACCEPTED: { bg: '#F0FDF4', fg: '#16A34A' },
  PAID: { bg: '#F0FDF4', fg: '#16A34A' },
  PARTIALLY_PAID: { bg: '#EFF6FF', fg: '#2563EB' },
  OVERDUE: { bg: '#FEF2F2', fg: '#DC2626' },
  REJECTED: { bg: '#FEF2F2', fg: '#DC2626' },
  EXPIRED: { bg: '#FFFBEB', fg: '#D97706' },
  CONVERTED: { bg: '#F0FDF4', fg: '#16A34A' },
  CANCELLED: { bg: '#F1F5F9', fg: '#475569' },
};

export function renderDocumentHtml(data: TemplateData): string {
  const title = data.kind === 'INVOICE' ? 'Invoice' : 'Quotation';
  const statusColour = STATUS_COLOURS[data.status] ?? STATUS_COLOURS.DRAFT!;
  const money = (v: string) => formatMoney(v, data.currency);

  const itemRows = data.items
    .map(
      (item) => `
      <tr>
        <td class="num">${item.position}</td>
        <td>${esc(item.description)}</td>
        <td class="right">${formatQuantity(item.quantity)}${item.unit ? ` ${esc(item.unit)}` : ''}</td>
        <td class="right">${money(item.unitPrice)}</td>
        <td class="right">${Number(item.discountAmount) > 0 ? money(item.discountAmount) : '—'}</td>
        <td class="right">${money(item.taxableValue)}</td>
        <td class="right">${formatQuantity(item.taxRate)}%</td>
        <td class="right">${money(item.taxAmount)}</td>
        <td class="right strong">${money(item.lineTotal)}</td>
      </tr>`,
    )
    .join('');

  const paymentRows =
    data.kind === 'INVOICE' && data.totals.amountPaid !== undefined
      ? `
      <tr>
        <td>Amount paid</td>
        <td class="right">${money(data.totals.amountPaid)}</td>
      </tr>
      <tr class="grand">
        <td>Amount due</td>
        <td class="right">${money(data.totals.amountDue ?? '0.0000')}</td>
      </tr>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} ${esc(data.documentNumber)}</title>
<style>
  /* Print geometry. A4 with a margin wide enough that nothing is clipped by
     a physical printer's non-printable edge. */
  @page { size: A4; margin: 14mm 12mm; }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 10pt;
    line-height: 1.45;
    color: #0F172A;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .logo { max-height: 56px; max-width: 180px; object-fit: contain; }
  .org-name { font-size: 15pt; font-weight: 700; margin: 0 0 2px; }
  .muted { color: #64748B; }
  .small { font-size: 9pt; }

  .doc-title { font-size: 22pt; font-weight: 700; margin: 0; text-align: right; }
  .doc-number { font-size: 11pt; color: #475569; text-align: right; margin-top: 2px; }
  .status {
    display: inline-block; margin-top: 6px; padding: 3px 10px; border-radius: 999px;
    font-size: 8.5pt; font-weight: 600; letter-spacing: 0.02em;
    background: ${statusColour.bg}; color: ${statusColour.fg};
  }

  .parties { display: flex; gap: 24px; margin-top: 22px; }
  .party { flex: 1; }
  .party h2 {
    font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em;
    color: #64748B; margin: 0 0 6px; font-weight: 600;
  }
  .party .name { font-weight: 600; }

  .meta { margin-top: 18px; border-top: 1px solid #E2E8F0; border-bottom: 1px solid #E2E8F0; padding: 10px 0; display: flex; gap: 32px; }
  .meta div span { display: block; }
  .meta .label { font-size: 8.5pt; color: #64748B; }

  table.items { width: 100%; border-collapse: collapse; margin-top: 18px; }
  table.items thead th {
    background: #F8FAFC; border-bottom: 1.5px solid #CBD5E1;
    padding: 7px 6px; font-size: 8.5pt; text-transform: uppercase;
    letter-spacing: 0.04em; color: #475569; text-align: left; font-weight: 600;
  }
  table.items tbody td { padding: 7px 6px; border-bottom: 1px solid #E2E8F0; vertical-align: top; }
  /* Financial columns are right-aligned with tabular figures so digits line up. */
  .right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .num { color: #94A3B8; width: 22px; }
  .strong { font-weight: 600; }

  /* Repeat the header when a long item list spills onto another page, and
     avoid splitting a row across the break. */
  table.items thead { display: table-header-group; }
  table.items tr { page-break-inside: avoid; }

  .totals-wrap { display: flex; justify-content: flex-end; margin-top: 14px; page-break-inside: avoid; }
  table.totals { min-width: 260px; border-collapse: collapse; }
  table.totals td { padding: 5px 6px; }
  table.totals tr.grand td {
    border-top: 1.5px solid #CBD5E1; font-size: 12pt; font-weight: 700; padding-top: 8px;
  }

  .notes { margin-top: 24px; page-break-inside: avoid; }
  .notes h2 {
    font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em;
    color: #64748B; margin: 0 0 4px; font-weight: 600;
  }
  .notes p { margin: 0 0 12px; white-space: pre-wrap; }

  .footer {
    margin-top: 26px; padding-top: 10px; border-top: 1px solid #E2E8F0;
    font-size: 8pt; color: #94A3B8; display: flex; justify-content: space-between;
  }
</style>
</head>
<body>
  <div class="header">
    <div>
      ${data.organisation.logoDataUri ? `<img class="logo" src="${data.organisation.logoDataUri}" alt="">` : ''}
      <p class="org-name">${esc(data.organisation.legalName ?? data.organisation.name)}</p>
      <div class="muted small">
        ${data.organisation.addressLines.map((line) => `<div>${esc(line)}</div>`).join('')}
        ${data.organisation.email ? `<div>${esc(data.organisation.email)}</div>` : ''}
        ${data.organisation.phone ? `<div>${esc(data.organisation.phone)}</div>` : ''}
        ${data.organisation.taxNumber ? `<div>Tax No: ${esc(data.organisation.taxNumber)}</div>` : ''}
      </div>
    </div>
    <div>
      <h1 class="doc-title">${title}</h1>
      <div class="doc-number">${esc(data.documentNumber)}</div>
      <div style="text-align:right"><span class="status">${esc(data.status.replace(/_/g, ' '))}</span></div>
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <h2>${data.kind === 'INVOICE' ? 'Bill to' : 'Quotation for'}</h2>
      <div class="name">${esc(data.customer.name)}</div>
      <div class="muted small">
        ${data.customer.addressLines.map((line) => `<div>${esc(line)}</div>`).join('')}
        ${data.customer.email ? `<div>${esc(data.customer.email)}</div>` : ''}
        ${data.customer.phone ? `<div>${esc(data.customer.phone)}</div>` : ''}
        ${data.customer.taxNumber ? `<div>Tax No: ${esc(data.customer.taxNumber)}</div>` : ''}
      </div>
    </div>
  </div>

  <div class="meta">
    <div>
      <span class="label">${esc(data.dates.issueLabel)}</span>
      <span>${esc(data.dates.issueDate)}</span>
    </div>
    ${
      data.dates.secondaryLabel && data.dates.secondaryDate
        ? `<div>
             <span class="label">${esc(data.dates.secondaryLabel)}</span>
             <span>${esc(data.dates.secondaryDate)}</span>
           </div>`
        : ''
    }
    <div>
      <span class="label">Currency</span>
      <span>${esc(data.currency)}</span>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th>#</th>
        <th>Description</th>
        <th class="right">Qty</th>
        <th class="right">Rate</th>
        <th class="right">Discount</th>
        <!-- Post-discount base each line's tax was computed on. Required for
             per-line GST/VAT reporting. -->
        <th class="right">Taxable</th>
        <th class="right">Tax %</th>
        <th class="right">Tax</th>
        <th class="right">Total</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals">
      <tr>
        <td>Subtotal</td>
        <td class="right">${money(data.totals.subtotal)}</td>
      </tr>
      ${
        Number(data.totals.discountAmount) > 0
          ? `<tr><td>Discount</td><td class="right">-${money(data.totals.discountAmount)}</td></tr>`
          : ''
      }
      <tr>
        <td>Tax</td>
        <td class="right">${money(data.totals.taxAmount)}</td>
      </tr>
      <tr class="grand">
        <td>Total</td>
        <td class="right">${money(data.totals.totalAmount)}</td>
      </tr>
      ${paymentRows}
    </table>
  </div>

  ${
    data.notes || data.terms
      ? `<div class="notes">
           ${data.notes ? `<h2>Notes</h2><p>${esc(data.notes)}</p>` : ''}
           ${data.terms ? `<h2>Terms</h2><p>${esc(data.terms)}</p>` : ''}
         </div>`
      : ''
  }

  <div class="footer">
    <span>${esc(data.organisation.name)}${data.organisation.website ? ` · ${esc(data.organisation.website)}` : ''}</span>
    <span>${esc(data.documentNumber)} · Generated ${esc(data.generatedAt)}</span>
  </div>
</body>
</html>`;
}
