# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run start    # Run production build
npm run lint     # ESLint
```

No test suite is configured.

## Environment Variables

```
NEXT_PUBLIC_SANITY_PROJECT_ID
NEXT_PUBLIC_SANITY_DATASET
SANITY_TOKEN
NEXT_PUBLIC_MAPBOX_TOKEN
GOOGLE_PLACES_API_KEY
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ANTHROPIC_API_KEY
```

## Architecture

**Disco Cater** is a catering discovery marketplace. Customers find restaurant partners for corporate/social events via an interactive map with AI-powered recommendations.

### Data Flow

1. `/api/restaurants` fetches restaurant records from **Sanity CMS** via GROQ (name, location, cuisine, lat/lng, images).
2. `/api/disco-chat` enriches that data with pricing/packages/delivery info from **`scripts/output/restaurant-compact.json`** (matched by normalized name), builds a system prompt, and calls the **Anthropic Claude API** to return personalized recommendations. Includes exponential-backoff retry logic for 429/529 errors.
3. The frontend (`app/fullmap/page.tsx`) holds all map + chat state in React hooks — no external state management.

### Key Pages

- `app/page.tsx` — Home: Google Places Autocomplete location search.
- `app/fullmap/page.tsx` — Main experience (~1000 lines): Mapbox GL map, restaurant sidebar list, AI chat panel ("Disco Bot"), cuisine filters, proximity sorting (Haversine, 25-mile radius).
- `app/faq/page.tsx` — FAQ accordion.

### Map & Markers

Mapbox GL JS renders numbered markers with custom styling. Disco partner restaurants get a gold outline. Clicking a marker opens a popup with image, cuisine tags, and an order button. Mobile hides the map by default with a toggle.

### Styling

- Tailwind CSS v4 for utility classes; most component styles are **inline style objects**.
- Brand gradient: `linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)`
- Font: DM Sans throughout.

### Image Domains

`next.config.ts` whitelists `images.squarespace-cdn.com` for `next/image`. Add new domains there if needed.

### Scripts

`scripts/` contains one-off data import/enrichment utilities (CSV import with geocoding, Claude-powered cuisine tagging, bulk Sanity upserts). Not part of the runtime app.

## Git Workflow
- After completing any task or set of changes, always stage, commit, and push:
  git add . && git commit -m "<short descriptive message>" && git push origin main
- Write commit messages that describe what changed (e.g. "fix map filter bug", "add FAQ page")
- Never leave changes uncommitted after finishing a task
- Always confirm the push was successful before considering a task done