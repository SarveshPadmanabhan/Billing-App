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

  console.log('\nSeed complete.\n');
  console.log('  Organisation A — Acme Consulting');
  console.log('    owner@acme.test    OWNER    DevPassword123!');
  console.log('    billing@acme.test  BILLING  DevPassword123!');
  console.log('    viewer@acme.test   VIEWER   DevPassword123!');
  console.log('  Organisation B — Globex Corporation');
  console.log('    owner@globex.test  OWNER    DevPassword123!');
  console.log('\n  Org B exists so cross-tenant leaks show up in normal dev use.');
}

interface SeedOrgInput {
  id: string;
  name: string;
  legalName: string;
  email: string;
  taxNumber: string;
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
        documentSequences: {
          create: [
            { documentType: 'INVOICE', prefix: input.invoicePrefix, padding: 6, currentNumber: 0n },
            { documentType: 'QUOTATION', prefix: input.quotationPrefix, padding: 6, currentNumber: 0n },
          ],
        },
      },
    });

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
