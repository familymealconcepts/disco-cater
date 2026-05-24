import { NextRequest } from 'next/server'

export function getToken(req: NextRequest): string | null {
  const cookie = req.cookies.get('disco_token')?.value
  if (cookie) return cookie
  return req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? null
}

export const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}
