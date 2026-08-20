// Pacing for any invite-sending loop that fires more than one email. Built after a real
// incident: 14 go-live invite emails went out in a literal 3-second window (a one-off script's
// bare for-loop, no delay anywhere) — a young, low-volume sending domain firing a burst of
// near-identical templated mail is exactly the pattern spam filters are tuned to catch,
// independent of SPF/DKIM/DMARC all being correctly configured (they were).
//
// This is the ONE place that pacing should be implemented -- any future batch-invite driver
// (a real bulk-conversion feature, or another one-off script) should call sendPaced() rather
// than writing its own loop, specifically so the delay isn't something that has to be
// remembered and re-added by hand each time. See inviteFmAuthorizedUsersFor in
// native-conversion.ts for the one place this is wired in today.
//
// NOTE: there is currently no standing multi-restaurant bulk-conversion driver in this
// codebase -- every bulk conversion so far has been a one-off script written per session. If
// one is ever built, it MUST use sendPaced() for the invite-sending step, not a bare loop.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Default spacing for a genuine bulk campaign (many DIFFERENT restaurants/recipients, run
// offline/out of band -- nobody is waiting on an HTTP response). Minutes, not seconds, per the
// incident above. Overridable via BULK_INVITE_DELAY_MS without a code change, since the right
// spacing is a judgment call that should be easy to retune as the sending domain's history
// grows -- see the bulk-conversion ramp design for why this needs to shrink gradually, not be
// picked once and left alone.
const DEFAULT_BULK_INVITE_DELAY_MS = 2 * 60 * 1000

export function bulkInviteDelayMs(): number {
  const override = process.env.BULK_INVITE_DELAY_MS
  const parsed = override ? parseInt(override, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BULK_INVITE_DELAY_MS
}

// Sends each item's email one at a time, sleeping between sends (including after the last —
// simpler than tracking "is this the final item", and a trailing delay before the function
// returns is harmless). sendOne's own failure for one item must never abort the rest: caught
// here so one bad address can't silently stop a whole campaign, matching every other
// best-effort email path in this codebase (ensureRestaurantLoginInvited, etc.).
export async function sendPaced<T>(
  items: T[],
  sendOne: (item: T) => Promise<void>,
  opts?: { delayMs?: number },
): Promise<void> {
  const delayMs = opts?.delayMs ?? bulkInviteDelayMs()
  for (const item of items) {
    try {
      await sendOne(item)
    } catch (e) {
      console.error('[bulk-invite] sendOne failed (continuing with the rest):', e instanceof Error ? e.message : e)
    }
    await sleep(delayMs)
  }
}
