# FM Stripe Card Storage — Audit

> Read-only audit + the one-line root-cause fix, written 2026-05-27. Highest-risk area in the codebase. Source of truth for the diner saved-card flow.

---

## Section 0 — TL;DR

The `/account/payment` "Save card" button was broken by a **single field-name mismatch**, not a missing implementation. The page already mounts Stripe Elements, tokenizes with `stripe.createToken()`, and POSTs to the right proxy — but it sent `{ token }` while FM expects `{ cardToken }`. The proxy forwarded the wrong field unchanged, FM ignored it, the save no-op'd.

Everything else (Stripe.js load, key source, GET card display, checkout saved-card handling) was already correct.

---

## Section A — FM saved-card flow (source of truth)

### A.1 Component
`pages/private/user/payment/` — `payment.component.ts`, `payment-card.component.ts`, `payment-card/update/update-payment-card.component.ts`.

**FM stores exactly ONE card** — the "default source". There is no list-all, no delete, no set-default. Adding a card replaces the existing one.

### A.2 Save flow (the exact sequence)
1. `GET /stripe/platform/info` → `{ publishableKey }` (`stripe.service.ts:66-68`). **Platform account** — `loadStripe(publishableKey)` with NO `stripeAccount` param (`update-payment-card.component.ts:220`).
2. Mount Stripe card Elements.
3. `stripe.createToken(cardElement)` → `{ token: { id: 'tok_...' } }` (`update-payment-card.component.ts:181`). **Legacy token API — NOT SetupIntent, NOT PaymentIntent.**
4. `POST /api/users/payment/defaultSource` with body **`{ cardToken: token.id }`** (`account.service.ts:126-128`, call site `update-payment-card.component.ts:200`).

### A.3 List / display
`GET /api/users/payment/defaultSource` → single `ICardDetails` (`account.model.ts:18-43`):

```ts
{ brand, last4, expMonth, expYear, name, cvcCheck, addressLine1, ... }
```

### A.4 Remove card
**`[NEEDS REVIEW]` — no delete endpoint in FM Angular source.** FM's model is single-card-replace: saving a new card overwrites the old. There is no "remove card to have zero cards on file" path. Disco Cater should NOT invent one — "Update" (re-POST a new card) is the only FM-supported mutation.

### A.5 Set default
N/A — single-card model. The one card IS the default.

### A.6 Stripe Connect
FM uses Connect for restaurant PAYOUTS, but diner saved cards live on the **platform** account (no `stripeAccount` on the save path). At checkout, the PaymentIntent carries the restaurant's connected `account` and Stripe.js is loaded with `{ stripeAccount }` for the charge — but the saved card itself is platform-scoped. The cross-account handoff is backend logic, `[NEEDS REVIEW]`, not visible in Angular and not our concern (FM backend handles it).

---

## Section B — Disco Cater state + the fix

### B.1 What was already correct
- `app/(customer)/account/payment/page.tsx` — loads existing card via `GET /api/fm-payment-source`, loads Stripe key from `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (fallback `/api/order/stripe-info`), mounts the card Element, calls `createToken`, displays the saved card. All correct and matching FM.
- `app/api/fm-payment-source/route.ts` GET — hits `/api/users/payment/defaultSource` with raw JWT. Correct.

### B.2 The bug
- Page sent `POST /api/fm-payment-source` with `{ token: result.token.id }`.
- FM expects `{ cardToken: token.id }` (§ A.2).
- The proxy forwarded `{ token }` unchanged → FM ignored it → silent no-op → "save doesn't work".

### B.3 The fix (landed this session)
- Page now sends `{ cardToken: result.token.id }`.
- Proxy normalizes defensively: accepts `cardToken` OR legacy `token`, always forwards `{ cardToken }` to FM. So any other caller using the old field keeps working.

### B.4 Remove card
Not built — FM has no delete endpoint (§ A.4). The page offers "Update" (replace), matching FM. Flagged.

### B.5 Checkout saved-card handling — already done
`CheckoutDrawer.tsx` already:
- Detects a saved card (`savedCard` state, loaded on entering the payment step).
- Offers "use saved card" vs "use new card" (`useNewCard` toggle).
- Sends `useDefaultPayment: usingSavedCard` to `/api/order/confirm-payment` (line 267).

This matches FM's `confirmWithDefaultSource` flag on `POST /api/userOrder/confirmPayment`. No change needed. The user-facing checkout already accepts saved cards.

`[NEEDS REVIEW]` — FM's confirm body has more fields (`paymentIntentId`, `paymentMethodId`) than our proxy sends (`token`, `useDefaultPayment`). Since checkout works in production today, our `/api/order/confirm-payment` proxy evidently translates correctly — not touching a working payment path.

---

## Section C — Proxy routes

| Route | Status |
|---|---|
| GET `/api/fm-payment-source` → FM `GET /api/users/payment/defaultSource` | ✅ existed, correct |
| POST `/api/fm-payment-source` → FM `POST /api/users/payment/defaultSource` | ✅ existed, **field-name normalize added** |
| DELETE | ❌ not built — FM has no endpoint (§ A.4) |

No new proxy files needed — the spec's `/api/payment-methods` routes would duplicate the working `/api/fm-payment-source` proxy. Kept the existing path to avoid churn.

---

## Section D — Env config

- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — set in `.env.local` (value not echoed). Page reads it first, falls back to `/api/order/stripe-info`.
- `STRIPE_PUBLISHABLE_KEY` + `STRIPE_SECRET_KEY` — also set.
- **`[NEEDS REVIEW]` for Peter**: confirm `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in Vercel (Production + Preview) is the **same Stripe account as FM's platform account**. If they differ, the diner's saved card (created against our publishable key) won't resolve to the FM customer FM expects, and saves/charges will fail with "no such customer". This is the one config risk that can't be verified from code — Peter must confirm the Vercel env value matches FM's platform Stripe account.

---

## Section E — Verification checklist for Peter

### E.1 — Saved card flow
1. `/account/payment` as a test diner → "No payment method on file" + card form.
2. Card field renders Stripe Element (not a blank box).
3. Enter `4242 4242 4242 4242`, future expiry, any CVV → Save card.
4. Card appears as `Visa ···· 4242 / Expires MM/YY`.
5. Reload → card persists.
6. Network tab on save: `POST /api/fm-payment-source` body is `{ cardToken: "tok_..." }` (NOT `{ token }`), returns 200.

### E.2 — Checkout with saved card
1. Restaurant page → add to cart → checkout → payment step.
2. Saved card shows as the default option; "use a different card" available.
3. Submit with saved card → order completes, no re-entry.

### E.3 — Env sanity
Confirm `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in Vercel matches FM's platform Stripe account (§ D).

---

## Section F — Deferred cleanups (this session)

| ID | Status | Notes |
|---|---|---|
| **E.1** drop `quantity` from checkout POST | ✅ done (commit `dc6254b`) | `buildCheckoutPayload` mapLine no longer emits `quantity`; FM reads `count` only. Pudding × 2 still yields `count: 2`. |
| **E.2** default menu = primary | ✅ done (commit `476ecd0`), `[NEEDS REVIEW]` | `fetchMenuData` sorts menus by `position` ascending so the admin-defined primary leads. FM itself does `menus[0]` with no client sort, so this is a defensible mirror of the admin's position ordering. Can't confirm the fix resolves the "[Copy] Summer Menu" symptom without the live `/public-api/menu` response for that restaurant. |
| **E.3** picker load time | ⏱ documented (below) | Can't measure from code. |
| **E.4** Sanity `fmReference` field | ⚠ not actionable here | The Sanity restaurant schema is NOT in the disco-cater repo — `sanity/` only contains `lib/client.ts`. The schema lives in the separate hosted Studio (`discocater.sanity.studio` per CLAUDE.md). Adding `fmReference` must be done in that Studio project, not here. Field spec for whoever does it: `defineField({ name: 'fmReference', title: 'FamilyMeal Reference', type: 'string', description: 'FM restaurant reference UUID for matching FM data as enrichment source.' })` — optional, no validation. |

### E.3 — Authorized Users picker load time

The location picker on the Authorized Users dialog calls `GET /api/restaurant/system-admin-restaurants` → FM `GET /api/system-admin/restaurants/list`. This is the **JWT-scoped** endpoint that returns only the SYSTEM_ADMIN's assigned locations (typically 1–30), NOT the SUPER_ADMIN's full 700-restaurant list.

By construction this is fast — a small payload, no pagination. The ~5s load Peter saw earlier was the SUPER_ADMIN `manage-admins` picker hitting `/api/admin/restaurants?size=1000` (all platform restaurants). That's a different page with a different endpoint.

**Cannot benchmark from code** — needs a live timing in DevTools Network tab. Expected < 1s for typical accounts. If it's slow, the bottleneck is FM's `/api/system-admin/restaurants/list` backend, not our proxy (which just forwards). Flagged for live verification.

---

## Open questions for Peter

1. **Remove-card** — FM has no delete endpoint. Confirm we should leave "Update/replace" as the only mutation (current behavior), or whether FM backend has an undocumented delete we should wire.
2. **Stripe account match** (§ D) — the one thing I can't verify from code. Must confirm the Vercel publishable key is FM's platform account.
3. **Checkout confirm payload** — our proxy sends a simpler body than FM's Angular client. It works today, so I left it. Worth confirming there's no edge case (e.g. 3DS / SCA cards) where the simpler payload fails.
