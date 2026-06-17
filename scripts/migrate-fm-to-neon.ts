// One-off migration: import historical FamilyMeal data from a LOCAL Postgres
// backup into Neon.
//
//   Run from the disco-cater folder:
//     npx ts-node --skip-project scripts/migrate-fm-to-neon.ts
//
// Connects to TWO databases:
//   1. Local FM backup — postgresql://peterventi@localhost/fm_backup (no password)
//   2. Neon — process.env.DATABASE_URL (read from .env.local)
//
// Three migrations, each idempotent (CREATE TABLE IF NOT EXISTS + ON CONFLICT
// upsert), batched in chunks of 500:
//   1. FM customers              → fm_customers
//   2. Historical FM orders      → fm_historical_orders
//   3. Stripe connected accounts → disco_restaurant_overrides (stripe_connected)

import { config } from 'dotenv'
import { Client } from 'pg'
import { neon } from '@neondatabase/serverless'

config({ path: '.env.local' })

const FM_BACKUP_URL = 'postgresql://peterventi@localhost/fm_backup'
const CHUNK = 500

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run: vercel env pull .env.local --environment=production')
  process.exit(1)
}
const neonSql = neon(process.env.DATABASE_URL)

// ── DDL ───────────────────────────────────────────────────────────────────────

const CREATE_FM_CUSTOMERS = `
CREATE TABLE IF NOT EXISTS fm_customers (
  id SERIAL PRIMARY KEY,
  fm_reference UUID UNIQUE NOT NULL,
  customer_number INTEGER,
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone_number VARCHAR(60),
  created_at TIMESTAMPTZ,
  total_orders INTEGER DEFAULT 0,
  lifetime_value NUMERIC DEFAULT 0,
  last_order_date DATE,
  first_order_date DATE,
  disco_orders INTEGER DEFAULT 0,
  fm_orders INTEGER DEFAULT 0,
  imported_at TIMESTAMPTZ DEFAULT NOW()
)`

const CREATE_FM_HISTORICAL_ORDERS = `
CREATE TABLE IF NOT EXISTS fm_historical_orders (
  id SERIAL PRIMARY KEY,
  fm_order_reference UUID UNIQUE NOT NULL,
  order_number BIGINT,
  order_date DATE,
  order_time TIME,
  order_type VARCHAR(60),
  order_status VARCHAR(60),
  source_of_order VARCHAR(60),
  restaurant_reference UUID,
  restaurant_name VARCHAR(255),
  customer_email VARCHAR(255),
  customer_first_name VARCHAR(100),
  customer_last_name VARCHAR(100),
  customer_phone VARCHAR(60),
  subtotal NUMERIC,
  total NUMERIC,
  fee NUMERIC,
  tips NUMERIC,
  taxes NUMERIC,
  service_charge NUMERIC,
  delivery_fee NUMERIC,
  third_party_delivery_fee NUMERIC,
  discount NUMERIC,
  stripe_payment_intent_id VARCHAR(255),
  payment_type VARCHAR(30),
  created_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT NOW()
)`

// ── Source queries (run against the LOCAL FM backup, schema: familymeal) ───────

const CUSTOMER_QUERY = `
SELECT
  rc.reference,
  rc.customer_number,
  rc.email,
  rc.first_name,
  rc.last_name,
  rc.phone_number,
  rc.created_date,
  COUNT(DISTINCT o.id) as total_orders,
  COALESCE(SUM(st.total), 0) as lifetime_value,
  MAX(o.order_date) as last_order_date,
  MIN(o.order_date) as first_order_date,
  SUM(CASE WHEN o.source_of_order = 'DISCO' THEN 1 ELSE 0 END) as disco_orders,
  SUM(CASE WHEN o.source_of_order = 'FAMILYMEAL' THEN 1 ELSE 0 END) as fm_orders
FROM familymeal.tbl_restaurant_customers rc
LEFT JOIN familymeal.tbl_restaurant_sale_transactions st ON st.restaurant_customer_id = rc.id
LEFT JOIN familymeal.tbl_restaurant_orders o ON o.id = st.restaurant_order_id
  AND (o.is_deleted = false OR o.is_deleted IS NULL)
GROUP BY rc.id, rc.reference, rc.customer_number, rc.email, rc.first_name, rc.last_name, rc.phone_number, rc.created_date`

const ORDERS_QUERY = `
SELECT
  o.reference as fm_order_reference,
  o.order_number,
  o.order_date,
  o.order_time,
  o.order_type,
  o.order_status,
  o.source_of_order,
  r.reference as restaurant_reference,
  r.business_name as restaurant_name,
  rc.email as customer_email,
  rc.first_name as customer_first_name,
  rc.last_name as customer_last_name,
  rc.phone_number as customer_phone,
  st.subtotal,
  st.total,
  st.fee,
  st.tips_in_price as tips,
  st.state_sales_tax_in_price + COALESCE(st.local_sales_tax_in_price,0) + COALESCE(st.other_sales_tax_in_price,0) as taxes,
  st.service_charge,
  st.own_delivery_fee as delivery_fee,
  st.third_party_delivery_fee,
  st.discount,
  st.stripe_payment_intent_id,
  st.payment_type,
  o.created_date as created_at
FROM familymeal.tbl_restaurant_orders o
LEFT JOIN familymeal.tbl_restaurants r ON r.id = o.restaurant_id
LEFT JOIN familymeal.tbl_restaurant_sale_transactions st ON st.restaurant_order_id = o.id
LEFT JOIN familymeal.tbl_restaurant_customers rc ON rc.id = st.restaurant_customer_id
WHERE o.is_deleted = false`

const STRIPE_QUERY = `
SELECT restaurant_reference, stripe_account_id
FROM familymeal.tbl_stripe_connected_accounts
WHERE stripe_account_id IS NOT NULL`

// ── Generic chunked upsert into Neon ──────────────────────────────────────────

// Dedupes rows by the conflict key (last wins — a single multi-row INSERT can't
// touch the same conflict target twice) and upserts in CHUNK-sized batches with
// a parameterized multi-row INSERT ... ON CONFLICT DO UPDATE.
async function batchUpsert(
  table: string,
  columns: string[],
  conflictKey: string,
  rows: Record<string, unknown>[],
  label: string,
): Promise<number> {
  const byKey = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    const key = r[conflictKey]
    if (key == null) continue // can't upsert a row with no conflict key
    byKey.set(String(key), r)
  }
  const deduped = [...byKey.values()]
  const updateCols = columns.filter(c => c !== conflictKey)
  const setSql = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')

  let processed = 0
  for (let i = 0; i < deduped.length; i += CHUNK) {
    const chunk = deduped.slice(i, i + CHUNK)
    const params: unknown[] = []
    const valuesSql: string[] = []
    let p = 1
    for (const row of chunk) {
      valuesSql.push(`(${columns.map(() => `$${p++}`).join(',')})`)
      for (const c of columns) params.push(row[c] ?? null)
    }
    const text =
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${valuesSql.join(',')} ` +
      `ON CONFLICT (${conflictKey}) DO UPDATE SET ${setSql}`
    await neonSql.query(text, params)
    processed += chunk.length
    console.log(`${label}... ${Math.min(i + CHUNK, deduped.length)}/${deduped.length}`)
  }
  return processed
}

// ── Migrations ────────────────────────────────────────────────────────────────

async function migrateCustomers(fm: Client): Promise<number> {
  console.log('\n=== Migration 1 — FM customers → fm_customers ===')
  await neonSql.query(CREATE_FM_CUSTOMERS)
  const { rows } = await fm.query(CUSTOMER_QUERY)
  console.log(`Fetched ${rows.length} customers from FM backup`)
  const mapped = rows.map(r => ({
    fm_reference: r.reference,
    customer_number: r.customer_number,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    phone_number: r.phone_number,
    created_at: r.created_date,
    total_orders: r.total_orders,
    lifetime_value: r.lifetime_value,
    last_order_date: r.last_order_date,
    first_order_date: r.first_order_date,
    disco_orders: r.disco_orders,
    fm_orders: r.fm_orders,
  }))
  return batchUpsert(
    'fm_customers',
    ['fm_reference', 'customer_number', 'email', 'first_name', 'last_name', 'phone_number',
      'created_at', 'total_orders', 'lifetime_value', 'last_order_date', 'first_order_date',
      'disco_orders', 'fm_orders'],
    'fm_reference',
    mapped,
    'Migrating customers',
  )
}

async function migrateOrders(fm: Client): Promise<number> {
  console.log('\n=== Migration 2 — Historical FM orders → fm_historical_orders ===')
  await neonSql.query(CREATE_FM_HISTORICAL_ORDERS)
  const { rows } = await fm.query(ORDERS_QUERY)
  console.log(`Fetched ${rows.length} order rows from FM backup`)
  // The query aliases already match the Neon column names, so the rows map 1:1.
  const columns = ['fm_order_reference', 'order_number', 'order_date', 'order_time', 'order_type',
    'order_status', 'source_of_order', 'restaurant_reference', 'restaurant_name', 'customer_email',
    'customer_first_name', 'customer_last_name', 'customer_phone', 'subtotal', 'total', 'fee', 'tips',
    'taxes', 'service_charge', 'delivery_fee', 'third_party_delivery_fee', 'discount',
    'stripe_payment_intent_id', 'payment_type', 'created_at']
  return batchUpsert('fm_historical_orders', columns, 'fm_order_reference', rows, 'Migrating orders')
}

async function migrateStripe(fm: Client): Promise<number> {
  console.log('\n=== Migration 3 — Stripe connected accounts → disco_restaurant_overrides ===')
  const { rows } = await fm.query(STRIPE_QUERY)
  console.log(`Fetched ${rows.length} stripe-connected accounts from FM backup`)
  // Dedupe by restaurant_reference; build a parameterized multi-row upsert with
  // stripe_connected/stripe_checked_at as SQL literals (true / NOW()).
  const byRef = new Map<string, true>()
  for (const r of rows) { if (r.restaurant_reference) byRef.set(String(r.restaurant_reference), true) }
  const refs = [...byRef.keys()]

  let processed = 0
  for (let i = 0; i < refs.length; i += CHUNK) {
    const chunk = refs.slice(i, i + CHUNK)
    const valuesSql = chunk.map((_, j) => `($${j + 1}, true, NOW())`).join(',')
    const text =
      `INSERT INTO disco_restaurant_overrides (restaurant_reference, stripe_connected, stripe_checked_at) ` +
      `VALUES ${valuesSql} ` +
      `ON CONFLICT (restaurant_reference) DO UPDATE SET stripe_connected = true, stripe_checked_at = NOW()`
    await neonSql.query(text, chunk)
    processed += chunk.length
    console.log(`Migrating stripe status... ${Math.min(i + CHUNK, refs.length)}/${refs.length}`)
  }
  return processed
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const fm = new Client({ connectionString: FM_BACKUP_URL })
  await fm.connect()
  console.log('Connected to local FM backup + Neon')

  const customers = await migrateCustomers(fm)
  const orders = await migrateOrders(fm)
  const stripe = await migrateStripe(fm)

  await fm.end()

  console.log('\n========================================')
  console.log('Migration complete. Summary:')
  console.log('  Tables ensured: fm_customers, fm_historical_orders, disco_restaurant_overrides')
  console.log(`  Migration 1 — fm_customers:          ${customers} rows inserted/updated`)
  console.log(`  Migration 2 — fm_historical_orders:  ${orders} rows inserted/updated`)
  console.log(`  Migration 3 — disco_restaurant_overrides (stripe): ${stripe} rows inserted/updated`)
  console.log('========================================')
}

main().catch(err => {
  console.error('\nMigration failed:', err)
  process.exit(1)
})
