// The portal's order report, loaded once for every surface that shows it.
//
// ── ONE LOADER, TWO SURFACES ──────────────────────────────────────────────────
// The Reporting page shows the report as an on-screen table
// (app/api/restaurant/reports/rows) and downloads it as CSV / Excel / PDF
// (app/api/restaurant/reports/export). Both call THIS: the same scope, the same
// rows, the same columns, the same totals and the same reconciliation refusal —
// so the screen and a download of the same window cannot disagree.
//
// The scope logic below was moved here verbatim from the export route; its
// comments are the export route's.
import { cookies } from 'next/headers'
import { resolveDiscoScopeRef, type RestaurantAuthContext } from '../restaurant-auth-context'
import { getRestaurantRef, getFmSessionPermittedRefs, RESTAURANT_TOKEN_COOKIE } from '../restaurant-auth'
import { resolveDiscoGroupScope } from '../restaurant-write-scope'
import { visibleReportColumns } from './visible-columns'
import {
  ORDER_REPORT_COLUMNS, LOCATION_COLUMN, buildOrderReportRows, totalsRow, reconcileRow,
  type OrderReportRow, type ReportColumnDef,
} from './order-report-rows'

export const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Every restaurant this session may report on. Never widened by the request:
 * the set comes from the session (and, for an FM admin with no location picked,
 * from FamilyMeal's own list). Empty means "pick a location first".
 */
export async function resolveReportRefs(ctx: RestaurantAuthContext): Promise<string[]> {
  // resolveDiscoScopeRef only resolves ctx.restaurantReference, which is always
  // '' for ordinary FM-authenticated sessions (only Disco-native sessions carry
  // it) — that silently 400'd Export Reports for every FM-backed restaurant.
  // FM sessions resolve their restaurant from the JWT itself via getRestaurantRef
  // (same fix as the menu-manager Items-column bug, same root cause).
  const ref = ctx.authType === 'disco' ? await resolveDiscoScopeRef(ctx) : (await getRestaurantRef()) || ''

  // ── A SESSION WITH NO SINGLE HOME IS NOT A SESSION WITH NO SCOPE ──────────
  // getRestaurantRef returns the FM JWT's `restaurant` claim, honouring the
  // selected-location cookie. An FM session that carries NEITHER — a
  // SYSTEM_ADMIN or SUPER_ADMIN who has not picked a location yet — resolved to
  // '' and the export answered {"error":"No restaurant in context"} as raw JSON
  // in the browser, because Export is a navigation rather than a fetch.
  //
  // Such a session does have a scope: the admin's Disco list (since 22 Oct
  // 2026; it was FamilyMeal's own list).
  // That is the SAME set the Reporting dashboard already charts for them
  // (dashboard/sale-stats builds refs the same way and deliberately never
  // errors), so Export matches the figures on screen instead of refusing.
  // No access is widened: the set comes from FamilyMeal, not from the request.
  let fmFallbackRefs: string[] = []
  if (!ref && ctx.authType !== 'disco') {
    const token = (await cookies()).get(RESTAURANT_TOKEN_COOKIE)?.value || ''
    if (token) fmFallbackRefs = [...(await getFmSessionPermittedRefs(token).catch(() => new Set<string>()))]
  }

  // MULTI-LOCATION. FM prepends a Location column for a SYSTEM_ADMIN covering
  // more than one restaurant, so the scope is the caller's whole reach rather
  // than one ref. resolveDiscoGroupScope is the role gate: a plain ADMIN gets
  // its own location no matter how many grant rows exist.
  //
  // MUST NOT be scoped to visibility/archive status — an archived restaurant's
  // history must keep exporting. Archiving is not deletion.
  const scope = await resolveDiscoGroupScope(ctx)
  const base = scope.unrestricted || scope.refs.size === 0 ? [ref] : [...new Set([ref, ...scope.refs])]
  return [...new Set([...base, ...fmFallbackRefs])].filter(Boolean)
}

/** The export's column set: visibleReportColumns, resolved to definitions. */
export function activeReportColumns(rows: OrderReportRow[], multiLocation: boolean): ReportColumnDef[] {
  const byKey = new Map<string, ReportColumnDef>(
    [LOCATION_COLUMN, ...ORDER_REPORT_COLUMNS].map(c => [c.key, c]),
  )
  return visibleReportColumns(rows, { multiLocation })
    .map(k => byKey.get(k))
    .filter((c): c is ReportColumnDef => !!c)
}

export type LoadedOrderReport =
  | { ok: true; rows: OrderReportRow[]; cols: ReportColumnDef[]; totals: Partial<OrderReportRow>; multiLocation: boolean }
  | { ok: false; broken: { r: OrderReportRow; c: ReturnType<typeof reconcileRow> }[] }

export async function loadOrderReport(opts: {
  refs: string[]; from: string; to: string; dateField: 'order_date' | 'created_at'; logTag: string
}): Promise<LoadedOrderReport> {
  const rows = await buildOrderReportRows({ refs: opts.refs, from: opts.from, to: opts.to, dateField: opts.dateField })

  // FAIL LOUDLY. The subsidy subtraction has never been exercised by a real
  // order — zero native orders carry one — so if the payout ever stops
  // reconciling against the row's own visible components, this refuses to
  // render rather than publishing a plausible wrong number. A quietly
  // misstated payout is the worst outcome available here.
  const broken = rows.map(r => ({ r, c: reconcileRow(r) })).filter(x => !x.c.ok)
  if (broken.length) {
    console.error(`[${opts.logTag}] payout failed to reconcile:`, broken.slice(0, 5).map(b => ({ order: b.r.orderId, expected: b.c.expected, got: b.r.totalDistributed, delta: b.c.delta })))
    return { ok: false, broken }
  }

  const multiLocation = new Set(rows.map(r => r.location)).size > 1
  return { ok: true, rows, cols: activeReportColumns(rows, multiLocation), totals: totalsRow(rows), multiLocation }
}

/**
 * The on-screen table's columns: the export's, plus Status and Payment always
 * (shown as badges), each in the export's own position.
 */
export function reportTableColumns(cols: ReportColumnDef[]): { key: string; label: string; financial: boolean }[] {
  const columns = cols.map(c => ({ key: c.key, label: c.label, financial: c.financial }))
  const ensure = (key: string, label: string, afterKey: string) => {
    if (columns.some(c => c.key === key)) return
    const at = columns.findIndex(c => c.key === afterKey)
    columns.splice(at >= 0 ? at + 1 : columns.length, 0, { key, label, financial: false })
  }
  ensure('orderStatus', 'Status', 'orderTime')
  ensure('paymentStatus', 'Payment', 'orderStatus')
  return columns
}
