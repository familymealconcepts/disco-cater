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
| Item landed via last-resort fallback placement | NOTE | Hasn't happened yet in 7 conversions |
| Marketplace visibility unset | NOTE | Already set by normal onboarding; `is_live` computed either way, never forced (fixed 2026-08-19) |
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
reads `taxRate`, `notifications`, and `closedDays` for every restaurant that
admin covers in one continuous session — not three logins per restaurant,
and not one login per restaurant when several share an admin.

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
