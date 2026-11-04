// Guards for Hold Payments sync (lib/money-flow-sync.ts, Peter 2026-11-04).
// Run: npx tsx scripts/tests/money-flow-sync.test.ts
//
// Disco and FamilyMeal must always say the same thing. Driven with in-memory fakes of both systems,
// so every failure path is exercised without touching either.
import { readFileSync } from 'node:fs'
import { setMoneyFlowEverywhere, parseMoneyFlow, type MoneyFlowDeps, type MoneyFlow } from '../../lib/money-flow-sync'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(v: unknown, msg: string) { if (!v) throw new Error(msg) }

type World = { disco: string | null; fm: string | null; fmStatus?: number; putStatus?: number; fmIgnoresPut?: boolean; discoFails?: boolean; audits: { ok: boolean }[]; writes: string[] }
function fakes(w: World): MoneyFlowDeps {
  return {
    fmGet: async () => ({ status: w.fmStatus ?? 200, moneyFlow: (w.fmStatus ?? 200) === 200 ? w.fm : null }),
    fmPut: async (_r, f: MoneyFlow) => {
      w.writes.push(`fm:${f}`)
      if (w.putStatus && w.putStatus >= 300) return { ok: false, status: w.putStatus }
      if (!w.fmIgnoresPut) w.fm = f
      return { ok: true, status: 200 }
    },
    discoGet: async () => w.disco,
    discoWrite: async (_r, f) => { w.writes.push(`disco:${f}`); if (w.discoFails) throw new Error('db down'); w.disco = f },
    cacheWrite: async () => { w.writes.push('cache') },
    audit: async (row) => { w.audits.push({ ok: row.ok }) },
  }
}
const world = (disco: string | null, fm: string | null, extra: Partial<World> = {}): World => ({ disco, fm, audits: [], writes: [], ...extra })
const run = (w: World, flow: MoneyFlow, o: { native?: boolean; dryRun?: boolean } = {}) =>
  setMoneyFlowEverywhere(fakes(w), { ref: 'r', fmRef: 'r', flow, native: o.native ?? true, dryRun: o.dryRun })

async function main() {
  console.log('\n=== the mapping ===')
  await check('ON is FAMILY_MEAL (held) and OFF is DIRECT (released); nothing else is accepted', () => {
    eq(parseMoneyFlow('FAMILY_MEAL'), 'FAMILY_MEAL', 'held'); eq(parseMoneyFlow('DIRECT'), 'DIRECT', 'released')
    for (const bad of [null, '', 'held', 'direct', 'ON', undefined]) eq(parseMoneyFlow(bad), null, String(bad))
    const page = readFileSync('app/(admin)/admin/(protected)/manage-restaurants/ordering/page.tsx', 'utf8')
    ok(/Toggle checked=\{effectiveMoneyFlow\(r, ov\) === 'FAMILY_MEAL'\}/.test(page), 'toggle ON must render FAMILY_MEAL')
    ok(/return setMoneyFlow\(r, held \? 'DIRECT' : 'FAMILY_MEAL'\)/.test(page), 'flipping held must send DIRECT and vice versa')
    const route = readFileSync('app/api/admin/restaurants/[ref]/money-flow/route.ts', 'utf8')
    ok(!/\|\| 'DIRECT'/.test(route), 'the route must not default a missing value to DIRECT')
  })

  console.log('\n=== a change sets both, the same way ===')
  await check('turning ON sets FamilyMeal FAMILY_MEAL, reads it back, then Disco FAMILY_MEAL', async () => {
    const w = world('DIRECT', 'DIRECT'); const r = await run(w, 'FAMILY_MEAL')
    ok(r.ok, r.error ?? 'failed'); eq([w.disco, w.fm], ['FAMILY_MEAL', 'FAMILY_MEAL'], 'both held'); eq(w.writes, ['fm:FAMILY_MEAL', 'disco:FAMILY_MEAL', 'cache'], 'order')
    eq(w.audits, [{ ok: true }], 'audited')
  })
  await check('turning OFF sets both DIRECT', async () => {
    const w = world('FAMILY_MEAL', 'FAMILY_MEAL'); const r = await run(w, 'DIRECT')
    ok(r.ok, r.error ?? 'failed'); eq([w.disco, w.fm], ['DIRECT', 'DIRECT'], 'both released')
  })
  await check('an FM-backed restaurant takes the same path, read-back included', async () => {
    const w = world('DIRECT', 'DIRECT'); const r = await run(w, 'FAMILY_MEAL', { native: false })
    ok(r.ok, r.error ?? 'failed'); eq([w.disco, w.fm], ['FAMILY_MEAL', 'FAMILY_MEAL'], 'both held')
  })

  console.log('\n=== a failure never leaves them different ===')
  await check('FamilyMeal refuses: nothing changes anywhere, and the attempt is audited', async () => {
    const w = world('DIRECT', 'DIRECT', { putStatus: 500 }); const r = await run(w, 'FAMILY_MEAL')
    ok(!r.ok, 'should fail'); eq([w.disco, w.fm], ['DIRECT', 'DIRECT'], 'unchanged'); eq(w.audits, [{ ok: false }], 'failure audited')
  })
  await check('FamilyMeal reads back something else: FamilyMeal is put back, Disco untouched', async () => {
    const w = world('DIRECT', 'DIRECT'); const deps = fakes(w)
    let n = 0; deps.fmGet = async () => ({ status: 200, moneyFlow: n++ === 1 ? 'DIRECT' : w.fm })
    const r = await setMoneyFlowEverywhere(deps, { ref: 'r', fmRef: 'r', flow: 'FAMILY_MEAL', native: true })
    ok(!r.ok && r.rolledBack, 'rolled back'); eq([w.disco, w.fm], ['DIRECT', 'DIRECT'], 'back where they were'); eq(w.writes, ['fm:FAMILY_MEAL', 'fm:DIRECT'], 'put back')
  })
  await check('Disco fails to save after FamilyMeal accepted: FamilyMeal is put back', async () => {
    const w = world('DIRECT', 'DIRECT', { discoFails: true }); const r = await run(w, 'FAMILY_MEAL')
    ok(!r.ok && r.rolledBack, 'rolled back'); eq([w.disco, w.fm], ['DIRECT', 'DIRECT'], 'both released still')
  })
  await check('FamilyMeal unreachable: nothing is written', async () => {
    const w = world('DIRECT', 'DIRECT', { fmStatus: 503 }); const r = await run(w, 'FAMILY_MEAL')
    ok(!r.ok, 'should fail'); eq(w.writes, [], 'no writes')
  })
  await check('no FamilyMeal record: native is Disco-only; FM-backed is refused', async () => {
    const a = world('DIRECT', null, { fmStatus: 404 }); ok((await run(a, 'FAMILY_MEAL')).ok, 'native ok'); eq(a.writes, ['disco:FAMILY_MEAL'], 'disco only')
    const b = world('DIRECT', null, { fmStatus: 404 }); ok(!(await run(b, 'FAMILY_MEAL', { native: false })).ok, 'FM-backed refused'); eq(b.writes, [], 'no writes')
  })

  console.log('\n=== dry run ===')
  await check('dryRun reads both and writes nothing, not even an audit row', async () => {
    const w = world('FAMILY_MEAL', 'DIRECT'); const r = await run(w, 'FAMILY_MEAL', { dryRun: true })
    ok(r.ok && r.dryRun && (r.plan?.length ?? 0) > 0, 'plan returned'); eq(w.writes, [], 'no writes'); eq(w.audits, [], 'no audit')
    eq([r.discoBefore, r.fmBefore], ['FAMILY_MEAL', 'DIRECT'], 'current values reported')
  })

  console.log('\n=== mismatches are shown, never fixed automatically ===')
  await check('the out-of-sync row offers Hold both / Release both instead of a flip', () => {
    const page = readFileSync('app/(admin)/admin/(protected)/manage-restaurants/ordering/page.tsx', 'utf8')
    ok(/if \(!fm\) return <Toggle/.test(page) && /pill\('FAMILY_MEAL', 'Hold both'\)/.test(page) && /pill\('DIRECT', 'Release both'\)/.test(page), 'mismatch UI')
  })
  await check('the 15-minute check only alerts; it writes no setting', () => {
    const srv = readFileSync('lib/money-flow-sync-server.ts', 'utf8')
    const fn = srv.slice(srv.indexOf('export async function alertMoneyFlowMismatches'))
    ok(!/UPDATE|INSERT|discoWrite|fmPut/.test(fn), 'alertMoneyFlowMismatches must not write')
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main()
