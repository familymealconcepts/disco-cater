# Native Conversion Runbook

Written for Peter, running conversions directly with Claude Code and DB
access. No hand-holding — FM is the source of truth for a restaurant's real
settings, and where something looks off after conversion, the fix is manual,
after the fact.

**Conversions are one at a time right now.** Everything below assumes that.
See "Batch" at the end for what changes if that stops being true.

**There is no rollback.** `is_disco_native` is written to `true` in exactly
two places in the codebase, and neither ever sets it back to `false`. Once a
restaurant converts, there is no code path to FM-backed again, and re-running
the menu import doesn't replace a bad import — it duplicates it. If
something's wrong post-conversion, fix it forward in Neon. Don't convert a
restaurant you're not ready to fix forward.

**Two tiers.** Tier 1 is the short checklist you run for every single
conversion. Tier 2 is a one-time batch-readiness gate — it already ran, once,
and its result is the reason batching is unblocked. It does not run again per
restaurant.

---

## Tier 1 — the procedure

### 1. Confirm the FM restaurant reference

`GET /api/admin/restaurants/{ref}` (service auth) — `status` is `ACCEPTED`,
and it's not a duplicate.

**Gotcha:** decoy rows exist for real restaurants (extra locations, "-NEW"
duplicates) that never converted — converting the wrong one is a real
failure mode, not hypothetical. `runPreflightCheck`
(`lib/conversion-preflight.ts`) checks this for you.

### 2. Stripe — reuse, never re-onboard

1. Get the real `acct_...` id from FM's `tbl_stripe_connected_accounts`,
   matched by restaurant **reference**, not business name (names collide
   across locations and franchises).
2. `verifyAccountReusable(accountId)` — live Stripe check
   (`charges_enabled && capabilities.transfers === 'active'`; ignore
   `requirementsDue`, it doesn't block reuse).
3. `importRestaurantStripeAccount(ref, accountId)` — one call, no
   restaurant action.

**Gotcha:** `stripeMode: "not-linked"` means the account id hasn't been
*imported* — it does not mean the restaurant needs to onboard.

**Gotcha:** don't confuse this with `app/api/admin/sync-stripe-status/route.ts`
— a separate writer of the same `stripe_connected` column that checks FM's
*own* Stripe-Connect status, not native reuse-eligibility. It can read `true`
with zero rows in `disco_restaurant_accounts` behind it.

### 3. Tax rate

Set `disco_restaurant_overrides.tax_rates.stateSalesTax.percent` via
`PUT /api/restaurant/tax-rate` (writes Neon directly — no ongoing FM mirror,
enter it once).

**Gotcha:** `0` is a valid, real rate — only `null`/missing blocks the gate.
A native restaurant with a null percent charges **$0 tax on every order**.

**Gotcha:** if FM genuinely has nothing here, that's a conversation with the
restaurant, not a data-recovery task.

### 4. Menu — faithful FM import

`importFmMenuFaithfully(fmRef)` (`lib/menu-import/fm-faithful-import.ts`, via
`POST /api/admin/restaurants/{ref}/import-fm-menu`) — one call. **Not** the
AI-PDF importer (`writeDiscoNativeMenu`), which drops modifier prices and
settings.

**Gotcha:** items on an Inactive/hidden menu, or an individually hidden item
on an otherwise-active menu, won't show up via the primary pass — a
supplementary heuristic pass catches them. A genuinely shared item
duplicating across menus it belongs to is correct, not a bug.

**Gotcha:** `maxOrder` is deliberately never auto-imported (FM's cap is
per-15-minute-window, Disco's is per-day) — a manual decision if the
restaurant wants a cap.

### 5. Marketplace visibility

`disco_restaurant_overrides.visible` must be explicitly `true` (the "Disco
Cater Marketplace" toggle) before the gate's `marketplace-ready` step can
pass — independent of Stripe. Already set for anything that went through
normal onboarding; only relevant if you're converting something unusual
enough to have skipped it.

### 6. Confirm readiness, then convert

Run `checkConversionReadiness(ref)` — all five blocking steps
(`not-already-native`, `native-menu`, `stripe-ready`, `settings`,
`marketplace-ready`) should read `done: true`. Then `convertToNative(ref)`.

**Gotcha:** never `goLiveNativeRestaurant` — that's a different function for
restaurants starting native from zero (gates on a real $1 charge and a real
signed Expedite dispatch, neither relevant here).

`convertToNative` backfills FM's order history first (aborts, doesn't
convert, if FM is unreachable — lead-gen fee-tier history must never be
silently lost), flips `is_disco_native` **and** `is_live` together in the
same call, then fires the invite and carry-over steps below, best-effort.
It's a one-way flag flip on Disco's side only — FM stays untouched, same
admin login, same order flow, until routing stops sending customers there.

### 7. Confirm the invite landed — required, not optional

`convertToNative` auto-invites FM's per-restaurant `admin.email` **and**
every FM SYSTEM_ADMIN covering this restaurant (`inviteFmSystemAdminsFor`) —
these are genuinely separate FM data, not redundant.

**Gotcha:** FM's system-admin list is authoritative — don't hand-grant
`grantLocationAccess` for anyone; it does no FM cross-check, so a manual
grant can silently disagree with FM's real structure. Re-sync from FM if a
location's access ever looks wrong.

Query `disco_restaurant_accounts` for the new row(s) — `invite_token IS NOT
NULL`, `invite_token_expires_at` in the future — then confirm the link
itself, cold, no session:

```
curl -s "https://www.discocater.com/api/restaurant/accept-invite?token=<token>"
# expect: {"valid":true,"email":"...","restaurantName":"..."} matching the real person/restaurant
```

Tokens last 14 days. If one's dead or was never sent, use **Resend invite**
in the super admin's `manage-restaurants/ordering` table (⋯ menu) — the
**expired-invite badge** there flags it automatically; that's the live
source of truth for invite status, not this doc.

### 8. Notifications, closed days, promo codes — expected to fail

`convertToNative` attempts all three and, on failure, sets an audit column
(`notification_settings_flagged_at` / `closed_days_flagged_at` /
`promo_codes_flagged_at`) instead of losing them silently.

**This fails every time by design — see Background for why.** Enter
manually:
- Notifications: check `disco_restaurant_overrides.notification_emails`
  first — often already populated from an earlier bulk mirror.
- Closed days: native "Closed Days" settings page, self-service.
- Promo codes: native promo-code UI.

### 9. Send the invite email — the only restaurant communication

Only after step 7 passes. One email, no advance notice, no feature pitch, no
fee discussion:

```
From:     Disco Cater Concierge <concierge@discocater.com>
Reply-To: concierge@discocater.com
Subject:  {Restaurant Name} is live on Disco Cater

Hi {First Name},

{Restaurant Name} is now live on Disco Cater.

To get in, set a new password. Your login email stays the same.

[Set your password]  -> https://www.discocater.com/restaurant/accept-invite?token={token}

The link is good for 14 days — reply if you need a new one.

Disco Cater Concierge
concierge@discocater.com
```

One email per person, one token per person, never reused. Confirm delivery
via Mailgun's Events API (`accepted`/`delivered`, not just that the send call
returned success).

### 10. Post-conversion verification

- Login works: step 7's check, plus a real `disco_restaurant_sessions` row
  once someone actually logs in.
- Live and visible on the marketplace (native 3-part rule — see Background,
  `stripe_connected` alone isn't a valid signal).
- Menu renders on the customer-facing page, modifier prices included.
- FM is untouched — the restaurant's FM login and order flow still work.

---

## Tier 2 — the batch-readiness gate (ran once, 2026-08-14 — do not re-run per restaurant)

Two subjects, Stripe/payout reconciliation explicitly out of scope (Peter is
confident payouts work): **Subject A** — a fresh FM test restaurant, built
out and converted end to end via an explicit, logged, never-committed Stripe
bypass, to exercise mechanics Glen Rock's real history can't (a null-tax
block, a hidden item, the carry-over walls against known real data). **Subject
B** — Francesca Catering – Glen Rock, 377 real orders (2022-09-01 to
2026-08-20), checked against live FM values.

Classification used throughout: **SYSTEMIC** (a whole category missing or a
pattern across many orders — would block batching), **ISOLATED** (a handful
of orders, no shared cause), **KNOWN IRRECOVERABLE** (accepted without
investigation — see Background).

### Subject A — Disco Parity Test 2026-08-14

| Check | Result |
|---|---|
| Native / visible / live after conversion | PASS |
| Menu item count/structure matches FM exactly, incl. $0.00 modifier | PASS |
| Hidden/inactive item via supplementary heuristic pass | PASS — learned category placement, not the blind fallback |
| Notifications flagged, not lost | PASS |
| Closed days flagged, not lost | PASS |
| Promo code flagged, not lost | PASS |
| Admin invited, accept-invite URL valid cold | PASS |
| Expired-invite badge clean | PASS |
| Null-tax blocks; explicit 0% passes | PASS |
| Marketplace-visibility toggle is a real, separate prerequisite | CONFIRMED |
| Teardown: FM soft-delete | DONE |
| Teardown: gone from counts / marketplace / system-admins | CONFIRMED |
| Teardown: Neon cleanup | DONE |

### Subject B — Francesca Catering – Glen Rock (377 orders)

| Check | Result | Classification |
|---|---|---|
| Every order has items + a transaction row | 377/377 | — |
| Tax populated | 377/377 | — |
| `tips_in_price` accuracy | 30/30 sampled | PASS |
| Fulfillment-time rule | Verified against real timestamps | PASS |
| Tax-exempt orders (2) | Both correct | PASS |
| `service_charge`/`stripe_fee` null | 16/377 (all `FM_SYNC`-sourced) | KNOWN IRRECOVERABLE |
| `lead_gen_one_disco_fee` null | 350/377, all pre-2026 | KNOWN IRRECOVERABLE (newly characterized) |
| `source` null | 2/377 | ISOLATED |
| DLIVRD order with fee in wrong column | n=1 | ISOLATED |
| Reporting-surface agreement | Same query path already verified complete | pass-by-construction |

**Verdict: zero systemic issues. Batching is not blocked by data parity.**

---

## Background

Reference material — why things are the way they are. Not procedure; skip
this section when actually running a conversion.

**Stripe reuse, proven.** All 6 DeCheco's accounts checked live
(`charges_enabled` + `transfers: active`), plus Glen Rock, Elmwood Park,
Briscola, and Pelican's already-imported accounts — reuse, not onboarding,
every time so far.

**Tax rate reality.** FM's own data for DeCheco's 6 locations has
`stateSalesTax.percent: null` — genuinely nothing to mirror, not an access
problem. Pelican Delicatessen is the counter-example: `0%` there is a real,
deliberate rate (state/local/other all explicitly `0`), which is why the
gate checks for a real number rather than treating any falsy value as
missing.

**Menu import mechanics.** The primary placement pass is exact, no
heuristics — it walks FM's public per-menu endpoint, which only ever returns
items on a menu FM currently marks visible/active. The supplementary pass
covers everything that misses that (most commonly an Inactive menu's items,
but confirmed 2026-08-14 to also catch a single item hidden on an otherwise-
active menu) via priority order: exact schedule-window match → learned
category placement → name overlap → a party-size regex → first-visible-menu
as a last resort. Proven clean on all 6 DeCheco's locations (29 items, 5
categories, 9 modifier groups, 87 modifiers each, zero fallback placements)
and again on the 2026-08-14 test restaurant, where the hidden item landed via
learned category placement (not the fallback) and a genuine $0.00 modifier
imported at the correct price.

**Marketplace visibility, confirmed independent of Stripe.** On the freshly
created 2026-08-14 test restaurant, the gate reported two failing blocking
steps until `disco_restaurant_overrides.visible` was set — `stripe-ready`
(expected) and `marketplace-ready` citing "Marketplace visibility is off" as
an independent reason. Once `visible` was set, `marketplace-ready`'s only
remaining failure reason collapsed to the Stripe one, confirming it's a real,
separate, one-time setup step.

**Why `inviteFmSystemAdminsFor` exists.** The single per-restaurant `admin`
field and FM's system-admin list are genuinely separate data — confirmed
real on DeCheco's, where one person was SYSTEM_ADMIN across all 6 locations
but was never any single location's `admin.email`, so nothing invited him
until this function was added. It reads FM's full system-admin list and
invites everyone whose `managedRestaurants` includes the restaurant,
skipping anyone who already has an account.

**Why hand-granting location access is a mistake.** `grantLocationAccess`
does no FM cross-check at all — a manual grant can silently disagree with
FM's real structure. This happened for real on DeCheco's: two people were
manually granted all 6 locations on the belief they were single-location
admins, when FM's system-admin list already covered all 6 correctly through
four different real admins. Always re-sync from FM instead of hand-editing
`disco_restaurant_location_access`.

**Invite tokens are 14 days, not 72 hours.** The original 72-hour window is
exactly how several restaurants' first retroactive invites died unused
before anyone clicked them — extended via `setInviteToken`.

**The carry-over walls — two different mechanisms.** Notifications and
promo codes are a **hard role exclusion**, not merely session-scoping:
`NotificationSettingController` and `CouponController` are both annotated
`@PreAuthorize("hasAnyAuthority('ADMIN', 'SYSTEM_ADMIN')")` — SUPER_ADMIN is
not in that list, for any credential, ever. Confirmed live against a
restaurant with real, known data behind it: the service account gets
`HTTP 500 "Access is denied"` from both, every time. Closed days is a
different, genuine **empty-response wall** — `RestaurantClosedDayController`
does allow SUPER_ADMIN, but `GET /api/closedDays` still returns `200 []` for
a restaurant independently confirmed (2026-08-14) to have 13 real rows (12
default holidays + 1 custom range) behind that same login.

**Two carry-over parsing gaps, found 2026-08-14, not yet fixed** (would
still bite even if the access walls above were ever lifted): `carryOverClosedDays`'s
field-name guesses (`holiday`/`name`/`fromDate`/`toDate`) don't match FM's
real shape at all — the real DTO is `{ eventName, available, eventDates:
[dates...] }`, a flat list of discrete dates, no `holiday` field.
`carryOverPromoCodes`'s field names are actually correct (`code`,
`discountPercentage`, `maxAvailable`, `maxPerDiner`, `startDate`, `endDate`
all match FM's real `CouponResponseDto`), but the shape assumption is
wrong — the code expects an array; FM's real `GET /api/coupon` returns a
single object (one coupon per restaurant, no list endpoint exists).

**Two real FM bugs, found incidentally, out of scope to fix here:**
FM's `POST /api/mealPackages` (and every sibling create/update path) throws
an unhandled NPE if `inheritScheduleOptionFromRestaurant` is omitted — typed
`Boolean` on the DTO but unboxed into a primitive `boolean` with no null
guard. Include it explicitly. Separately, FM's JWT auth does **not** use a
`Bearer ` prefix — send `Authorization: <jwt>` raw, or it fails to parse and
reads as a generic 401.

**Known-irrecoverable fields — confirm the count hasn't grown, don't
investigate further:** `service_charge` and `stripe_fee` (null on every
`FM_SYNC`-sourced transaction row, only present on `FM_BACKFILL` rows),
~10% of `tips_in_price` fleet-wide, `tax_exempt_state`, a small number of
orders with unreachable FM fetches and `FM_BACKFILL` artifacts. The
2026-08-14 gate additionally found `lead_gen_one_disco_fee` null for every
pre-2026 order at Glen Rock — FM's own lead-gen tracking doesn't go back
further, not a sync gap.

**`stripe_connected` isn't a valid native-readiness signal by itself** —
every converted restaurant inherits it `true` from a historical migration
regardless of real readiness. The marketplace visibility rule ORs it with
`hasCompletedNativeStripeAccount`, which is the one that means something
post-conversion.

**Multi-location brands need nothing special for admin access** — DeCheco's
(6 locations) needed zero extra work once FM's system-admin structure was
read correctly; `inviteFmSystemAdminsFor` mirrors it automatically per
location as each one converts. Stripe import, tax entry, menu import, and
the conversion flip itself are still genuinely one call per location — the
win is only that nobody has to think about admin access location-by-location.

---

## Batch

What changes when converting more than one restaurant at a time:

- The invite email (§9) needs a real bulk-send path with per-recipient
  Mailgun delivery confirmation — the verification step (§7) doesn't change,
  but running it N times by hand won't scale.
- `inviteFmSystemAdminsFor` re-fetches FM's entire ~363-record system-admin
  list on every single restaurant's conversion — harmless one-at-a-time,
  wasteful run back-to-back. Worth caching within a batch run.
- Nothing about Stripe/tax/menu parallelizes today — independent per
  restaurant, so batching them is a scripting question, not a design change.
- The Tier 2 gate does **not** re-run per restaurant — it's the reason
  batching is unblocked, not a per-restaurant precondition. Re-run it only
  if something structural changes (a new FM order-item catalog, a new payout
  path, a schema change to `disco_sale_transactions`).

Not building any of this now — noting it so batch mode doesn't start from
scratch when it's needed.
