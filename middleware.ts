import { NextRequest, NextResponse } from 'next/server'

function getTokenRole(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.role || payload.authorities?.[0] || null
  } catch {
    return null
  }
}

export function middleware(req: NextRequest) {
  const token = req.cookies.get('disco_token')?.value
  const { pathname } = req.nextUrl

  // Restaurant portal — requires ADMIN role
  if (pathname.startsWith('/restaurant/')) {
    if (!token) {
      const url = req.nextUrl.clone()
      url.pathname = '/restaurant/login'
      return NextResponse.redirect(url)
    }
    const role = getTokenRole(token)
    if (role !== 'ADMIN') {
      const url = req.nextUrl.clone()
      url.pathname = '/restaurant/login'
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  // Admin portal — requires SYSTEM_ADMIN or SUPER_ADMIN role
  if (pathname.startsWith('/admin/')) {
    if (!token) {
      const url = req.nextUrl.clone()
      url.pathname = '/admin/login'
      return NextResponse.redirect(url)
    }
    const role = getTokenRole(token)
    if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') {
      const url = req.nextUrl.clone()
      url.pathname = '/admin/login'
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  // Customer portal — protect /account and /portal
  const customerProtected = ['/account', '/portal']
  if (customerProtected.some(p => pathname.startsWith(p)) && !token) {
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
