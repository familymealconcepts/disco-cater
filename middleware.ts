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

  // Restaurant portal — accepts a Disco-native session OR a legacy FM token.
  if (pathname.startsWith('/restaurant/') && pathname !== '/restaurant/login') {
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

  // Customer portal — protect /account and /portal
  const customerToken = req.cookies.get('disco_token')?.value
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
