# Native Conversion Runbook

Written for Peter, running conversions directly with Claude Code and DB
access. No hand-holding, no pre-flight-check accumulation — FM is the source
of truth for what a restaurant's real settings are, and where something looks
off after conversion, the fix is manual, after the fact. This doc is the
procedure, not a design document; every claim in it is checked against real
records, not against how the code ought to behave.

**Conversions are one at a time right now.** Everything below assumes that.
See "Batch, later" at the end for what changes if that stops being true.

**There is no rollback.** `is_disco_native` is written to `true` in exactly
two places in the codebase, and neither ever sets it back to `false`. Once a
restaurant converts, there is no code path to FM-backed again, and re-running
the menu import doesn't replace a bad import — it duplicates it (`INSERT INTO
disco_menus` has no conflict handling). If something's wrong post-conversion,
fix it forward in Neon. Don't convert a restaurant you're not ready to fix
forward.

---

## Two tiers, not one

**Tier 1 — every conversion, every time.** Cheap, no order placement, no
payout reconciliation. The procedure below. Run it in full for every
restaurant that converts.

**Tier 2 — a one-time batch-readiness gate, not a recurring step.** The full
parity checklist: does everything that was in FM still work in Disco Cater,
to the cent, for real order history? This ran once, on 2026-08-14, covering
two subjects — a fresh FM test restaurant (conversion mechanics, including
the two carry-over/gate questions Tier 1 alone can't answer) and Francesca
Catering – Glen Rock (data parity, using 377 real orders). Its results are
the **batch-readiness record** at the bottom of this doc. It does not need to
run again before converting the next single restaurant — only before moving
from one-at-a-time to batch.

---

## Tier 1 — the procedure

### 1. Confirm the FM restaurant reference

Look it up directly (`GET /api/admin/restaurants/{ref}`, service auth, or
`tbl_restaurants` in fm_backup for a quick offline check) and confirm:
- `status` is `ACCEPTED`.
- It's not a duplicate. Real, live problem, not hypothetical — Glen Rock has
  a decoy *"Francesca Catering - Glen Rock - NEW"* row (not native, not
  live), Pelican has two decoy *"Location 2"/"Location 3"* rows. None of the
  decoys are the one that converted. Converting the wrong duplicate is the
  actual failure mode this step exists to catch. `runPreflightCheck`
  (`lib/conversion-preflight.ts`) does this comparison for you.

fm_backup is a stale point-in-time snapshot (June 17), not live — use it to
look something up quickly, but the live FM admin lookup is authoritative if
they disagree.

### 2. Stripe — reuse, never re-onboard

`checkConversionReadiness` reporting `stripeMode: "not-linked"` means **the
account id hasn't been imported yet** — it does not mean the restaurant needs
to onboard to Stripe. That wording cost real time on DeCheco's; read it
correctly.

1. Get the real `acct_...` id. Either from FM's own
   `tbl_stripe_connected_accounts` (matched by the restaurant's exact
   reference — not by business name; names collide across locations and
   franchises in a way account ids don't), or ask Peter directly if that
   table doesn't have it.
2. `verifyAccountReusable(accountId)` — a live Stripe check:
   `charges_enabled && capabilities.transfers === 'active'`. Ignore
   `requirementsDue` (Stripe asking for something by a future date) — it
   doesn't block reuse.
3. `importRestaurantStripeAccount(ref, accountId)` — writes
   `disco_restaurant_accounts.stripe_account_id` +
   `stripe_onboarding_complete = true`, and
   `disco_restaurant_overrides.stripe_connected = true`. One call, no
   restaurant action, no onboarding flow.

**Don't confuse this with `app/api/admin/sync-stripe-status/route.ts`**, a
separate, unrelated writer of the same `stripe_connected` column — it checks
FM's *own* Stripe-Connect status (`HEAD /api/stripe/{ref}`), not native
reuse-eligibility. A restaurant can show `stripe_connected: true` from that
job with zero rows in `disco_restaurant_accounts` — that's FM's payment
status, not native readiness. Confirmed this is exactly what DeCheco's showed
before its Stripe accounts were imported.

Proven on all 6 known accounts checked live for DeCheco's (all
`charges_enabled` + `transfers: active`) plus Glen Rock, Elmwood Park,
Briscola, and Pelican's already-imported accounts — reuse, not onboarding,
every time so far.

### 3. Tax rate

`disco_restaurant_overrides.tax_rates.stateSalesTax.percent` — if it's null,
native checkout charges **$0 tax** on every order. `checkConversionReadiness`
blocks on this (checks the real percent, not just whether a `tax_rates` blob
exists — `0` passes, `null` fails). **Verified directly against unmodified
production code** during the Tier 2 gate (2026-08-14): a restaurant with no
`tax_rates` row at all fails the `settings` step with "No real state tax
percent set"; setting an explicit `stateSalesTax.percent: 0` flips it to
pass. `0` is a real, valid rate — only null/missing blocks.

**FM often genuinely has nothing to mirror.** Checked FM's own data directly
for DeCheco's 6 locations — `stateSalesTax.percent: null` in FM's own
records, not just inaccessible to us. Nothing to import; it's a real
conversation with the restaurant, not a data-recovery task. Pelican
Delicatessen is the counter-example worth knowing: `0%` there is a real,
deliberate rate (state/local/other all explicitly `0`).

`GET/PUT /api/restaurant/tax-rate` never calls FM for a native restaurant —
reads/writes `disco_restaurant_overrides.tax_rates` in Neon directly. Enter
it once, there's no ongoing mirror to rely on.

### 4. Menu — faithful FM import

`importFmMenuFaithfully(fmRef, {targetRef?})`
(`lib/menu-import/fm-faithful-import.ts`), via
`POST /api/admin/restaurants/{ref}/import-fm-menu` — one call per restaurant.
Not the AI-PDF importer (`writeDiscoNativeMenu`, which drops modifier prices
and settings) — this one pulls FM's real menu structure, modifier
prices/rules, service charge, tips, delivery config, order minimums, and lead
time.

The **primary** placement pass is exact, no heuristics — it walks FM's public
per-menu endpoint, which returns each menu's real categories/items directly,
but only for items on a menu FM currently marks visible/active. A
**supplementary** pass exists for anything that misses primary placement —
most commonly items on an Inactive/hidden menu, but confirmed this run
(2026-08-14) to also correctly catch a single **hidden item on an otherwise-
visible menu** (`visible: false` on the meal package itself): the public
endpoint omits it from its response even though the menu is active, so it
never gets a `placedRefs` hit and falls to the supplementary pass. That pass
placed it via priority order (exact schedule-window match → learned category
placement → name overlap → a party-size regex → first-visible-menu as a last
resort) — in the test case, via **learned category placement** (the item
shared a category with an already-placed visible sibling), not the blind
fallback. `duplicatedAcrossMenus: 0`, `unplacedFallbackCount: 0` — a clean,
non-fallback placement, and the item imported with `visible: false` preserved
in Neon.

Also imported, fill-blank-only (never overwrites an existing value):
`announcement`, `delivery_order_time_windows`, `icon_url`/`image_url`.
`maxOrder` is deliberately left null — FM's cap is per-15-minute-window,
Disco's is per-day, not convertible; a manual decision if the restaurant
wants a cap.

Proven clean on all 6 DeCheco's locations (29 items, 5 categories, 9 modifier
groups, 87 modifiers each, zero fallback placements) and again on the
2026-08-14 test restaurant (1 menu, 1 category, 2 items including one hidden,
1 modifier group, 2 modifiers — one of them a genuine **$0.00 modifier**,
confirmed imported at the correct price, not dropped or defaulted).

### 5. Marketplace visibility — a real prerequisite, separate from Stripe

`disco_restaurant_overrides.visible` has to be explicitly `true` before
`checkConversionReadiness`'s `marketplace-ready` step can pass — this is the
"Disco Cater Marketplace" toggle a restaurant gets during normal onboarding,
and a brand-new restaurant that's never been touched in the admin panel won't
have it set. Confirmed this run: on the freshly created test restaurant, the
gate reported **two** failing blocking steps until this was set — `stripe-
ready` (expected) and `marketplace-ready`, citing *"Marketplace visibility is
off"* as an independent reason alongside the Stripe one. Once `visible` was
set `true` (same effect as the admin-panel toggle), `marketplace-ready`'s
only remaining failure reason collapsed to the Stripe one — confirming it's
normally a real, separate, one-time setup step, not something Stripe import
implicitly covers. Any restaurant that's been through normal onboarding
already has this set; only relevant if you're converting something unusual
enough to have skipped it.

### 6. Confirm readiness, then convert

Run `checkConversionReadiness(ref)`. All five blocking steps
(`not-already-native`, `native-menu`, `stripe-ready`, `settings`,
`marketplace-ready`) should read `done: true` before you flip anything. Then
`convertToNative(ref)` — **never `goLiveNativeRestaurant`**, which is a
different function for restaurants starting native from zero (it gates on a
real $1 charge and a real signed Expedite dispatch, neither relevant here).

`convertToNative`:
- Runs a gated FM order-history backfill first; aborts (doesn't convert) if
  FM is unreachable, so lead-gen fee-tier history is never silently lost.
- Sets `is_disco_native = true` **and** `is_live = true` in the same call —
  no separate go-live step.
- Fires the invite step (§7) and the notification/closed-days/promo-code
  carry-over attempts (§8) automatically, best-effort — none of them can
  fail the conversion itself.
- Is a **one-way flag flip on our side only**. FM is untouched — same admin
  login, same order flow — until DNS/routing/marketing stops sending
  customers to the FM URL. Cooperation, not lockout.

### 7. Confirm the invite actually landed — required, not optional

This is the step that has failed on every real conversion so far. Don't skip
it, and don't consider a conversion done until it passes.

**What fires automatically.** Two things, both inside `convertToNative`:
- `ensureRestaurantLoginInvited` — reads FM's single per-restaurant
  `admin.email` field, creates a `disco_restaurant_accounts` row
  (`role: 'ADMIN'`), sends a password-set invite.
- `inviteFmSystemAdminsFor(ref, restaurantName)` — reads FM's **full**
  system-admin list (`GET /api/admin/users/system-admin`) and invites every
  SYSTEM_ADMIN whose `managedRestaurants` includes this restaurant, skipping
  anyone who already has an account (most will, from the step above or a
  sibling location). This exists because the single `admin` field and FM's
  system-admin list are genuinely separate data — confirmed real on
  DeCheco's: Tyron User was SYSTEM_ADMIN across all 6 locations but was never
  any single location's `admin.email`, so nothing invited him until this
  function was added.

**ADMIN vs SYSTEM_ADMIN is FM's call, not ours.** Whatever role FM's own
system-admin list reports is what gets mirrored. There's no Disco-side
decision to make here, and no reason to hand-grant `grantLocationAccess` for
anyone — `grantLocationAccess` does no FM cross-check at all, so a manual
grant can silently disagree with FM's real structure (this happened: Nathan
and Cory were manually granted all 6 DeCheco's locations on the belief they
were single-location admins, when FM already had all four — Dominic, Nathan,
Cory, Tyron — covering all 6). If a location's access ever looks wrong after
the fact, re-sync from FM's system-admin list; don't hand-edit
`disco_restaurant_location_access`.

**Verify the token, don't assume the email worked.** Query
`disco_restaurant_accounts` for the new row(s): `invite_token IS NOT NULL`
and `invite_token_expires_at` in the future. Then prove the link itself
works, with no session:

```
curl -sIL "https://www.discocater.com/restaurant/accept-invite?token=<token>"
   # expect: 200, no redirect to /restaurant/login
curl -s "https://www.discocater.com/api/restaurant/accept-invite?token=<token>"
   # expect: {"valid":true,"email":"...","restaurantName":"..."} matching the real person/restaurant
```

Confirmed again this run against the 2026-08-14 test restaurant, cold (no
cookies, no session): `GET /api/restaurant/accept-invite?token=...` returned
`200 {"valid":true,"email":"peter+paritytest@discocater.com","firstName":
"Disco","restaurantName":"Disco Parity Test 2026-08-14"}` — right email,
right restaurant name, from a brand-new token minted seconds earlier by
`ensureRestaurantLoginInvited` inside the conversion itself.

Tokens are **14 days** (`setInviteToken`, extended from an original 72 hours
— the 72-hour window is exactly how Glen Rock, Briscola, and Elmwood Park's
first retroactive invites all died unused before anyone clicked them). If a
token's dead or was never sent, there's a **resend-invite button** in the
super admin's `manage-restaurants/ordering` table (⋯ menu, "Resend invite")
next to an **expired-invite badge** that flags it automatically
(`invite_token IS NOT NULL AND invite_token_expires_at < NOW()`, only when
`is_disco_native`) — no script required to check it; a token 14 days from
expiry reads clean by construction.

**Current real state**, so you don't re-investigate something already
resolved: Briscola's admin (`briscolabrooklyn@gmail.com`) accepted their
invite and logged in on 2026-08-13 — working. Glen Rock and Elmwood Park both
have valid, unexpired 14-day tokens sitting unsent — ready, just need the
email (§9) sent. DeCheco's four real admins (Dominic, Nathan, Cory, Tyron)
were emailed and are pending, not yet accepted. Pelican's only account is
FM's own fake sentinel (`chef@familymeal.com`, fabricated name, placeholder
phone) — there's no real contact to invite until the actual owner's details
come from the restaurant directly; don't invent one.

### 8. What doesn't carry over — expected, not a blocker

Notification recipients, closed days, and promo codes all fail to carry over
automatically, for **two distinct reasons**, both confirmed directly against
FM's own source this run (not inferred from behavior alone):

- **Notifications and promo codes are a hard role exclusion, not just
  "session-scoped."** `NotificationSettingController` and `CouponController`
  are both annotated `@PreAuthorize("hasAnyAuthority('ADMIN', 'SYSTEM_ADMIN')")`
  — **SUPER_ADMIN is not in that list.** No service-account credential, no
  matter how privileged, can ever call these two endpoints; this isn't a bug
  FM could accidentally fix, it's a deliberate role boundary. Confirmed live
  against a restaurant with real, known data behind it (not an empty test):
  the service account gets `HTTP 500 "Access is denied"` from both, every
  time.
- **Closed days is a genuine empty-response wall**, not a role exclusion —
  `RestaurantClosedDayController` *does* allow SUPER_ADMIN. But the service
  account's `GET /api/closedDays` still returns `200 []` for a restaurant
  independently confirmed (this run) to have 13 real rows (12 default
  holidays + 1 custom range) behind that same login. The wall is real; its
  mechanism is just different from the other two.

`convertToNative` attempts all three anyway (best-effort), and on failure
sets an audit column (`notification_settings_flagged_at` /
`closed_days_flagged_at` / `promo_codes_flagged_at`) — confirmed this run
that all three set correctly and immediately on a real conversion, not just
in isolated unit testing.

**Two additional, previously-unknown gaps found this run, worth knowing if
this code is ever revisited (not yet fixed — flagging, since they'd bite even
if the access wall above were ever lifted):**
- `carryOverClosedDays`'s field-name guesses (`holiday`/`name`/`fromDate`/
  `toDate`) don't match FM's real shape at all. The real
  `RestaurantClosedDaysRequestDto`/response is `{ eventName, available,
  eventDates: [dates...] }` — a flat list of discrete dates, not a from/to
  range, and no field named `holiday`. Even with API access, this parser
  would silently produce zero usable rows against real FM data.
- `carryOverPromoCodes`'s field-name guesses are actually **right**
  (`code`, `discountPercentage`, `maxAvailable`, `maxPerDiner`, `startDate`,
  `endDate` all match FM's real `CouponResponseDto` exactly) — but the
  **shape** assumption is wrong: the code expects an array (`Array.isArray`
  check) and treats anything else as a parse failure, while FM's real
  `GET /api/coupon` returns a **single object** (one coupon per restaurant,
  by design — `CouponController` has no list endpoint). Confirmed via
  `POST /api/coupon` + `GET /api/coupon` as a real restaurant admin, no
  service-account access needed.

**This is expected to fail every time. It's not a bug to chase, and it's not
a reason to hold up the conversion.** Enter the real values manually
afterward:
- Notifications: check `disco_restaurant_overrides.notification_emails`
  first — 778 of 4,432 restaurants already have this populated from an
  earlier bulk mirror, so it may already be correct. If it's a
  `@familymeal.com` placeholder or empty, get the real recipient list from
  the restaurant and enter it (or have them save it once through their own
  portal session, which mirrors correctly going forward).
- Closed days: the native "Closed Days" settings page
  (`POST /api/restaurant/disco-closed-days`) writes straight to Neon,
  self-service, a few seconds per holiday. This is how Glen Rock's real
  holidays exist today — entered directly, not carried over.
- Promo codes: get the restaurant's active codes and re-enter them through
  the native promo-code UI.

If notifications are wrong, the restaurant never learns an order arrived —
this is worth actually doing before calling a restaurant live, just not worth
blocking the flag flip over.

### 9. Send the invite email — the only restaurant communication

No advance notice, no feature pitch, no fee discussion. One email, to the
system admins and restaurant admin(s) confirmed working in step 7, after
their accept-invite links are verified — not before.

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

One email per person, one token per person, never reused across recipients.
Confirm delivery via Mailgun's Events API (`accepted` and `delivered`, not
just that the send call returned success) — this has caught real send
failures before. (In a local/dev environment without Mailgun configured, the
invite step logs "Mailgun not configured — skipping email" but still creates
the real `disco_restaurant_accounts` row and token — the accept-invite link
itself is fully testable without a working local Mailgun key; only actual
delivery isn't.)

### 10. Post-conversion verification

- **Login works** — this is new, and it's here because it's the step that's
  silently failed 4 times in a row. Don't consider a conversion done without
  this: the accept-invite check in step 7, and (once someone's actually
  logged in) a real session row in `disco_restaurant_sessions`.
- Live and visible on the marketplace (`disco_restaurant_cache.is_live` +
  `.visible`, and the native 3-part rule passes — visible AND online-ordering
  on AND a real Stripe signal). Note:
  `disco_restaurant_overrides.stripe_connected` alone is not a valid native
  signal — every converted restaurant inherits it `true` from a historical
  migration regardless of real native readiness; the marketplace rule ORs it
  with `hasCompletedNativeStripeAccount`, which is the one that actually
  means something post-conversion.
- Menu renders on the customer-facing page, modifier prices included.
- FM is untouched — the restaurant's FM login and FM-side order flow still
  work exactly as before. Should never need an active fix, just a sanity
  check nothing broke.

That's the list. Not a general audit — the things that have actually gone
wrong or would visibly matter to a customer.

---

## Multi-location brands need nothing special — except the parts that are still per-location

DeCheco's (6 locations) needed zero extra admin-access work once FM's real
system-admin structure was read correctly — `inviteFmSystemAdminsFor` mirrors
it automatically, per location, as each one converts. That's the only thing
that's automatically brand-wide.

**Stripe import, tax entry, menu import, and the conversion flip itself are
each still genuinely one call per location.** A 6-location brand is still 6
Stripe imports, 6 tax entries (or 6 "nothing to import" confirmations), 6
menu imports, and 6 `convertToNative` calls — the win is only that nobody
has to think about admin access location-by-location anymore.

---

## Tier 2 — the batch-readiness gate (run once, 2026-08-14)

Two subjects. **Subject A** — conversion mechanics — a fresh FM restaurant
("Disco Parity Test 2026-08-14", reference `6be8f6b5-e6c8-4db2-a057-
2b3d599bba6c`), created on FM production, built out as a real restaurant
admin (not the SUPER_ADMIN service account, which cannot reach menu/
notification/closed-day/promo-code creation — those all resolve the target
restaurant from the calling user's own session), converted via an explicit,
logged bypass (below), fully verified, then torn down. **Subject B** — data
parity — Francesca Catering – Glen Rock, 377 real orders spanning 2022-09-01
to 2026-08-20, checked against live FM values, not expectations. Stripe and
payout reconciliation were explicitly out of scope for this run (Peter is
confident payouts work); every item below is either a real Stripe-independent
check or is marked not-testable for that reason.

**Classification used for every finding:** SYSTEMIC (a whole category
missing or a pattern affecting many orders — would block batching),
ISOLATED (a handful of orders, no shared cause — note and move on), KNOWN
IRRECOVERABLE (accept without investigation — `service_charge`, ~10% of
`tips_in_price`, `tax_exempt_state`, a small number of unreachable-FM-fetch
orders and `FM_BACKFILL` artifacts; only confirm the count hasn't grown).

### The Stripe bypass (explicit, logged, never committed)

Stripe is real, correctly missing (no linked account, and none should exist
for a throwaway test restaurant), and `checkConversionReadiness` correctly
blocked on it (`stripe-ready`, plus `marketplace-ready`'s Stripe-only
reason). The gate itself was never weakened. Instead, a one-off script
(`scripts/tmp-tier2-bypass.ts`, deleted immediately after use, never
committed) did exactly two things: (1) called the real, unmodified
`checkConversionReadiness` and asserted every failing blocking step's cause
was Stripe — aborting instead of proceeding if anything else was also
failing; (2) called every individual real function `convertToNative` itself
calls (`backfillFmOrderHistory`, the `is_disco_native`/`is_live` cache
update, `ensureRestaurantLoginInvited`, `inviteFmSystemAdminsFor`,
`carryOverNotificationSettings`, `carryOverClosedDays`,
`carryOverPromoCodes`) directly, in the same order, skipping only the
top-level `readiness.ready` gate check that would otherwise refuse to run
them. No source file in `lib/native-conversion.ts` was edited.

### Subject A results — Disco Parity Test 2026-08-14

| Check | Result |
|---|---|
| Native / visible / live after conversion | **PASS** — `disco_restaurant_cache.is_disco_native = true`, `is_live = true` |
| Menu item count/structure matches FM exactly | **PASS** — 1 menu, 1 category, 2 items, 1 modifier group, 2 modifiers (one priced $2.50, one a genuine **$0.00 modifier**, both imported at the correct price) |
| Hidden/inactive item handled by the supplementary heuristic pass | **PASS** — a `visible: false` meal package on an otherwise-active menu was correctly skipped by the primary public-endpoint pass and picked up by the supplementary pass via learned category placement (not the blind fallback); imported with `visible: false` preserved |
| Notifications flagged, not lost | **PASS** — `notification_settings_flagged_at` set; real data behind the wall confirmed present (2 emails, 1 phone, `phoneNotificationType: ALL`) and still correctly inaccessible to the service account |
| Closed days flagged, not lost | **PASS** — `closed_days_flagged_at` set; 13 real rows (12 holidays + 1 custom) behind the wall, still returned as `[]` to the service account |
| Promo code flagged, not lost | **PASS** — `promo_codes_flagged_at` set; a real code (`PARITY10`, 10%, 100 uses, 1/diner) behind the wall, still a 500 to the service account |
| Admin invited, accept-invite URL valid | **PASS** — `GET /api/restaurant/accept-invite?token=...`, no cookies, returned `200 {"valid":true,"email":"peter+paritytest@discocater.com",...,"restaurantName":"Disco Parity Test 2026-08-14"}` |
| Expired-invite badge clean | **PASS** — token minted with a 14-day expiry, `invite_token_expires_at` far in the future at check time |
| Null-tax case blocks; explicit 0% passes | **PASS** — real, unmodified `settings` gate: null → FAIL ("No real state tax percent set"), explicit `0` → PASS |
| Marketplace-visibility toggle is a real, separate prerequisite | **CONFIRMED** — see Tier 1 §5; not a Stripe artifact |
| Teardown: FM soft-delete | **DONE** — `DELETE /api/admin/restaurants/{ref}` → 200; restaurant now 404s on normal lookup, appears only in `/api/admin/restaurants/deleted` |
| Teardown: gone from restaurant counts / marketplace / system-admin list | **CONFIRMED** — 0 matches in `searchName`-filtered admin list, 0 matches in the live marketplace feed (387 other rows unaffected), 0 matches among 363 system admins |
| Teardown: Neon cleanup | **DONE** — `disco_restaurant_cache`/`_overrides`/`_accounts`, menu tables, `disco_restaurant_closed_days`, `promo_codes` all confirmed at 0 rows for this reference (the cache row was unexpectedly already gone by the time cleanup ran — worth a later look at whether something prunes cache rows for FM-deleted restaurants faster than the known daily syncs, but not a blocker for this record) |

**Two real FM bugs found incidentally, out of scope to fix here, worth
knowing:**
- FM's `POST /api/mealPackages` (and every sibling create/update path calling
  the same internal `processScheduleOption`) throws an unhandled NPE
  (generic `500-001`) if `inheritScheduleOptionFromRestaurant` is omitted
  from the request — it's typed `Boolean` on the DTO but unboxed into a
  primitive `boolean` with no null guard. Include it explicitly (`true`,
  assuming the target menu already has a schedule option) on any tooling
  that creates meal packages directly.
- FM's JWT auth does **not** use a `Bearer ` prefix — `resolveToken` reads
  the raw `Authorization` header value directly into the JWT parser with no
  stripping. A token sent as `Authorization: Bearer <jwt>` fails to parse and
  reads as a generic 401; send `Authorization: <jwt>` with no prefix.

### Subject B results — Francesca Catering – Glen Rock (377 orders)

| Check | Result | Classification |
|---|---|---|
| Every order has ≥1 item, every order has a transaction row | 377/377 | — |
| Tax populated (state/local/other) | 377/377 | — |
| `tips_in_price` accuracy vs. the real `resolveTipsInPrice` formula | 30/30 sampled | PASS |
| Fulfillment-time rule (pickup/self-delivery −30min/3P unchanged, day-rollover) | Verified against real order timestamps | PASS |
| Tax-exempt orders (2 exist) | Both $0 tax across all three tax fields | PASS |
| `service_charge`/`stripe_fee` null | 16/377 (exactly the `FM_SYNC`-sourced rows; all 359 `FM_BACKFILL` rows populated) | KNOWN IRRECOVERABLE |
| `lead_gen_one_disco_fee` null | 350/377, concentrated entirely in 2022–2025 orders (0/307); only appears starting 2026 (27/71) — FM's own lead-gen tracking predates 2026 | KNOWN IRRECOVERABLE (newly characterized) |
| `source` null | 2/377 (order numbers 900000080/081) | ISOLATED |
| 3-catalog usage in this restaurant | Only `orderMealPackages` seen (0 classics, 0 subscription) — a pizzeria doesn't use FM's other two catalogs | not applicable here, already verified fleet-wide elsewhere |
| Single `DLIVRD_DELIVERY` order (#24933) with fee in `own_delivery_fee` instead of `third_party_delivery_fee` | n=1 | ISOLATED |
| Reporting-surface agreement (summary cards / Daily Revenue / CSV export) | All three read `disco_orders` directly via the same join already confirmed complete above; no separate pipeline to diverge | pass-by-construction |

**Overall Tier 2 verdict: zero systemic issues.** Every discrepancy found is
either already-known-irrecoverable, newly characterized but still
irrecoverable (the pre-2026 lead-gen gap — confirm this count doesn't grow,
don't try to close it), or isolated to 1–2 orders with no shared cause.
**Batching is not blocked by data parity.**

---

## Batch, later

Everything above the Tier 2 section is written for converting one restaurant
at a time, which is the current mode. If/when this moves to batch:

- The invite email (Tier 1 §9) needs a real bulk-send path with per-recipient
  Mailgun delivery confirmation, not one-by-one manual verification — the
  verification step (§7) doesn't change, but running it N times by hand
  won't scale.
- `inviteFmSystemAdminsFor` re-fetches FM's entire ~363-record system-admin
  list on every single restaurant's conversion — harmless at one-at-a-time
  cadence, wasteful run back-to-back across many locations in the same
  batch. Worth caching within a batch run if this becomes routine.
- Nothing about the Stripe/tax/menu steps parallelizes today — they're
  independent per restaurant, so batching them is a scripting question, not
  a design change.
- The Tier 2 gate does **not** need to re-run per restaurant once batching
  starts — it's the reason batching is unblocked, not a per-restaurant
  precondition. Re-run it only if something structural changes (a new FM
  order-item catalog, a new payout path, a schema change to
  `disco_sale_transactions`).

Not building any of this now — noting it so batch mode doesn't start from
scratch when it's needed.
