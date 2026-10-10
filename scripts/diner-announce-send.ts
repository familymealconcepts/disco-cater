/**
 * Batch driver for the diner announcement (campaign key: diner-announce-oct).
 *
 * Same shape and the same guarantees as scripts/rebrand-campaign-send.ts — run
 * it locally, never as a serverless function: the 30s floor plus jitter means
 * 13,776 recipients is roughly 115 hours of wall clock, and a function killed
 * mid-run is the failure the send log exists to survive rather than court.
 *
 *   npx tsx scripts/diner-announce-send.ts --status
 *   npx tsx scripts/diner-announce-send.ts --test peter@discocater.com
 *   npx tsx scripts/diner-announce-send.ts --only /tmp/diner-canary.txt --dry-run
 *   npx tsx scripts/diner-announce-send.ts --only /tmp/diner-canary.txt
 *   npx tsx scripts/diner-announce-send.ts --canary 50 --dry-run
 *   npx tsx scripts/diner-announce-send.ts --canary 50
 *   npx tsx scripts/diner-announce-send.ts --count 500
 *   npx tsx scripts/diner-announce-send.ts --until-close
 *
 * RESUME IS THE DEFAULT. Every mode subtracts anyone already in
 * marketing_send_log for this campaign before doing anything, and claim() writes
 * the row BEFORE Mailgun is called, so a crash between claim and send leaves a
 * row a re-run skips. Biased toward under-sending: a missed diner is
 * recoverable, a duplicate announcement is not.
 *
 * THE AUGUST BLAST HAD NO SEND LOG AT ALL — its recipients are reconstructable
 * only from Mailgun events in noise-machine's Neon DB. That is exactly what this
 * campaign key fixes, and it is why --status reads the log rather than Mailgun.
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import {
  runCampaign, isCampaignHalted, DINER_PROFILE, DINER_CAMPAIGN,
  type CampaignRecipient, type SendOutcome,
} from '../lib/marketing/campaign-send'
import { CampaignHealth } from '../lib/marketing/campaign-health'
import { inSendWindow } from '../lib/marketing/send-window'
import { dinerGreeting } from '../lib/marketing/diner-greeting'
import { sql, runMigrations } from '../lib/db'

const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(f)
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }

/**
 * Addresses that must never receive this, beyond the SQL exclusions below.
 * Hardcoded here rather than fixed upstream for the same reason the restaurant
 * campaign does it: the exclusion query will be re-run, and a fix applied to its
 * output is a fix a re-run silently undoes.
 */
const NEVER_SEND: Record<string, string> = {}

/**
 * Addresses that cannot be delivered to, so sending is pure reputation damage.
 * 12 of the 13,776 — 11 misspelled provider domains and one address with no TLD
 * at all (`...@yahoo`). A bounce costs sender reputation on a domain whose
 * warmth is the reason this campaign uses it, and these are guaranteed bounces.
 */
const TYPO_DOMAINS = /^(gmail\.con|gmai\.com|gmial\.com|gnail\.com|gmail\.co|gamil\.com|tahoo\.com|yaho\.com|yahoo\.con|hotmial\.com|hotmai\.com|comcast\.com|icloud\.con|aol\.con|outlook\.con)$/i
const WELL_FORMED = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i

function deliverable(email: string): boolean {
  if (!WELL_FORMED.test(email)) return false
  return !TYPO_DOMAINS.test(email.split('@')[1] ?? '')
}

/**
 * The eligible remainder.
 *
 * EVERY EXCLUSION IS IN ONE PLACE so the list cannot drift between a dry run and
 * a real one. The bounced/complained set lives in noise-machine's Neon DB
 * (mailgun_events), which this process cannot reach, so it is passed in by the
 * caller rather than guessed at.
 */
async function buildRecipients(excluded: Set<string>): Promise<CampaignRecipient[]> {
  // OLDEST REGISTRATION FIRST. The de-dup picks each address's EARLIEST
  // fm_customers row (created_at ASC inside DISTINCT ON), so someone who
  // registered in 2021 and again in 2025 is placed by their first registration
  // rather than their most recent — otherwise a duplicate row would silently
  // move a long-standing diner to the back of a ten-day queue.
  const rows = (await sql`
    SELECT d.email, d.first_name FROM (
    SELECT DISTINCT ON (lower(f.email)) lower(f.email) AS email, f.first_name, f.created_at
    FROM fm_customers f
    WHERE f.email IS NOT NULL AND f.email <> ''
      -- never a restaurant or system admin, even if they have also ordered as a
      -- diner. 22 addresses are both; this announcement is not addressed to them.
      AND NOT EXISTS (SELECT 1 FROM disco_restaurant_accounts a WHERE lower(a.email) = lower(f.email))
      AND NOT EXISTS (SELECT 1 FROM marketing_email_opt_outs o WHERE lower(o.email) = lower(f.email))
      AND NOT EXISTS (SELECT 1 FROM disco_customers c WHERE lower(c.email) = lower(f.email) AND c.disabled_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM marketing_send_log s WHERE s.campaign = ${DINER_CAMPAIGN} AND s.email = lower(f.email))
      -- internal and test addresses
      AND f.email NOT ILIKE '%@familymeal.com'
      AND f.email NOT ILIKE '%@discocater.com'
      AND f.email NOT ILIKE '%+test%'
      AND f.email NOT ILIKE 'test%'
      AND f.email NOT ILIKE '%@example.%'
      AND f.email NOT ILIKE '%@test.%'
    ORDER BY lower(f.email), f.created_at ASC, f.id
    ) d
    ORDER BY d.created_at ASC, d.email
  `) as { email: string; first_name: string | null }[]

  return rows
    .filter(r => !excluded.has(r.email) && !NEVER_SEND[r.email] && deliverable(r.email))
    .map(r => ({
      email: r.email,
      restaurantName: '',                       // column is campaign-agnostic; unused here
      greetingName: dinerGreeting(r.first_name),
    }))
}

async function main() {
  await runMigrations()

  // Already-emailed (August) and ever-bounced live in noise-machine's DB. The
  // caller exports them to a file; refusing to run without it is deliberate —
  // silently sending to a bounced address is how a warm domain stops being warm.
  const exclusionFile = val('--exclusions') ?? '/tmp/diner-exclusions.txt'
  let excluded = new Set<string>()
  try {
    const { readFileSync } = await import('fs')
    excluded = new Set(readFileSync(exclusionFile, 'utf8').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean))
  } catch {
    console.error(`Could not read ${exclusionFile}. It must hold every address already emailed in August and every address that has ever bounced, failed or complained — one per line. Refusing to build a list without it.`)
    process.exit(1)
  }
  console.log(`exclusions loaded: ${excluded.size}`)

  const recipients = await buildRecipients(excluded)
  console.log(`eligible recipients: ${recipients.length}`)

  if (has('--status')) {
    const log = (await sql`
      SELECT outcome, COUNT(*)::int AS n FROM marketing_send_log
      WHERE campaign = ${DINER_CAMPAIGN} GROUP BY outcome ORDER BY outcome
    `) as { outcome: string; n: number }[]
    console.log(`halted: ${await isCampaignHalted(DINER_CAMPAIGN)}`)
    console.log(log.length ? log.map(r => `  ${r.outcome}: ${r.n}`).join('\n') : '  (nothing sent yet)')
    const named = recipients.filter(r => r.greetingName !== 'there').length
    console.log(`greeting: ${named} by name, ${recipients.length - named} as "there"`)
    return
  }

  // ONE address, through the real send path. Not paced — there is nothing to
  // pace against — and logged under a key that is UNIQUE PER RUN.
  //
  // Unique because claim() is the campaign's duplicate guard: a fixed test key
  // means the second test of the day returns "skipped-already-sent" and silently
  // sends nothing, which is exactly what happened on the first copy revision.
  // The real campaign key is never touched, so a test can never consume a real
  // recipient's slot.
  const testTo = val('--test')
  if (testTo) {
    const sample = recipients.find(r => r.greetingName !== 'there')
    const out = await runCampaign(
      [{ email: testTo, restaurantName: '', greetingName: sample?.greetingName ?? 'there' }],
      { profile: DINER_PROFILE, campaign: `${DINER_CAMPAIGN}-test-${Date.now()}`, pace: false },
    )
    console.log(JSON.stringify(out, null, 2))
    return
  }

  const only = val('--only')
  const canary = val('--canary')
  const count = val('--count')
  // SEND UNTIL THE WINDOW CLOSES, rather than to a per-day number.
  //
  // The batch becomes every remaining recipient and the 8:45am-11:00pm ET gate
  // decides when sending happens: at 11:00pm the loop pauses, at 8:45am it
  // resumes, and it keeps going until the list is exhausted. A day's output is
  // therefore however many messages the window holds at the unchanged pace,
  // not a cap chosen in advance.
  //
  // THIS CHANGES HOW LONG WE SEND FOR, NEVER HOW FAST. MIN_GAP_MS (30s) and
  // JITTER_MS (15s) are untouched, so a longer day means more messages, never
  // quicker ones. Every halt condition is likewise untouched and still read
  // between messages.
  const untilClose = has('--until-close')
  const take = canary ? Number(canary) : count ? Number(count) : 0
  if (!only && !take && !untilClose) { console.error('Specify --status, --test <email>, --only <file>, --canary <n>, --count <n> or --until-close.'); process.exit(1) }

  // A CURATED batch, for a canary picked by hand rather than by list order.
  //
  // It NARROWS the eligible list and can never widen it: every address is
  // looked up in `recipients`, so the opt-out, restaurant-admin, disabled,
  // already-sent, internal/test and undeliverable-domain exclusions all still
  // apply. An address in the file that is not eligible is REPORTED and skipped
  // rather than sent — the file is a selection, not an override, and a curated
  // list is exactly where an override would do the most damage.
  let batch: CampaignRecipient[]
  if (only) {
    const { readFileSync } = await import('fs')
    const wanted = readFileSync(only, 'utf8').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean)
    const byEmail = new Map(recipients.map(r => [r.email, r]))
    const missing: string[] = []
    batch = []
    for (const w of wanted) {
      const hit = byEmail.get(w)
      if (hit) batch.push(hit)
      else missing.push(w)
    }
    console.log(`curated list ${only}: ${wanted.length} requested, ${batch.length} eligible, ${missing.length} skipped`)
    for (const m of missing) console.log(`   skipped (not in the eligible set): ${m}`)
  } else if (untilClose) {
    batch = recipients
  } else {
    batch = recipients.slice(0, take)
  }
  console.log(`${has('--dry-run') ? 'DRY RUN' : 'SENDING'}: ${batch.length}${untilClose ? ' (until the window closes each day, until the list is exhausted)' : ''}`)
  if (has('--dry-run')) {
    for (const r of batch) console.log(`   ${r.email.padEnd(42)} Hi ${r.greetingName},`)
    return
  }

  const started = Date.now()

  // The automatic halts. Measured against THIS run's events only, via the
  // profile's o:tag, so yesterday's numbers cannot mask today's problem.
  const key = process.env.MAILGUN_API_KEY
  if (!key) { console.error('MAILGUN_API_KEY is not set — refusing to run without the health checks.'); process.exit(1) }
  // LOOK BACK 24 HOURS, not to this process's start. The bounce rule measures
  // the last 200 sends, and a run that began its own window at zero would need
  // 100 fresh sends before the rule could fire again — so every restart would
  // disarm the protection for the first 100 messages. At ~1,300 a day, 24 hours
  // comfortably covers 200 sends while bounding what the poll has to page.
  // --ack-complaints is GONE. It existed only to resume past a complaint the
  // zero-tolerance rule had halted on; complaints are now judged as a rate, so
  // there is nothing to acknowledge and two overlapping controls would be one
  // too many. A genuinely bad rate stops the run on its own.
  const health = new CampaignHealth(
    DINER_PROFILE.tag!, DINER_PROFILE.domain, Math.floor(started / 1000) - 24 * 3600,
  )

  console.log(`send window is currently ${inSendWindow(new Date()) ? 'OPEN' : 'CLOSED (the run will wait)'}`)

  const out = await runCampaign(batch, {
    profile: DINER_PROFILE,
    window: true,
    health,
    healthEvery: 20,
    mailgunKey: key,
    onProgress: (o: SendOutcome) => {
      const n = Math.round((Date.now() - started) / 1000)
      const extra = o.status === 'auto-halted' ? ` :: ${(o as { reason: string }).reason}` : ''
      console.log(`[${n}s] ${o.status.padEnd(20)} ${o.email}${extra}`)
    },
  })

  const sent = out.filter(o => o.status === 'sent').length
  const failed = out.filter(o => o.status === 'failed').length
  const halted = out.find(o => o.status === 'auto-halted') as { reason: string } | undefined
  console.log(`\n--- run summary ---`)
  console.log(`sent: ${sent}  failed: ${failed}  elapsed: ${Math.round((Date.now() - started) / 60000)} min`)
  console.log(`health: ${JSON.stringify(health.snapshot())}`)
  if (halted) console.log(`AUTO-HALTED: ${halted.reason}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
