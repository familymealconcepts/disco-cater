// Guards for the marketplace cron-run log (lib/cron-runs.ts, lib/migrations/007_disco_cron_runs.sql).
// Run: npx tsx scripts/tests/cron-runs.test.ts
//
//   1. The pure rules: status -> state, user agent -> trigger, the auth test, the error text kept.
//   2. Every cron vercel.json schedules is wrapped, under its own name, and no route still exports a
//      bare GET. Control-tested against doctored copies of the real file text, so none passes vacuously.
//   3. A failed log write never stops or fails the job (Kevin, 2026-10-23): with no database at all,
//      the handler still runs once and its response, or its throw, comes back unchanged.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { classifyCronStatus, triggerOf, isCronAuthorized, responseErrorText, scheduledCrons, withCronRun, RETENTION_DAYS } from '../../lib/cron-runs'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg) }

async function main() {
  console.log('\n=== the rules ===')
  await check('2xx and 3xx are ok', () => ok(classifyCronStatus(200) === 'ok' && classifyCronStatus(204) === 'ok' && classifyCronStatus(302) === 'ok', 'wrong'))
  await check('409 is a skip', () => ok(classifyCronStatus(409) === 'skipped', 'wrong'))
  await check('401, 500 and 504 are failures', () => ok(['failed', 'failed', 'failed'].every((s, i) => classifyCronStatus([401, 500, 504][i]) === s), 'wrong'))
  await check("Vercel's user agent is a scheduled run", () => ok(triggerOf('vercel-cron/1.0') === 'schedule', 'wrong'))
  await check('anything else is manual', () => ok(triggerOf('curl/8.0') === 'manual' && triggerOf(null) === 'manual', 'wrong'))
  await check('only Bearer <CRON_SECRET> is a cron call', () => ok(isCronAuthorized('Bearer s3', 's3') && !isCronAuthorized('s3', 's3') && !isCronAuthorized('Bearer s3', undefined) && !isCronAuthorized(null, 's3'), 'wrong'))
  await check("a JSON body's error is kept", () => ok(responseErrorText('{"error":"FM 504"}') === 'FM 504', 'wrong'))
  await check('a plain body is kept as text, an empty one as null', () => ok(responseErrorText('boom') === 'boom' && responseErrorText('  ') === null, 'wrong'))
  await check('retention is 90 days', () => ok(RETENTION_DAYS === 90, `is ${RETENTION_DAYS}`))

  console.log('\n=== every scheduled cron is wrapped ===')
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Array<{ path: string; schedule: string }> }
  const crons = scheduledCrons()
  await check('scheduledCrons() is vercel.json, name for name and schedule for schedule', () => ok(
    crons.length === vercel.crons.length && vercel.crons.every((c, i) => crons[i].cron === c.path.split('/').pop() && crons[i].schedule === c.schedule), 'differs'))
  await check('no two crons share a route name', () => ok(new Set(crons.map((c) => c.cron)).size === crons.length, 'duplicate name'))
  const wrapped = (src: string, name: string) =>
    src.includes(`export const GET = withCronRun('${name}', runGet)`) && !/export async function GET\b/.test(src) && /async function runGet\(req: NextRequest\)/.test(src)
  for (const c of vercel.crons) {
    const name = c.path.split('/').pop()!
    const src = readFileSync(path.join('app', ...c.path.split('/').filter(Boolean), 'route.ts'), 'utf8')
    await check(`${name} is wrapped under its own name`, () => ok(wrapped(src, name), 'not wrapped'))
  }
  const sample = vercel.crons[0].path.split('/').pop()!
  const sampleSrc = readFileSync(path.join('app', ...vercel.crons[0].path.split('/').filter(Boolean), 'route.ts'), 'utf8')
  await check('  control: a bare exported GET is caught', () => ok(!wrapped(sampleSrc.replace(`export const GET = withCronRun('${sample}', runGet)`, '').replace('async function runGet(', 'export async function GET('), sample), 'not caught'))
  await check('  control: a wrap under the wrong name is caught', () => ok(!wrapped(sampleSrc.replace(`withCronRun('${sample}'`, `withCronRun('other'`), sample), 'not caught'))

  console.log('\n=== a failed log write never stops or fails the job ===')
  // No DATABASE_URL: every write in lib/cron-runs.ts throws, which is the worst case for the log.
  delete process.env.DATABASE_URL
  process.env.CRON_SECRET = 'test-secret'
  const req = () => new NextRequest('https://example.test/api/cron/x', { headers: { authorization: 'Bearer test-secret', 'user-agent': 'vercel-cron/1.0' } })
  const quiet = console.error
  console.error = () => {}
  try {
    let calls = 0
    const okRes = await withCronRun('x', async () => { calls++; return new Response('{"done":true}', { status: 200 }) })(req())
    await check('the handler runs once and its 200 comes back', async () => ok(calls === 1 && okRes.status === 200 && (await okRes.text()) === '{"done":true}', `calls=${calls} status=${okRes.status}`))
    const failRes = await withCronRun('x', async () => new Response('{"error":"FM down"}', { status: 500 }))(req())
    await check("the handler's own 500 comes back unchanged", async () => ok(failRes.status === 500 && (await failRes.text()) === '{"error":"FM down"}', 'changed'))
    let thrown: unknown = null
    try { await withCronRun('x', async () => { throw new Error('handler blew up') })(req()) } catch (e) { thrown = e }
    await check("the handler's own throw comes back unchanged", () => ok(thrown instanceof Error && thrown.message === 'handler blew up', String(thrown)))
    let anonCalls = 0
    const anon = await withCronRun('x', async () => { anonCalls++; return new Response('no', { status: 401 }) })(new NextRequest('https://example.test/api/cron/x'))
    await check('an unauthenticated request goes straight to the handler', () => ok(anonCalls === 1 && anon.status === 401, 'wrong'))
  } finally {
    console.error = quiet
  }

  console.log(`\n${failures.length ? 'FAILED' : 'ALL PASS'} ${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join('; ')}` : ''}`)
  if (failures.length) process.exit(1)
}
main()
