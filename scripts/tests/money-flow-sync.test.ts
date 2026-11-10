// Guards for Hold Payments sync (lib/money-flow-sync.ts, Peter 2026-11-04).
// Run: npx tsx scripts/tests/money-flow-sync.test.ts
//
// Disco and FamilyMeal must always say the same thing. Driven with in-memory fakes of both systems,
// so every failure path is exercised without touching either. 2026-11-10: a change made directly in
// FamilyMeal is synced into Disco (Disco only), and only an unresolvable pair alerts.
import { readFileSync } from 'node:fs'
import {
  setMoneyFlowEverywhere, parseMoneyFlow, syncDiscoToFamilyMeal, syncNeedsAlert,
  type MoneyFlowDeps, type MoneyFlow, type DiscoSyncDeps,
} from '../../lib/money-flow-sync'

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

  console.log('\n=== an out-of-sync row is shown with explicit buttons ===')
  await check('the out-of-sync row offers Hold both / Release both instead of a flip', () => {
    const page = readFileSync('app/(admin)/admin/(protected)/manage-restaurants/ordering/page.tsx', 'utf8')
    ok(/if \(!fm\) return <Toggle/.test(page) && /pill\('FAMILY_MEAL', 'Hold both'\)/.test(page) && /pill\('DIRECT', 'Release both'\)/.test(page), 'mismatch UI')
  })

  console.log('\n=== a Super Admin change audits; only a failed one alerts ===')
  await check('the route alerts only on failure, resolves on success, and audits source super_admin', () => {
    const route = readFileSync('app/api/admin/restaurants/[ref]/money-flow/route.ts', 'utf8')
    const okIdx = route.indexOf('if (!result.ok) {')
    ok(okIdx > 0, 'failure branch')
    const failBranch = route.slice(okIdx, route.indexOf('status: 502', okIdx))
    ok(/alertMoneyFlowChangeFailed/.test(failBranch) && /!dryRun/.test(failBranch), 'failure (not dry run) alerts')
    const after = route.slice(route.indexOf('status: 502'))
    ok(/resolveMoneyFlowChangeFailed/.test(after), 'success resolves any open failure alert')
    ok(!/alertOps|alertOnce|alertGroup|slack/i.test(route), 'no other alert or Slack call in the route')
    const srv = readFileSync('lib/money-flow-sync-server.ts', 'utf8')
    ok(/source: 'super_admin'/.test(srv), 'Super Admin audit rows carry source super_admin')
  })

  console.log('\n=== a change made in FamilyMeal: Disco quietly matches it ===')
  type SyncWorld = { disco: string | null; fm: string | null; fmStatus?: number; fmThrows?: boolean; discoFails?: boolean; discoIgnores?: boolean; changedUnderUs?: string; audits: { ok: boolean; extra: Record<string, unknown> }[]; writes: string[] }
  const sw = (disco: string | null, fm: string | null, extra: Partial<SyncWorld> = {}): SyncWorld => ({ disco, fm, audits: [], writes: [], ...extra })
  const syncFakes = (w: SyncWorld): DiscoSyncDeps => ({
    fmGet: async () => { if (w.fmThrows) throw new Error('ECONNRESET'); return { status: w.fmStatus ?? 200, moneyFlow: (w.fmStatus ?? 200) === 200 ? w.fm : null } },
    discoGet: async () => w.disco,
    discoWriteIf: async (_r, expected, f) => {
      w.writes.push(`disco:${f}`)
      if (w.discoFails) throw new Error('db down')
      if (w.changedUnderUs) { w.disco = w.changedUnderUs; return false }
      if (w.disco !== expected) return false
      if (!w.discoIgnores) w.disco = f
      return true
    },
    audit: async (row) => { w.audits.push({ ok: row.ok, extra: row.extra }) },
  })
  const sync = (w: SyncWorld, dryRun = false) => syncDiscoToFamilyMeal(syncFakes(w), { ref: 'r', fmRef: 'r', dryRun })
  // The sync's deps have no way to write FamilyMeal at all: no fmPut exists on DiscoSyncDeps.
  await check('FamilyMeal held, Disco released: Disco becomes held, audited as the FamilyMeal sync, no alert', async () => {
    const w = sw('DIRECT', 'FAMILY_MEAL'); const r = await sync(w)
    eq(r.outcome, 'synced', 'outcome'); eq([w.disco, w.fm], ['FAMILY_MEAL', 'FAMILY_MEAL'], 'Disco matches FamilyMeal')
    eq(w.audits.length, 1, 'one audit row'); ok(w.audits[0].ok && w.audits[0].extra.source === 'familymeal_sync', 'audit source')
    ok(!syncNeedsAlert(r.outcome), 'no alert')
  })
  await check('FamilyMeal released, Disco held: Disco becomes released', async () => {
    const w = sw('FAMILY_MEAL', 'DIRECT'); const r = await sync(w)
    eq(r.outcome, 'synced', 'outcome'); eq(w.disco, 'DIRECT', 'released'); eq([r.discoBefore, r.discoAfter], ['FAMILY_MEAL', 'DIRECT'], 'old and new')
  })
  await check('Disco unset and FamilyMeal held: Disco is set held', async () => {
    const w = sw(null, 'FAMILY_MEAL'); const r = await sync(w); eq(r.outcome, 'synced', 'outcome'); eq(w.disco, 'FAMILY_MEAL', 'set')
  })
  await check('already the same live (the 15-minute copy was behind): nothing written, nothing audited', async () => {
    const w = sw('FAMILY_MEAL', 'FAMILY_MEAL'); const r = await sync(w)
    eq(r.outcome, 'already_in_sync', 'outcome'); eq(w.writes, [], 'no writes'); eq(w.audits, [], 'no audit')
    const u = sw(null, 'DIRECT'); eq((await sync(u)).outcome, 'already_in_sync', 'unset reads as released'); eq(u.writes, [], 'no writes')
  })
  await check('a Super Admin change landing mid-check is never overwritten', async () => {
    const w = sw('DIRECT', 'FAMILY_MEAL', { changedUnderUs: 'FAMILY_MEAL' }); const r = await sync(w)
    eq(r.outcome, 'disco_changed', 'outcome'); eq(w.audits, [], 'no audit'); ok(!syncNeedsAlert(r.outcome), 'no alert')
  })
  await check('FamilyMeal unreachable, erroring or valueless: Disco untouched, and it alerts', async () => {
    for (const w of [sw('DIRECT', 'FAMILY_MEAL', { fmStatus: 503 }), sw('DIRECT', 'FAMILY_MEAL', { fmThrows: true }), sw('DIRECT', 'held'), sw('DIRECT', null), sw('DIRECT', 'FAMILY_MEAL', { fmStatus: 404 })]) {
      const r = await sync(w)
      eq(r.outcome, 'fm_unreadable', 'outcome'); eq(w.writes, [], 'no writes'); eq(w.disco, 'DIRECT', 'Disco unchanged'); ok(syncNeedsAlert(r.outcome), 'alerts')
    }
  })
  await check('Disco write fails or does not stick: alerts, failure audited', async () => {
    for (const w of [sw('DIRECT', 'FAMILY_MEAL', { discoFails: true }), sw('DIRECT', 'FAMILY_MEAL', { discoIgnores: true })]) {
      const r = await sync(w)
      eq(r.outcome, 'disco_write_failed', 'outcome'); ok(syncNeedsAlert(r.outcome), 'alerts'); eq(w.audits.map(a => a.ok), [false], 'failure audited')
    }
  })
  await check('dry run reports the sync and writes nothing, not even an audit row', async () => {
    const w = sw('DIRECT', 'FAMILY_MEAL'); const r = await sync(w, true)
    eq(r.outcome, 'synced', 'would sync'); eq(w.writes, [], 'no writes'); eq(w.audits, [], 'no audit'); eq(w.disco, 'DIRECT', 'unchanged')
  })

  console.log('\n=== the 15-minute check: writes Disco only, never FamilyMeal; alerts only when unresolved ===')
  await check('syncMoneyFlowFromFamilyMeal never writes FamilyMeal and alerts only the unresolved', () => {
    const srv = readFileSync('lib/money-flow-sync-server.ts', 'utf8')
    const fn = srv.slice(srv.indexOf('export async function syncMoneyFlowFromFamilyMeal'), srv.indexOf('export async function alertMoneyFlowChangeFailed'))
    ok(!/fmPut|method: 'PUT'|setMoneyFlowEverywhere|UPDATE|INSERT/.test(fn), 'no FamilyMeal write and no direct SQL write in the check')
    ok(/alertGroup\(run\.unresolved/.test(fn), 'alerts only the unresolved restaurants')
    ok(/if \(dryRun\) return run/.test(fn), 'dry run touches no alert')
    const deps = srv.slice(srv.indexOf('export function familyMealSyncDeps'), srv.indexOf('export type MoneyFlowMismatch'))
    ok(!/fmPut|method: 'PUT'|stripe/i.test(deps), 'the sync deps cannot write FamilyMeal or Stripe')
    ok(/IS NOT DISTINCT FROM \$\{expected\}/.test(deps), 'Disco write is conditional on the value read')
    ok((deps.match(/money_flow =/g) ?? []).length === 1 && !/withhold_payouts|stripe_account_id/.test(deps), 'only money_flow is written')
    const cron = readFileSync('app/api/cron/refresh-restaurant-admin-list/route.ts', 'utf8')
    ok(/syncMoneyFlowFromFamilyMeal/.test(cron) && !/alertMoneyFlowMismatches/.test(cron), 'cron runs the sync, not the old alert-every-difference check')
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main()
