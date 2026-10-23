-- 007_privacy_opt_out_events.sql
-- Browser ad opt-outs (Global Privacy Control, or the /privacy-choices switch) recorded against an
-- email, so NM OS can keep that person out of ad audiences. Written by lib/privacy-opt-out-events.ts;
-- read nightly by NM OS (noise-machine dnc-reconcile, as crm_readonly) into an `ads` do-not-contact
-- suppression. Decided by Kevin, 2026-10-23.
--
-- Append-only: an event is a fact about one moment. Per email, NM OS takes the newest event; an
-- opt_in lifts only when it comes from the diner's own switch (source privacy_choices_switch).
--
-- Additive: one new table, nothing else touched. Applied with a short lock_timeout and read back on
-- a fresh connection. crm_readonly gets SELECT from neondb_owner's default privileges; the GRANT
-- below states it explicitly.

CREATE TABLE IF NOT EXISTS privacy_opt_out_events (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL CHECK (email = LOWER(TRIM(email)) AND email LIKE '%_@_%'),
  kind         TEXT NOT NULL CHECK (kind IN ('opt_out', 'opt_in')),
  source       TEXT NOT NULL CHECK (source IN ('checkout_gpc', 'checkout_switch', 'privacy_choices_switch')),
  order_ref    TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Only the switch can opt back in; a checkout never writes an opt_in.
  CONSTRAINT privacy_opt_out_events_opt_in_source CHECK (kind = 'opt_out' OR source = 'privacy_choices_switch')
);

CREATE INDEX IF NOT EXISTS privacy_opt_out_events_email ON privacy_opt_out_events (email, occurred_at);

GRANT SELECT ON privacy_opt_out_events TO crm_readonly;
