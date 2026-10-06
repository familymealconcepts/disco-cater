import Stripe from 'stripe'
import { sql } from './db'
import { alertOps } from './ops-alert'
import { getFmServiceAuthHeader } from './fm-service-auth'

// Reconcile Disco's Stripe link against FamilyMeal's, for CONVERTED restaurants.
//
// ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
// resolveStripeAccountForConversion (lib/stripe-link-resolver.ts) runs ONCE, at
// conversion, and is called from exactly one place — scripts/mass-convert.ts.
// A restaurant that connects Stripe in FamilyMeal AFTER it converts is never
// picked up by anything: refresh-stripe-capabilities only refreshes accounts
// already linked, and nothing else looks. Three reported instances — EggBred -
// Greenville, One Lev, and before them the fleet sweep that found 122 — and a
// standing population of 26 restaurants that FamilyMeal says are connected and
// Disco does not, 18 of which have online ordering ON and are therefore
// refusing checkout with payment-not-configured right now.
//
// ── THIS WRITES A PAYOUT DESTINATION. READ THE MATCHING RULE BEFORE EDITING ─
// stripe_account_id is where a restaurant's money goes. A wrong link does not
// fail loudly — it pays one business for another's food. So the matching rule
// is deliberately narrow to the point of being nearly useless, and that is the
// correct trade:
//
//   USED:      Stripe account metadata.restaurantReference, exactly one hit.
//              Written by Disco's own onboarding, so it is Disco's own record
//              of the link. Exact, not inferred.
//
//   REJECTED:  ACCOUNT EMAIL. Measured against 411 links Disco already holds
//              and treats as correct: of 179 confident email matches, 171
//              agreed and EIGHT NAMED A DIFFERENT BUSINESS — Realmuto
//              Pasticceria → "Al Volo Pier 57 LLC", Mario's Pizzeria →
//              "Coppola Ristorante & Pizzeria", Thea Bakery → "153 Nigel LLC",
//              Fat Boy's Pizza - Fort Wayne → "Slider Boys LLC", plus two
//              right-brand-wrong-location (Wax Paper, EggBred). A shared owner
//              email across businesses or locations breaks it completely. 4.5%
//              wrong is catastrophic for payouts. Do not reintroduce it.
//
//   REJECTED:  BUSINESS NAME. Measured earlier and equally unsafe: "Black Seed
//              Bagels" matches "Black Market BBQ LLC", "Family's Favorite
//              Foods" matches "Family Meal Maiz". Many accounts are named
//              "FamilyMeal Concepts Inc" rather than the restaurant.
//
// ── WHAT FAMILYMEAL CAN AND CANNOT BE ASKED ────────────────────────────────
// FM answers WHETHER (HEAD /api/stripe/{ref} → 204 / 404) and never WHICH.
// Probed again 2026-10-06: GET on that path returns "Request method 'GET' not
// supported", /api/stripe/account/{ref} and /api/admin/stripe/{ref} are 404,
// and the admin restaurant detail carries no Stripe field at all. The mapping
// exists only in FM's tbl_stripe_connected_accounts, inside a private network
// reachable through an SSH tunnel — which a Vercel cron cannot open.
//
// CONSEQUENCE, STATED SO NOBODY RE-DERIVES IT: against today's backlog this
// job links NOTHING. Only 15 of 670 live connected accounts carry the
// metadata, and none of them belongs to an unlinked restaurant. Its value
// today is that the 26 stop sitting silent. It links automatically only for
// accounts that carry the reference, which is the state onboarding produces
// going forward. Clearing the backlog needs a human-authorised one-off against
// FM's database, the same way the 122 were cleared.

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const FM_PROBE_CONCURRENCY = 10
// Same lesson as lib/fm-orders-sync.ts's ROTATION_TIME_BUDGET_MS: stop cleanly
// rather than be killed by the platform mid-run. Nothing here is a partial
// write (each link is its own statement), so stopping early is always safe.
const TIME_BUDGET_MS = 240_000

export type RefusalReason =
  | 'ambiguous-metadata'      // >1 account claims this restaurant
  | 'account-taken'           // the named account is already another restaurant's
  | 'unhealthy'               // live Stripe says it cannot take money
  | 'fm-unresolvable'         // FM holds an account it will not name
  | 'conflict'                // Disco and FM/metadata disagree — never auto-resolved

export interface StripeLinkAction {
  restaurantReference: string
  name: string | null
  accountId: string | null
  onlineOrderingEnabled: boolean
}

export interface StripeLinkRefusal extends StripeLinkAction {
  reason: RefusalReason
  detail: string
}

export interface StripeLinkReconcileResult {
  candidates: number
  linked: StripeLinkAction[]
  refused: StripeLinkRefusal[]
  conflicts: StripeLinkRefusal[]
  stripeAccountsScanned: number
  budgetStopped: boolean
  dryRun: boolean
  durationMs: number
}

/**
 * Is this account actually able to receive money right now?
 *
 * Checked against the LIVE account object, never against a cached flag — the
 * whole point of linking is that a charge will be routed here, and a restricted
 * or past-due account takes the charge and strands the payout. Restricted,
 * disabled, past-due and deauthorised accounts are reported, never linked.
 */
export function accountHealth(a: Stripe.Account): { healthy: boolean; detail: string } {
  const problems: string[] = []
  if (a.charges_enabled !== true) problems.push('charges disabled')
  if (a.payouts_enabled !== true) problems.push('payouts disabled')
  if (a.details_submitted !== true) problems.push('onboarding incomplete')
  const req = a.requirements
  if (req?.disabled_reason) problems.push(`disabled: ${req.disabled_reason}`)
  if (req?.past_due?.length) problems.push(`${req.past_due.length} requirement(s) past due`)
  if (req?.currently_due?.length) problems.push(`${req.currently_due.length} requirement(s) currently due`)
  // A deauthorised (revoked) account still lists, but cannot be used.
  if ((a as unknown as { deauthorized?: boolean }).deauthorized === true) problems.push('deauthorised')
  return { healthy: problems.length === 0, detail: problems.join('; ') || 'charges + payouts enabled, nothing due' }
}

/** FamilyMeal's yes/no. null when FM could not be asked — treated as unknown,
 *  never as "no account". */
async function fmHasAccount(ref: string, auth: Record<string, string>): Promise<boolean | null> {
  try {
    const res = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: auth, cache: 'no-store' })
    if (res.status === 204) return true
    if (res.status === 404) return false
    return null
  } catch {
    return null
  }
}

export async function reconcileStripeLinks(
  opts: { dryRun?: boolean; stripe?: Stripe } = {},
): Promise<StripeLinkReconcileResult> {
  const startedAt = Date.now()
  const deadline = startedAt + TIME_BUDGET_MS
  const dryRun = opts.dryRun === true
  const linked: StripeLinkAction[] = []
  const refused: StripeLinkRefusal[] = []
  const conflicts: StripeLinkRefusal[] = []
  let budgetStopped = false

  const key = (process.env.STRIPE_READONLY_KEY || process.env.STRIPE_SECRET_KEY || '').replace(/^"|"$/g, '')
  const stripe = opts.stripe ?? new Stripe(key)

  // CONVERTED restaurants only. Disco owns this value after conversion, and an
  // FM-backed restaurant's payments are FamilyMeal's business, not ours.
  const candidates = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, COALESCE(o.online_ordering_enabled, false) AS ordering
    FROM disco_restaurant_cache c
    JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    WHERE c.is_disco_native = true AND o.stripe_account_id IS NULL
    ORDER BY c.name
  `.catch(() => [])) as { ref: string; name: string | null; ordering: boolean }[]

  // Every link Disco already holds. Two uses: the account-taken guard, and the
  // conflict check. NEVER a source of candidates — an existing link is never
  // overwritten by this job, in either direction.
  const existing = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, o.stripe_account_id AS acct
    FROM disco_restaurant_cache c
    JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    WHERE o.stripe_account_id IS NOT NULL
  `.catch(() => [])) as { ref: string; name: string | null; acct: string }[]
  const accountOwner = new Map(existing.map(e => [e.acct, e]))
  const discoLinkByRef = new Map(existing.map(e => [e.ref, e.acct]))

  // One pass over the platform's connected accounts, indexed by the reference
  // they claim. A scan rather than accounts.search for the same reason the
  // conversion resolver gives: search is not on this API version's Account
  // resource, and ~670 accounts is cheap.
  const byRef = new Map<string, Stripe.Account[]>()
  let scanned = 0
  for await (const a of stripe.accounts.list({ limit: 100 })) {
    scanned++
    const ref = a.metadata?.restaurantReference
    if (!ref) continue
    if (!byRef.has(ref)) byRef.set(ref, [])
    byRef.get(ref)!.push(a)
  }

  // ── CONFLICTS: Disco and the account's own metadata disagree ──────────────
  // Read-only and loud. Taim is the reason this exists rather than a correction:
  // two different accounts were in play and DISCO'S WAS THE CORRECT ONE, so a
  // job that "fixed" the disagreement would have moved a live restaurant's
  // payouts to the wrong account. A human decides; this only reports.
  for (const [ref, accts] of byRef) {
    const discoAcct = discoLinkByRef.get(ref)
    if (!discoAcct) continue
    const named = accts.map(a => a.id)
    if (!named.includes(discoAcct)) {
      const e = existing.find(x => x.ref === ref)
      conflicts.push({
        restaurantReference: ref, name: e?.name ?? null, accountId: discoAcct,
        onlineOrderingEnabled: false, reason: 'conflict',
        detail: `Disco holds ${discoAcct}; Stripe metadata names ${named.join(', ')}. NOT changed — a human must confirm which is correct.`,
      })
    }
  }

  // ── CANDIDATES ────────────────────────────────────────────────────────────
  const auth = await getFmServiceAuthHeader().catch(() => null)
  let idx = 0
  async function worker() {
    while (idx < candidates.length) {
      if (Date.now() > deadline) { budgetStopped = true; return }
      const c = candidates[idx++]
      const base: StripeLinkAction = {
        restaurantReference: c.ref, name: c.name, accountId: null, onlineOrderingEnabled: c.ordering === true,
      }
      const hits = byRef.get(c.ref) ?? []

      if (hits.length > 1) {
        refused.push({ ...base, reason: 'ambiguous-metadata',
          detail: `${hits.length} Stripe accounts claim this reference (${hits.map(h => h.id).join(', ')}).` })
        continue
      }

      if (hits.length === 0) {
        // Nothing nameable. Only worth reporting when FamilyMeal says an account
        // exists — otherwise this is simply a restaurant that has never
        // connected one, which is not a problem.
        const fm = auth ? await fmHasAccount(c.ref, auth) : null
        if (fm === true) {
          refused.push({ ...base, reason: 'fm-unresolvable',
            detail: 'FamilyMeal holds a Stripe account for this restaurant but exposes no endpoint naming it. Needs a human, or a one-off against FM\'s own tbl_stripe_connected_accounts.' })
        }
        continue
      }

      const acct = hits[0]
      const taken = accountOwner.get(acct.id)
      if (taken && taken.ref !== c.ref) {
        refused.push({ ...base, accountId: acct.id, reason: 'account-taken',
          detail: `${acct.id} is already linked to ${taken.name ?? taken.ref}. Linking it here would point two restaurants at one payout destination.` })
        continue
      }

      const health = accountHealth(acct)
      if (!health.healthy) {
        refused.push({ ...base, accountId: acct.id, reason: 'unhealthy', detail: `${acct.id}: ${health.detail}` })
        continue
      }

      if (!dryRun) {
        // Guarded on IS NULL a second time, at the statement. The candidate list
        // was read at the top of the run and something else may have linked this
        // restaurant since; this makes "never overwrite" a property of the write
        // rather than of the read that preceded it.
        await sql`
          UPDATE disco_restaurant_overrides
          SET stripe_account_id = ${acct.id}, updated_at = NOW()
          WHERE restaurant_reference = ${c.ref} AND stripe_account_id IS NULL
        `
      }
      linked.push({ ...base, accountId: acct.id })
      accountOwner.set(acct.id, { ref: c.ref, name: c.name, acct: acct.id })
    }
  }
  await Promise.all(Array.from({ length: FM_PROBE_CONCURRENCY }, () => worker()))

  // ── ALERT ON EVERYTHING, INCLUDING REFUSALS ───────────────────────────────
  // The reason this job exists is that these sat silent. A refusal is the
  // normal outcome here, not an exception, so it is reported every run.
  const blocked = refused.filter(r => r.onlineOrderingEnabled)
  if (linked.length || refused.length || conflicts.length) {
    const lines: string[] = []
    if (linked.length) {
      lines.push(`LINKED (${linked.length}):`)
      for (const l of linked) lines.push(`  • ${l.name ?? l.restaurantReference} → ${l.accountId}`)
    }
    if (conflicts.length) {
      lines.push(`⚠ CONFLICTS — NOT changed (${conflicts.length}):`)
      for (const c of conflicts) lines.push(`  • ${c.name ?? c.restaurantReference}: ${c.detail}`)
    }
    if (refused.length) {
      lines.push(`REFUSED (${refused.length}${blocked.length ? `, ${blocked.length} of them have online ordering ON and are refusing checkout now` : ''}):`)
      for (const r of refused.slice(0, 30)) {
        lines.push(`  • ${r.name ?? r.restaurantReference} [${r.reason}]${r.onlineOrderingEnabled ? ' ⚠ ordering ON' : ''}: ${r.detail}`)
      }
      if (refused.length > 30) lines.push(`  …and ${refused.length - 30} more`)
    }
    await alertOps(
      `stripe-link-reconcile${dryRun ? ' (DRY RUN)' : ''}: ${linked.length} linked, ${refused.length} refused, ${conflicts.length} conflict(s) across ${candidates.length} converted restaurants with no Disco account:\n${lines.join('\n')}`,
    )
  }

  return {
    candidates: candidates.length, linked, refused, conflicts,
    stripeAccountsScanned: scanned, budgetStopped, dryRun,
    durationMs: Date.now() - startedAt,
  }
}
