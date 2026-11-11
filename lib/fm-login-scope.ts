// Does this FamilyMeal-password sign-in have to use a Disco Cater password instead?
//
// One decision, used in three places so they can never disagree:
//   - app/api/restaurant-auth (the FM sign-in): refuse, or hand out the set-password step
//   - lib/staff-migration.ts (the Disco sign-in's FM check): the set-password step
//   - lib/fm-portal-gate.ts (every FM-session portal request): a re-check, so a session
//     whose restaurants converted after sign-in is stopped too
//
// THE LINE: every restaurant this login reaches is on Disco Cater. Those people
// have (or get) a Disco account, and Disco's portal is the only portal their
// restaurants need. A login that still reaches a restaurant running on FamilyMeal
// keeps its FamilyMeal session, because that restaurant's menu, item, closed-day,
// scheduling and add-on screens are served by FamilyMeal with the user's own FM
// token (33 routes call getRestaurantAuthHeader) — a Disco session cannot do them,
// and an FM-backed System Admin has no Disco location list, so a Disco session
// would refuse them outright ("No locations are assigned").
//
// Reads only. Never writes, and never calls FamilyMeal.
import { sql } from './db'

export type FmLoginScope =
  /** The team (FamilyMeal SUPER_ADMIN). Never moved to a Disco password. */
  | 'team'
  /** Still reaches a restaurant on FamilyMeal: keeps the FM session. */
  | 'fm-backed'
  /** Every restaurant is on Disco and the Disco account is removed. */
  | 'archived'
  /** Every restaurant is on Disco and a Disco password exists: the FM password is refused. */
  | 'has-disco-password'
  /** Every restaurant is on Disco and no Disco password yet: must set one first. */
  | 'needs-password'

export interface FmLoginIdentity {
  /** The email FamilyMeal authenticated (lowercased). */
  email: string
  /** FamilyMeal's role for it. */
  role: string
  /** The JWT's `restaurant` claim — the home restaurant. */
  homeRef: string | null
}

/** Home + (for a System Admin) their Disco location list — the same set an FM session reaches. */
export async function fmLoginReachableRefs(id: FmLoginIdentity): Promise<string[]> {
  const out = new Set<string>()
  if (id.homeRef) out.add(id.homeRef)
  if (id.role === 'SYSTEM_ADMIN' && id.email) {
    // Same rows as lib/restaurant-auth.ts discoListForEmail (getFmSessionPermittedRefs):
    // an FM-password System Admin reaches exactly this list.
    const rows = (await sql`
      SELECT g.restaurant_reference AS ref
        FROM disco_restaurant_location_access g
       WHERE lower(g.account_email) = ${id.email}
         AND NOT EXISTS (SELECT 1 FROM disco_restaurant_overrides o
                          WHERE o.restaurant_reference = g.restaurant_reference AND o.archived_at IS NOT NULL)
    `) as Array<{ ref: string }>
    for (const r of rows) if (r.ref) out.add(r.ref)
  }
  return [...out]
}

/** True only when EVERY ref is present in the cache and Disco-native. Empty = false (fails toward FM). */
export async function allOnDisco(refs: string[]): Promise<boolean> {
  if (!refs.length) return false
  const rows = (await sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE is_disco_native)::int AS native
      FROM disco_restaurant_cache WHERE restaurant_reference::text = ANY(${refs})
  `) as Array<{ total: number; native: number }>
  const r = rows[0]
  return !!r && r.total === refs.length && r.native === refs.length
}

export async function classifyFmRestaurantLogin(id: FmLoginIdentity): Promise<FmLoginScope> {
  if (id.role === 'SUPER_ADMIN') return 'team'
  const email = (id.email || '').trim().toLowerCase()
  if (!email) return 'fm-backed'
  if (!(await allOnDisco(await fmLoginReachableRefs({ ...id, email })))) return 'fm-backed'

  const rows = (await sql`
    SELECT password_set_at, archived_at FROM disco_restaurant_accounts
     WHERE lower(email) = ${email} LIMIT 1
  `) as Array<{ password_set_at: string | null; archived_at: string | null }>
  const acct = rows[0]
  if (acct?.archived_at) return 'archived'
  if (acct?.password_set_at) return 'has-disco-password'
  return 'needs-password'
}

/** The refusal for a FamilyMeal password once a Disco password exists. */
export const USE_DISCO_PASSWORD = {
  error: 'Your restaurant portal now uses your Disco Cater password, not your FamilyMeal password. Sign in with your Disco Cater password, or choose "Forgot password?" to reset it.',
  reason: 'use-disco-password',
} as const

export const ACCOUNT_REMOVED = {
  error: 'This account has been removed. Ask your restaurant’s admin to invite you again.',
  reason: 'account-removed',
} as const
