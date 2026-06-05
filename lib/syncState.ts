// Cross-invocation coordination for the restaurant compact regeneration.
//
// Serverless functions don't share memory, so the FM→Sanity sync cron and the
// Sanity webhook coordinate through a tiny Neon table (`sync_state`). This lets
// the webhook (a) skip the expensive full regeneration while a batch sync is
// writing ~150 docs, and (b) debounce rapid manual edits so it regenerates at
// most once per window. generateCompact() crawls every restaurant with a ~1s/req
// FM delay, so running it per-doc would always blow the 300s budget.

import { sql } from './db'

// Created lazily (idempotent) so no migration is required. Cached per lambda.
let ensured = false
async function ensure(): Promise<void> {
  if (ensured) return
  await sql`CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TIMESTAMPTZ NOT NULL)`
  ensured = true
}

const SYNC_ACTIVE_KEY = 'restaurant_sync_active_until'
const LAST_REGEN_KEY = 'last_compact_regen'

// Called by the FM→Sanity sync cron at the start of a run: marks a window during
// which the webhook should NOT regenerate (the sync's own writes fire it).
export async function markRestaurantSyncActive(minutes = 15): Promise<void> {
  await ensure()
  await sql`
    INSERT INTO sync_state (key, value)
    VALUES (${SYNC_ACTIVE_KEY}, NOW() + (${minutes} * INTERVAL '1 minute'))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `
}

// Called by the webhook. Returns { run: false } when a sync is active or a regen
// happened within `debounceSeconds`; otherwise stamps "now" and returns
// { run: true }. Fails CLOSED (run: false) on any error so a DB hiccup can never
// re-open the per-doc regeneration storm — the daily cron is the backstop.
export async function acquireRegenSlot(debounceSeconds = 120): Promise<{ run: boolean; reason?: string }> {
  try {
    await ensure()
    const active = (await sql`
      SELECT 1 FROM sync_state WHERE key = ${SYNC_ACTIVE_KEY} AND value > NOW()
    `) as unknown[]
    if (active.length > 0) return { run: false, reason: 'restaurant sync in progress' }

    const recent = (await sql`
      SELECT 1 FROM sync_state
      WHERE key = ${LAST_REGEN_KEY} AND value > NOW() - (${debounceSeconds} * INTERVAL '1 second')
    `) as unknown[]
    if (recent.length > 0) return { run: false, reason: 'debounced (recent regeneration)' }

    await sql`
      INSERT INTO sync_state (key, value)
      VALUES (${LAST_REGEN_KEY}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `
    return { run: true }
  } catch (e) {
    console.error('[syncState] acquireRegenSlot failed — skipping regen (fail-closed):', e)
    return { run: false, reason: 'coordination unavailable' }
  }
}
