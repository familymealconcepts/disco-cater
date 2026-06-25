-- 001_disco_orders.sql
-- Disco-native order management schema (Neon Postgres).
-- Modeled on the FamilyMeal backend entities (RestaurantOrder, RestaurantSaleTransaction,
-- StripePayment) so Disco can eventually replace FM as the order backend.
-- All statements are idempotent (IF NOT EXISTS) so the migration can run on every boot.

CREATE TABLE IF NOT EXISTS disco_orders (
  id BIGSERIAL PRIMARY KEY,
  reference UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  order_number BIGINT NOT NULL UNIQUE,
  order_status TEXT NOT NULL DEFAULT 'CART' CHECK (order_status IN ('CART','RESERVED','DUE','COMPLETED','CANCELED','REFUND','PARTIAL_REFUND','EXPIRED','VOID','UNPAID','PAID')),
  order_type TEXT NOT NULL CHECK (order_type IN ('PICKUP','DELIVERY')),
  delivery_type TEXT CHECK (delivery_type IN ('OWN_DELIVERY','THIRD_PARTY','DLIVRD')),
  source_of_order TEXT NOT NULL DEFAULT 'DISCO' CHECK (source_of_order IN ('DISCO','FAMILYMEAL')),
  purchase_type TEXT,
  restaurant_reference UUID NOT NULL,
  restaurant_name TEXT,
  restaurant_email TEXT,
  customer_email TEXT NOT NULL,
  customer_id BIGINT,
  customer_first_name TEXT,
  customer_last_name TEXT,
  customer_phone TEXT,
  order_date DATE NOT NULL,
  order_time TIME NOT NULL,
  order_drop_off_time TIME,
  tips NUMERIC(10,2) NOT NULL DEFAULT 0,
  tips_type TEXT NOT NULL DEFAULT 'PERCENTAGE' CHECK (tips_type IN ('PERCENTAGE','CUSTOM')),
  refund NUMERIC(10,2),
  note TEXT,
  delivery_address_line1 TEXT,
  delivery_address_line2 TEXT,
  delivery_city TEXT,
  delivery_state TEXT,
  delivery_zip TEXT,
  stripe_invoice_id TEXT,
  stripe_invoice_status TEXT,
  tax_exempt_id TEXT,
  fm_order_reference UUID,
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  seen_by_admin BOOLEAN NOT NULL DEFAULT false,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disco_sale_transactions (
  id BIGSERIAL PRIMARY KEY,
  reference UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  order_id BIGINT NOT NULL REFERENCES disco_orders(id),
  transaction_status TEXT NOT NULL DEFAULT 'INITIATED' CHECK (transaction_status IN ('INITIATED','PAID','VOIDED')),
  transaction_type TEXT NOT NULL DEFAULT 'ORIGINAL' CHECK (transaction_type IN ('ORIGINAL','REFUND','ADDITIONAL')),
  transaction_version BIGINT NOT NULL DEFAULT 1,
  edit_number INTEGER NOT NULL DEFAULT 0,
  receipt_number BIGINT,
  transaction_date DATE,
  paid_at TIMESTAMPTZ,
  subtotal NUMERIC(10,2),
  total NUMERIC(10,2),
  fee NUMERIC(10,2),
  service_charge NUMERIC(10,2),
  stripe_fee NUMERIC(10,2),
  state_tax NUMERIC(10,2),
  local_tax NUMERIC(10,2),
  other_tax NUMERIC(10,2),
  tips_in_price NUMERIC(10,2),
  third_party_delivery_tips NUMERIC(10,2),
  own_delivery_fee NUMERIC(10,2),
  third_party_delivery_fee NUMERIC(10,2),
  third_party_delivery_subsiding NUMERIC(10,2),
  discount NUMERIC(10,2),
  lead_gen_one_disco_fee NUMERIC(10,2),
  lead_gen_two_disco_fee NUMERIC(10,2),
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_type TEXT NOT NULL DEFAULT 'CARD',
  stripe_payment_intent_id TEXT,
  stripe_invoice_id TEXT,
  money_flow TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disco_stripe_payments (
  id BIGSERIAL PRIMARY KEY,
  payment_reference UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  order_reference UUID NOT NULL,
  restaurant_reference UUID NOT NULL,
  transaction_reference UUID,
  stripe_payment_intent_id TEXT UNIQUE,
  status TEXT,
  subtotal NUMERIC(10,2),
  total NUMERIC(10,2),
  fee NUMERIC(10,2),
  delivery_fee NUMERIC(10,2),
  stripe_fee NUMERIC(10,2),
  receipt_url TEXT,
  stripe_customer TEXT,
  charge_id TEXT,
  charge_failure_code TEXT,
  charge_failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disco_order_items (
  id BIGSERIAL PRIMARY KEY,
  reference UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  order_id BIGINT NOT NULL REFERENCES disco_orders(id),
  meal_package_reference TEXT,
  fm_package_id BIGINT,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  price_per_unit NUMERIC(10,2) NOT NULL,
  total_price NUMERIC(10,2) NOT NULL,
  serves INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disco_order_events (
  id BIGSERIAL PRIMARY KEY,
  -- Nullable: account/payout/subscription and WEBHOOK_ERROR events are not tied
  -- to a specific order, so they record with order_reference = NULL.
  order_reference UUID,
  event_type TEXT NOT NULL,
  event_data JSONB,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Self-heal databases created before order_reference was made nullable. Safe to
-- run repeatedly: a no-op once the constraint is already dropped.
ALTER TABLE disco_order_events ALTER COLUMN order_reference DROP NOT NULL;

-- Self-heal databases created before restaurant_email existed. Used by the
-- webhook to send the restaurant order notification. Safe to run repeatedly.
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS restaurant_email TEXT;

-- Disco-native saved card vault. Replaces FM's defaultSource as the source of
-- truth for a customer's default payment method: the card is attached to a
-- Stripe customer (created/looked up by email) and the display + Stripe ids are
-- cached here, keyed one-per-customer-email.
CREATE TABLE IF NOT EXISTS disco_customer_payment_methods (
  id SERIAL PRIMARY KEY,
  customer_email TEXT NOT NULL,
  fm_user_reference TEXT,
  stripe_customer_id TEXT NOT NULL,
  stripe_payment_method_id TEXT NOT NULL,
  card_brand TEXT,
  card_last4 TEXT,
  card_exp_month INTEGER,
  card_exp_year INTEGER,
  is_default BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(customer_email)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_disco_orders_reference ON disco_orders(reference);
CREATE INDEX IF NOT EXISTS idx_disco_orders_status ON disco_orders(order_status);
CREATE INDEX IF NOT EXISTS idx_disco_orders_restaurant ON disco_orders(restaurant_reference);
CREATE INDEX IF NOT EXISTS idx_disco_orders_customer ON disco_orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_disco_orders_fm_reference ON disco_orders(fm_order_reference);
CREATE INDEX IF NOT EXISTS idx_disco_orders_date ON disco_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_disco_sale_transactions_order ON disco_sale_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_disco_sale_transactions_intent ON disco_sale_transactions(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_disco_stripe_payments_intent ON disco_stripe_payments(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_disco_stripe_payments_order ON disco_stripe_payments(order_reference);
CREATE INDEX IF NOT EXISTS idx_disco_order_items_order ON disco_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_disco_order_events_reference ON disco_order_events(order_reference);

-- ── Disco-native restaurant authentication ───────────────────────────────────
-- Disco-owned credentials + sessions for new restaurant partners, replacing FM
-- token auth. Passwords are bcrypt-hashed; sessions are opaque UUID tokens.
CREATE TABLE IF NOT EXISTS disco_restaurant_accounts (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  restaurant_reference TEXT NOT NULL,
  fm_user_reference TEXT,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  restaurant_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disco_restaurant_sessions (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  restaurant_reference TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disco_restaurant_sessions_token ON disco_restaurant_sessions(token);
CREATE INDEX IF NOT EXISTS idx_disco_restaurant_accounts_email ON disco_restaurant_accounts(email);

-- ── Disco-native customer authentication ─────────────────────────────────────
-- Customers authenticate against Neon (bcrypt password_hash). Behind the scenes
-- we still obtain an FM JWT (+ refresh token) and store it on the session so
-- order placement keeps working. The opaque session_token lives in the
-- disco_customer_token cookie (separate from disco_restaurant_token / admin).
CREATE TABLE IF NOT EXISTS disco_customers (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  fm_customer_number INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disco_customer_sessions (
  id SERIAL PRIMARY KEY,
  session_token TEXT UNIQUE NOT NULL,
  customer_email TEXT NOT NULL,
  fm_jwt TEXT,
  fm_refresh_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disco_customer_sessions_token ON disco_customer_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_disco_customers_email ON disco_customers(email);

-- Self-heal columns: needs_password_reset flags FM-migrated rows; fm_reference
-- preserves the FM customer reference (string) the frontend expects on the user
-- payload (the integer fm_customer_number above is null when FM omits it).
ALTER TABLE disco_customers ADD COLUMN IF NOT EXISTS needs_password_reset BOOLEAN DEFAULT false;
ALTER TABLE disco_customers ADD COLUMN IF NOT EXISTS fm_reference TEXT;

-- Disco-native role + restaurant-group columns. ADMIN = single-location access
-- (own restaurant_reference); SYSTEM_ADMIN = all locations in the same group
-- (matched by business_name, or email domain as a fallback). Set by the super
-- admin "Transfer to System Admin" action. Mirrors the FM JWT role, but driven
-- from Neon for Disco-native restaurant accounts.
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'ADMIN';
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS business_name VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_disco_restaurant_accounts_business_name ON disco_restaurant_accounts(business_name);
CREATE INDEX IF NOT EXISTS idx_disco_restaurant_accounts_restaurant_ref ON disco_restaurant_accounts(restaurant_reference);

-- Disco-native SMS notifications: per-restaurant opt-in + destination number,
-- independent of FM's own (FM-proxied) text-notification settings. Read by the
-- Stripe webhook to text the restaurant on new Disco-native orders, and managed
-- from the restaurant portal Settings page (/api/restaurant/sms-settings).
-- Seed sms_phone from the existing signup contact phone so opt-in is one click.
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN DEFAULT false;
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS sms_phone TEXT;
UPDATE disco_restaurant_accounts SET sms_phone = phone WHERE sms_phone IS NULL AND phone IS NOT NULL;

-- Disco-native onboarding (become-a-partner). is_disco_native marks restaurants
-- created entirely in Disco (no FM record); onboarding_step tracks progress
-- (0=registered, 1=profile, 2=stripe, 3=menu, 4=live); stripe_account_id holds
-- the Stripe Connect Express account (acct_xxx) we create natively.
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT false;
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS is_disco_native BOOLEAN DEFAULT true;
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 0;
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE disco_restaurant_accounts ADD COLUMN IF NOT EXISTS cuisine TEXT;

-- ── Disco-native order editing ───────────────────────────────────────────────
-- Edit lifecycle on the order row + an audit log of every committed edit. The
-- pending_* columns hold a proposed edit while we await customer payment on an
-- invoice (resolved by the Stripe invoice.paid webhook).
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS edit_count INTEGER DEFAULT 0;
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS edit_status VARCHAR(50);
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS pending_edit_data JSONB;
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS pending_edit_delta NUMERIC;
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS pending_stripe_invoice_id VARCHAR(255);

CREATE TABLE IF NOT EXISTS disco_order_edits (
  id SERIAL PRIMARY KEY,
  fm_order_reference UUID NOT NULL,
  edit_number INTEGER NOT NULL,
  editor_email VARCHAR(255),
  original_items JSONB,
  new_items JSONB,
  original_total NUMERIC,
  new_total NUMERIC,
  delta NUMERIC,
  original_date DATE,
  new_date DATE,
  original_time TIME,
  new_time TIME,
  payment_action VARCHAR(50),
  payment_status VARCHAR(50),
  stripe_payment_intent_id VARCHAR(255),
  stripe_invoice_id VARCHAR(255),
  stripe_refund_id VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disco_order_edits_fm_ref ON disco_order_edits(fm_order_reference);
CREATE INDEX IF NOT EXISTS idx_disco_orders_pending_invoice ON disco_orders(pending_stripe_invoice_id);

-- Order money columns on disco_orders (the edit flow recalculates + stores these
-- on item changes). FM keeps the canonical money on disco_sale_transactions, but
-- disco_orders carries a denormalized snapshot for the native edit path.
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2);
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS total NUMERIC(10,2);
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS fee NUMERIC(10,2);

-- Headcount (number of people the order serves). FM has no order-level headcount
-- field, so this is captured at Disco checkout and stored here; null when not
-- provided. Shown on the order details panel + PDF.
ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS persons INTEGER;

-- Native-edit audit columns on disco_order_edits (in addition to the original
-- editor_email/original_*/delta columns the webhook also uses).
ALTER TABLE disco_order_edits ADD COLUMN IF NOT EXISTS edited_by VARCHAR(255);
ALTER TABLE disco_order_edits ADD COLUMN IF NOT EXISTS edit_type VARCHAR(20);
ALTER TABLE disco_order_edits ADD COLUMN IF NOT EXISTS previous_total NUMERIC;
ALTER TABLE disco_order_edits ADD COLUMN IF NOT EXISTS previous_date DATE;

-- Allow PAYMENT_FAILED (checkout payment failure, set by the Stripe webhook) and
-- REOPEN/CANCELLED (FM history statuses pulled in by the FM→Neon orders sync).
-- VOIDED is the Disco-native void status (food prepared, not fulfilled — no
-- refund, no notification), set by PUT /api/restaurant/orders/{ref}/void.
-- Drop + re-add is idempotent because DROP precedes ADD on every run.
ALTER TABLE disco_orders DROP CONSTRAINT IF EXISTS disco_orders_order_status_check;
ALTER TABLE disco_orders ADD CONSTRAINT disco_orders_order_status_check CHECK (order_status IN ('CART','RESERVED','DUE','COMPLETED','CANCELED','CANCELLED','REFUND','PARTIAL_REFUND','EXPIRED','VOID','VOIDED','UNPAID','PAID','PAYMENT_FAILED','REOPEN'));
