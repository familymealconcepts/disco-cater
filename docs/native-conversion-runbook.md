# Native Conversion Runbook

Written for Peter, running conversions directly with Claude Code and DB
access. No hand-holding — FM is the source of truth for a restaurant's real
settings, and where something looks off after conversion, the fix is manual,
after the fact.

**The procedure has never been wrong.** Conversions to date (Briscola,
Pelican, Francesca Catering – Glen Rock, Francesca Catering – Elmwood Park,
DeCheco's ×6, The Winkin' Rooster, Atlanta Bread ×9) all ran the same eleven
steps below. What varied was the *state each restaurant arrived in* — FM has
~4,400 records entered by different people over four years with no
validation, so pre-flight always finds something different. This revision's
point: the pre-flight output is now a **classified work list**, not a pile
of facts to interpret. Every condition seen so far maps to exactly one of
four buckets:

- **BLOCKER** — cannot convert until resolved.
- **PETER** — needs Peter specifically (a tax confirmation that's really a
  conversation with the restaurant, or reading a session-scoped FM value no
  automation can reach).
- **AUTO** — the conversion itself handles it; take no action.
- **NOTE** — worth knowing, doesn't block anything.

Target state: a routine conversion needs nothing from Peter at all — the
Stripe id is resolved and verified automatically (step 5), and as of
2026-08-19, tax rate, notification recipients, and closed days all carry
over automatically too (step 6, step 10) for any restaurant with a real
FM admin identity — roughly 1,058 restaurants fleet-wide, holding 98.9% of
real order volume. Everything else on this page exists to get you there or
to handle the restaurant that isn't routine.

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
PETER is now just a Stripe id that can't be resolved/verified, or a
restaurant with no real FM admin identity at all; AUTO covers Stripe
resolution/reuse, menu import, and (as of 2026-08-19) tax/notifications/
closed-days via the master-password read; NOTE covers promo codes and bare
orders — neither blocks anything, budget the time anyway.

### 3. Resolve every BLOCKER

Don't proceed past this until none remain.

### 4. Get the PETER items

As of 2026-08-19, tax/notifications/closed-days are no longer routinely
PETER items — they carry over automatically via the master-password
mechanism (step 6, step 10). What's left that genuinely needs Peter:

- **A Stripe account id that can't be resolved or verified** — either the
  restaurant onboarded after the `fm_backup` snapshot date (so it's missing
  from `tbl_stripe_connected_accounts` entirely — Alpharetta was this case,
  registered 2026-08-17 with no snapshot row), or the transfer-metadata
  verification in step 5 comes back unconfirmed. Get the real id from the
  Stripe Dashboard directly — this is the one case that still requires it.
- **Confirming closed-day polarity on a new restaurant type**, if FM's
  `/api/closedDays` response shape ever changes. The current mapping
  (`available: true` = closed) was verified once, against Pelican
  Delicatessen's known real state — see Background. If a restaurant's
  carried-over closed days look wrong, that's the first thing to check
  before assuming the carry-over itself is broken.
- Anything the pre-flight otherwise flags that automation genuinely can't
  resolve (a duplicate FM record, a restaurant with no admin identity at
  all).

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

**Stripe is no longer a blocker, fixed 2026-08-19.** `checkConversionReadiness`'s
`stripe-ready` and `marketplace-ready` steps are advisory now, not blocking —
only `not-already-native`, `native-menu`, and `settings` (tax) actually gate
conversion. Most FM restaurants have no Stripe account and will never take an
order; converting them for accurate data shouldn't wait on payment capability.
`is_live`/`visible` are computed from `evaluateMarketplaceReadiness` (FM's own
current visibility/online-ordering state, plus a capability-verified
`hasCompletedNativeStripeAccount` signal — never the historically-unreliable
`stripe_connected` column) and never forced — a restaurant with no working
Stripe account converts correctly non-live, not incorrectly live. Alpharetta
(no connected account at all) converted this way: native, data intact,
`is_live: false`, exactly as expected. Resolution failing or coming back
unverified is still a Stripe-id PETER item (step 4) if the restaurant should
actually go live — it just no longer blocks the conversion itself.

### 6. Tax rate

**Automatic as of 2026-08-19** — no longer a routine PETER item. FM's
`taxRate` endpoint is session-scoped to a real restaurant login (the
service account gets `500 — "Access is denied"`, permanently — see
Background), but `checkConversionReadiness`'s settings gate now falls
through to a **master-password read** (`lib/fm-master-admin-read.ts`) when
Neon has no real `stateSalesTax.percent` yet: it resolves the restaurant's
real FM admin identity and logs in as them, in place of their real
password, reading the live value. `0` is a valid, real rate — only
`null`/missing blocks the gate.

This costs one login (a few seconds to ~11s observed) **only** when Neon
genuinely has nothing yet — a restaurant with an already-real Neon value
(the common case) triggers no live read at all. The fetched value is reused
by `convertToNative`'s own carry-over step rather than fetched twice — see
"The master-password mechanism" in Background for the full design.

**Still a PETER conversation, not a data-recovery task, if:**
- the restaurant has no real per-restaurant FM admin at all (only a
  platform `SUPER_ADMIN` account on file — confirmed permanently denied
  regardless of any restaurant claim), or
- FM genuinely has nothing configured (the live read comes back with no
  real value either).

`Set disco_restaurant_overrides.tax_rates.stateSalesTax.percent` directly via
`PUT /api/restaurant/tax-rate` remains the manual fallback for exactly those
two cases.

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

**Announcement banner and delivery order time windows also carry
automatically** — these are free text/settings the restaurant configures on
the same FM page as closed days, but unlike closed days they're **not**
session-walled: they come from `GET /public-api/restaurants/{ref}/feesAndTips`,
a public endpoint the menu import already calls, no master-password read
needed. Confirmed live on Smyrna: Neon's `announcement` and
`delivery_order_time_windows` matched FM's portal exactly
("Pickup & Delivery | Please allow 12 hours advanced notice | Order minimum:
$200.00", `exact`) with zero extra work.

### 8. Confirm readiness, then convert

`checkConversionReadiness(ref)` — **three** blocking steps as of 2026-08-19
(`not-already-native`, `native-menu`, `settings`); `stripe-ready` and
`marketplace-ready` are advisory/reported only, not blocking (see step 5).
Then `convertToNative(ref)`. Never `goLiveNativeRestaurant` — that's for
restaurants starting native from zero.

`convertToNative` backfills FM's order history first (aborts, doesn't
convert, if FM is unreachable). **If this aborts, just retry it** — before
2026-08-17 (`maxDuration` fix, commit `41ba6db`) this frequently surfaced as
a fake `"FM orders fetch failed"` caused by the route timing out, not FM
actually being down. Confirmed live: a single FM order-history page can take
~15s, and the full flow (backfill + system-admin list + 3 carry-over
attempts) needs real headroom.

It flips `is_disco_native` always, and `is_live` from
`evaluateMarketplaceReadiness` — never forced true (see step 5) — then fires
invites + carry-over, best-effort. FM stays untouched — same admin login,
same order flow, until routing stops sending customers there.

**Order count and revenue are captured structurally, fixed 2026-08-19.**
`convertToNative` snapshots `disco_orders` count + `SUM(total)` for the
restaurant immediately before it starts (before the history backfill, so
it's the true pre-conversion state) and again at the end, returning both as
`orderStats: { before, after }` on the result. This closes a real gap: eight
of the nine Atlanta Bread locations converted without this being captured,
because nothing forced it — the runbook's own diff (step 11) asked for it
and it was still missed.

### 9. Confirm the invite landed

`convertToNative` invites FM's per-restaurant `admin.email` **and** every
person FM's real Authorized Users list confirms for this restaurant (see
Background: "FM's real access model" — not just `SYSTEM_ADMIN` coverage,
and never a self-reported multi-restaurant claim). Fixed 2026-08-17
(`e72502d`): both invite functions now check
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

- **Closed days / holidays**: **automatic as of 2026-08-19** via the
  master-password read (same mechanism as step 6, same session — one login
  covers tax, notifications, and closed days together). `carryOverClosedDays`
  was also rewritten this same day to fix a real parsing bug (see
  Background) and a polarity inversion (`available: true` = closed, not the
  literal reading) — verified against Pelican Delicatessen's known real
  state before shipping. Still flagged (`closed_days_flagged_at` set,
  `PETER` per step 4) only when no real admin identity resolves for the
  restaurant, or the live read fails.
- **Notifications**: **automatic as of 2026-08-19**, same mechanism, same
  session. Only flagged (`notification_settings_flagged_at`) for the same
  no-real-admin-identity case. Check
  `disco_restaurant_overrides.notification_emails` /
  `notification_sms_numbers` if anything looks wrong — the 778-restaurant
  bulk import from before this fix means some restaurants already had these
  populated from an earlier source; the master-password read now overwrites
  with FM's current live value regardless.
- **Promo codes**: still a genuine wall, not yet fixed — `FM /api/coupon`
  is confirmed session-scoped the same way tax/notifications/closed-days
  were, but no master-password mechanism has been built for it yet, and its
  own parsing bug (below) is also still unfixed. `promo_codes_flagged_at`
  set. Only relevant if the restaurant actually has any — check the native
  promo-code UI.
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
FM's admin view against Disco's after Winkin' Rooster converted. All four
are now automated (logo/image/phone via step 7, closed days via step 10).
For everything else, run this comparison instead of eyeballing:

| Compare | FM side | Disco side | Clean result |
|---|---|---|---|
| Business identity | `GET /api/admin/restaurants/{ref}` → `businessName`, `address` | `disco_restaurant_cache.name`, `.address` | Match |
| Logo / image | `image`/`marketplaceImage` references | `disco_restaurant_cache.icon_url` / `.image_url` | Both non-null (step 7 fills them; if FM has one and Neon doesn't, something regressed) |
| Phone | `address.phoneNumber` | `disco_restaurant_cache.phone` | Match, or both null if FM has none |
| Menu item count | `GET /api/restaurants/{ref}/mealPackages?page=0&size=1000`, flattened length | `SELECT COUNT(*) FROM disco_menu_items WHERE restaurant_reference = ref` | Neon ≥ FM (never <; cross-menu duplication can only make Neon larger) — this is the exact check `runPreflightCheck` already runs |
| Tax rate | Readable directly as of 2026-08-19 — re-run the master-password read, or just trust `taxRates.reason` on the conversion result | `disco_restaurant_overrides.tax_rates.stateSalesTax.percent` | Match to 3 decimals — Neon/FM both store full precision, not just 2 |
| Closed days | Re-run the master-password read; compare `eventName`/`available` per row | `disco_restaurant_closed_days` — `name`/`holiday`/`from_date`/`to_date` | Only holidays with `available: true` in FM's response should have rows |
| Notifications | Same read | `notification_emails` / `notification_sms_numbers` | Match, verbatim |
| Announcement / delivery window | `GET /public-api/restaurants/{ref}/feesAndTips` (public, no session needed) | `announcement` / (menu's delivery-window setting) | Match verbatim |
| Order count + revenue | `orderStats.before`/`.after` on the `convertToNative` result (captured structurally as of 2026-08-19) | Same | `after.count`/`after.revenue` ≥ `before` (backfill only ever adds rows) |
| Bare orders | — | `LEFT JOIN disco_sale_transactions ... WHERE t.id IS NULL` | Zero |
| Login | — | `disco_restaurant_accounts` row has `invite_token` live or a real session | At least one usable login exists |

If this gets built later: a script that runs all rows for one
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
| Tax null on Neon, restaurant has a real FM admin | AUTO | Fixed 2026-08-19 — master-password read resolves it live, no PETER conversation needed |
| Tax null on Neon, no real FM admin identity | PETER | The ~321-restaurant population with only a platform `SUPER_ADMIN` link on file, or none at all — genuinely unreachable |
| Tax real + directly verifiable | AUTO | Settings step passes on its own, no live read triggered |
| Stripe id can't be resolved/verified (post-snapshot onboarding, or mismatch) | PETER | Get the real id from the Stripe Dashboard — see step 4 |
| Menu not imported | AUTO | One call |
| Hidden/inactive menu items | AUTO | Supplementary heuristic pass |
| Item landed via last-resort fallback placement | NOTE | First fired on conversion 8 (Bird & Co., 2026-08-26) after 7 clean ones — see "The last-resort fallback has now fired" in Background |
| Marketplace visibility unset | NOTE | Already set by normal onboarding; `is_live` computed either way, never forced (fixed 2026-08-19) |
| `online_ordering_enabled` on, zero orders so far | NOTE | Never auto-correct or propose flipping this flag — it's set by us intentionally. A restaurant with no orders yet is just a restaurant that hasn't had an order yet, not a misconfiguration. Confirmed with Peter 2026-08-19 re: Aztec Dave's Cantina and Tom Toms Italian (both live, Stripe-connected, zero orders, no FM link) — leave alone. |
| Bare FM orders | NOTE | Background hygiene, not conversion-specific |
| Order-history backfill fails | AUTO (was a false BLOCKER) | Usually the now-fixed timeout, not real FM downtime |
| Per-restaurant admin never invited | AUTO | Fixed — real login-state check |
| FM system-admin coverage missed | AUTO | Fixed — same mechanism |
| Invite issued, unclicked | NOTE | Normal lag |
| Notifications wall | AUTO | Fixed 2026-08-19 — same master-password read as tax; PETER only for the no-real-admin population above |
| Closed-days wall | AUTO | Fixed 2026-08-19 — same mechanism; also fixed a real field-parsing bug and a polarity inversion the same day (see Background) |
| Promo-codes wall | NOTE | Not yet fixed — no master-password mechanism built for this endpoint; flag if the restaurant has any |
| Logo/image/phone missing | AUTO | Fixed, carried over fill-blank-only |
| Announcement / delivery window missing | AUTO | Fixed 2026-08-19 — public `feesAndTips` endpoint, no session needed |
| `money_flow` stale | AUTO | Fixed, daily reconciliation |
| Admin-form autofill misclassification | AUTO | Fixed, unrelated to conversion procedure |

**Stripe reuse, proven.** All 6 DeCheco's accounts checked live
(`charges_enabled` + `transfers: active`), plus Glen Rock, Elmwood Park,
Briscola, Pelican's, and Winkin' Rooster's already-imported accounts — reuse,
not onboarding, every time so far.

**`stripe-ready` under-reports since 2026-08-20 — believe the import, not the
step.** `storedAccountId()` (`lib/native-conversion.ts`, and a byte-identical
copy in `lib/conversion-preflight.ts`) reads
`disco_restaurant_accounts.stripe_account_id`. On 2026-08-20 the Stripe columns
moved to `disco_restaurant_overrides` (restaurant-scoped, one row per
restaurant, no `ORDER BY id LIMIT 1` ambiguity) and
`importRestaurantStripeAccount` stopped writing the accounts row. Nothing
updated these two readers, so a successful, verified, charge-capable import
still leaves them returning null.

Consequence: `checkConversionReadiness` reports `stripeMode: "not-linked"` and
`stripe-ready: false` for **every restaurant imported since that date**, and
`runPreflightCheck`'s Stripe section has the same blind spot. Observed live on
Bird & Co. (2026-08-26): `stripe-ready: false` on the very run that converted
it, minutes after `acct_1MemZkGvdNsY0SZV` imported cleanly.

**It is reporting-only — `is_live` is not affected.** `computeNativeIsLive` and
`checkMarketplaceReadiness` both go through `stripeReadySql()` against
`disco_restaurant_overrides`, which is correct; Bird & Co. converted
`is_live: true` as it should have. The real cost is that the next pre-flight
will read "no Stripe account" for a restaurant that has one, and someone will
either re-import needlessly or treat a converted restaurant as un-live. Fix is
to point both readers at `disco_restaurant_overrides` — `stripeReadySql()`
already encodes the definition — rather than adding a third read path.

**Tax rate reality.** FM's own data for DeCheco's 6 locations has
`stateSalesTax.percent: null` — genuinely nothing to mirror, not an access
problem. Pelican Delicatessen is a counter-example: `0%` there is a real,
deliberate rate (state/local/other all explicitly `0`). Confirmed directly
(Hugo's, 2026-08): `GET {FM}/api/restaurants/taxRate` with the service
account returns `500 — {"description":"Access is denied"}` — a real
access-control response masked as a generic error, not a flaky endpoint
worth retrying, and the exact same role-exclusion class as the
notifications/closed-days/promo-code walls below. As of 2026-08-19 this is
no longer a dead end — see "The master-password mechanism" below for how
it's read automatically now.

### The master-password mechanism (2026-08-19)

The wall above is real for the `SUPER_ADMIN` service account specifically —
confirmed (this session) that FM's own `/login` accepts the master password
in place of a real restaurant admin's password, for `ADMIN` and
`SYSTEM_ADMIN` roles. `SUPER_ADMIN` stays denied on these three endpoints
regardless of credential — the two platform accounts
(`peter@familymeal.com`, `matthew@familymeal.com`) are hard-blocked by email,
not just by role, so a future data quirk can't slip past a role-only check.

`lib/fm-master-admin-read.ts` resolves the real admin for a restaurant — a
cached bulk `SYSTEM_ADMIN` coverage map (`/api/admin/users/system-admin`, one
call), then the per-restaurant `admin` field off the same
`/api/admin/restaurants/{ref}` detail call conversion already makes for
profile-field carry-over, at no extra cost. It logs in once per admin and
reads **five walled fields** — `taxRate`, `notifications`, `closedDays`,
`promoCode`, and (added 2026-08-20) `authorizedUsers` — for every restaurant
that admin covers in one continuous session — not five logins per
restaurant, and not one login per restaurant when several share an admin.
See "FM's real access model" below for what `authorizedUsers` is and why it
exists as a separate field from the per-restaurant `admin`/`SYSTEM_ADMIN`
data this mechanism already read.

**Reach: roughly 1,058 restaurants fleet-wide** (a live `SYSTEM_ADMIN`
count of 575 plus a June-snapshot `ADMIN`-role count of 616, deduplicated),
holding **98.9% of all real order volume** (23,988 of 24,265 order rows).
The remaining ~3,321 restaurants have no real per-restaurant admin at all —
only a platform `SUPER_ADMIN` link, or nothing — and between all of them
have 25 orders and 2 real Stripe accounts total. Unreachable and, by every
measure checked, not worth reading regardless of method.

**Every attempt is audited**, success or failure, to `disco_admin_audit` as
`action = 'FM_MASTER_PASSWORD_READ'` — the same table `lib/master-login.ts`
uses for the Disco-side bypass, distinguished by `action`. The `detail`
JSONB records the admin identity and role used, every restaurant read,
what was switched to, what it was restored to, and whether that restore was
independently verified.

**Switching selected restaurant is a persisted, server-side change on a
real admin's own FM account — not a safe read.** A two-token test proved
this directly: logging in twice as the same admin and switching selection
via one login was visible to the *other*, completely separate login as the
same user. FM resolves "current restaurant" from state keyed to the
account, not from anything in the session token. Every switch here is
therefore bookended: read → switch back to that admin's real home
restaurant, in a `try/finally` so a mid-batch failure still triggers the
restore → verify the restore actually landed (re-read, don't just trust the
switch call's `200`) → alert loudly (`alertOps`) if it can't be confirmed.

The home restaurant itself is resolved independently of the post-login
JWT — a real gap found on the very first live conversion (Smyrna): the
JWT's own `restaurant` claim decoded as `null` on that run despite an
immediate manual re-login with identical credentials decoding it correctly,
cause unconfirmed. `homeRestaurant` now comes from the `SYSTEM_ADMIN` bulk
list's own `restaurant` field (already fetched for identity resolution) or,
for a plain `ADMIN`, is simply the restaurant being converted (an `ADMIN`
belongs to exactly one). If an admin covers restaurants other than a home
that can't be independently confirmed, the mechanism now refuses to switch
at all rather than switching with no verified way back. Re-verified on the
Atlanta Bread batch: `tmc@atlantabread.com` covers eight of the nine
locations — the first genuine multi-restaurant session — and its audit row
showed `homeRestaurant` correctly resolved, `restoreConfirmed: true`.

**The polarity mapping — record this, it was wrong for about an hour.**
FM's `/api/closedDays` response shape is `{eventName, available,
eventDates: ["DD.MM.YYYY", ...], reference}`. The field name reads like
"is the restaurant available (open)," and the first implementation read it
that way (`available: false` = closed) — plausible, and wrong. **`FM:
available: true` means ordering is unavailable, i.e. closed, i.e. the box
is checked in FM's Scheduling Override UI.** Verified against Pelican
Delicatessen's own known real state (Peter): exactly one box checked there
(Memorial Day) — and Memorial Day was the only entry with `available:
true`, all eleven others `available: false`. Nothing had been written
under the wrong polarity to a real restaurant before this was caught
(Pelican itself was already native and had never had its closed days
carried over) — but if this shape or mapping is ever in doubt again on a
new restaurant type, verify against that restaurant's own known state
before trusting a bulk write, the same way this was settled.

**The tax-gate catch-22, fixed the same day.** A brand-new restaurant
(Alpharetta, registered 2026-08-17) has no tax rate mirrored to Neon by
anything — the old opportunistic mirror only fires when a restaurant's own
admin views the tax page, and the conversion carry-over that would
otherwise populate it doesn't run until *after* the readiness gate passes.
`checkConversionReadiness`'s settings gate now falls through to the same
master-password read when Neon has nothing, so this no longer needs a
manual pre-seed. Confirmed live both ways: a restaurant with an already-real
Neon rate triggers no live read at all (`taxSource: "neon"`); one with none
does, at a real, one-time cost (~11s observed for the login/read round
trip). The read is fetched at most once per conversion either way — a
`fetchedWalled` result from the gate is reused by the carry-over step
rather than triggering a second login.

**The master password is a distinct secret from `MASTER_PASSWORD_HASH`.**
`FM_MASTER_PASSWORD` (a new env var, plaintext, read only inside
`lib/fm-master-admin-read.ts` — never reachable from general request
handling) and `MASTER_PASSWORD_HASH` (Disco's own portal-login bypass,
SHA-256 only) are two representations of the *same* underlying value —
confirmed by hashing the working FM password and matching it against the
stored hash exactly. Rotating the real master password means rotating
**both** env vars in lockstep, plus whatever holds it on FM's own side
(presumably the authoritative copy, since this codebase doesn't push
anything to FM) — a three-way dependency this file can't enforce, only
document.

**`FM_MASTER_PASSWORD` must be persisted in BOTH `.env.local` AND Vercel
production, not just used ad hoc.** Confirmed missing from both as of
2026-08-20 — it was used once this session (pulled from wherever it was
available at the time) but never saved anywhere durable. Vercel is not
optional: `app/api/cron/reconcile-promo-codes/route.ts` already documents it
as required and runs unattended, and `convertToNative` needs it live in
production too. Its absence doesn't fail uniformly — `notifications`/
`closedDays`/`promoCode`/`authorizedUsers` all degrade gracefully (flagged
for manual review, or a skipped invite step, conversion still completes),
but the `settings`/tax-rate gate is `blocking: true` and only attempts the
master-password read when Neon has no rate yet — so a brand-new restaurant
with no tax rate on file cannot complete conversion at all without this
credential actually being set.

**Menu import mechanics.** The primary placement pass is exact, no
heuristics — it walks FM's public per-menu endpoint, which only ever returns
items on a menu FM currently marks visible/active. The supplementary pass
covers everything that misses that via priority order: exact schedule-window
match → learned category placement → name overlap → a party-size regex →
first-visible-menu as a last resort. Proven clean on all 6 DeCheco's
locations and Winkin' Rooster's hidden "[Copy] Sandwich Tray" (both via
learned category placement, not the fallback).

**The last-resort fallback has now fired — conversion 8, Bird & Co.,
2026-08-26.** Seven conversions ran without it; this one returned
`supplementaryItemsPlaced: 1` **and** `unplacedFallbackCount: 1`, meaning the
item exhausted schedule-window match, learned category placement, name overlap
and the party-size regex, and landed via first-visible-menu.

**The placement was still correct, and understanding why matters more than the
count.** Bird & Co. has exactly one menu, so "first visible menu" and "the right
menu" are the same answer — the fallback cannot be wrong on a single-menu
restaurant. Read this as the fallback being *exercised*, not as a placement to
distrust. On a multi-menu restaurant the same code path would be a genuine
coin-flip, and that is the case to watch for.

**What actually triggered it was duplicate FM data, not a placement failure.**
FM holds two `tbl_meal_packages` records with the identical name
`Build-Your-Own Taco Bar (10-person minimum)` in the same category — one live at
$26.00, one `visible: false` at $0.00. The hidden one is what fell through: name
overlap can't disambiguate against its own twin. Both imported; the $0 copy is
`visible: false` in Neon so it cannot be ordered, and is a cleanup candidate
rather than a live risk. **If the fallback fires again, check for a duplicate
name in FM before assuming the heuristic chain is at fault.**

**Marketplace visibility, confirmed independent of Stripe.** On a freshly
created test restaurant, the gate reported two failing blocking steps until
`disco_restaurant_overrides.visible` was set — `stripe-ready` (expected) and
`marketplace-ready` citing "Marketplace visibility is off" as an independent
reason. Once `visible` was set, `marketplace-ready`'s only remaining failure
reason collapsed to the Stripe one.

**FM's real access model (2026-08-20) — the restaurant object's `admin`
field is one designated contact, not the set of people with access.** A
location can have multiple admins running catering there. A business owner
can hold every location a brand has. A regional manager can hold whatever
subset the owner grants them. None of that is visible from
`/api/admin/restaurants/{ref}`'s single `admin` field or even from the
`SYSTEM_ADMIN` coverage map alone — the real source is
**`GET /api/system-admin/users`**, the same relationship behind FM's own
Authorized Users screen. `restaurantReference` on its create shape
(`{firstName, lastName, email, role, restaurantReference: string[]}`) is an
**array** — confirmed proof this is a genuine many-to-many join, not a
single-restaurant field.

This endpoint is session-walled exactly like `taxRate`/`notifications`/
`closedDays`/`promoCode` — reachable only via the master-password mechanism
above, now the 5th field (`authorizedUsers`) in `readWalledFields()`.
**It additionally requires a `SYSTEM_ADMIN`-role session specifically** — a
plain `ADMIN`-role login (a single-location restaurant's only admin) gets a
flat `500 Access is denied`. This is correct, not a gap: a single-location
restaurant has no Authorized Users list to have — FM's whole multi-admin
concept only exists at the `SYSTEM_ADMIN`/chain level. Confirmed live on 3 of
the first 24 converted restaurants (Francesca Catering ×2, The Winkin'
Rooster) — all three resolve to a role=`ADMIN` identity, and
`authorizedUsers` correctly comes back `null` for all three, not empty.

**Worked example — Atlanta Bread's 9 locations, read live 2026-08-20.** Two
clean, distinct access clusters, confirming the model rather than looking
like noise:
- **Owner cluster, all 9 locations**: `bcouvaras@atlantabread.com`,
  `kumar.adarsh@gmail.com`, `arnav.anju@gmail.com`,
  `atlbreadcollections@gmail.com`, `atlbreadsandysprings@gmail.com`,
  `kjp@atlantabread.com`, `tmc@atlantabread.com` — all `SYSTEM_ADMIN`.
- **Regional cluster, 8 of 9 — everything except Alpharetta**:
  `southcobb@atlantabread.com`, `josh@woosindustries.com`,
  `stacy.freemyer@atlantabreadwoodstock.com`,
  `atlantabreadasheville@gmail.com`, `davidjenningsfisher@gmail.com`,
  `abwestside245@gmail.com` (`ADMIN`), plus `anthie@thenccgroup.com` and
  `tara@thenccgroup.com` (`SYSTEM_ADMIN`). Alpharetta genuinely differing
  from its 8 siblings is itself the evidence this is a real, working
  restaurant-scoped read, not a brand-wide list that happens to look
  restaurant-specific.

**Grant per confirmed restaurant, never from a claimed scope.**
`inviteFmAuthorizedUsersFor` (replacing the old `inviteFmSystemAdminsFor`)
grants **only the restaurant currently being read** — deliberately narrower
than the old mechanism, which mirrored FM's entire self-reported
`managedRestaurants` array onto every restaurant that admin happened to
cover. That old pattern is exactly how over-permission would happen: one
record's claimed scope propagating to locations nobody actually
re-confirmed. Under the new model, access to a given restaurant accumulates
only when *that restaurant's own* Authorized Users read confirms the
person — real, and it self-corrects as each location gets its own
conversion/read pass, rather than trusting a single upstream claim to cover
everyone. (Same underlying lesson as the original `grantLocationAccess`
warning below, one level deeper: even an FM-sourced bulk claim isn't
grounds to grant a restaurant nobody actually checked.)

**Why hand-granting location access is a mistake.** `grantLocationAccess`
does no FM cross-check at all. This happened for real on DeCheco's: two
people were manually granted all 6 locations on the belief they were
single-location admins, when FM's system-admin list already covered all 6
correctly through four different real admins. Always re-sync from FM instead
of hand-editing `disco_restaurant_location_access`.

**The missed-invite gap this closes.** The old two-source model (per-
restaurant `admin` + `SYSTEM_ADMIN` coverage) silently missed every plain
`ADMIN`-role authorized user who wasn't the one designated contact —
confirmed real: `southcobb@atlantabread.com` had genuine, FM-granted access
to 8 Atlanta Bread locations and a Disco account existed nowhere. A fleet
audit across all 24 converted restaurants (2026-08-20) found 25 distinct
FM-authorized people total; 5 had no Disco account at all, and 10 more held
correct-but-partial grants (as few as 1 of 9 locations) from the old
`managedRestaurants`-mirror path. Zero cases of the reverse (Disco granting
*more* than FM confirms) were found anywhere in the 24 — the over-permission
risk was real in the design, not yet realized in the data.

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

**The carry-over walls — two different mechanisms, one now bypassed.**
Notifications, closed days, and tax are all a **hard role exclusion**:
their controllers are annotated
`@PreAuthorize("hasAnyAuthority('ADMIN', 'SYSTEM_ADMIN')")` — `SUPER_ADMIN`
is not in that list, for any credential, ever, including the service
account's. That's exactly why the master-password mechanism above works:
logging in as the restaurant's *real* `ADMIN`/`SYSTEM_ADMIN` identity
satisfies the same `@PreAuthorize` check a real human's session would.
Promo codes (`CouponController`) has the identical exclusion but no
master-password mechanism has been built for it yet — still a genuine wall
in practice, see below.

**One carry-over parsing gap, fixed 2026-08-19; one still open.**
`carryOverClosedDays`'s field-name guesses didn't match FM's real shape —
confirmed only once real data was reachable at all (via the master-password
read): it's `{ eventName, available, eventDates: [...], reference }`, not
the guessed `holiday`/`fromDate`/`toDate`. Fixed, along with the polarity
mapping above. `carryOverPromoCodes`'s field names are correct but the shape
assumption is still wrong — FM's real `GET /api/coupon` returns a single
object, not a list — and remains unfixed since promo codes still has no
read mechanism to exercise it against.

**The two order-reminder toggles were dropped by the notification carry-over,
fixed 2026-08-26 (`cd15df0`).** `carryOverNotificationSettings` wrote the
recipient lists and silently discarded `orderReminderEmailsEnabled` and
`adminOrderReminderEmailsEnabled`, both sitting on the same
`GET /api/notifications` response it already reads. Restaurants therefore
converted onto `disco_restaurant_overrides.order_reminder_emails_enabled`'s
`DEFAULT false` regardless of what FM said. A read of all 32 real native
restaurants' live FM values (2026-08-26) found **18** in the FM-true/Neon-false
state — Atlanta Bread ×9, DeCheco's ×6, Francesca ×2, Briscola, i.e. exactly
the set that converted and never had a portal Save afterwards — plus two with
the admin toggle null against FM true. All 20 were reconciled by hand. The fix
now COALESCEs: a non-boolean from FM means "FM didn't say" and leaves Neon's
value alone, so it can never write a fabricated `false`.

**The reminder cron is asymmetric between its two passes — this is the
non-obvious part, and it is what makes the restaurant-facing toggle the riskier
of the two.** `app/api/cron/order-reminders` runs hourly at `:00` and selects a
23.5h–24.5h window before pickup, with a placement skip, in the restaurant's own
timezone:

- **PASS 1 (customer reminder)** additionally filters
  `source_of_order = 'DISCO'`. FM's own Java backend already emails the diner
  for FAMILYMEAL-sourced orders, and that filter is precisely what stops Disco
  double-emailing the same person from `orders@discocater.com`.
- **PASS 2 (restaurant/admin reminder)** has **no source filter at all**. It
  fires on FM-mirrored orders too, and sends one email *per recipient* on
  `notification_emails` — 5 and 6 addresses respectively at the two Hugo's
  locations.

Two practical consequences. First, flipping the customer toggle on for a
freshly-converted restaurant changes nothing until it takes its first genuinely
native order — every one of the 18 above has 100% FAMILYMEAL-sourced history, so
no diner had ever actually missed a reminder; the setting was wrong, the outcome
was not. Do not describe that backfill as restoring lost mail. Second, the admin
toggle is live from the next FM-mirrored order onward, which is why it deserves
a conversation with the restaurant before being changed rather than a silent
reconcile. There is no retroactive catch-up in either pass — an order whose 24h
mark passed while a toggle was off is missed permanently. Fleet totals are tiny
(4 customer, 8 admin reminders ever sent as of 2026-08-26), so an unexpected
spike is worth a look rather than a shrug.

**A newer Neon value can be the restaurant's own deliberate choice — check
before "reconciling" it to FM.** Hugo's Studio City and West Hollywood both read
FM `adminOrderReminderEmailsEnabled: false` against Neon `true`, which looks like
Disco being over-permissive. It wasn't. All four Hugo's locations were written in
sequence at 16:41:52, 16:44:07, 16:46:08 and 16:48:39 on 2026-08-25 — ~2½ minutes
apart, human pace, not a cron's same-second burst — from a real
`contact@hugosrestaurant.com` portal session (`disco_restaurant_sessions` id 207,
created 16:44:04). Not a master-password login: the `MASTER_PASSWORD_LOGIN` audit
rows that day start at 16:59, after the last write. The location-specific
recipient lists they saved (`weho@hugos.us`, `stucity@hugos.us`) are restaurant
knowledge no script would produce. So Disco holds the *more recent, deliberate*
value and FM holds the stale one — the direction of the fix is the opposite of
what the diff suggests. Note also that `disco_admin_audit` has **no action for a
notifications save**, so attribution here came from session and `updated_at`
forensics; if that becomes a recurring question, an audit row on that route is
the cheap fix.

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
`inviteFmAuthorizedUsersFor` reads FM's real Authorized Users list per
restaurant automatically as each location converts; nobody has to think
about admin access location-by-location. See "FM's real access model"
above for why this reads a 5th walled field rather than mirroring a
self-reported multi-restaurant claim.

### Email sending rules (2026-08-20)

**Stagger every invite/announcement send by at least 30 seconds.** A real
14-email burst went out in 3 seconds and landed in spam — confirmed the
cause, not a guess. `lib/bulk-invite.ts`'s `sendPaced()` is the one place
this pacing should live; nothing should write a second bare send-loop.

**Cold-verify each accept-invite token before sending it.** `GET
/api/restaurant/accept-invite?token=...` validates without consuming —
confirm `{valid:true, email: "..."}` matches the intended recipient before
the email goes out, not after. Catches a bad/mismatched token before it
reaches a real inbox instead of after someone reports a broken link.

**When FM's name field holds a location, not a person, use "Hi there,"
— don't invent a name.** Real examples from FM's own Authorized Users
data: `"South Cobb"`, `"ABC Westside"`. That's what FM has on file, not a
lookup failure to work around — checked the diner-table record, its detail
endpoint, and the Authorized Users record itself for all three; all three
agree, and no richer name exists anywhere reachable. Inventing a plausible-
sounding name would be worse than a generic greeting.

**Current deliverability state, as of 2026-08-20:**
- `mg.discocater.com` is the Mailgun-verified sending domain (confirmed via
  Mailgun's own Domains API — the root `discocater.com` isn't registered in
  Mailgun at all, a 404). Every visible From address still uses
  `@discocater.com` (root), which works today only because
  `discocater.com`'s own DMARC record uses relaxed alignment
  (`adkim=r; aspf=r`) — deliberately not changed to the verified subdomain,
  since that would expose an uglier address to every recipient for a risk
  that's contingent on someone else's future DNS change, not a live break.
  Documented as a dependency in `lib/email/send.ts`, not fixed.
- Every send now includes a real plain-text part via the shared
  `sendEmail()` (`lib/email/htmlToText.ts` derives it automatically), fixing
  the original HTML-only deliverability gap.
- **All three hand-rolled Mailgun senders found during that work are now
  fixed**, not still-open — `become-a-partner/menu-upload`,
  `become-a-partner/complete`'s team notification, and
  `cron/recurring-orders` all route through the shared `sendEmail()` as of
  2026-08-20, each verified against a real send as genuine
  `multipart/alternative`. (If this file is read later and a new hand-rolled
  sender has appeared, that's a regression to fix the same way — not
  evidence this list was wrong.)

### Menu tagging + one menu per order (2026-08-20) — product rule, not just a bug fix

**Delivery method, service charge, and fulfillment availability (pickup vs
delivery) are all per-MENU settings, not per-restaurant.** A single
restaurant can have one menu on third-party delivery and another
self-delivered, different service-charge percentages per menu, and a
holiday-only menu that's pickup-only while the regular menu offers both.
FM's restaurant-level fields (`deliveryType` etc.) are only a default — the
real setting lives on `disco_menus`. This used to be a bug (nothing recorded
which menu an order's cart came from, so dispatch/fees/checkout all guessed
the primary menu via `ORDER BY position, id LIMIT 1`); it's now a closed,
fully-wired system, plus a deliberate product constraint on top of it:

- `disco_orders.menu_reference` (added 2026-08-19) is populated at
  placement from the cart's tagged items (`resolveCartMenuReference`).
  Every consumer — `loadRestaurantServiceChargePct`,
  `loadRestaurantDeliverySettings`/`validateNativeDelivery`,
  `dispatchExpediteForOrder`'s dispatch cross-check, and (2026-08-20)
  `loadMenuFulfillmentAvailability` at placement time — takes an explicit
  `menuReference`, resolves the exact menu, and only falls back to the
  `LIMIT 1` guess when an order has no tag (logged as a fallback, never
  silent). As of 2026-08-20: 0 of 24,291 orders have `menu_reference`
  populated — every existing order takes the fallback path, which is
  correct for all of them today (47 of 48 native restaurants have exactly
  one menu; the fallback and the real tag agree by construction). This will
  start diverging as multi-menu native restaurants place real orders.
- **One menu per order is an enforced rule, not a limitation to work
  around.** `RestaurantClient.tsx`'s cart guard blocks adding an item from a
  menu that differs from whatever's already in the cart — regardless of
  whether the two menus happen to share a delivery method. (An earlier
  version of this guard only blocked a delivery-method *mismatch*; that was
  tightened to "any different menu" because same-method menus can still
  disagree on fulfillment availability — see next point — which the
  method-only comparison didn't catch.) Cross-menu ordering is a deliberate
  future feature, not an omission — see the sizing note below before
  scoping it as quick.
- **Per-menu fulfillment availability is real and enforced**
  (`disco_menus.offers_pickup`/`offers_delivery`, both default true). The
  picker UI already disabled an unavailable toggle; `buildNativePlaceInput`
  now also refuses server-side (`loadMenuFulfillmentAvailability`) so a
  direct API call can't place a delivery order against a pickup-only menu
  or vice versa.
- **Telemetry**: the cart guard fires `trackEvent('menu_block_shown', {
  restaurant_name, restaurant_slug, cart_menu_name, attempted_menu_name })`
  via GA4 (same `trackEvent` path as `checkout_opened`/`checkout_completed`
  — no new analytics plumbing). Check GA4 → Reports → Engagement → Events →
  `menu_block_shown` for volume/restaurant breakdown. This rule is stricter
  than the delivery-method-mismatch rule it replaced, so it's expected to
  fire more on FM-backed multi-menu restaurants (native restaurants can't
  trigger it today — see below); if it's firing constantly, one-menu-per-
  order is friction rather than protection.

**Multi-menu native customer browsing does not exist yet — sizing note.**
`loadDiscoNativeRestaurant` (`shared.tsx`) hard-limits a native restaurant's
customer page to its one primary menu (`ORDER BY position, id LIMIT 1`,
returns exactly one `menuData` entry). This is why the one-menu-per-order
guard above can't currently be exercised by a native customer — there's
only ever one menu to add from. Building real multi-menu native browsing
means: (1) the data loader returning every visible menu instead of `LIMIT
1`; (2) the category/item query, which today pulls **all** of a
restaurant's items with no menu filter at all — silently relying on "only
one menu exists" — would need real per-menu scoping; (3) cart-management UX
decisions (what happens to an in-progress cart when switching tabs, what
"start a new order" actually does). This is a multi-day feature, not a
quick follow-up — don't scope it as one.

**Real incident this caused** (historical, now fixed): `createExpediteDelivery()`
(`app/api/order/confirm-payment/route.ts`) dispatched a real Expedite
courier for The Winkin' Rooster — a restaurant whose menu, and FM's own
restaurant-level record, both say self-delivery only — because that
function checked `order_type = 'DELIVERY'` alone, no delivery-method check
at all. Same root class of bug also fired at DeCheco's - Munroe Falls via
the (correctly-gated) native dispatch path, off a mismatched imported
menu-level setting. Both the `confirm-payment` gate and the menu-tagging
fix shipped 2026-08-20; the underlying question of whether FM's
restaurant-level or menu-level field should win when they disagree is still
open for the 11 native restaurants where they don't currently agree (see
`disco-cater`'s own session history for that specific list — not
duplicated here since it's restaurant-data-specific, not procedural).

---

## Batch

What changes when converting more than one restaurant at a time:

- The invite email (§9's follow-up, sending the actual "you're live"
  announcement) needs a real bulk-send path with per-recipient Mailgun
  delivery confirmation — the verification step itself doesn't change, but
  running it N times by hand won't scale.
- `inviteFmAuthorizedUsersFor` reads via the master-password mechanism
  (`readWalledFieldsForRestaurants`), which already groups by resolved admin
  and shares one login across every ref passed to it in the same call — but
  only if the caller passes all the batch's refs together (or threads
  `opts.prefetchedWalled` through, same as tax/notifications/closedDays/
  promoCode). Calling `convertToNative` one restaurant at a time in a loop,
  each with its own single-ref read, gets none of that sharing — worth
  batching the walled-field read up front for a real multi-restaurant run,
  same lesson as the old ~363-record system-admin list re-fetch this note
  used to describe.
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
