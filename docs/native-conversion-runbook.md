# Native Conversion Runbook

How an FM-backed restaurant actually becomes Disco-native, as proven by four real
conversions: **Francesca Catering – Glen Rock**, **Francesca Catering – Elmwood
Park**, **Pelican Delicatessen**, and **Briscola Trattoria**. This is a
description of what happened, sourced from git history and live database
records — not a design document. Where the evidence contradicts the "this is
solved" framing, that's called out rather than smoothed over (see the Admin
Access section — it's the one step that did NOT reliably work for any of these
four).

## 0. The tools involved

- `checkConversionReadiness(ref)` / `convertToNative(ref)` — `lib/native-conversion.ts`
- `runPreflightCheck(ref)` — `lib/conversion-preflight.ts` (a second, more granular
  read-only checker, built after real friction converting Francesca Catering's
  two locations; catches partial menu imports and duplicate FM records that
  `checkConversionReadiness` doesn't)
- `importFmMenuFaithfully(ref)` — `lib/menu-import/fm-faithful-import.ts`
- `importRestaurantStripeAccount(ref, accountId)` — `lib/native-conversion.ts`
- `grantLocationAccess(email, ref, grantedBy)` — `lib/disco-restaurant-auth.ts`

---

## 1. Confirm the FM restaurant reference and status

Before anything else: the FM `restaurant_reference` is ACCEPTED, live, and not
a duplicate record.

- **ACCEPTED**: FM's `tbl_restaurants.status` column. Confirmed `ACCEPTED` for
  all 6 DeCheco's locations, Glen Rock, and Elmwood Park in the June 17
  fm_backup snapshot. This is a real, checkable field — verify it before
  starting.
- **Not a duplicate**: `runPreflightCheck`'s `duplicateRecords` check compares
  normalized addresses against every other `disco_restaurant_cache` row.
  This is a real, live problem — Glen Rock has a decoy
  *"Francesca Catering - Glen Rock - NEW"* record (not native, not live), and
  Pelican has two decoy *"Location 2"* / *"Location 3"* records. None of the
  decoys are the one that actually converted; converting the wrong duplicate
  is the exact failure mode this check exists for.
- One caveat found while pulling this evidence: fm_backup is a **point-in-time
  snapshot (June 17)**, not live. Pelican Delicatessen's native
  `restaurant_reference` resolves in that snapshot to an FM record labeled
  "Test Bakery" — almost certainly a pre-rename business name FM itself later
  updated after the snapshot was taken, not a reference collision. Briscola's
  reference isn't in the snapshot at all (onboarded to FM after June 17).
  Treat fm_backup as directional for anything recent; the live FM admin
  lookup (`GET /api/admin/restaurants/{ref}`, service auth) is authoritative.

---

## 2. Stripe: reused, never re-onboarded

**The single most misleading part of the tooling.** `checkConversionReadiness`
reports `stripeMode: "not-linked"` for a restaurant with a perfectly good,
live, reusable Stripe account. That wording means **"nobody has imported the
account ID yet,"** not "this restaurant needs to onboard to Stripe." The
distinction matters because the fix is a single backend call, not a
merchant-facing KYC flow.

How it actually works, per the code (`lib/stripe-connect.ts`,
`lib/native-conversion.ts`, commit `2b661fe`):

1. **Peter supplies the `acct_...` id**, read directly from the Stripe
   Dashboard → Connected accounts (or, if FM's own `tbl_stripe_connected_accounts`
   table has it recorded against the restaurant's exact reference, that's an
   acceptable source too — that's how Glen Rock's `acct_1LT2GVAiQrFq77Fo`,
   Elmwood Park's `acct_1LYZBtLPlGXXB6ha`, Briscola's `acct_1TqkQoBdEVwh2uSq`,
   and Pelican's `acct_1TvGqL34v0I6NXRL` all got imported). **Never fuzzy-match
   an account by restaurant name** — always resolve by the restaurant's own
   reference or ask for the id directly. Business names collide across
   locations and franchises in a way account ids don't.
2. `verifyAccountReusable(accountId)` does a **live** Stripe API call and
   checks `charges_enabled === true && capabilities.transfers === 'active'`.
   `2b661fe`'s own commit note is explicit that this per-account live check is
   load-bearing: a live audit found only 635 connected accounts total, 576 of
   them reuse-eligible — nowhere near the ~4,000 `money_flow=DIRECT` restaurants
   the money-flow field alone would suggest. DIRECT does not imply reusable;
   each account has to be checked.
3. **Standing rule: ignore "future requirements due."** `requirementsDue` on
   the reusability check can be non-zero (Stripe asking for something like an
   updated business representative by a future date) without blocking
   reuse — `reusable` only cares about `charges_enabled` and `transfers`
   being active right now.
4. `importRestaurantStripeAccount(ref, accountId)` then writes
   `disco_restaurant_accounts.stripe_account_id` +
   `stripe_onboarding_complete = true`, and sets
   `disco_restaurant_overrides.stripe_connected = true`. Bulk entry point:
   `POST /api/admin/stripe-accounts/import`.

**A second, separate `stripe_connected` writer that will mislead you if you
don't know about it:** `app/api/admin/sync-stripe-status/route.ts` runs
regularly and sets the same `disco_restaurant_overrides.stripe_connected`
column, but it's checking something different — whether FM's *own*
Stripe-Connect status is live (`HEAD /api/stripe/{ref}` → 204). It has nothing
to do with native reuse-eligibility. This is why DeCheco's 6 locations all
show `stripe_connected: true` (checked as recently as `2026-08-10` for
Firestone Park) with **zero rows in `disco_restaurant_accounts`** — that flag
is FM's payment-processing status, not evidence that anyone has imported a
Stripe account for native use. Don't read it as readiness.

---

## 3. Tax rate

If `disco_restaurant_overrides.tax_rates.stateSalesTax.percent` is null,
native checkout charges **$0 tax** on every order. Set it before conversion.

- FM often has no tax field to mirror at all — this isn't always a Disco gap.
  Direct query of FM's own `tbl_restaurants.tax_rates` (fm_backup) for
  DeCheco's 6 locations shows `stateSalesTax.percent: null` **in FM's own
  data**, not just inaccessible to us. There is nothing to import for these
  six; a real percentage has to be entered.
- **0% can be legitimate.** Pelican Delicatessen has
  `stateSalesTax.percent: 0` (and `localSalesTax`/`otherSalesTax` also
  explicitly `0`, not null) — a real, deliberate rate. This is why the
  readiness check has to distinguish "0" (passes) from "null" (fails) rather
  than treating any falsy value as missing. (This distinction was a real bug
  in `checkConversionReadiness` — see the code-history note at the bottom.)
- Glen Rock (NJ, 6.625%) and Elmwood Park (NJ, 6.625%) both carry real state
  rates. Briscola (NY/NYC, 8.875% state, null local) is the same shape —
  state set, local not populated, and that's fine because the check only
  gates on `stateSalesTax.percent`.
- For a Disco-native restaurant, `GET/PUT /api/restaurant/tax-rate` never
  calls FM at all — it reads/writes `disco_restaurant_overrides.tax_rates`
  in Neon directly. There is no FM mirror-on-save path for tax the way there
  is for notifications; it has to be entered once, directly, in the native
  portal or by an admin action.

---

## 4. Menu: faithful FM import

`importFmMenuFaithfully(fmRef, {targetRef?})` (`lib/menu-import/fm-faithful-import.ts`),
triggered via `POST /api/admin/restaurants/{ref}/import-fm-menu` — one call
per restaurant. This is **not** the AI-PDF menu importer (`writeDiscoNativeMenu`);
that one drops modifier prices and settings. This one pulls FM's real menu
structure, modifier prices/rules, service charge, tips, delivery config, order
minimums, and lead time, and writes it faithfully into `disco_menus` /
`disco_menu_items` / `disco_modifier_groups`.

**Correction to "zero heuristic filtering":** the *primary* placement pass is
exact and heuristic-free — it walks FM's public per-menu endpoint
(`GET /public-api/restaurants/{ref}/mealPackages?menuReference={menu}`), which
returns each menu's real categories and items directly, no guessing. But FM
has no usable item→menu link in its flat catalog for items belonging to an
**Inactive/hidden** menu (the public endpoint never surfaces those), so a
*supplementary* pass exists for exactly that case, using — in order — an exact
schedule-window match, a category name learned from window-matched siblings,
normalized name overlap, and a narrow party-size-tier regex, with "first
visible menu" as the last resort so nothing is silently dropped
(`unplacedFallbackCount` tracks how often that happens).

What *is* true without qualification, and matches your framing exactly: **a
genuinely shared item is duplicated into every menu it belongs to, never
arbitrarily assigned to one.** This is deliberate (`duplicatedAcrossMenus` in
the summary) — confirmed real, not hypothetical, via twin party-size tiers
sharing an identical season window in production FM data. The importer
never picks a winner between two menus that legitimately share an item.

Also faithfully imported in the same pass, fill-blank-only (never overwrites
an existing value): `announcement` and `delivery_order_time_windows` (via the
public `feesAndTips` endpoint — deliberately not the session-scoped one, which
has no by-reference variant a service account could use), and `icon_url` /
`image_url` (via `GET /api/admin/restaurants/{ref}`, only written when
currently null).

**Not imported, by design, no available endpoint:** notification recipients
(FM's `/api/notifications` is session-scoped with no admin/by-ref mirror — see
§7). `maxOrder` is deliberately left null — FM's cap is per-15-minute-window,
Disco's is per-day, and the two aren't convertible; it's a manual decision.

---

## 5. `convertToNative` — never `goLiveNativeRestaurant`

The actual flip. `convertToNative(ref)`:

- Refuses if `checkConversionReadiness` isn't fully green.
- Runs a gated, one-time FM order-history backfill first (aborts the whole
  conversion if FM is unreachable — this preserves lead-gen fee-tier history,
  since a restaurant's fee tier depends on prior paid-order count).
- Sets `disco_restaurant_cache.is_disco_native = true` **and**
  `is_live = true` in the same call (as of commit `50cd61c`, 2026-07-29 — no
  separate go-live step is needed for this path). `goLiveNativeRestaurant` is
  a different function with different gates (a real live-mode $1 charge, a
  real signed Expedite dispatch test) — it's for restaurants that started
  native from zero, not for a conversion. Using it here would be redundant at
  best and gate on things a conversion doesn't need.
- It's a **one-way flag flip on our side**, and FM is untouched by it. FM
  keeps serving the restaurant exactly as before — same admin login, same
  order flow, same everything — until whoever manages DNS/routing/marketing
  stops sending customers to the FM URL. Nothing about this call locks FM
  out or breaks it. Cooperation, not lockout.

---

## 6. `ensureRestaurantLoginInvited` fires automatically — but check it actually landed

On conversion, this reads FM's real admin email off `admin.email` (never the
Stripe-import sentinel), creates a `disco_restaurant_accounts` row with
`role: 'ADMIN'`, and sends a password-set invite. It was added in commit
`3bc6507` (2026-08-06) — **restaurants converted before that commit (Pelican,
Glen Rock, Elmwood Park) never got one automatically** and needed it run
retroactively.

**This is the one step in the whole proven flow that did not actually work for
any of the four reference restaurants, and it's still broken right now for
three of them.** Live query of `disco_restaurant_accounts` today:

| Restaurant | Account created | Invite pending? | Invite expired? |
|---|---|---|---|
| Glen Rock | 2026-08-06 (retroactive) | yes, still unconsumed | **yes** — expired 2026-08-11 16:57 UTC |
| Briscola | 2026-08-07 (retroactive) | yes, still unconsumed | **yes** — expired 2026-08-10 16:33 UTC |
| Elmwood Park | 2026-08-06 (retroactive) | yes, still unconsumed | **yes** — expired 2026-08-13 19:57 UTC (~1hr before this was checked) |
| Pelican | 2026-07-23 (original, pre-`3bc6507`) | no invite ever generated | n/a — account exists only via the Stripe-import sentinel path, email is `chef@familymeal.com`, not a real recipient |

None of the three retroactive invites were ever accepted
(`acceptInvite()` nulls `invite_token` on success — all three still have a
live, non-null token, just an expired one). The reason: their invites were
generated in the exact window `middleware.ts` was redirecting
`/restaurant/accept-invite` straight to `/restaurant/login` before the token
could ever be validated (see §8, commit `42e78e5`). That bug was fixed
2026-08-11 ~16:04 UTC. Glen Rock's token expired ~53 minutes *after* the fix
shipped, so it's not certain it was ever actually usable in practice (deploy
propagation, etc.); Briscola's expired entirely *before* the fix; Elmwood
Park's window mostly postdates the fix but has also now lapsed. **Practically:
treat all three as not logged in yet.** Fresh invites need to be re-sent for
Glen Rock, Briscola, and Elmwood Park, and Pelican needs a real invite
generated for the first time (its current sentinel account isn't usable by
anyone real).

---

## 7. Notification settings

Carry-over is attempted (`carryOverNotificationSettings`) against FM's
`GET /api/notifications`, but that endpoint is **session-scoped** — a service
account gets HTTP 500 "Access is denied" regardless of the `restaurantReference`
param, and there's no admin/by-ref equivalent anywhere in FM
(`/api/admin/notifications` and `/api/admin/restaurants/{ref}/notifications`
both 404). Every attempted carry-over fails and sets
`notification_settings_flagged_at`, for manual entry.

**Check Neon before assuming a restaurant's notification recipients are
missing.** A direct query today shows 778 of 4,432 `disco_restaurant_overrides`
rows already have `notification_emails` populated, with 755 of those
written in a single batch on 2026-08-06 — consistent with a bulk backfill
pulled from the June 17 fm_backup snapshot (the same snapshot the
`migrate-fm-to-neon.ts` Stripe-status migration used, commit `4323945`), not
from the per-restaurant carry-over path. Glen Rock and Elmwood Park's real
recipient emails (`sreina5@yahoo.com,Jeff@franpizzanj.com` /
`sreina5@yahoo.com,info@elmwoodparkpizza.com`) are already in this
population — don't re-flag or re-request these from the restaurant.

Separately, `app/api/restaurant/notifications/route.ts` mirrors on every
*save* the restaurant makes through their own FM-token session (not a service
account) — that's how a restaurant actively using the portal keeps this
current going forward, once they have a working login (see §6).

Pelican's `notification_emails` is `chef@familymeal.com` — a generic FM
placeholder, not flagged (`notification_settings_flagged_at: null`) because
Pelican converted before the flagging column existed. Commit `1e0b29f` added
a second, independently-derived admin warning ("native + no
non-@familymeal.com recipient") specifically so cases like this don't hide
behind a clean-looking null flag.

---

## 8. Closed days / holidays

Two completely different mechanisms exist; only one of them is proven to
work.

- **Automated carry-over at conversion** (`carryOverClosedDays`) hits the same
  session-scoped wall: FM's `GET /api/closedDays` returns HTTP 200 with an
  **empty array** for a service account — confirmed against Glen Rock
  specifically, independently known (via screenshots) to have 5 real holidays
  plus a custom vacation range. The empty array is the wall, not "this
  restaurant has none." Every attempted carry-over (Briscola, Elmwood Park +
  3 others) failed and set `closed_days_flagged_at`. It never destructively
  deletes existing rows on failure — the delete-then-reinsert only runs after
  a confirmed non-empty fetch.
- **The self-service native "Closed Days" page** (`POST /api/restaurant/disco-closed-days`)
  writes straight to `disco_restaurant_closed_days` in Neon, with no FM call
  at all. Toggling one holiday pre-computes that date for the next 50 years in
  one insert. **This is how Glen Rock actually has 251 real rows today** — 5
  holidays × 50 years = 250, plus 1 custom range = 251, entered directly
  through this page (Glen Rock converted before the automated carry-over
  existed, so nothing was ever attempted or flagged for it — the rows are
  self-service, not carried over).

Practical read: closed days aren't reliably carried over from FM by any
automated path today, but re-entering them post-conversion is a few seconds
per holiday through a page that already exists, not a data-recovery problem.

Promo codes follow the identical wall (`GET /api/coupon` → HTTP 500 "Access
is denied" for a service account, confirmed for Glen Rock — which
independently has a real code, FRAN10) — `carryOverPromoCodes` flags via
`promo_codes_flagged_at` on failure. One open discrepancy found while pulling
this evidence and not explained: commit `d8ad889` lists Briscola among the 5
restaurants retroactively flagged for promo codes, but Briscola's
`promo_codes_flagged_at` is currently null, and so is Elmwood Park's (which
wasn't in that commit's list at all). Not resolved here — noting it rather
than guessing.

---

## 9. Post-conversion verification

Before telling a restaurant it's live, confirm:

- Live and visible on the marketplace (`evaluateMarketplaceReadiness` /
  `disco_restaurant_cache.is_live` + `.visible` = true, and the native 3-part
  rule — visible AND online-ordering-on AND a real Stripe signal — actually
  passes; see the marketplace-visibility caveat below).
- The menu renders on the customer-facing page, including modifier prices.
- The **max order/inventory field** shows up in the native menu manager for
  the imported menu (it will be blank/null post-import by design — §4 — but
  the field itself should be present and settable, not missing).
- FM is untouched: the restaurant's FM admin login and FM-side order flow
  still work exactly as before (§5 — this should never need active
  verification-as-a-fix, only a sanity check that nothing broke).

One caveat worth carrying into this check: `disco_restaurant_overrides.stripe_connected`
is not a valid post-conversion payout signal on its own (§2) — every
converted restaurant inherits `stripe_connected = true` from the historical
2026-06-17 migration regardless of whether a native account has actually been
imported. The marketplace rule ORs it with `hasCompletedNativeStripeAccount`,
so today it happens to not misfire for any real, visible restaurant — but it
will as more restaurants convert with a stale inherited `true` and no
imported account yet. Flagged in code (`lib/marketplace-visibility.ts`), not
fixed — that's a separate decision.

---

## Admin access for multi-location brands

**FM's own SYSTEM_ADMIN structure is authoritative — mirror it, don't invent a
Disco-side grant plan.** `GET /api/admin/users/system-admin` (paged, no working
server-side filter — see the search-bug note below) returns every FM system
admin with a `role` (`SYSTEM_ADMIN` or `ADMIN`) and a `managedRestaurants[]`
list of every location they cover. This is the real, complete structure —
checked, not assumed, after an earlier turn in this thread wrongly concluded
DeCheco's only had two single-location admins (Nathan, Cory) based on a search
box that was silently filtering the wrong thing (see below). Live data showed
**four** FM SYSTEM_ADMINs — Dominic LaGuardia, Nathan DeCheco, Cory O'Connor,
and Tyron User — each already covering all 6 DeCheco's locations in FM.

Two gaps this exposed, both now fixed:

1. **`ensureRestaurantLoginInvited` only ever reads the single per-restaurant
   `admin` field**, never FM's separate system-admin list. A brand can have
   system admins covering a restaurant that never appears in that one field at
   all — confirmed real: Tyron covered all 6 DeCheco's locations in FM but was
   never invited by anything, because he was never any single location's
   `admin.email`. Fixed by `inviteFmSystemAdminsFor(ref, restaurantName)`
   (`lib/native-conversion.ts`), called from `convertToNative` alongside (not
   instead of) the existing per-restaurant invite — same best-effort,
   never-blocks-the-conversion contract as every other carry-over step. For
   each FM SYSTEM_ADMIN whose `managedRestaurants` includes the converting
   restaurant: invite them if they have no Disco account yet (skip silently if
   they already do — most will, from a sibling location's conversion or the
   per-restaurant admin invite), and mirror FM's **full** `managedRestaurants`
   set into `disco_restaurant_location_access` for them — not just the one
   restaurant currently converting, so a multi-location brand's grants match
   FM immediately rather than trickling in location-by-location as each one
   happens to convert.
2. **Grants should mirror FM, never be assigned by hand.** A super admin
   manually granting `grantLocationAccess` — even with good intentions — can
   silently disagree with FM the moment FM's own structure differs from what's
   assumed (exactly what happened here: Nathan and Cory were manually granted
   all 6 on the belief they were single-location, when FM already had them at
   all 6). `grantLocationAccess` itself does no FM cross-check — it's a plain
   `INSERT INTO disco_restaurant_location_access (account_email,
   restaurant_reference, granted_by) ... ON CONFLICT (account_email,
   restaurant_reference) DO NOTHING` with no validation against anything. The
   fix is procedural, not code: **don't hand-grant locations — verify FM's
   mirrored system-admin scope came through** (via
   `inviteFmSystemAdminsFor`/conversion, or `POST /api/admin/system-admins/
   {email}/locations` if a location needs syncing after the fact), and if FM
   disagrees with an assumption, FM wins.

Confirmed from the table's own migration (`lib/migrations/001_disco_orders.sql`):
`account_email` is a plain `TEXT` column with **no foreign key** to
`disco_restaurant_accounts` — only a `UNIQUE(account_email, restaurant_reference)`
constraint, so a grant can be pre-created for an email before that person has
ever logged in or has any account row at all. This is exactly how
`inviteFmSystemAdminsFor` pre-seeds a brand's *other*, not-yet-converted
locations into the same person's grants the moment any one of their
locations converts.

**Why this was initially misread**: the super admin System Admins page's
search box filtered client-side, over whatever 25-row page of FM's 363 total
system admins happened to already be loaded — typing "decheco" found only
whichever DeCheco's admin(s) landed on page 1 (Dominic), making it look like
Nathan and Cory didn't exist as system admins at all. FM's own
`/api/admin/users/system-admin` endpoint has no working server-side filter
either (confirmed empirically — `search`, `query`, `name`, `email`, `q`,
`searchName`, and several other likely param names were all tried live; none
changed the 363-record result). Fixed in `app/api/admin/system-admins/route.ts`
by fetching FM's full list once (it returns all 363 in a single page at
`size=2000`) and filtering server-side across name, email, and
`managedRestaurants[].businessName` — the fix lives in the route, not in FM.

---

## Bugs fixed along the way (don't reintroduce)

- **`checkConversionReadiness` tax false-positive** (fixed this session,
  uncommitted in `lib/native-conversion.ts`): the old check was
  `!!ov[0]?.tax_rates` — truthy on *any* tax_rates JSON blob, including one
  where every percent is null. Now checks
  `typeof tax_rates.stateSalesTax.percent === 'number'` specifically, and the
  step is blocking (was advisory). Pelican's legitimate `0%` still passes;
  DeCheco's null now correctly fails.
- **Commit `42e78e5` (2026-08-11), two invite bugs:**
  1. `middleware.ts`'s restaurant-portal auth gate only exempted
     `/restaurant/login` — every invite/reset link points at
     `/restaurant/accept-invite`, by definition visited by someone with no
     session, so the gate redirected them to login (silently appending the
     token to the query string) before the page's own validation ever ran.
     This is the direct cause of §6's still-live problem — the fix landed
     too late to save Glen Rock's and Briscola's already-issued tokens.
  2. The restaurant login page's "Forgot password?" link pointed at
     `/reset-password` (a customer-facing FM temp-password page with nothing
     to actually trigger for a restaurant admin). Added
     `/restaurant/forgot-password`, wired to the real, working
     `/api/auth/forgot-password` backend.
- **`d5bb300`** (2026-07-26): a stale FM-ref read could make an
  *already-native* restaurant show as eligible to convert again — named
  "Test 50, Test 34" by the commit as the restaurants that exposed it.
  `resolveNativeRef` now guards against this.

---

## Applying this to DeCheco's (6 locations)

Live query, today, against all 6 (`Cuyahoga Falls`, `Fairlawn`,
`Firestone Park`, `Hudson`, `Munroe Falls`, `Springfield / Ellet`):

| Check | Result | Whose |
|---|---|---|
| FM status | ACCEPTED, all 6 | — (already true) |
| Stripe account | Real `acct_...` id exists for each (FM's own `tbl_stripe_connected_accounts`, matched by reference — not fuzzy-matched); live-verified **reusable (`charges_enabled` + `transfers: active`) for all 6** | **Ours** — one `importRestaurantStripeAccount` call per location, no restaurant action needed |
| Tax rate | Null in FM's own data for all 6 (confirmed, not just inaccessible) | **DeCheco's** — a real conversation, not a data fix; genuinely nothing to import |
| Native menu | 0 items in Neon, all 6 | **Ours** — one `import-fm-menu` call per location, real FM menus exist to pull from |
| Admin accounts | **Zero rows** in `disco_restaurant_accounts` for any of the 6 at the time of this check | **Ours**, automatic — `ensureRestaurantLoginInvited` + `inviteFmSystemAdminsFor` both fire the moment each location converts |
| System-admin scope | FM already has **four** SYSTEM_ADMINs — Dominic, Nathan, Cory, Tyron — each covering all 6 (checked live via `/api/admin/users/system-admin`, not assumed from the per-restaurant admin field) | **FM's, mirror it** — `inviteFmSystemAdminsFor` grants each of them all 6 automatically on conversion; no manual `grantLocationAccess` calls needed or wanted |

**Update, post-conversion:** all 6 locations have since actually been converted.
`ensureRestaurantLoginInvited` invited Nathan (Cuyahoga Falls), Cory (Firestone
Park), and Dominic (Fairlawn) via the per-restaurant admin field, exactly as
predicted; Tyron was missed by that path (never any single location's admin
field) and had to be backfilled once `inviteFmSystemAdminsFor` existed —
exactly the gap it now closes automatically for the next brand. A fleet-wide
audit after the fix found only one other FM SYSTEM_ADMIN covering a native
restaurant with no Disco account — an internal test fixture on Pelican
Delicatessen (`chef+1@familymeal.com`, "Peter Remy Test"), not a real person.

**Your expectation — that this reduces to Stripe account ids plus tax rates,
with the menu handled by the FM import — is correct for 5 of 6 pieces, with
one addition:** the Stripe id lookup is already done and verified (not an
open task), the menu import is a real, ready path (not a build), and there's
a real, per-location tax conversation still needed with DeCheco's ownership.
The one thing your framing doesn't cover is admin access — because DeCheco's
currently has **no native account rows at all**, not because of a
multi-location grant problem specifically. That resolves itself automatically
per location the moment each one converts (no separate ask), but given §6's
finding that this exact step silently failed for 3 of the 4 restaurants it's
supposedly already proven on, it's worth actively confirming — not assuming —
that Nathan's and Cory's invites land and get accepted this time, rather than
declaring DeCheco's done the moment the flag flips.

Ordered, concretely:

1. **Ours:** run `importRestaurantStripeAccount` for each of the 6 known
   account ids.
2. **DeCheco's:** provide real state/local tax percentages per location.
3. **Ours:** run `importFmMenuFaithfully` (via `POST /api/admin/restaurants/{ref}/import-fm-menu`)
   for each of the 6.
4. **Ours:** once 1–3 are green for a location, run `convertToNative` for it.
   `ensureRestaurantLoginInvited` fires automatically, but **verify the
   invite is actually usable and gets accepted** (§6 — don't assume it did).
5. **Ours:** pre-create (or, once each admin has logged in, grant)
   `grantLocationAccess` for Nathan and Cory across all 6.
