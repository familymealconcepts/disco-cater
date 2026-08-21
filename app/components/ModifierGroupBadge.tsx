// Shared by the customer item modal (RestaurantClient.tsx) and the
// restaurant-portal order editor (EditOrderClient.tsx) — previously two
// independent hand-written copies of this pill that had already drifted
// (the staff one never gained a satisfied state, and its count text stayed
// grey forever). Takes the two derived booleans rather than the group
// object itself, since the two callers' FmExtraItemsGroup interfaces don't
// quite agree on which fields are optional — the badge never needed the
// object, just these two flags, so sidestepping the interface mismatch
// entirely was simpler than reconciling it.
export function ModifierGroupBadge({ isRequired, isValid }: { isRequired: boolean; isValid: boolean }) {
  if (isRequired && isValid) {
    return (
      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, borderRadius: 20, padding: '2px 8px', background: '#F0FDF4', color: '#166534', letterSpacing: '0.04em' }}>
        ✓ COMPLETE
      </span>
    )
  }
  if (isRequired) {
    return (
      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, borderRadius: 20, padding: '2px 8px', background: '#FEF3E2', color: '#B45309', letterSpacing: '0.04em' }}>
        REQUIRED
      </span>
    )
  }
  return (
    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, borderRadius: 20, padding: '2px 8px', background: '#EEF0FD', color: '#4046B8', letterSpacing: '0.04em' }}>
      OPTIONAL
    </span>
  )
}
