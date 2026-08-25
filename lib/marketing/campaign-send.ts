import { sql, runMigrations } from '../db'
import { sendEmail } from '../email/send'
import { layout } from '../email/layout'

// The ONE code path every rebrand-announcement email goes through, draft or
// real. A draft that bypasses this proves nothing about the real send, so the
// draft is not a special case: it is this function with a one-row recipient
// list.
//
// WHAT THIS GUARANTEES, and where each guarantee actually comes from:
//   • no double-send — marketing_send_log's PRIMARY KEY (campaign, email). The
//     claim is INSERTed BEFORE Mailgun is called, so a crash between claim and
//     send leaves a 'claimed' row that a re-run skips. The constraint enforces
//     it; the code does not have to be careful.
//   • stoppable mid-run — the kill flag is re-read before EVERY send, not once
//     at start-up, so halting does not require killing the process.
//   • paced — a floor of 30s between sends, jittered. A 14-email burst in 3
//     seconds previously landed in spam (see lib/bulk-invite.ts, which records
//     that incident); identical spacing across hundreds of near-identical
//     messages is itself a pattern, hence the jitter rather than a fixed sleep.
//   • from the warm domain — mg.familymeal.com, via sendEmail's per-send
//     domain override, with its own credential (see resolveKeyFor in send.ts:
//     production's MAILGUN_API_KEY returns 401 Forbidden on that domain).
//   • Kealoha not copied 709 times — skipStandingBcc.
//   • DMARC-aligned, which is the whole point of the From/domain pairing below.
//
// THE FROM ADDRESS AND THE SENDING DOMAIN MUST NOT BE CHANGED INDEPENDENTLY.
// They are one decision, and getting it wrong silently lands the whole send in
// spam rather than failing.
//
//   From:  FamilyMeal <noreply@mg.familymeal.com>   -> From domain mg.familymeal.com
//   DKIM:  krs._domainkey.mg.familymeal.com         -> d=mg.familymeal.com
//   SPF:   envelope noreply@mg.familymeal.com, and mg.familymeal.com publishes
//          "v=spf1 include:mailgun.org ~all"
//
// All three are the SAME domain, so DKIM and SPF both align under strict as
// well as relaxed. mg.familymeal.com publishes no DMARC record of its own, so
// the policy is inherited from familymeal.com by tree-walk:
// "v=DMARC1; p=quarantine" — no adkim/aspf, i.e. relaxed by default. Aligned
// either way.
//
// This mirrors the diner announcement blast of 2026-08-05..07 exactly (3,026
// Mailgun events under tags fm-to-disco-batch2-* / fm-to-disco-batch3-1000-*,
// 2,939 delivered / 66 bounced / 16 failed / 3 complained). Same subject line,
// same From, same domain, same api-key-id (1e0f599c-0cc41c0b). Its
// configuration is recoverable from mailgun_events.raw_payload in
// noise-machine's Neon DB; nothing in either repo sends it, it was an ad-hoc
// script.
//
// WHAT THIS REPLACED, so it is not reintroduced: the From was
// "Disco Cater Concierge <concierge@discocater.com>" while DKIM signed
// mg.familymeal.com. discocater.com and familymeal.com are different
// organizational domains, so neither identifier aligned, DMARC failed, and
// _dmarc.discocater.com's own p=quarantine sent it to the spam folder. A From
// on @discocater.com is only safe over a discocater.com signing domain.

export const REBRAND_CAMPAIGN = 'rebrand-sept-30'
export const CAMPAIGN_DOMAIN = 'mg.familymeal.com'
export const CAMPAIGN_FROM = 'FamilyMeal <noreply@mg.familymeal.com>'
export const CAMPAIGN_SUBJECT = 'FamilyMeal is becoming Disco Cater'

// The diner blast set NO Reply-To (verified: reply-to is null on all 3,024
// stored payloads). This send does, because the audiences differ — a diner
// announcement expects no reply, whereas 709 restaurant partners being told
// their platform is rebranding will reply, and a bare noreply@ From sends every
// one of those into a mailbox nobody reads.
//
// Safe to point at another domain: Reply-To is not an authenticated identifier
// and DMARC does not evaluate it, so this cannot reintroduce the alignment
// failure above. It matches the one contact address the body copy shows.
export const CAMPAIGN_REPLY_TO = 'kealoha@discocater.com'

// Floor, not a target. 30s is the minimum; the jitter only ever adds.
const MIN_GAP_MS = 30_000
const JITTER_MS = 15_000

export interface CampaignRecipient {
  email: string
  restaurantName: string
  greetingName: string
}

export type SendOutcome =
  | { email: string; status: 'sent'; messageId: string | null }
  | { email: string; status: 'skipped-already-sent' }
  | { email: string; status: 'halted' }
  | { email: string; status: 'failed'; error: string }

// APPROVED COPY. The only substitution is the greeting. Do not reword: this
// text was signed off as-is.
//
// showFooter:false because layout()'s boilerplate footer ends in "Questions?
// Contact us at concierge@discocater.com", which duplicated the sign-off's own
// address — rendered together they read as a templating bug.
//
// EXACTLY ONE contact address appears in this body: kealoha@discocater.com, in
// the walkthrough paragraph. That is deliberate and it is now the only one, so
// check both places before adding another — the footer is suppressed, so the
// body is the only thing standing between a noreply@ From and a recipient with
// no way to reach a human.
//
// The sign-off used to repeat concierge@discocater.com underneath "Disco Cater
// Concierge". Dropped: it was the second copy of an address that had already
// been shown, and it is the wrong address to lead with now that the From is
// noreply@mg.familymeal.com — Kealoha is a person who answers, which is what
// the copy is asking them to do.
export function renderCampaignHtml(greetingName: string): string {
  const body = `<p>Hi ${greetingName},</p>
<p>FamilyMeal is rebranding to Disco Cater! The official change happens September 30th.</p>
<p>What this means for you on that date: nothing. Same menus, same orders, same pricing, same payouts. Your customers won't see a change either.</p>
<p>What's worth your time: we've added features since you came on board, and there's more coming with the rebrand. Kealoha is setting up short walkthroughs — email her at kealoha@discocater.com and she'll find a time that works.</p>
<p>Disco Cater Concierge</p>`
  return layout(body, { showFooter: false })
}

/** True when the campaign has been halted. Read before every single send. */
export async function isCampaignHalted(campaign = REBRAND_CAMPAIGN): Promise<boolean> {
  const rows = (await sql`
    SELECT halted_at FROM marketing_campaign_control WHERE campaign = ${campaign} LIMIT 1
  `) as { halted_at: string | null }[]
  return !!rows[0]?.halted_at
}

/** Stop the campaign. Idempotent. */
export async function haltCampaign(by: string, note?: string, campaign = REBRAND_CAMPAIGN): Promise<void> {
  await sql`
    INSERT INTO marketing_campaign_control (campaign, halted_at, halted_by, note, updated_at)
    VALUES (${campaign}, NOW(), ${by}, ${note ?? null}, NOW())
    ON CONFLICT (campaign) DO UPDATE
      SET halted_at = NOW(), halted_by = ${by}, note = ${note ?? null}, updated_at = NOW()
  `
}

/** Clear the halt so a paused campaign can continue. */
export async function resumeCampaign(campaign = REBRAND_CAMPAIGN): Promise<void> {
  await sql`
    INSERT INTO marketing_campaign_control (campaign, halted_at, halted_by, note, updated_at)
    VALUES (${campaign}, NULL, NULL, NULL, NOW())
    ON CONFLICT (campaign) DO UPDATE
      SET halted_at = NULL, halted_by = NULL, note = NULL, updated_at = NOW()
  `
}

// Claim an address. Returns false when it was already claimed — i.e. a previous
// run already sent it, or died mid-send after claiming. Either way this run
// must not send it. ON CONFLICT DO NOTHING makes the check and the claim one
// atomic statement, so two concurrent drivers cannot both win.
async function claim(r: CampaignRecipient, campaign: string): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO marketing_send_log (campaign, email, restaurant_name, greeting_name, outcome)
    VALUES (${campaign}, ${r.email.toLowerCase().trim()}, ${r.restaurantName}, ${r.greetingName}, 'claimed')
    ON CONFLICT (campaign, email) DO NOTHING
    RETURNING email
  `) as { email: string }[]
  return rows.length > 0
}

async function recordResult(
  email: string, campaign: string, outcome: 'sent' | 'failed',
  messageId: string | null, error: string | null,
): Promise<void> {
  await sql`
    UPDATE marketing_send_log
       SET outcome = ${outcome}, message_id = ${messageId}, error = ${error}, sent_at = NOW()
     WHERE campaign = ${campaign} AND email = ${email.toLowerCase().trim()}
  `
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Send the campaign to `recipients`, in order, one at a time.
 *
 * `opts.pace` defaults to true. It is set false ONLY for a single-recipient
 * draft, where there is nothing to pace against — never for a real batch.
 */
export async function runCampaign(
  recipients: CampaignRecipient[],
  opts?: { campaign?: string; pace?: boolean; onProgress?: (o: SendOutcome) => void },
): Promise<SendOutcome[]> {
  const campaign = opts?.campaign ?? REBRAND_CAMPAIGN
  const pace = opts?.pace !== false
  await runMigrations()

  const results: SendOutcome[] = []
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]

    // Re-read before every send, so a halt takes effect on the next message
    // rather than the next run.
    if (await isCampaignHalted(campaign)) {
      const out: SendOutcome = { email: r.email, status: 'halted' }
      results.push(out); opts?.onProgress?.(out)
      break
    }

    if (!(await claim(r, campaign))) {
      const out: SendOutcome = { email: r.email, status: 'skipped-already-sent' }
      results.push(out); opts?.onProgress?.(out)
      continue
    }

    const html = renderCampaignHtml(r.greetingName)
    // text is intentionally NOT passed — sendEmail derives it via htmlToText so
    // the plain part cannot drift from the HTML.
    const res = await sendEmail({
      to: r.email,
      subject: CAMPAIGN_SUBJECT,
      html,
      from: CAMPAIGN_FROM,
      replyTo: CAMPAIGN_REPLY_TO,
      domain: CAMPAIGN_DOMAIN,
      skipStandingBcc: true,
    })

    if (res.success) {
      await recordResult(r.email, campaign, 'sent', res.id ?? null, null)
      const out: SendOutcome = { email: r.email, status: 'sent', messageId: res.id ?? null }
      results.push(out); opts?.onProgress?.(out)
    } else {
      await recordResult(r.email, campaign, 'failed', null, res.error ?? 'unknown')
      const out: SendOutcome = { email: r.email, status: 'failed', error: res.error ?? 'unknown' }
      results.push(out); opts?.onProgress?.(out)
    }

    if (pace && i < recipients.length - 1) {
      await sleep(MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS))
    }
  }
  return results
}
