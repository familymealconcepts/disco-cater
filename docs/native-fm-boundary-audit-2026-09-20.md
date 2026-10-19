# Disco-native ↔ FamilyMeal boundary audit

**Date:** 2026-09-20 · **Scope:** read-only investigation, nothing changed
**Trigger:** the 2026-09-19/20 FamilyMeal production outage
**Rule under test:** *a Disco-native restaurant must never call, read from, or write to FamilyMeal.*

Every figure below was measured against production — Neon and FM's live Postgres
(`10.108.0.6`, database `fm`) — or read out of FM's Java source. Where something is
inferred rather than measured, it says so.

---

## 0. Executive summary

| Question | Answer |
|---|---|
| Did Disco write **settings** into FM after conversion? | **No.** No FM settings row for any of the 214 native restaurants was modified by the Disco service account. |
| Did Disco write **orders** into FM after conversion? | **Yes — 19 writes**, across 8 restaurants, 2026-09-10 → 2026-09-18. |
| Did that corrupt anything? | **No.** All 19 targeted FM-originated orders (`source_of_order = FAMILYMEAL`), where FM legitimately holds the record. Neon and FM agree on all 19. |
| Are the 133 empty FM tenant schemas data loss? | **No.** They are an abandoned 2021 multitenancy design. Not related to conversions. |
| Is the boundary actually enforced? | **No.** It holds by luck and by low native-order volume, not by construction. |

The headline is uncomfortable rather than catastrophic: **the architecture rule is
violated constantly, but has not yet produced data corruption** — because native
restaurants have so far taken only 138 native-origin orders, and because the writes
that did land went to orders FM owned anyway. The exposure grows with every native
order placed.

---

## 1. What diverged

### 1.1 Settings — no Disco writes found

I compared all **214** native restaurants field-by-field between
`disco_restaurant_overrides` and FM's `tbl_restaurants` / `tbl_notification_settings`.

| Field | Divergent | Verdict |
|---|---|---|
| `money_flow` | 0 | agree |
| reminder flags | 0 | agree |
| lead gen | 4 | **expected** — Disco's own rate structure |
| online ordering | 10 | FM stale |
| tax rates | 8 | FM stale / conversion decisions |
| notification emails | 10 | FM stale |

**Critically, `modified_by` on every divergent FM row is a restaurant staff member or a
Disco team member — never the service account.** Combined with §3's finding that the
service account *did* touch orders, the absence here is meaningful: the settings routes
did not fire for these restaurants.

Per the standing rule, a post-conversion difference is a **decision, not drift**. These
are listed as evidence that Neon moved on and FM did not — which is correct behaviour.

**Online ordering — Neon disabled, FM still enabled (7 restaurants):**

| Restaurant | Neon | FM | FM last modified |
|---|---|---|---|
| Two Hands - Austin | false | **true** | 2026-06-17 by naz@twohandshospitality.com |
| Two Hands - Dallas | false | **true** | 2026-06-17 |
| Two Hands - Denver | false | **true** | 2026-06-17 |
| Two Hands - Franklin | false | **true** | 2026-06-17 |
| Two Hands - Nashville | false | **true** | 2026-09-07 |
| Two Hands - Tribeca | false | **true** | 2026-09-07 |
| Two Hands - Williamsburg | false | **true** | 2026-09-07 |

And the reverse — Neon enabled, FM disabled: **EggBred - Bakersfield**, **EggBred - Seal
Beach**, **Katz's Delicatessen**.

Neon is authoritative here (the FM→Neon mirror shipped 2026-09-01, 49c0a1c), so these are
FM being stale. The risk is not data loss but **operator confusion**: FM's admin screens
still show Two Hands as taking online orders.

**Tax rates — real value differences:**

| Restaurant | Neon (state/local/other) | FM | FM last modified by |
|---|---|---|---|
| Briscola Trattoria | 8.875 / – / – | **4 / 4.5 / 0.375** | peter@familymeal.com, 2026-08-06 |
| Concierge Test | 6.625 / 0 / 0 | null / null / null | concierge@discocater.com |
| DeCheco's Pizzeria — all 6 locations | 0 / 0 / 0 | null / null / null | cory@dechecos.com, kealoha@familymeal.com |

Briscola is the one worth a human look: FM holds New York's component breakdown
(4% state + 4.5% city + 0.375% MCTD = 8.875%), Neon holds the combined 8.875% in
`stateSalesTax`. **Same effective rate, different decomposition** — correct totals, but
any per-component reporting will disagree. The DeCheco's rows are the known
"0% is real, null is unconfigured" case: Neon's explicit zeros are right.

**Notification emails — Neon is a superset (10 restaurants).** Every Apollo Bagels
location has its per-location address in Neon but not in FM, e.g.

- Apollo Bagels - Kips Bay — Neon `416third@apollobagels.com, taylor@apollobagels.com`;
  FM only `taylor@apollobagels.com`
- Apollo Bagels - Midtown — Neon adds `224w35@apollobagels.com`
- Hugo's Studio City — FM has an extra address Neon dropped: `fangery@hugosrestaurant.com`

Hugo's is the only case where **FM holds an address Neon does not**. If notification
routing ever falls back to FM, that person gets mail; if it does not, they have silently
stopped receiving it. Worth confirming with the restaurant.

### 1.2 Twenty-six native restaurants have no FM record at all

Of 214 native restaurants, **26 have no row in FM's `tbl_restaurants`** for their Neon
reference. Most are tests (`Test 26`–`Test 50`, `Repro Test Restaurant` ×3) or `(Copy)`
duplicates, but several are real: **Blasteran, Cena Vegan, Love & Plates, Rendang
Republic, Aztec Dave's Cantina, Tom Toms Italian, Lee's Chinese Food, Crimson Coward -
Frisco, Almost Home**.

**These are not missing — they are double-registered under two different references.**
Blasteran is `353bd8de-7371-4120-a116-d75607e934a8` in Neon, but FM has a *Blasteran*
at `b6f57a13-3efb-46b2-9cf6-9ccf332c36ac` with a `Menu (1)` created by
`peter@familymeal.com`. The same pattern holds for Cena Vegan, Love & Plates and the
others: onboarding created an FM restaurant, and Neon stored a different reference.

Consequence: any FM lookup by the Neon reference **404s**. For these restaurants the
ungated routes fail closed, which is why they show no divergence — the boundary is
being enforced by accident, by a reference mismatch.

---

## 2. Which system is authoritative — intended vs actual

Read from the route source. **Bold = violation for a native restaurant.**

| Area | Truth should live in | Portal reads | Portal writes | Verdict |
|---|---|---|---|---|
| Tax rates | Neon `overrides.tax_rates` | Neon | Neon | ✅ correct |
| Notifications | Neon `overrides.notification_*` | Neon (both branches) | Neon **+ FM `/api/notifications`** | ⚠️ dual-write |
| Online ordering | Neon `overrides.online_ordering_enabled` | Neon | Neon **+ FM `/api/restaurants/onlineOrdering`** | ⚠️ dual-write |
| **Fees & tips** | Neon | **FM `/api/feesAndTips`** | **FM only** | ❌ **no Neon storage at all** |
| **Business info** | Neon | **FM `/api/businessInfo`** | **FM only** | ❌ **no Neon storage at all** |
| **Scheduling** | Neon | **FM `/api/scheduling?menu=`** | **FM only** | ❌ **no Neon storage at all** |
| **Authorized users** | Neon `disco_restaurant_accounts` | **FM `/api/system-admin/users`** | **FM only** | ❌ **no Neon storage at all** |
| Account profile | Neon | FM `/api/profile` | FM `/api/users` + partial Neon | ❌ mostly FM |
| Menus | Neon `disco_menus` | guard refuses… | …**unless Disco-native session** | ❌ guard has a hole |
| Order status | Neon `disco_orders` | Neon | Neon **+ unconditional FM PUT** | ❌ ungated |
| Orders list | Neon | Neon | *(fixed 2026-09-20, 666fedd)* | ✅ now gated |

**The four ❌ "no Neon storage at all" rows are the most serious finding in this report.**
Fees & tips, business info, scheduling and authorized users have **no Neon columns**.
For a native restaurant these screens are not merely reading the wrong system — there
is nowhere else for the data to live. A native restaurant editing its delivery fee or
its pickup schedule today is writing that value **into FamilyMeal and nowhere else**,
and Disco's own checkout does not read it back from there.

This is not a gate that is missing. It is a **feature that was never ported**, and
adding a gate would break those screens rather than fix them.

---

## 3. The order write paths — measured, not inferred

### What FM's POST actually does (read from source)

`MenuAdminController.java:37` → `menuService.createMenuByAdmin(...)` →
`MenuServiceImpl.createMenu(...)` → `menuRepository.save(menu)`, returning
`201 CREATED`. It is a **real persisted write**, and it also calls `changePositions(...)`,
reordering the restaurant's existing menus. Not a no-op.

### What actually happened

**19 FM orders were modified by `peter@familymeal.com` (the Disco service account)
between 2026-09-10 and 2026-09-18**, across 8 native restaurants. 18 set `COMPLETED`,
1 set `CANCELED`.

| Restaurant | Order # | Written to FM | When (UTC) |
|---|---|---|---|
| Supernatural | 83836785, 87947436, 60016688 | COMPLETED | 2026-09-10 18:32:47–54 |
| Apollo Bagels - East Village | 75916643 | COMPLETED | 2026-09-11 15:19:52 |
| Apollo Bagels - Tribeca | 12342738 | COMPLETED | 2026-09-11 15:19:56 |
| Apollo Bagels - Williamsburg | 62717814 | COMPLETED | 2026-09-13 18:55:14 |
| Brooklyn Dumpling Shop - UES | 69719484 | COMPLETED | 2026-09-13 19:03:56 |
| Bird & Co. | 44002764 | COMPLETED | 2026-09-14 01:43:16 |
| Gracious Bakery & Cafe - Garden District | 15513325, 41109933, 85189140, 15924731, 75174250, 71059337, 95807513, 80285521 | COMPLETED | 2026-09-15 12:53:45–12:54:30 |
| Apollo Bagels - Kips Bay | 75685839 | COMPLETED | 2026-09-16 18:40:04 |
| Bird & Co. | 30317237 | COMPLETED | 2026-09-17 14:34:36 |
| Apollo Bagels - Kips Bay | 94273846 | **CANCELED** | 2026-09-18 17:13:03 |

The Gracious Bakery cluster — eight orders in 45 seconds — is a bulk "Mark All Complete".

### Did it cause divergence? No.

I compared all 19 against `disco_orders` on `(restaurant_reference, order_number)`:

- **19/19 statuses agree** between Neon and FM.
- **19/19 are `source_of_order = FAMILYMEAL`** with `fm_order_reference` set.

Every one was an **FM-originated order mirrored into Neon**. FM is their system of
record, so propagating the status back is defensible — arguably correct.

**No Disco-native order (`fm_order_reference IS NULL`) was written to FM.** There are
**138** such orders across all native restaurants, and none appear in FM. They cannot:
FM has no row to update, so the PUT 404s and the `try/catch` swallows it.

### So what is the actual risk?

The routes are ungated, so the *only* thing preventing corruption is that native orders
don't exist in FM to be corrupted. Today that is 138 orders against 3,043 FM-mirrored
ones. The failure mode appears the moment a native order shares an order number with an
FM order at the same restaurant — the composite key `(restaurant_reference,
order_number)` is unique in Neon, but FM numbers and Disco numbers are allocated
independently. **A collision would write a native order's status onto an unrelated FM
order.** I found no collision today; nothing prevents one.

**Note on attribution.** `FM_ADMIN_EMAIL` is `peter@familymeal.com` — Peter's own
account. Writes by the Disco service account and writes by Peter in FM's UI are
indistinguishable in `modified_by`. I attribute these 19 to Disco because of the
sub-second bulk timing and because they match Disco's "Mark All Complete" shape, not
because the audit column proves it. **Giving the service account its own FM identity
would make this unambiguous and is worth doing.**

---

## 4. Blast radius

- **214** Disco-native restaurants; **163 live**.
- **3,181** orders at native restaurants: **138 native-origin**, **3,043 FM-mirrored**.
- **8** restaurants had FM orders written by the service account.
- **206 of 214** have a portal account and can hold a Disco-native session — the
  condition that bypasses the menus guard.

**Ranked by exposure** (30-day order volume):

| # | Restaurant | Live | Orders | Native | 30d | Portal accts |
|---|---|---|---|---|---|---|
| 1 | Apollo Bagels - Kips Bay | Y | 127 | 14 | 68 | 2 |
| 2 | Supernatural | Y | 140 | 4 | 36 | 5 |
| 3 | Apollo Bagels - Hoboken | Y | 70 | 3 | 27 | 2 |
| 4 | Apollo Bagels - Williamsburg | Y | 33 | 4 | 19 | 2 |
| 5 | DeCheco's Pizzeria - Fairlawn | Y | 30 | 9 | 14 | 2 |
| 6 | Gracious Bakery - Garden District | Y | 17 | 5 | 12 | 1 |
| 7 | **Bird & Co.** | Y | 346 | 8 | 11 | 1 |
| 8 | Atlanta Bread - Smyrna | Y | 42 | 8 | 10 | 2 |
| 9 | Apollo Bagels - Industry City | Y | 14 | 1 | 10 | 2 |
| 10 | Apollo Bagels - Tribeca | Y | 9 | 8 | 9 | 2 |
| 11 | Francesca Catering - Glen Rock | Y | 385 | 7 | 7 | 1 |
| 12 | Almost Home – Lincroft | Y | 713 | 0 | 4 | 1 |

Apollo Bagels is the highest-exposure group — 9 locations, high volume, actively used.
Bird & Co. is the one that triggered the outage.

---

## 5. The 133 empty tenant schemas — not data loss

**Verdict: an abandoned 2021 multitenancy design. Expected. Unrelated to conversions.**

Evidence:

| Schema shape | Count | Restaurant id range |
|---|---|---|
| Full 19 tables | 60 | **4 – 77** |
| Partial | 2 | 15, 34 |
| Only `flyway_schema_history_restaurant` | **131** | **79 – 283** |

The boundary is clean at id 77/79 — a deliberate cutover, not scattered failures.

- A *complete* tenant schema (`6_52fa9d25…`) has all 19 tables and **zero rows** in
  `tbl_orders`. Its migrations all ran **2021-03-31**, once, and never again.
- Real orders live in the **main** schema: `familymeal.tbl_restaurant_orders` holds
  **25,304** rows spanning **2021-03-30 → 2026-09-18**.
- Across all 62 tenant schemas that still have a `tbl_orders`, there are **608 rows
  total** — 2021-era residue. Thirteen schemas hold them, the largest being
  `47_8966f05b…` (Almost Home – Lincroft, 188 rows) and `53_cc716341…` (115).

So FM creates and baselines a schema per restaurant, then never populates it. Bird & Co.
is id **150**, inside the 79–283 band, so its bare schema is **exactly what every
restaurant onboarded since ~2021 looks like** — not a failure, and nothing to do with it
being native.

**What the missing tables would have held:** per-restaurant orders, customers, payments,
delivery addresses, DoorDash records, sale transactions. All of that now lives in the
main schema.

**Does it correlate with native conversions?** No. The split is chronological by
restaurant id, and native restaurants appear on both sides.

**One caveat worth flagging:** those 608 legacy rows are invisible to every current code
path, since FM reads the main schema. If anything ever reported from tenant schemas,
it would see a near-empty world.

---

## 6. Other defects of the same shape

### 6.1 Confirmed and fixed tonight

1. **Unbounded login retries with no backoff** — `lib/fm-service-auth.ts` cached only on
   success, so FM errors *increased* Disco's login rate. Fixed (0d7b848) with
   single-flight + circuit breaker + backoff + timeout in `lib/fm-login-guard.ts`.
2. **Unstable hook dependency → infinite render loop** — `[...ACTIVE_STATUSES,
   ...REFUND_STATUSES]` rebuilt every render, making `loadOrders` unstable and firing
   its effect endlessly. ~2,700 req/min from one tab. Fixed (666fedd).
3. **Missing native gate on the orders sync.** Fixed (666fedd).

### 6.2 Still open

4. **A guard keyed on the wrong thing.** `refuseIfNativeMenuSurface(await
   getRestaurantRef())` — `getRestaurantRef()` reads the **`fm_restaurant_token`
   cookie** and returns `null` for a Disco-native session, so the guard silently
   no-ops and the route proceeds to FM. The guard's own header warns against exactly
   this ("deciding from the caller's cookie rather than from the thing that matters"),
   then takes its input from a cookie-only resolver. **206 of 214** native restaurants
   can hold such a session. GET and POST both.

5. **A library that is unsafe by default.** `lib/fm-orders-sync.ts` has no native check.
   I gated the *caller*; the hourly cron and the admin backfill route still reach FM for
   native restaurants, and the next caller added inherits the hole.

6. **Second doors to the same columns.** `notifications/route.ts` and
   `online-ordering/route.ts` both dual-write FM and Neon, and `disco-settings` writes
   the same notification columns by another path. Three writers, one truth.

7. **Pagination loops with no hard cap.** `OrdersCalendar.tsx:98` and
   `lib/fm-master-admin-read.ts:704` are `for(;;)` loops that exit only on the server's
   own `totalPages`. `fm-orders-sync` has a `maxPages` backstop; these do not. A server
   returning a wrong `totalPages` spins indefinitely.

8. **The service account shares a human's identity.** `FM_ADMIN_EMAIL =
   peter@familymeal.com` makes automated writes indistinguishable from Peter's own, which
   is precisely what made §3 hard to attribute.

9. **Silent `try/catch` around cross-system writes.** The order-status FM proxy is
   "best-effort, never fatal". It hides both failures *and* successes. Every one of the
   19 writes in §3 was invisible to Disco's logs.

### 6.3 Swept and clean

- No other spread-built values used as hook dependencies (checked all 155 hooks).
- No `while(true)` around a fetch without a break condition.
- No other module caching only on success in the auth path.

---

## 7. Recommended fix architecture

### The options

**A — Fix 50 routes individually.** Add `isDiscoNativeRestaurant` to each.
*Against:* 50 chances to key the gate on the wrong reference — the exact bug in
`refuseIfNativeMenuSurface`. No protection for route 51. Tonight produced three
instances of one defect in three separate files; that is the failure rate to expect.

**B — One shared guard every restaurant-scoped route passes through.**
*For:* one implementation, one place to key it correctly, and route 51 inherits it.
*Against:* a chokepoint, and it cannot decide *what to do instead* — which differs per
route (menus refuse, dashboard reads Neon, orders skip the sync).

### Recommendation: **B, with a deliberate qualification.**

Build one helper — call it `assertNotNative(ref, surface)` — resolving **the reference
the operation will actually use**, never a cookie. Make it the single sanctioned way to
ask, delete `refuseIfNativeMenuSurface`'s cookie-based entry point, and add a lint rule
or a test that fails when a file importing `${FM}` does not call it.

The qualification, and it matters: **a guard is the wrong tool for the four areas in §2
that have no Neon storage** — fees & tips, business info, scheduling, authorized users.
Gating those turns a wrong screen into a broken one. They need the data modelled in Neon
and the screens repointed. That is a porting project, not a guard.

So:

1. **Now** — shared guard on the paths that *have* a native equivalent (order writes,
   menus, reads). Fixes the ungated-write class and closes the cookie hole.
2. **Next** — port fees & tips, business info, scheduling and authorized users into
   Neon, then gate them.
3. **Alongside** — give the service account its own FM identity; add a hard page cap to
   the two uncapped loops; make cross-system write failures visible instead of
   swallowed.
4. **Keep** — the origin nginx limits. They are what kept FM serving on 2026-09-20 and
   are the only defence against a client that misbehaves despite all of the above.

### What this does not fix

A guard stops Disco calling FM. It does not stop **FM calling itself into trouble** —
`RestaurantOrderMapperImpl`'s N+1 lazy-load (one `SELECT` per order's add-on collection;
observed holding a pool connection for **548 seconds**) against a Hikari pool of **15**
with a **120 s** connection timeout. Three or four concurrent order-list requests exhaust
FM regardless of who sends them. **That is a FamilyMeal-side defect and the real reason
the outage was an outage rather than a slowdown.** It should be fixed in FM with a join
fetch or a projection, independently of anything in this report.

---

## Appendix — method

- Neon via `lib/db` with the production `DATABASE_URL`; FM via `psql` to `10.108.0.6`
  from the API droplet. All queries read-only.
- Conversion timestamps from `disco_conversions` (163 records).
- FM behaviour read from `familymeal-java-backend` (checked out at branch
  `restaurant-archive-allowlist`, **not `dev`** — worth re-confirming against `dev`):
  `MenuAdminController.java`, `MenuServiceImpl.java`, `RestaurantRepository.java`,
  `RestaurantServiceImpl.java`, `DataSourceUtil.java`, `FlywayMigrationUtil.java`.
- Temp files under `/tmp` (`native.json`, `fm_native.txt`, `conv.json`, `diffs.json`)
  are working artefacts, not committed.

**Nothing in this report was changed. No nginx limit was touched.**
