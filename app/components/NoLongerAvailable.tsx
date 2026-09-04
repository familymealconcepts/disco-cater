const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'

// Shared "this used to exist but doesn't anymore" state — originally built for
// a dead multi-unit location link (locations/[slug]/page.tsx), reused here for
// an archived restaurant's storefront. Distinct from a bare 404 (which stays
// for a slug that never resolved to anything): a real business a customer may
// have bookmarked or ordered from before deserves an explanation, not a blank
// Next.js error page.
export default function NoLongerAvailable({
  icon = '🔗',
  title = 'This link is no longer active',
  message = "The page you're looking for isn't available. Browse our marketplace to find catering near you.",
}: {
  icon?: string
  title?: string
  message?: string
}) {
  return (
    <div style={{ minHeight: '100svh', background: '#fff', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '48px 20px 96px' }}>
        <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 18 }}>{icon}</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: '0 0 10px', letterSpacing: '-0.01em' }}>
          {title}
        </h1>
        <p style={{ fontSize: 15, color: '#777', margin: '0 0 26px', maxWidth: 380, lineHeight: 1.55 }}>
          {message}
        </p>
        <a
          href="/fullmap"
          style={{
            display: 'inline-block', background: BLUE, color: '#fff', textDecoration: 'none',
            padding: '12px 24px', borderRadius: 999, fontSize: 15, fontWeight: 700,
          }}
        >
          Browse restaurants →
        </a>
      </main>
    </div>
  )
}
