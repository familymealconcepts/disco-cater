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
