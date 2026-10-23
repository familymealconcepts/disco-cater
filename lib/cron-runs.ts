import type { NextRequest } from 'next/server'
import { sql } from './db'
import vercelConfig from '../vercel.json'

// ─── withCronRun: one disco_cron_runs row per cron run (lib/migrations/007_disco_cron_runs.sql) ──
//
// Wraps a scheduled cron route's GET so every run is recorded:
//
//   async function runGet(req: NextRequest) { ...the route, unchanged... }
//   export const GET = withCronRun('sync-fm-orders', runGet)
//
// WHY: before this a marketplace cron that failed left only an #ops-alerts post and a Vercel log
// line, and one Vercel never called left nothing, so NM OS's Platform Health could not show these
// jobs at all. It reads these tables as crm_readonly and judges them with the same rules it uses for
// its own crons (NM OS docs/platform-health-canonical.md, "Marketplace jobs"). This is a port of
// NM OS's src/lib/cronRuns.ts; keep the two in step.
//
// THE ROUTE'S OWN AUTH IS UNTOUCHED. A request without the cron secret goes straight to the handler,
// which refuses it as before, and writes no row: an anonymous hit is not a run.
//
// RECORDING NEVER STOPS OR FAILS THE JOB (Kevin, 2026-10-23). Every write here is caught and logged;
// the handler runs whatever happened to the start write, and its response (or its throw) reaches
// Vercel unchanged. A job that works but is not recorded shows as missed on Platform Health, which is
// the visible direction to fail in.
//
// No transactions: lib/db.ts is Neon HTTP mode, so the start and the finish are two autocommit
// statements. That is the design, not a gap: the 'running' row left by a killed function is exactly
// what records the kill.

export type CronRunState = 'ok' | 'failed' | 'skipped'

/** 409 means another run held the job's lock: a skip. Any other 4xx or a 5xx fails; 2xx/3xx is ok. */
export function classifyCronStatus(status: number): CronRunState {
  if (status === 409) return 'skipped'
  if (status >= 400) return 'failed'
  return 'ok'
}

/** Vercel's scheduler calls with a `vercel-cron/1.0` user agent; anything else is a person or a script. */
export function triggerOf(userAgent: string | null): 'schedule' | 'manual' {
  return /^vercel-cron\//i.test(userAgent ?? '') ? 'schedule' : 'manual'
}

/** The same test every cron route makes, so the wrapper records exactly the requests the route serves. */
export function isCronAuthorized(authorization: string | null, secret: string | undefined): boolean {
  return !!secret && authorization === `Bearer ${secret}`
}

/** The words worth keeping from a non-ok body: its error, else skipped/reason/message, else the text. */
export function responseErrorText(body: string): string | null {
  const text = body.trim()
  if (!text) return null
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    for (const k of ['error', 'skipped', 'reason', 'message']) {
      if (typeof j[k] === 'string' && j[k]) return j[k] as string
    }
  } catch {
    // Not JSON: keep the text as it came.
  }
  return text.slice(0, 4000)
}

/** Every scheduled cron, by route name, with its schedule, from this deployment's own vercel.json. */
export function scheduledCrons(): Array<{ cron: string; schedule: string }> {
  return ((vercelConfig as { crons?: Array<{ path: string; schedule: string }> }).crons ?? [])
    .map((c) => ({ cron: c.path.split('/').filter(Boolean).pop()!, schedule: c.schedule }))
}

export const RETENTION_DAYS = 90
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000

/**
 * REGISTRATION: the first scheduler-signed call this server instance handles records every scheduled
 * cron with its schedule. `since` is set once (ON CONFLICT keeps it), so missed runs count from the
 * first deployment that recorded the job; `schedule` and `schedule_seen_at` are refreshed, so a
 * changed schedule follows the deploy. Once per instance: a new deploy is a new instance.
 */
let registered = false
/** RETENTION: at most once a day per instance, on a scheduled run, delete runs older than 90 days. */
let lastPruneAt = 0

const commit = () => process.env.VERCEL_GIT_COMMIT_SHA ?? null

async function register(): Promise<void> {
  const crons = scheduledCrons()
  await sql.query(
    `INSERT INTO disco_cron_recorded_since (cron, schedule, commit_sha)
       SELECT c, s, $3 FROM unnest($1::text[], $2::text[]) AS t(c, s)
     ON CONFLICT (cron) DO UPDATE SET schedule = EXCLUDED.schedule, schedule_seen_at = NOW()`,
    [crons.map((c) => c.cron), crons.map((c) => c.schedule), commit()],
  )
  registered = true
}

async function prune(): Promise<void> {
  lastPruneAt = Date.now()
  await sql.query(`DELETE FROM disco_cron_runs WHERE started_at < NOW() - make_interval(days => $1)`, [RETENTION_DAYS])
}

async function startRun(cron: string, trigger: 'schedule' | 'manual'): Promise<number | null> {
  try {
    const rows = await sql.query(
      `INSERT INTO disco_cron_runs (cron, trigger, commit_sha) VALUES ($1, $2, $3) RETURNING id`,
      [cron, trigger, commit()],
    ) as Array<{ id: string | number }>
    if (trigger === 'schedule') {
      if (!registered) await register().catch((e: Error) => console.error('[cron-runs] could not register the scheduled crons', e.message))
      if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) await prune().catch((e: Error) => console.error('[cron-runs] could not prune old runs', e.message))
    }
    return Number(rows[0].id)
  } catch (e) {
    console.error(`[cron-runs] ${cron}: could not record the start`, (e as Error).message)
    return null
  }
}

async function finishRun(id: number | null, cron: string, state: CronRunState, httpStatus: number | null, errorText: string | null) {
  if (id === null) return
  try {
    await sql.query(
      `UPDATE disco_cron_runs SET state = $2, finished_at = NOW(), http_status = $3, error_text = $4 WHERE id = $1`,
      [id, state, httpStatus, errorText],
    )
  } catch (e) {
    console.error(`[cron-runs] ${cron}: could not record the finish`, (e as Error).message)
  }
}

export function withCronRun(cron: string, handler: (req: NextRequest) => Promise<Response>) {
  return async function GET(req: NextRequest): Promise<Response> {
    if (!isCronAuthorized(req.headers.get('authorization'), process.env.CRON_SECRET)) return handler(req)
    const id = await startRun(cron, triggerOf(req.headers.get('user-agent')))
    let res: Response
    try {
      res = await handler(req)
    } catch (e) {
      await finishRun(id, cron, 'failed', null, e instanceof Error ? (e.stack ?? e.message) : String(e))
      throw e
    }
    try {
      const state = classifyCronStatus(res.status)
      const errorText = state === 'ok' ? null : responseErrorText(await res.clone().text().catch(() => ''))
      await finishRun(id, cron, state, res.status, errorText)
    } catch (e) {
      console.error(`[cron-runs] ${cron}: could not classify the response`, (e as Error).message)
    }
    return res
  }
}
