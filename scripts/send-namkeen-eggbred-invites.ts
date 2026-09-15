/**
 * Backfill invites for the 27 Namkeen + EggBred conversions.
 *
 * Those runs used skipInvites, which skipped the WHOLE authorized-users step —
 * so no accounts, no grants and no emails. Accounts and grants were created
 * first; this sends the invites.
 *
 * Membership came from readUserAssignment ONLY, never FM's authorized-users
 * list: that list claimed 555 person-restaurant pairs across this cohort where
 * FM actually assigns 158. Believing it would have written 397 excess grants.
 *
 * One email per PERSON, not per restaurant. Ordering round-robins across
 * restaurants so no single team receives several sends back to back.
 * Dispatch is recorded, never treated as delivery — reconcile against Mailgun
 * afterwards.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import fs from 'fs'
import { setInviteToken, getAccountByInviteToken } from '../lib/disco-restaurant-auth'
import { sendEmail } from '../lib/email/send'
import { layout, button } from '../lib/email/layout'
import { appendProgress, readProgress } from '../lib/run-progress'

const LOG = 'data/conversion-invites.jsonl'
const RUN = 'namkeen-eggbred-backfill-2026-09-14'
const STAGGER_MS = 30_000

// Known hard bounces + Mailgun suppression hits carried forward from prior runs.
const HARD_BOUNCED = new Set([
  'eat@bingebiryani.com', 'alvin@brooklyndumpling.com', 'store042@gmail.com',
  'ido@landwercafe.com', 'jackson@eatcops.com', 'justin@eatcops.com',
  'fhunter@burgerfi.com', 'anthie@thenccgroup.com', 'chef+30@gmail.com',
  'nhojel@theoberon.co',
])

;(async () => {
  const people = JSON.parse(fs.readFileSync('/tmp/nk-ready.json', 'utf8')) as {
    email: string; role: string; firstName: string | null; grantRefs: string[]
  }[]
  const rs = JSON.parse(fs.readFileSync('/tmp/nk-restaurants.json', 'utf8')) as { ref: string; name: string }[]
  const nameByRef = new Map(rs.map(r => [r.ref, r.name]))
  const suppressed = new Set(JSON.parse(fs.readFileSync('/tmp/nk-suppressed.json', 'utf8')) as string[])

  const already = readProgress(LOG)
  // Round-robin by primary restaurant so teammates are spread across the run.
  const buckets = new Map<string, typeof people>()
  for (const p of people) {
    const k = p.grantRefs[0]
    const b = buckets.get(k) ?? []
    b.push(p); buckets.set(k, b)
  }
  const queue: typeof people = []
  for (let i = 0; queue.length < people.length; i++) {
    for (const b of buckets.values()) if (b[i]) queue.push(b[i])
  }

  let dispatched = 0, skipped = 0
  let n = 0
  for (const p of queue) {
    const e = p.email.toLowerCase()
    // `ref` is the progress KEY (readProgress indexes on it) and this run is one
    // record per PERSON, so it must be the email — keying it by restaurant made
    // teammates overwrite each other and made the resume check below never match.
    const rec: Record<string, unknown> = {
      run: RUN, ref: p.email, restaurantReference: p.grantRefs[0],
      restaurant: nameByRef.get(p.grantRefs[0]) ?? null,
      email: p.email, role: p.role, locations: p.grantRefs.length,
    }
    if (already[p.email]) { skipped++; continue }
    if (HARD_BOUNCED.has(e)) {
      rec.dispatched = false; rec.reason = 'hard-bounced previously — needs a different contact'
      appendProgress(LOG, rec as { ref: string }); skipped++
      console.log(`SKIP  ${p.email} hard-bounced`); continue
    }
    if (suppressed.has(e)) {
      rec.dispatched = false; rec.reason = 'on a Mailgun suppression list — would consume a slot and never arrive'
      appendProgress(LOG, rec as { ref: string }); skipped++
      console.log(`SKIP  ${p.email} suppressed`); continue
    }

    n++
    if (n > 1) await new Promise(r => setTimeout(r, STAGGER_MS))
    try {
      // FRESH 30-day token every send — never a stored one.
      const token = await setInviteToken(p.email)
      const cold = await getAccountByInviteToken(token)
      if (!cold || cold.email.toLowerCase() !== e) {
        rec.dispatched = false; rec.reason = 'cold verify failed — token not readable back'
        appendProgress(LOG, rec as { ref: string }); skipped++
        console.log(`FAIL  ${p.email} cold verify`); continue
      }
      const url = `https://www.discocater.com/restaurant/accept-invite?token=${token}`
      const scope = p.grantRefs.length === 1
        ? (nameByRef.get(p.grantRefs[0]) ?? 'your restaurant')
        : `${p.grantRefs.length} locations`
      const greeting = p.firstName ? `Hi ${p.firstName},` : 'Hi,'
      const content = `
<p>${greeting}</p>
<p>You&rsquo;re now live on Disco Cater &mdash; ${scope}.</p>
<p>To get in, set a password.</p>
${button('Set your password', url)}
<p>The link is good for 30 days &mdash; reply if you need a new one.</p>
<p>Disco Cater Concierge<br/><a href="mailto:concierge@discocater.com" style="color:#5B6FE8;">concierge@discocater.com</a></p>`
      const res = await sendEmail({
        to: p.email, subject: 'You’re live on Disco Cater', html: layout(content),
        from: 'Disco Cater Concierge <concierge@discocater.com>',
        replyTo: 'Disco Cater Concierge <concierge@discocater.com>', domain: 'mg.discocater.com',
      })
      // DISPATCHED, not delivered. Reconciliation against Mailgun is a separate step.
      rec.dispatched = res.success
      rec.messageId = res.id ?? null
      rec.reason = res.success ? 'Invite dispatched (fresh 30-day token).' : `dispatch failed: ${res.error}`
      rec.at = new Date().toISOString()
      appendProgress(LOG, rec as { ref: string })
      if (res.success) dispatched++; else skipped++
      console.log(`${String(n).padStart(2)}. ${p.email.padEnd(36)} ${String(p.grantRefs.length).padStart(2)} loc  ${res.success ? 'DISPATCHED ' + res.id : 'FAILED ' + res.error}`)
    } catch (err) {
      rec.dispatched = false; rec.reason = err instanceof Error ? err.message : String(err)
      appendProgress(LOG, rec as { ref: string }); skipped++
      console.log(`THREW ${p.email} ${rec.reason}`)
    }
  }
  console.log(`\nDONE dispatched=${dispatched} skipped=${skipped}`)
  process.exit(0)
})()
