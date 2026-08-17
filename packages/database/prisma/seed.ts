/**
 * Development seed (TICKET-002).
 *
 * Creates TWO organisations on purpose. Tenant isolation is the product's most
 * important invariant, so the default dev dataset must make a cross-tenant leak
 * visible immediately rather than requiring a special fixture.
 *
 * Idempotent: safe to re-run. Refuses to run against NODE_ENV=production.
 */
import { PrismaClient } from '@prisma/client';
import { scryptSync, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

const ORG_A_ID = '11111111-1111-1111-1111-111111111111';
const ORG_B_ID = '22222222-2222-2222-2222-222222222222';

// Each organisation's default company. Fixed ids so the seed is idempotent and
// so tests can reference a known company.
const COMPANY_A_ID = 'aaaa1111-1111-1111-1111-111111111111';
const COMPANY_B_ID = 'bbbb2222-2222-2222-2222-222222222222';

/**
 * Better Auth's default password hash format: scrypt, `salt:hash` in hex.
 * Kept in sync with better-auth's own defaults so seeded users can log in
 * through the normal endpoint.
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  return `${salt}:${derived.toString('hex')}`;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database');
  }

  console.log('Seeding development data...\n');

  const password = hashPassword('DevPassword123!');

  // --- Organisation A -------------------------------------------------------
  const owner = await prisma.user.upsert({
    where: { email: 'owner@acme.test' },
    update: {},
    create: {
      email: 'owner@acme.test',
      firstName: 'Ada',
      lastName: 'Owner',
      name: 'Ada Owner',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      accounts: {
        create: { accountId: 'owner@acme.test', providerId: 'credential', password },
      },
    },
  });

  const billingUser = await prisma.user.upsert({
    where: { email: 'billing@acme.test' },
    update: {},
    create: {
      email: 'billing@acme.test',
      firstName: 'Ben',
      lastName: 'Billing',
      name: 'Ben Billing',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      accounts: {
        create: { accountId: 'billing@acme.test', providerId: 'credential', password },
      },
    },
  });

  const viewer = await prisma.user.upsert({
    where: { email: 'viewer@acme.test' },
    update: {},
    create: {
      email: 'viewer@acme.test',
      firstName: 'Vic',
      lastName: 'Viewer',
      name: 'Vic Viewer',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      accounts: {
        create: { accountId: 'viewer@acme.test', providerId: 'credential', password },
      },
    },
  });

  // --- Organisation B (the isolation counterparty) --------------------------
  const rivalOwner = await prisma.user.upsert({
    where: { email: 'owner@globex.test' },
    update: {},
    create: {
      email: 'owner@globex.test',
      firstName: 'Grace',
      lastName: 'Globex',
      name: 'Grace Globex',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      accounts: {
        create: { accountId: 'owner@globex.test', providerId: 'credential', password },
      },
    },
  });

  await seedOrganisation({
    id: ORG_A_ID,
    companyId: COMPANY_A_ID,
    name: 'Acme Consulting',
    legalName: 'Acme Consulting Private Limited',
    email: 'accounts@acme.test',
    taxNumber: '29ABCDE1234F1Z5',
    invoicePrefix: 'INV-',
    quotationPrefix: 'QUO-',
    members: [
      { userId: owner.id, role: 'OWNER' as const },
      { userId: billingUser.id, role: 'BILLING' as const },
      { userId: viewer.id, role: 'VIEWER' as const },
    ],
    customers: [
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', companyName: 'Northwind Traders', email: 'ap@northwind.test' },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', companyName: 'Contoso Ltd', email: 'ap@contoso.test' },
    ],
  });

  await seedOrganisation({
    id: ORG_B_ID,
    companyId: COMPANY_B_ID,
    name: 'Globex Corporation',
    legalName: 'Globex Corporation LLP',
    email: 'accounts@globex.test',
    taxNumber: '27FGHIJ5678K2Z9',
    invoicePrefix: 'GBX-',
    quotationPrefix: 'GBQ-',
    members: [{ userId: rivalOwner.id, role: 'OWNER' as const }],
    customers: [
      { id: 'bbbbbbbb-0000-0000-0000-000000000001', companyName: 'Initech Systems', email: 'ap@initech.test' },
    ],
  });

  // --- Documents ------------------------------------------------------------
  // Realistic quotations and invoices across the lifecycle, so the customer
  // detail page, invoice list and (later) dashboard have something meaningful
  // to render rather than empty states.
  await seedDocuments(ORG_A_ID, COMPANY_A_ID, owner.id);

  console.log('\nSeed complete.\n');
  console.log('  Organisation A — Acme Consulting');
  console.log('    owner@acme.test    OWNER    DevPassword123!');
  console.log('    billing@acme.test  BILLING  DevPassword123!');
  console.log('    viewer@acme.test   VIEWER   DevPassword123!');
  console.log('  Organisation B — Globex Corporation');
  console.log('    owner@globex.test  OWNER    DevPassword123!');
  console.log('\n  Org B exists so cross-tenant leaks show up in normal dev use.');
}

/**
 * Line-item shape for seeding. Amounts are pre-computed here rather than run
 * through the calculation engine: the seed writes directly to the database and
 * these values are checked against the engine's rules in its own tests.
 */
interface SeedItem {
  description: string;
  quantity: string;
  unit?: string;
  unitPrice: string;
  taxRate: string;
}

/** Line totals for a set of items at a single tax rate. */
function computeTotals(items: SeedItem[]) {
  let subtotal = 0;
  let tax = 0;
  const lines = items.map((item, index) => {
    const net = Number(item.quantity) * Number(item.unitPrice);
    const lineTax = (net * Number(item.taxRate)) / 100;
    subtotal += net;
    tax += lineTax;
    return {
      position: index + 1,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit ?? null,
      unitPrice: item.unitPrice,
      discountRate: '0',
      discountAmount: '0',
      taxRate: item.taxRate,
      taxAmount: lineTax.toFixed(4),
      lineTotal: (net + lineTax).toFixed(4),
    };
  });
  return {
    lines,
    subtotal: subtotal.toFixed(4),
    taxAmount: tax.toFixed(4),
    totalAmount: (subtotal + tax).toFixed(4),
  };
}

const daysFromNow = (days: number) => {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + days * 86_400_000);
};

/**
 * Seed quotations, invoices and payments covering the states the UI must
 * render: draft, sent, accepted-and-converted, paid, partially paid, overdue
 * and cancelled.
 */
async function seedDocuments(organisationId: string, companyId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_organisation_id', ${organisationId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;

    // Idempotent: skip if documents already exist for this organisation.
    const existing = await tx.invoice.count({ where: { organisationId } });
    if (existing > 0) {
      console.log('  documents already seeded, skipping');
      return;
    }

    const customers = await tx.customer.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, companyName: true },
    });
    if (customers.length < 2) return;

    const [northwind, contoso] = customers;
    const sequences = { quotation: 0, invoice: 0 };
    const nextNumber = (kind: 'quotation' | 'invoice') => {
      sequences[kind] += 1;
      const prefix = kind === 'invoice' ? 'INV-' : 'QUO-';
      return `${prefix}${String(sequences[kind]).padStart(6, '0')}`;
    };

    // --- Quotations ---------------------------------------------------------
    const draftQuote = computeTotals([
      { description: 'Discovery workshop', quantity: '2', unit: 'days', unitPrice: '40000', taxRate: '18' },
    ]);
    await tx.quotation.create({
      data: {
        organisationId,
        companyId,
        customerId: northwind!.id,
        quotationNumber: nextNumber('quotation'),
        issueDate: daysFromNow(-3),
        validUntil: daysFromNow(27),
        status: 'DRAFT',
        currencyCode: 'INR',
        subtotal: draftQuote.subtotal,
        taxAmount: draftQuote.taxAmount,
        totalAmount: draftQuote.totalAmount,
        notes: 'Scope to be confirmed after the workshop.',
        createdBy: userId,
        items: { create: draftQuote.lines },
      },
    });

    const sentQuote = computeTotals([
      { description: 'Platform integration', quantity: '15', unit: 'days', unitPrice: '35000', taxRate: '18' },
      { description: 'Documentation', quantity: '1', unitPrice: '50000', taxRate: '18' },
    ]);
    await tx.quotation.create({
      data: {
        organisationId,
        companyId,
        customerId: contoso!.id,
        quotationNumber: nextNumber('quotation'),
        issueDate: daysFromNow(-10),
        validUntil: daysFromNow(20),
        status: 'SENT',
        currencyCode: 'INR',
        subtotal: sentQuote.subtotal,
        taxAmount: sentQuote.taxAmount,
        totalAmount: sentQuote.totalAmount,
        sentAt: daysFromNow(-10),
        createdBy: userId,
        items: { create: sentQuote.lines },
      },
    });

    // --- Invoices -----------------------------------------------------------

    // Fully paid.
    const paid = computeTotals([
      { description: 'Monthly retainer — June', quantity: '1', unitPrice: '120000', taxRate: '18' },
    ]);
    const paidInvoice = await tx.invoice.create({
      data: {
        organisationId,
        companyId,
        customerId: northwind!.id,
        invoiceNumber: nextNumber('invoice'),
        issueDate: daysFromNow(-60),
        dueDate: daysFromNow(-30),
        status: 'PAID',
        currencyCode: 'INR',
        subtotal: paid.subtotal,
        taxAmount: paid.taxAmount,
        totalAmount: paid.totalAmount,
        amountPaid: paid.totalAmount,
        amountDue: '0',
        paidAt: daysFromNow(-32),
        sentAt: daysFromNow(-60),
        createdBy: userId,
        items: { create: paid.lines },
      },
    });

    // Partially paid.
    const partial = computeTotals([
      { description: 'Monthly retainer — July', quantity: '1', unitPrice: '120000', taxRate: '18' },
      { description: 'Additional support hours', quantity: '12', unit: 'hrs', unitPrice: '3500', taxRate: '18' },
    ]);
    const partialPaidAmount = 100000;
    const partialInvoice = await tx.invoice.create({
      data: {
        organisationId,
        companyId,
        customerId: northwind!.id,
        invoiceNumber: nextNumber('invoice'),
        issueDate: daysFromNow(-25),
        dueDate: daysFromNow(5),
        status: 'PARTIALLY_PAID',
        currencyCode: 'INR',
        subtotal: partial.subtotal,
        taxAmount: partial.taxAmount,
        totalAmount: partial.totalAmount,
        amountPaid: partialPaidAmount.toFixed(4),
        amountDue: (Number(partial.totalAmount) - partialPaidAmount).toFixed(4),
        sentAt: daysFromNow(-25),
        createdBy: userId,
        items: { create: partial.lines },
      },
    });

    // Overdue — past due date with a balance outstanding.
    const overdue = computeTotals([
      { description: 'Implementation phase 1', quantity: '1', unitPrice: '250000', taxRate: '18' },
    ]);
    await tx.invoice.create({
      data: {
        organisationId,
        companyId,
        customerId: contoso!.id,
        invoiceNumber: nextNumber('invoice'),
        issueDate: daysFromNow(-75),
        dueDate: daysFromNow(-45),
        status: 'OVERDUE',
        currencyCode: 'INR',
        subtotal: overdue.subtotal,
        taxAmount: overdue.taxAmount,
        totalAmount: overdue.totalAmount,
        amountPaid: '0',
        amountDue: overdue.totalAmount,
        sentAt: daysFromNow(-75),
        createdBy: userId,
        items: { create: overdue.lines },
      },
    });

    // Draft.
    const draftInvoice = computeTotals([
      { description: 'Monthly retainer — August', quantity: '1', unitPrice: '120000', taxRate: '18' },
    ]);
    await tx.invoice.create({
      data: {
        organisationId,
        companyId,
        customerId: northwind!.id,
        invoiceNumber: nextNumber('invoice'),
        issueDate: daysFromNow(0),
        dueDate: daysFromNow(30),
        status: 'DRAFT',
        currencyCode: 'INR',
        subtotal: draftInvoice.subtotal,
        taxAmount: draftInvoice.taxAmount,
        totalAmount: draftInvoice.totalAmount,
        amountPaid: '0',
        amountDue: draftInvoice.totalAmount,
        createdBy: userId,
        items: { create: draftInvoice.lines },
      },
    });

    // Cancelled — kept in history, owes nothing.
    const cancelled = computeTotals([
      { description: 'Duplicate billing run', quantity: '1', unitPrice: '15000', taxRate: '18' },
    ]);
    await tx.invoice.create({
      data: {
        organisationId,
        companyId,
        customerId: contoso!.id,
        invoiceNumber: nextNumber('invoice'),
        issueDate: daysFromNow(-20),
        dueDate: daysFromNow(10),
        status: 'CANCELLED',
        currencyCode: 'INR',
        subtotal: cancelled.subtotal,
        taxAmount: cancelled.taxAmount,
        totalAmount: cancelled.totalAmount,
        amountPaid: '0',
        amountDue: '0',
        cancelledAt: daysFromNow(-19),
        cancelledReason: 'Raised in error — duplicate of the July retainer.',
        sentAt: daysFromNow(-20),
        createdBy: userId,
        items: { create: cancelled.lines },
      },
    });

    // --- Payments -----------------------------------------------------------
    // Allocated against the invoices above so balances reconcile.
    const fullPayment = await tx.payment.create({
      data: {
        organisationId,
        companyId,
        customerId: northwind!.id,
        paymentNumber: 'PAY-000001',
        paymentDate: daysFromNow(-32),
        amount: paid.totalAmount,
        currencyCode: 'INR',
        paymentMethod: 'BANK_TRANSFER',
        reference: 'NEFT/2026/0612',
        status: 'RECORDED',
        createdBy: userId,
      },
    });
    await tx.paymentAllocation.create({
      data: {
        paymentId: fullPayment.id,
        invoiceId: paidInvoice.id,
        allocatedAmount: paid.totalAmount,
      },
    });

    const partPayment = await tx.payment.create({
      data: {
        organisationId,
        companyId,
        customerId: northwind!.id,
        paymentNumber: 'PAY-000002',
        paymentDate: daysFromNow(-12),
        amount: partialPaidAmount.toFixed(4),
        currencyCode: 'INR',
        paymentMethod: 'UPI',
        reference: 'UPI/554120993',
        status: 'RECORDED',
        createdBy: userId,
      },
    });
    await tx.paymentAllocation.create({
      data: {
        paymentId: partPayment.id,
        invoiceId: partialInvoice.id,
        allocatedAmount: partialPaidAmount.toFixed(4),
      },
    });

    // Advance the document sequences past the numbers used above, or the first
    // document created through the API would collide with a seeded one.
    await tx.documentSequence.updateMany({
      where: { organisationId, documentType: 'QUOTATION' },
      data: { currentNumber: sequences.quotation },
    });
    await tx.documentSequence.updateMany({
      where: { organisationId, documentType: 'INVOICE' },
      data: { currentNumber: sequences.invoice },
    });
    // Two payments are seeded below; advance past them so an API-recorded
    // payment cannot collide with a seeded number.
    await tx.documentSequence.updateMany({
      where: { organisationId, documentType: 'PAYMENT' },
      data: { currentNumber: 2 },
    });

    console.log(
      `  documents: ${sequences.quotation} quotations, ${sequences.invoice} invoices, 2 payments`,
    );
  });
}

interface SeedOrgInput {
  id: string;
  name: string;
  legalName: string;
  email: string;
  taxNumber: string;
  companyId: string;
  invoicePrefix: string;
  quotationPrefix: string;
  members: Array<{ userId: string; role: 'OWNER' | 'ADMIN' | 'BILLING' | 'SALES' | 'VIEWER' }>;
  customers: Array<{ id: string; companyName: string; email: string }>;
}

async function seedOrganisation(input: SeedOrgInput) {
  // The seed connects as the migration role and sets tenant context per
  // organisation, mirroring how the API behaves under RLS.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_organisation_id', ${input.id}, true)`;

    await tx.organisation.upsert({
      where: { id: input.id },
      update: {},
      create: {
        id: input.id,
        name: input.name,
        legalName: input.legalName,
        email: input.email,
        phone: '+91 80 4000 1000',
        addressLine1: '1 Commerce Street',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        countryCode: 'IN',
        taxNumber: input.taxNumber,
        currencyCode: 'INR',
        timezone: 'Asia/Kolkata',
        settings: {
          create: {
            invoicePrefix: input.invoicePrefix,
            quotationPrefix: input.quotationPrefix,
            invoiceStartNumber: 1n,
            quotationStartNumber: 1n,
            numberPadding: 6,
            defaultPaymentTermsDays: 30,
            defaultTaxRate: '18.0000',
            defaultTerms: 'Payment due within 30 days of invoice date.',
          },
        },
      },
    });

    // Default company, then its sequences. Numbering is per company, so the
    // company must exist before the sequences can reference it.
    const company = await tx.company.upsert({
      where: { id: input.companyId },
      update: {},
      create: {
        id: input.companyId,
        organisationId: input.id,
        name: input.name,
        countryCode: 'IN',
        currencyCode: 'INR',
        invoicePrefix: input.invoicePrefix,
        quotationPrefix: input.quotationPrefix,
        isDefault: true,
      },
      select: { id: true },
    });

    for (const seq of [
      { documentType: 'INVOICE' as const, prefix: input.invoicePrefix },
      { documentType: 'QUOTATION' as const, prefix: input.quotationPrefix },
      { documentType: 'PAYMENT' as const, prefix: 'PAY-' },
    ]) {
      await tx.documentSequence.upsert({
        where: { companyId_documentType: { companyId: company.id, documentType: seq.documentType } },
        update: {},
        create: {
          organisationId: input.id,
          companyId: company.id,
          documentType: seq.documentType,
          prefix: seq.prefix,
          padding: 6,
          currentNumber: 0n,
        },
      });
    }

    for (const member of input.members) {
      await tx.organisationMember.upsert({
        where: { organisationId_userId: { organisationId: input.id, userId: member.userId } },
        update: { role: member.role, isActive: true },
        create: { organisationId: input.id, userId: member.userId, role: member.role },
      });
    }

    for (const customer of input.customers) {
      await tx.customer.upsert({
        where: { id: customer.id },
        update: {},
        create: {
          id: customer.id,
          organisationId: input.id,
          companyId: company.id,
          customerType: 'COMPANY',
          companyName: customer.companyName,
          contactName: 'Accounts Payable',
          email: customer.email,
          phone: '+91 80 5000 2000',
          billingAddressLine1: '42 Industrial Estate',
          billingCity: 'Bengaluru',
          billingState: 'Karnataka',
          billingPostalCode: '560002',
          billingCountryCode: 'IN',
        },
      });
    }
  });

  console.log(`  ${input.name}: ${input.members.length} member(s), ${input.customers.length} customer(s)`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
