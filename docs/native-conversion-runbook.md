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

#### WHICH KEY VERIFIES — settle this before anything else (2026-09-02)

**`STRIPE_READONLY_KEY` is LIVE (`rk_live_…`). `STRIPE_SECRET_KEY` is TEST (`sk_test_…`)
locally.** That is the whole answer, and establishing it took two sessions. It should not
take a third.

- Verification (`accounts.retrieve`, `transfers.list`, PaymentIntent metadata) MUST use
  `STRIPE_READONLY_KEY`. Confirmed live against a known-good account — Tenkatori's
  `acct_1OakQrFzjlnQ16We` returns the account and 3 transfers.
- `verifyAccountReusable` and `importRestaurantStripeAccount` default to `getStripe()`,
  which reads `STRIPE_SECRET_KEY`. **Locally that is the test key, so you must pass the
  live key explicitly** — `importRestaurantStripeAccount(ref, acct, { stripe })`.
- **WHY THAT MATTERS MORE THAN IT LOOKS.** `verifyAccountReusable` fails CLOSED on a
  retrieve error, and `importRestaurantStripeAccount` writes `stripe_account_id`
  regardless while gating `stripe_onboarding_complete` and `stripe_connected` on
  `reusable`. Run it with the test key and you get a SILENT HALF-IMPORT: an account id
  sitting in production with both flags false, so the restaurant still cannot take orders
  and the next person sees an id and assumes the job is done. Strictly worse than no
  account at all.

#### A WRONG ID AND A WRONG KEY PRODUCE THE IDENTICAL ERROR

Stripe answers both with:

```
The provided key '…' does not have access to account 'acct_…'
(or that account does not exist). Application access may have been revoked.
```

That message distinguishes NOTHING. A live account behind a test key, a revoked account,
and a one-character typo are indistinguishable from it.

**This is not hypothetical — it cost a session.** Alpharetta's account was first attempted
as `acct_1U5nb03WZv4qhog5` (**digit zero**). The real id is `acct_1U5nbO3WZv4qhog5`
(**capital O**) in the `1U5nbO3` segment. The wrong id was reported as "not connected to
platform", and the test key was blamed — both were wrong at once, and either alone
produces the same error.

**RULE: confirm an id against the LIVE key before concluding anything about access.** Never
report "no access" or "not connected" from a failed retrieve until the id itself has been
checked with `STRIPE_READONLY_KEY`. If Peter supplies an id by hand, treat `0`/`O` and
`1`/`l`/`I` as suspect and test the alternates — it is one extra call.

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
because nothing forced it — the runbook's own diff (step 12) asked for it
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

### 11. Multi-unit /locations link — **NOT BUILT, DO THIS BY HAND**

**Applies only to a chain**, i.e. a restaurant whose SYSTEM_ADMIN holds more than one
location. A single-venue conversion skips this step entirely.

**Nothing in `convertToNative` or `checkConversionReadiness` touches
`disco_multi_unit_links`.** `grep -c multi_unit lib/native-conversion.ts` returns 0. It
was scoped as a per-chain step at conversion time and never written — it is a gap, not a
regression. Until it is built, a human does the following, or the chain's `/locations`
page silently keeps being served by FM.

**Why it matters even though the page still "works".** The FM fallback in
`getLocationLink` covers a converted chain, so nothing looks broken — which is exactly
why Gracious went three weeks unnoticed. But a converted chain served from FM's group
endpoint is a live dependency on an unmaintained system, and its membership is FM's, not
ours. See the 2026-08-31 section below for why explicit links are compulsory.

**1 — find the FM group slug.** It is NOT derivable from the location slugs. Gracious's
two are `graciousbakerycafe-gardendistrict` and `graciousbakery-uptown`; the group slug
is `graciousbakery`. Probe candidates until one answers:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://api.familymeal.com/public-api/restaurants/group/<candidate>"
```

**Accept a 200 only if its membership CONTAINS the converting restaurant's reference.**
A 200 for some other chain's slug is a wrong answer that looks like a right one.

There is no ref → slug endpoint. Probed and confirmed 404 on 2026-09-02:
`/public-api/restaurants/{ref}/links`, `/{ref}/group`,
`/links/restaurant/{ref}`. `/public-api/restaurants/{ref}` returns 200 but carries no
link- or group-shaped key. The authenticated portal listing
(`/api/system-admin/restaurants/links/listing`) is keyed on `userReference`, not on a
restaurant. So probing is currently the only route.

**2 — create or grow the link.** If a native link already exists at that slug, ADD this
member. If not, create it with this ONE member.

Never write the whole chain at once from FM's list. **A chain converts one location at a
time — Atlanta Bread converted over days — so the link has to GROW.** A link written
once at the first conversion and left alone stays short forever. Growth is monotonic:
add on each conversion, never remove. `getLocationLink`'s native branch already filters
members on `is_live = true AND archived_at IS NULL`, so a location that later goes dark
drops off the page without a second write path.

**3 — membership comes from `disco_restaurant_location_access`, never from FM's group
list.** FM supplies the **slug and title only**.

FM's group endpoint OVER-REPORTS. That is not theoretical: it is how Morning Squeeze
(`8a7bb6f5-25fd-4672-b75c-e2912620116e`, Tempe AZ) ended up listed on
`/locations/eggstasy` despite being unchecked, and FM's grouping cannot be corrected
because nobody maintains FM's Java backend. Copying FM's membership copies that class of
error into Disco, where it becomes ours. Cross-check the two lists and **stop on any
divergence in either direction rather than picking a side.**

**4 — re-host the banner, never hotlink FM.** The native branch has no FM image fallback
(deliberately — see below), so seeding a link DROPS THE BANNER and the page falls to its
auto-extracted gradient. That happened to Gracious on 2026-09-02.

Use `rehostFmBanner` (`lib/locations/fm-banner.ts`): downloads FM's image, sniffs magic
bytes, uploads to Vercel Blob under `fm-link-banners/<sha256>.<ext>`. Content-addressed,
so re-runs are idempotent and identical banners across slugs collapse to one object.

**TWO WRITES ARE REQUIRED, and this is the part that fails silently.**
`upsertLocationLink`'s `ON CONFLICT` updates `title` and `restaurant_reference` but
deliberately **NOT** `image_url` — so it cannot set a banner on a slug that already has a
row, and it reports success either way. A row very often DOES already exist with
`image_url` NULL, because `resolveGradient`'s `cacheAutoGradient` creates one the first
time the page renders. **Call `upsertLocationLinkImage(slug, blobUrl)` as well.**

**Do NOT "fix" this by adding an FM image fallback to the native branch.** Reaching back
to FM at render time for a converted chain reintroduces exactly the dependency conversion
exists to sever.

**5 — verify.** `curl -s https://www.discocater.com/locations/<slug>` and check: the Blob
URL appears, `api.familymeal.com` appears ZERO times, and every expected location renders
with an `/order/<slug>` link (**`/order/`, not `/restaurants/`** — the Order button
target). Gracious, done 2026-09-02, is the worked example.

---

### 12. Post-conversion diff — a concrete check, not a screen comparison

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
| `online_ordering_enabled` on, zero orders so far | NOTE | Never auto-correct or propose flipping this flag **on a DISCO-NATIVE restaurant** — it's set by us intentionally. A restaurant with no orders yet is just a restaurant that hasn't had an order yet, not a misconfiguration. Confirmed with Peter 2026-08-19 re: Aztec Dave's Cantina and Tom Toms Italian (both live, Stripe-connected, zero orders, no FM link) — leave alone. **Scope narrowed 2026-09-01:** on an FM-BACKED restaurant the flag is a mirror with no authority of its own and IS auto-corrected from FM every 15 minutes — see "`online_ordering_enabled` is a mirror before conversion". |
| `online_ordering_enabled` false on an FM-backed restaurant | AUTO | Was the single most common false BLOCKER at conversion: 4,224 FM-backed rows carried a bulk-import `false` and 296 of them actively disagreed with FM, 186 of those taking real orders. Fixed at the source 2026-09-01 — the mirror cron corrects it before you ever reach the readiness gate. If it's still false, FM says false too, and that is a real answer. |
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

---

## Recurring orders — two things that don't work, logged not fixed (2026-08-27)

Found while sizing "carry item references into the recurring snapshot" (gap 1,
still on hold). Neither is urgent: exactly ONE recurring order exists in the
system, it's a test fixture, and per the second finding below its native branch
has never executed. Logging so nobody re-derives this.

### 1. `repriceCart` and `checkMenuAvailability` are inert — the catch swallows a 500

`lib/recurring.ts` reads the menu through
`GET {FM}/public-api/restaurants/{ref}/mealPackages` — with **no
`menuReference` query param**. FM requires it, and answers:

```
HTTP 500
{"code":"500-001","description":"Unforeseen and unhandled error :
  Required UUID parameter 'menuReference' is not present", ...}
```

(verified live 2026-08-27 against a real UUID.) So:

- `fetchMenuItemPrices` throws → `repriceCart`'s `catch { return cart }` returns
  the snapshot unchanged. **The re-price has never happened.** The comment at
  `app/api/cron/recurring-orders/route.ts:493-495` — "Re-price the cart against
  the CURRENT menu before charging (I5), so a menu price change since setup is
  reflected" — describes behaviour that does not occur. A recurring order charges
  the price frozen at setup, indefinitely.
- `checkMenuAvailability` throws on the same call. Its caller correctly treats a
  throw as "couldn't determine" rather than "everything is gone" (deliberate, so a
  transient FM hiccup can't falsely pause a subscription) — which means it never
  pauses anything either. A removed item is never detected.

Both failures are silent by construction: the swallow is the *right* behaviour for
a transient error, it just also hides a permanent one.

Same root cause as the `/order/[slug]` zero-packages bug: FM's `mealPackages`
requires `menuReference`. Note the correct fix for a Disco-native restaurant is
**not** to add the param — it's to read Neon (`disco_menu_items`), since FM's copy
of a converted restaurant's menu is stale by definition. Wire the native branch to
Neon and keep the FM call only for FM-backed restaurants.

### 2. A recurring order cannot be created from a native order at all

Both producers build the payload as:

```ts
restaurantReference: detail.restaurant?.businessNameWithoutSpaces || ''
```

- `app/(customer)/account/components/OrderDetailPanel.tsx:424`
- `app/(customer)/account/subscriptions/page.tsx:296`

`buildNeonDetail` — the **native** branch of `app/api/fm-order-detail/[ref]/
route.ts` — never sets `businessNameWithoutSpaces` on its `restaurant` object
(it returns `businessName`, `phoneNumber`, `timezone`, `address`). So for a native
order the expression resolves to `''`, and `POST /api/recurring-orders:114`
rejects it:

```
400  {"error":"restaurantReference, restaurantName and sourceOrderReference are required"}
```

For an FM-backed order it resolves to a **slug**, not a reference. That is why the
one existing recurring order carries `restaurant_reference = 'testkitchen'` while
that restaurant's real reference is `c8322ff4-32dd-47bc-8515-3f0cffc34bbf`.
Consequence: `isDiscoNativeRestaurant('testkitchen')` returns false, so the cron
takes the **FM branch** — the native recurring path
(`chargeAndPlaceNativeRecurringOrder`) has never run once in production.

The fix is small and is the prerequisite for all of gap 1: `buildNeonDetail`
already SELECTs `o.restaurant_reference`, it just isn't surfaced. Expose it and
use it in both producers. Until then, nothing reference-based in the recurring
pipeline can resolve, and `subscriptions/page.tsx:282`'s comment ("Pulls the full
order detail so we have the restaurant reference") is not true.

---

## Two scheduling divergences with FM, logged not fixed (2026-08-28)

Found while fixing partial-day menu blackouts. Neither is caused by that change.

### 1. `localDate` is sent as ISO where FM requires DD.MM.YYYY

FM's `GET /public-api/mealPackages/{ref}/availablePickUp` takes `localDate` as a
Java `LocalDate` bound to **DD.MM.YYYY**. Verified live:

```
?localDate=2026-09-06   400  "Failed to convert value of type 'java.lang.String'
                              to required type 'java.time.LocalDate'"
?localDate=06.09.2026   200  [{"localTime":"10:00:00",...}, ...]
```

Three routes send ISO and therefore **always** 400:

- `app/api/order/times/route.ts`
- `app/api/fm-times/route.ts`
- `app/api/fm-dates/route.ts` (same shape, `availableDates`)

For Disco-NATIVE restaurants these are no-ops anyway — the native flow computes
availability from `disco_menus` via `lib/scheduling/cutoffs.ts` and never calls
them (see the note in `app/(customer)/restaurants/[slug]/shared.tsx`). For
**FM-backed** restaurants they are the date/time picker's data source, so that
picker is running on a dead endpoint.

Same class as the inert `repriceCart`/`checkMenuAvailability` above: a request
that has never once succeeded, hidden because the caller treats failure as empty
rather than as an error.

### 2. Slot granularity and the closing slot disagree

For the same Bird & Co. menu (window 10:00–19:00, no blackout, 2026-09-10):

| | slots | grid | first | last |
|---|---|---|---|---|
| FM   | 37 | 15 min | 10:00 | **19:00** |
| Disco | 18 | 30 min | 10:00 | **18:30** |

Two separate causes, both in `lib/scheduling/cutoffs.ts`:

- `SLOT_MINUTES = 30`, so Disco never offers FM's `:15`/`:45` times.
- `windowSlotMinutes` requires `m + SLOT_MINUTES <= to`, so a window ending 19:00
  stops at 18:30. FM treats `to` as an inclusive PICKUP TIME, not an exclusive
  bound, and offers 19:00.

Consequence: Disco's times are a strict subset of FM's, so a customer looking at
the two systems for the same restaurant sees different pickup times, and the
19:00 closing slot is unbookable on Disco for every restaurant whose window ends
on the half hour. Not a safety problem (Disco offers fewer slots, never more),
which is why it is logged rather than fixed here.

`scripts/verify-partial-blackouts.ts` excludes both from its parity diff by name
so the blackout parity result stays readable — remove those exclusions when this
is fixed and the diff should still come out clean.

---

## Migration candidate: two refund routes still duplicate the post-refund block (2026-08-29)

`lib/order/native-refund.ts` gained `refundNativeOrderAndRecord` when the cancel path
needed it — refund in Stripe, then status + `refund` total + audit event + courier
stand-down + customer notification, with the Stripe call FIRST so a failure writes
nothing. It was extracted specifically to avoid writing a THIRD copy.

Two copies remain, both on the money path:

- `app/api/admin/orders/[ref]/refund/route.ts`
- `app/api/restaurant/orders/[ref]/refund/route.ts`

They were deliberately NOT refactored at the time — they work, and rewriting live
refund code under time pressure is a worse risk than the duplication. That trade
expires the moment someone edits one of them.

**They have already drifted, and one difference is a real defect.** Diffed
2026-08-29:

1. **Stripe-refunded-but-Neon-write-failed is handled oppositely.** The admin route
   returns `ok: true` with a warning, and says why in a comment: *"The refund already
   moved in Stripe — never report it as a failure. Surface the record-update problem
   for manual reconciliation instead."* The restaurant route returns **500 "Unable to
   process refund"** in the same situation — telling a restaurant the refund failed
   when the customer's money has already gone back. The obvious next action is to
   retry, which is a **double refund**. The admin copy states the correct principle;
   the restaurant copy does not follow it.
2. **Different UPDATE scope.** Admin targets `reference = <resolved native ref>`;
   restaurant targets `reference = ${ref} OR fm_order_reference = ${ref}`, so it can
   stamp REFUND status onto an FM-mirrored row that FM actually owns.
3. **Different missing-row handling.** Restaurant 404s when the UPDATE matches
   nothing; admin silently no-ops.
4. **Stale comment.** The restaurant route's header says `order_status → REFUNDED`
   while the code writes `'REFUND'` — the spelling distinction the code comments
   elsewhere call out explicitly.
5. Cosmetic: differing event `source` ('ADMIN_REFUND' vs 'DISCO_REFUND', intentional
   and preserved by the helper's `source` parameter), and the restaurant route omits
   `stripeRefundId` from its response.

This estate has a documented history of exactly this failure mode — parallel
implementations that agree on the day they are written and diverge silently
afterwards. Prior instances in this runbook and the fix log: the delivery-fee
migrate-on-read wired into the write path but not either read path; `parseTier`
duplicated in `_MenuForm` and `backfill-delivery-fees`; the blackout editor existing
in `manage-v2` but not `menu-manager`; `menuRowToSettings` vs `computeOwnDeliveryFee`
disagreeing about the same JSONB. Each cost real money or real orders.

**When picked up:** migrate both routes onto `refundNativeOrderAndRecord`, keeping
the admin route's error semantics as the shared behaviour (never report a completed
Stripe refund as a failure) and passing `source` per caller. Confirm the FM-mirrored
UPDATE scope is genuinely wanted before carrying it over — it may itself be the bug.
Not urgent; do it the next time either file is opened, not as its own project.

---

## Multi-unit /locations pages: explicit Disco links, now the only option (2026-08-31)

REQUIRED, not eventual. The alternative — fixing the grouping in FM — died with FM's
maintenance. Nobody maintains FM's Java backend, so anything wrong inside it is
permanent. Recording the decision so the next person does not re-derive it.

### Where membership comes from today

`getLocationLink` (`lib/locations.ts`) has two paths:

1. **Explicit** — `getNativeLinkBySlug` → `disco_multi_unit_links` → `membersOf()` →
   `disco_multi_unit_link_members`. Takes precedence when a row exists.
2. **Fallback** — `GET {FM}/public-api/restaurants/group/{slug}`.

**`disco_multi_unit_links` held ZERO rows until 2026-09-02**, when `graciousbakery` was
seeded as the first one (see Tier 1 step 11). Every other slug — `atlantabread`,
`dechecos`, `eggstasy`, `hugosrestaurant`, `hugostacos`, `morningsqueeze`, `namkeen`,
`surftaco`, `tap42`, `twohands`, `almosthome`, `testgroup`, +1 — is still served
entirely by FM's group endpoint.

There is **no Disco-side inference** — no grouping by `business_name`, no grouping by
email domain. Checked `locations.ts`, `multi-unit-links.ts`, `location-links.ts`.
When a membership looks inferred, the inference is FM's, inside FM's Java.

Disco's own multi-unit-links UI branches the same way: native restaurants →
`createNativeLink` (Neon); FM-backed → proxy `{FM}/api/system-admin/restaurants/links`.
So for an FM-backed chain, the config writes to FM and the page reads from FM. Disco
is a pass-through on both sides and holds no membership of its own.

### The case that surfaced it

`/locations/eggstasy` lists Morning Squeeze (`8a7bb6f5-25fd-4672-b75c-e2912620116e`,
Tempe AZ) despite being unchecked. All seven locations are FM-backed, FM's group
endpoint returns Morning Squeeze directly, and Disco has no link row — so nothing in
this repo decided it. Raised with Revyrie rather than patched here, because a
Disco-side override would fork the source of truth for one tenant. (Same restaurant
as the FM charge-description defect logged the same day — We Begg To Differ Catering
LLC is the Stripe account behind both.)

FM's grouping CANNOT be corrected. It was raised as an FM issue; there is no longer
anyone to raise it with. Morning Squeeze will keep appearing on /locations/eggstasy
for as long as that page is served by FM's group endpoint.

### Why explicit links are now the only option

"Explicit beats inferred" is only TRUE in a state Disco is not in. Right now an
explicit exclusion cannot beat the fallback, because there is nothing explicit to
beat it with — and **deleting the fallback today would break all 13 pages**, since
none has a single explicit link.

Two things make this compulsory rather than desirable:

1. **The grouping errors are unfixable upstream.** Morning Squeeze is wrong today and
   will stay wrong. Every future grouping error FM makes is equally permanent.
2. **The fallback is a dependency on an unmaintained endpoint.** It works until it
   does not, and when `/public-api/restaurants/group/{slug}` stops answering, all 13
   `/locations/*` pages return null simultaneously with no degraded mode.

### What it involves

1. Seed `disco_multi_unit_links` + `_members` for all 13 slugs from FM's current
   grouping — one-time, scriptable, verifiable by diffing each page's rendered
   membership before and after.
2. Only then remove the FM fallback from `getLocationLink`.
3. Point the multi-unit-links UI at the Neon path for FM-backed restaurants too, or
   the config and the display diverge in the opposite direction from today.

**This is a data migration AND an owner-facing behaviour change**, not a refactor:
after it, editing a chain's locations in FM stops affecting the Disco page, and
restaurant owners who currently manage grouping in FM must be told where it moved.
Sequence it with the conversion programme, not ahead of it.

---

### Chain survey, 2026-09-02 — read this before seeding anything

Every converted chain, measured against FM's group endpoint and
`disco_restaurant_location_access`. **Nothing below was written except Gracious.** The
other four were deliberately left on the FM fallback pending decisions recorded here.

| Chain | FM group slug | Resolves | FM lists | Grant table | Banner |
|---|---|---|---|---|---|
| Gracious Bakery | `graciousbakery` | yes | 2 | Barbara: 2 — exact match | yes, **re-hosted** |
| Atlanta Bread | `atlantabread` | yes | 9 | **7 SAs hold 9, two hold 8** | yes |
| DeCheco's | `dechecos` | yes | 6 | 4 SAs hold 6 each — match | yes |
| Hugo's Tacos | `hugostacos` | yes | 2 | 2 SAs hold 2 each — match | **none** |
| Hugo's Restaurant | `hugosrestaurant` | yes | 2 | 1 SA holds 2 — match | **none** |
| Francesca Catering | — | **no slug resolves** | — | 2 converted | — |

**Five converted chains have no explicit link.** Only Gracious does.

**HUGO'S IS TWO CHAINS, NEVER ONE LINK.** `hugostacos` holds Tacos Atwater Village +
Tacos Studio City (SAs `atwater@` and `stucity@hugostacos.com`, title "Hugo's Tacos").
`hugosrestaurant` holds Hugo's Studio City + West Hollywood (SA
`contact@hugosrestaurant.com`, title "Hugo's Restaurant"). Different owners, different FM
groups, different titles. Anyone reading "Hugo's ×4" as one chain will merge two
unrelated businesses onto one public page.

**FRANCESCA CATERING IS NOT A CHAIN IN DISCO'S MODEL, and needs more than a slug.**
Twelve slug candidates probed, all 404, and no `disco_location_links` row — so there is no
slug, title, or banner to copy, and no existing public URL to preserve.

**Corrected 2026-09-02 while building the pre-flight check:** it also has **ZERO
`disco_restaurant_location_access` rows**, and both accounts (`sreina5@yahoo.com`,
`info@elmwoodparkpizza.com`) are **ADMIN, not SYSTEM_ADMIN**, each anchored to one
location. By the grant table these are two independent restaurants that share a brand
name, not a chain. So membership has nobody to come from: the rule is that a SYSTEM_ADMIN
checks boxes over their own locations, and Francesca has no SYSTEM_ADMIN at all.

Francesca therefore needs, in order: someone promoted to SYSTEM_ADMIN over both locations,
grants written, THEN a human-chosen slug. It is the furthest from ready of the five, not
the closest. The pre-flight reports it as `isChain: false` for this reason — correctly.

**ATLANTA BREAD'S GRANT TABLE DIVERGES — NEEDS BASIL, NOT A JUDGEMENT CALL.** FM lists 9.
Seven SYSTEM_ADMINs hold all 9. `anthie@thenccgroup.com` and `tara@thenccgroup.com` hold
**8**, both missing **Atlanta Bread – Alpharetta**.

`/locations/atlantabread` is one page with one membership, but the grant table gives two
different answers depending on which SA you ask — union 9, intersection 8, or the owner's
own grants depending on which of nine SAs owns the link. "Membership comes from the grant
table" does not resolve it here.

What makes it genuinely undecidable rather than merely fiddly: FM's authorized-users
endpoint over-reports the whole chain per location, and 84 excess grants were deliberately
left unrevoked. So the seven 9-grant SAs may themselves be carrying FM-derived
over-grants, and anthie/tara's 8 may be the CURATED number. FM agreeing at 9 is therefore
not corroboration — it is the same source counted twice. **Ask Basil whether Alpharetta
belongs on the page, and whether anthie/tara's missing grant is a separate gap to fix.**

DeCheco's and both Hugo's groups are unblocked — FM and the grant table agree exactly in
both directions. Neither Hugo's group has an FM banner, so those two pages lose nothing
by being seeded.

---

## Atlanta Bread – Alpharetta: Stripe imported 2026-09-02, ownership by ELIMINATION

`0532387f-e504-4d8e-8a21-217de5d39057` → `acct_1U5nbO3WZv4qhog5`.

**OWNERSHIP IS A REAL TIMESTAMPED TRACE — corrected 2026-09-02, having first been recorded
here as elimination-only.** The stronger evidence existed all along in `#stripe` and was
missed; see the FM-vs-Disco message note below for why it looked like noise.

```
2026-08-18 14:03:40 UTC   acct_1U5nbO3WZv4qhog5 created on the platform
2026-08-18 14:03:46 UTC   FM → #stripe: "New Stripe Connection
                           Restaurant Name: Atlanta Bread - Alpharetta"
```

Six seconds apart, and **the join is unique**: exactly ONE connected account was created on
2026-08-18 platform-wide, and none other within ±5 minutes. FM announced Alpharetta
connecting Stripe six seconds after that account came into existence, and nothing else was
created that day for it to refer to.

The account was separately confirmed to EXIST and be CHARGE-CAPABLE against the live key.
`transfers.list` returned **zero transfers**, so there is still no payment trace and no
`metadata.restaurantReference` — the usual proof remains unavailable, and the Slack
correlation is what replaces it.

The original elimination argument is kept, because it corroborates independently: the
account is assigned to no restaurant anywhere in Neon; it is distinct from all eight other
Atlanta Bread account ids, each already assigned; Alpharetta is the only Atlanta Bread
location without one; and its owner `arnav.anju@gmail.com` is a real Atlanta Bread
SYSTEM_ADMIN holding all nine. **Two independent lines now agree.**

### Resolving a connected account: what the evidence actually is (2026-09-02)

**`#stripe` CARRIES TWO DIFFERENT MESSAGE TYPES, AND THE USEFUL ONE LOOKS LIKE NOISE.**

| Source | Shape | Carries | Since |
|---|---|---|---|
| **FM's own webhook** | attachment, `New Stripe Connection` | restaurant NAME, **no account id** | ≥ 2026-06-30 |
| Disco's webhook | text, `💳 Stripe Connected` | name **and** `acct_…` | 2026-08-11 |

**FM's messages RENDER BLANK in a concise Slack read** — the content is in the attachment,
not the message text — so a quick scan of the channel shows a column of empty
`incoming-webhook:` lines and they read as noise. They are the ownership trail. Read
`#stripe` (`C05Q2JNP7V4`) with **`response_format: detailed`** or you will not see them.

**DISCO'S OWN PING CANNOT SERVE THIS PURPOSE, BY CONSTRUCTION.** `notifyStripeConnectedIfNewlyFullyConnected`
updates `WHERE stripe_account_id = <account>` and then:

```js
if (claimed.length === 0) return // no matching restaurant, or already notified
```

It only fires when **Neon already holds the mapping**. It announces mappings we have; it
can never reveal one we do not. Fleet-wide only **2 rows** have ever had
`stripe_connected_notified_at` set, and Alpharetta's is still NULL — no ping ever fired for
it and none could have. Do not reach for Disco's ping to identify an unknown account.

**`SLACK_STRIPE_CONNECTED_WEBHOOK_URL` IS configured in Vercel Production** (added
2026-08-12), so it is not silently skipping. Contrast `SLACK_NOTIFICATIONS_WEBHOOK_URL`,
which is absent from Vercel entirely — `alertOps()` really is console-only.

### The census — most accounts are NOT mapped, by an order of magnitude

Measured 2026-09-02 with `STRIPE_READONLY_KEY`:

| | |
|---|---|
| Connected accounts on the platform | **653** (640 `standard`, 13 `express`) |
| Charge-capable | 593 |
| **Assigned to a restaurant in Neon** | **42** |
| Unassigned | **611** — of which **554 charge-capable** |
| Assigned in Neon but absent from the platform | 0 |
| **Carrying a restaurant reference in metadata** | **0 of 653** |

**Anyone assuming most connected accounts map to a restaurant is wrong by an order of
magnitude.** 42 of 653. The 640 `standard` accounts are FM-era, onboarded through Stripe's
own flow, and Disco never touched them; the 13 `express` ones are Disco-created and carry
`{source: 'disco-become-a-partner'}` — and, as of 2026-09-02, `restaurantReference` too
(`createConnectAccount`, `lib/stripe-connect.ts`). That fixes nothing retroactively but
makes every FUTURE account self-identifying.

### The Slack join resolves ~20 accounts, NOT the fleet — do not over-budget it

Of the 554 unassigned charge-capable accounts:

- **401 were created before 2026-06** — earlier than any FM message in the channel.
  Effectively unreachable.
- **134 carry no creation date at all** (epoch 0). Nothing to join on.
- **~19 fall in 2026-06/07/08**, the window where FM messages demonstrably exist.

Ambiguity narrows it further: only **201 of 554** sit on a creation-day holding exactly one
account; **219 share a day with another**, where a day-level join is not unique and the
message timestamp has to land within seconds the way Alpharetta's did.

So the realistic yield is **on the order of 20 accounts**, and they are the RECENT ones —
which is the conversion population, so it is worth knowing about, but it is not a
fleet-wide fix.

**A LOOKUP TOOL WAS SCOPED AND DELIBERATELY NOT BUILT (2026-09-02).** Alpharetta was the
first conversion in nine Atlanta Bread locations to stall this way; one occurrence does not
justify the machinery, and the metadata line above prevents the next generation of the
problem outright. **The trigger to build it is a SECOND conversion stalling on an
unresolvable account.** Until then, do the join by hand — read `#stripe` detailed, find the
`New Stripe Connection` naming the restaurant, and match its timestamp against
`accounts.list` creation times, confirming no other account was created nearby.

### Why the 2026-08-19 conversion recorded "not connected"

Not a resolution bug. **Alpharetta had ZERO `disco_restaurant_accounts` rows** — no real
admin, not even a `stripe-import+` sentinel — so `storedAccountId(ref)` had nothing to
read, and `resolveStripeAccountFromHistory` found zero settled payments. Both paths empty.

The other eight resolved through `disco_restaurant_accounts.stripe_account_id`, NOT through
payment history — three of them have zero payments and still had ids. The discriminator is
the account row, and Alpharetta is the one location that never got one. **It has now
surfaced as a gap three separate ways**: no Stripe account row, no account row at all, and
missing from `anthie@`/`tara@`'s grants (see the chain survey). Anything Atlanta-Bread-wide
should check Alpharetta explicitly rather than assuming nine.

### is_live was never the gate — `visible` was

Recorded because the brief on this was wrong twice. Alpharetta was **already
`is_live = true`** and stayed true throughout; `is_live` is not the marketplace gate and
importing Stripe did not change it.

The native feed predicate (`lib/marketplace-restaurants.ts`) is a 3-part AND plus an
archive gate: `is_disco_native AND visible AND online_ordering_enabled AND
(stripe_connected OR a completed account row)`, with `archived_at IS NULL`.

| Field | Before import | After import | After visible flip |
|---|---|---|---|
| `is_live` | true | true | true |
| `visible` | false | false | **true** |
| `online_ordering_enabled` | true | true | true |
| `stripe_account_id` | null | `acct_1U5nbO3WZv4qhog5` | same |
| `stripe_onboarding_complete` | false | **true** | true |
| `stripe_connected` | false | **true** | true |
| **passes feed** | false | false | **true** |

`visible` is a **separate decision from the import** and needed its own flip (Peter's call,
2026-09-02). Confirmed after: the marketplace feed returns all nine Atlanta Bread
locations, and `/order/atlantabread-alpharetta` serves HTTP 200. If anyone reports a
converted restaurant "not showing", check `visible` before Stripe — three of 37 real
converted restaurants sit at `visible = false`, so it is not a universal default.

### Fleet sweep, same day

**No converted restaurant is sitting on an FM Stripe account Disco never imported.** The
only two non-test converted restaurants without a Stripe id are **Rendang Republic** and
**Tom Toms Italian**, and **neither is connected on FM yet** (confirmed with Peter) — so
there is nothing to import and this does not need re-investigating. Both are already
`is_live` and `visible`, so each would list the moment an account exists.

---

## FM's Stripe charge description is permanently wrong (2026-08-31)

Nobody maintains FM's Java backend, so this stands for as long as FM charges cards.
It is not a Disco defect and there is no Disco-side mitigation for FM-sourced
charges: FM builds the string and attaches it to its own PaymentIntent.

**What a restaurant sees on any FM-sourced charge.** Verified on
`pi_3UAa7QKp5OWEZLTA0bXrMOng` (We Begg To Differ Catering LLC, $262.98):

```
Receipt # 69032122; Total: 262.98 USD; Subtotal: 180 USD; Promo: 0 USD;
Service Charge: 0.00 USD; Fee: 5.40 USD; Tips: 0 USD;  Order Details:
Pickup date: 2026-09-02; Meal packages: 1. Fruit Cups  40 USD X1 ;
2. 10 Sets of Utensils 10 USD X2 ; ...
```

Four defects, all permanent:

1. **It accounts for $185.40 of $262.98.** Missing: third-party delivery fee $27.00,
   courier tip $36.00, state sales tax $14.58. FM's own order API returns all three
   and they reconcile exactly — `180.00 + 27.00 + 36.00 + 5.40 + 14.58 = 262.98`.
2. **"Tips: 0" against $36.00 actually collected.** It reads `tipsInPrice` (the
   restaurant tip, genuinely 0) and ignores `thirdPartyDeliveryTipsInPrice`.
3. **"Pickup date" on a delivery.** The order is `DLIVRD_DELIVERY` to Phoenix with a
   live courier booking.
4. **The itemization double-counts quantity.** It prints each line's TOTAL in the
   unit-price slot and then also prints the count: "10 Sets of Utensils 10 USD X2"
   where the real unit price is $5.00. A reader multiplying gets $20 and a $190
   subtotal against the correct $180. Every line with count > 1 is affected.

**Disco's own native description does reconcile** (`lib/order/charge-description.ts`,
verified by `scripts/verify-charge-description.ts`, which parses the money back out of
the emitted string and re-adds it). It is built from the same `computeBreakdown` terms
that compute the charge, so it cannot drift; it prints unit price beside `x{count}`;
it names delivery fee, courier tip and tax separately; and it returns null rather than
print a breakdown that does not sum, falling back to the plain one-line description.

So this is a concrete, restaurant-visible reason conversion matters: a converted
restaurant gets a charge description that adds up, and an unconverted one never will.
Worth saying to an owner who asks what they gain.

---

## Multi-unit grouping: seed explicit links PER CHAIN, at conversion (2026-08-31)

A `/locations/<slug>` page's membership comes from FM's grouping, with a Disco
`disco_multi_unit_links` table that overrides it when a link exists. FM's grouping
key is inside its Java and cannot be corrected there any more, and it is
demonstrably wrong in at least one place (Morning Squeeze appears on
`/locations/eggstasy` despite being unchecked). So explicit Disco links are the
only remaining way to get a correct page.

**Do this per chain, at conversion — not as one estate-wide migration.** A chain
being converted already has an owner conversation and a portal walkthrough; the
grouping change lands as part of "your Disco setup" instead of as an unexplained
change. Chains that never convert keep the FM fallback, which is exactly where
you want it kept longest.

### The conversion step

1. **Seed explicit links** for every location in the chain, from FM's current
   grouping.
2. **Review the membership against FM with the owner.** This is the part that is
   not mechanical: seeding from FM imports FM's errors, and the only detector is
   a person recognising a location that should not be there. Do not skip it, and
   do not try to derive the exclusions from data — they are not in the data.
3. **Only then does the FM fallback stop mattering for that chain.** Leave
   `getLocationLink`'s fallback in place for everyone else; it can be removed
   only once the last multi-unit chain has explicit links.
4. Note that `app/api/restaurant/multi-unit-links` branches on whether the
   RESTAURANT is native. Once a chain has Disco links while still FM-backed,
   that branch must key off whether the LINK exists, or the config UI writes to
   FM while the page reads Neon.

### RAISE THIS WITH THE OWNER — it is a real workflow change

- Editing grouping in FM will no longer affect the Disco page. Silently. An owner
  who removes a closed location in FM still sees it on Disco.
- Grouping becomes a two-system job for as long as they take FM orders too: FM
  for their FM storefront, Disco for their Disco page.
- New locations must be added in both places until the chain fully converts.

Whoever runs the conversation owns telling them where it moved. 13 slugs, each
with an owner.

---

## Two scheduling defects found while fixing the slot grid, logged not fixed (2026-08-31)

Both surfaced from the FM `availablePickUp` parity diff in
`scripts/verify-partial-blackouts.ts` and the six-restaurant sweep behind
commit `af682ea`. Neither is caused by that change; both predate it. Both fail
in the SAFE direction (Disco offers less than FM, never more), so no customer
can book a time the restaurant refuses — they just cannot book times the
restaurant does offer.

### 1. A midnight-wrapping window yields ZERO slots — the day is unbookable

`windowSlotMinutes` compares minutes-since-midnight, so a window of
`10:00:00 → 0:00:00` gives `from = 600`, `to = 0`, the loop never runs, and the
date has no bookable time at all. `buildAvailableDates` then greys the date out
entirely.

Real and live: **Razzis Pizzeria – Downtown** (`0f293250-…`) has windows
`10:00-23:00`, `10:00-0:00`, `11:00-23:00`, `11:00-0:00`. On 2026-09-04 FM
offered 56 slots and Disco offered 0; on 2026-09-05, FM 52 and Disco 0. Two
fully unbookable days a week on a live restaurant.

The fix is not just `to === 0 → 1440`: a window can legitimately cross midnight
(`22:00-02:00`), and slot times, the stored `order_time`, and the Ready By
offset all assume a single calendar day. Needs its own decision about what a
post-midnight pickup means for `order_date`, so it is logged rather than patched.
Scan for other affected restaurants before deciding scope — the estate-wide count
is not yet known.

### 2. Disco's lead-time floor is stricter than FM's on the first bookable day

Where FM opens the first available date at the window start, Disco opens it at
the exact lead-time offset, so Disco loses the morning of that one day.

- **Northside Inc. Cafe**, "Catering Menu", 2026-09-02: FM 37 slots from 09:00,
  Disco 21 from 13:00.
- **Northside Inc. Cafe**, "Box Lunch Menu", 2026-09-01: FM offers 17:45 and
  18:00, Disco offers none.
- **Razzis**, 2026-09-01: FM 30 slots, Disco 18.

FM appears to round `prepTime` to a whole day for some `scheduleType` values
rather than applying it as an exact hour offset. Confirm which, against
`scheduleType`/`prepTime` combinations, before changing `earliestPickup` —
loosening it wrongly would let a customer book inside the kitchen's real prep
window, which is the one failure direction this module must never have.

---

## Product decisions settled 2026-08-31 (Peter)

Seven rulings. They are recorded here because three of them describe behaviour
that does not exist yet, and because the fourth is the principle the rest hang
off. Where something is already built, the verification is named so nobody
re-litigates it.

### 1. Delivery method and fulfillment availability are per-MENU — confirmed intentional

A restaurant can run one menu on couriers and another self-delivered, and can
offer pickup on one menu and delivery on another. This is deliberate, not drift.
The checkout blocks mixing menus with DIFFERENT delivery methods in one cart
(`RestaurantClient.addItemWithConfig`); mixing menus that share a method is
allowed, which is why a cart can legitimately carry more than one
`menuReference`. Do not "fix" this by hoisting delivery settings to the
restaurant.

### 2. FM owns reminders for FM-sourced orders — customer AND restaurant-facing

**PARTIALLY BUILT.** `app/api/cron/order-reminders` has two passes:

- **PASS 1 (customer)** — already filtered: `AND o.source_of_order = 'DISCO'`
  (route.ts:159). Correct.
- **PASS 2 (restaurant/admin)** — has **no source filter**. Verified 2026-08-31:
  its WHERE clause gates on `admin_order_reminder_emails_enabled`,
  `admin_reminder_sent`, status, the 24h window and the placement skip — and
  nothing else. So Disco sends a restaurant reminder for FM-sourced orders that
  FM's Java has already reminded them about.

**To build:** the same `AND o.source_of_order = 'DISCO'` on PASS 2. One line,
same rationale as PASS 1. Until a converted restaurant takes its first native
order the practical impact is zero, which is why it has gone unnoticed.

### 3. Disco owns multi-unit grouping post-conversion

Membership is determined by a system admin ticking their own locations, not by
FM's grouping. See the per-chain conversion step above — seed explicit links,
review with the owner, and only then does the FM fallback stop mattering for
that chain.

### 4. FM is authoritative pre-conversion; Disco is authoritative post-conversion

**This is the principle the others sit on.** Until a restaurant converts, Disco
should MIRROR FM's behaviour rather than improve on it — a Disco customer must
not see a different answer from an FM customer for the same restaurant on the
same day.

Every scheduling fix this week is an instance of it, and all of them were Disco
misreading FM rather than FM being wrong:

- 15-minute slot grid, and the closing slot (`af682ea`)
- Midnight-closing windows (`fbf9fbf`)
- The daily cutoff as a placement deadline, and lead time on the restaurant's
  clock (`17a7e31`)

The corollary matters just as much: where Disco genuinely disagrees with FM and
FM is wrong, prefer matching FM anyway until conversion, and fix it properly on
the Disco side afterwards. Offering MORE than FM is the dangerous direction — it
lets a customer book something the restaurant cannot serve. That is why a
genuinely crossing pickup window (12:00→02:00) still yields nothing on Disco:
FM yields nothing for it too.

### 4a. `online_ordering_enabled` is a MIRROR before conversion (2026-09-01)

The first column found to violate §4 in the data rather than in the code, and
the reason both Gracious Bakery & Cafe locations reported not-ready with FM
saying they were fine.

`disco_restaurant_overrides.online_ordering_enabled` was added as "a Disco-side
mirror of FM's `onlineOrderingAllowed`" (`lib/db.ts`) and then nothing ever
mirrored it. The bulk import wrote `false` fleet-wide — note it wrote a *value*
rather than leaving the column's `DEFAULT true` unset, which is why the
false-dominance never looked anomalous — and after that the only writers were
humans clicking a toggle.

**The rule, stated plainly.** While a restaurant is FM-backed the flag has no
authority of its own: FM owns it and Disco mirrors it. The moment
`convertToNative` sets `is_disco_native = true`, Disco owns it permanently and
nothing may overwrite it from FM again. `is_disco_native` is the guard, and it is
the same flag every existing gate already branches on.

**Measured before the fix** (4,382 FM restaurants, 4,052 comparable):

| | count |
|---|---|
| agree | 3,727 |
| FM true, Neon false — the seed artifact | 296 (186 take real orders) |
| FM false, Neon true — the dangerous direction | 29 (none native, 11 take real orders, 4 blocked on FM) |

**Why correcting an FM-backed row is inert.** No FM-backed gate reads this
column. `lib/restaurant-orderable.ts` only suppresses ordering when
`isDiscoNative && onlineOrderingEnabled === false`, and
`lib/marketplace-restaurants.ts` applies a deliberate 2-part rule to FM-backed
rows for exactly this reason. So a flip in either direction changes nothing a
customer can see *today*. What it changes is conversion: `native-conversion.ts`'s
readiness gate reads `online_ordering_enabled !== false`, so a stale `false` is
what makes a healthy FM restaurant report not-ready.

**Shipped:** `lib/online-ordering-mirror.ts`, run by
`/api/cron/mirror-online-ordering` at `5,20,35,50 * * * *`. Verify or preview
with `npx tsx scripts/verify-online-ordering-mirror.ts` (add `--apply` to write).
Applied once over the fleet on 2026-09-01: 325 rows corrected, then 4,026/4,026
agreeing on the next pass.

**Two design constraints, both learned the hard way.**

1. It reads `disco_restaurant_admin_list_cache.raw`, not FM. That table already
   holds FM's raw admin-list JSON for all 4,382 restaurants and
   `refresh-restaurant-admin-list` rebuilds it every 15 minutes, so the mirror is
   a Neon-to-Neon `UPDATE`: no FM call, no auth, no timeout. The cron is offset
   past each quarter hour so it reads a freshly rebuilt cache instead of racing
   the refresh.
2. **It must NOT be folded into `sync-restaurants`.** That cron is daily, not
   every 15 minutes, and its upsert only writes `disco_restaurant_cache`. Worse,
   `lib/restaurant-cache.ts`'s `normalize()` drops every non-ACCEPTED or blocked
   row — and FM couples `blocked` to `onlineOrderingAllowed` bidirectionally, so a
   mirror living in that loop would fix the safe direction and silently skip the
   risky one. The raw cache is unfiltered, which is what makes it correct.

### 4b. Other columns with the same shape — and the one that must NOT be synced

`online_ordering_enabled` was found by accident, so the whole overlap between
`disco_restaurant_overrides` and FM's authoritative fields was swept.

| column | Neon | disagrees with FM | verdict |
|---|---|---|---|
| `money_flow` | DIRECT 4,321 / NULL 78 / FAMILY_MEAL 40 | **0** | Same shape, **already solved** by `lib/money-flow-reconcile.ts` + a daily cron. The precedent the mirror above copies, and the proof the pattern converges once someone builds the reconciler. |
| `nash_allowed` | `false` on all 4,439 | 777 | Same shape — but Nash is defunct (dlivrd is the courier). Dead weight. Record, don't sync. |
| `shipday_enabled` | `false` on all 4,439 | 9 | Same shape, small, no consumer. |
| `lead_gen_one_pct` / `lead_gen_two_pct` | `15.00` / `5.00` on 4,438 of 4,439 | **3,906 of 4,036** | **Looks identical and must NEVER be synced.** |

**The lead-gen row is a trap and is written down so the next sweep doesn't
"fix" it.** FM's real distribution is 15/3 on 3,729 restaurants and 0/0 on 394,
so Neon's fleet-wide 15/5 disagrees with FM almost everywhere — on a *fee*
column. It is nonetheless correct: per the Bird & Co. conversion (2026-08-26),
Disco's 15/5 is Disco's OWN rate structure and is deliberately never reconciled
to FM. A future audit will find 3,906 disagreements on a money column and
reasonably conclude it's broken. It isn't.

The general lesson: the surface signature "uniform value in Neon, varied value
in FM, nothing syncing it" identifies a *candidate*, not a bug. What separates
`online_ordering_enabled` from `lead_gen_*_pct` is whether the column is a mirror
of FM's decision or a statement of Disco's own.

### 4b-ii. A menu window ending ~30/60/90 days out is ROLLING, not an expiry

Confirmed with Peter 2026-09-01 after I mis-flagged it on Tenkatori Sawtelle.

FM's `scheduleOption` reports `startDate` / `endDate` alongside
`rollingAvailability`. When the gap between them equals the rolling value, the
window is **the rolling setting working correctly** — a standard cap on how far
ahead a customer may book, computed from today — **not** an end date to extend.

Tenkatori's Catering Menu read `2026-09-01 → 2026-11-30` with
`rollingAvailability: 90`, and 2026-09-01 + 90 days is exactly 2026-11-30. I
reported it as a menu about to expire; it was not. Do the arithmetic before
raising it.

Two things that distinguish a REAL date-bounded menu from a rolling one:
- A real one has a **short, fixed** span unrelated to the rolling number — e.g.
  Tenkatori's "Super Bowl Menu " is `2026-02-08 → 2026-02-08` with
  `rollingAvailability: 30`: one day, in the past, a genuine one-off event.
- A real one usually carries `cutOffType: 'BY_DATE'` with a `cutOffDate`, as that
  Super Bowl menu does (`12:00` on `2026-02-07`).

The faithful importer already models this correctly: it writes
`rolling_availability_days` and leaves `start_date`/`end_date` NULL, so nothing
downstream treats the rolling horizon as a hard stop.

### 4c. Grants at conversion — the INTERIM RULE (Peter, 2026-09-01)

**Why an interim.** FM's authorized-users endpoint OVER-REPORTS: it returns the
whole CHAIN's authorized users for every location, not that location's. Proven —
for Atlanta Bread Alpharetta it returned 7 users, all SYSTEM_ADMIN, and **zero of
the 7** are assigned to Alpharetta in FM's own `tbl_system_admin_restaurants`.
Reading it as membership is what produced 84 excess grant rows across 16 people
(52% of the grant table). FM's real membership lives in the `fm_backup` snapshot
(schema `familymeal`), which is **frozen at 2026-06-16**, and no live endpoint
exposes it. Revyrie is gone, so there is no near-term live source.

**THE RULE.** At conversion:

1. **Invite from the endpoint** — it is still the right candidate list, and the
   role reconciliation in `inviteFmAuthorizedUsersFor` (which mirrors FM's
   per-user `role` in both directions) stays.
2. **Grant only the restaurant being converted** — never a sibling, never the
   chain. `inviteFmAuthorizedUsersFor` already does exactly this
   (`grantLocationAccess(email, ref, 'fm-authorized-users-sync')`), and that is
   correct: converting 5 locations calls it 5 times and the grants accumulate
   one per conversion.
3. **Grant only to people FM names as that restaurant's ADMIN or designated
   admin.** This is the new constraint — it is what stops the chain-wide list
   from becoming chain-wide grants.
4. **Hold SYSTEM_ADMIN grants for explicit assignment.** A super admin or an
   existing SYSTEM_ADMIN assigns locations they themselves hold. That is the
   stated architecture anyway (see CLAUDE.md, "Who can see which restaurants").

**Never revoke existing grants to make them match FM.** Post-conversion Disco
owns them; a grant may be a deliberate later change. The 84 excess rows are
deliberately left alone.

### 4d. Who assigns SYSTEM_ADMIN locations, and where — BOTH SCREENS EXIST

Verified working 2026-09-01. The interim does NOT create a manual step with no
tool.

**Super admin (us) — `/admin/manage-admins`**, "System Admins" in the admin nav.
Open a system admin → location picker (filterable, sourced from
`/api/admin/restaurant-cache/list`) → add/remove. The list itself is an FM proxy
(`/api/admin/users/system-admin`, 364 people, server-side search over name,
email and restaurant name), but the location editor is Neon-backed:
`GET/POST/DELETE /api/admin/system-admins/{email}/locations`. The home location
cannot be removed. **20 of the 21 existing Neon SYSTEM_ADMINs are findable
there**; the one exception is `andrew+2@discocater.com`, our own test account.

**An existing SYSTEM_ADMIN — `/restaurant/manage/authorized-users`**, in the
portal nav. (The standalone `/restaurant/team` route still exists but is
deliberately hidden from the nav — the page moved.) Add or edit a user → role
(System Admin / Restaurant User) → location multi-select → invite email. The
server enforces the rule: `resolveDiscoAccessScope` + `discoRefAllowed` reject
anything outside the inviter's own set with "You can only assign locations you
have access to", and an ADMIN can only ever mint an ADMIN, trimmed to one
location.

**THE ONE GAP, and the way around it.** A SYSTEM_ADMIN can only manage users
**they created**: `/api/restaurant/team` lists `WHERE created_by = ctx.email`,
and the edit route guards with `assertOwnedSubAdmin`. `inviteFmAuthorizedUsersFor`
does not set `created_by`, so **all 21 existing SYSTEM_ADMIN accounts have
`created_by = NULL`** and are invisible to every peer's Authorized Users page.
Only a super admin can assign their locations.

**So do this for a chain, in this order — it is far less work than it looks:**

1. Convert the locations. Each SYSTEM_ADMIN ends up with an account anchored to
   whichever location converted FIRST (the `ON CONFLICT (email) DO UPDATE` does
   not move `restaurant_reference`) and no grants. They see that one location,
   because `resolveDiscoAccessScope` falls back to the anchor when there are no
   grant rows.
2. **Pick ONE lead SYSTEM_ADMIN for the chain** and, as super admin, give them
   the full set on `/admin/manage-admins`. For a 5-location chain that is 4
   clicks.
3. **Let the lead assign everyone else** from Authorized Users. Re-adding an
   existing peer by the same email works: the POST's
   `ON CONFLICT (email) DO UPDATE SET role, created_by = ${ctx.email}` adopts
   them, which both grants the selected locations and makes them editable from
   then on.

For Atlanta Bread's shape (7 system admins × 8 locations) that is ~8 super-admin
clicks instead of ~50. Doing step 2 for every person instead of one lead is the
expensive path — avoid it.

**Check before relying on step 3:** that POST also issues a fresh set-password
invite. The account's `password_hash` is untouched so an existing login should
keep working, but this has NOT been verified against someone who has already
signed in. Confirm it on a test account before using it on a real operator.

### 5. Cancellations and refunds need customer emails

**NOT BUILT.** Mirror FM's templates, without the FM name. Today the restaurant
sees the cancellation and the amber "the customer has still been charged" notice
in the portal, and the refund reaches Stripe — but the CUSTOMER is told nothing
by Disco. Note that cancel is deliberately status-only and does not refund, so
the two emails are separate events and must not be collapsed into one.

### 6. Blackouts are additive, and they COMPOUND — already works, nothing to build

Whole-day closures at the LOCATION level (Settings → Closed Days / Closed
Holidays, `disco_restaurant_closed_days`) and finer windows per MENU
(`disco_menus.skipped_days`, with `intervals` for partial days) stack. Neither
overrides the other; a date closed by either is closed.

Verified end-to-end 2026-08-31, both layers:

- **Picker** — `shared.tsx` concatenates the menu's `skipped_days` with the
  location's closed-day rows into one `skippedDays` array, so
  `buildAvailableDates`/`buildAvailableTimes` see both. Entries WITHOUT
  `intervals` block the whole date (`skippedDateSet`); entries WITH them block
  only those hours (`skippedIntervalsFor`, inclusive at both ends).
- **Server** — `native-place-checkout` runs them as two separate gates:
  `isNativeDateClosed` (location, whole-day, 403) at line 64 and
  `isNativeDateTimeValid` (menu, incl. partial intervals, 400) at line 85. Both
  must pass.

Confirmed against real data: Francesca Catering – Elmwood Park's "vacation"
closure returns `isNativeDateClosed = true` on dates where the MENU alone is
perfectly bookable, and Bird & Co's 2026-09-05 partial blackout refuses 15:00 and
16:30 while allowing 12:00 and 17:00.

One latent caveat, logged not fixed: `isNativeDateClosed` wraps its query in
`.catch(() => [])`, so a query failure would silently turn the location-level
gate into a no-op. The cast is correct today (`disco_restaurant_closed_days
.restaurant_reference` is uuid, unlike the cache's, which is TEXT), so nothing is
broken — but the swallow is the same shape as several defects on this page.

### 7. Item images are the restaurant's choice — no placeholder

An item without an image renders without one. Do not add a generic placeholder.
The importer carries FM's images where they exist (1,154 backfilled, `d14019f` +
`09b053d`); an item with none simply has none, and that is the restaurant's call.

---

## A third lead-time divergence: the DAILY cutoff rolls the day forward, FM doesn't (2026-08-31)

Found by `scripts/verify-lead-time.ts` after the clock crossed a restaurant's
cutoff — it passed at 17:55 restaurant-local and failed at 19:30 against a 19:00
cutoff. PRE-EXISTING, not a regression from `17a7e31`: that commit removed the
cutoff-as-pickup-FLOOR, and this is the separate roll-the-day block above it,
which was never touched.

**Pelons Tex Mex** (America/Chicago, prepTime 6h, DAILY cutoff 19:00, window
10:30–21:30), 2026-09-01: FM offers **45** slots, Disco offers **0**.

`earliestPickup` pushes `earliestDay` forward a whole day whenever the current
time-of-day is past the cutoff. With a 6-hour prep time at 19:30, `now + 6h` is
01:30 the next morning — already before that day's window even opens — so the
lead time is satisfied for the whole of the next day and the extra day costs a
full day of bookings.

Isolated directly:

```
earliestPickup(19:30 Chicago, lead 6h, cutoff 19:00) = Wed Sep 02 00:00
earliestPickup(19:30 Chicago, lead 6h, no cutoff)    = Tue Sep 01 01:30
Disco 2026-09-01 slots WITH cutoff    :  0
Disco 2026-09-01 slots WITHOUT cutoff : 45   <- exactly FM's answer
```

FM's DAILY cutoff appears to mean **"no more SAME-DAY orders after this time"**,
not "push every date out by one." Disco reads it as the latter.

NOT FIXED HERE, deliberately — it is the third distinct semantic in this one
function and it deserves its own confirmation against FM across
`scheduleType`/`prepTime` combinations before being changed. Note the roll may be
largely redundant: `leadAbsolute` already enforces prep time independently, so
removing the roll would still refuse anything inside the kitchen's real window.
Confirm that before touching it — loosening this wrongly is the one failure
direction this module must never have.

`verify-lead-time.ts` is left FAILING on this rather than carrying an exclusion.
A suite that names a real open defect is doing its job; the previous granularity
carve-out is exactly how the 15-vs-30 gap survived three months.

---

## `earliestPickup` — the whole function's behaviour, written down (2026-08-31)

Three distinct semantics have now been found in this one function, two fixed and
one open. Writing the whole thing down rather than patching the third the way the
first two were patched.

Evidence: `scripts/audit-daily-cutoff-semantics.ts` (read-only), run against
every DAILY-cutoff menu in the estate — **46 menus, 42 with a bookable day inside
5 days**.

### The three inputs

| Input | FM field | Status |
|---|---|---|
| Lead time | `scheduleOption.prepTime` (total hours) | Fixed — now evaluated on the restaurant's clock (`17a7e31`) |
| Daily cutoff | `scheduleOption.cutOff` + `cutOffType='DAILY'` | Floor **fixed** (`17a7e31`); **roll still open** |
| Hard cutoff | `scheduleOption.cutOffDate` | No known divergence |

### Semantic 1 — lead time (SETTLED)

`now + prepTime`, evaluated in the RESTAURANT's timezone, not the runtime's.
Before `17a7e31` the same instant gave 17 / 29 / 1 slots under Eastern / Pacific /
UTC for the same Pacific restaurant, and Vercel runs UTC, so the placement gate
and the customer's picker could disagree.

### Semantic 2 — the cutoff as a FLOOR ON PICKUP TIME (SETTLED, was wrong)

`floor = max(floor, cutoff)` made "order by 1pm" mean "you may not collect before
1pm". 37 of 38 menus lost the morning of their first bookable day, median 8
hours. Removed in `17a7e31`. FM does not do this.

### Semantic 3 — the cutoff as a ROLL OF THE DAY (SETTLED, was wrong)

**THE RULE, as settled by Peter and now shipped:**

```
earliest = max(now + prepTime, pastCutoff ? startOfTomorrow : now)
```

The daily cutoff only affects SAME-DAY ordering. Past it, no more orders for
today; prep time does everything else. A 15:45 cutoff with no prep means the
earliest slot is tomorrow; with 48h prep the cutoff is irrelevant, because 48
hours out is already past today either way.

It fits **10 of the 11 discriminating cases** (the old roll fit 1) and the
remaining one is FM being wrong — see below. Everything from here down is the
evidence that got there.

### The old behaviour and how it was scored

`if (now's time-of-day > cutoff) earliestDay += 1 day`.

**Scored against FM across the estate.** A "match" is cheap when the two
hypotheses agree, so only the 11 cases where they DISAGREE say anything:

```
H0  roll the day (as shipped)   first-day 31/42   slot-count 32/42
H1  no roll                     first-day 40/42   slot-count 42/42
H2  blocks TODAY only           first-day 40/42   slot-count 42/42

DISCRIMINATING CASES (H0 != H1): 11
   FM agrees with H0 (roll):     1
   FM agrees with H1 (no roll): 10
   FM agrees with neither:       0
```

And the split that actually explains it:

```
prepTime % 24 == 0 :  roll right 1, roll wrong  0
prepTime % 24 != 0 :  roll right 0, roll wrong 10
```

**Working reading: FM applies the cutoff to the DAYS component of the lead time.**
When `prepTime` is a whole number of days (24h, 48h) the cutoff rolls the day;
when it carries an hours remainder (6h, 12h, 36h) FM uses the absolute offset and
the cutoff does not move the date. That fits all 11 discriminating cases with no
exceptions. It matches how FM's own UI presents lead time — days AND hours —
rather than as a single hour count.

**H1 and H2 cannot be told apart from this data.** They score identically in every
breakdown, because the discriminating case (past the cutoff, lead time short
enough that TODAY is still bookable) does not occur anywhere in the estate right
now. Do not pick between them on this evidence.

### Is removing the roll safe? NO — not on its own

`leadAbsolute` does enforce prep time independently, so removing the roll cannot
let anyone book inside the kitchen's real prep window. But it can still put Disco
AHEAD of FM, which is the direction that produces a booking hole:

```
H1 (no roll) would offer a day FM refuses:  2 cases
   OBAO                 prep 24h  cut 19:00   H1 2026-09-01 vs FM 2026-09-02
   The Winkin' Rooster  prep 48h  cut 15:45   H1 2026-09-03 vs FM 2026-09-04
```

Both are whole-day prep times — exactly the cases the working reading says SHOULD
roll. So the fix is not "delete the roll"; it is "roll only when `prepTime % 24 === 0`".

### A booking hole that already exists in shipped code

Found while checking the above, and worth its own line because it is the
dangerous direction and it is live TODAY:

```
The Winkin' Rooster (America/Chicago, prep 48h, cutoff 15:45), 2026-09-03:
   FM  0 slots        Disco  31 slots     ← Disco offers all 31; FM refuses every one
```

Neither H0 nor H1 explains it — both over-offer — so a fourth thing is going on
for whole-day prep times past the cutoff. Settle this before changing the roll:
whatever rule explains Winkin' Rooster probably explains OBAO too.

### What it costs today

`scripts/audit-daily-cutoff-semantics.ts`, slots lost on FM's first bookable day
under the shipped behaviour:

```
10 menus across 10 restaurants (8 live) lose slots
total: 410 slots

  -47  Yella's                      SAME_DAY  prep 12h  cut 12:00
  -45  Pelons Tex Mex               CUSTOM    prep  6h  cut 19:00
  -44  DeCheco's Pizzeria x6        SAME_DAY  prep 12h  cut 21:00
  -31  Slate Cafe                   CUSTOM    prep 12h  cut 17:00
  -23  Apollo Bagels - FiDi         SAME_DAY  prep 36h  cut 15:00
```

Every one loses its ENTIRE first bookable day — H0 offers 0 where FM offers all
of them. All six DeCheco's locations are affected, which is a whole chain.

### Recommendation

One change, not two: gate the roll on `prepTime % 24 === 0`. That fits 11 of 11
discriminating cases, recovers all 410 slots, and keeps the two whole-day cases
where FM does roll. Do NOT ship it until the Winkin' Rooster hole is explained —
it is the same population and a rule that leaves a booking hole standing is worse
than one that loses slots.

`scripts/verify-lead-time.ts` is deliberately LEFT FAILING on the Pelons case
until this is settled. A suite that names an open defect is doing its job; the
granularity carve-out is how the 15-vs-30 gap survived three months.

### Semantic 3 — RESOLVED (2026-08-31, shipped)

Peter's rule, tested as H3 against all 46 DAILY-cutoff menus:

```
                               first-day   slot-count
H0  roll the day (old)           31/42       32/42
H1  no roll                      40/42       42/42
H3  cutoff blocks TODAY only     40/42       42/42

DISCRIMINATING CASES (the rules actually disagree): 11
   FM agrees with H0:  1
   FM agrees with H1: 10
   FM agrees with H3: 10
```

**H3 vs H1 differ in ZERO cases in the current estate.** The same-day block only
bites when `now + prepTime` still lands today, and no live DAILY-cutoff menu has
a prep time short enough for that right now. They are empirically
indistinguishable today, so H3 was chosen because it is the correct RULE, not
because the data separated them — and a self-test (`4c`) pins the discriminating
case so a future short-prep restaurant can't quietly break it.

That also settles what the ~407 "lost" slots were: since H3 == H1 everywhere,
none of them were same-day orders Disco was right to refuse. They were real
losses, and they are recovered.

**The two disagreements with FM are FM over-rolling.** Verified against each
restaurant's real window rather than inferred:

| | prep | cutoff | window | FM | Disco (H3) |
|---|---|---|---|---|---|
| OBAO | 24h | 19:00 | 12:00–22:30 daily | 0 slots on 09-01 | **4 slots, 21:45–22:30** |
| The Winkin' Rooster | 48h | 15:45 | Mon–Fri 10:00–17:30 | 0 slots on 09-03 | **31 slots, 10:00–17:30** |

Ordering at 21:45, OBAO's 24-hour lead lands at 21:45 tomorrow — inside a window
open until 22:30. Those four slots are genuinely 24 hours out and FM refuses
them. Winkin' Rooster's 48-hour lead clears Thursday entirely; FM opens on
Friday. **Neither is a booking hole** — `leadAbsolute` still enforces the
kitchen's real prep window independently, so nothing can be offered inside it.

This is the standing rule in action: Disco is authoritative post-conversion, so
where FM is wrong Disco is correct rather than diverging. The earlier note
calling Winkin' Rooster "a booking hole in shipped code" was WRONG and is
retracted — Disco was right and FM was refusing bookable slots.

**What shipping it changed** — 11 menus, 11 restaurants (8 live), each of which
had been losing its ENTIRE first bookable day:

```
Yella's                  prep 12h cut 12:00   09-02 -> 09-01    0 -> 46 slots
Pelons Tex Mex           prep  6h cut 19:00   09-02 -> 09-01    0 -> 45   LIVE
DeCheco's Pizzeria x6    prep 12h cut 21:00   09-02 -> 09-01    0 -> 44   LIVE
Slate Cafe               prep 12h cut 17:00   09-02 -> 09-01    0 -> 30   LIVE
Apollo Bagels - FiDi     prep 36h cut 15:00   09-03 -> 09-02    0 -> 22
OBAO                     prep 24h cut 19:00   09-02 -> 09-01    +4 slots on 09-01
```

`scripts/verify-lead-time.ts` passes again. `scripts/audit-daily-cutoff-semantics.ts`
is kept as the regression tool — re-run it after any change to `earliestPickup`.
