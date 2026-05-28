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
| B.1 | Location (city/state) | ❌ **BLOCKED** | No address on the customer row. Skipped. Would need a Revyrie enhancement to add address to `/api/customer/users`, or per-customer order/address lookups. |
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
