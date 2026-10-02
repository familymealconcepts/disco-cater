// The converted restaurants nobody can administer in Disco Cater.
//
// "Nobody" is resolved the way the portal resolves reach — explicit grants, the
// business_name group, the email-domain group, and the account's own anchor
// (lib/disco-restaurant-auth.ts getDiscoGroupAccounts). No link-aware reach:
// the permission model does not read multi-unit links and is not being changed.
//
// FamilyMeal's own answer is carried alongside, even where Disco could not use
// it, because that is the gap being filled in by hand.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
import { writeFileSync } from 'fs'

const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : ''
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  const rows = (await sql`
    WITH targets AS (
      SELECT c.restaurant_reference::text AS ref, c.name, c.slug,
             COALESCE(o.visible, false) AS visible,
             COALESCE(o.online_ordering_enabled, false) AS ordering,
             c.is_live
        FROM disco_restaurant_cache c
        JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
       WHERE c.is_disco_native = true AND o.archived_at IS NULL
         -- no explicit grant
         AND NOT EXISTS (SELECT 1 FROM disco_restaurant_location_access g
                          WHERE g.restaurant_reference = c.restaurant_reference)
         -- no real (non-sentinel) account anchored here, so no group can carry it
         AND NOT EXISTS (SELECT 1 FROM disco_restaurant_accounts a
                          WHERE a.restaurant_reference = c.restaurant_reference
                            AND a.email NOT LIKE 'stripe-import+%' AND a.archived_at IS NULL)
    )
    SELECT t.*,
           (SELECT count(*)::int FROM disco_orders d WHERE d.restaurant_reference = t.ref::uuid) AS orders,
           (SELECT COALESCE(sum(x.total), 0) FROM disco_orders d
              JOIN disco_sale_transactions x ON x.order_id = d.id AND x.transaction_type = 'ORIGINAL'
             WHERE d.restaurant_reference = t.ref::uuid) AS gross,
           (SELECT max(d.order_date)::text FROM disco_orders d WHERE d.restaurant_reference = t.ref::uuid) AS last_order,
           fm.raw->'admin'->>'email'      AS fm_admin_email,
           fm.raw->'admin'->>'firstName'  AS fm_admin_first,
           fm.raw->'admin'->>'lastName'   AS fm_admin_last,
           fm.raw->>'multiUnitLinksReference' AS fm_group_ref,
           fm.raw->>'businessName'        AS fm_business_name,
           fm.raw->>'status'              AS fm_status,
           (SELECT count(*)::int FROM disco_restaurant_accounts s
             WHERE s.restaurant_reference = t.ref AND s.email LIKE 'stripe-import+%') AS sentinel_rows
      FROM targets t
      LEFT JOIN disco_restaurant_admin_list_cache fm ON fm.raw->>'reference' = t.ref
     ORDER BY orders DESC, t.name
  `) as any[]

  const isCopy = (n: string) => /\[copy\]|\(copy\)|\btest\b|\bdemo\b/i.test(n || '')
  console.log(`converted restaurants nobody can administer: ${rows.length}`)
  console.log(`  with an FM admin email on record : ${rows.filter(r => r.fm_admin_email).length}`)
  console.log(`  copies / test records            : ${rows.filter(r => isCopy(r.name)).length}`)
  console.log(`  have taken an order              : ${rows.filter(r => r.orders > 0).length}`)
  console.log(`  visible + ordering on            : ${rows.filter(r => r.visible && r.ordering).length}`)

  const header = ['Restaurant', 'Reference', 'Orders', 'Gross', 'Last order', 'Visible', 'Ordering on',
    'FM admin email', 'FM admin name', 'FM business name', 'FM group ref', 'FM status',
    'Copy/test?', 'Assign to (fill in)']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      r.name, r.ref, r.orders, Number(r.gross || 0).toFixed(2), r.last_order || '',
      r.visible ? 'yes' : 'no', r.ordering ? 'yes' : 'no',
      r.fm_admin_email || '', [r.fm_admin_first, r.fm_admin_last].filter(Boolean).join(' '),
      r.fm_business_name || '', r.fm_group_ref || '', r.fm_status || '',
      isCopy(r.name) ? 'yes' : '', '',
    ].map(csvCell).join(','))
  }
  if (OUT) { writeFileSync(OUT, lines.join('\n')); console.log(`\nwrote ${OUT}`) }
  writeFileSync('/private/tmp/claude-501/-Users-peterventi-Desktop-VS-Code/76bbaa67-ff60-4fba-92b4-a107221c33ae/scratchpad/unadministered.json', JSON.stringify(rows, null, 2))

  console.log('\n  top 15 by order count:')
  for (const r of rows.slice(0, 15)) {
    console.log(`   ${String(r.name).slice(0, 36).padEnd(38)} ${String(r.orders).padStart(5)}  $${Number(r.gross || 0).toFixed(2).padStart(10)}  last=${r.last_order || '—'}  fmAdmin=${r.fm_admin_email || '—'}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
