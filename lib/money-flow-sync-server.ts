// Server wiring for lib/money-flow-sync.ts: the real FamilyMeal and Disco reads/writes, and the
// 15-minute mismatch report. Never decides a value on its own.
import { sql } from './db'
import { logSettingsChange } from './settings-audit'
import { alertGroup, syncAlertSet } from './ops-alert'
import { SUGGESTIONS } from './ops-alert-format'
import { parseMoneyFlow, label, type MoneyFlowDeps } from './money-flow-sync'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

/** The FamilyMeal reference behind a Disco restaurant (a native rebuilt under a new ref keeps its FM one). */
export async function fmRefFor(ref: string): Promise<string> {
  const acct = (await sql`
    SELECT fm_restaurant_reference FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} AND fm_restaurant_reference IS NOT NULL LIMIT 1
  `.catch(() => [])) as { fm_restaurant_reference: string }[]
  return acct[0]?.fm_restaurant_reference || ref
}

export function moneyFlowDeps(fmAuth: Record<string, string>, audit: { ref: string; actorEmail: string | null; native: boolean; fmRef: string }): MoneyFlowDeps {
  return {
    fmGet: async (fmRef) => {
      const r = await fetch(`${FM}/api/admin/restaurants/${fmRef}`, { headers: { ...fmAuth, Accept: 'application/json' }, cache: 'no-store' })
      if (!r.ok) return { status: r.status, moneyFlow: null }
      const j = (await r.json().catch(() => null)) as { moneyFlow?: string } | null
      return { status: r.status, moneyFlow: j?.moneyFlow ?? null }
    },
    fmPut: async (fmRef, flow) => {
      const r = await fetch(`${FM}/api/admin/restaurants/${fmRef}/money-flow?moneyFlow=${flow}`, { method: 'PUT', headers: fmAuth })
      return { ok: r.ok, status: r.status }
    },
    discoGet: async (ref) => {
      const rows = (await sql`SELECT money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`) as { money_flow: string | null }[]
      return rows[0]?.money_flow ?? null
    },
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
        extra: { native: audit.native, fmReference: audit.fmRef, ...row.extra },
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

/**
 * Posts one ops alert per restaurant that newly differs and resolves it when they match again.
 * Reports only: neither system is changed, because which value is right is Peter's call.
 */
export async function alertMoneyFlowMismatches(): Promise<MoneyFlowMismatch[]> {
  const mismatches = await findMoneyFlowMismatches()
  const key = (r: MoneyFlowMismatch) => `money-flow-mismatch:${r.ref.toLowerCase()}`
  await alertGroup(mismatches.map(r => ({ ...r, key: key(r) })), fresh => ({
    severity: 'warn',
    headline: fresh.length === 1
      ? `Hold Payments differs: ${fresh[0].name} is ${label(parseMoneyFlow(fresh[0].disco) ?? 'DIRECT')} in Disco, ${label(parseMoneyFlow(fresh[0].fm))} in FamilyMeal`
      : `Hold Payments differs between Disco and FamilyMeal for ${fresh.length} restaurants`,
    lines: [
      ...fresh.slice(0, 10).map(r => `${r.name}: Disco ${label(parseMoneyFlow(r.disco) ?? 'DIRECT')}, FamilyMeal ${label(parseMoneyFlow(r.fm))}`),
      'Orders each system processes follow that system\'s value. Nothing was changed.',
    ],
    action: 'choose Hold both or Release both on the restaurant\'s Ordering row.',
    link: SUGGESTIONS.accountManagement,
    context: { refs: fresh.map(r => r.ref) },
  }))
  await syncAlertSet('money-flow-mismatch:', mismatches.map(key), () => 'Resolved: Hold Payments matches in Disco and FamilyMeal.')
  return mismatches
}
