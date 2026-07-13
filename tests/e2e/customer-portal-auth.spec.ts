// Regression guard for the customer-portal middleware auth gate.
//
// The customer session's source of truth is the `disco_customer_token` cookie
// (an opaque Neon session token — set by /api/fm-auth and /api/auth/signup, and
// read by /api/fm-user + AuthContext). `disco_token` (the legacy FM JWT) is only
// set when FamilyMeal hands back a JWT at login/signup.
//
// The middleware once gated /account and /portal on `disco_token` ALONE. That
// silently locked out every brand-new signup where FM returned no JWT: the
// header + /api/fm-user showed them logged in (valid Neon session), but the edge
// middleware bounced /account/* and /portal/* to /?login=1. These tests fail
// loudly if that cookie-name mismatch ever regresses.
//
// They hit the edge middleware directly with maxRedirects:0 so the raw redirect
// (or pass-through) is observed WITHOUT the client-side auth in AccountLayout
// muddying the result. A fake token is fine — the middleware only checks cookie
// PRESENCE at the edge (Neon isn't available there); full validation happens in
// /api/fm-user.
import { test, expect } from '@playwright/test'

const GATED_PATHS = ['/account/orders', '/account/favorites', '/account/profile', '/portal']

test.describe('Customer portal middleware auth gate', () => {
  test('disco_customer_token (the real session cookie) is accepted — no login redirect', async ({ request }) => {
    for (const path of GATED_PATHS) {
      const res = await request.get(path, {
        headers: { Cookie: 'disco_customer_token=fake-opaque-session-token' },
        maxRedirects: 0,
      })
      // The invariant: a request carrying the customer session cookie must never
      // be bounced to the login screen by the middleware. (Pass-through renders
      // 200; /portal legitimately 307s onward to /account/orders — neither is a
      // login redirect. A wrong-cookie regression would 307 → /?login=1 here.)
      const location = res.headers()['location'] ?? ''
      expect(location, `${path} should not redirect to login`).not.toContain('login=1')
      expect(res.status(), `${path} should not be blocked, got ${res.status()}`).not.toBe(401)
    }
  })

  test('no session cookie is redirected to /?login=1', async ({ request }) => {
    const res = await request.get('/account/orders', { maxRedirects: 0 })
    expect(res.status()).toBe(307)
    expect(res.headers()['location'] ?? '').toContain('login=1')
  })

  test('legacy disco_token is still accepted (fallback preserved)', async ({ request }) => {
    const res = await request.get('/account/orders', {
      headers: { Cookie: 'disco_token=legacy.fm.jwt' },
      maxRedirects: 0,
    })
    expect(res.status(), `expected pass-through, got ${res.status()}`).toBeLessThan(300)
  })
})
