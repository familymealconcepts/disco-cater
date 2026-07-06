// Best-effort FM restaurant creation, shared by the onboarding routes.
//
// FM's POST /api/admin/restaurants requires SUPER_ADMIN, so we authenticate with
// the service account (not the brand-new user). The `restaurant` part is JSON
// inside multipart/form-data; the runtime sets the multipart boundary, so we must
// NOT set Content-Type ourselves.
//
// Robustness (so a restaurant never silently ends up with no FM record):
//   • Retries transient failures (network error / 5xx) up to 2 times (0.5s, 1.5s).
//   • Does NOT retry permanent 4xx (validation) — retrying won't help.
//   • On 400-027 ("email already in FM"), the record already exists, so instead of
//     failing we look it up by name+admin-email and return that reference.
import { getFmServiceAuthHeader } from '../fm-service-auth'
import { sanitizePhone } from '../utils/phone'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const RETRY_BACKOFFS_MS = [500, 1500]   // before retry 1, retry 2 (transient only)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  | { ok: true; reference: string; adminReference: string | null; recovered?: boolean }
  | { ok: false; code?: string; status: number; error: string }

// Find an existing FM restaurant by name + admin email (used to recover a 400-027,
// where FM already has the record). Returns null on any miss/error.
export async function findFmRestaurantByEmail(name: string, email: string): Promise<{ reference: string; adminReference: string | null } | null> {
  const trimmed = (name || '').trim()
  const target = (email || '').trim().toLowerCase()
  if (!trimmed || !target) return null
  try {
    let header = await getFmServiceAuthHeader()
    const url = `${FM}/api/admin/restaurants?size=50&searchName=${encodeURIComponent(trimmed)}`
    let res = await fetch(url, { headers: { ...header, Accept: 'application/json' }, cache: 'no-store' })
    if (res.status === 401) { header = await getFmServiceAuthHeader(true); res = await fetch(url, { headers: { ...header, Accept: 'application/json' }, cache: 'no-store' }) }
    if (!res.ok) return null
    const data = await res.json().catch(() => null) as { content?: Record<string, unknown>[] } | null
    const list = Array.isArray(data?.content) ? data!.content! : []
    const match = list.find((r) => {
      const admin = (r.admin ?? {}) as Record<string, unknown>
      return String(r.adminEmail ?? admin.email ?? '').toLowerCase() === target && !!r.reference
    })
    if (!match) return null
    const admin = (match.admin ?? {}) as Record<string, unknown>
    return { reference: String(match.reference), adminReference: (admin.reference as string) ?? null }
  } catch { return null }
}

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

  const MAX_ATTEMPTS = RETRY_BACKOFFS_MS.length + 1
  let last: { code?: string; status: number; error: string } = { status: 0, error: 'FM creation not attempted' }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFFS_MS[attempt - 1])
    try {
      let header = await getFmServiceAuthHeader(attempt > 0) // fresh token on each retry
      let res = await fetch(`${FM}/api/admin/restaurants`, { method: 'POST', headers: { ...header, Accept: 'application/json' }, body: mkFd() })
      if (res.status === 401) {
        header = await getFmServiceAuthHeader(true)
        res = await fetch(`${FM}/api/admin/restaurants`, { method: 'POST', headers: { ...header, Accept: 'application/json' }, body: mkFd() })
      }
      const data = await res.json().catch(() => null)
      if (res.ok && data?.reference) {
        return { ok: true, reference: String(data.reference), adminReference: data?.admin?.reference || null }
      }
      const raw = JSON.stringify(data) || ''
      const code = data?.code || (raw.includes('400-027') ? '400-027' : undefined)
      last = { code, status: res.status, error: data?.error || `FM ${res.status}` }

      // 400-027 → the FM record already exists; recover its reference by lookup.
      if (code === '400-027') {
        const found = await findFmRestaurantByEmail(input.restaurantName, input.email)
        if (found) return { ok: true, reference: found.reference, adminReference: found.adminReference, recovered: true }
        return { ok: false, ...last } // exists but not found by search — surface it
      }
      // Any other 4xx is permanent (validation) — don't retry.
      if (res.status >= 400 && res.status < 500) return { ok: false, ...last }
      // 5xx → transient → fall through to retry.
    } catch (err) {
      // Network/timeout → transient → retry.
      last = { status: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { ok: false, ...last }
}
