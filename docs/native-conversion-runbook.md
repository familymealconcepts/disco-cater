# Native Conversion Runbook

Written for Peter, running conversions directly with Claude Code and DB
access. No hand-holding — FM is the source of truth for a restaurant's real
settings, and where something looks off after conversion, the fix is manual,
after the fact.

**The procedure has never been wrong.** Five conversions (Briscola, Pelican,
Francesca Catering – Glen Rock, Francesca Catering – Elmwood Park, DeCheco's
×6, The Winkin' Rooster) all ran the same nine steps below. What varied was
the *state each restaurant arrived in* — FM has ~4,400 records entered by
different people over four years with no validation, so pre-flight always
finds something different. This revision's point: the pre-flight output is
now a **classified work list**, not a pile of facts to interpret. Every
condition seen so far maps to exactly one of four buckets:

- **BLOCKER** — cannot convert until resolved.
- **PETER** — needs Peter specifically (a tax confirmation that's really a
  conversation with the restaurant, or reading a session-scoped FM value no
  automation can reach).
- **AUTO** — the conversion itself handles it; take no action.
- **NOTE** — worth knowing, doesn't block anything.

Target state: a routine conversion needs nothing from Peter at all — the
Stripe id is resolved and verified automatically (step 5). Everything else
on this page exists to get you there or to handle the restaurant that isn't
routine.

**Conversions are one at a time right now.** Everything below assumes that.
See "Batch" at the end for what changes if that stops being true.

**There is no rollback — and here's exactly what that means, scoped for
real** (researched 2026-08, after the four-restaurant Hugo's batch — the
largest single conversion run to date). `is_disco_native` is written to
`true` in exactly two places in the codebase, and neither ever sets it back
to `false` — confirmed by grepping the whole repo for `is_disco_native =
false`, which returns nothing but test fixtures. "Revert" is not a lesser-
used option; it's hand-run SQL against Neon, outside all application code,
full stop.

**Revert is only meaningful before the first native order clears.** The
storefront, checkout routing, and marketplace visibility all re-read
`is_disco_native` live on every request — flip it back and a restaurant
behaves FM-backed again on the very next page load, no caching to wait out.
But a native order is charged as a destination charge straight to the
restaurant's own connected Stripe account — FM's own order/reporting/payout
system is never told about it, by any code path, ever. Reverting the flag
doesn't retroactively inform FM; there's nothing in this codebase that
could. So the gap isn't a decay curve, it's a hard cutover: fine right up
until the first real native order settles, permanent the instant it does.
The honest procedural statement is **revert the flag within the first
hours, before real orders land — after that, fix forward, because rollback
no longer has anything meaningful left to undo.**

Even reverted in time, two things don't clean up on their own and need a
manual pass:
- **The imported native menu.** No delete/archive path exists for
  `disco_menus`/`disco_menu_items`/`disco_modifier_groups`/`disco_modifiers`
  /etc. — the only archive function in the codebase explicitly never deletes
  rows, by design. Left alone, it just sits inert in Neon, unrendered — but
  a future re-conversion attempt's readiness check only counts rows, not
  freshness, so it would read this leftover as "menu already built" and
  possibly skip re-importing. Archive-clean it by hand before trying again.
- **The accounts and location-access grants created at conversion.** These
  need explicit revoking, not just abandoning. Skipping this isn't inert —
  see the next paragraph.

**The leftover native login is actively misleading, not harmless.** The
restaurant login page tries Disco-native auth first, FM second. A reverted
restaurant's Disco account still authenticates — nothing in the login path
checks `is_disco_native` — so staff get routed straight into
`/restaurant/menu-manager`, the Neon-native menu editor, editing the exact
leftover menu above. Their edits appear to save successfully and have zero
effect on the restaurant's real, live (FM-backed) menu. That's worse than a
dead end: it's a dead end that looks like it worked. Revoking the
conversion-created `disco_restaurant_accounts` rows and
`disco_restaurant_location_access` grants is part of the same cleanup pass
as the menu, not optional.

Don't convert a restaurant you're not ready to fix forward.

**Two tiers.** Tier 1 is the short checklist you run for every single
conversion. Tier 2 is a one-time batch-readiness gate — it already ran, once
(2026-08-14), and its result is the reason batching is unblocked. It does not
run again per restaurant.

---

## Tier 1 — the procedure

### 1. Confirm the FM restaurant reference

`GET /api/admin/restaurants/{ref}` (service auth) — `status` is `ACCEPTED`,
and it's not a duplicate. `runPreflightCheck` (`lib/conversion-preflight.ts`)
checks this for you — a `duplicateRecords` hit is a **BLOCKER**: confirm
which is the real, active one before touching either. Decoy rows (extra
locations, "-NEW" duplicates that never converted) are real, not
hypothetical — this has actually happened.

### 2. Run the pre-flight tools, sort the output into the work list

`runPreflightCheck(ref)` + `checkConversionReadiness(ref)`. Map every finding
against "Background → Pre-flight classification" rather than re-deriving it
per conversion. In practice: BLOCKER is almost always a duplicate record, a
non-charge-capable Stripe account, or a resolved-but-unverified Stripe id;
PETER is now just the tax question; AUTO covers Stripe resolution/reuse and
menu import; NOTE covers closed days, notifications, and bare orders — none
of them block anything, budget the time anyway.

### 3. Resolve every BLOCKER

Don't proceed past this until none remain.

### 4. Get the PETER items

Any tax confirmation the pre-flight flagged (see step 6) — this is the only
step that needs Peter specifically now that Stripe account resolution is
automated (step 5).

### 5. Stripe — resolve, verify, reuse — never re-onboard, never fuzzy-match

Resolving the `acct_...` id no longer requires Peter pulling it from the
Dashboard by hand. In order of reliability:

1. **Resolve — `familymeal.tbl_stripe_connected_accounts`** (in the local
   `fm_backup` Postgres mirror): `restaurant_reference` UUID → `stripe_account_id`,
   one row per restaurant, a DB-level `UNIQUE` constraint on the account id.
   4,361 rows as of the 2026-06-17 snapshot. This is FM's own operational
   source of truth — no FM API exposes it directly (confirmed by testing;
   every plausible endpoint 404s/500s), and Neon doesn't mirror it for any
   restaurant that hasn't converted yet. **Stale by design** past the
   snapshot date — a restaurant onboarded or re-keyed after 2026-06-17 won't
   be in there; if a restaurant is missing, that's a signal to get a fresher
   scoped dump, not to fall back to name/email matching.
2. **Verify — required before import, every time:**
   `stripe.transfers.list({ destination: acctId })` (a documented, exact
   Stripe filter — no dependency on Neon's own sparse `disco_stripe_payments`
   mirror). Take a recent transfer, follow its `source_transaction` (a
   charge) to the charge's `payment_intent`, retrieve that PaymentIntent, and
   confirm `metadata.restaurantReference` equals the target restaurant's
   reference exactly. **Refuse the import if it doesn't match.** FM stamps
   this metadata on every PaymentIntent it creates — it's an exact id match,
   not an inference. Proven on all four Hugo's accounts: 5 transfers each,
   20 for 20 matched.
3. **Never match by name, email, or company name — proven wrong, not just
   theoretically risky.** `arnav.anju@gmail.com` is the Stripe account email
   for **four different** Atlanta Bread locations (Decatur, The Collection,
   Sandy Springs, Peachtree Corners) — `stripe.accounts.list({email})` there
   returns four unrelated restaurants with no way to disambiguate. Separately,
   "Pasta Mama Inc" is the shared legal `company.name` across at least two
   different Hugo's locations' Stripe accounts (Studio City and West
   Hollywood) — trusting it pointed the Hugo's West Hollywood account at
   Studio City instead, caught only by the transfer-metadata check in step 2.
   Company name and account email are corroborating evidence at best, never
   the resolution method.
4. `verifyAccountReusable(accountId)` — live Stripe check (`charges_enabled
   && capabilities.transfers === 'active'`; ignore `requirementsDue`, it
   doesn't block reuse).
5. `importRestaurantStripeAccount(ref, accountId)` — one call, no restaurant
   action. `stripeMode: "not-linked"` means the id hasn't been *imported*
   yet — it does not mean the restaurant needs to onboard.

This turns Stripe resolution from a PETER item into an AUTO one — the
account id is looked up, not supplied — gated by a hard verification step
that refuses a mismatch rather than trusting the lookup blind.

### 6. Tax rate

Set `disco_restaurant_overrides.tax_rates.stateSalesTax.percent` via
`PUT /api/restaurant/tax-rate` (Neon-only, no ongoing FM mirror). `0` is a
valid, real rate — only `null`/missing blocks the gate. If FM genuinely has
nothing, that's the PETER conversation from step 4, not a data-recovery
task.

**Confirming the real FM value stays a PETER item — don't re-test this.**
The page backing it (`/restaurant/tax-rate` in the portal) calls
`GET/PUT {FM}/api/restaurants/taxRate`. The service account gets
`500 — "Access is denied"` — the same role-exclusion class as the
notifications and promo-code walls (see Background). It's genuinely
readable, just not by automation: it needs a real restaurant/system-admin
session with that restaurant selected, which is how Peter read Studio City's
value directly (9.750% state, matching Neon exactly). Getting a session
yourself by resetting a live business's admin password is not the move —
that's a different risk class from a disposable test account, and the
sensible call is to not do it unilaterally.

### 7. Menu — faithful FM import

`importFmMenuFaithfully(fmRef)` — one call. **Not** the AI-PDF importer
(`writeDiscoNativeMenu`), which drops modifier prices and settings. Items on
an Inactive menu, or individually hidden, are caught by the supplementary
heuristic pass — proven clean on 7 conversions so far, including a real
hidden item on both DeCheco's and Winkin' Rooster (learned category
placement, not the blind fallback). `maxOrder` is deliberately never
auto-imported (FM's cap is per-15-minute-window, Disco's is per-day) — a
manual decision if the restaurant wants one.

This same call now also carries over **logo, marketplace image, and phone**
(fill-blank-only — never overwrites an existing value), fixed 2026-08-17
(commit `34f8278`) after Winkin' Rooster arrived with all three empty and
needed manual re-entry. No longer a checklist item.

### 8. Confirm readiness, then convert

`checkConversionReadiness(ref)` — all five blocking steps (`not-already-
native`, `native-menu`, `stripe-ready`, `settings`, `marketplace-ready`)
should read `done: true`. Then `convertToNative(ref)`. Never
`goLiveNativeRestaurant` — that's for restaurants starting native from zero.

`convertToNative` backfills FM's order history first (aborts, doesn't
convert, if FM is unreachable). **If this aborts, just retry it** — before
2026-08-17 (`maxDuration` fix, commit `41ba6db`) this frequently surfaced as
a fake `"FM orders fetch failed"` caused by the route timing out, not FM
actually being down. Confirmed live: a single FM order-history page can take
~15s, and the full flow (backfill + system-admin list + 3 carry-over
attempts) needs real headroom.

Then it flips `is_disco_native` **and** `is_live` together, and fires
invites + carry-over, best-effort. FM stays untouched — same admin login,
same order flow, until routing stops sending customers there.

### 9. Confirm the invite landed

`convertToNative` invites FM's per-restaurant `admin.email` **and** every FM
SYSTEM_ADMIN covering this restaurant — genuinely separate FM data, not
redundant. Fixed 2026-08-17 (`e72502d`): both invite functions now check
`hasUsableLogin()` (a live, unexpired token, or any prior session) instead
of pattern-matching the account's email — the old check silently treated an
already-real-but-never-invited email as "done." Confirmed via a live fleet
check that this isn't currently a widespread problem, but always still
worth the cheap verification:

```
curl -s "https://www.discocater.com/api/restaurant/accept-invite?token=<token>"
# expect: {"valid":true,"email":"...","restaurantName":"..."} matching the real person/restaurant
```

Zero logins a few days after inviting is normal lag, not a broken link —
confirmed on all 4 DeCheco's admins. Tokens last 14 days. If one's dead or
was never sent, **Resend invite** in the super admin's
`manage-restaurants/ordering` table (⋯ menu) — the expired-invite badge
flags it automatically.

### 10. What's left — expected manual work, and why

- **Closed days / holidays**: FM's session-scoped wall returns `200 []` even
  for a restaurant with real closures behind it — `closed_days_flagged_at`
  gets set, never lost, but **expect to enter these by hand every single
  time**, not occasionally. Kealoha did this for Winkin' Rooster after
  discovering the gap by eye; this note exists so it's expected up front
  instead.
- **Notifications**: same wall, `notification_settings_flagged_at` set. Check
  `disco_restaurant_overrides.notification_emails` /
  `notification_sms_numbers` **first** — the 778-restaurant bulk import means
  most restaurants already have these populated; don't assume they're
  missing.
- **Promo codes**: same wall, `promo_codes_flagged_at` set. Only relevant if
  the restaurant actually has any — check the native promo-code UI.
- **Bare FM orders** (a `disco_orders` row with no `disco_sale_transactions`
  detail): background sync hygiene, not a conversion step, and no longer
  routine either way. Fleet-wide sweep (2026-08-18): **42 of 57 repaired, 15
  permanently irrecoverable** — 14 got FM `404 Order Not Found` (abandoned
  `EXPIRED` carts FM no longer has, 13 on "Test Kitchen" alone), 1 got a
  genuine FM `500`. All FM-side, nothing left to retry — a larger
  irrecoverable set than previously known (2 fetches + 7 `FM_BACKFILL`
  artifacts), now the accepted floor. **A bare order in a pre-flight from
  here is a regression signal**, not expected noise — the hourly sync already
  self-heals new ones in rotation.
- **Post-conversion diff**: see below instead of eyeballing two screens.

### 11. Post-conversion diff — a concrete check, not a screen comparison

Kealoha found the logo/image/phone/closed-days gaps by manually comparing
FM's admin view against Disco's after Winkin' Rooster converted. Three of
those four are now automated (step 7); closed days is expected manual work
(step 10). For everything else, run this comparison instead of eyeballing:

| Compare | FM side | Disco side | Clean result |
|---|---|---|---|
| Business identity | `GET /api/admin/restaurants/{ref}` → `businessName`, `address` | `disco_restaurant_cache.name`, `.address` | Match |
| Logo / image | `image`/`marketplaceImage` references | `disco_restaurant_cache.icon_url` / `.image_url` | Both non-null (step 7 fills them; if FM has one and Neon doesn't, something regressed) |
| Phone | `address.phoneNumber` | `disco_restaurant_cache.phone` | Match, or both null if FM has none |
| Menu item count | `GET /api/restaurants/{ref}/mealPackages?page=0&size=1000`, flattened length | `SELECT COUNT(*) FROM disco_menu_items WHERE restaurant_reference = ref` | Neon ≥ FM (never <; cross-menu duplication can only make Neon larger) — this is the exact check `runPreflightCheck` already runs |
| Tax rate | (session-scoped, can't read live for a spot-check) | `disco_restaurant_overrides.tax_rates.stateSalesTax.percent` | Non-null; cross-reference against the PETER confirmation from step 4 if flagged |
| Order count | FM's own order list total for this restaurant | `SELECT COUNT(*) FROM disco_orders WHERE restaurant_reference = ref` | Match (native lead-gen tier depends on this) |
| Bare orders | — | `LEFT JOIN disco_sale_transactions ... WHERE t.id IS NULL` | Zero |
| Login | — | `disco_restaurant_accounts` row has `invite_token` live or a real session | At least one usable login exists |

If this gets built later: a script that runs all eight rows for one
`restaurant_reference` and prints PASS/FAIL per row is the natural shape —
same queries as above, not scoped further here.

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

### Pre-flight classification — the full mapping

Every condition observed across the five conversions to date, so a new one
can be classified by pattern-matching against this list rather than
re-deriving the reasoning each time:

| Condition | Class | Why |
|---|---|---|
| Duplicate/decoy FM record | BLOCKER | Converting the wrong one is a real failure mode |
| Stripe id unknown | AUTO | Resolved from `fm_backup`'s `tbl_stripe_connected_accounts`, verified via `stripe.transfers.list` + PaymentIntent `metadata.restaurantReference` — no longer needs Peter or the Dashboard (see step 5) |
| Stripe id resolved but verification mismatches | BLOCKER | Refuse the import — this is exactly the failure mode name/email matching would have produced silently |
| Stripe not charge-capable | BLOCKER | Needs fresh onboarding, can't be done for the restaurant |
| Stripe charge-capable, id supplied | AUTO | One call, no restaurant action |
| Tax null on FM | PETER | Conversation with the restaurant |
| Tax real + directly verifiable | AUTO | Settings step passes on its own |
| Tax real but only via opportunistic mirror (never independently verified) | PETER | Flag for confirmation — could be stale; FM's own taxRate endpoint is a session-scoped wall, not automatable (see step 6) |
| Menu not imported | AUTO | One call |
| Hidden/inactive menu items | AUTO | Supplementary heuristic pass |
| Item landed via last-resort fallback placement | NOTE | Hasn't happened yet in 7 conversions |
| Marketplace visibility unset | NOTE | Already set by normal onboarding |
| Bare FM orders | NOTE | Background hygiene, not conversion-specific |
| Order-history backfill fails | AUTO (was a false BLOCKER) | Usually the now-fixed timeout, not real FM downtime |
| Per-restaurant admin never invited | AUTO | Fixed — real login-state check |
| FM system-admin coverage missed | AUTO | Fixed — same mechanism |
| Invite issued, uncicked | NOTE | Normal lag |
| Notifications wall | NOTE | Check Neon first — likely already populated |
| Closed-days wall | NOTE | Expect manual entry every time |
| Promo-codes wall | NOTE | Only if the restaurant has any |
| Logo/image/phone missing | AUTO | Fixed, carried over fill-blank-only |
| `money_flow` stale | AUTO | Fixed, daily reconciliation |
| Admin-form autofill misclassification | AUTO | Fixed, unrelated to conversion procedure |

**Stripe reuse, proven.** All 6 DeCheco's accounts checked live
(`charges_enabled` + `transfers: active`), plus Glen Rock, Elmwood Park,
Briscola, Pelican's, and Winkin' Rooster's already-imported accounts — reuse,
not onboarding, every time so far.

**Tax rate reality.** FM's own data for DeCheco's 6 locations has
`stateSalesTax.percent: null` — genuinely nothing to mirror, not an access
problem. Pelican Delicatessen is a counter-example: `0%` there is a real,
deliberate rate (state/local/other all explicitly `0`). Winkin' Rooster is a
third case: a real, non-null 6.88%/0.5%/1% — but it could only have gotten
into Neon via a past opportunistic mirror (FM's own `taxRate` endpoint is
scoped to the restaurant's own login, unreadable by the service account), so
it's a real number of unknown freshness — treat this pattern as a PETER
confirmation, not an automatic pass. Confirmed directly (Hugo's, 2026-08):
`GET {FM}/api/restaurants/taxRate` with the service account returns
`500 — {"description":"Access is denied"}` — a real access-control response
masked as a generic error, not a flaky endpoint worth retrying. It's the
exact same role-exclusion class as the notifications/closed-days/promo-code
walls below, just for tax rather than settings — don't re-test it expecting
a different result. It IS readable, just only by a real restaurant/system-
admin session with that restaurant selected (how Peter confirmed Studio
City's 9.750% matched Neon exactly) — not something worth getting by
resetting a live business's admin password to check.

**Menu import mechanics.** The primary placement pass is exact, no
heuristics — it walks FM's public per-menu endpoint, which only ever returns
items on a menu FM currently marks visible/active. The supplementary pass
covers everything that misses that via priority order: exact schedule-window
match → learned category placement → name overlap → a party-size regex →
first-visible-menu as a last resort. Proven clean on all 6 DeCheco's
locations and Winkin' Rooster's hidden "[Copy] Sandwich Tray" (both via
learned category placement, not the fallback).

**Marketplace visibility, confirmed independent of Stripe.** On a freshly
created test restaurant, the gate reported two failing blocking steps until
`disco_restaurant_overrides.visible` was set — `stripe-ready` (expected) and
`marketplace-ready` citing "Marketplace visibility is off" as an independent
reason. Once `visible` was set, `marketplace-ready`'s only remaining failure
reason collapsed to the Stripe one.

**Why `inviteFmSystemAdminsFor` exists.** The single per-restaurant `admin`
field and FM's system-admin list are genuinely separate data — confirmed
real on DeCheco's, where one person (Tyron) was SYSTEM_ADMIN across all 6
locations but was never any single location's `admin.email`.

**Why hand-granting location access is a mistake.** `grantLocationAccess`
does no FM cross-check at all. This happened for real on DeCheco's: two
people were manually granted all 6 locations on the belief they were
single-location admins, when FM's system-admin list already covered all 6
correctly through four different real admins. Always re-sync from FM instead
of hand-editing `disco_restaurant_location_access`.

**The invite-skip bug, fixed 2026-08-17 (`e72502d`).** Both invite functions
used to infer "does a working login already exist" from the account's email
shape (`ensureRestaurantLoginInvited`) or mere row existence
(`inviteFmSystemAdminsFor`) — a row created by `importRestaurantStripeAccount`
with a real email (exactly what this runbook instructs supplying) read as
"already works" while actually having a null invite token and an unguessable
random password. Caught live on Winkin' Rooster's Doug McCulloch. Both
functions now call `hasUsableLogin()`, which checks the real state (a live
token, or any session ever created) instead.

**Invite tokens are 14 days, not 72 hours.** The original 72-hour window is
exactly how several restaurants' first retroactive invites died unused
before anyone clicked them.

**The carry-over walls — two different mechanisms.** Notifications and
promo codes are a **hard role exclusion**: `NotificationSettingController`
and `CouponController` are both annotated
`@PreAuthorize("hasAnyAuthority('ADMIN', 'SYSTEM_ADMIN')")` — SUPER_ADMIN is
not in that list, for any credential, ever. Closed days is a different,
genuine **empty-response wall** — `RestaurantClosedDayController` does allow
SUPER_ADMIN, but `GET /api/closedDays` still returns `200 []` for a
restaurant confirmed to have 13 real rows behind that same login.

**Two carry-over parsing gaps, not yet fixed** (would still bite even if the
access walls above were ever lifted): `carryOverClosedDays`'s field-name
guesses don't match FM's real shape (`{ eventName, available, eventDates:
[...] }`, not `holiday`/`fromDate`/`toDate`). `carryOverPromoCodes`'s field
names are correct but the shape assumption is wrong — FM's real
`GET /api/coupon` returns a single object, not a list.

**Logo/image/phone, fixed 2026-08-17 (`34f8278`).** All three sit in the same
`GET /api/admin/restaurants/{ref}` response already fetched elsewhere in the
conversion flow — the gap was never FM access, just that nobody read them
here. `carryOverProfileFields()` now does, fill-blank-only. Fleet backfill
the same day: 26 of 34 existing native restaurants were missing at least
one; 11 gained a real phone, 0 gained a logo/image (already covered by the
map-cache/Sanity mirrors for every restaurant that has one).

**`money_flow` reconciliation, fixed 2026-08-17 (`587809c`).** This column
used to be written once, as a side effect of the admin ordering page's "Hold
Payments on FamilyMeal" toggle — not an ongoing sync, so it drifted silently
whenever FM changed by any other path. A stale `FAMILY_MEAL` value silently
blocks a legitimate restaurant-funded promo at `validate` time — exactly the
kind of failure nobody reports as a bug, they just think the promo code
doesn't work. A daily cron now reconciles all restaurants against FM's live
value and alerts on every flip. No longer a pre-flight concern for
conversion specifically, but worth knowing it exists.

**The `convert-native` timeout, fixed 2026-08-17 (`41ba6db`).** The route had
no `maxDuration`, unlike every sibling FM-heavy route. `convertToNative`'s
own order-history backfill, system-admin list fetch, and 3 carry-over
attempts are each a real FM round-trip — a single order-history page alone
measured ~15s live. Under Vercel's default timeout this surfaced as a
generic `"FM orders fetch failed"`, indistinguishable from real FM downtime.
The abort-don't-convert safety was always correct; the cause wasn't.

**The admin-form autofill bug, fixed 2026-08-17 (`dcae2c6`).** Unrelated to
the conversion procedure itself, but found via a conversion (Kealoha editing
Winkin' Rooster's admin contact in the super-admin Edit Restaurant dialog,
her own email landing in Doug's phone field). A plain, untyped phone input
next to an email input let the browser misclassify one as the other — fixed
across 8 forms app-wide, with `name`+`autoComplete` made required props
wherever a shared input helper existed, so a future field can't reintroduce
it silently.

**Known-irrecoverable fields — confirm the count hasn't grown, don't
investigate further:** `service_charge` and `stripe_fee` (null on every
`FM_SYNC`-sourced transaction row, only present on `FM_BACKFILL` rows),
~10% of `tips_in_price` fleet-wide, `tax_exempt_state`, a small number of
orders with unreachable FM fetches and `FM_BACKFILL` artifacts.
`lead_gen_one_disco_fee` null for every pre-2026 order at Glen Rock — FM's
own lead-gen tracking doesn't go back further, not a sync gap.

**`stripe_connected` isn't a valid native-readiness signal by itself** —
every converted restaurant inherits it `true` from a historical migration
regardless of real readiness. The marketplace visibility rule ORs it with
`hasCompletedNativeStripeAccount`, which is the one that means something
post-conversion.

**Multi-location brands need nothing special for admin access** —
`inviteFmSystemAdminsFor` mirrors FM's system-admin structure automatically
per location as each one converts; nobody has to think about admin access
location-by-location.

---

## Batch

What changes when converting more than one restaurant at a time:

- The invite email (§9's follow-up, sending the actual "you're live"
  announcement) needs a real bulk-send path with per-recipient Mailgun
  delivery confirmation — the verification step itself doesn't change, but
  running it N times by hand won't scale.
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

---

## FM-backed archive — queued, not built

Archive/restore (`lib/disco-restaurant-archive.ts`) ships Disco-native only.
An FM-backed restaurant currently has no archive path at all — the admin UI
disables the action for it and states why (`app/api/admin/restaurants/[ref]/
route.ts`'s `DELETE` handler returns 501 with the reason if the route is
somehow reached directly).

The blocker: "archived" is specified as gone from the internet at every
level, including FM's own checkout if a restaurant is FM-backed. The only
lever available is FM's `blocked` flag
(`POST /api/admin/restaurants/manage/block/{ref}`), and whether setting it
actually stops FM's own Angular frontend / API from taking an order has never
been confirmed — `docs/fm-marketplace-and-access-audit.md` flags this
explicitly as `[NEEDS REVIEW]`. Shipping FM-backed archive on an unverified
assumption would mean telling an admin a restaurant is gone while it's still
orderable on familymeal.com. This same gap is why the permanent-delete tool
(super admin, native-only, 0-1 orders) refuses any FM-backed restaurant
outright — a Neon-only delete there would just get silently re-created by
the daily map-cache cron within a day.

What unblocks it, whenever someone picks this up:
1. Test `blocked=true` against a real FM-backed test restaurant — attempt an
   order through FM's own frontend/API directly, not through Disco, and
   confirm it's actually rejected.
2. If confirmed: wire the archive/restore routes to call FM's block/restore
   endpoints for the FM-backed branch, symmetric with the Disco-native path.
3. If not confirmed: FM-backed archive stays unbuilt — the honest state is
   "hidden from Disco, not gone from the internet," which doesn't meet the
   spec, so there's nothing safe to ship until FM's own behavior changes or
   the restaurant converts to native (see the rest of this runbook — most
   restaurants get there within weeks anyway, which may make this moot).
