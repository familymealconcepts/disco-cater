import { getRestaurantAuthContext } from './restaurant-auth-context'
import { getRestaurantRole, getRestaurantHomeRef, getFmSystemAdminPermittedRefs } from './restaurant-auth'
import { getDiscoGroupAccounts } from './disco-restaurant-auth'

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
