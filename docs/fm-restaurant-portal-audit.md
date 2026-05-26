# FM Restaurant Portal — Complete Source Audit

> Audited from: `~/Desktop/familymeal-backend/src/app/`  
> Date: 2026-05-25  
> Purpose: Full reference for rebuilding the ADMIN/SYSTEM_ADMIN restaurant portal in Disco Cater

---

## API Base URL

Production: `https://api.familymeal.com/`  
Frontend: `https://familymeal.com/`

All private API calls use the `api/` prefix. Public (no-auth) calls use `public-api/`.

---

## Auth

### Token Storage
Angular stores the full user object in `localStorage` under the key `currentUser`:
```json
{
  "authorization": "<JWT token string>",
  "refreshToken": "<refresh token string>",
  "firstName": "...",
  "lastName": "...",
  "email": "...",
  "phoneNumber": "...",
  "role": "ADMIN | SYSTEM_ADMIN | SUPER_ADMIN | USER",
  "reference": "<restaurant reference UUID>"
}
```

### Token Attachment
An Angular HTTP interceptor (`JwtInterceptor`) automatically adds the token:
- Header: `Authorization: <token>` (not "Bearer", just the raw token)
- Applied to all URLs **not** containing `/public-api`, EXCEPT:
  - `public-api/v2/restaurants/` — also gets the token
  - `public-api/order/pdf` — gets token + `Accept: application/pdf`

### Token Refresh
- `POST /refreshToken` with header `RefreshToken: {token}` → returns `{ authorization, refreshToken }`
- Triggered automatically via `AccountService.getToken()` when token is detected as expired
- On refresh failure → user is logged out and redirected to `/`

### Auth Guard
- `AuthGuard` checks `currentUser` from `localStorage.currentUser`
- Decodes role from JWT payload field `role`
- Decodes restaurant reference from JWT payload field `restaurant`
- If role not in route's `authorities` array → logout + redirect to `/`
- If no user at all → redirect to `/?action=signIn`

### Role Constants
```typescript
SUPER_ADMIN = 'SUPER_ADMIN'
SYSTEM_ADMIN = 'SYSTEM_ADMIN'
ADMIN = 'ADMIN'
USER = 'USER'
```

### Key localStorage Items
| Key | Purpose |
|-----|---------|
| `currentUser` | Full user object with JWT |
| `selectedRestaurant` | Restaurant reference UUID — set when SYSTEM_ADMIN impersonates a restaurant |
| `currentPaginationSize` | Persisted page size (default 25) |
| `newOrdersCount` | Badge count for orders sidebar |

---

## URL Structure

| Role | Base path | Loaded module |
|------|-----------|---------------|
| ADMIN | `/restaurant` | `AdminModule` |
| SYSTEM_ADMIN | `/restaurant` (impersonating) or `/manage` | `AdminModule` / `AdminManagerModule` |
| SUPER_ADMIN | `/admin` | `AdminModule` |

Restaurant portal (ADMIN + SYSTEM_ADMIN) lives at `/restaurant/*`.

---

## Navigation & Sidebar

The sidebar (`SidebarComponent`) reads its path list from `SIDEBAR_PATHS_LIST[role]`.

### ADMIN Sidebar (restaurant portal — what we are rebuilding)

| Order | Title | Path | Children |
|-------|-------|------|----------|
| 1 | Reporting | `dashboard` | — |
| 2 | Orders | `orders` | — (shows badge with `unseenByAdmin` count) |
| 3 | Manage Menus | `manage-v2/` | Menus, Group Library, Modifier Library |
| 3a | └ Menus | `manage-v2/menus` | — |
| 3b | └ Group Library | `manage/groups` | — |
| 3c | └ Modifier Library | `manage/modifiers` | — |
| 4 | Settings | `order-settings` | — |
| 5 | Account | `account/profile` | Profile, Banking, DoorDash (external link) |
| 5a | └ Profile | `account/profile` | — |
| 5b | └ Banking | `account/banking` | Stripe connect/disconnect (rendered as sub-component) |
| 5c | └ DoorDash | `https://www.doordash.com/merchant` | External link, only visible if `deliveryAllowed && doorDashAllowed && deliveryType === DOOR_DASH_DELIVERY` |
| 6 | Tax Rate | `tax-rate` | — |
| 7 | Customers | `restaurant-customers` | — |

### Badge Logic
- The sidebar polls `GET /api/orders/{restaurantReference}/statistics` every **60 seconds**
- Returns `{ unseenByAdmin: number, ... }` → displayed as red badge on Orders tab
- `restaurantReference` comes from JWT `restaurant` field, or `localStorage.selectedRestaurant` for SYSTEM_ADMIN
- Count also stored in `localStorage.newOrdersCount`

### SYSTEM_ADMIN View Toggle
When SYSTEM_ADMIN is impersonating a restaurant (has `selectedRestaurant` in localStorage), the sidebar shows a "View as Restaurant User / View as System Admin" toggle link that navigates between `/manage/locations` and `/restaurant/dashboard`.

---

## Dashboard

### Route
`/restaurant/dashboard`

### Access
ADMIN, SYSTEM_ADMIN, SUPER_ADMIN

### Component
`DashboardRestaurantComponent` (used inside `DashboardComponent` which routes by role)

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/restaurants` | Load restaurant data (deliveryType, onlineOrderingAllowed, feeCategories, etc.) |
| GET | `/api/dashboard/sale/stats` | Sale statistics for date range |
| GET | `/api/dashboard/stats` | Count statistics (active packages, today's orders, etc.) |
| HEAD | `/api/stripe/{restaurantReference}` | Check if restaurant is connected to Stripe |

For SYSTEM_ADMIN impersonating: uses `GET /api/system-admin/dashboard/sale/stats` instead.

### Sale Stats Query Parameters
```
fromDate: YYYY-MM-DD
toDate:   YYYY-MM-DD
dateType: 'orderDate' | 'createdDate'
```

### Sale Stats Response Fields Used
```typescript
{
  doordashDeliveryFeeSum: number,
  thirdPartyDeliveryFeeSum: number,
  doordashTipsOrdersSum: number,
  thirdPartyDeliveryTipsOrdersSum: number,
  ownDeliveryPriceSum: number,
  pickupTipsInPrice: number,
  subtotalOrdersAvg: number,
  subtotalOrdersSum: number,
  stateSalesTaxInPriceSum: number,
  localSalesTaxInPriceSum: number,
  otherSalesTaxInPriceSum: number,
  owndeliveryTipsInPrice: number,
  totalOrdersCount: number,
  totalOrdersSum: number,
  stripeFeeSum: number,
  serviceChargesSum: number,
  leadgenonediscofee: number,
  leadgentwodiscofee: number
}
```

### Stats Response Fields Used (from `/api/dashboard/stats`)
```typescript
{
  activeAddOnsCount: number,
  activeMealPackagesCount: number,
  availableAddOnsCount: number,
  availableMealPackagesCount: number,
  scheduleOrdersCount: number,
  todayOrdersCount: number
}
```

### Restaurant Response Fields Used (from `/api/restaurants`)
```typescript
{
  reference: string,
  businessName: string,
  businessNameWithoutSpaces: string,
  deliveryType: string,             // 'OWN_DELIVERY' | 'DOOR_DASH_DELIVERY' | 'NASH_DELIVERY' | 'DLIVRD_DELIVERY'
  onlineOrderingAllowed: boolean,
  doorDashAllowed: boolean,
  deliveryAllowed: boolean,
  feeCategories: [{ displayFeeCategoriesName: string, ... }],
  admin: { phoneNumber: string, ... }
}
```

### UI Elements

**Date Range Filter**
- Date range picker (Material DateRangePicker): "From Date" / "To Date"
- Clear button appears when either date is filled
- Radio buttons: "Order Date" (value: `orderDate`) | "Created Date" (value: `createdDate`)
- On date change → `filterSaleStats()` → calls `/api/dashboard/sale/stats`
- Default: today's date for both from and to

**Print Sales Summary Button**
- `<app-print-sales-summary>` component — generates PDF/printable summary

**Metric Cards** (all displayed as `app-sales-card` components)

| Card Title | Field | Notes |
|-----------|-------|-------|
| Net Sales | `subtotalOrdersSum` | Big format |
| Tax Amount | `taxRateOrdersSum` (=state+local+other) | Has tooltip showing breakdown |
| # of Orders | `totalOrdersCount` | Non-currency |
| Avg. Check (Net) | `subtotalOrdersAvg` | |
| Lead Gen 1 | `leadgenonediscofee` | |
| Lead Gen 2 | `leadgentwodiscofee` | |
| Pickup Tips | `pickupTipsInPrice` | |
| Self-Delivery | `ownDeliveryPriceSum` | |
| Self-Delivery Tips | `owndeliveryTipsInPrice` | |
| DoorDash/Third-Party Delivery | Always `0` (hardcoded) | Title switches based on `doordashDeliveryFeeSum > 0` |
| DoorDash/Third-Party Tips | `thirdPartyDeliveryTipsOrdersSum` or `doordashTipsOrdersSum` | |
| Service Charge (dynamic name) | `serviceChargesSum` | Only shown if `serviceCharge` is truthy; title = `feeCategories[0].displayFeeCategoriesName` |
| Stripe Fees | `stripeFeeSum` | Gray box |
| Total Amount | `totalOrdersSum` | Big format |

**Quick Navigation** (clicking card titles)
- "Active" → navigates to `/restaurant/orders?tab=active`
- Other links → navigate to `/restaurant/manage-v2/{link}`

### Business Rules
- If restaurant is not connected to Stripe (`HEAD /api/stripe/{ref}` fails) → online ordering toggle is forced off
- SYSTEM_ADMIN sees restaurant name in parentheses next to "Reporting" heading

---

## Orders

### Route
`/restaurant/orders`

### Access
ADMIN, SYSTEM_ADMIN

### Tabs

| Tab Index | Tab Name | Query Param | Order Statuses |
|-----------|----------|-------------|----------------|
| 0 | Active | `?tab=active` | `DUE`, `UNPAID`, `PAID` |
| 1 | Order History | `?tab=history` | `COMPLETED`, `REOPEN`, `CANCELED`, `EXPIRED`, `RESERVED`, `VOID`, `REFUND`, `PARTIAL_REFUND` |
| 2 | Order Counts | `?tab=counts` | `COMPLETED`, `DUE` |

Tab state persisted in URL query params. Deep linking to `?tab=active` etc. is supported.

### Orders Table (Active + History tabs)

**API Endpoint**
```
GET /api/orders
```

**Query Parameters (pagination + filters)**
```
page: number (0-based)
size: number (default 25)
sort: string[]  (e.g. "order_date,desc", "order_time,desc")
orderStatuses: string[] (repeated)
search: string (optional)
fromDate: YYYY-MM-DD (optional)
toDate: YYYY-MM-DD (optional)
```

**Response Shape**
```typescript
{
  content: Order[],
  totalElements: number,
  totalPages: number
}
```

**Order Object Fields Used**
```typescript
{
  orderReference: string,
  orderNumber: number,
  firstName: string,
  lastName: string,
  orderDate: string,          // 'YYYY-MM-DD'
  orderTime: string,          // 'HH:mm:ss'
  orderCreatedDate: string,   // ISO datetime → converted via moment-timezone
  restaurantTimezone: string,
  orderType: string,          // 'DELIVERY' | 'PICKUP'
  deliveryType: string,       // 'OWN_DELIVERY' | 'DOOR_DASH_DELIVERY' | 'NASH_DELIVERY' | 'DLIVRD_DELIVERY'
  transactionsTotal: number,
  orderStatus: string,
  orderSeenByAdmin: boolean,
  orderStatusesToChange: string[],  // allowed transitions
  nashDeliveryStatus: string,
  nashDeliveryPickupEta: string,
  nashDeliveryDropoffEta: string,
  nashDeliveryPublicTrackingUrl: string,
  nashDeliveryProviderId: string,
  maxAllowedRefundAmount: number,
  note: string
}
```

**Table Columns**
| Column Key | Header | Content |
|------------|--------|---------|
| `first_name` | ORDER | Customer name (`firstName lastName`), Order ID (`orderNumber`), Received on (date+time from `orderCreatedDate`) |
| `order_date` | ORDER TIME | Time (`orderTime` formatted 12hr), Date |
| `order_drop_off_time` | DELIVERY PICKUP | Nash pickup ETA if available, else calculated drop-off time |
| `order_type` | SERVICE | Delivery type formatted (e.g. "DoorDash Delivery") or "Pickup" |
| `deliveryStatus` | DELIVERY STATUS | Nash delivery status, pickup ETA, dropoff ETA |
| `transactions_total` | TOTAL | Currency formatted |
| `order_status` | STATUS | Status display (select dropdown for changeable statuses, plain text for terminal statuses) |

**New Order Highlight**
- Rows where `orderSeenByAdmin === false` get CSS class `new-order` (highlighted)
- Clicking a new order → `PUT /api/orders/{orderReference}/seenByAdmin` before opening details

**Row Click Behavior**
- If `orderSeenByAdmin === true` → directly opens order details panel (slide-in drawer)
- If `orderSeenByAdmin === false` → marks as seen first, then opens details

**Drop-off Time Calculation**
- OWN_DELIVERY: `orderDateTime - 30 minutes`
- NASH_DELIVERY / DOOR_DASH_DELIVERY / DLIVRD_DELIVERY: `orderDateTime - 25 minutes`
- Displayed only when nash pickup ETA is not available

**Order Color Coding** (in ORDER TIME column)
- Order is within 1 hour in the future → green (`#77AE70`)
- Order is in the past → red (`#E76F51`)
- Otherwise → no color

**Polling**
- Active orders auto-refresh every **60 seconds** via `setInterval`
- Refreshes only the current page (not resetting to page 0)

**Status Transitions** (from `orderStatusesToChange` field on each order)

Terminal statuses shown as plain text (no dropdown): `EXPIRED`, `REOPEN`, `REFUND`, `PARTIAL_REFUND`, `CANCELED`, `VOID`

All others shown as a `<select>` dropdown.

Status enum display values:
```
DUE → 'Due'
COMPLETED → 'Completed'
REOPEN → 'Reopened'
REFUND → 'Refunded'
PARTIAL_REFUND → 'Partial refunded'
CANCELED → 'Canceled'
EXPIRED → 'Expired'
RESERVED → 'Reserved'
VOID → 'Voided'
PAID → 'Paid'
UNPAID → 'Unpaid'
```

**Update Status**
```
PUT /api/orders/{orderReference}/updateStatus?orderStatus={status}
```
- For CANCELED or VOID → shows confirmation dialog first: "Do you want to cancel? Order status will be changed and customer will be notified."
- First fetches `GET /api/orders/{reference}` to verify order still exists, then updates

**Sorting**
- Sortable columns: `order_date` (default, DESC), `first_name`, `transactions_total`, `createdDate`
- `order_date` sort also adds `order_time` as secondary sort key
- `first_name` sort also adds `last_name` as secondary sort key

**Pagination**
- Items per page options: 25, 50, 100, 250
- Default: 25
- `ngb-pagination` component (Bootstrap-style)

### Orders Filter

**Filter Form Fields**
- Search text input (searches by name, etc.) — only shown for Active and History tabs (not Counts)
- Date range picker: Start Date / End Date
- Filters auto-apply when both dates are selected
- Clear buttons for search and dates separately

**Buttons in Filter Bar**
- "Mark all as complete" (Active tab only) — fetches count of DUE/COMPLETED orders, shows confirmation dialog, then calls `PUT /api/orders/setCompleted?fromDate=...&toDate=...`
- "Create Order" button (`add-button` component)
- "Export" button → triggers Excel export via `matTableExporter`

### Order Details Drawer

Side panel that slides in from the right. Opened via `orderDetails$` subject.

**Load Order**
```
GET /api/orders/{orderReference}
```

**Order Detail Actions**
- **Complete** → `PUT /api/orders/{ref}/updateStatus?orderStatus=COMPLETED`
- **Refund** → Opens `OrderRefundComponent` dialog
  - Form: amount input (pattern `[0-9\.,]+`), "Use full amount" toggle
  - Max refund: `order.maxAllowedRefundAmount`
  - API: `PUT /api/orders/{reference}/refund` body: `{ amount: number }`
  - On success: updates status to REFUND/PARTIAL_REFUND
- **Void** → Same as refund but sets `isVoid=true`, prefills full `transactionsTotal`
- **Reopen** → `OrderReopenComponent` dialog
  - API: `PUT /api/orders/{reference}/reopen` body: `{ orderDate, orderTime }`
- **Notes** → `OrderNotesComponent` dialog
  - Form: single `note` textarea (required)
  - API: `PUT /api/orders/{orderReference}/note` body: `{ note: string }` + header `X-RESTAURANT-UUID: {orderReference}`
- **Print** → Opens `window.open(/public-api/order/{orderReference}/pdf)`
- **PDF Summary** → `GET /public-api/order/pdf` with filters as query params

### Order Counts Tab

**API Endpoint**
```
GET /api/orders/saleStats
```
Query params:
```
orderStatuses: string[] (repeated) → ['COMPLETED', 'DUE']
fromDate: YYYY-MM-DD
toDate: YYYY-MM-DD
```

**Default Date Range** (first load only): today through today+6 days

**Response Shape**
```typescript
{
  mealPackages: SalesStatisticItem[],
  addOns: SalesStatisticItem[]
}

SalesStatisticItem {
  addOnName: string,
  mealPackageName?: string,
  count: number,
  price: number,
  total: number
}
```

**UI**
- Two tables: "Items" table (mealPackages), "Modifiers" table (addOns)
- Items columns: Items, Count, Price, Total ($)
- Modifiers columns: Modifier, Items, Count, Price, Total ($)

**Export**
- PDF: client-side via `jsPDF` + `jspdf-autotable`
- CSV: via `AngularCsv`
- Filename: `OrderCounts_MMDDYY-MMDDYY`

---

## Manage Menus (v2)

### Routes
| URL Pattern | Description |
|-------------|-------------|
| `/restaurant/manage-v2/menus` | Menus list (3 tabs) |
| `/restaurant/manage-v2/add-new-menu/settings` | Create new menu |
| `/restaurant/manage-v2/{menuReference}` | Menu detail (categories sidebar) |
| `/restaurant/manage-v2/{menuReference}/{categoryReference}` | Category detail (meal packages list) |
| `/restaurant/manage-v2/{menuReference}/{categoryReference}/add-new-item` | Create new meal package |
| `/restaurant/manage-v2/{menuReference}/{categoryReference}/{mealPackageReference}` | Edit meal package |

Sidebar also links:
- `manage/groups` → Group/Modifier library (v1 manage module)
- `manage/modifiers` → Modifier library (v1 manage module)

### Access
ADMIN, SYSTEM_ADMIN

### Menus List Page

**Component:** `MenusListV2Component` → `MenusTableComponent`

Three tabs:
- **Active Menus** — filter: `ACTIVE`
- **Inactive Menus** — filter: `NON_VISIBLE`
- **Archived Menus** — filter: `ARCHIVED`

**API: Get Menus**
```
GET /api/menu?filter={ACTIVE|NON_VISIBLE|ARCHIVED}&page=0&size=25&sort=...
```

**Response**
```typescript
{
  content: Menu[],
  totalElements: number
}

Menu {
  reference: string,
  name: string,
  menuType: string,
  startDate: string,
  endDate: string,
  image: { reference: string, ... },
  visible: boolean,
  archived: boolean
}
```

**Table Columns:** drag handle, menuName, menuType, startDate, endDate, image thumbnail, settings icon, actions

**Actions per row:**
- Navigate to menu detail (click row) → `/restaurant/manage-v2/{reference}`
- Copy/Clone → `POST /api/menu/{reference}/clone`
- Delete → confirmation dialog → `DELETE /api/menu/{reference}`
- Archive/Unarchive → `PUT /api/menu/{reference}/archive?isArchived={boolean}`
- Visibility toggle → `PUT /api/menu/{reference}/visible?isVisible={boolean}`
- Drag to reorder → `PUT /api/menu/{reference}/position?position={number}`

**Create Menu Button** → navigates to `/restaurant/manage-v2/add-new-menu/settings`

### Menu Detail Page (Categories)

**Component:** `MenuDetailedV2Component`

**Load Categories**
```
GET /api/itemCategories?menuReference={menuReference}
```
Response: array of category objects
```typescript
{
  reference: string,
  name: string,
  position: number,
  ...
}
```

On load:
- First category selected by default
- URL updated to `{menuReference}/{categories[0].reference}`
- If `categoryReference` in route params → that category is selected

**Category Sidebar UI**
- List of categories on left side
- Clicking a category navigates to `/restaurant/manage-v2/{menuRef}/{categoryRef}`
- Drag-and-drop reordering → `PUT /api/itemCategories/{reference}/position?position={number}`
- "Add Category" button → `MenuCategoryDialogComponent` dialog
  - Creates: `POST /api/itemCategories` body: `{ name, menuReference }`
- Edit icon per category → same dialog → `PUT /api/itemCategories/{reference}` body: `{ name, menuReference }`
- Delete icon → confirmation dialog → `DELETE /api/itemCategories/{reference}`

**Meal package drag-to-category**
- Drag a meal package from its category and drop onto another category header
- Confirmation dialog → `PUT /api/mealPackages/{mealPackageReference}/category?categoryReference={categoryReference}`

### Meal Packages Table (inside a category)

**API: Get Meal Packages by Category**
```
GET /api/restaurants/{restaurantReference}/mealPackages?categoryReference={categoryReference}&page=0&size=25
```

For SYSTEM_ADMIN: uses `restaurantReference` from `localStorage.selectedRestaurant`

**Response**
```typescript
{
  content: MealPackage[],
  totalElements: number
}
```

**Meal Package Actions:**
- Click → navigate to edit page
- Clone → `POST /api/mealPackages/{reference}/clone`
- Delete → `DELETE /api/mealPackages/{reference}`
- Toggle visible → `PUT /api/mealPackages/{reference}/visible?isVisible={boolean}`
- Drag to reorder → `PUT /api/mealPackages/{reference}/position?position={number}`
- "Add existing item" → modal to pick from existing meal packages
  - Load: `GET /api/restaurants/{ref}/mealPackages/existing?categoryReference={categoryRef}`
  - Add: `POST /api/mealPackages/existing?categoryReference={categoryRef}` body: `[mealId1, mealId2, ...]`

### Create/Edit Meal Package

**Create**
```
POST /api/mealPackages
```
Query params: `restaurantReference`, `menu` (menu ID number)

**Update**
```
PUT /api/mealPackages/{reference}
```

**Key Fields (from `FAKE_CONFIRM_INFO` / `IMealPackageResponse` model)**
```typescript
{
  name: string,
  description: string,
  type: string,           // 'FAMILY_MEAL' | 'KITS' | 'BEVERAGES' | 'PANTRY' | 'CHEFS_TABLE' | 'POPUP' | 'COLLABS' | 'DRINKS' | 'SERIES'
  itemCategoryReference: string,
  price: number,
  serves: number,
  addOns: any[],          // modifier groups
  available: boolean,
  inventory: number,
  schedule: any,          // scheduling config
  cutOffDate: string,
  prepTime: number,       // in hours: 0, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  pickupWindow: string,
  vegetarian: boolean,
  containsNuts: boolean,
  glutenFree: boolean,
  vegan: boolean
}
```

**Prep Time Options:** 0, 0.25, 0.50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 (hours)
**Prep Days Options:** 0, 1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28

**Dietary flags:** vegetarian, containsNuts, glutenFree, vegan, containsAlcohol

**Types list:**
`FAMILY_MEAL`, `KITS`, `BEVERAGES`, `PANTRY`, `CHEFS_TABLE`, `POPUP`, `COLLABS`, `DRINKS`, `SERIES`

### Scheduling

**Get Scheduling**
```
GET /api/scheduling?menu={menuId}
```

**Create Scheduling**
```
POST /api/scheduling?menu={menuId}
```

**Update Scheduling**
```
PUT /api/scheduling?menu={menuId}
```

**Scheduling includes per-day availability:**
- Days: sunday, monday, tuesday, wednesday, thursday, friday, saturday
- Per day: `isChecked`, `fromPickUpTime`, `fromPickUpMeridiem`, `toPickUpTime`, `toPickUpMeridiem`

**Availability modes:**
- `default` = Always available (based on menu scheduling)
- `custom` = Custom scheduling

**Max Order Variants:** No Maximum (default) or Custom number

---

## Group Library (Manage → Groups)

### Route
`/restaurant/manage/groups`

### Access
ADMIN, SYSTEM_ADMIN

(Part of the v1 `ManageMenusModule`)

This is the modifier group library. Groups contain modifier options that are attached to meal packages.

---

## Modifier Library (Manage → Modifiers)

### Route
`/restaurant/manage/modifiers`

### Access
ADMIN, SYSTEM_ADMIN

(Part of the v1 `ManageMenusModule`)

---

## Order Settings

### Route
`/restaurant/order-settings`

### Access
ADMIN, SYSTEM_ADMIN

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/restaurants` | Load restaurant data (reference, onlineOrderingAllowed, etc.) |
| HEAD | `/api/stripe/{restaurantReference}` | Check Stripe connection |
| PATCH | `/api/restaurants/onlineOrdering?onlineOrderingAllowed={bool}` | Toggle online ordering |
| GET | `/api/feesAndTips` | Load fees, tips, announcement, delivery settings |
| PUT | `/api/feesAndTips` | Update fees/tips/announcement |
| GET | `/api/notifications` | Load notification emails/phones |
| PUT | `/api/notifications` | Update notifications |
| GET | `/api/coupon` | Load active coupon |
| POST | `/api/coupon` | Create coupon |
| PUT | `/api/coupon` | Update coupon |
| DELETE | `/api/coupon` | Delete/end coupon |
| GET | `/api/closedDays` | Load skipped/closed days |
| POST | `/api/closedDays` | Create skipped day |
| PUT | `/api/closedDays/{reference}` | Update skipped day |
| DELETE | `/api/closedDays/{reference}` | Delete skipped day |

### UI Sections

**Online Ordering Toggle**
- Slide toggle: On / Off
- Toggle off → confirmation dialog warning about active orders
- Requires Stripe to be connected to turn ON
- API: `PATCH /api/restaurants/onlineOrdering?onlineOrderingAllowed={boolean}`

**FamilyMeal Page URL**
- Shows base URL + editable slug field (`businessNameWithoutSpaces`)
- Input forced to lowercase
- Save button appears when field is dirty and valid
- Pattern: `^[A-Za-z0-9-_]+$`
- API: `PUT /api/feesAndTips` body includes `businessNameWithoutSpaces`

**Email Notifications** (radio group)
- Options: All, Orders Only, Off
- Values: `ALL`, `ORDERS_ONLY`, `OFF`

**Email Notification Recipients**
- List of email addresses
- Add: enter email → "Add" button → appended to list → `PUT /api/notifications`
- Remove: delete icon per email

**Text Notifications** toggle (On/Off)

**Text Notification Recipients**
- Same pattern as emails, phone format: `000-000-0000` (masked)

**Customer Order Reminder Emails** toggle (On/Off)

**Print Kitchen Tickets** toggle (On/Off) — `autoPrint` field

**Enable Menu Search** toggle (On/Off)

**Delivery Order Time Windows** dropdown
- Options: Exact, 30 Minutes (30_min), 1 Hour (1_hour)
- API: `PUT /api/feesAndTips` body includes `deliveryOrderTimeWindows`

**Announcement Banner**
- Textarea, max 500 chars
- Save button → `PUT /api/feesAndTips` body includes `announcement`

**Scheduling Override (Skipped Days)**
- Pre-seeded system holidays (non-editable): Christmas Day, Christmas Eve, July 4th, Labor Day, Memorial Day, New Year's Day, New Year's Eve, Thanksgiving Day, Valentine's Day, Martin Luther King Jr. Day, President's Day, Independence Day, Easter
- Each has a checkbox (available true/false) → `PUT /api/closedDays/{reference}`
- Custom dates can be added → opens date picker dialog → `POST /api/closedDays`
- Custom dates can be edited or deleted

**Discounts / Coupon Section**
Form fields:
| Field | API Field | Notes |
|-------|-----------|-------|
| Discount Name | `code` | Text, required |
| Total Discounts Available | `maxAvailable` | Number, required |
| Total Per Diner | `maxPerDiner` | Number, required |
| Discount % | `discountPercentage` | Number, required |
| Start Date | `startDate` | Date picker, YYYY-MM-DD |
| End Date | `endDate` | Date picker, min = startDate |

- Save → if coupon exists: `PUT /api/coupon`; if new: `POST /api/coupon`
- "End" button → confirmation dialog → `DELETE /api/coupon`
- Remaining Discounts Available shown in tooltip on Total Number field

### Notification Object Structure (PUT /api/notifications)
```typescript
{
  email: string[],
  phoneNumber: string[],
  emailNotificationType: 'ALL' | 'ORDERS_ONLY' | 'OFF',
  phoneNotificationType: 'ALL' | 'OFF',
  autoPrint: boolean,
  orderReminderEmailsEnabled: boolean
}
```

### feesAndTips Object (PUT /api/feesAndTips)
```typescript
{
  businessNameWithoutSpaces: string,
  announcement: string,
  deliveryOrderTimeWindows: 'exact' | '30_min' | '1_hour',
  enableMenuSearch: boolean
}
```

---

## Account — Profile

### Route
`/restaurant/account/profile`

### Access
ADMIN, SYSTEM_ADMIN

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/restaurants` | Load restaurant + admin info |
| PUT | `/api/restaurants` | Update restaurant |
| GET | `/api/businessInfo` | Load business legal info |
| PUT | `/api/businessInfo` | Update business legal info |
| POST | `/api/changePassword` + params | Change password |
| POST | `public-api/images` (multipart) | Upload restaurant image |
| DELETE | (image delete endpoint) | Remove restaurant image |

### Forms

**Profile Form** (admin personal info)
```typescript
{
  firstName: string,         // required
  lastName: string,
  email: string,             // disabled (read-only)
  phoneNumber: string,       // required, pattern: /^(\+\d{1}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/
}
```

**Password Form**
```typescript
{
  password: string,          // old password, min 8, max 50
  newPassword: string,       // min 8, max 50
}
```
API: `POST /api/changePassword` with params `oldPassword` and `newPassword`

**Business Form** (legal name and address)
```typescript
{
  businessLegalName: string,
  city: string,
  state: string,
  zipcode: string
}
```

**Address Form** (restaurant public address)
```typescript
{
  businessName: string,      // required
  phoneNumber: string,       // required
  addressLine1: string,      // required, Google Places Autocomplete
  city: string,
  state: string,
  zipcode: string
}
```
+ geolocation fields: `latitude`, `longitude`, `timezone` (resolved via Google Places + Timezone API)

**DoorDash Form**
```typescript
{
  pickupInstructions: string,  // max 1000 chars
}
```

**Update Restaurant Payload** (PUT /api/restaurants)
```typescript
{
  reference: string,
  admin: {
    phoneNumber: string,
    firstName: string,
    lastName: string | null
  },
  address: {
    businessName: string,
    phoneNumber: string,
    addressLine1: string,
    city: string,
    state: string,
    zipcode: string,
    latitude: number,
    longitude: number
  },
  businessName: string,
  businessLegalName: string,
  timezone: string,
  pickupInstructions: string
}
```

### Images

**Restaurant Image** (square/circular cropper ratio 1:1 implied)
- Upload: `POST /api/images/{restaurantReference}/upload` (multipart `file`)
- Download: `GET /public-api/images/{imageReference}/download?size=150`
- Delete: separate endpoint

**Marketplace Image** (4:3 ratio crop)
- Upload: `POST /api/images/{restaurantReference}/marketplace` (multipart `file`)
- Delete: separate endpoint

Both go through a `CropperDialogComponent` (image crop modal) before upload.

### Business Rules
- Save button only enabled when: (profileForm OR businessForm OR doorDashForm OR addressForm) is dirty AND valid AND geolocation `lat+lng` are set
- If address changed via autocomplete, `lat/lng/timezone` are updated
- Google Places Autocomplete is used for the address field

---

## Account — Banking (Stripe)

### Route
`/restaurant/account/banking`

### Access
ADMIN, SYSTEM_ADMIN

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| HEAD | `/api/stripe/{restaurantReference}` | Check if connected |
| POST | `/api/stripe/clients/{restaurantReference}/connect` | Initiate Stripe OAuth connect |
| GET | `/api/stripe/disconnect/{restaurantReference}` | Disconnect Stripe |

### UI
- Single button showing "Stripe (connected)" or "Stripe (disconnected)"
- Clicking opens `StripeModalComponent` dialog
- If not connected → action: `connect` → calls connect API → `window.open(stripeConnectUrl, '_self')` (OAuth redirect)
- If connected → action: `disconnect` → disconnect API

### Connect Request
```
POST /api/stripe/clients/{restaurantReference}/connect
Content-Type: application/x-www-form-urlencoded
body: callbackUri=https://familymeal.com/restaurant/account
```
Response: `{ stripeConnectUrl: string }` → redirect to this URL

### SYSTEM_ADMIN Note
When SYSTEM_ADMIN is impersonating a restaurant, `restaurantReference` comes from `localStorage.selectedRestaurant`.

---

## Tax Rate

### Route
`/restaurant/tax-rate`

### Access
ADMIN, SYSTEM_ADMIN

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/restaurants/taxRate` | Load tax rates |
| PUT | `/api/restaurants/taxRate` | Update tax rate |

### Tax Rate Response
```typescript
{
  stateSalesTax: { fixedAmount: number, percent: number },
  localSalesTax: { fixedAmount: number, percent: number },
  otherSalesTax: { fixedAmount: number, percent: number, types: any[] }
}
```

### UI
- Material table with 3 rows: State Sales Tax, Local Sales Tax, Other Sales Tax
- Columns: Name, Tax Rate (%), Tax Rate ($)
- Footer row: totals (summed percent + summed fixedAmount)
- Edit icon per row → `UpdateTaxRateComponent` dialog
- Disclaimer text: "You are responsible for ensuring that your tax rate is an accurate summation..."

### Update Dialog Fields
- `percent` (number, to 3 decimal places)
- `fixedAmount` (currency)
- For Other Sales Tax: `types` field also editable

---

## Customers

### Route
`/restaurant/restaurant-customers`

### Access
ADMIN, SYSTEM_ADMIN

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/customer/users` | Paginated customer list |
| GET | `/api/customer/users/{customerReference}/orders` | Customer order history |

### Customers Table

**Request Parameters**
```
page: number
size: number (default 25)
sort: string[]
restaurantReference: string  (from JWT or localStorage.selectedRestaurant)
search: string (optional, filter by name)
```

**Response**
```typescript
{
  content: Customer[],
  totalElements: number
}

Customer {
  customerReference: string,
  username: string,
  email: string,
  phoneNumber: string,
  numberOfOrders: number,
  totalspend: number
}
```

**Table Columns**
| Column | Header |
|--------|--------|
| `username` | Name |
| `email` | Email |
| `phoneNumber` | Phone |
| `numberOfOrders` | Number Of Orders |
| `totalspend` | Total Spend (currency) |

**Pagination:** 25, 50, 100, 250 per page

**Search Filter:** text input for name search

**Export:** Excel download via `xlsx` library, columns: username, email, phoneNumber, numberOfOrders, totalspend

**Row Click:** navigates to customer detail page at `restaurant-customers/{customerReference}`

### Customer Detail Page
- Route: `/restaurant/restaurant-customers/{customerReference}`
- Shows order history for that customer
- API: `GET /api/customer/users/{customerReference}/orders` with `from=RESTAURANT`, `restaurant_ref={restaurantReference}`

---

## Support / FAQ

### Route
`/restaurant/support`  
(Note: sidebar shows no separate support link for ADMIN — embedded under Account or direct nav)

### Access
ADMIN, SYSTEM_ADMIN

### UI
Static FAQ accordion with the following questions:
1. How do I get started?
2. How do I manage my orders?
3. How do order statuses work?
4. When do I get paid?
5. How do I get DoorDash Delivery?
6. How much does DoorDash cost?
7. What is the DoorDash Delivery radius?
8. Additional Questions?
9. DoorDash Support (phone: 855-599-7066)

### No API calls — fully static content.

### FAQ Content Notes (key info to preserve)
- Payments: first order up to 7 days, then 48 hours after order
- DoorDash: $7.00 flat delivery fee via DoorDash Drive
- DoorDash radius: 5 miles (NYC: 3 miles)
- Status workflow:
  - Due → Completed: fulfilled
  - Due → Canceled: prepared but canceled (inventory adjusted)
  - Due → Void: NOT prepared — full refund
  - Completed → Reopen: make again (diner not re-charged)
  - Completed → Refund: partial or full refund

---

## Order Status Reference

| Status Key | Display Name | Terminal? |
|------------|-------------|-----------|
| `DUE` | Due | No (changeable) |
| `UNPAID` | Unpaid | No (changeable) |
| `PAID` | Paid | No (changeable) |
| `COMPLETED` | Completed | No (reopenable/refundable) |
| `REOPEN` | Reopened | Yes (plain text) |
| `REFUND` | Refunded | Yes (plain text) |
| `PARTIAL_REFUND` | Partial refunded | Yes (plain text) |
| `CANCELED` | Canceled | Yes (plain text) |
| `EXPIRED` | Expired | Yes (plain text) |
| `RESERVED` | Reserved | No (changeable) |
| `VOID` | Voided | Yes (plain text) |

Active tab statuses: `DUE`, `UNPAID`, `PAID`  
History tab statuses: `COMPLETED`, `REOPEN`, `CANCELED`, `EXPIRED`, `RESERVED`, `VOID`, `REFUND`, `PARTIAL_REFUND`

---

## Delivery Type Reference

| Value | Display |
|-------|---------|
| `OWN_DELIVERY` | Self-Delivery |
| `NASH_DELIVERY` | Third-Party (Nash) |
| `DOOR_DASH_DELIVERY` | DoorDash Delivery |
| `DLIVRD_DELIVERY` | Dlivrd Delivery |

---

## Meal Package Type Reference

| Value | Display |
|-------|---------|
| `FAMILY_MEAL` | Family Meal |
| `KITS` | Kits |
| `BEVERAGES` | Beverages |
| `PANTRY` | Pantry |
| `CHEFS_TABLE` | Chef's Table |
| `POPUP` | Pop Up |
| `COLLABS` | Collabs |
| `DRINKS` | Drinks |
| `SERIES` | Series |

---

## Menu Category (API field name: `menuCategories`) Reference

| Value | Display |
|-------|---------|
| `GENERAL_CATERING` | General Catering |
| `OFFICE_CATERING` | Office Catering |
| `HOLIDAY_CATERING` | Holiday Catering |
| `MEAL_PREP` | Meal Prep |
| `PRIVATE_CHEF` | Private Chef |
| `NATIONWIDE_SHIPPING` | Nationwide Shipping |
| `MERCH` | Merch |
| `POP_UP` | Pop Up |

---

## Key Angular Services → API Mapping Summary

| Service | Key Endpoints |
|---------|---------------|
| `AuthenticationService` | localStorage `currentUser`, no HTTP |
| `AccountService` | `POST /login`, `POST /refreshToken`, `POST /registration`, `GET/PUT /api/users` |
| `DashboardService` | `GET /api/restaurants`, `GET /api/dashboard/sale/stats`, `GET /api/dashboard/stats`, `PATCH /api/restaurants/onlineOrdering`, `PATCH /api/restaurants/delivery` |
| `OrderService` | `GET /api/orders`, `PUT /api/orders/{ref}/updateStatus`, `PUT /api/orders/{ref}/refund`, `PUT /api/orders/{ref}/reopen`, `PUT /api/orders/{ref}/note`, `PUT /api/orders/{ref}/seenByAdmin`, `GET /api/orders/{ref}/statistics`, `GET /api/orders/saleStats`, `PUT /api/orders/setCompleted` |
| `RestaurantService` | `GET /api/restaurants`, `PUT /api/restaurants`, `GET /api/restaurants/taxRate`, `PUT /api/restaurants/taxRate` |
| `MenuService` | `GET/POST/PUT/DELETE /api/menu`, `GET/POST/PUT/DELETE /api/itemCategories`, `PUT /api/menu/{ref}/position`, `PUT /api/menu/{ref}/visible`, `PUT /api/menu/{ref}/archive`, `POST /api/menu/{ref}/clone` |
| `MealPackageService` | `GET/POST/PUT/DELETE /api/mealPackages`, `PUT /api/mealPackages/{ref}/position`, `PUT /api/mealPackages/{ref}/visible`, `PUT /api/mealPackages/{ref}/category`, `POST /api/mealPackages/{ref}/clone`, `GET /api/restaurants/{ref}/mealPackages`, `GET/POST /api/scheduling` |
| `NotificationService` | `GET/PUT /api/notifications`, `GET/PUT /api/feesAndTips`, `GET/PUT /api/orderSettings` |
| `OrderSettingsService` | `GET/POST/PUT/DELETE /api/coupon`, `GET/POST/PUT/DELETE /api/closedDays`, `GET/POST/PUT /api/itemCategories` |
| `ProfileService` | `GET/PUT /api/restaurants`, `GET/PUT /api/businessInfo`, `POST /api/changePassword` |
| `StripeService` | `HEAD /api/stripe/{ref}`, `POST /api/stripe/clients/{ref}/connect`, `GET /api/stripe/disconnect/{ref}` |
| `CustomersService` | `GET /api/customer/users`, `GET /api/customer/users/{ref}/orders` |

---

## Global Architecture Notes

### SYSTEM_ADMIN Impersonation
When a SYSTEM_ADMIN selects a restaurant to manage, the restaurant's reference UUID is stored in `localStorage.selectedRestaurant`. All services check for this and use it instead of the JWT `restaurant` field when making restaurant-specific API calls. The sidebar shows a toggle to switch between "Restaurant User" view and "System Admin" view.

### Admin Component Shell
`AdminComponent` at `/restaurant` wraps all sub-routes and contains the `<app-sidebar>` and `<router-outlet>`.

### DoorDash Icon in Sidebar
Shown conditionally under Account > DoorDash only when:
- `restaurant.deliveryAllowed === true`
- `restaurant.doorDashAllowed === true`
- `restaurant.deliveryType === 'DOOR_DASH_DELIVERY'`
- `restaurant.address.addressLine1` is set AND `restaurant.admin.phoneNumber` is set

Otherwise the DoorDash link is hidden.

### Image API
- Upload: multipart/form-data with `file` field
- Retrieve: `GET /public-api/images/{reference}/download?size={pixels}`
- Size values used: 70, 150

### Socket.io Integration
`MealPackageService` connects to a socket.io server at `BACKEND_MENU_UPLOAD_URL` (https://menuupload.familymeal.com/) for:
- Bulk menu import status: events `scrapeStatus`, `status`, `itemStatus`, `error`
- Auth: `{ userId: restaurant.reference }`
- Used in SUPER_ADMIN bulk import flow, not in restaurant ADMIN portal

---

## Gaps / Unclear Areas

1. **Group Library & Modifier Library** (`/restaurant/manage/groups`, `/restaurant/manage/modifiers`): These are in the v1 `ManageMenusModule` which was not fully read. The API endpoints for add-ons/extra item groups need separate audit of that module.

2. **Menu Settings page** (`manage-menus-v2/menus-v2/menu-settings-v2/`): Not read in detail — this is the create/edit menu form for menu-level settings (name, type, dates, scheduling). API is `POST /api/menu` and `PUT /api/menu/{reference}`.

3. **Meal Package Detail/Edit form**: The full meal package create/edit wizard (`meal-packages-v2/` subdirectory) was not read in detail. The API endpoints are known (`POST /api/mealPackages`, `PUT /api/mealPackages/{ref}`), but the full set of form steps was not captured.

4. **Order Details drawer sub-components**: The full `OrderDetailsComponent` was not read — it is a separate component that shows order line items, customer info, delivery address, payment summary, and action buttons (complete, refund, void, reopen, note, print).

5. **Print Summary / Export components**: `PrintSalesSummaryComponent` and `PrintSummaryComponent` were not read in detail.

6. **Admin Banking page** (`/admin/admin-banking`): SUPER_ADMIN only — not in scope for restaurant portal rebuild.

7. **`/api/orderSettings`** endpoint: Used in `NotificationService.getOrderSettings()` / `setOrderSettings()` but not clearly mapped to a specific UI section in the reviewed code.

8. **`PUT /api/feesAndTips` full schema**: There are additional fields (delivery fees, service charges, tip settings, delivery minimums) referenced in commented-out code in `OrderSettingsComponent` that suggest these settings were previously managed here but may have moved to a different admin panel or are managed by SUPER_ADMIN only.
