-- CreateEnum
CREATE TYPE "organisation_role" AS ENUM ('OWNER', 'ADMIN', 'BILLING', 'SALES', 'VIEWER');

-- CreateEnum
CREATE TYPE "document_number_type" AS ENUM ('INVOICE', 'QUOTATION');

-- CreateEnum
CREATE TYPE "customer_type" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "quotation_status" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'UPI', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('RECORDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL', 'SMS', 'IN_APP');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100),
    "phone" VARCHAR(30),
    "avatar_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "email_verified_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "name" VARCHAR(201) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" VARCHAR(512) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" VARCHAR(64),
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "active_organisation_id" UUID,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" VARCHAR(255) NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(6),
    "refresh_token_expires_at" TIMESTAMPTZ(6),
    "scope" TEXT,
    "id_token" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "value" VARCHAR(512) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "legal_name" VARCHAR(255),
    "logo_url" TEXT,
    "email" VARCHAR(255),
    "phone" VARCHAR(30),
    "website" TEXT,
    "address_line_1" VARCHAR(255),
    "address_line_2" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "postal_code" VARCHAR(30),
    "country_code" CHAR(2) NOT NULL DEFAULT 'IN',
    "tax_number" VARCHAR(100),
    "currency_code" CHAR(3) NOT NULL DEFAULT 'INR',
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_members" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "organisation_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organisation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_settings" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "invoice_prefix" VARCHAR(10) NOT NULL DEFAULT 'INV-',
    "quotation_prefix" VARCHAR(10) NOT NULL DEFAULT 'QUO-',
    "invoice_start_number" BIGINT NOT NULL DEFAULT 1,
    "quotation_start_number" BIGINT NOT NULL DEFAULT 1,
    "number_padding" INTEGER NOT NULL DEFAULT 6,
    "default_payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "default_notes" TEXT,
    "default_terms" TEXT,
    "default_tax_rate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "date_format" VARCHAR(20) NOT NULL DEFAULT 'DD/MM/YYYY',
    "allow_sales_convert_quotation" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organisation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "document_type" "document_number_type" NOT NULL,
    "prefix" VARCHAR(10) NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "current_number" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "customer_type" "customer_type" NOT NULL DEFAULT 'COMPANY',
    "company_name" VARCHAR(255),
    "contact_name" VARCHAR(255),
    "email" VARCHAR(255),
    "phone" VARCHAR(30),
    "tax_number" VARCHAR(100),
    "billing_address_line_1" VARCHAR(255),
    "billing_address_line_2" VARCHAR(255),
    "billing_city" VARCHAR(100),
    "billing_state" VARCHAR(100),
    "billing_postal_code" VARCHAR(30),
    "billing_country_code" CHAR(2),
    "shipping_address_line_1" VARCHAR(255),
    "shipping_address_line_2" VARCHAR(255),
    "shipping_city" VARCHAR(100),
    "shipping_state" VARCHAR(100),
    "shipping_postal_code" VARCHAR(30),
    "shipping_country_code" CHAR(2),
    "notes" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "quotation_number" VARCHAR(50) NOT NULL,
    "issue_date" DATE NOT NULL,
    "valid_until" DATE,
    "status" "quotation_status" NOT NULL DEFAULT 'DRAFT',
    "currency_code" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "terms" TEXT,
    "created_by" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "converted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_items" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unit" VARCHAR(30),
    "unit_price" DECIMAL(19,4) NOT NULL,
    "discount_rate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "quotation_id" UUID,
    "invoice_number" VARCHAR(50) NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "currency_code" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "amount_due" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "terms" TEXT,
    "created_by" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unit" VARCHAR(30),
    "unit_price" DECIMAL(19,4) NOT NULL,
    "discount_rate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "payment_number" VARCHAR(50) NOT NULL,
    "payment_date" DATE NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "payment_method" "payment_method" NOT NULL,
    "reference" VARCHAR(255),
    "notes" TEXT,
    "status" "payment_status" NOT NULL DEFAULT 'RECORDED',
    "idempotency_key" VARCHAR(255),
    "voided_at" TIMESTAMPTZ(6),
    "voided_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "allocated_amount" DECIMAL(19,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "document_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "checksum" VARCHAR(128),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID,
    "type" VARCHAR(100) NOT NULL,
    "channel" "notification_channel" NOT NULL DEFAULT 'EMAIL',
    "recipient" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(500),
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "related_entity_type" VARCHAR(50),
    "related_entity_id" UUID,
    "provider_message_id" VARCHAR(255),
    "sent_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organisation_id" UUID,
    "user_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(50),
    "entity_id" UUID,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_token_idx" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "organisation_members_organisation_id_user_id_idx" ON "organisation_members"("organisation_id", "user_id");

-- CreateIndex
CREATE INDEX "organisation_members_user_id_idx" ON "organisation_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_members_organisation_id_user_id_key" ON "organisation_members"("organisation_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_settings_organisation_id_key" ON "organisation_settings"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_sequences_organisation_id_document_type_key" ON "document_sequences"("organisation_id", "document_type");

-- CreateIndex
CREATE INDEX "customers_organisation_id_idx" ON "customers"("organisation_id");

-- CreateIndex
CREATE INDEX "customers_organisation_id_is_archived_idx" ON "customers"("organisation_id", "is_archived");

-- CreateIndex
CREATE INDEX "customers_organisation_id_email_idx" ON "customers"("organisation_id", "email");

-- CreateIndex
CREATE INDEX "quotations_organisation_id_idx" ON "quotations"("organisation_id");

-- CreateIndex
CREATE INDEX "quotations_organisation_id_status_idx" ON "quotations"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "quotations_organisation_id_customer_id_idx" ON "quotations"("organisation_id", "customer_id");

-- CreateIndex
CREATE INDEX "quotations_organisation_id_issue_date_idx" ON "quotations"("organisation_id", "issue_date");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organisation_id_quotation_number_key" ON "quotations"("organisation_id", "quotation_number");

-- CreateIndex
CREATE INDEX "quotation_items_quotation_id_idx" ON "quotation_items"("quotation_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_items_quotation_id_position_key" ON "quotation_items"("quotation_id", "position");

-- CreateIndex
CREATE INDEX "invoices_organisation_id_idx" ON "invoices"("organisation_id");

-- CreateIndex
CREATE INDEX "invoices_organisation_id_status_idx" ON "invoices"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "invoices_organisation_id_customer_id_idx" ON "invoices"("organisation_id", "customer_id");

-- CreateIndex
CREATE INDEX "invoices_organisation_id_issue_date_idx" ON "invoices"("organisation_id", "issue_date");

-- CreateIndex
CREATE INDEX "invoices_organisation_id_due_date_idx" ON "invoices"("organisation_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organisation_id_invoice_number_key" ON "invoices"("organisation_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoice_items_invoice_id_idx" ON "invoice_items"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_items_invoice_id_position_key" ON "invoice_items"("invoice_id", "position");

-- CreateIndex
CREATE INDEX "payments_organisation_id_idx" ON "payments"("organisation_id");

-- CreateIndex
CREATE INDEX "payments_organisation_id_payment_date_idx" ON "payments"("organisation_id", "payment_date");

-- CreateIndex
CREATE INDEX "payments_organisation_id_customer_id_idx" ON "payments"("organisation_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organisation_id_payment_number_key" ON "payments"("organisation_id", "payment_number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organisation_id_idempotency_key_key" ON "payments"("organisation_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payment_allocations_payment_id_idx" ON "payment_allocations"("payment_id");

-- CreateIndex
CREATE INDEX "payment_allocations_invoice_id_idx" ON "payment_allocations"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_payment_id_invoice_id_key" ON "payment_allocations"("payment_id", "invoice_id");

-- CreateIndex
CREATE INDEX "documents_organisation_id_idx" ON "documents"("organisation_id");

-- CreateIndex
CREATE INDEX "documents_organisation_id_entity_id_idx" ON "documents"("organisation_id", "entity_id");

-- CreateIndex
CREATE INDEX "notifications_organisation_id_idx" ON "notifications"("organisation_id");

-- CreateIndex
CREATE INDEX "notifications_organisation_id_status_idx" ON "notifications"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_organisation_id_created_at_idx" ON "audit_logs"("organisation_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_organisation_id_entity_type_entity_id_idx" ON "audit_logs"("organisation_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_settings" ADD CONSTRAINT "organisation_settings_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
