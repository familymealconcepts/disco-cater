import { NextRequest, NextResponse } from 'next/server'

export function middleware(req: NextRequest) {
  const token = req.cookies.get('disco_token')?.value
  const { pathname } = req.nextUrl

  const protectedPaths = ['/account', '/portal']
  if (protectedPaths.some(p => pathname.startsWith(p)) && !token) {
    const url = req.nextUrl.clone()
    url.pathname = '/'
    url.searchParams.set('login', '1')
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/account/:path*', '/portal/:path*'],
}
