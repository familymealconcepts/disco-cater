/**
 * Reconcile dispatched invites against Mailgun's actual delivery events.
 *
 * The send log records DISPATCH — Mailgun accepting the message. That is not
 * the mailbox taking it: on 2026-09-09, three of six bounces arrived AFTER a
 * `delivered` event, so any success count read at send time overstates.
 *
 * DEADLINE. Mailgun event retention is only ~4-5 days (measured 2026-09-10:
 * earliest visible event 09-06 on mg.discocater.com, 09-05 on
 * mg.familymeal.com). Run this within that window or the evidence is gone —
 * which is exactly why the 2026-08-27 invites can no longer be verified.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import * as fs from 'fs'

const RUN = process.argv.find(a => a.startsWith('--run='))?.split('=')[1] ?? 'outstanding-2026-09-10'
const KEY = process.env.MAILGUN_API_KEY!
const auth = { Authorization: 'Basic ' + Buffer.from(`api:${KEY}`).toString('base64') }
const INVITE_RE = /you.?re live|invite|welcome/i

async function events(domain: string, rcpt: string) {
  try {
    const r = await fetch(`https://api.mailgun.net/v3/${domain}/events?recipient=${encodeURIComponent(rcpt)}&limit=300`, { headers: auth })
    if (!r.ok) return []
    const d = await r.json() as { items?: Record<string, unknown>[] }
    return d.items ?? []
  } catch { return [] }
}

async function main() {
  const sent = fs.readFileSync('data/conversion-invites.jsonl', 'utf8').split('\n')
    .filter(Boolean).map(l => JSON.parse(l)).filter(j => j.run === RUN)
  console.log(`run "${RUN}": ${sent.length} dispatch rows`)

  const out: Record<string, string[]> = {}
  for (const s of sent) {
    const em = String(s.email).toLowerCase()
    const all = [...await events('mg.discocater.com', em), ...await events('mg.familymeal.com', em)]
    const mine = all.filter((e) => {
      const ev = e as { timestamp: number; message?: { headers?: { subject?: string } } }
      return INVITE_RE.test(String(ev.message?.headers?.subject ?? '')) && ev.timestamp * 1000 >= new Date(s.at).getTime() - 120_000
    })
    const kinds = [...new Set(mine.map(e => String((e as { event: string }).event).toLowerCase()))]
    let verdict = 'NO MAILGUN RECORD'
    if (kinds.includes('failed') || kinds.includes('rejected')) verdict = 'BOUNCED'
    else if (kinds.includes('delivered')) verdict = 'DELIVERED'
    else if (kinds.includes('accepted')) verdict = 'ACCEPTED (not yet delivered)'
    ;(out[verdict] ??= []).push(`${s.email} | ${s.restaurant} | day ${s.day}`)
  }
  console.log('\n=== RECONCILED DELIVERY ===')
  for (const [v, rows] of Object.entries(out).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${v} — ${rows.length}`)
    for (const r of rows) console.log(`  ${r}`)
  }
}
main().catch(e => { console.error(e.message); process.exit(1) })
