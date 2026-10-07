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
 *   npx tsx scripts/diner-announce-send.ts --canary 50 --dry-run
 *   npx tsx scripts/diner-announce-send.ts --canary 50
 *   npx tsx scripts/diner-announce-send.ts --count 500
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
  const rows = (await sql`
    SELECT DISTINCT ON (lower(f.email)) lower(f.email) AS email, f.first_name
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
    ORDER BY lower(f.email), f.id
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

  const canary = val('--canary')
  const count = val('--count')
  const take = canary ? Number(canary) : count ? Number(count) : 0
  if (!take) { console.error('Specify --status, --test <email>, --canary <n> or --count <n>.'); process.exit(1) }

  const batch = recipients.slice(0, take)
  console.log(`${has('--dry-run') ? 'DRY RUN' : 'SENDING'}: ${batch.length}`)
  if (has('--dry-run')) {
    for (const r of batch) console.log(`   ${r.email.padEnd(42)} Hi ${r.greetingName},`)
    return
  }

  const started = Date.now()
  await runCampaign(batch, {
    profile: DINER_PROFILE,
    onProgress: (o: SendOutcome) => {
      const n = Math.round((Date.now() - started) / 1000)
      console.log(`[${n}s] ${o.status.padEnd(20)} ${o.email}`)
    },
  })
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
