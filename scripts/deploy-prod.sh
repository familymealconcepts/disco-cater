#!/usr/bin/env bash
# Production deploy from the Vercel CLI that still reports its commit at
# /api/version. A CLI deploy carries no git metadata, so the commit is passed
# explicitly as a build env (read by next.config.ts). Refuses a dirty tree, so
# the SHA it reports is exactly the code that was uploaded.
#
#   npm run deploy:prod
set -euo pipefail
if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing: uncommitted changes. Commit (and push) first so /api/version is truthful." >&2
  exit 1
fi
SHA="$(git rev-parse HEAD)"
echo "Deploying $SHA to production via the Vercel CLI…"
vercel deploy --prod --build-env BUILD_COMMIT_SHA="$SHA"
