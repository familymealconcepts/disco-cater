// Regression: super-admin ordering list must reflect what onboarding actually saved.
//
// Guards two fixes (2026-07-05) for mismatches between saved state and what the
// super-admin ordering page reads:
//   #1 Stripe "Not connected" for a restaurant connected via Disco onboarding.
//      - StripeStatus cell must show Connected when hasStripeAccount is true.
//      - sync-stripe-status must not clobber a disco-connected restaurant to false
//        just because FM's HEAD /api/stripe/{ref} doesn't know it.
//   #2 Uploaded menu not accessible: menu_upload_url held the bare local filename
//      instead of the durable Blob URL, so "View Menu" opened nothing. The
//      /complete route must never overwrite a stored http(s) URL with a filename.
//
// Read/writes only its own temp rows (unique refs), cleans up after itself.
// Run from the disco-cater folder:  node_modules/.bin/tsx scripts/regress-superadmin-stripe-menu.ts

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
// Load .env.local (run from the repo root) before the first DB query.
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
import { sql, runMigrations } from '../lib/db'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${e}`)) }

// The exact display invariant of the StripeStatus cell (ordering/page.tsx): a disco
// Stripe account (hasStripeAccount) OR a probed connection reads as "Connected".
function cellShowsConnected(s?: { connected?: boolean; hasStripeAccount?: boolean; checkedAt?: string | null }): 'Connected' | 'Not connected' | 'Unknown' {
  if (s?.hasStripeAccount === true || s?.connected === true) return 'Connected'
  if (!s || !s.checkedAt) return 'Unknown'
  return 'Not connected'
}

async function main() {
  await runMigrations()
  const discoRef = randomUUID(), plainRef = randomUUID(), menuRef = randomUUID()
  const email = `regress+${Date.now()}@disco-test.invalid`
  try {
    await sql`INSERT INTO disco_restaurant_cache (restaurant_reference, name, slug, is_disco_native, is_live) VALUES
      (${discoRef}, 'Regress Disco', ${'rg-disco-' + Date.now()}, true, true),
      (${plainRef}, 'Regress Plain', ${'rg-plain-' + Date.now()}, false, true)`
    // disco-connected = a Stripe Connect account + completed onboarding
    await sql`INSERT INTO disco_restaurant_accounts (email, password_hash, restaurant_reference, restaurant_name, role, stripe_account_id, stripe_onboarding_complete)
      VALUES (${email}, 'x', ${discoRef}, 'Regress Disco', 'ADMIN', 'acct_regress123', true)`
    await sql`INSERT INTO disco_restaurant_overrides (restaurant_reference, stripe_connected, visible) VALUES
      (${discoRef}, true, true), (${plainRef}, true, true)
      ON CONFLICT (restaurant_reference) DO UPDATE SET stripe_connected = true, stripe_checked_at = NULL`

    console.log('FIX #1 — Stripe status reflects the disco Stripe connection:')
    // (a) overrides API LATERAL join computes has_stripe_account
    const lat = (await sql`
      SELECT c.restaurant_reference, (a.stripe_account_id IS NOT NULL) AS has_stripe_account
      FROM disco_restaurant_cache c
      LEFT JOIN LATERAL (SELECT stripe_account_id FROM disco_restaurant_accounts a2
        WHERE a2.restaurant_reference = c.restaurant_reference AND a2.stripe_account_id IS NOT NULL LIMIT 1) a ON true
      WHERE c.restaurant_reference IN (${discoRef}, ${plainRef})`) as { restaurant_reference: string; has_stripe_account: boolean }[]
    const discoHas = lat.find(r => r.restaurant_reference === discoRef)?.has_stripe_account
    const plainHas = lat.find(r => r.restaurant_reference === plainRef)?.has_stripe_account
    ok('has_stripe_account: disco-connected=true, plain=false', discoHas === true && plainHas === false, `→ ${discoHas}/${plainHas}`)

    // (b) the cell invariant — even with a null/failed FM probe, disco account = Connected
    ok('cell shows Connected for disco account (fresh, no probe yet)', cellShowsConnected({ hasStripeAccount: true, checkedAt: null }) === 'Connected')
    ok('cell shows Connected for disco account even if FM probe said false', cellShowsConnected({ hasStripeAccount: true, connected: false, checkedAt: new Date(0).toISOString() }) === 'Connected')
    ok('cell shows Not connected for a plain restaurant probed false', cellShowsConnected({ hasStripeAccount: false, connected: false, checkedAt: new Date(0).toISOString() }) === 'Not connected')

    // (c) sync-stripe-status guard query identifies disco-connected refs (so the FM
    //     HEAD result is OR'd to true and never clobbers them)
    const guard = (await sql`
      SELECT restaurant_reference FROM disco_restaurant_accounts
      WHERE restaurant_reference = ANY(${[discoRef, plainRef]}) AND stripe_account_id IS NOT NULL AND stripe_onboarding_complete = true
    `) as { restaurant_reference: string }[]
    ok('sync guard detects disco-connected, not the plain restaurant',
      guard.some(r => r.restaurant_reference === discoRef) && !guard.some(r => r.restaurant_reference === plainRef))

    console.log('\nFIX #2 — /complete never overwrites a stored Blob URL with a filename:')
    const blobUrl = 'https://blob.example.com/partner-menus/regress.pdf'
    await sql`INSERT INTO disco_restaurant_cache (restaurant_reference, name, slug, is_disco_native, is_live, menu_upload_url)
      VALUES (${menuRef}, 'Regress Menu', ${'rg-menu-' + Date.now()}, true, true, ${blobUrl})`
    // the exact guarded UPDATE from complete/route.ts
    const guardedSet = (ref: string, val: string) => sql`
      UPDATE disco_restaurant_cache SET menu_upload_url = ${val}
      WHERE restaurant_reference = ${ref} AND (menu_upload_url IS NULL OR menu_upload_url NOT LIKE 'http%')`
    await guardedSet(menuRef, 'Local-File.pdf')
    const kept = (await sql`SELECT menu_upload_url FROM disco_restaurant_cache WHERE restaurant_reference = ${menuRef}`) as { menu_upload_url: string }[]
    ok('Blob URL preserved (filename did not clobber it)', kept[0]?.menu_upload_url === blobUrl, `→ ${kept[0]?.menu_upload_url}`)
    // fallback: with no URL yet, the filename is stored
    await sql`UPDATE disco_restaurant_cache SET menu_upload_url = NULL WHERE restaurant_reference = ${menuRef}`
    await guardedSet(menuRef, 'Local-File.pdf')
    const fb = (await sql`SELECT menu_upload_url FROM disco_restaurant_cache WHERE restaurant_reference = ${menuRef}`) as { menu_upload_url: string }[]
    ok('filename stored as fallback when no URL present', fb[0]?.menu_upload_url === 'Local-File.pdf', `→ ${fb[0]?.menu_upload_url}`)
  } finally {
    await sql`DELETE FROM disco_restaurant_accounts WHERE email = ${email}`.catch(() => {})
    await sql`DELETE FROM disco_restaurant_overrides WHERE restaurant_reference IN (${discoRef}, ${plainRef})`.catch(() => {})
    await sql`DELETE FROM disco_restaurant_cache WHERE restaurant_reference IN (${discoRef}, ${plainRef}, ${menuRef})`.catch(() => {})
  }
  console.log(`\n──────────\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
