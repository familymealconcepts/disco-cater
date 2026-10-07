// The hours a bulk campaign is allowed to send, in the BUSINESS's zone.
//
// 8:45am–11:00pm Eastern. Outside it the run PAUSES and resumes at the next
// open — it never sends, and it never gives up and exits. A diner opening a
// 3am announcement is a worse impression than one that waits for morning, and
// a burst resuming at a fixed minute is itself a pattern, so resume is jittered
// the same way the per-message gap is.
//
// THE ZONE IS PINNED, NOT THE SERVER'S. Vercel and this laptop disagree about
// local time, and "8:45am" means 8:45am in New York for every operator reading
// the schedule. Computed via Intl rather than an offset constant so DST is
// handled by the platform instead of by arithmetic nobody will revisit in
// November.

export const SEND_TZ = 'America/New_York'
export const WINDOW_OPEN_MIN = 8 * 60 + 45   // 08:45
export const WINDOW_CLOSE_MIN = 23 * 60      // 23:00

/** Minutes past midnight in SEND_TZ for an instant. */
export function zoneMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SEND_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  // Intl can render midnight as hour 24 in some ICU versions; normalise it.
  return (h % 24) * 60 + m
}

export function inSendWindow(now: Date): boolean {
  const m = zoneMinutes(now)
  return m >= WINDOW_OPEN_MIN && m < WINDOW_CLOSE_MIN
}

/**
 * Milliseconds until the window next opens. Zero when it is already open.
 *
 * Derived by stepping minute-by-minute off the ZONE clock rather than by adding
 * a day in UTC: on a DST boundary the gap between two 8:45s is 23 or 25 hours,
 * and an arithmetic answer is wrong twice a year in a way nobody would notice
 * until a run resumed an hour early.
 */
export function msUntilWindowOpen(now: Date): number {
  if (inSendWindow(now)) return 0
  const MIN = 60_000
  for (let i = 1; i <= 24 * 60 + 2; i++) {
    if (inSendWindow(new Date(now.getTime() + i * MIN))) return i * MIN
  }
  return 0
}

/** Human description of the wait, for the log line that explains a pause. */
export function describeWindow(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SEND_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
    month: 'short', day: 'numeric',
  }).format(now)
}
