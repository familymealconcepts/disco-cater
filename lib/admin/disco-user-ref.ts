/**
 * The `disco:<email>` reference convention for Disco-native accounts in the
 * super-admin portal.
 *
 * FamilyMeal identifies people by a UUID reference. A customer who signed up on
 * Disco Cater, and a system admin who only exists in disco_restaurant_accounts,
 * have no such reference — so the merged admin lists give them a synthetic one
 * built from their email, and the per-account routes route on it instead of
 * forwarding it to FamilyMeal and getting a 404.
 */
export const DISCO_USER_PREFIX = 'disco:'

/** The email behind a `disco:<email>` reference, or null if this is an FM ref. */
export function discoUserEmail(ref: string): string | null {
  if (!ref.startsWith(DISCO_USER_PREFIX)) return null
  const e = decodeURIComponent(ref.slice(DISCO_USER_PREFIX.length)).trim().toLowerCase()
  return e || null
}
