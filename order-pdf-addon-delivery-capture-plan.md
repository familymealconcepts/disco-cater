# Follow-up: Capture itemized add-ons + true delivery instructions (order PDF + surfaces)

**Status:** DONE (2026-07-18, commit `420518e`) — native capture + FM delivery-instruction mirror + PDF loader/render shipped; FM per-item add-on mirror is wired best-effort (populates once parseFmOrder surfaces FM's orderAddOns).
**Opened:** 2026-07-16
**Origin:** Split out of the order-PDF layout rebuild (commit `0a8ed9c`), which
intentionally deferred these two items because they are **data-capture gaps**, not
rendering gaps. The bordered-grid PDF already reserves the structure; it just has no
data to populate for these two fields.
**Scope constraint:** Disco-native flows are the target. FM-backed orders stay
behaviorally untouched except that the sync should *read* FM's existing add-on /
delivery-instruction fields into the Neon mirror (mirror-only, no FM writes).

---

## Problem

The order PDF (and every surface that shows order detail) cannot show:
1. **Itemized add-ons / modifiers** as indented `+` sub-lines under each item.
2. **Delivery instructions** as their own section, distinct from the general order note.

## Root cause (verified during the rebuild investigation)

- **Add-ons:** `disco_order_items` has no add-on structure — columns are
  `id, reference, order_id, meal_package_reference, fm_package_id, name, quantity,
  price_per_unit, total_price, serves, notes, created_at`. Add-ons are currently
  **baked into `price_per_unit`** (native cart builds `price = base + addOns`) and are
  not stored as separate lines. `notes` is a free-text comment, not structured add-ons.
- **Delivery instructions:** `disco_orders` has no `delivery_instructions` column —
  only the generic `note` field (which the PDF currently uses for the Note box). FM's
  order object carries `dinerDeliveryInstructions`; Disco never persists it separately.

## Scope of work

1. **Schema**
   - Add-ons: either a new `disco_order_item_addons` table
     (`order_item_id, name, price, quantity`) or a JSONB `addons` column on
     `disco_order_items`. Prefer the table for queryability + parity with FM's
     `orderAddOns`.
   - `ALTER TABLE disco_orders ADD COLUMN IF NOT EXISTS delivery_instructions TEXT;`
   - Add migrations to `lib/migrations/001_disco_orders.sql` (follow the existing
     `ADD COLUMN IF NOT EXISTS` pattern used for `restaurant_address/phone`).

2. **Placement capture** — `lib/order/native-checkout.ts` (`placeNativeOrder`):
   persist per-item add-ons (name/price/qty) instead of baking them into
   `price_per_unit`, and persist `delivery_instructions` from the checkout payload.

3. **FM sync mirror** — `lib/fm-orders-sync.ts` (`upsertOne`): read
   `orderMealPackages[].orderAddOns` → item add-ons, and `dinerDeliveryInstructions`
   → `delivery_instructions`. Mirror-only; do not write back to FM.

4. **Loader** — `lib/order/order-pdf.ts` (`loadOrderPdfData`): load add-ons per item
   and `delivery_instructions`; extend `OrderPdfData.items[]` with an `addOns` array
   and add a `deliveryInstructions` field.

5. **Render** — `lib/order/order-pdf.ts` (`renderOrderPdf`): render add-ons as
   indented `+ {name} … {price}` sub-lines under each item row (FM style), and add a
   dedicated **"Delivery Instructions:"** bordered box (separate from the Note box).
   The single generator means all 5 surfaces inherit it automatically.

## Acceptance criteria

- A real Disco-native order placed **with add-ons and delivery instructions** renders,
  in the PDF: each add-on as an indented `+` sub-line under its item, and a
  Delivery Instructions section distinct from Note.
- Verified across all 5 surfaces (they already share one generator: confirmation
  download, customer email, restaurant email, SMS link, restaurant Orders tab).
- FM-backed orders: add-ons / instructions appear when FM supplied them, and no
  FM-facing behavior changes.
- Tested against a real order (not a $1 test order), the same way the layout rebuild
  was verified (synthetic rich order → full load→render → field assertions).

## References

- Layout rebuild + surface unification: commit `0a8ed9c`.
- Deferred note in `renderOrderPdf` (`lib/order/order-pdf.ts`): "Itemized add-ons +
  true delivery instructions are a deferred follow-up — that data isn't captured yet."
