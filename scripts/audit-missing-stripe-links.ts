// Which of the Disco-native restaurants with no Stripe account in Disco
// actually have one in FamilyMeal.
//
// READ ONLY. Three sources, all reads:
//   * Neon            — who is native, visible, ordering-on, and unlinked
//   * FamilyMeal      — HEAD /api/stripe/{ref}, FM's own yes/no (204 = holds one)
//   * Stripe (live)   — the connected-account list, via the READ-ONLY rk_live key
//
// It writes nothing anywhere. Linking is a separate, deliberate step.
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'
import Stripe from 'stripe'
import { writeFileSync } from 'fs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : ''

type Row = {
  ref: string; name: string; visible: boolean; ordering: boolean
  is_live: boolean; stripe_connected: boolean | null; orders: number
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

async function main() {
  const rows = (await sql`
    SELECT c.restaurant_reference::text AS ref, c.name, c.is_live,
           COALESCE(o.visible,false) AS visible,
           COALESCE(o.online_ordering_enabled,false) AS ordering,
           o.stripe_connected,
           (SELECT count(*)::int FROM disco_orders d WHERE d.restaurant_reference = c.restaurant_reference::uuid) AS orders
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
     WHERE c.is_disco_native = true AND o.archived_at IS NULL AND o.stripe_account_id IS NULL
     ORDER BY c.name
  `) as Row[]
  console.log(`Disco-native, not archived, NO stripe_account_id in Disco: ${rows.length}`)

  // ── FM's own answer, live ──────────────────────────────────────────────────
  const h = await getFmServiceAuthHeader()
  const fmHas = new Map<string, boolean | null>()
  let cursor = 0
  async function worker() {
    while (cursor < rows.length) {
      const r = rows[cursor++]
      try {
        const res = await fetch(`${FM}/api/stripe/${r.ref}`, { method: 'HEAD', headers: h, cache: 'no-store' })
        fmHas.set(r.ref, res.status === 204 ? true : res.status === 404 ? false : null)
      } catch { fmHas.set(r.ref, null) }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))

  const yes = rows.filter(r => fmHas.get(r.ref) === true)
  const no = rows.filter(r => fmHas.get(r.ref) === false)
  const unknown = rows.filter(r => fmHas.get(r.ref) == null)
  console.log(`  FamilyMeal HOLDS an account : ${yes.length}`)
  console.log(`  FamilyMeal holds none       : ${no.length}`)
  console.log(`  FM did not answer cleanly   : ${unknown.length}`)

  // ── The static file conversion resolves from ──────────────────────────────
  const file = require('../data/stripe-account-resolutions.json') as {
    generatedAt: string; totalAccounts: number
    resolutions: { stripeAccountId: string; stripeDisplayName: string | null; bucket: string; restaurantReference: string | null }[]
  }
  const resolvedRefs = new Set(file.resolutions.map(r => r.restaurantReference).filter(Boolean) as string[])
  console.log(`\nstripe-account-resolutions.json — generated ${file.generatedAt.slice(0,10)}, ${file.totalAccounts} accounts`)
  console.log(`  of the ${yes.length} FM-connected restaurants, present as a RESOLVED reference in the file: ${yes.filter(r => resolvedRefs.has(r.ref)).length}`)
  console.log(`  absent from it (so conversion had nothing to link): ${yes.filter(r => !resolvedRefs.has(r.ref)).length}`)

  // ── Live Stripe, read-only ────────────────────────────────────────────────
  const stripe = new Stripe((process.env.STRIPE_READONLY_KEY || '').replace(/^"|"$/g, ''))
  type Acct = { id: string; name: string; charges: boolean; payouts: boolean; disabled: string | null; pastDue: string[]; created: string; metaRef: string | null; claimed: boolean }
  const accounts: Acct[] = []
  for await (const a of stripe.accounts.list({ limit: 100 })) {
    accounts.push({
      id: a.id,
      name: a.business_profile?.name || (a as any).settings?.dashboard?.display_name || '',
      charges: a.charges_enabled === true, payouts: a.payouts_enabled === true,
      disabled: (a as any).requirements?.disabled_reason ?? null,
      pastDue: ((a as any).requirements?.past_due || []) as string[],
      // Some accounts carry no usable `created` — guard rather than throw and
      // lose the whole audit over a display field.
      created: typeof a.created === 'number' && a.created > 0
        ? new Date(a.created * 1000).toISOString().slice(0, 10) : '—',
      metaRef: (a.metadata?.restaurantReference as string) || null,
      claimed: false,
    })
  }
  console.log(`\nLive Stripe connected accounts: ${accounts.length}`)

  // Accounts already linked to SOME restaurant in Disco are not candidates.
  const taken = new Set(((await sql`
    SELECT stripe_account_id FROM disco_restaurant_overrides WHERE stripe_account_id IS NOT NULL
  `) as { stripe_account_id: string }[]).map(r => r.stripe_account_id))
  for (const a of accounts) if (taken.has(a.id)) a.claimed = true
  console.log(`  already linked to a restaurant in Disco: ${accounts.filter(a => a.claimed).length}`)
  console.log(`  unclaimed: ${accounts.filter(a => !a.claimed).length}`)

  // ── Candidate matching, for a HUMAN to confirm ────────────────────────────
  // Name matching is explicitly NOT trusted as proof: several accounts are named
  // "FamilyMeal" / "FamilyMeal Concepts Inc", and real ones diverge from the
  // restaurant name ("Al Volo Gastronomia Italiana" / "Al Volo Pier 57 LLC").
  // These are leads for the Stripe dashboard, never a basis for writing.
  // Accounts named for the platform rather than the restaurant tell us nothing.
  const GENERIC = /^(familymeal|family meal|familymeal concepts|familymeal concepts inc)$/
  const STOP = new Set(['the','and','co','inc','llc','ltd','company','restaurant','cafe','kitchen','bar','grill','a','of'])
  const toks = (x: string) => norm(x).split(' ').filter(t => t && !STOP.has(t))

  /**
   * Confidence, measured rather than asserted. Scored on SIGNIFICANT shared
   * tokens, because first-word matching alone is demonstrably wrong:
   * "Black Seed Bagels" shares "black" with "Black Market BBQ LLC", and
   * "Family's Favorite Foods" shares "family" with "Family Meal Maiz".
   * It also missed real links the other way — "Al Volo Gastronomia Italiana"
   * never matched "Al Volo Pier 57 LLC" because "al" is two letters.
   */
  const score = (rName: string, aName: string): 'strong' | 'possible' | null => {
    const R = toks(rName), A = toks(aName)
    if (!R.length || !A.length) return null
    const shared = R.filter(t => A.includes(t))
    const sharedLong = shared.filter(t => t.length >= 4)
    if (norm(rName) === norm(aName)) return 'strong'
    // Every significant token of one name present in the other.
    if (shared.length === Math.min(R.length, A.length) && shared.length >= 2) return 'strong'
    if (sharedLong.length >= 2) return 'strong'
    // Two shared tokens where at least one is distinctive, or one long one.
    if (shared.length >= 2) return 'possible'
    if (sharedLong.length === 1 && sharedLong[0].length >= 6) return 'possible'
    return null
  }

  const out: any[] = []
  for (const r of yes) {
    const byMeta = accounts.find(a => a.metaRef === r.ref && !a.claimed)
    const scored = accounts
      .filter(a => !a.claimed && a.name && !GENERIC.test(norm(a.name)))
      .map(a => ({ a, s: score(r.name, a.name) }))
      .filter(x => x.s)
      .sort((x, y) => (x.s === 'strong' ? 0 : 1) - (y.s === 'strong' ? 0 : 1))
    out.push({
      ref: r.ref, restaurant: r.name, visible: r.visible, ordering: r.ordering,
      isLive: r.is_live, orders: r.orders,
      inResolutionsFile: resolvedRefs.has(r.ref),
      metadataMatch: byMeta ? { id: byMeta.id, name: byMeta.name, charges: byMeta.charges, payouts: byMeta.payouts, disabled: byMeta.disabled, pastDue: byMeta.pastDue } : null,
      nameCandidates: scored.slice(0, 4).map(x => ({
        confidence: x.s, id: x.a.id, name: x.a.name, created: x.a.created,
        charges: x.a.charges, payouts: x.a.payouts, disabled: x.a.disabled, pastDue: x.a.pastDue,
        nameDiverges: norm(x.a.name) !== norm(r.name),
      })),
    })
  }

  const exact = out.filter(o => o.metadataMatch || o.nameCandidates.filter((c: any) => c.confidence === 'strong').length === 1)
  const ambiguous = out.filter(o => !o.metadataMatch && o.nameCandidates.filter((c: any) => c.confidence === 'strong').length > 1)
  const none = out.filter(o => !o.metadataMatch && !o.nameCandidates.some((c: any) => c.confidence === 'strong'))
  const disabled = out.flatMap(o => o.nameCandidates.filter((c: any) => c.disabled).map((c: any) => ({ restaurant: o.restaurant, ...c })))
  console.log(`\nMATCHING against live Stripe (leads only, nothing written):`)
  console.log(`  single unambiguous candidate : ${exact.length}`)
  console.log(`  several candidates           : ${ambiguous.length}`)
  console.log(`  no strong candidate          : ${none.length}`)
  console.log(`  candidates that are DISABLED in Stripe: ${disabled.length}`)
  for (const d of disabled.slice(0, 12)) console.log(`     ${String(d.restaurant).slice(0,34).padEnd(34)} ${d.id} "${String(d.name).slice(0,28)}" ${d.disabled}`)

  console.log(`\n── VISIBLE + ONLINE ORDERING ON: findable and failing at checkout now ──`)
  const live = rows.filter(r => r.visible && r.ordering)
  console.log(`  ${live.length} restaurants`)
  for (const r of live) {
    const fm = fmHas.get(r.ref)
    const m = out.find(o => o.ref === r.ref)
    const cand = m?.metadataMatch || m?.nameCandidates?.[0]
    console.log(`   ${(fm === true ? 'FM:yes' : fm === false ? 'FM:no ' : 'FM:?  ')}  ${String(r.name).slice(0, 44).padEnd(44)} orders=${String(r.orders).padEnd(4)} ${cand ? `candidate ${cand.id} "${String(cand.name).slice(0,30)}"${cand.disabled ? ` DISABLED(${cand.disabled})` : ''}` : 'no candidate'}`)
  }

  if (OUT) { writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), fmConnected: yes.length, candidates: out }, null, 2)); console.log(`\nwrote ${OUT}`) }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
