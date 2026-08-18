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
- **PETER** — needs Peter specifically (the Stripe `acct_...` id, or a tax
  confirmation that's really a conversation with the restaurant).
- **AUTO** — the conversion itself handles it; take no action.
- **NOTE** — worth knowing, doesn't block anything.

Target state: a routine conversion needs the Stripe id from Peter and
nothing else. Everything else on this page exists to get you there or to
handle the restaurant that isn't routine.

**Conversions are one at a time right now.** Everything below assumes that.
See "Batch" at the end for what changes if that stops being true.

**There is no rollback.** `is_disco_native` is written to `true` in exactly
two places in the codebase, and neither ever sets it back to `false`. Once a
restaurant converts, there is no code path to FM-backed again, and re-running
the menu import doesn't replace a bad import — it duplicates it. If
something's wrong post-conversion, fix it forward in Neon. Don't convert a
restaurant you're not ready to fix forward.

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
per conversion. In practice: BLOCKER is almost always a duplicate record or a
non-charge-capable Stripe account; PETER is the Stripe id and/or a tax
question; AUTO covers menu import and Stripe reuse once supplied; NOTE
covers closed days, notifications, and bare orders — none of them block
anything, budget the time anyway.

### 3. Resolve every BLOCKER

Don't proceed past this until none remain.

### 4. Get the PETER items

Stripe `acct_...` id from the Dashboard (never fuzzy-matched by name), and
any tax confirmation the pre-flight flagged. This is the only step that
needs Peter specifically, by design.

### 5. Stripe — reuse, never re-onboard

1. `verifyAccountReusable(accountId)` — live Stripe check (`charges_enabled
   && capabilities.transfers === 'active'`; ignore `requirementsDue`, it
   doesn't block reuse).
2. `importRestaurantStripeAccount(ref, accountId)` — one call, no restaurant
   action. `stripeMode: "not-linked"` means the id hasn't been *imported*
   yet — it does not mean the restaurant needs to onboard.

### 6. Tax rate

Set `disco_restaurant_overrides.tax_rates.stateSalesTax.percent` via
`PUT /api/restaurant/tax-rate` (Neon-only, no ongoing FM mirror). `0` is a
valid, real rate — only `null`/missing blocks the gate. If FM genuinely has
nothing, that's the PETER conversation from step 4, not a data-recovery
task.

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
| Stripe id unknown | PETER | Peter pulls it from the Dashboard; never fuzzy-match by name |
| Stripe not charge-capable | BLOCKER | Needs fresh onboarding, can't be done for the restaurant |
| Stripe charge-capable, id supplied | AUTO | One call, no restaurant action |
| Tax null on FM | PETER | Conversation with the restaurant |
| Tax real + directly verifiable | AUTO | Settings step passes on its own |
| Tax real but only via opportunistic mirror (never independently verified) | PETER | Flag for confirmation — could be stale |
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
confirmation, not an automatic pass.

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
