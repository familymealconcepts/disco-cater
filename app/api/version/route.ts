import { NextResponse } from 'next/server'

// GET /api/version — which commit the live site is running.
//
// Public on purpose: it exists so a check OUTSIDE Vercel
// (.github/workflows/prod-drift.yml) can tell when production has silently
// stayed on old code. It returns only the commit, where that commit came from
// and when this build was made — all baked in at build time (next.config.ts),
// nothing read from the request or the environment at runtime, nothing secret.
export const dynamic = 'force-static'

export function GET() {
  const sha = process.env.BUILD_COMMIT_SHA || ''
  return NextResponse.json(
    {
      sha: sha || 'unknown',
      shortSha: sha ? sha.slice(0, 7) : 'unknown',
      source: process.env.BUILD_COMMIT_SOURCE || 'unknown',
      builtAt: process.env.BUILD_TIME || null,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
