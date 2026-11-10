// Server wiring for lib/money-flow-sync.ts: the real FamilyMeal and Disco reads/writes, the
// 15-minute "Disco matches FamilyMeal" sync, and the only Hold Payments alerts (a pair that can't be
// brought back in sync). A Hold Payments change itself never alerts, only audits.
import { sql } from './db'
import { logSettingsChange } from './settings-audit'
import { alertGroup, alertOnce, resolveAlert, syncAlertSet } from './ops-alert'
import { SUGGESTIONS } from './ops-alert-format'
import {
  parseMoneyFlow, label, syncDiscoToFamilyMeal, syncNeedsAlert, FAMILYMEAL_SYNC_ACTOR,
  type MoneyFlowDeps, type MoneyFlowResult, type DiscoSyncDeps, type DiscoSyncResult,
} from './money-flow-sync'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

/** The FamilyMeal reference behind a Disco restaurant (a native rebuilt under a new ref keeps its FM one). */
export async function fmRefFor(ref: string): Promise<string> {
  const acct = (await sql`
    SELECT fm_restaurant_reference FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} AND fm_restaurant_reference IS NOT NULL LIMIT 1
  `.catch(() => [])) as { fm_restaurant_reference: string }[]
  return acct[0]?.fm_restaurant_reference || ref
}

function fmGetFor(fmAuth: Record<string, string>): MoneyFlowDeps['fmGet'] {
  return async (fmRef) => {
    const r = await fetch(`${FM}/api/admin/restaurants/${fmRef}`, { headers: { ...fmAuth, Accept: 'application/json' }, cache: 'no-store' })
    if (!r.ok) return { status: r.status, moneyFlow: null }
    const j = (await r.json().catch(() => null)) as { moneyFlow?: string } | null
    return { status: r.status, moneyFlow: j?.moneyFlow ?? null }
  }
}

async function discoGet(ref: string): Promise<string | null> {
  const rows = (await sql`SELECT money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`) as { money_flow: string | null }[]
  return rows[0]?.money_flow ?? null
}

/** Super Admin toggle wiring (setMoneyFlowEverywhere). */
export function moneyFlowDeps(fmAuth: Record<string, string>, audit: { ref: string; actorEmail: string | null; native: boolean; fmRef: string }): MoneyFlowDeps {
  return {
    fmGet: fmGetFor(fmAuth),
    fmPut: async (fmRef, flow) => {
      const r = await fetch(`${FM}/api/admin/restaurants/${fmRef}/money-flow?moneyFlow=${flow}`, { method: 'PUT', headers: fmAuth })
      return { ok: r.ok, status: r.status }
    },
    discoGet,
    discoWrite: async (ref, flow) => {
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, money_flow, updated_at)
        VALUES (${ref}, ${flow}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET money_flow = ${flow}, updated_at = NOW()
      `
    },
    cacheWrite: async (fmRef, flow) => {
      await sql`
        UPDATE disco_restaurant_admin_list_cache SET raw = jsonb_set(raw, '{moneyFlow}', to_jsonb(${flow}::text))
        WHERE restaurant_reference = ${fmRef}
      `
    },
    audit: async (row) => {
      await logSettingsChange({
        action: row.ok ? 'money_flow_update' : 'money_flow_update_failed',
        restaurantReference: audit.ref,
        actorEmail: audit.actorEmail,
        authType: 'admin',
        before: { money_flow: row.before.disco, fm_money_flow: row.before.fm },
        after: { money_flow: row.after.disco, fm_money_flow: row.after.fm },
        extra: { source: 'super_admin', native: audit.native, fmReference: audit.fmRef, ...row.extra },
      })
    },
  }
}

/**
 * 15-minute sync wiring (syncDiscoToFamilyMeal): reads FamilyMeal, writes ONLY Disco's money_flow,
 * and only while it still holds the value the check read (a concurrent Super Admin change wins).
 */
export function familyMealSyncDeps(fmAuth: Record<string, string>, audit: { ref: string; native: boolean }): DiscoSyncDeps {
  return {
    fmGet: fmGetFor(fmAuth),
    discoGet,
    discoWriteIf: async (ref, expected, flow) => {
      const rows = (await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, money_flow, updated_at)
        VALUES (${ref}, ${flow}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET money_flow = ${flow}, updated_at = NOW()
          WHERE disco_restaurant_overrides.money_flow IS NOT DISTINCT FROM ${expected}::text
        RETURNING restaurant_reference
      `) as unknown[]
      return rows.length > 0
    },
    audit: async (row) => {
      await logSettingsChange({
        action: row.ok ? 'money_flow_update' : 'money_flow_update_failed',
        restaurantReference: audit.ref,
        actorEmail: FAMILYMEAL_SYNC_ACTOR,
        authType: 'system',
        before: { money_flow: row.before.disco, fm_money_flow: row.before.fm },
        after: { money_flow: row.after.disco, fm_money_flow: row.after.fm },
        extra: { native: audit.native, ...row.extra },
      })
    },
  }
}

export type MoneyFlowMismatch = { ref: string; name: string; native: boolean; disco: string | null; fm: string | null }

/**
 * Restaurants whose Disco and FamilyMeal Hold Payments differ, from the 15-minute admin-list copy
 * of FamilyMeal. A missing Disco value is compared as released (DIRECT), which is what every
 * reader treats it as. Deleted and archived copies are skipped.
 */
export async function findMoneyFlowMismatches(): Promise<MoneyFlowMismatch[]> {
  const rows = (await sql`
    WITH m AS (
      SELECT DISTINCT ON (c.restaurant_reference)
             c.restaurant_reference::text AS ref, c.name, COALESCE(c.is_disco_native, false) AS native, o.money_flow AS disco,
             COALESCE(a.fm_restaurant_reference::text, c.restaurant_reference::text) AS fm_ref
        FROM disco_restaurant_cache c
        LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
        LEFT JOIN disco_restaurant_accounts a ON a.restaurant_reference::text = c.restaurant_reference::text AND a.fm_restaurant_reference IS NOT NULL
       WHERE c.name NOT ILIKE '%[deleted]%' AND c.name NOT ILIKE '%[archived]%'
       ORDER BY c.restaurant_reference
    )
    SELECT m.ref, m.name, m.native, m.disco, l.raw->>'moneyFlow' AS fm
      FROM m JOIN disco_restaurant_admin_list_cache l ON l.restaurant_reference::text = m.fm_ref
     WHERE l.raw->>'moneyFlow' IN ('DIRECT', 'FAMILY_MEAL')
       AND COALESCE(m.disco, 'DIRECT') <> l.raw->>'moneyFlow'
     ORDER BY m.name
  `) as MoneyFlowMismatch[]
  return rows
}

const MISMATCH_PREFIX = 'money-flow-mismatch:'
const CHANGE_FAILED_PREFIX = 'money-flow-change-failed:'
const keyOf = (prefix: string, ref: string) => `${prefix}${ref.toLowerCase()}`

export type MoneyFlowSyncRun = {
  /** Restaurants the 15-minute copy showed as differing. */
  checked: number
  synced: { ref: string; name: string; from: string | null; to: string }[]
  unresolved: (MoneyFlowMismatch & { result: DiscoSyncResult })[]
  dryRun: boolean
}

/**
 * The 15-minute check. For every restaurant whose Disco and FamilyMeal Hold Payments differ in the
 * admin-list copy, makes Disco equal FamilyMeal's LIVE value (syncDiscoToFamilyMeal) and audits it.
 * No alert for a sync. One alert per restaurant that can't be brought back in sync (FamilyMeal
 * unreadable, Disco write failed), resolved in its thread once it is. dryRun writes nothing and
 * touches no alert.
 */
export async function syncMoneyFlowFromFamilyMeal(fmAuth: Record<string, string>, opts: { dryRun?: boolean } = {}): Promise<MoneyFlowSyncRun> {
  const dryRun = opts.dryRun === true
  const mismatches = await findMoneyFlowMismatches()
  const fmRefs = new Map<string, string>()
  if (mismatches.length) {
    const rows = (await sql`
      SELECT restaurant_reference::text AS ref, fm_restaurant_reference::text AS fm_ref FROM disco_restaurant_accounts
       WHERE restaurant_reference::text = ANY(${mismatches.map(m => m.ref)}) AND fm_restaurant_reference IS NOT NULL
    `) as { ref: string; fm_ref: string }[]
    for (const r of rows) if (!fmRefs.has(r.ref)) fmRefs.set(r.ref, r.fm_ref)
  }
  const run: MoneyFlowSyncRun = { checked: mismatches.length, synced: [], unresolved: [], dryRun }
  for (const m of mismatches) {
    const fmRef = fmRefs.get(m.ref) || m.ref
    const result = await syncDiscoToFamilyMeal(familyMealSyncDeps(fmAuth, { ref: m.ref, native: m.native }), { ref: m.ref, fmRef, dryRun })
    if (result.outcome === 'synced' && result.fm) run.synced.push({ ref: m.ref, name: m.name, from: result.discoBefore, to: result.fm })
    else if (syncNeedsAlert(result.outcome)) run.unresolved.push({ ...m, result })
  }
  for (const s of run.synced) {
    console.log(`[money-flow-sync] ${dryRun ? 'would set' : 'set'} Disco Hold Payments to FamilyMeal's for ${s.name} (${s.ref}): ${s.from ?? 'null'} -> ${s.to}`)
  }
  if (dryRun) return run

  const unresolvedKeys = run.unresolved.map(u => keyOf(MISMATCH_PREFIX, u.ref))
  await alertGroup(run.unresolved.map(u => ({ ...u, key: keyOf(MISMATCH_PREFIX, u.ref) })), fresh => ({
    severity: 'warn',
    headline: fresh.length === 1
      ? `Hold Payments couldn't be synced for ${fresh[0].name}: Disco ${label(parseMoneyFlow(fresh[0].disco) ?? 'DIRECT')}, FamilyMeal ${label(parseMoneyFlow(fresh[0].fm))}`
      : `Hold Payments couldn't be synced between Disco and FamilyMeal for ${fresh.length} restaurants`,
    lines: [
      ...fresh.slice(0, 10).map(u => `${u.name}: Disco ${label(parseMoneyFlow(u.disco) ?? 'DIRECT')}, FamilyMeal ${label(parseMoneyFlow(u.fm))}. ${u.result.error ?? ''}`.trim()),
      'Orders each system processes follow that system\'s value. The check retries every 15 minutes; nothing else was changed.',
    ],
    action: 'if it doesn\'t clear on its own, choose Hold both or Release both on the restaurant\'s Ordering row.',
    link: SUGGESTIONS.accountManagement,
    context: { refs: fresh.map(u => u.ref) },
  }))
  // Closes any open mismatch thread (including ones raised before 2026-11-10, when every difference
  // alerted) whose restaurant is now in sync.
  await syncAlertSet(MISMATCH_PREFIX, unresolvedKeys, () => 'Resolved: Hold Payments matches in Disco and FamilyMeal.')
  // A failed Super Admin change closes once the two agree again.
  await syncAlertSet(CHANGE_FAILED_PREFIX, unresolvedKeys.map(k => CHANGE_FAILED_PREFIX + k.slice(MISMATCH_PREFIX.length)),
    () => 'Resolved: Disco and FamilyMeal agree on Hold Payments again.')
  return run
}

/**
 * Super Admin side: a Hold Payments change that failed or was rolled back is the one thing that
 * alerts (a successful change only audits). Once per restaurant while open; a later successful
 * change, or the 15-minute check finding the two in sync, resolves it.
 */
export async function alertMoneyFlowChangeFailed(args: { ref: string; actorEmail: string | null; result?: MoneyFlowResult; error?: string }): Promise<void> {
  const name = ((await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${args.ref} LIMIT 1`.catch(() => [])) as { name: string | null }[])[0]?.name || args.ref
  const r = args.result
  await alertOnce(keyOf(CHANGE_FAILED_PREFIX, args.ref), {
    severity: 'warn',
    headline: `Hold Payments change didn't complete for ${name}`,
    lines: [
      r ? `Asked for ${label(r.requested)} by ${args.actorEmail ?? 'unknown admin'}. ${r.error ?? ''}`.trim() : `Requested by ${args.actorEmail ?? 'unknown admin'}. ${args.error ?? ''}`.trim(),
      r ? `Disco now ${label(parseMoneyFlow(r.discoAfter))}, FamilyMeal now ${r.fmRecord ? label(parseMoneyFlow(r.fmAfter)) : 'no record'}.` : 'Check both systems.',
    ],
    action: 'check the restaurant\'s Ordering row and try again.',
    link: SUGGESTIONS.accountManagement,
    context: { ref: args.ref },
  })
}

/** A successful Super Admin change closes that restaurant's open failure alert, if any. */
export async function resolveMoneyFlowChangeFailed(ref: string): Promise<void> {
  await resolveAlert(keyOf(CHANGE_FAILED_PREFIX, ref), 'Resolved: Hold Payments was changed in both Disco and FamilyMeal.')
}
