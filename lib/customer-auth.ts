import { cookies } from 'next/headers'

export const CUSTOMER_TOKEN_COOKIE = 'fm_token'
export const CUSTOMER_REFRESH_COOKIE = 'fm_refresh'

export const CUSTOMER_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

export async function getCustomerToken(): Promise<string | null> {
  const store = await cookies()
  return store.get(CUSTOMER_TOKEN_COOKIE)?.value ?? null
}

// FM API expects raw JWT: Authorization: <token> (no Bearer prefix)
export async function getCustomerAuthHeader(): Promise<Record<string, string>> {
  const store = await cookies()
  const token = store.get(CUSTOMER_TOKEN_COOKIE)?.value
  if (!token) throw new Error('Not authenticated')
  return { Authorization: token }
}
