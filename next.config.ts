import type { NextConfig } from 'next'
import legacyRestaurantSlugRedirects from './lib/legacy-restaurant-slug-redirects.json'

const nextConfig: NextConfig = {
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
    ]
  },
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