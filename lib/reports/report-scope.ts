// Report location-scope sanitizer. The report generator scopes disco_orders by
// filter.locationReferenceIds (falling back to the report's own restaurant), and
// that list arrives from the client — so it must be constrained to the caller's
// OWN restaurants, else a crafted payload could pull other restaurants' orders
// into the report (RM8). Unknown/empty → the report's own restaurant only.
//
// READ-PATH GAP (deliberately deferred, not fixed): doesn't branch on role at
// all, so a disco-native SUPER_ADMIN's report filter here is narrowed to
// `scope` (the report's own restaurant) + their group, same as anyone else —
// a true "any restaurant" report filter would need a real list-all query, not
// built. Never an error, never another owner's orders in the report.
import { getDiscoGroupAccounts } from '../disco-restaurant-auth'
import type { ReportFilter } from './native-reports'

export async function sanitizeReportFilter(
  ctx: { businessName: string | null; email: string },
  scope: string,
  rawFilter: unknown,
): Promise<ReportFilter> {
  const f = (rawFilter && typeof rawFilter === 'object' && !Array.isArray(rawFilter))
    ? (rawFilter as Record<string, unknown>) : {}
  const group = await getDiscoGroupAccounts(ctx.businessName, ctx.email)
  const accessible = new Set<string>([scope, ...group.map(g => g.restaurant_reference)].filter(Boolean))
  const locationReferenceIds = (Array.isArray(f.locationReferenceIds) ? f.locationReferenceIds : [])
    .map(String).filter(x => accessible.has(x))
  return { ...(f as ReportFilter), locationReferenceIds }
}
