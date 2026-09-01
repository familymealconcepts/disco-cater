# Disco Cater — Claude Code Context

## Project
Disco Cater (discocater.com) is a Next.js catering marketplace gradually replacing the FamilyMeal Angular frontend. The goal is to migrate all FamilyMeal functionality (diner, restaurant, and admin portals) into Disco Cater and sunset the old frontend entirely.

## Codebase
- **Local path**: `/Users/peterventi/Desktop/VS Code/disco-cater`
- **Repo**: github.com/familymealconcepts/disco-cater
- **Deploy**: Vercel, auto-deploy from `main` branch
- **Stack**: Next.js App Router, TypeScript, Sanity CMS, Mapbox, Anthropic API

## Environment Variables
Stored in `.env.local` (local) and Vercel (production). Never hardcode keys.
- `NEXT_PUBLIC_MAPBOX_TOKEN`
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
- `NEXT_PUBLIC_SANITY_PROJECT_ID=0j4eqnmw`
- `NEXT_PUBLIC_SANITY_DATASET=production`
- `SANITY_TOKEN`
- `ANTHROPIC_API_KEY`

## Brand
- **Font**: DM Sans
- **Gradient**: `linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)`
- **Logo**: `<span gradient>disco</span><span color=#999> cater</span>` — always this pattern, never an image
- **Dark**: `#1A1028`
- **Blue** (buttons): `#5B6FE8`
- **Gold** (AI button): `#EFB84A`
- **Header bg**: `linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff`
- **Header border**: `1px solid #f0f0f0`
- **Header padding**: `9px 18px`

## Header Rules (CRITICAL)
Every page has exactly ONE header. They must all look identical — same font sizes, logo, colors, padding.
- `app/components/GlobalHeader.tsx` — used on homepage, FAQ, compare, restaurant pages
- Portal (`/portal`) — has its own inline header (same design, adds Orders/Subscriptions/History/Favorites pills)
- Fullmap (`/fullmap`) — has its own inline header (same design, adds filter pills)
- GlobalHeader is NOT in `app/layout.tsx` — added per-page for control
- Auth state: reads `localStorage.getItem('disco_user')`, shows initials avatar + dropdown when logged in, Log in button when logged out
- Login modal built into GlobalHeader — calls `/api/fm-auth`, stores response in `disco_user`

## Key Files
## FamilyMeal API
Base URL: `https://api.familymeal.com`
Auth: `Authorization: Bearer {token}` header on all `/api/*` endpoints
Public endpoints (no auth): `/public-api/*`

### Auth
- `POST /login` → `{authorization, refreshToken, firstName, lastName, email, phoneNumber, role}`
- `POST /refreshToken` (header: `RefreshToken: {token}`) → new JWT pair
- Roles: USER (customer), ADMIN (restaurant), SYSTEM_ADMIN, SUPER_ADMIN

### Customer Order Flow
1. `GET /public-api/restaurants/{ref}/mealPackages` — browse menu
2. `GET /public-api/mealPackages/{ref}/availableDates` — pick date
3. `GET /public-api/mealPackages/{ref}/availablePickUp?localDate={d}` — pick time
4. `POST /public-api/v2/restaurants/{ref}/orders/init` — create draft
5. `POST /public-api/delivery/validate` — validate address
6. `PUT /public-api/v2/restaurants/{ref}/orders/{orderRef}` — finalize totals
7. `GET /stripe/platform/info` → tokenize card → `POST /api/userOrder/confirmPayment`
8. `POST /api/v2/restaurants/{ref}/orders/{orderRef}` — place order (auth required)
9. `GET /api/userOrder/{orderRef}` — confirmation

### Account
- `GET/PUT /api/users` — profile
- `GET /api/userOrder` — order history (paginated) ⚠️ currently 401, Revyrie investigating
- `GET /api/users/payment/defaultSource` — saved card

### Restaurant Reference
Extracted from Sanity `orderUrl`:
`https://www.familymeal.com/disco/twohandsfranklin/catering` → ref = `twohandsfranklin`

## Sanity
- Project: `0j4eqnmw`, dataset: `production`
- Studio: https://discocater.sanity.studio/
- ~700 restaurants imported
- Key fields: `name, slug, address, cuisine, cuisines[], description, image, orderUrl, isDisco, lat, lng, location, tags[]`

## Current State of Migration

### ✅ Done
- Homepage with GlobalHeader and auth
- Fullmap with Mapbox, sidebar, cuisine filters, AI chat, auth-aware header
- Diner portal (orders, subscriptions, history, favorites, account)
- Restaurant profile pages at `/restaurants/[slug]`
- FAQ page
- Auth flow (login, logout, persist across pages)

### 🔄 In Progress
- Restaurant profile pages — just built, needs testing
- Fix `/api/userOrder` 401 — waiting on Revyrie

### 📋 Next Priorities
1. Complete native ordering flow: package → date → time → address → payment → confirmation
2. Restaurant portal (restaurant-facing dashboard)
3. Admin portal

## Rules
1. Always run `npm run build` before committing — never push broken builds
2. Never break existing pages
3. All headers must be visually identical — same font, logo, colors, padding
4. Logo is ALWAYS text (`disco` gradient + ` cater` grey), never an image
5. Auth state always from `localStorage.getItem('disco_user')`
6. Git: `git add . && git commit -m "message" && git push origin main`
7. Never paste API keys into chat or code — use env vars only
8. Sanity mutations use `createOrReplace`, not `publish`

## Who can see which restaurants (READ BEFORE TOUCHING ANY MULTI-LOCATION CODE)

This model has caused six separate bugs in six different files. Read it before
writing anything that answers "which restaurants can this person see."

### The architecture (Peter, 2026-09-01 — authoritative)

- **ADMIN: exactly one location.** All tools for that location. **Cannot see or
  switch to another.** This is by design — the portal shell putting an ADMIN in
  Mode B unconditionally is CORRECT, not a bug to fix.
- **SYSTEM_ADMIN: all locations assigned to or created by them**, with a
  rolled-up view across exactly those — orders, reporting, everything. No more,
  no less.
- **A "regional manager" is just a SYSTEM_ADMIN with a subset.** Not a separate
  role. Do not add one.
- **A location can have many ADMINs. A SYSTEM_ADMIN can hold 1 or 5,000
  locations, overlapping freely with other SYSTEM_ADMINs.**
- **Only a super admin (us) or another SYSTEM_ADMIN invites SYSTEM_ADMINs**, and
  can only assign locations they themselves hold.
- **ROLE GATES REACH.** Grants define a SYSTEM_ADMIN's set. **An ADMIN's reach is
  their own location regardless of grants.** Never compute reach from grant count
  alone.
- **Post-conversion, Disco owns grants. NEVER reconcile them against FM** — a
  grant may be a deliberate later change someone made on purpose, and revoking
  it would overwrite a real decision.

### The tables

- **`disco_restaurant_accounts` is the credentials table.** One row per human,
  `UNIQUE(email)`. `role` lives here. Its `restaurant_reference` is an **anchor
  for default context** — where the portal drops them on login — and for an
  ADMIN it is also their single location. `is_disco_native` on this row is stale
  and unreliable; the authoritative one is on `disco_restaurant_cache`.
- **`disco_restaurant_location_access` is the grant table**, keyed on **email**
  (not `account_id`). It defines a SYSTEM_ADMIN's set. For an ADMIN it is not
  consulted for reach.
- A **restaurant's** archive is `disco_restaurant_overrides.archived_at` (see
  `lib/disco-restaurant-archive.ts`). `disco_restaurant_accounts.archived_at`
  describes one ACCOUNT and says nothing about the location.

Sentinel `stripe-import+{ref}@familymeal.com` rows exist for locations with no
real admin, so a future admin has a row to accept an invite onto. They are
**never recipients of anything**.

### Use the role-gated wrappers, not the raw primitives

`lib/restaurant-write-scope.ts` exports the two that apply the role gate:

- **`resolveDiscoGroupScope(ctx)`** — for call sites keyed on group refs
  (locations, upload-image, bulk-pricing, report scope).
- **`resolveDiscoAccessScope(ctx)`** — for call sites keyed on the grant table
  (order scope, multi-unit links, team).

Both return home-ref-only for any role that isn't `SYSTEM_ADMIN`, and
`{unrestricted: true}` for `SUPER_ADMIN`. The raw `getLocationAccessRefs` /
`getDiscoGroupAccounts` / `discoGroupRefs` primitives answer "what is this
email's group" **without regard to role**, which is the wrong question for both
an ADMIN and a SUPER_ADMIN. Reach for either through a wrapper.

Verify any change with `npx tsx scripts/verify-role-gated-reach.ts`.

### Four traps that have each cost a real bug

1. **Do not gate multi-location UI on grant count.** Changed on 2026-09-01 and
   **reverted the same day**. When an ADMIN appears to be missing locations,
   either their role is wrong (mirror FM's) or their grants are — never widen the
   shell. Barbara Coultas's real fix was her role: FM said `SYSTEM_ADMIN` and the
   account row created by passing `email:` to `importRestaurantStripeAccount`
   defaulted to `ADMIN`. **Don't pass `email` to that function** — the
   `stripe-import+{ref}@` sentinel fallback is the correct behaviour.

2. **FM's authorized-users endpoint OVER-REPORTS.** It returns the whole chain's
   authorized users for every location, not that location's. Proven 2026-09-01:
   for Atlanta Bread Alpharetta it returned 7 users and **none of the 7** is
   assigned to Alpharetta in FM's own `tbl_system_admin_restaurants`. This is the
   same shape as Morning Squeeze appearing on Eggstasy's page while unchecked.
   FM's real membership lives in the snapshot DB (`fm_backup`, schema
   `familymeal`):
   - `tbl_restaurant_admins (restaurant_id, user_id)` — an ADMIN's location
   - `tbl_system_admin_restaurants (user_id, restaurant_id)` — a SYSTEM_ADMIN's set
   - `tbl_restaurant_groups_system_admins (group_id, user_id)`
   The snapshot is frozen at **2026-06-16**, and no live FM endpoint exposes
   these. Treat the endpoint as a candidate list, never as membership.

3. **An FM-session user has NO Disco identity.** `getRestaurantAuthContext()`
   returns `authType: 'fm'` with **`email: ''`** and `restaurantReference: ''`.
   Every grant resolver returns empty for a blank email — deliberately, so a
   non-Disco user is never blocked — so a grant lookup silently yields nothing.
   Handle that case explicitly rather than letting it fall through. (Same root as
   the `ctx.restaurantReference` blank-for-FM family of bugs.)

4. **Never join `disco_restaurant_accounts` on `restaurant_reference`.** It is
   not unique there — Atlanta Bread Asheville has 9 account rows. A `LEFT JOIN`
   on it to test `archived_at` multiplied every grant by the account-row count:
   kjp@atlantabread.com's 9 grants returned 24, Asheville repeated 8 times. No
   revenue was ever overstated (aggregates de-dupe into a Set and filter with
   `= ANY(refs)`, which is membership, not a join) but the location dropdown
   showed the duplicates. Test a restaurant's archive with `NOT EXISTS` against
   `disco_restaurant_overrides`.

## Browser verification with Playwright (READ THIS BEFORE SAYING YOU CAN'T)

**Playwright is already installed and working in this repo.** No install step.
`@playwright/test ^1.60.0` is in devDependencies, Chromium is in
`~/Library/Caches/ms-playwright`, and `playwright.config.ts` exists. Sessions have
lost real verification by assuming otherwise — 1,154 item-image rows were written
and *zero* rendered, and only a manual HTML grep caught it.

Use it whenever a change is visual, or whenever "the data is right" is not the
same claim as "the customer sees it".

### The two gotchas that make it look broken

1. **Import from `@playwright/test`, NOT `playwright`.** Only the test package is
   installed, so `import { chromium } from 'playwright'` fails with
   `ERR_MODULE_NOT_FOUND`. Use `import { chromium } from '@playwright/test'`.
2. **The script must live inside the repo** so Node resolves `node_modules`. A
   `.mjs` at the repo root works; a script in the scratchpad does not. Name it
   `*.tmp.mjs` and delete it when done.

Also: `playwright.config.ts` defaults `baseURL` to **production**
(`https://www.discocater.com`). For local work start `npm run dev` and hit
`http://localhost:3000` explicitly, or use `npm run test:e2e:local`.

### Auth — the edge only checks that a cookie EXISTS

`middleware.ts` cannot reach Neon, so it checks cookie presence (and, for the
legacy FM cookie, decodes an unverified role claim). Full validation happens in
the API routes. That is enough to render a gated page with stubbed APIs:

- **Customer** (`/account/*`, `/portal`): cookie `disco_customer_token`.
- **Restaurant portal** (`/restaurant/*`): cookie `disco_restaurant_token` —
  opaque, so presence alone passes. (`fm_restaurant_token` also works but must be
  a real JWT shape whose payload carries `role: ADMIN | SYSTEM_ADMIN |
  SUPER_ADMIN`, or the edge bounces to `/restaurant/login`.) Also seed
  `localStorage.restaurant_user` via `context.addInitScript`, and stub
  `/api/disco-restaurant-auth/me` with a 401 so the layout keeps the seeded
  identity.
- **Set cookies with `url: 'http://localhost:3000'`**, not `domain: 'localhost'` —
  the domain form silently fails to attach and you get redirected to login.

Never invent or hard-code real credentials; stub the API instead (Rule 7).

### Stubbing data

`page.route('**/api/restaurant/orders?**', r => r.fulfill({...}))` renders the real
component against a controlled fixture — the right way to verify a state that is
hard to reach, like a cancelled-but-unrefunded order.

**Match the field names the component actually reads.** The orders list keys rows
on `orderReference`, not `reference`; getting it wrong yields a duplicate-key
React warning and rows that will not open.

### Two page-specific traps

- The customer ordering page **opens a date/time modal on load**. Dismiss it
  (`button` with text `×`) before asserting on the menu underneath, or every
  locator resolves behind an overlay.
- Don't scrape text with a blanket `document.querySelectorAll('*')` — it pulls in
  `<script>`/`<style>` contents. Walk `NodeFilter.SHOW_TEXT` and skip
  `SCRIPT`/`STYLE`/`NOSCRIPT`.

### Assert on computed style, not source

For hierarchy or colour, read it back from the rendered DOM — that is the whole
point of using a browser:

```js
const s = getComputedStyle(el)          // fontSize / fontWeight / color
```

e.g. the portal orders date/time cell must be date-dominant, verified as
`16.5px/700 #1A1028` above `13px/600 #6E6684`.

### Screenshots

`await page.screenshot({ path, clip })` — a `clip` box around the element under
test reads far better in a report than `fullPage: true`. Include a **control** in
the same frame where one exists (e.g. a min-4 item beside a min-1 item), so the
screenshot proves the rule rather than just showing the happy case.

### Comparing FamilyMeal and Disco side by side

`node scripts/compare-fm-disco.mjs <slug> [--base http://localhost:3000] [--out DIR]`

Renders both pages for the same restaurant and diffs what each actually SHOWS —
item names, prices, Serves/Select labels, notice banners — plus a screenshot of
each. This comparison is where most real bugs have surfaced (the 15-minute slot
grid, the partial-day blackouts, the missing item images), so run it rather than
waiting for someone to notice.

- FM's Disco-skinned storefront is `https://www.familymeal.com/disco/{slug}/catering`
  and renders fully in Playwright (Angular, ~6s to hydrate, anonymous).
- FM's own-branded storefront redirects to a sign-in modal at
  `https://www.familymeal.com/?action=signIn`. There is no `/login` route — it
  404s to `/page/not-found`.
- Compare SLOTS with `scripts/verify-lead-time.ts` instead. It diffs against FM's
  own `availablePickUp`, which is far more precise than reading a picker, and
  FM's picker is a multi-step Angular flow.
- Expect two harmless artifacts in the name diff: Disco's date/time modal is
  dismissed while FM's pickup bar is inline, and the two split "Serves 2+" into
  different text nodes.

**Authenticating as a restaurant on FM** is mechanically possible —
`FM_MASTER_PASSWORD` works in place of any enabled restaurant admin's password,
and the sign-in modal above takes Email + Password. Do NOT do it from a script
yet: `lib/fm-master-admin-read.ts` writes an audit row for every master-password
use (`FM_MASTER_PASSWORD_READ`), and a browser login would bypass that trail.
Wire the same audit write first.
