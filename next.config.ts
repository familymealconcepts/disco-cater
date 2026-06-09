import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
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