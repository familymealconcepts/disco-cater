/**
 * Bulk re-invite for converted restaurants whose users have never held a Disco
 * session — the population that falls through to FM at login and edits
 * FamilyMeal instead of Disco.
 *
 * Sends through inviteAccountByEmail (lib/native-conversion.ts), the same
 * mint+send ensureRestaurantLoginInvited uses. No parallel send path.
 *
 * NEVER TOUCHES FAMILYMEAL.
 *
 *   --day=1|2     which half to send (see the split below)
 *   --apply       actually send; omit for a dry run
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { inviteAccountByEmail } from '../lib/native-conversion'
import * as fs from 'fs'

const LOG = 'data/conversion-invites.jsonl'
const STAGGER_MS = 30_000
const APPLY = process.argv.includes('--apply')
const DAY = Number((process.argv.find(a => a.startsWith('--day=')) || '--day=1').split('=')[1])

// Mailgun shows these hard-bouncing on 2026-09-09. Sending again spends
// reputation for nothing; they need a different contact.
const HARD_BOUNCED = new Set([
  'eat@bingebiryani.com', 'alvin@brooklyndumpling.com', 'store042@gmail.com',
  'ido@landwercafe.com', 'jackson@eatcops.com', 'justin@eatcops.com',
])
// Delivered 2026-09-09 17:54:29, token cleared and password set 18:18 — the
// signature of an ACCEPTED invite (acceptInvite nulls the token and writes
// password_hash). Setup is already complete; re-inviting would mint a new
// token over a finished account.
const ALREADY_ACCEPTED = new Set(['skaawach@yahoo.com'])

async function main() {
  const rows = (await sql`
    SELECT c.name AS restaurant, c.restaurant_reference AS ref, a.email, COALESCE(a.role,'ADMIN') role,
           a.created_at::text created
    FROM disco_restaurant_cache c
    JOIN disco_restaurant_accounts a ON a.restaurant_reference = c.restaurant_reference
    WHERE c.is_disco_native = true AND a.archived_at IS NULL
      AND a.email NOT LIKE 'stripe-import+%'
      AND NOT EXISTS (SELECT 1 FROM disco_restaurant_sessions s WHERE s.email = a.email)
    ORDER BY c.name, a.created_at ASC
  `) as { restaurant: string; ref: string; email: string; role: string; created: string }[]

  const skipped: { email: string; restaurant: string; reason: string }[] = []
  const eligible = rows.filter(r => {
    const e = r.email.toLowerCase()
    if (HARD_BOUNCED.has(e)) { skipped.push({ ...r, reason: 'hard-bounced 2026-09-09 — needs a different contact' }); return false }
    if (ALREADY_ACCEPTED.has(e)) { skipped.push({ ...r, reason: 'invite already accepted (token consumed, password set)' }); return false }
    return true
  })

  // THE SPLIT. Day 1 = each restaurant's FIRST account, so all 68 restaurants
  // hear once. Day 2 = every remaining account. This also spaces a restaurant's
  // own accounts by a DAY rather than seconds — five simultaneous "you're live"
  // emails to one team reads as a malfunction.
  const seen = new Set<string>()
  const day1: typeof eligible = [], day2: typeof eligible = []
  for (const r of eligible) { if (seen.has(r.ref)) day2.push(r); else { seen.add(r.ref); day1.push(r) } }
  const batch = DAY === 1 ? day1 : day2

  const already = new Set<string>()
  if (fs.existsSync(LOG)) for (const l of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try { const j = JSON.parse(l); if (j.run === 'outstanding-2026-09-10') already.add(String(j.email).toLowerCase()) } catch {}
  }
  const todo = batch.filter(r => !already.has(r.email.toLowerCase()))

  console.log(`eligible ${eligible.length} | day1 ${day1.length} | day2 ${day2.length} | skipped ${skipped.length}`)
  console.log(`DAY ${DAY}: ${batch.length} in batch, ${already.size} already sent this run, ${todo.length} to send`)
  console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}  stagger ${STAGGER_MS / 1000}s  est ${Math.round(todo.length * STAGGER_MS / 60000)} min`)
  console.log('\nskipped:')
  for (const s of skipped) console.log(`  ${s.email.padEnd(34)} ${s.restaurant} — ${s.reason}`)
  if (!APPLY) {
    console.log(`\n=== DRY RUN — day ${DAY} order ===`)
    todo.forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}  ${r.email.padEnd(38)} ${r.role.padEnd(13)} ${r.restaurant}`))
    return
  }

  let ok = 0, fail = 0
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i]
    let res: { invited: boolean; reason: string }
    try { res = await inviteAccountByEmail(r.email, r.restaurant) }
    catch (e) { res = { invited: false, reason: `threw: ${e instanceof Error ? e.message : e}` } }
    // DISPATCH, not delivery. Mailgun accepting a message is not the same as
    // the mailbox taking it — three of the 2026-09-09 bounces arrived AFTER a
    // delivered event. Reconciled separately against Mailgun.
    fs.appendFileSync(LOG, JSON.stringify({
      run: 'outstanding-2026-09-10', day: DAY, ref: r.ref, restaurant: r.restaurant,
      email: r.email, role: r.role, dispatched: res.invited, reason: res.reason,
      at: new Date().toISOString(),
    }) + '\n')
    res.invited ? ok++ : fail++
    console.log(`  [${i + 1}/${todo.length}] ${res.invited ? 'dispatched' : 'FAILED    '}  ${r.email}  (${r.restaurant})`)
    if (i < todo.length - 1) await new Promise(s => setTimeout(s, STAGGER_MS))
  }
  console.log(`\nday ${DAY} complete: ${ok} dispatched, ${fail} failed`)
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1) })
