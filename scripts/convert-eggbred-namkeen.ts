/**
 * Convert the remaining EggBred + Namkeen locations to Disco-native.
 *
 * STRIPE IS NOT A GATE (product decision, 2026-09-11). A location converts
 * whether or not it has a Stripe account, transfers, or any payment history.
 * An account is attached only where one is confirmed; otherwise the location
 * converts without one and that is recorded, not treated as a problem.
 *
 * Serial, paced, append-only log — a failure partway through never loses what
 * already succeeded, and a re-run skips what is done.
 *
 * NEVER WRITES TO FAMILYMEAL.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import Stripe from 'stripe'
import { sql, runMigrations } from '../lib/db'
import { convertToNative, importRestaurantStripeAccount } from '../lib/native-conversion'
import { importFmMenuFaithfully } from '../lib/menu-import/fm-faithful-import'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'
import * as fs from 'fs'

const LOG = 'data/eggbred-namkeen-conversion.jsonl'
const PACE_MS = 4000
const APPLY = process.argv.includes('--apply')
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const stripe = new Stripe(process.env.STRIPE_LIVE_SECRET_KEY!)

// Confirmed from the Stripe dashboard. San Pablo only.
// acct_1HIItbKZUc8hF6Bt is Albert Shim's CHAIN-LEVEL account, not per-location —
// deliberately NOT attached to La Habra despite the stale snapshot saying so.
const STRIPE_BY_REF: Record<string, string> = {
  '0ef4355d-24a2-48e1-a24c-e2cf9829d861': 'acct_1ThHQB2XucxS9g7Z', // EggBred - San Pablo
}

const arr = (d: unknown): Record<string, unknown>[] => {
  if (Array.isArray(d)) return d as Record<string, unknown>[]
  const o = d as { content?: unknown; data?: unknown } | null
  return (Array.isArray(o?.content) ? o!.content : Array.isArray(o?.data) ? o!.data : []) as Record<string, unknown>[]
}

/**
 * The importer's UNCOUNTED drop: for each item, an extraItemsGroups reference
 * absent from the modifier-group library is skipped by `if (!discoGroup) continue`
 * with no counter. Recomputed here from the same two FM reads the importer uses.
 */
async function groupLinkDrops(ref: string, auth: Record<string, string>) {
  const get = async (p: string) => {
    const r = await fetch(`${FM}${p}`, { headers: { ...auth, Accept: 'application/json' } })
    return r.ok ? await r.json().catch(() => null) : null
  }
  const known = new Set(arr(await get(`/api/restaurants/${ref}/extraItemsGroups?page=0&size=500`)).map(g => String(g.reference)))
  const items = arr(await get(`/api/restaurants/${ref}/mealPackages?page=0&size=1000`))
  let pairs = 0, dropped = 0
  for (const it of items) {
    for (const eg of arr((it as { extraItemsGroups?: unknown }).extraItemsGroups)) {
      pairs++
      if (!known.has(String((eg as { reference?: unknown }).reference || ''))) dropped++
    }
  }
  return { groups: known.size, pairs, dropped }
}

async function main() {
  await runMigrations()
  const targets = (await sql`
    SELECT restaurant_reference AS ref, name FROM disco_restaurant_cache
    WHERE (name ILIKE '%eggbred%' OR name ILIKE '%namkeen%') AND is_disco_native = false
    ORDER BY name
  `) as { ref: string; name: string }[]

  const done = new Set<string>()
  if (fs.existsSync(LOG)) for (const l of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try { const j = JSON.parse(l); if (j.converted) done.add(j.ref) } catch { /* torn line */ }
  }
  const todo = targets.filter(t => !done.has(t.ref))
  console.log(`targets ${targets.length} | already converted this run ${done.size} | to do ${todo.length} | ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  if (!APPLY) { todo.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}  stripe=${STRIPE_BY_REF[t.ref] || '(none)'}`)); return }

  const auth = await getFmServiceAuthHeader()
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i]
    console.log(`\n######## [${i + 1}/${todo.length}] ${t.name} ########`)
    const rec: Record<string, unknown> = { ref: t.ref, name: t.name, at: new Date().toISOString() }
    try {
      const acct = STRIPE_BY_REF[t.ref] || null
      rec.stripeAttached = acct
      if (acct) {
        const s = await importRestaurantStripeAccount(t.ref, acct, { stripe })
        rec.stripeImport = { mode: (s as { mode?: string }).mode, reusable: (s as { reusable?: boolean }).reusable }
        console.log('  stripe:', JSON.stringify(rec.stripeImport))
      } else {
        console.log('  stripe: none — converting without one (not a gate)')
      }

      rec.drops = await groupLinkDrops(t.ref, auth)
      const m = await importFmMenuFaithfully(t.ref)
      rec.menu = { menus: m.menus, categories: m.categories, items: m.items, groups: m.groups,
        modifiers: m.modifiers, itemGroupLinks: m.itemGroupLinks, duplicatedAcrossMenus: m.duplicatedAcrossMenus,
        supplementaryItemsPlaced: m.supplementaryItemsPlaced, hiddenCategorySkipped: m.hiddenCategorySkipped }
      console.log('  menu:', JSON.stringify(rec.menu))

      // Standing rule: visible = true (is_live is COMPUTED by convertToNative from it).
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
        VALUES (${t.ref}, true, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET visible = true, updated_at = NOW()`

      const r = await convertToNative(t.ref, { stripe, skipInvites: true, actorEmail: 'peter@familymeal.com' })
      const j = r as Record<string, any>
      rec.converted = j.converted
      rec.reason = j.reason ?? null
      rec.carry = {
        tax: j.taxRates ?? null, notifications: j.notificationSettings ?? null,
        closedDays: j.closedDays ?? null, promoCodes: j.promoCodes ?? null, profile: j.profileFields ?? null,
      }
      rec.multiUnitLink = j.multiUnitLink?.status ?? null
      console.log(`  converted: ${j.converted}${j.reason ? ' | ' + j.reason : ''}`)
    } catch (e) {
      rec.converted = false
      rec.error = e instanceof Error ? e.message : String(e)
      console.log('  FAILED:', rec.error)
    }
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
    if (i < todo.length - 1) await new Promise(s => setTimeout(s, PACE_MS))
  }
  console.log('\nRUN COMPLETE')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1) })
