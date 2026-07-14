// Client-side mirror of FamilyMeal's ordering-validation (RestaurantServiceImpl
// .restaurantIsAllowedToOnlineOrdering / setOrderingFalseIfValidateDoesNotPass).
//
// FM re-runs this on every restaurant SAVE and auto-disables online ordering if
// the restaurant is missing ANY of: a complete address (incl. map lat/lng), a
// contact phone (notification-setting phone OR admin phone — NOT the business/
// address phone), or a connected Stripe account. It ignores the onlineOrdering
// flag we send. So a routine Disco save (admin edit, or the restaurant's own
// profile save) can silently turn ordering off on a restaurant that already
// fails validation.
//
// This computes whether a save WOULD disable ordering, so the UI can WARN first
// (never hard-block). It only flags when ordering is currently ON — a save can
// only *lose* ordering that's already on.

export interface OrderingCheckInput {
  onlineOrderingAllowed?: boolean | null
  address?: {
    addressLine1?: string | null; city?: string | null; state?: string | null
    zipcode?: string | null; latitude?: number | null; longitude?: number | null
  } | null
  adminPhone?: string | null
  /** Notification-setting phones. Pass the array when known; omit/undefined when
   *  the caller can't see it (admin side) — then contact is judged on adminPhone
   *  alone and the warning notes it may not apply. */
  notificationPhones?: string[] | null
  stripeConnected?: boolean | null
  /** false when the notification phone couldn't be checked (admin edit dialog). */
  canCheckContactFully?: boolean
}

export interface OrderingCheckResult {
  wouldDisable: boolean
  failing: string[]
  message: string | null
}

const nb = (v: unknown) => !!String(v ?? '').trim()

export function checkOrderingWouldDisable(i: OrderingCheckInput): OrderingCheckResult {
  // A save can only turn OFF ordering that's currently on.
  if (i.onlineOrderingAllowed !== true) return { wouldDisable: false, failing: [], message: null }

  const a = i.address || {}
  const addressOk = nb(a.addressLine1) && nb(a.city) && nb(a.state) && nb(a.zipcode) && a.latitude != null && a.longitude != null
  const notifOk = Array.isArray(i.notificationPhones) && i.notificationPhones.some(nb)
  const contactOk = notifOk || nb(i.adminPhone)
  const stripeOk = i.stripeConnected === true

  const failing: string[] = []
  if (!addressOk) failing.push('a complete address with map location')
  if (!contactOk) failing.push('a contact phone number')
  if (!stripeOk) failing.push('a connected Stripe account')
  if (failing.length === 0) return { wouldDisable: false, failing: [], message: null }

  const list = failing.length === 1 ? failing[0] : failing.slice(0, -1).join(', ') + ' and ' + failing[failing.length - 1]
  const softContact = i.canCheckContactFully === false && !contactOk
  const message =
    `⚠️ Saving may turn OFF online ordering.\n\n` +
    `FamilyMeal automatically disables online ordering for any restaurant missing ${list}. ` +
    `This restaurant currently has online ordering ON but is missing ${list}, so saving these changes may cause FamilyMeal to turn it off.` +
    (softContact ? `\n\n(Note: this check can't see a notification-only phone number, so if one is set this may not apply.)` : ``) +
    `\n\nSave anyway?`

  return { wouldDisable: true, failing, message }
}
