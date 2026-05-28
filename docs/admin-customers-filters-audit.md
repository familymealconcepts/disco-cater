# Admin Customers — Filters Data Inventory

> SUPER_ADMIN `/admin/manage-customers`. What FM actually returns per customer,
> and which of the five requested filters are buildable today vs blocked.
> Read from FM Angular source; cited `file:line`.

## FM endpoint
`GET /api/customer/users` (`_system/_services/customers/customers.service.ts:15,55`).
Query params FM supports (`customers.service.ts:30-49`, `customer-table-filter.component.ts:185-195`):
- `search` — name search
- `source` — `FAMILYMEAL` | `DISCO` (`customer-table-filter.component.ts:35-46`)
- `fromDate` / `toDate` — **formatted `DD.MM.YYYY`** via DateFormatService (`customers.service.ts:38-43`); filters customers by order activity in the range
- `restaurantReference` — customers who ordered from one restaurant
- `page` / `size` / `sort`

## Per-customer fields returned
From the admin customer table columns (`customer-table/customer-table.component.ts:29`,
`customer-table.component.html`): `username`, `email`, `numberOfOrders`,
`sourceoforder` (FAMILYMEAL/DISCO), `totalspend`. Disco's existing row also
carries `phoneNumber` and `customerReference`.

| Field | In FM customer row? |
|---|---|
| name (`username`) | ✅ |
| `email` | ✅ |
| `phoneNumber` | ✅ (present though FM's admin table hides it) |
| `numberOfOrders` | ✅ |
| `totalspend` | ✅ |
| `sourceoforder` (FAMILYMEAL/DISCO) | ✅ |
| address / city / state | ❌ not returned |
| last order date | ❌ not returned per row (but server **filters** by date range) |
| distinct restaurant count | ❌ not returned (server can **filter** by one restaurant, no count) |

## Requested filters — feasibility

| # | Filter | Status | How |
|---|---|---|---|
| B.1 | Location (state / zip) | ✅ **proxy via restaurant addresses** | See "Location via restaurant proxy" below — customer has no address, but their orders' restaurants do. |
| B.2 | Number of orders (range) | ✅ **client-side** | min/max on `numberOfOrders`. |
| B.3 | Corporate vs Social | ✅ **client-side** | email-domain heuristic (personal-provider list). No FM call. |
| B.4 | Last order date (range) | ✅ **server-side** | FM `fromDate`/`toDate` on `/api/customer/users`. Filters the set; the per-row date itself isn't returned, so the CSV "Last Order Date" column stays blank. |
| B.5 | # different restaurants (range) | ❌ **BLOCKED** | No restaurant-count field. Skipped. FM offers a single-`restaurantReference` filter (membership, not a count) as the nearest alternative — not built this pass. |

## Approach
The list is fetched in full (paged through, capped) so the client-side filters
(# orders, corporate/social) and the filtered CSV export operate over the
entire matching set, not just one server page. The date range is applied
server-side (FM `fromDate`/`toDate`); name search is server-side; the rest is
client-side. Pagination becomes client-side over the filtered result.

## Corporate/Social heuristic
"Social" = email domain ∈ the personal-provider list (gmail.com, yahoo.com,
hotmail.com, outlook.com, aol.com, icloud.com, me.com, msn.com, live.com,
mac.com, ymail.com, rocketmail.com, googlemail.com, protonmail.com, proton.me,
comcast.net, verizon.net, att.net, sbcglobal.net, cox.net, charter.net,
earthlink.net, optonline.net). "Corporate" = anything else. "All" = no filter.

## Location via restaurant proxy (State + Zip filters)
FM returns **no customer address**. But every order carries a restaurant
reference, and every restaurant carries an address, so customer location is
derived:
1. `GET /api/admin/restaurants?size=1000` → `restaurantRef → { state, zipcode }`
   (`address.state` is a 2-letter code, `address.zipcode` a string — confirmed
   via the add/edit-restaurant form and the locations list).
2. `GET /api/admin/userOrders` (paged, capped 50×200) → each order exposes
   `firstName`, `lastName`, `restaurantReference` (confirmed in
   `admin-orders-table.component.html` bindings).
3. Aggregate `customer → { states, zips }`.

### ⚠️ Join is by NAME, not email
FM's admin **orders list does NOT include customer email or a customer
reference** — only `firstName` + `lastName` (email appears only on the order
*detail*, which we can't fetch 10k times). So orders are joined to customers by
**normalized full name** (`firstName lastName` ↔ customers' `username`),
case-insensitive. Limitation: two customers with the same name share a location
set. Acceptable for an approximate SUPER_ADMIN location proxy; documented.

### Filters
- **State** — multi-select (50 states + DC, full names, 2-letter values), OR
  logic: a customer matches if any of their states is selected. "All States"
  clears.
- **Zip** — exact `^\d{5}$`; only applies when 5 digits entered.
- Both AND with the other filters; reflected in CSV (States, Zips columns) and
  URL (`?states=NY,CT&zip=10001`).

### Performance / timing
Aggregation is **lazy + cached for the session**: it runs on mount only if the
URL deep-links a location filter, otherwise on first open of the State dropdown
or focus of the Zip input. While it runs, "Loading location data…" shows and the
location filter is held off (the list isn't blanked). Restaurants = 1 call;
orders = up to 50 parallel-ish calls (cap 10k orders). Customers with no orders,
or orders whose restaurant has no address (warned + skipped), get no location
and are excluded when a location filter is active.
