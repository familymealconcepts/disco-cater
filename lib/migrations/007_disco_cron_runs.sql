-- 007: disco_cron_runs + disco_cron_recorded_since — one row per marketplace cron run, so the
-- marketplace's scheduled jobs appear on NM OS's Platform Health (Kevin, 2026-10-23).
--
-- APPLY MANUALLY, BEFORE the code that writes these tables deploys (lib/cron-runs.ts swallows a
-- failed write, so code deployed first records nothing rather than breaking, but every run until
-- then is lost). Purely additive: two new tables and their indexes, nothing else reads or writes
-- them. Idempotent. Apply with a short lock_timeout and read back on a fresh connection.
--
-- These mirror NM OS's cron_runs (its migration 259) and cron_recorded_since (its migration 262),
-- so NM OS judges marketplace jobs with exactly the rules it uses for its own. One addition:
-- the registry also stores each job's SCHEDULE, because NM OS cannot import this repo's vercel.json.
--
-- WRITTEN only by withCronRun (lib/cron-runs.ts), which wraps every scheduled cron route's GET.
-- READ by NM OS's Platform Health as crm_readonly. No GRANT is needed: a default privilege on this
-- database gives crm_readonly SELECT on every public table neondb_owner creates (measured
-- 2026-10-23), so apply this AS neondb_owner.
--
-- disco_cron_runs states, kept apart (NM OS docs/collapsed-error-states.md):
--   running  inserted before the handler; still 'running' long after maxDuration means it was killed.
--   ok       the handler returned 2xx/3xx.
--   failed   the handler threw, or returned 5xx or a 4xx other than 409.
--   skipped  the handler returned 409 (another run held the job's lock).
-- A slot with no row at all is a MISSED run, derived from the schedule, never stored.
-- trigger: 'schedule' for Vercel's own calls (user agent vercel-cron), 'manual' for anything else
-- that presents CRON_SECRET. An unauthenticated request writes no row.
--
-- Volume: about 830 rows a day across the 24 scheduled jobs. Retention: runs older than 90 days are
-- deleted by withCronRun itself, at most once a day per server instance (Kevin, 2026-10-23).

CREATE TABLE IF NOT EXISTS disco_cron_runs (
  id           BIGSERIAL PRIMARY KEY,
  cron         TEXT NOT NULL CHECK (btrim(cron) <> ''),
  trigger      TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  state        TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'ok', 'failed', 'skipped')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  http_status  INTEGER,
  -- The full error text, never cut here; the reader cuts it for display.
  error_text   TEXT,
  -- The deployment's commit, so a run can be tied to the code that ran it.
  commit_sha   TEXT,
  CONSTRAINT disco_cron_runs_finished_shape CHECK ((state = 'running') = (finished_at IS NULL))
);

CREATE INDEX IF NOT EXISTS disco_cron_runs_cron_started_idx ON disco_cron_runs (cron, started_at DESC);
-- For the 90-day retention delete, which is not per cron.
CREATE INDEX IF NOT EXISTS disco_cron_runs_started_idx ON disco_cron_runs (started_at);

-- When each cron started being recorded, and the schedule it runs on.
--   since             set once, by the first scheduler-signed call any deployment handles, and never
--                     moved: NM OS counts missed runs from it, so a job Vercel never calls reads missed.
--   schedule          the job's cron expression from this repo's vercel.json, rewritten on every
--                     registration so a schedule change follows the deploy that made it.
--   schedule_seen_at  when a deployment last listed this job. A job removed from vercel.json stops
--                     being refreshed, and NM OS stops showing it once it falls a day behind the rest.
CREATE TABLE IF NOT EXISTS disco_cron_recorded_since (
  cron              TEXT PRIMARY KEY CHECK (btrim(cron) <> ''),
  since             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schedule          TEXT NOT NULL CHECK (btrim(schedule) <> ''),
  schedule_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The deployment's commit that first registered it.
  commit_sha        TEXT
);
