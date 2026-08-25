/**
 * Batch driver for the Sept 30 rebrand announcement.
 *
 * Run it locally, never as a serverless function: the send is deliberately
 * paced at a 30s floor plus jitter, so a 325-recipient day is ~3 hours of
 * wall clock. Every serverless runtime this app deploys to caps out long
 * before that, and a function killed mid-run is the one failure mode the
 * send log exists to make survivable rather than one to court.
 *
 *   npx tsx scripts/rebrand-campaign-send.ts --status
 *   npx tsx scripts/rebrand-campaign-send.ts --plan ~/Desktop/.../day1-plan.txt --dry-run
 *   npx tsx scripts/rebrand-campaign-send.ts --plan ~/Desktop/.../day1-plan.txt
 *   npx tsx scripts/rebrand-campaign-send.ts --count 325
 *
 * WHY BOTH --plan AND --count. Day one is a curated canary: a specific 60
 * chosen for what they will tell us (the risky domains first, then a spread
 * across mail providers), so it is named explicitly in a plan file. Days two
 * and three are "everyone still unsent", which is a count, not a curation.
 * Building only the count mode would have made day one unrepeatable; building
 * only the plan mode would mean hand-maintaining a 325-line file.
 *
 * RESUME IS THE DEFAULT, not a flag. Both modes subtract anyone already in
 * marketing_send_log for this campaign before doing anything else, so:
 *   - re-running an interrupted day sends only the remainder
 *   - re-running a COMPLETED day sends nothing and says so
 *   - `--count 325` on day two never re-touches day one's 60
 * The log is the source of truth for "who has been emailed", and it is written
 * BEFORE Mailgun is called (see claim() in lib/marketing/campaign-send.ts), so
 * a crash between claim and send leaves a row that a re-run skips. That is
 * deliberately biased toward under-sending: a missed recipient is recoverable,
 * a duplicate announcement to a restaurant partner is not.
 */
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import {
  runCampaign, isCampaignHalted, REBRAND_CAMPAIGN,
  CAMPAIGN_FROM, CAMPAIGN_DOMAIN, CAMPAIGN_REPLY_TO, CAMPAIGN_SUBJECT,
  type CampaignRecipient, type SendOutcome,
} from '../lib/marketing/campaign-send'
import { sql, runMigrations } from '../lib/db'

const DEFAULT_CSV = resolve(homedir(), 'Desktop/rebrand-recipient-export/rebrand-recipients.csv')

/**
 * Rows that must never receive this announcement, keyed by email.
 *
 * Hardcoded here rather than fixed in the CSV on purpose: the CSV is an export
 * and will be regenerated, so a fix applied to the file is a fix that a
 * re-export silently undoes. This list travels with the code that sends.
 *
 * All three are test records that leaked into the recipient export. Found by
 * scanning restaurant_name/contact_name for test markers, not by reading 709
 * rows by hand — so treat this as "the ones a scan can find", and re-scan if
 * the CSV is regenerated.
 */
const NEVER_SEND: Record<string, string> = {
  'peteventi@gmail.com': 'internal test account (restaurant_name "Test", contact "Chef Curry")',
  'kfvfjdxqzvjetepeby@cazlp.com': 'test record ("Test Yurii 21-07-2023"), random local-part',
  'nicholas.karoly@gmail.com': 'test record ("Karoly Test Restaurant")',
}

// Deliberately permissive-but-real: rejects the things that actually break a
// send (spaces, commas, missing TLD, bare hostnames) without trying to
// re-implement RFC 5322, which would reject valid addresses.
const EMAIL_RE = /^[^\s@,;:<>"()[\]\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/

/** RFC 4180. Three rows in this CSV carry embedded commas inside quotes, so a
 *  split(',') here is not a shortcut, it is a wrong answer on real data. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); field = ''; if (row.some(x => x !== '')) rows.push(row); row = [] }
    else if (c !== '\r') field += c
  }
  row.push(field)
  if (row.some(x => x !== '')) rows.push(row)
  return rows
}

interface Row extends CampaignRecipient { isRole: boolean }

function loadCsv(path: string): Row[] {
  const rows = parseCsv(readFileSync(path, 'utf8'))
  const head = rows[0].map(h => h.trim())
  const iName = head.indexOf('restaurant_name')
  const iEmail = head.indexOf('email')
  const iGreet = head.indexOf('greeting_name')
  const iRole = head.indexOf('is_role_mailbox')
  if (iEmail < 0 || iGreet < 0) throw new Error(`CSV missing email/greeting_name columns; got: ${head.join(',')}`)
  return rows.slice(1).map(r => ({
    email: r[iEmail].trim().toLowerCase(),
    restaurantName: (r[iName] ?? '').trim(),
    greetingName: (r[iGreet] ?? '').trim(),
    isRole: r[iRole] === 'true',
  }))
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)

async function alreadyLogged(campaign: string): Promise<Map<string, string>> {
  await runMigrations()
  const rows = (await sql`
    SELECT email, outcome FROM marketing_send_log WHERE campaign = ${campaign}
  `) as { email: string; outcome: string }[]
  return new Map(rows.map(r => [r.email.toLowerCase(), r.outcome]))
}

async function main() {
  const campaign = arg('campaign') ?? REBRAND_CAMPAIGN
  const csvPath = arg('csv') ?? DEFAULT_CSV
  const dryRun = has('dry-run')
  const all = loadCsv(csvPath)
  const logged = await alreadyLogged(campaign)

  // ---- --status: report and exit, touching nothing ----
  if (has('status')) {
    const halted = await isCampaignHalted(campaign)
    const byOutcome = [...logged.values()].reduce<Record<string, number>>((a, o) => { a[o] = (a[o] ?? 0) + 1; return a }, {})
    console.log(`campaign        : ${campaign}`)
    console.log(`kill flag       : ${halted ? 'SET — sends will refuse' : 'clear'}`)
    console.log(`CSV rows        : ${all.length} (${Object.keys(NEVER_SEND).length} excluded by NEVER_SEND)`)
    console.log(`log rows        : ${logged.size} ${JSON.stringify(byOutcome)}`)
    console.log(`remaining       : ${all.length - Object.keys(NEVER_SEND).length - logged.size}`)
    return
  }

  // ---- build the target list ----
  const planPath = arg('plan')
  let targets: Row[]
  let mode: string

  if (planPath) {
    const wanted = readFileSync(resolve(planPath.replace(/^~/, homedir())), 'utf8')
      .split('\n').map(l => l.trim().toLowerCase())
      .filter(l => l && !l.startsWith('#'))
    const byEmail = new Map(all.map(r => [r.email, r]))
    const missing = wanted.filter(e => !byEmail.has(e))
    if (missing.length) throw new Error(`plan lists ${missing.length} address(es) absent from the CSV: ${missing.join(', ')}`)
    // Plan order is preserved — day one deliberately sends the risky domains
    // first, so their bounces land early rather than three hours in.
    targets = wanted.map(e => byEmail.get(e)!)
    mode = `plan ${planPath} (${wanted.length} listed)`
  } else {
    const n = Number(arg('count'))
    if (!Number.isFinite(n) || n <= 0) throw new Error('pass --plan <file> or --count <n> (or --status)')
    targets = all.filter(r => !logged.has(r.email) && !NEVER_SEND[r.email]).slice(0, n)
    mode = `count ${n} over CSV order, unsent first`
  }

  // ---- filter and validate ----
  const skippedNeverSend = targets.filter(r => NEVER_SEND[r.email])
  const skippedAlreadySent = targets.filter(r => logged.has(r.email))
  targets = targets.filter(r => !NEVER_SEND[r.email] && !logged.has(r.email))

  const invalid = targets.filter(r => !EMAIL_RE.test(r.email))
  const noGreeting = targets.filter(r => !r.greetingName)
  const seen = new Set<string>()
  const dupes = targets.filter(r => (seen.has(r.email) ? true : (seen.add(r.email), false)))
  const halted = await isCampaignHalted(campaign)

  console.log('=== plan ===')
  console.log(`campaign         : ${campaign}`)
  console.log(`mode             : ${mode}`)
  console.log(`From             : ${CAMPAIGN_FROM}`)
  console.log(`Reply-To         : ${CAMPAIGN_REPLY_TO}`)
  console.log(`domain           : ${CAMPAIGN_DOMAIN}  (key: ${process.env.MAILGUN_CAMPAIGN_API_KEY ? 'MAILGUN_CAMPAIGN_API_KEY' : 'MAILGUN_API_KEY fallback'})`)
  console.log(`subject          : ${CAMPAIGN_SUBJECT}`)
  console.log(`to send          : ${targets.length}`)
  console.log(`  skipped, never-send : ${skippedNeverSend.length}${skippedNeverSend.length ? ' — ' + skippedNeverSend.map(r => r.email).join(', ') : ''}`)
  console.log(`  skipped, already in log : ${skippedAlreadySent.length}`)
  console.log('=== validation ===')
  console.log(`  invalid addresses  : ${invalid.length}${invalid.length ? ' — ' + invalid.map(r => r.email).join(', ') : ''}`)
  console.log(`  duplicates         : ${dupes.length}${dupes.length ? ' — ' + dupes.map(r => r.email).join(', ') : ''}`)
  console.log(`  empty greeting     : ${noGreeting.length}${noGreeting.length ? ' — ' + noGreeting.map(r => r.email).join(', ') : ''}`)
  console.log(`  role / named       : ${targets.filter(r => r.isRole).length} / ${targets.filter(r => !r.isRole).length}`)
  console.log(`  "there" / name     : ${targets.filter(r => r.greetingName === 'there').length} / ${targets.filter(r => r.greetingName !== 'there').length}`)
  console.log(`  kill flag          : ${halted ? 'SET' : 'clear'}`)

  // Hard refusals. Each of these produces a visibly broken message or a
  // duplicate, so none of them is worth "warn and continue".
  if (invalid.length || dupes.length || noGreeting.length) throw new Error('refusing to send: validation failed above')
  if (halted) throw new Error('refusing to send: kill flag is set (clear it with resumeCampaign)')
  if (!targets.length) { console.log('\nnothing to send — every target is already in the log.'); return }
  if (dryRun) { console.log('\n--dry-run: stopping before send.'); return }

  // ---- send ----
  console.log(`\n=== sending ${targets.length} at a 30s floor + up to 15s jitter (~${Math.round(targets.length * 37.5 / 60)} min) ===`)
  const started = Date.now()
  let n = 0
  const outcomes = await runCampaign(targets, {
    campaign,
    onProgress: (o: SendOutcome) => {
      n++
      const el = Math.round((Date.now() - started) / 1000)
      const detail = o.status === 'sent' ? o.messageId : o.status === 'failed' ? o.error : ''
      console.log(`[${String(n).padStart(3)}/${targets.length}] ${String(el).padStart(5)}s  ${o.status.padEnd(20)} ${o.email.padEnd(38)} ${detail ?? ''}`)
    },
  })

  const tally = outcomes.reduce<Record<string, number>>((a, o) => { a[o.status] = (a[o.status] ?? 0) + 1; return a }, {})
  console.log('\n=== result ===')
  console.log(`elapsed : ${Math.round((Date.now() - started) / 1000)}s`)
  console.log(`outcomes: ${JSON.stringify(tally)}`)
  const failed = outcomes.filter(o => o.status === 'failed')
  if (failed.length) { console.log('\nfailures:'); failed.forEach(f => console.log(`  ${f.email}  ${'error' in f ? f.error : ''}`)) }
  // A halt is a clean stop, not a crash — say exactly where it stopped so the
  // rest can be resumed with the same command.
  const haltedAt = outcomes.findIndex(o => o.status === 'halted')
  if (haltedAt >= 0) {
    console.log(`\nHALTED by the kill flag after ${haltedAt} send(s), at ${outcomes[haltedAt].email}.`)
    console.log(`${targets.length - haltedAt} recipient(s) were not attempted. Re-run the same command after clearing the flag; the log makes it resume.`)
  }

  const logAfter = await alreadyLogged(campaign)
  const byOutcome = [...logAfter.values()].reduce<Record<string, number>>((a, o) => { a[o] = (a[o] ?? 0) + 1; return a }, {})
  console.log(`\nsend log now: ${logAfter.size} rows ${JSON.stringify(byOutcome)}`)

  const runPath = resolve(homedir(), `Desktop/rebrand-recipient-export/run-${campaign}-${started}.json`)
  writeFileSync(runPath, JSON.stringify({ campaign, mode, startedAt: new Date(started).toISOString(), tally, outcomes }, null, 1))
  console.log(`run log: ${runPath}`)
}

main().then(() => process.exit(0)).catch(e => { console.error('\n' + (e instanceof Error ? e.message : String(e))); process.exit(1) })
