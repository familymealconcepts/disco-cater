'use client'

/**
 * Customer-facing dietary + allergen labels for a menu item.
 *
 * These flags have existed on disco_menu_items, been read into the customer
 * payload by shared.tsx, and been rendered NOWHERE — so a restaurant ticking
 * "Gluten-free" in its own portal produced no customer-visible effect at all.
 * 26 items across 3 native restaurants are in that state today (Cena Vegan 17,
 * Aztec Dave's Cantina 8, Test 32 1).
 *
 * ── WHY CONTAINS-NUTS IS NOT JUST A FOURTH BADGE ──────────────────────────
 * Vegetarian / Vegan / Gluten-free are attributes a diner seeks out. Contains
 * nuts is a warning they need to NOT miss. Rendering them as one undifferentiated
 * row makes the warning read as a feature — the same visual weight as "Vegan"
 * says "here is something good about this dish". So the dietary three get a
 * quiet positive treatment and the nut warning gets the amber warning pair plus
 * a marker glyph, and it always sorts last so it is never buried mid-row.
 *
 * Amber (#FFFBEB / #92400E) rather than the red (#EF4444) this page already uses
 * for "Sold out" and cap errors: red here would read as an error state on the
 * item rather than information about it.
 *
 * ── WHY ABSENCE MUST NOT READ AS ASSESSED ─────────────────────────────────
 * An item with no glutenFree flag is not "contains gluten" — it means nobody
 * ticked the box. That distinction is invisible in any per-item badge system,
 * and it is NOT hypothetical here: both real restaurants have mixed menus. Cena
 * Vegan has 17 items flagged vegan and ONE that is not, which a diner could
 * easily read as "that one isn't vegan" when it may simply be unlabelled.
 *
 * Handled by DietaryLegend, rendered ONCE above a menu that has any labels at
 * all, rather than by a caveat on every card (which would be noise) or by
 * hiding the labels (which would waste real information the restaurant entered).
 * The legend states who provided the labels and that they appear only where the
 * restaurant added them. It deliberately offers no allergen advice of its own
 * and makes no claim about unlabelled items.
 *
 * ONE definition, both surfaces — the item card and the item detail modal
 * import the same component, because this codebase's recurring defect is a rule
 * duplicated across surfaces that then drifts (two DELIVERY_LABEL maps missing
 * the same key; a visibility clause pasted into five files).
 *
 * Wording matches the restaurant portal's own checkboxes exactly
 * (menu-manager/[ref] and manage-v2's _MealPackageForm): "Vegetarian",
 * "Vegan", "Gluten-free", "Contains nuts". One word per thing, both sides.
 */

export interface DietaryFlags {
  vegetarian?: boolean
  vegan?: boolean
  glutenFree?: boolean
  containsNuts?: boolean
}

/** True when the restaurant has said anything at all about this item. */
export function hasDietaryInfo(p: DietaryFlags | null | undefined): boolean {
  return !!p && (p.vegetarian === true || p.vegan === true || p.glutenFree === true || p.containsNuts === true)
}

const DIETARY: { key: keyof DietaryFlags; label: string }[] = [
  { key: 'vegan', label: 'Vegan' },
  { key: 'vegetarian', label: 'Vegetarian' },
  { key: 'glutenFree', label: 'Gluten-free' },
]

// Reuses the green already established in this codebase for a positive pill
// (the modifier-group "COMPLETE" badge), rather than introducing a new hue.
const POSITIVE = { background: '#F0FDF4', color: '#166534' }
const WARNING = { background: '#FFFBEB', color: '#92400E' }

export function DietaryBadges({ pkg, size = 'card' }: { pkg: DietaryFlags | null | undefined; size?: 'card' | 'modal' }) {
  // No flags → render NOTHING. Not an empty container, not a placeholder row:
  // an empty box beside every unlabelled item would itself imply the question
  // had been asked and answered.
  if (!hasDietaryInfo(pkg)) return null
  const p = pkg as DietaryFlags
  const fontSize = size === 'modal' ? 11 : 10
  const pill: React.CSSProperties = {
    fontSize, fontWeight: 700, borderRadius: 20, padding: size === 'modal' ? '3px 9px' : '2px 8px',
    whiteSpace: 'nowrap', lineHeight: 1.4,
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: size === 'modal' ? 10 : 6 }}>
      {DIETARY.filter(d => p[d.key] === true).map(d => (
        <span key={d.key} style={{ ...pill, ...POSITIVE }}>{d.label}</span>
      ))}
      {/* Always last, so the warning is never buried between positives. */}
      {p.containsNuts === true && (
        <span style={{ ...pill, ...WARNING, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span aria-hidden="true">⚠</span>Contains nuts
        </span>
      )}
    </div>
  )
}

/**
 * Rendered once above a menu, only when at least one visible item carries a
 * label. Attribution, not a disclaimer: it says who provided the information
 * and that it is shown only where they provided it. See the module header.
 */
export function DietaryLegend({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <div style={{ fontSize: 11.5, color: '#8a89a8', lineHeight: 1.5, margin: '0 0 12px' }}>
      Dietary labels are provided by the restaurant and shown only on items they have labelled.
    </div>
  )
}
