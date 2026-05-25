import { NextResponse } from 'next/server'
import { COOKIE_OPTS } from '../../../lib/auth'

export async function POST() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.set('disco_token', '', { ...COOKIE_OPTS, maxAge: 0 })
  resp.cookies.set('disco_refresh', '', { ...COOKIE_OPTS, maxAge: 0 })
  return resp
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true })
  resp.cookies.set('disco_token', '', { ...COOKIE_OPTS, maxAge: 0 })
  resp.cookies.set('disco_refresh', '', { ...COOKIE_OPTS, maxAge: 0 })
  return resp
}
