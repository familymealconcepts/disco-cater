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
