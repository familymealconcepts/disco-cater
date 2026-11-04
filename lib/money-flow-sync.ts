// "Hold Payments": one setting, two systems. Disco's disco_restaurant_overrides.money_flow and
// FamilyMeal's restaurant moneyFlow must always say the same thing, because each system holds the
// charges IT processes by its own copy (a converted restaurant's FamilyMeal-processed orders follow
// FamilyMeal's value).
//
//   Toggle ON  = held     = FAMILY_MEAL in both systems
//   Toggle OFF = released = DIRECT      in both systems
//
// ── ONE PATH FOR EVERY CHANGE ───────────────────────────────────────────────────────────────
// setMoneyFlowEverywhere() is the only writer behind the Super Admin toggle, for native and
// FM-backed restaurants alike:
//   1. read both current values
//   2. PUT FamilyMeal, then READ IT BACK; Disco is written only when FamilyMeal shows the new value
//   3. if the read-back disagrees, or Disco's write fails, FamilyMeal is PUT BACK to what it was,
//      so a failed change never leaves the two systems saying different things
//   4. every attempt is audited, the failed ones included (the old route logged only successes,
//      so a change that reached FamilyMeal and then failed left no trace in Disco)
// A restaurant FamilyMeal has no record of (404) is Disco-only; that is allowed for native
// restaurants and refused for FM-backed ones.
//
// dryRun does steps 1 and the planning only: no PUT, no Disco write, no audit row.
//
// mismatches are never resolved automatically in either direction. Peter decides each one
// (CLAUDE.md, Hold Payments rule); alertMoneyFlowMismatches() only reports them.

export type MoneyFlow = 'DIRECT' | 'FAMILY_MEAL'

/** Strict: anything but the two exact values is not a money flow (no silent default to DIRECT). */
export function parseMoneyFlow(raw: unknown): MoneyFlow | null {
  return raw === 'DIRECT' || raw === 'FAMILY_MEAL' ? raw : null
}

export const label = (f: MoneyFlow | null | undefined) => (f === 'FAMILY_MEAL' ? 'held' : f === 'DIRECT' ? 'released' : 'not set')

export type MoneyFlowDeps = {
  /** FamilyMeal's live value. status 404 = FamilyMeal has no record of this restaurant. */
  fmGet: (fmRef: string) => Promise<{ status: number; moneyFlow: string | null }>
  fmPut: (fmRef: string, flow: MoneyFlow) => Promise<{ ok: boolean; status: number }>
  discoGet: (ref: string) => Promise<string | null>
  discoWrite: (ref: string, flow: MoneyFlow) => Promise<void>
  /** Keeps the 15-minute admin-list copy current so the page doesn't show a stale mismatch. */
  cacheWrite?: (fmRef: string, flow: MoneyFlow) => Promise<void>
  audit: (row: { ok: boolean; before: { disco: string | null; fm: string | null }; after: { disco: string | null; fm: string | null }; extra: Record<string, unknown> }) => Promise<void>
}

export type MoneyFlowResult = {
  ok: boolean
  dryRun: boolean
  requested: MoneyFlow
  discoBefore: string | null
  fmBefore: string | null
  fmRecord: boolean
  /** What each system says when this returns. */
  discoAfter: string | null
  fmAfter: string | null
  rolledBack?: boolean
  error?: string
  plan?: string[]
}

export async function setMoneyFlowEverywhere(
  deps: MoneyFlowDeps,
  args: { ref: string; fmRef: string; flow: MoneyFlow; native: boolean; dryRun?: boolean }
): Promise<MoneyFlowResult> {
  const { ref, fmRef, flow } = args
  const dryRun = args.dryRun === true
  const discoBefore = await safe(() => deps.discoGet(ref))
  const fmRead = await deps.fmGet(fmRef)
  const fmRecord = fmRead.status !== 404
  const base = { requested: flow, discoBefore, fmRecord, dryRun }

  if (fmRecord && (fmRead.status < 200 || fmRead.status >= 300)) {
    return { ...base, ok: false, fmBefore: null, discoAfter: discoBefore, fmAfter: null, error: `FamilyMeal couldn't be reached (${fmRead.status}), so Hold Payments wasn't changed in either system.` }
  }
  const fmBefore = fmRecord ? fmRead.moneyFlow : null
  if (!fmRecord && !args.native) {
    return { ...base, ok: false, fmBefore, discoAfter: discoBefore, fmAfter: null, error: 'FamilyMeal has no record of this restaurant, so Hold Payments wasn\'t changed.' }
  }

  if (dryRun) {
    const plan = [
      `Disco now: ${label(parseMoneyFlow(discoBefore))} (${discoBefore ?? 'null'}). FamilyMeal now: ${fmRecord ? `${label(parseMoneyFlow(fmBefore))} (${fmBefore ?? 'null'})` : 'no record'}.`,
      fmRecord
        ? `Would send FamilyMeal moneyFlow=${flow}, read it back, and require ${flow}.`
        : 'FamilyMeal has no record: would write Disco only.',
      `Would then write Disco money_flow=${flow}${fmRecord ? ' and update the 15-minute copy' : ''}.`,
      `On any failure after FamilyMeal accepts: would put FamilyMeal back to ${fmBefore ?? 'its previous value'}.`,
      `Result if it succeeds: both ${label(flow)} (${flow}).`,
    ]
    return { ...base, ok: true, fmBefore, discoAfter: discoBefore, fmAfter: fmBefore, plan }
  }

  const fail = async (error: string, extra: Record<string, unknown>, fmAfter: string | null, rolledBack?: boolean): Promise<MoneyFlowResult> => {
    const discoAfter = await safe(() => deps.discoGet(ref))
    await deps.audit({ ok: false, before: { disco: discoBefore, fm: fmBefore }, after: { disco: discoAfter, fm: fmAfter }, extra: { requested: flow, error, ...extra } }).catch(() => {})
    return { ...base, ok: false, fmBefore, discoAfter, fmAfter, rolledBack, error }
  }

  // Puts FamilyMeal back where it was after a later step failed. Only when we know where that was.
  const restoreFm = async (): Promise<{ rolledBack: boolean; fmAfter: string | null }> => {
    const prev = parseMoneyFlow(fmBefore)
    if (!prev || prev === flow) return { rolledBack: false, fmAfter: (await deps.fmGet(fmRef).catch(() => ({ moneyFlow: null }))).moneyFlow }
    await deps.fmPut(fmRef, prev).catch(() => null)
    const now = (await deps.fmGet(fmRef).catch(() => ({ moneyFlow: null }))).moneyFlow
    return { rolledBack: now === prev, fmAfter: now }
  }

  let fmAfter: string | null = null
  if (fmRecord) {
    const put = await deps.fmPut(fmRef, flow)
    if (!put.ok) return fail(`FamilyMeal refused the change (${put.status}), so Hold Payments wasn't changed in either system.`, { step: 'fm_put', status: put.status }, fmBefore)
    fmAfter = (await deps.fmGet(fmRef).catch(() => ({ moneyFlow: null }))).moneyFlow
    if (fmAfter !== flow) {
      const r = await restoreFm()
      return fail(
        `FamilyMeal showed ${fmAfter ?? 'no value'} after the change instead of ${flow}. ` +
          (r.rolledBack ? `FamilyMeal was put back to ${fmBefore}; Disco wasn't changed.` : `FamilyMeal now shows ${r.fmAfter ?? 'no value'}; Disco wasn't changed. Check both before trying again.`),
        { step: 'fm_readback', fmReadBack: fmAfter }, r.fmAfter, r.rolledBack)
    }
  }

  try {
    await deps.discoWrite(ref, flow)
  } catch (e) {
    const r = fmRecord ? await restoreFm() : { rolledBack: false, fmAfter: null }
    return fail(
      `Disco couldn't save Hold Payments (${e instanceof Error ? e.message : 'error'}). ` +
        (fmRecord ? (r.rolledBack ? `FamilyMeal was put back to ${fmBefore}.` : `FamilyMeal now shows ${r.fmAfter ?? 'no value'}; check both before trying again.`) : ''),
      { step: 'disco_write' }, r.fmAfter, r.rolledBack)
  }
  if (fmRecord && deps.cacheWrite) await deps.cacheWrite(fmRef, flow).catch(() => {})
  await deps.audit({ ok: true, before: { disco: discoBefore, fm: fmBefore }, after: { disco: flow, fm: fmRecord ? fmAfter : null }, extra: { requested: flow, fmRecord } }).catch(() => {})
  return { ...base, ok: true, fmBefore, discoAfter: flow, fmAfter }
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch { return null }
}
