import { sql } from './db'
import { getRestaurantAuthContext, type RestaurantAuthContext } from './restaurant-auth-context'
import { getRestaurantRef, getRestaurantEmail, getRestaurantRole } from './restaurant-auth'
import { isDiscoNativeRestaurant } from './order/native-checkout'
import { resolveDiscoAccessScope, discoRefAllowed } from './restaurant-write-scope'
import { getLocationAccessRefs } from './disco-restaurant-auth'
import { readAuthorizedUsersRaw } from './fm-master-admin-read'

/**
 * Who may manage whom on the Authorized Users screen — Disco's mirror of
 * FamilyMeal's own rules, read out of the Java source rather than invented:
 *
 *   UserServiceImpl.getManagedUsers      -> SystemAdminUserSpecification
 *                                           .getManagedUsersByManagedRestaurants
 *   UserServiceImpl.updateAdmin/deleteAdmin -> findManagedUserByReference
 *                                              + validateFirstSystemAdmin
 *   UserServiceImpl.resetPassword        -> findManagedUserByReference ONLY
 *
 * TWO FINDINGS THAT SHAPE THIS FILE.
 *
 * 1. FM SCOPES BY LOCATION ASSIGNMENT, NEVER BY CREATOR. The specification
 *    joins managedRestaurants (for a SYSTEM_ADMIN) or restaurant (for an ADMIN)
 *    against the viewer's own managed set. There is no creator predicate
 *    anywhere in it, and FM does not record one: BaseEntity has a created_by
 *    column but its @CreatedBy annotation is commented out, nothing calls
 *    setCreatedBy for a user, and AdminUserResponseDto does not expose it. So
 *    "the users I created" is not a concept FM has, and Disco must not gate on
 *    disco_restaurant_accounts.created_by — which is NULL for every FM-synced
 *    account and made these guards reject every viewer against every target.
 *
 * 2. THE THREE ACTIONS DO NOT SHARE ONE RULE. Edit and delete additionally
 *    refuse the FIRST system admin of the group; reset-password does not.
 */

export type ManageVerdict =
  | { ok: true }
  | { ok: false; error: string; status: number }

export interface ManagedTarget {
  email: string
  role: string
  anchor: string | null
}

/**
 * FM's findManagedUserByReference: the target must sit inside the viewer's own
 * managed set. Deliberately no wider than what the viewer already holds.
 */
export async function assertManagedUser(ctx: RestaurantAuthContext, target: ManagedTarget): Promise<ManageVerdict> {
  const viewerRole = (ctx.role || '').toUpperCase()
  if (viewerRole !== 'SUPER_ADMIN' && viewerRole !== 'SYSTEM_ADMIN') {
    return { ok: false, error: 'Only a System Admin can manage users.', status: 403 }
  }
  const scope = await resolveDiscoAccessScope(ctx)
  if (scope.unrestricted) return { ok: true }

  // A SYSTEM_ADMIN is reachable through any shared location; an ADMIN through
  // their single assigned one — the two arms of FM's specification.
  const targetRefs = new Set<string>(
    (target.role || '').toUpperCase() === 'SYSTEM_ADMIN' ? await getLocationAccessRefs(target.email) : [],
  )
  if (target.anchor) targetRefs.add(target.anchor)
  if (![...targetRefs].some(r => discoRefAllowed(scope, r))) {
    return { ok: false, error: 'That user is not at one of your locations.', status: 403 }
  }
  return { ok: true }
}

/**
 * FM's validateFirstSystemAdmin, applied to EDIT and DELETE only.
 *
 * The authority is FM's own `locked` flag (UserMapper.toPage sets it from
 * UserRepository.findFirstSystemAdminReferenceByManagedRestaurants — the
 * earliest-created SYSTEM_ADMIN of the group). It is read live rather than
 * mirrored into a column: Disco's disco_restaurant_accounts.created_at is the
 * SYNC INSERT time, not FM's, so ordering by it picks the wrong person — for
 * Atlanta Bread it returns tmc@ where FM's locked flag is bcouvaras@.
 *
 * FAILS CLOSED. If FM cannot be reached the destructive action is refused
 * rather than allowed, because the alternative is deleting the one account FM
 * says may never be modified.
 */
export async function assertNotFirstSystemAdmin(target: ManagedTarget): Promise<ManageVerdict> {
  // FM's first system admin is always a SYSTEM_ADMIN, so an ADMIN target needs
  // no FM round-trip at all.
  if ((target.role || '').toUpperCase() !== 'SYSTEM_ADMIN') return { ok: true }
  if (!target.anchor) {
    return { ok: false, error: 'Cannot verify this user against FamilyMeal (no location on the account).', status: 409 }
  }

  let rows: Awaited<ReturnType<typeof readAuthorizedUsersRaw>>
  try {
    rows = await readAuthorizedUsersRaw(target.anchor)
  } catch (e) {
    console.error('[team-management-scope] FM locked-flag read threw:', e instanceof Error ? e.message : e)
    return { ok: false, error: 'Could not reach FamilyMeal to check whether this user is protected. Try again.', status: 503 }
  }
  if (!rows) {
    return { ok: false, error: 'Could not reach FamilyMeal to check whether this user is protected. Try again.', status: 503 }
  }

  const me = rows.find(r => r.email.toLowerCase() === target.email.toLowerCase())
  if (me?.locked === true) {
    return { ok: false, error: 'FamilyMeal protects the first System Admin — they cannot be edited or removed here.', status: 403 }
  }
  return { ok: true }
}

/** The target account, or null when it does not exist / is archived. */
export async function loadManagedTarget(email: string): Promise<ManagedTarget | null> {
  const rows = (await sql`
    SELECT email, COALESCE(role, 'ADMIN') AS role, restaurant_reference AS anchor
    FROM disco_restaurant_accounts WHERE email = ${email} AND archived_at IS NULL LIMIT 1
  `) as Array<{ email: string; role: string; anchor: string | null }>
  return rows[0] ?? null
}

/**
 * The acting person for the team screen, for EITHER kind of session.
 *
 * Disco owns every team change (Peter, 22 Oct 2026): users and locations are
 * saved to Disco only, never to FamilyMeal. A FamilyMeal-password session used
 * to be sent to an FM-proxying team page that created, edited and deleted
 * users — and their locations — in FamilyMeal. Now it is served Disco's team
 * screen, as the person its VERIFIED token names (lib/fm-token-verify.ts), with
 * their verified role. Their authority is then exactly the System Admin rules
 * against Disco's list (lib/system-admin-authority.ts), the same as a
 * Disco-password user.
 *
 * Over a Disco-native restaurant an FM session keeps the role it already had
 * on this screen (SYSTEM_ADMIN for that restaurant — the master-password case
 * the team GET documented); that is unchanged.
 */
export async function getTeamActorContext(): Promise<RestaurantAuthContext | null> {
  const raw = await getRestaurantAuthContext()
  if (!raw) return null
  if (raw.authType === 'disco') return raw
  const targetRef = (await getRestaurantRef().catch(() => null)) || ''
  const email = (await getRestaurantEmail().catch(() => null)) || ''
  if (!targetRef || !email) return null
  const native = await isDiscoNativeRestaurant(targetRef)
  const role = native ? 'SYSTEM_ADMIN' : ((await getRestaurantRole().catch(() => null)) || 'ADMIN').toUpperCase()
  return { ...raw, authType: 'disco', email, role, restaurantReference: targetRef }
}
