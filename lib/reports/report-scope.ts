// Report location-scope sanitizer. The report generator scopes disco_orders by
// filter.locationReferenceIds (falling back to the report's own restaurant), and
// that list arrives from the client — so it must be constrained to the caller's
// OWN restaurants, else a crafted payload could pull other restaurants' orders
// into the report (RM8). Unknown/empty → the report's own restaurant only.
//
// ROLE GATES REACH (fixed 2026-09-01). This used to call getDiscoGroupAccounts
// directly, which answers "what is this email's group" without regard to role.
// That is the wrong question for an ADMIN: an ADMIN has exactly one location no
// matter how many grant rows they hold, and grant rows have drifted — six
// Atlanta Bread ADMINs each carry 8 while FM assigns them 1. Measured before
// this fix: sanitizeReportFilter accepted all 8 of
// stacy.freemyer@atlantabreadwoodstock.com's granted refs, so an ADMIN could put
// eight locations' ORDER DATA into a scheduled report even though the portal nav
// only ever offers her one. It now goes through resolveDiscoGroupScope, which
// returns home-ref-only for any role that isn't SYSTEM_ADMIN.
//
// This is a READ-path gate, deliberately mirroring the write path: see
// lib/restaurant-write-scope.ts, whose header explains why the raw group
// primitives are "unsafe to apply to a plain ADMIN too".
import { discoGroupRefs } from '../disco-restaurant-auth'
import { resolveDiscoGroupScope } from '../restaurant-write-scope'
import type { RestaurantAuthContext } from '../restaurant-auth-context'
import type { ReportFilter } from './native-reports'

export async function sanitizeReportFilter(
  ctx: RestaurantAuthContext,
  scope: string,
  rawFilter: unknown,
): Promise<ReportFilter> {
  const f = (rawFilter && typeof rawFilter === 'object' && !Array.isArray(rawFilter))
    ? (rawFilter as Record<string, unknown>) : {}

  const gate = await resolveDiscoGroupScope(ctx)
  // SUPER_ADMIN keeps EXACTLY today's behaviour — scope + their own group —
  // rather than becoming unrestricted here. Widening the Disco team's report
  // filter is not part of this fix; the narrowing is a documented deferral
  // (a true "any restaurant" filter needs a real list-all query, not built).
  const reachable = gate.unrestricted
    ? await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)
    : gate.refs

  const accessible = new Set<string>([scope, ...reachable].filter(Boolean))
  const locationReferenceIds = (Array.isArray(f.locationReferenceIds) ? f.locationReferenceIds : [])
    .map(String).filter(x => accessible.has(x))
  return { ...(f as ReportFilter), locationReferenceIds }
}
