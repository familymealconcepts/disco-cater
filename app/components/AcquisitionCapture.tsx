'use client'

// Records how a customer arrived, once, on their first customer-facing page.
//
// Mounted in the root layout rather than a route-group layout because there is
// no app/(customer)/layout.tsx, and adding one would wrap every customer page
// in a new boundary purely to host this. The path guard below does the same job
// with no change to the render tree.
//
// Renders nothing. Capture is fire-and-forget and is never on the path of
// anything a customer is trying to do — see lib/utils/acquisition.ts.

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { captureAcquisitionOnLoad } from '../../lib/utils/acquisition'

// Staff surfaces. A restaurant admin opening their portal, or a super-admin
// working through /admin, is not a customer acquiring anything — and direct
// entry (a restaurant placing an order for its own customer) must never pick up
// an acquisition source, exactly as it is excluded from the checkout funnel.
const EXCLUDED_PREFIXES = ['/admin', '/restaurant', '/api']

export default function AcquisitionCapture() {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname) return
    if (EXCLUDED_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))) return
    // Already a no-op once a first touch exists, so re-running on client-side
    // navigation costs a cookie read and nothing else.
    try { captureAcquisitionOnLoad() } catch { /* never affects the page */ }
  }, [pathname])

  return null
}
