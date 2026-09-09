/**
 * Day-1 conversion invites: 40 sends, 30s stagger, biggest admins first.
 *
 * Sequenced by restaurant count DESCENDING on purpose — the multi-location
 * admins land first, so a deliverability problem shows up on the highest-value
 * recipients while there is still time to stop, rather than after 39 sends to
 * single-site owners.
 *
 * Role and location assignment both come from FM (readUserAssignment), never
 * from the email address and never from the authorized-users membership list,
 * which over-reports the whole chain per location.
 *
 * Appends one line per recipient so an interrupted run cannot lose its record.
 */
import { readFileSync } from 'fs'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { sql } from '../lib/db'
import { CREATED_BY_CONVERSION } from '../lib/native-conversion'
import { setInviteToken, getAccountByInviteToken } from '../lib/disco-restaurant-auth'
import { sendEmail } from '../lib/email/send'
import { layout, button } from '../lib/email/layout'
import { readProgress, appendProgress } from '../lib/run-progress'

const LOG = 'data/conversion-invites.jsonl'
const BATCH = Number(process.argv[2] || '40')
const STAGGER_MS = 30_000

;(async () => {
  const people = JSON.parse(readFileSync('/tmp/invite-final.json', 'utf8')) as {
    email: string; role: string; firstName: string | null; greeting: string; names: string[]
  }[]
  const targets = JSON.parse(readFileSync('/tmp/invite-targets.json', 'utf8')) as { name: string; ref: string }[]
  const refByName = new Map(targets.map(t => [t.name, t.ref]))

  const already = readProgress(LOG)
  const queue = people
    .filter(p => !already[p.email])
    .sort((a, b) => b.names.length - a.names.length || a.email.localeCompare(b.email))
    .slice(0, BATCH)

  console.log(`invite queue ${people.length} | already sent ${Object.keys(already).length} | this batch ${queue.length}`)
  let n = 0
  for (const p of queue) {
    n++
    if (n > 1) await new Promise(r => setTimeout(r, STAGGER_MS))
    const refs = p.names.map(nm => refByName.get(nm)).filter((r): r is string => !!r)
    const rec: Record<string, unknown> = { ref: p.email, email: p.email, role: p.role, locations: refs.length }
    try {
      const pre = await sql`SELECT id FROM disco_restaurant_accounts WHERE email = ${p.email}` as unknown[]
      if (!pre.length) {
        const sentinel = bcrypt.hashSync(randomUUID(), 10)
        await sql`
          INSERT INTO disco_restaurant_accounts
            (email, password_hash, restaurant_reference, fm_restaurant_reference, first_name, restaurant_name, role, created_by)
          VALUES (${p.email}, ${sentinel}, ${refs[0]}, ${refs[0]}, ${p.firstName}, ${p.names[0]}, ${p.role}, ${CREATED_BY_CONVERSION})`
        rec.accountCreated = true
      }
      for (const r of refs) {
        await sql`INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
                  VALUES (${p.email}, ${r}, ${CREATED_BY_CONVERSION}) ON CONFLICT DO NOTHING`
      }
      const token = await setInviteToken(p.email)
      const cold = await getAccountByInviteToken(token)
      if (!cold || cold.email !== p.email) {
        rec.sent = false; rec.error = 'cold verify failed'
        appendProgress(LOG, rec as { ref: string }); console.log(`${n}. ${p.email} COLD VERIFY FAILED`); continue
      }
      const url = `https://www.discocater.com/restaurant/accept-invite?token=${token}`
      const scope = refs.length === 1 ? p.names[0] : `${refs.length} locations`
      const content = `
<p>${p.greeting}</p>
<p>You&rsquo;re now live on Disco Cater &mdash; ${scope}.</p>
<p>To get in, set a new password.</p>
${button('Set your password', url)}
<p>The link is good for 14 days &mdash; reply if you need a new one.</p>
<p>Disco Cater Concierge<br/><a href="mailto:concierge@discocater.com" style="color:#5B6FE8;">concierge@discocater.com</a></p>`
      const res = await sendEmail({
        to: p.email, subject: 'You’re live on Disco Cater', html: layout(content),
        from: 'Disco Cater Concierge <concierge@discocater.com>',
        replyTo: 'Disco Cater Concierge <concierge@discocater.com>', domain: 'mg.discocater.com',
      })
      rec.sent = res.success; rec.messageId = res.id ?? null; if (!res.success) rec.error = res.error
      appendProgress(LOG, rec as { ref: string })
      console.log(`${String(n).padStart(2)}. ${p.email.padEnd(36)} ${String(p.role).padEnd(13)} ${String(refs.length).padStart(2)} loc  ${res.success ? 'SENT ' + res.id : 'FAILED ' + res.error}`)
    } catch (e) {
      rec.sent = false; rec.error = e instanceof Error ? e.message : String(e)
      appendProgress(LOG, rec as { ref: string })
      console.log(`${n}. ${p.email} THREW ${rec.error}`)
    }
  }
  const all = Object.values(readProgress(LOG)) as { sent?: boolean }[]
  console.log(`\nlog holds ${all.length} | sent ${all.filter(x => x.sent).length} | failed ${all.filter(x => !x.sent).length}`)
  process.exit(0)
})()
