import type { Metadata } from 'next'
import { Suspense } from 'react'
import DinovaDemo from './DinovaDemo'

// Hidden, unlinked demo: a Dinova-branded reskin of the Disco Cater fullmap.
// Not indexed (robots noindex/nofollow → emits <meta name="robots"
// content="noindex, nofollow">) and not linked from any public navigation.
export const metadata: Metadata = {
  title: 'Dinova Restaurant Network',
  robots: { index: false, follow: false },
}

export default function DinovaDemoPage() {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'DM Sans, sans-serif', color: '#999', fontSize: 14 }}>Loading…</div>}>
      <DinovaDemo />
    </Suspense>
  )
}
