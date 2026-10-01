import type { Metadata } from 'next'
import Link from 'next/link'

// The site-wide 404.
//
// Next.js was serving its own unstyled default — a bare "404: This page could
// not be found." on a white page, with no branding and no way back. This
// replaces it with the same wordmark, palette and type the rest of the customer
// surface uses.
//
// ONE FILE COVERS BOTH CASES. App Router resolves notFound() to the nearest
// not-found boundary and there are no others in the tree, so this answers both a
// genuinely missing route (/nonsense) and a restaurant slug that does not
// resolve — app/(customer)/restaurants/[slug]/shared.tsx calls notFound()
// explicitly when neither Neon nor FamilyMeal knows the slug.
//
// Deliberately minimal: there is no reliable way to tell those two cases apart
// here, so the copy says the one thing that is true of both and offers the one
// link worth offering.

// Brand: the gradient wordmark used on the restaurant portal login and across
// the customer surface. Kept inline rather than imported — this page must render
// even when something upstream is broken.
const GRAD = 'linear-gradient(90deg,#6466E8 0%,#C044C8 50%,#F0468A 100%)'
const DARK = '#1A1028'
const MUTED = '#727272'

export const metadata: Metadata = {
  title: 'Page not found | Disco Cater',
  // A 404 must never be indexed, whatever path produced it.
  robots: { index: false, follow: false },
}

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
        textAlign: 'center',
        background: 'linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff',
      }}
    >
      <Link href="/" style={{ textDecoration: 'none', marginBottom: 28 }}>
        <span style={{ fontSize: 26, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          disco
        </span>
        <span style={{ fontSize: 26, fontWeight: 800, color: '#999' }}> cater</span>
      </Link>

      <h1 style={{ fontSize: 20, fontWeight: 700, color: DARK, margin: '0 0 10px' }}>
        This page doesn’t exist
      </h1>

      <p style={{ fontSize: 14.5, color: MUTED, lineHeight: 1.6, margin: '0 0 26px', maxWidth: 420 }}>
        The link may be out of date, or the page may have moved.
      </p>

      <Link
        href="/fullmap"
        style={{
          display: 'inline-block',
          padding: '12px 22px',
          borderRadius: 999,
          background: GRAD,
          color: '#fff',
          fontSize: 14.5,
          fontWeight: 700,
          textDecoration: 'none',
        }}
      >
        Find catering near you →
      </Link>
    </main>
  )
}
