// The merge-boundary normalizer for any Postgres timestamp a route hands back
// to the client alongside (or compared against) FM-sourced data. FM's own JSON
// timestamps always arrive UTC-with-"Z" (e.g. "2026-08-14T16:10:16.965Z"). A
// bare to_char(col, 'YYYY-MM-DD"T"HH24:MI:SS') — the pattern this replaces —
// produces real UTC digits with no marker, and a client-side Date.parse() on a
// timezone-designator-free ISO string is interpreted as LOCAL time, not UTC.
// Confirmed to silently break sort order when such a value is ever compared
// against a real "Z"-suffixed FM timestamp (admin Orders list, 2026-08-14).
//
// Use this at the point two sources are combined for the client — never
// to_char() a timestamp for JSON output, and never assume the driver's raw
// return shape (a JS Date, an ISO string, or a Postgres "YYYY-MM-DD HH:MM:SS"
// string without "Z" are all handled the same way here).
export function toClientIso(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
