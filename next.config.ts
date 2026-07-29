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
    return legacyRestaurantSlugRedirects.flatMap(({ oldSlug, newSlug }) => ([
      { source: `/restaurants/${oldSlug}`, destination: `/restaurants/${newSlug}`, permanent: true },
      { source: `/order/${oldSlug}`, destination: `/order/${newSlug}`, permanent: true },
    ]))
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