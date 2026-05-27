# Missing Test Restaurant — diagnosis

**Status:** Read-only diagnosis. No fix applied yet.

**Symptom:** chef@familymeal.com (SUPER_ADMIN) sees Test Kitchen, Test Bakery, and TestGrape in the top-right Restaurant dropdown on `/restaurant/dashboard`, but does **not** see "Test Restaurant" — which exists in FM staging at `https://stg.familymeal.com/testrestaurant`.

## The two paths that populate the dropdown

The dropdown loads from `app/(restaurant)/restaurant/(portal)/dashboard/page.tsx:137`:

```ts
fetch('/api/restaurant/locations?size=1000')
```

That hits the proxy at `app/api/restaurant/locations/route.ts`:

```ts
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
...
const res = await fetch(`${FM}/api/system-admin/restaurants?${params}`, { headers: h })
```

FM endpoint resolved: `GET /api/system-admin/restaurants?size=1000` (confirmed against FM's `RestaurantService.getSystemAdminRestaurantsPagination`, line 410). Paginated, supports filter args. No client-side filter is applied in our proxy or in the dashboard — the dropdown shows whatever FM returns.

## Three hypotheses, ranked

### A. Environment mismatch (most likely)

The screenshot URL `https://stg.familymeal.com/testrestaurant` is the **staging** front-end. Test Restaurant exists in staging FM only. If `FM_API_BASE_URL` on Vercel is set to `https://api.familymeal.com` (production FM API), the dropdown queries production, where Test Restaurant doesn't exist — Test Kitchen / Bakery / Grape do.

**To confirm:** check the Vercel env var for the environment chef is logging into:

- Vercel → Project → Settings → Environment Variables → `FM_API_BASE_URL`
- Look at the Production / Preview / Development values

Expected resolution:
- If chef tests on `discocater.com` (prod) and `FM_API_BASE_URL=https://api.familymeal.com` → he's hitting prod FM, "Test Restaurant" lives only in staging FM, so it's invisible. **Working as intended; no bug.**
- If chef tests on a Vercel preview that's pointing at the wrong FM → swap the env var on that environment to `https://api.stg.familymeal.com`.

`.env.local` here on the dev machine has `FM_API_BASE_URL=<set>` — value not echoed for safety. Verify which host that resolves to and what Vercel has for each environment.

### B. Pagination cutoff

Dashboard requests `size=1000`. FM's `getSystemAdminRestaurantsPagination` paginates but accepts arbitrary size. 1000 is far above the count of restaurants in any realistic FM deployment, so a missing-page-2 scenario is extremely unlikely. Unless FM caps `size` server-side at e.g. 25 and silently ignores larger values, in which case "Test Restaurant" could be on page 2 and never fetched.

**To rule out:** open DevTools → Network → click the `/api/restaurant/locations` request → check the `content[]` length in the response. If FM returned fewer than ~50 records but the total is high, the cap is real and we'd need a paginate-until-exhausted loop in the proxy.

### C. Filtered out by an FM flag

FM's `system-admin/restaurants` endpoint supports filter args (the `filters` param to `getSystemAdminRestaurantsPagination`). FM may apply a default `isArchived=false` / `blocked=false` / `published=true` filter when called without explicit args. If Test Restaurant is archived / blocked / unpublished in production FM, it'd be silently filtered out while the others remain visible.

**To rule out:** add a temporary `console.log(d.content.map(r => ({ name: r.businessName, archived: r.archived, blocked: r.blocked, published: r.isPublished })))` to the dashboard's location-load and see if Test Restaurant comes back in the response at all. If it's not in `content[]`, FM is filtering it out and we need to either:
1. Pass explicit filter args (probably forbidden — would expose archived restaurants to the dropdown), or
2. Accept that this restaurant is unreachable by design.

## Recommended next step

Confirm hypothesis A first — it's a one-minute env-var check and explains the symptom completely. If A is ruled out, do the Network-tab inspection in B and the response-content check in C in that order.

**Do not change the proxy or the dashboard yet** — the page-1-only fetch and the no-explicit-filter behavior are both deliberate. Only patch once you've confirmed which hypothesis is real.
