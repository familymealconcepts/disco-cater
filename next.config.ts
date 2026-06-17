import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // mupdf ships a WASM binary that must load from node_modules at runtime rather
  // than be bundled by Turbopack — used by the become-a-partner menu import to
  // rasterize PDF pages for Claude vision.
  serverExternalPackages: ['mupdf'],
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