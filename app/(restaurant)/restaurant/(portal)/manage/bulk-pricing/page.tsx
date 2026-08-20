import { getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import BulkPricingClient from './BulkPricingClient'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'

// SYSTEM_ADMIN-only tool to find a menu item across all locations and update its
// price everywhere. A plain ADMIN sees an explicit access-denied message
// instead of the tool.
//
// Bug fixed 2026-08-20: this used to call ONLY getRestaurantRole(), which
// decodes the FM-legacy `fm_restaurant_token` JWT -- always null for a
// Disco-native session, since that session's role lives on
// disco_restaurant_accounts (via `disco_restaurant_token`) instead. Every
// Disco-native SYSTEM_ADMIN (e.g. Basil Couvaras / bcouvaras@atlantabread.com,
// SYSTEM_ADMIN across all 9 Atlanta Bread locations) got treated as if their
// role were unset and silently redirect()'d to Orders -- a real bug, not a
// correct denial. Now resolves role the same dual-path way
// app/api/restaurant/bulk-pricing/{search,apply-one}/route.ts already do:
// ctx.role for a Disco-native session, the FM JWT decode only as a fallback.
export default async function BulkPricingPage() {
  const ctx = await getRestaurantAuthContext()
  const role = ctx?.authType === 'disco' ? ctx.role : await getRestaurantRole()

  if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') {
    return (
      <div style={{ maxWidth: 480, margin: '96px auto', padding: '0 24px', textAlign: 'center', fontFamily: F }}>
        <h1 style={{ fontSize: 19, fontWeight: 700, color: DARK, margin: '0 0 10px' }}>
          Bulk Menu Editor isn&rsquo;t available on this account
        </h1>
        <p style={{ color: '#666', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
          This tool is limited to system administrators managing multiple locations.
          {role === 'ADMIN' ? ' Your account is set up as a standard restaurant admin.' : ''}
          {' '}If this doesn&rsquo;t sound right, contact{' '}
          <a href="mailto:concierge@discocater.com" style={{ color: BLUE }}>concierge@discocater.com</a>.
        </p>
      </div>
    )
  }
  return <BulkPricingClient />
}
