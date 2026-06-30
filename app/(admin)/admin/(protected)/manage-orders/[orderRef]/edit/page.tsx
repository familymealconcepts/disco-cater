import EditOrderClient from '../../../../../../(restaurant)/restaurant/(portal)/orders/[orderRef]/edit/EditOrderClient'

// Super-admin full order edit — reuses the restaurant portal's Disco-native edit
// engine (items, quantities, date/time) via `context="admin"`. The same client
// hits the same /api/restaurant/orders/[ref]/{details,edit-status,edit} routes,
// which now accept the admin cookie and treat it as a SUPER_ADMIN edit (24h
// window bypassed; 3-edit cap + non-editable-status checks still apply).
export default async function AdminEditOrderPage({ params }: { params: Promise<{ orderRef: string }> }) {
  const { orderRef } = await params
  return <EditOrderClient orderRef={orderRef} context="admin" />
}
