import { NextRequest, NextResponse } from 'next/server'

function decodeTokenRole(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.role || payload.authorities?.[0] || null
  } catch {
    return null
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Public, unauthenticated restaurant-portal pages — a logged-out user must be
  // able to reach these by definition (invite/reset links are emailed to
  // someone who, by construction, has no session yet). Without this exemption
  // every such link silently redirects to /restaurant/login before the page's
  // own token-validation logic ever runs — no error, just a dead end.
  const PUBLIC_RESTAURANT_PATHS = ['/restaurant/login', '/restaurant/accept-invite', '/restaurant/forgot-password']
  // Restaurant portal — accepts a Disco-native session OR a legacy FM token.
  if (pathname.startsWith('/restaurant/') && !PUBLIC_RESTAURANT_PATHS.includes(pathname)) {
    // Disco-native session is an opaque UUID, not a JWT, so presence is enough
    // at the edge (next/headers + Neon aren't available here). Full validation
    // happens in /api/disco-restaurant-auth/me.
    const discoToken = req.cookies.get('disco_restaurant_token')?.value
    if (discoToken) return NextResponse.next()

    const restaurantToken = req.cookies.get('fm_restaurant_token')?.value
    if (!restaurantToken) {
      const url = req.nextUrl.clone()
      url.pathname = '/restaurant/login'
      return NextResponse.redirect(url)
    }
    const role = decodeTokenRole(restaurantToken)
    const RESTAURANT_PORTAL_ROLES = ['ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN']
    if (!role || !RESTAURANT_PORTAL_ROLES.includes(role)) {
      const url = req.nextUrl.clone()
      url.pathname = '/restaurant/login'
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  // Admin portal — SUPER_ADMIN only via separate fm_admin_token cookie
  if (pathname.startsWith('/admin/') && pathname !== '/admin/login') {
    const adminToken = req.cookies.get('fm_admin_token')?.value
    if (!adminToken) {
      const url = req.nextUrl.clone()
      url.pathname = '/admin/login'
      return NextResponse.redirect(url)
    }
    const role = decodeTokenRole(adminToken)
    if (role !== 'SUPER_ADMIN') {
      const url = req.nextUrl.clone()
      url.pathname = '/admin/login'
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  // Customer portal — protect /account and /portal.
  // The source of truth is the Disco-native session cookie (disco_customer_token,
  // an opaque Neon token). disco_token (the legacy FM JWT) is only set when FM
  // hands back a JWT at login/signup — so gating on it alone silently locks out
  // any brand-new signup where FM returned no JWT, even though the Neon session
  // is valid (header + /api/fm-user work fine). Check the real session cookie
  // first; keep disco_token as a fallback for legacy sessions. Presence is enough
  // at the edge (next/headers + Neon aren't available here); full validation
  // happens in /api/fm-user, mirroring the restaurant-portal pattern above.
  const customerToken = req.cookies.get('disco_customer_token')?.value
    || req.cookies.get('disco_token')?.value
  if (['/account', '/portal'].some(p => pathname.startsWith(p)) && !customerToken) {
    const url = req.nextUrl.clone()
    url.pathname = '/'
    url.searchParams.set('login', '1')
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  // Public ordering routes — /restaurants/[slug] (3P) and /order/[slug] (1P) —
  // are intentionally NOT listed here, so the middleware never runs on them and
  // they stay auth-free (anyone can browse + start an order; auth is only
  // required at the place-order step inside CheckoutDrawer). Only the portals
  // below are gated.
  matcher: [
    '/account/:path*',
    '/portal/:path*',
    '/restaurant/:path*',
    '/admin/:path*',
  ],
}
