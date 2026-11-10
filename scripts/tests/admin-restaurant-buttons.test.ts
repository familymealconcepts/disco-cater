// Guards for the Super Admin → Restaurants buttons (Peter, 2026-11-10): Enrich with Google fills only empty
// fields and never touches a converted / Disco-native restaurant, and the three remaining fleet-wide buttons
// record who clicked them in disco_admin_audit. Source checks; no database.
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'

let n = 0
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++ }
const src = (p: string) => readFileSync(p, 'utf8')

const enrich = src('app/api/admin/enrich-restaurants-places/route.ts')
const updates = enrich.match(/UPDATE disco_restaurant_cache[\s\S]*?`/g) || []
ok(updates.length === 2, 'two cache writes, one per path')
for (const u of updates) {
  ok(/COALESCE\(is_disco_native, false\) = false/.test(u), 'every write re-checks the restaurant is not Disco-owned')
  ok(!/description = COALESCE\(\$\{/.test(u) && !/image_url = COALESCE\(\$\{/.test(u), 'no write puts a new value over an existing description or photo')
  ok(/cuisine = CASE WHEN cuisine IS NULL OR cuisine = 'Other'/.test(u), 'cuisine is filled, never replaced')
}
ok(/description = CASE WHEN \$\{sql\.unsafe\(BLANK\('description'\)\)\}/.test(enrich) && /image_url = CASE WHEN \$\{sql\.unsafe\(BLANK\('image_url'\)\)\}/.test(enrich), 'description and photo are written only when blank')
ok((enrich.match(/AND COALESCE\(c\.is_disco_native, false\) = false/g) || []).length === 2, 'Disco-owned restaurants are never candidates (count and page)')
ok(/action: 'google_enrich_run'/.test(enrich), 'each Enrich batch is audited')

for (const [file, action] of [
  ['app/api/admin/refresh-restaurant-admin-list-cache/route.ts', 'admin_list_refresh'],
  ['app/api/admin/refresh-restaurant-cache/route.ts', 'map_cache_refresh'],
] as const) {
  const s = src(file)
  ok(new RegExp(`action: '${action}'`).test(s) && /getAdminEmail\(\)/.test(s), `${action} records who clicked`)
}
ok(/'admin_list_refresh' \| 'map_cache_refresh' \| 'google_enrich_run'/.test(src('lib/admin-audit.ts')), 'the three actions are declared')

// Stripe Sync buttons removed (Peter, 2026-11-10, option A); an FM non-answer never records "not connected".
const ordering = src('app/(admin)/admin/(protected)/manage-restaurants/ordering/page.tsx')
ok(!/Sync Stripe Status'|'Full Sync'|sync-stripe-status\/full/.test(ordering) && !existsSync('app/api/admin/sync-stripe-status/full/route.ts'), 'no Sync Stripe Status or Full Sync button, and no full-sync route')
const stripeSync = src('app/api/admin/sync-stripe-status/route.ts')
ok(/if \(res\.status === 204\) return true\s+if \(res\.status === 404\) return false/.test(stripeSync) && !/isConnected = false/.test(stripeSync), 'only 204 and 404 are answers; an error writes nothing')
ok((stripeSync.match(/if \(answer === null\)/g) || []).length === 2, 'both check paths skip the write on no answer')

console.log(`admin-restaurant-buttons: ALL PASS ${n} assertions`)
