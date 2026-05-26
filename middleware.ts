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

  // Restaurant portal — uses separate fm_restaurant_token cookie
  if (pathname.startsWith('/restaurant/') && pathname !== '/restaurant/login') {
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

  // Admin portal — uses disco_token with elevated roles
  if (pathname.startsWith('/admin/') && pathname !== '/admin/login') {
    const adminToken = req.cookies.get('disco_token')?.value
    if (!adminToken) {
      const url = req.nextUrl.clone()
      url.pathname = '/admin/login'
      return NextResponse.redirect(url)
    }
    const role = decodeTokenRole(adminToken)
    if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') {
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
  matcher: [
    '/account/:path*',
    '/portal/:path*',
    '/restaurant/:path*',
    '/admin/:path*',
  ],
}
