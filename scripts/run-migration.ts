// One-off: apply lib/migrations/001_disco_orders.sql to the Neon database.
// Mirrors lib/db.ts runDiscoOrderMigrations() — every statement is idempotent
// (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so re-running is safe.
//
//   npx tsx scripts/run-migration.ts

import { config } from 'dotenv'
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import path from 'node:path'

config({ path: '.env.local' })

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set in .env.local')
  process.exit(1)
}
const sql = neon(process.env.DATABASE_URL)

async function main() {
  const sqlPath = path.join(process.cwd(), 'lib', 'migrations', '001_disco_orders.sql')
  const file = readFileSync(sqlPath, 'utf8')

  // Same splitting as runDiscoOrderMigrations: drop full-line `--` comments,
  // split on `;` (the Neon HTTP driver runs one statement per round-trip).
  const statements = file
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  console.log(`Applying ${statements.length} statements from 001_disco_orders.sql …\n`)

  let ok = 0
  let failed = 0
  for (const s of statements) {
    const label = s.replace(/\s+/g, ' ').slice(0, 80)
    try {
      await sql.query(s)
      ok++
      console.log(`✓ ${label}`)
    } catch (err) {
      failed++
      console.error(`✗ ${label}\n    → ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\nDone — ${ok} ok, ${failed} failed.`)

  // Verify the new edit columns + table actually exist now.
  const cols = (await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'disco_orders'
      AND column_name IN ('edit_count','edit_status','pending_edit_data','pending_edit_delta','pending_stripe_invoice_id')
    ORDER BY column_name
  `) as { column_name: string }[]
  const tbl = (await sql`SELECT to_regclass('public.disco_order_edits') AS t`) as { t: string | null }[]
  console.log('\nVerification:')
  console.log('  disco_orders edit columns:', cols.map((c) => c.column_name).join(', ') || '(none)')
  console.log('  disco_order_edits table:', tbl[0]?.t || '(missing)')

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\nMigration run failed:', err)
  process.exit(1)
})
