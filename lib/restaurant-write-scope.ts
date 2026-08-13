import { getRestaurantAuthContext, type RestaurantAuthContext } from './restaurant-auth-context'
import { getRestaurantRole, getRestaurantHomeRef, getFmSystemAdminPermittedRefs } from './restaurant-auth'
import { getDiscoGroupAccounts, discoGroupRefs, getLocationAccessRefs } from './disco-restaurant-auth'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The restaurant references the authenticated caller may WRITE to.
//   ADMIN         → their own restaurant only.
//   SYSTEM_ADMIN  → their own group (disco: getDiscoGroupAccounts; FM:
//                   getFmSystemAdminPermittedRefs), plus their own home ref.
//   SUPER_ADMIN   → unrestricted (allowedRefs is unused — see isRefAllowed).
export interface WriteScope {
  role: string
  isSuperAdmin: boolean
  isSystemAdmin: boolean
  ownRef: string
  allowedRefs: string[]
  email: string
}

export async function resolveWriteScope(): Promise<WriteScope | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return null

  const role = ctx.authType === 'disco' ? (ctx.role || 'ADMIN') : (await getRestaurantRole()) || 'ADMIN'
  const isSuperAdmin = role === 'SUPER_ADMIN'
  const isSystemAdmin = role === 'SYSTEM_ADMIN'
  // The true home ref, independent of any current selection — NOT
  // getRestaurantRef()/resolveDiscoScopeRef(), which reflect whatever is
  // selected right now. allowedRefs below is the actual membership check;
  // ownRef here is just guaranteed always in scope for its own account.
  const ownRef = ctx.authType === 'disco' ? (ctx.restaurantReference || '') : (await getRestaurantHomeRef()) || ''

  let allowedRefs: string[] = []
  if (isSuperAdmin) {
    // Unrestricted — isRefAllowed() short-circuits before ever consulting this.
  } else if (isSystemAdmin) {
    if (ctx.authType === 'disco') {
      try {
        const group = await getDiscoGroupAccounts(ctx.businessName, ctx.email)
        allowedRefs = group.map(g => g.restaurant_reference).filter(r => UUID_RE.test(r))
      } catch { /* fall through to home-only below — never widen access on error */ }
    } else if (ctx.fmToken) {
      allowedRefs = [...(await getFmSystemAdminPermittedRefs(ctx.fmToken))].filter(r => UUID_RE.test(r))
    }
    if (ownRef && UUID_RE.test(ownRef) && !allowedRefs.includes(ownRef)) allowedRefs.push(ownRef)
  } else if (ownRef && UUID_RE.test(ownRef)) {
    allowedRefs = [ownRef]
  }

  return { role, isSuperAdmin, isSystemAdmin, ownRef, allowedRefs, email: ctx.email }
}

export function isRefAllowed(scope: WriteScope, ref: string): boolean {
  if (!ref || !UUID_RE.test(ref)) return false
  if (scope.isSuperAdmin) return true
  return scope.allowedRefs.includes(ref)
}

export type WriteRefResult = { ok: true; ref: string } | { ok: false; status: number; error: string }

// THE Step-3 enforcement point. Every write-vulnerable route calls this with
// the restaurant_reference the CLIENT explicitly claims (the one its form was
// loaded for) and writes only to the returned ref — never to whatever the
// session's current selection happens to resolve to right now. That fallback
// is exactly the stale-intent bug this closes: load Location A's profile,
// switch to Location B, save — the write must land on A or be refused,
// never silently retarget to B just because that's selected at save time.
// Fails closed (403) on any ref outside the caller's permitted set.
export async function requireWritableRestaurantRef(claimedRef: unknown): Promise<WriteRefResult> {
  const ref = typeof claimedRef === 'string' ? claimedRef.trim() : ''
  if (!ref) return { ok: false, status: 400, error: 'restaurant_reference is required' }
  const scope = await resolveWriteScope()
  if (!scope) return { ok: false, status: 401, error: 'Not authenticated' }
  if (!isRefAllowed(scope, ref)) return { ok: false, status: 403, error: 'You do not have access to that restaurant' }
  return { ok: true, ref }
}

// ── Disco-native-only scoping helpers ──────────────────────────────────────
//
// A handful of disco-native routes already hold a `ctx` (from
// getRestaurantAuthContext()) and only need a yes/no "is this specific ref in
// reach" check against ONE of two existing group primitives — discoGroupRefs
// (business_name/email-domain grouping, preferring explicit
// disco_restaurant_location_access when present) or getLocationAccessRefs
// (the explicit ACL table only, home-ref fallback). Neither primitive branches
// on role: they just answer "what is this email's group," which is the wrong
// question for a SUPER_ADMIN (unrestricted — the Disco Cater team) and is
// unsafe to apply to a plain ADMIN too (a coincidental shared business_name/
// email-domain would otherwise hand them another owner's locations). These
// two helpers wrap each primitive with the correct role gate; callers that
// already picked one of the two primitives keep using that same data source,
// only the role handling changes.
//
// FM-session scoping is untouched by these — see each call site's own
// deferred-FM comment (native conversion makes those short-lived).
export interface DiscoPermittedRefs { unrestricted: boolean; refs: Set<string> }

export function discoRefAllowed(scope: DiscoPermittedRefs, ref: string): boolean {
  return scope.unrestricted || scope.refs.has(ref)
}

// For call sites keyed on discoGroupRefs (locations/*, upload-image, bulk-pricing).
export async function resolveDiscoGroupScope(ctx: RestaurantAuthContext): Promise<DiscoPermittedRefs> {
  if (ctx.role === 'SUPER_ADMIN') return { unrestricted: true, refs: new Set() }
  if (ctx.role !== 'SYSTEM_ADMIN') return { unrestricted: false, refs: new Set([ctx.restaurantReference].filter(Boolean)) }
  return { unrestricted: false, refs: await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference) }
}

// For call sites keyed on getLocationAccessRefs (order-scope, multi-unit-links,
// team/sub-admins) — explicit ACL table only, with a home-ref fallback when the
// account has no explicit rows yet.
export async function resolveDiscoAccessScope(ctx: RestaurantAuthContext): Promise<DiscoPermittedRefs> {
  if (ctx.role === 'SUPER_ADMIN') return { unrestricted: true, refs: new Set() }
  if (ctx.role !== 'SYSTEM_ADMIN') return { unrestricted: false, refs: new Set([ctx.restaurantReference].filter(Boolean)) }
  let refs: string[] = []
  try { refs = await getLocationAccessRefs(ctx.email) } catch { /* fall through to home-only below */ }
  if (!refs.length && ctx.restaurantReference) refs = [ctx.restaurantReference]
  return { unrestricted: false, refs: new Set(refs) }
}
