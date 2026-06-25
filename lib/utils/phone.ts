// Shared phone-number helpers.
//
// FamilyMeal's API rejects any formatted phone number ("Phone number has wrong
// format") — it requires digits only, no dashes / spaces / parentheses / "+".
// EVERY phone value sent to FM must pass through sanitizePhone() first. Use
// formatPhoneDisplay() only for rendering in the Disco UI (never on the wire).

export const sanitizePhone = (phone: string | null | undefined): string => {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

export const formatPhoneDisplay = (phone: string | null | undefined): string => {
  const digits = sanitizePhone(phone)
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  if (digits.length === 11 && digits[0] === '1') return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  return digits
}

// Recursively rewrite every phone-bearing field (phone / phoneNumber /
// mobileNumber) on an arbitrary FM payload to digits-only, in place, returning
// the same object. This is the foolproof backstop for nested order DTOs
// (customer / deliveryAddress / checkoutDetails) so no phone can ever reach FM
// formatted, regardless of where it sits in the body. Safe on any shape.
const PHONE_KEYS = new Set(['phone', 'phonenumber', 'mobilenumber'])

export function sanitizePhoneFields<T>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload
  if (Array.isArray(payload)) {
    for (const item of payload) sanitizePhoneFields(item)
    return payload
  }
  const obj = payload as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (typeof val === 'string' && PHONE_KEYS.has(key.toLowerCase())) {
      obj[key] = sanitizePhone(val)
    } else if (val && typeof val === 'object') {
      sanitizePhoneFields(val)
    }
  }
  return payload
}
