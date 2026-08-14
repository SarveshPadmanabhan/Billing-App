/**
 * Restore the seeded demo organisations to a clean state.
 *
 * Integration tests each create their own organisation, so they do not touch
 * the demo data. But over a long session the demo organisation still collects
 * records from manual exploration, and a dashboard full of "Test Co 1786..."
 * rows is useless for judging whether the UI actually looks right.
 *
 * This removes documents from the two seeded organisations and re-runs the
 * seed. It never touches other organisations, and refuses to run in production.
 *
 *   pnpm db:reset:demo
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';

const prisma = new PrismaClient();

const DEMO_ORGS = [
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset demo data in production');
  }

  for (const organisationId of DEMO_ORGS) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organisation_id', ${organisationId}, true)`;

      // Ordered to respect the Restrict foreign keys that protect financial
      // history: allocations before payments, items before their documents.
      await tx.$executeRaw`
        DELETE FROM payment_allocations
         WHERE payment_id IN (SELECT id FROM payments WHERE organisation_id = ${organisationId}::uuid)`;
      await tx.payment.deleteMany({ where: { organisationId } });
      await tx.document.deleteMany({ where: { organisationId } });
      await tx.$executeRaw`
        DELETE FROM invoice_items
         WHERE invoice_id IN (SELECT id FROM invoices WHERE organisation_id = ${organisationId}::uuid)`;
      await tx.invoice.deleteMany({ where: { organisationId } });
      await tx.$executeRaw`
        DELETE FROM quotation_items
         WHERE quotation_id IN (SELECT id FROM quotations WHERE organisation_id = ${organisationId}::uuid)`;
      await tx.quotation.deleteMany({ where: { organisationId } });
      await tx.customer.deleteMany({ where: { organisationId } });

      // Reset the sequences so the reseeded documents get their usual numbers.
      await tx.documentSequence.updateMany({
        where: { organisationId },
        data: { currentNumber: 0 },
      });
    });

    console.log(`  cleared ${organisationId}`);
  }

  console.log('\nRe-seeding...\n');
  execSync('pnpm --filter @billing/database seed', { stdio: 'inherit' });
}

main()
  .catch((error) => {
    console.error('Demo reset failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
