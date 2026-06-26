// Best-effort FM restaurant creation, shared by the onboarding routes.
//
// FM's POST /api/admin/restaurants requires SUPER_ADMIN, so we authenticate with
// the service account (not the brand-new user). The `restaurant` part is JSON
// inside multipart/form-data; the runtime sets the multipart boundary, so we must
// NOT set Content-Type ourselves.
import { getFmServiceAuthHeader } from '../fm-service-auth'
import { sanitizePhone } from '../utils/phone'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export interface FmCreateInput {
  restaurantName: string
  email: string
  phoneNumber?: string
  firstName?: string
  lastName?: string
  zipcode?: string
  password?: string
  addressLine1?: string
  city?: string
  state?: string
}

export type FmCreateResult =
  | { ok: true; reference: string; adminReference: string | null }
  | { ok: false; code?: string; status: number; error: string }

export async function createFmRestaurant(input: FmCreateInput): Promise<FmCreateResult> {
  const restaurant = {
    businessName: input.restaurantName,
    businessNameWithoutSpaces: input.restaurantName.toLowerCase().replace(/[^a-z0-9]/g, ''),
    email: input.email,
    // FM requires a digits-only phone ("Phone number has wrong format" otherwise).
    phoneNumber: sanitizePhone(String(input.phoneNumber || '')),
    categories: ['EVENT', 'OFFICE', 'HOLIDAY'],
    fulfillmentOptions: ['PICKUP', 'DELIVERY'],
    admin: {
      email: input.email,
      firstName: String(input.firstName || ''),
      lastName: String(input.lastName || ''),
      password: String(input.password || ''),
    },
    address: {
      addressLine1: String(input.addressLine1 || 'TBD'),
      city: String(input.city || 'TBD'),
      state: String(input.state || 'NY'),
      zipcode: String(input.zipcode || ''),
    },
  }

  const mkFd = () => {
    const fd = new FormData()
    fd.append('restaurant', new Blob([JSON.stringify(restaurant)], { type: 'application/json' }))
    return fd
  }

  const header = await getFmServiceAuthHeader()
  let res = await fetch(`${FM}/api/admin/restaurants`, {
    method: 'POST', headers: { ...header, Accept: 'application/json' }, body: mkFd(),
  })
  // One retry on an expired service token.
  if (res.status === 401) {
    const fresh = await getFmServiceAuthHeader(true)
    res = await fetch(`${FM}/api/admin/restaurants`, {
      method: 'POST', headers: { ...fresh, Accept: 'application/json' }, body: mkFd(),
    })
  }

  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.reference) {
    const raw = JSON.stringify(data) || ''
    const code = data?.code || (raw.includes('400-027') ? '400-027' : undefined)
    return { ok: false, code, status: res.status, error: data?.error || `FM ${res.status}` }
  }
  return { ok: true, reference: String(data.reference), adminReference: data?.admin?.reference || null }
}
