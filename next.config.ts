import type { NextConfig } from 'next'
import legacyRestaurantSlugRedirects from './lib/legacy-restaurant-slug-redirects.json'
import { execSync } from 'node:child_process'
import { HTML_LIMITED_BOT_UA_RE } from 'next/dist/shared/lib/router/utils/html-bots'

// ── PUBLIC MARKETING PAGES ON restaurant.discocater.com (9 Nov 2026) ─────────
// vercel.json rewrites that host onto /restaurant/*, but only for paths no
// static page claims, so these public pages were served there too, as copies
// of www that Google counted as duplicates. Each is sent to the same path on
// www. Only static marketing pages are listed: every portal, admin, API,
// login, sign-up and account path on that host is untouched.
const RESTAURANT_HOST_MARKETING_PATHS = [
  '/', '/faq', '/fullmap', '/restaurants',
  '/new-york', '/new-jersey', '/los-angeles', '/chicago', '/austin', '/seattle',
  '/corporate-catering', '/holiday-catering', '/social-catering', '/meal-prep',
  '/third-party-delivery', '/compare/:path*', '/become-a-partner', '/for-restaurants',
  '/privacy', '/privacy-choices', '/terms',
]

// ── WHICH COMMIT IS THIS BUILD? (served at /api/version) ─────────────────────
// Baked in at BUILD time, so the live site can say exactly what it is running
// and .github/workflows/prod-drift.yml can notice when production silently
// stays on old code (a push GitHub never handed to Vercel). In order:
//   1. VERCEL_GIT_COMMIT_SHA — every git-triggered Vercel build;
//   2. BUILD_COMMIT_SHA      — a Vercel CLI deploy, which carries no git
//                              metadata: `npm run deploy:prod` passes it with
//                              --build-env (scripts/deploy-prod.sh);
//   3. `git rev-parse HEAD`  — a local `vercel build` / `next build`.
// Empty when none is available; the endpoint then says "unknown" rather than
// guessing.
function buildCommit(): { sha: string; source: string } {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return { sha: process.env.VERCEL_GIT_COMMIT_SHA, source: 'vercel-git' }
  if (process.env.BUILD_COMMIT_SHA) return { sha: process.env.BUILD_COMMIT_SHA, source: 'cli' }
  try {
    return { sha: execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), source: 'local-git' }
  } catch {
    return { sha: '', source: 'unknown' }
  }
}
const BUILD = buildCommit()

const nextConfig: NextConfig = {
  env: {
    BUILD_COMMIT_SHA: BUILD.sha,
    BUILD_COMMIT_SOURCE: BUILD.source,
    BUILD_TIME: new Date().toISOString(),
  },
  // Sanity-sunset slug migration: Sanity auto-slugified restaurant names with
  // hyphens (e.g. "two-hands-franklin"); Neon's disco_restaurant_cache mirrors
  // FM's own shorter no-hyphen slug ("twohandsfranklin") for the same
  // restaurant — the two were never the same string. Now that the customer
  // detail page resolves exclusively via Neon, any restaurant whose old
  // Sanity-slug URL was indexed/bookmarked/backlinked needs a permanent
  // redirect to its new canonical URL instead of a 404. Built once (this
  // static JSON, regenerated only if Sanity data changes before full sunset)
  // — no live Sanity lookup at request time.
  async redirects() {
    return [
      // ── THE DELETED ORDERING WIZARD ────────────────────────────────────────
      // /restaurants/[slug]/order was a one-package-at-a-time stepper, removed
      // in 9ccdda1 because it served FamilyMeal's frozen menu (Beach Buns
      // Bakery was priced $38.00 against Disco's $31.50) and could not complete
      // an order on a native restaurant at all.
      //
      // Nothing in the product ever linked to it and it was never in the
      // sitemap, so this exists purely for a bookmark or a stale backlink —
      // which would otherwise hit a bare 404. Permanent (308) so browsers and
      // crawlers stop asking.
      //
      // The `:slug` segment cannot swallow the live routes: this matches only a
      // path with the literal `/order` SUFFIX, so /restaurants/[slug] and
      // /order/[slug] are untouched.
      { source: '/restaurants/:slug/order', destination: '/restaurants/:slug', permanent: true },

      ...legacyRestaurantSlugRedirects.flatMap(({ oldSlug, newSlug }) => ([
        { source: `/restaurants/${oldSlug}`, destination: `/restaurants/${newSlug}`, permanent: true },
        { source: `/order/${oldSlug}`, destination: `/order/${newSlug}`, permanent: true },
      ])),

      ...RESTAURANT_HOST_MARKETING_PATHS.map(source => ({
        source,
        has: [{ type: 'host' as const, value: 'restaurant.discocater.com' }],
        // /?login=1 is where /account sends a signed-out visitor to log in on
        // this host; it keeps working exactly as before.
        ...(source === '/' ? { missing: [{ type: 'query' as const, key: 'login' }] } : {}),
        destination: `https://www.discocater.com${source}`,
        permanent: true,
      })),
    ]
  },
  // ── THE BACKUP ADDRESS STAYS UP BUT OUT OF SEARCH (9 Nov 2026) ─────────────
  // disco-cater.vercel.app serves the whole site and is kept as a working
  // backup, so it is not redirected. noindex keeps Google from counting its
  // pages as duplicates of www; every canonical tag already names www.
  async headers() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: '(?<host>.*)\\.vercel\\.app' }],
        headers: [{ key: 'X-Robots-Tag', value: 'noindex' }],
      },
    ]
  },
  // ── GOOGLEBOT GETS THE PAGE TAGS IN <head> (9 Nov 2026) ────────────────────
  // Next treats Googlebot as a full browser and, when a page's metadata is not
  // ready by the time the page starts sending, streams the title, canonical and
  // robots tags into <body>. Google only reliably obeys canonical and noindex in
  // <head>: ~470 restaurant pages (mostly the paused "not accepting online
  // orders" notice) were reported as "Duplicate without user-selected
  // canonical". Adding Googlebot to Next's own list makes it wait for them.
  htmlLimitedBots: new RegExp(`${HTML_LIMITED_BOT_UA_RE.source}|Googlebot`, 'i'),
  // mupdf ships a WASM binary that must load from node_modules at runtime rather
  // than be bundled by Turbopack — used by the become-a-partner menu import to
  // rasterize PDF pages for Claude vision.
  // mupdf/sharp are native/WASM modules that must load from node_modules at
  // runtime rather than be bundled by Turbopack. sharp is used server-side by
  // lib/brand-color.ts to extract a restaurant's brand color for the Multi-Unit
  // Links header gradient.
  serverExternalPackages: ['mupdf', 'sharp'],
  // Ensure the SQL migration files are bundled into the serverless functions so
  // runDiscoOrderMigrations() can read them at runtime on Vercel (dynamic
  // process.cwd() reads are not auto-traced).
  outputFileTracingIncludes: {
    '/**': ['./lib/migrations/**'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.squarespace-cdn.com',
      },
    ],
  },
}

export default nextConfig