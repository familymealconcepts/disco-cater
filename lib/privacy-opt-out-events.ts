import { sql } from './db'

// Browser ad opt-outs, recorded against an email so NM OS can keep the person out of ad
// audiences (Google Customer Match). Table: lib/migrations/008_privacy_opt_out_events.sql.
//
// The opt-out itself (Global Privacy Control or the /privacy-choices switch) lives only in the
// visitor's browser (lib/privacy-choices.ts). This is where it meets an email:
//   - a checkout placed with GPC or the switch on writes an opt_out (app/api/order/place)
//   - a signed-in diner turning the switch on or off on /privacy-choices writes an opt_out or an
//     opt_in (app/api/privacy-choices)
// NM OS reads the table nightly (noise-machine src/lib/doNotContactSync.ts, importBrowserOptOuts)
// and turns an opt_out into an `ads` do-not-contact suppression. Only an opt_in from the switch
// lifts one; a later checkout without GPC never does (Kevin, 2026-10-23).
//
// Append-only. A write is best-effort and must never fail or delay an order: every caller runs it
// inside waitUntil, and this function swallows its own errors.

export type OptOutSource = 'checkout_gpc' | 'checkout_switch' | 'privacy_choices_switch'
export type OptOutKind = 'opt_out' | 'opt_in'

/**
 * Which opt-out a checkout carries, or null. GPC is read from the request header, so it needs
 * nothing from the browser; the switch only exists in localStorage, so the checkout sends
 * `privacyOptOut: true` for it. GPC wins when both are present.
 */
export function checkoutOptOutSource(secGpcHeader: string | null, bodyFlag: unknown): OptOutSource | null {
  if (secGpcHeader?.trim() === '1') return 'checkout_gpc'
  if (bodyFlag === true) return 'checkout_switch'
  return null
}

/** The distinct, normalized addresses an event should be recorded for; empty strings dropped. */
export function optOutEmails(...emails: Array<unknown>): string[] {
  const out = new Set<string>()
  for (const e of emails) {
    if (typeof e !== 'string') continue
    const n = e.trim().toLowerCase()
    if (n.includes('@')) out.add(n)
  }
  return [...out]
}

export async function recordPrivacyOptOutEvents(ev: { emails: string[]; kind: OptOutKind; source: OptOutSource; orderRef?: string | null }): Promise<void> {
  for (const email of ev.emails) {
    try {
      await sql`
        INSERT INTO privacy_opt_out_events (email, kind, source, order_ref)
        VALUES (${email}, ${ev.kind}, ${ev.source}, ${ev.orderRef ?? null})
      `
    } catch (e) {
      console.error('[privacy-opt-out] record failed (non-fatal):', e instanceof Error ? e.message : e)
    }
  }
}
