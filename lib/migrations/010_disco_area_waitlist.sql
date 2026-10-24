-- 010_disco_area_waitlist.sql
-- "Notify me" sign-ups from /fullmap when a location search finds no restaurant within 25 miles
-- (Kevin, items #40 and #45, 2026-10-23). Written by the waitlist route; read by the daily notify job,
-- which sends ONE email per sign-up the first time a restaurant appears within 25 miles of the
-- searched point, then stamps notified_at. Nothing else is ever sent to these addresses from here.
--
-- Purpose-limited: not a marketing list. No marketing opt-in is collected, and nothing here is copied
-- into marketing_email_opt_outs or any campaign list. The notify job checks NM OS's do-not-contact list
-- (lib/marketing/nm-do-not-contact.ts, fails closed) and marketing_email_opt_outs before sending.
--
-- Data kept to what the promise needs: the email, what they searched (shown back to them in the email)
-- and its coordinates (to match restaurants), which version of the approved copy they saw, and the
-- notification outcome. No IP address, no user agent.
--
-- Privacy requests: NM OS exports and deletes rows here by email (SELECT through crm_readonly, below;
-- the deletion path is a separate item). A deleted row is gone, not flagged.
--
-- Additive: one new table and its indexes, nothing else touched. Applied with a short lock_timeout and
-- read back on a fresh connection.

CREATE TABLE IF NOT EXISTS disco_area_waitlist (
  id                     BIGSERIAL PRIMARY KEY,
  email                  TEXT NOT NULL CHECK (email = LOWER(TRIM(email)) AND email LIKE '%_@_%'),
  place_label            TEXT NOT NULL CHECK (length(trim(place_label)) BETWEEN 1 AND 200),
  lat                    DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                    DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  -- Which approved wording the visitor saw when signing up (e.g. 'item-45-2026-10-23').
  copy_version           TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'fullmap' CHECK (source IN ('fullmap')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set once, when the one email is sent; the sign-up is then closed.
  notified_at            TIMESTAMPTZ,
  notified_restaurant    TEXT,
  CONSTRAINT disco_area_waitlist_notified_pair CHECK ((notified_at IS NULL) = (notified_restaurant IS NULL))
);

-- One OPEN sign-up per email and searched place: signing up twice for the same place is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS disco_area_waitlist_open_unique
  ON disco_area_waitlist (email, lower(place_label)) WHERE notified_at IS NULL;

-- The notify job reads the open sign-ups.
CREATE INDEX IF NOT EXISTS disco_area_waitlist_open ON disco_area_waitlist (created_at) WHERE notified_at IS NULL;

-- Privacy-request lookups by email.
CREATE INDEX IF NOT EXISTS disco_area_waitlist_email ON disco_area_waitlist (email);

GRANT SELECT ON disco_area_waitlist TO crm_readonly;
