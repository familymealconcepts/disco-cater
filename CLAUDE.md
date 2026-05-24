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
