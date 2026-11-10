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
// ── WHEN FAMILYMEAL WAS CHANGED DIRECTLY (Peter, 2026-11-10) ───────────────────────────────
// Someone can change Hold Payments in FamilyMeal's own admin, which Disco never hears about. The
// 15-minute check finds those and syncDiscoToFamilyMeal() makes DISCO match FAMILYMEAL: it re-reads
// FamilyMeal live (the 15-minute copy can be a few minutes behind a Super Admin change), writes only
// Disco's money_flow, and only if Disco still holds the value it was checked against, then audits it
// as actor 'system: familymeal sync'. It never writes FamilyMeal and never moves money.
//
// Alerts: a Hold Payments change is not an alert, from either side. Only a pair that can't be
// brought back in sync is: FamilyMeal unreadable, Disco's write failing, or a Super Admin change
// that FamilyMeal refused or that was rolled back.

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

export const FAMILYMEAL_SYNC_ACTOR = 'system: familymeal sync'

export type DiscoSyncDeps = {
  /** FamilyMeal's live value (status 404 = no record). */
  fmGet: MoneyFlowDeps['fmGet']
  discoGet: MoneyFlowDeps['discoGet']
  /**
   * Sets Disco's money_flow to `flow` ONLY while it still equals `expected` (null = unset/no row),
   * so a Super Admin change landing mid-check is never overwritten. Returns true if it wrote.
   */
  discoWriteIf: (ref: string, expected: string | null, flow: MoneyFlow) => Promise<boolean>
  audit: (row: { ok: boolean; before: { disco: string | null; fm: string | null }; after: { disco: string | null; fm: string | null }; extra: Record<string, unknown> }) => Promise<void>
}

export type DiscoSyncOutcome =
  /** Disco now equals FamilyMeal; audited. */
  | 'synced'
  /** Live values already agree (the 15-minute copy was behind); nothing written. */
  | 'already_in_sync'
  /** Disco changed while we checked; left alone, the next run looks again. */
  | 'disco_changed'
  /** FamilyMeal couldn't be read, or gave no valid value: nothing written. Alert. */
  | 'fm_unreadable'
  /** Disco's write failed or didn't stick. Alert. */
  | 'disco_write_failed'

export type DiscoSyncResult = { outcome: DiscoSyncOutcome; discoBefore: string | null; fm: string | null; discoAfter: string | null; error?: string }

/** True for the outcomes that leave Disco and FamilyMeal unconfirmed in sync: the only ones that alert. */
export const syncNeedsAlert = (o: DiscoSyncOutcome) => o === 'fm_unreadable' || o === 'disco_write_failed'

/** A missing Disco value is read as released (DIRECT), as every reader treats it. */
const sameFlow = (disco: string | null, fm: string) => (disco ?? 'DIRECT') === fm

/**
 * Makes Disco's Hold Payments equal FamilyMeal's live value. Writes Disco only; never FamilyMeal.
 * dryRun reads both and reports what it would do, writing and auditing nothing.
 */
export async function syncDiscoToFamilyMeal(
  deps: DiscoSyncDeps,
  args: { ref: string; fmRef: string; dryRun?: boolean },
): Promise<DiscoSyncResult> {
  const { ref, fmRef } = args
  let fmRead: { status: number; moneyFlow: string | null }
  try { fmRead = await deps.fmGet(fmRef) } catch { fmRead = { status: 0, moneyFlow: null } }
  const fm = fmRead.status >= 200 && fmRead.status < 300 ? parseMoneyFlow(fmRead.moneyFlow) : null
  const discoBefore = await safe(() => deps.discoGet(ref))
  if (!fm) {
    const error = fmRead.status >= 200 && fmRead.status < 300
      ? `FamilyMeal returned no valid Hold Payments value (${fmRead.moneyFlow ?? 'none'}).`
      : `FamilyMeal couldn't be read (${fmRead.status || 'unreachable'}).`
    return { outcome: 'fm_unreadable', discoBefore, fm: null, discoAfter: discoBefore, error }
  }
  if (sameFlow(discoBefore, fm)) return { outcome: 'already_in_sync', discoBefore, fm, discoAfter: discoBefore }
  if (args.dryRun) return { outcome: 'synced', discoBefore, fm, discoAfter: discoBefore }

  const extra = { source: 'familymeal_sync', fmReference: fmRef }
  let wrote = false
  let writeError: string | null = null
  try { wrote = await deps.discoWriteIf(ref, discoBefore, fm) } catch (e) { writeError = e instanceof Error ? e.message : 'error' }
  const discoAfter = await safe(() => deps.discoGet(ref))

  if (!writeError && !wrote) {
    // Someone changed Disco between our read and our write (a Super Admin toggle). Not ours to undo.
    return { outcome: 'disco_changed', discoBefore, fm, discoAfter }
  }
  if (writeError || discoAfter !== fm) {
    const error = writeError
      ? `Disco couldn't save FamilyMeal's Hold Payments value (${writeError}).`
      : `Disco shows ${discoAfter ?? 'no value'} after saving ${fm}.`
    await deps.audit({ ok: false, before: { disco: discoBefore, fm }, after: { disco: discoAfter, fm }, extra: { ...extra, requested: fm, step: 'disco_write', error } }).catch(() => {})
    return { outcome: 'disco_write_failed', discoBefore, fm, discoAfter, error }
  }
  await deps.audit({ ok: true, before: { disco: discoBefore, fm }, after: { disco: fm, fm }, extra: { ...extra, requested: fm } }).catch(() => {})
  return { outcome: 'synced', discoBefore, fm, discoAfter: fm }
}
