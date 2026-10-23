// End-to-end check of the #ops-alerts key lifecycle in lib/ops-alert.ts against
// a REAL Postgres, with Slack stubbed: nothing is sent anywhere.
//
//   open → silent while open → one reply per step → resolve in the thread →
//   resolve again is a no-op → re-arms as a NEW thread → group alert with one
//   ts for several keys → syncAlertSet closes only what is gone → job threshold
//   (N failures in a row, recovered reply) → per-item streaks → webhook fallback
//   (no token: resolve posts top-level naming the alert).
//
// WRITES to disco_alert_dedup, so it refuses to run unless OPS_ALERT_VERIFY=branch:
// point DATABASE_URL at a Neon BRANCH of disco-cater-db, never production
// (there are no transactions in this repo — see CLAUDE.md). Its keys are all
// under a random `verify-<n>:` prefix and are deleted at the end.
//
// Run: OPS_ALERT_VERIFY=branch DATABASE_URL=<branch url> npx tsx scripts/verify-ops-alert-lifecycle.ts
import { sql } from '../lib/db'
import {
  alertOnce, replyToAlert, resolveAlert, alertGroup, syncAlertSet, openAlertKeys,
  noteJobFailure, noteJobSuccess, bumpStreaks, clearStreaks,
} from '../lib/ops-alert'
import { JOBS } from '../lib/ops-alert-format'

if (process.env.OPS_ALERT_VERIFY !== 'branch') {
  console.error('Refusing: set OPS_ALERT_VERIFY=branch and point DATABASE_URL at a Neon branch.')
  process.exit(2)
}

type Posted = { text: string; thread_ts?: string; reply_broadcast?: boolean; via: 'bot' | 'webhook' }
const posted: Posted[] = []
let n = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url)
  const body = JSON.parse(String(init?.body ?? '{}'))
  if (u.includes('chat.postMessage')) {
    posted.push({ text: body.text, thread_ts: body.thread_ts, reply_broadcast: body.reply_broadcast, via: 'bot' })
    return new Response(JSON.stringify({ ok: true, ts: `1700000000.${String(++n).padStart(6, '0')}` }))
  }
  if (u.startsWith('https://hooks.slack.test/')) {
    posted.push({ text: body.text, via: 'webhook' })
    return new Response('ok')
  }
  return realFetch(url, init)
}) as typeof fetch

process.env.SLACK_OPS_ALERTS_BOT_TOKEN = 'xoxb-verify-stub'
process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL = 'https://hooks.slack.test/verify'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const since = () => { const at = posted.length; return () => posted.slice(at) }

const P = `verify-${Date.now()}:`
const A = { severity: 'warn' as const, headline: 'Verify headline', lines: ['line'], action: 'do it.' }

async function main() {
  await check('opens once: first call posts, repeats are silent', async () => {
    const got = since()
    eq(await alertOnce(`${P}a`, A), true, 'first')
    eq(await alertOnce(`${P}a`, A), false, 'second')
    eq(await alertOnce(`${P}a`, A), false, 'third')
    eq(got().length, 1, 'one post')
    eq(got()[0].thread_ts, undefined, 'top-level')
  })
  const ts = (await sql`SELECT slack_ts FROM disco_alert_dedup WHERE alert_key = ${`${P}a`}`) as Array<{ slack_ts: string }>
  await check('the post ts is stored on the key', async () => { if (!ts[0]?.slack_ts) throw new Error('no slack_ts') })
  await check('a reply goes in the thread, once per step, broadcast when asked', async () => {
    const got = since()
    eq(await replyToAlert(`${P}a`, 'at-risk', 'Pickup is soon.', { broadcast: true, severity: 'warn' }), true, 'first reply')
    eq(await replyToAlert(`${P}a`, 'at-risk', 'Pickup is soon.', { broadcast: true, severity: 'warn' }), false, 'same step again')
    eq(got().length, 1, 'one reply')
    eq(got()[0].thread_ts, ts[0].slack_ts, 'in thread')
    eq(got()[0].reply_broadcast, true, 'broadcast')
  })
  await check('resolve replies ✅ in the thread and closes the key', async () => {
    const got = since()
    eq(await resolveAlert(`${P}a`, 'Resolved: fixed.'), true, 'resolved')
    eq(got().map(p => [p.text, p.thread_ts]), [[':white_check_mark: Resolved: fixed.', ts[0].slack_ts]], 'reply')
    eq((await openAlertKeys(`${P}a`)).length, 0, 'closed')
  })
  await check('resolving again, or a key never opened, posts nothing', async () => {
    const got = since()
    eq(await resolveAlert(`${P}a`, 'again'), false, 'again')
    eq(await resolveAlert(`${P}never`, 'x'), false, 'never')
    eq(got().length, 0, 'silent')
  })
  await check('a returning condition re-arms as a NEW thread, and can escalate again', async () => {
    const got = since()
    eq(await alertOnce(`${P}a`, A), true, 're-armed')
    eq(await alertOnce(`${P}a`, A), false, 'then silent')
    eq(await replyToAlert(`${P}a`, 'at-risk', 'Pickup is soon.'), true, 'step cleared by the resolve')
    const fresh = got()
    eq(fresh.length, 2, 'post + reply')
    eq(fresh[0].thread_ts, undefined, 'new top-level')
    if (fresh[1].thread_ts === ts[0].slack_ts) throw new Error('replied in the OLD thread')
  })
  await check('group: one post for the new keys only, each key carries its ts', async () => {
    const got = since()
    const first = await alertGroup([{ key: `${P}g1` }, { key: `${P}g2` }], f => ({ ...A, headline: `${f.length} things` }))
    eq(first.map(f => f.key), [`${P}g1`, `${P}g2`], 'both new')
    const second = await alertGroup([{ key: `${P}g1` }, { key: `${P}g2` }, { key: `${P}g3` }], f => ({ ...A, headline: `${f.length} things` }))
    eq(second.map(f => f.key), [`${P}g3`], 'only the new one')
    eq(got().map(p => p.text.split('\n')[0]), [':warning: *2 things*', ':warning: *1 things*'], 'two posts')
    const rows = (await sql`SELECT alert_key, slack_ts FROM disco_alert_dedup WHERE alert_key = ANY(${[`${P}g1`, `${P}g2`]}) ORDER BY 1`) as Array<{ slack_ts: string }>
    eq(rows[0].slack_ts === rows[1].slack_ts && !!rows[0].slack_ts, true, 'shared ts')
  })
  await check('syncAlertSet closes only the keys no longer true, in their thread', async () => {
    const got = since()
    const closed = await syncAlertSet(`${P}g`, [`${P}g2`], k => `closed ${k.slice(P.length)}`)
    eq(closed.sort(), [`${P}g1`, `${P}g3`], 'closed')
    eq(got().map(p => p.text).sort(), [':white_check_mark: closed g1', ':white_check_mark: closed g3'], 'replies')
    eq(await openAlertKeys(`${P}g`), [`${P}g2`], 'g2 still open')
  })
  await check('job threshold: silent below N, posts at N, silent after, recovered reply on success', async () => {
    JOBS[`${P}job`] = { name: 'Verify job', meaning: 'Things.', threshold: 3 }
    const got = since()
    await noteJobFailure(`${P}job`, 'boom 1')
    await noteJobFailure(`${P}job`, 'boom 2')
    eq(got().length, 0, 'below threshold')
    await noteJobFailure(`${P}job`, 'boom 3')
    await noteJobFailure(`${P}job`, 'boom 4')
    eq(got().length, 1, 'one post at threshold')
    eq(got()[0].text.split('\n')[0], ':warning: *Verify job has failed 3 runs in a row*', 'headline')
    await noteJobSuccess(`${P}job`)
    eq(got().length, 2, 'recovered reply')
    eq(/^:white_check_mark: Recovered: it ran fine at .* after 4 failures\.$/.test(got()[1].text), true, got()[1].text)
    await noteJobSuccess(`${P}job`)
    eq(got().length, 2, 'second success silent')
  })
  await check('a single failure then success posts nothing (the 10-23 Mailgun 500)', async () => {
    JOBS[`${P}blip`] = { name: 'Blip', meaning: '', threshold: 3 }
    const got = since()
    await noteJobFailure(`${P}blip`, 'Mailgun events 500')
    await noteJobSuccess(`${P}blip`)
    eq(got().length, 0, 'silent')
  })
  await check('per-item streaks count and clear', async () => {
    eq([...(await bumpStreaks(P, ['r1', 'r2'])).values()], [1, 1], 'first')
    eq([...(await bumpStreaks(P, ['r1'])).values()], [2], 'second')
    eq((await clearStreaks(P, ['r1', 'r2', 'r3'])).sort(), ['r1', 'r2'], 'cleared the failing ones')
    eq([...(await bumpStreaks(P, ['r1'])).values()], [1], 'restarted')
  })
  await check('webhook fallback: no token → posts via webhook, resolve is top-level naming the alert', async () => {
    delete process.env.SLACK_OPS_ALERTS_BOT_TOKEN
    const got = since()
    await alertOnce(`${P}w`, { ...A, headline: 'Webhook alert' })
    await resolveAlert(`${P}w`, 'Resolved: done.')
    eq(got().map(p => [p.via, p.text]), [
      ['webhook', ':warning: *Webhook alert*\nline\n*What to do:* do it.'],
      ['webhook', ':white_check_mark: *Webhook alert*\nResolved: done.'],
    ], 'fallback')
    process.env.SLACK_OPS_ALERTS_BOT_TOKEN = 'xoxb-verify-stub'
  })

  await sql`DELETE FROM disco_alert_dedup WHERE alert_key LIKE ${`${P}%`} OR alert_key LIKE ${`job-run:${P}%`} OR alert_key LIKE ${`job:${P}%`} OR alert_key LIKE ${`streak:${P}%`}`
  console.log(`\n${failures.length ? `FAILED ${failures.length}: ${failures.join(' | ')}` : 'ALL PASS'} — ${passed} passed`)
  process.exit(failures.length ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
