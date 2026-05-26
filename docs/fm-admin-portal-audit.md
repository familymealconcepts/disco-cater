# FamilyMeal SUPER_ADMIN Portal Audit

> Source: comprehensive audit of `/Users/peterventi/Desktop/familymeal-backend/src/app/`
> Date: 2026-05-26
> Purpose: source-of-truth for Disco Cater admin portal replica build

---

## 1. Authentication & Authorization

- **Role string**: `SUPER_ADMIN` (`_system/_constants/authority.constant.ts:2`)
- **Route guard**: `AuthGuard` with `data: { authorities: [Authority.SUPER_ADMIN] }`
- **Entry path**: `/admin` (`app-routing.module.ts:94-99`)
- **JWT header**: raw `Authorization: <token>` — NO `Bearer` prefix (`_system/_interceptor/jwt/jwt.interceptor.ts:28-38`)
- **User object** in localStorage `currentUser`:

```json
{
  "reference": "UUID",
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "phoneNumber": "string",
  "enabled": "boolean",
  "authorization": "JWT token",
  "refreshToken": "string",
  "role": "SUPER_ADMIN",
  "temporary": "boolean",
  "restaurantReference": "string (optional)"
}
```

---

## 2. Sidebar Tabs (in order)

From `_system/_constants/paths.constant.ts:230-330` and `components/private/sidebar/sidebar.component.ts:104`.

| # | Title | Path under `/admin/` |
|---|---|---|
| 1 | Dashboard | `dashboard` |
| 2 | Orders | `manage-orders` |
| 3 | Content Management | `content-management` |
| 4 | Users | `manage-users` |
| 5 | Customers | `manage-customers` |
| 6 | System Admin | `manage-admins` |
| 7 | Restaurants | `manage-restaurants` (sub: Ordering, Marketplace, Import Menus) |
| 8 | Menus | `manage-menus` |
| 9 | Banking | `manage-banking` (Coming Soon) |
| 10 | Settings | `manage-settings` (Coming Soon) |

---

## 3. Routes & Component Files

All routes defined in `admin/admin-routing.module.ts`.

| Route | Component file |
|---|---|
| `/admin/dashboard` | `admin/dashboard/dashboard.component.ts` |
| `/admin/manage-orders` | `admin/admin-orders/admin-orders.component.ts` |
| `/admin/content-management` | `admin/content-management/content-management.component.ts` |
| `/admin/manage-users` | `admin/user-management/user-management.component.ts` |
| `/admin/manage-customers` | `admin/customers-management/customers-management.component.ts` |
| `/admin/manage-admins` | `admin/admin-management/admin-management.component.ts` |
| `/admin/manage-restaurants/ordering` | `admin/restaurant/restaurant-ordering/restaurant-ordering.component.ts` |
| `/admin/manage-restaurants/marketplace` | `admin/restaurant/restaurant-marketplace/restaurant-marketplace.component.ts` |
| `/admin/manage-restaurants/bulk-import-menu` | `admin/restaurant/import-bulk-menu-list/import-bulk-menu-list.component.ts` |
| `/admin/manage-restaurants/imported-restaurant-list/:id` | `admin/restaurant/uploaded-restaurant-list/uploaded-restaurant-list.component.ts` |
| `/admin/manage-menus` | `admin/admin-menus/admin-menus.component.ts` |
| `/admin/manage-banking` | (Coming Soon stub) |
| `/admin/manage-settings` | (Coming Soon stub) |

---

## 4. SUPER_ADMIN-only API endpoints

### Users
| Method | Endpoint | Service | Notes |
|---|---|---|---|
| GET | `/api/admin/users` | UserService.getAll | List all users; paginated + search |
| GET | `/api/admin/users/system-admin` | UserService.getSystemAdmins | Filter to SYSTEM_ADMIN role |
| POST | `/api/admin/users` | UserService.create | Create user |
| POST | `/api/admin/users/system-admin` | UserService.createBySuper | Create SYSTEM_ADMIN |
| PUT | `/api/admin/users/{ref}` | UserService.update | Update |
| PUT | `/api/admin/users/system-admin/{ref}` | UserService.updateBySuper | Update SYSTEM_ADMIN |
| DELETE | `/api/admin/users/{ref}` | UserService.delete | |
| PATCH | `/api/admin/users/{ref}/disable/toggle?isEnabled={bool}` | UserService.disabled | Enable/disable |

### Restaurants
| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/admin/restaurants?restaurantStatus={status}` | List ordering restaurants |
| GET | `/api/admin/restaurants/marketplace` | List marketplace restaurants |
| POST | `/api/admin/restaurants` | Create ordering restaurant; multipart with `restaurant` blob + optional `file` (menu CSV) |
| POST | `/api/admin/restaurants/marketplace` | Create marketplace restaurant |
| PUT | `/api/admin/restaurants/{ref}` | Update ordering |
| PUT | `/api/admin/restaurants/marketplace/{ref}` | Update marketplace |
| POST | `/api/admin/restaurants/{ref}?status={status}` | Change status (ACTIVE/INACTIVE/SUSPENDED/ARCHIVED) |
| POST | `/api/admin/restaurants/manage/block/{ref}?block={bool}` | Block/unblock |
| PATCH | `/api/admin/restaurants/{ref}/nashAllowed?nashAllowed={bool}` | Toggle Nash delivery |
| PATCH | `/api/admin/restaurants/{ref}/shipdayEnabled?shipdayEnabled={bool}` | Toggle Shipday |
| PUT | `/api/admin/restaurants/{ref}/resetPassword` | Reset admin password |

### Orders
| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/admin/userOrders` | All orders platform-wide |
| GET | `/api/admin/userOrders/{ref}?restaurantReference={r}` | Single order |
| PUT | `/api/admin/userOrders/{ref}/refund` | Body `{amount}` |
| PUT | `/api/admin/userOrders/{ref}/updateStatus?status={s}&restaurantReference={r}` | Update status |

### Customers
| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/customer/users` | Same endpoint as restaurant portal; SUPER_ADMIN sees all (no `restaurantReference` filter) |
| GET | `/api/customer/users/{ref}/orders` | Customer order history |

### Content Management
| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/admin/content-management` | Fetch site content (8 sections) |
| POST | `/api/admin/content-management` | Update site content |
| POST | `/public-api/images` | Upload images (multipart) |
| DELETE | `/public-api/images` | Remove images |

### Bulk Menu Import (external service)
| Method | Endpoint | Notes |
|---|---|---|
| GET | `https://menuuploadstg.familymeal.com/scraped-locations` | List import jobs |
| GET | `https://menuuploadstg.familymeal.com/scraped-locations/{id}/scraped-restaurants` | Scraped restaurants per location |
| PATCH | `https://menuuploadstg.familymeal.com/scraped-restaurants/{id}/retry` | Retry failed import |
| | x-api-key: `dd1c0019-8742-46dc-845d-096f074d84e7` | Header required for all of these |

---

## 5. Per-Page Details

### 5.1 Dashboard (`/admin/dashboard`)
Component: `admin/dashboard/dashboard.component.ts`
Sets `isHaveAuthorities` flag based on role. Uses `DashboardService` (not fully audited in this pass).

### 5.2 Orders (`/admin/manage-orders`)
Component: `admin/admin-orders/admin-orders.component.ts`
Table component: `admin/admin-orders/admin-orders-table/admin-orders-table.component.ts:34-43`

Columns: `createdDate`, `restaurantName`, `total`, `orderDate`, `orderDropOffTime`, `orderType`, `orderStatus`, `actions`

Order response (per row):
```json
{
  "orderReference": "string",
  "restaurantReference": "string",
  "restaurantName": "string",
  "restaurantTimezone": "string",
  "createdDate": "datetime",
  "orderDate": "date",
  "orderTime": "time",
  "orderDropOffTime": "datetime?",
  "orderType": "DELIVERY|PICKUP",
  "orderStatus": "string",
  "total": "decimal",
  "nashDeliveryPickupEta": "datetime?",
  "nashDeliveryDropoffEta": "datetime?"
}
```

### 5.3 Content Management (`/admin/content-management`)
Component: `admin/content-management/content-management.component.ts:142-331`
Service: `admin/content-management/content-management.service.ts:19-26`

8 sections (FormGroups):
- **section_1** — Hero: firstHeading, lastHeading, description, buttonText, url (image), urlText. `layoutId=heroSectionDto`
- **section_2** — 3-column: heading, iconDataList[{icon, iconDescription, iconHeading}]. `layoutId=threeColumnDto`
- **section_3** — Full-width CTA: heading, image, starredText, buttonText, bulletPoints[]. `layoutId=fullWidthCtaDto`
- **section_4** — 4-column: heading, iconDtoList[{icon, iconDescription, iconHeading}]. `layoutId=fourColumnDto`
- **section_5** — CTA banner: heading, image, description, buttonText. `layoutId=ctaBannerDto`
- **section_6** — FAQs: heading, faqsDtoList[{faqHeading, faqDescription}]. `layoutId=faqsDto`
- **section_7** — Process: heading, headingTagLine, buttonText, image, steps[]. `layoutId=processBoxDto`
- **section_8** — Marquee icons: iconsList[]. `layoutId=marqueeIconsDto`

### 5.4 Users (`/admin/manage-users`)
Component: `admin/user-management/user-management.component.ts`
Table columns: `name`, `email`, `createdDate`, `lastOrder`, `actions`

Query params for GET: `page`, `size`, `sort`, `search`, `fromDate`, `toDate`

Response shape (paginated, FM standard `{content, totalElements, totalPages}`):
```json
{
  "reference": "string",
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "phoneNumber": "string",
  "enabled": "boolean",
  "role": "string",
  "createdDate": "datetime",
  "lastOrder": "datetime?"
}
```

### 5.5 Customers (`/admin/manage-customers`)
Component: `admin/customers-management/customers-management.component.ts`
Table columns: `username`, `email`, `numberOfOrders`, `sourceoforder`, `totalspend`
Has PDF export (jsPDF + autoTable).

### 5.6 System Admins (`/admin/manage-admins`)
Component: `admin/admin-management/admin-management.component.ts`
Table columns: `name`, `email`, `locations`, `actions`
Dialog component: `UpdateAdminComponent`

Create body:
```json
{
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "phoneNumber": "string",
  "role": "SYSTEM_ADMIN"
}
```

### 5.7 Restaurants — Ordering (`/admin/manage-restaurants/ordering`)
Component: `admin/restaurant/restaurant-ordering/restaurant-ordering.component.ts`
Table component: `admin/restaurant/restaurant-table/restaurant-table.component.ts:36`

Columns: `blocked`, `businessName`, `adminName`, `adminEmail`, `createdDate`, `url`, `status`, `nash`, `holdPayments`, `shipdayEnabled`, `actions`

Restaurant response shape (key fields):
```json
{
  "reference": "string",
  "businessName": "string",
  "address": { "addressLine1", "addressLine2", "city", "state", "zipcode", "latitude", "longitude", "phoneNumber" },
  "admin": { "firstName", "lastName", "email", "phoneNumber" },
  "createdDate": "datetime",
  "adminName": "string",
  "adminEmail": "string",
  "url": "string",
  "blocked": "boolean",
  "nashAllowed": "boolean",
  "shipdayEnabled": "boolean",
  "holdPayments": "boolean",
  "onlineOrderingAllowed": "boolean",
  "restaurantStatus": "ACTIVE|INACTIVE|SUSPENDED|ARCHIVED"
}
```

Add Restaurant form (`admin/restaurant/update/add-restaurant/add-restaurant.component.ts:97-119`):
- restaurantName (req), addressLine1 (req), addressLine2, city (req), state (req), zipcode (req + pattern), phoneNumber (req)
- firstName (req), lastName (req), email (req + pattern)
- categories (multi, ≥1), fulfillmentOptions (multi: PICKUP/DELIVERY, ≥1)
- lead_gen_1, lead_gen_2 (optional)

### 5.8 Restaurants — Marketplace (`/admin/manage-restaurants/marketplace`)
Same restaurant model with `type='MARKETPLACE'`. Reduced table columns: `blocked`, `businessName`, `adminName`, `url`, `actions`.

### 5.9 Bulk Menu Import (`/admin/manage-restaurants/bulk-import-menu`)
Component: `admin/restaurant/import-bulk-menu-list/import-bulk-menu-list.component.ts:28`
Hits external `menuuploadstg.familymeal.com` service with API key.
Table columns: `location`, `total_restaurant_count`, `comp_restaurant_count`, `err_restaurant_count`, `created_at`, `status`, `actions`
Route param `id` is base64-encoded location ID.

### 5.10 Menus (`/admin/manage-menus`)
Component: `admin/admin-menus/admin-menus.component.ts` — stub/minimal. Functionality may live in child/table components not deeply audited.

### 5.11 Banking + Settings
Both render `<app-coming-soon>` template. Expected: platform Stripe config, fee templates, tax templates, service charges, delivery zones, coupons.

---

## 6. SUPER_ADMIN vs SYSTEM_ADMIN vs ADMIN

| Capability | SUPER_ADMIN | SYSTEM_ADMIN | ADMIN |
|---|---|---|---|
| Platform-wide orders | ✓ | ✗ | ✗ (own restaurant only) |
| Manage restaurants (all) | ✓ (create/edit/block/status) | ✗ | ✗ |
| Manage SYSTEM_ADMIN users | ✓ | ✗ | ✗ |
| Manage all users | ✓ | ✗ | ✗ |
| Platform customers | ✓ (all) | scoped to chain | scoped to one restaurant |
| Website content | ✓ | ✗ | ✗ |
| Banking config | ✓ (coming soon) | ✗ | ✗ |
| Settings | ✓ (coming soon) | ✗ | ✗ |
| Bulk menu import | ✓ | ✗ | ✗ |
| Restaurant menus/account/settings/tax | ✗ | ✓ (impersonating) | ✓ |

Entry paths:
- SUPER_ADMIN → `/admin`
- SYSTEM_ADMIN → `/manage`
- ADMIN → `/restaurant`

---

## 7. Conventions

- **Pagination**: `page` (0-based), `size`, `sort` (string array). Response: `{content, totalElements, totalPages}`. Sizes: 25/50/100/250. localStorage key `currentPaginationSize`.
- **Image upload**: multipart POST `/public-api/images`; download `/public-api/images/{ref}/download?size=...`
- **Confirmations**: `ConfirmationDialogComponent` for destructive actions
- **Toasts**: `toast-done` / `toast-danger` via `ToastrMessageService`
- **Validation patterns**: `EMAIL_PATTERN`, `ZIPCODE_PATTERN` in `_system/_constants/`
- **Address autocomplete**: Google Places
- **Rich text**: Quill toolbar (Content Management)

---

## 8. Known gaps in this audit

1. `DashboardService` endpoints for SUPER_ADMIN dashboard not fully traced — likely `/api/admin/dashboard/*` or reuses `/api/system-admin/dashboard/*`. Need to dig into the dashboard component template/service when building.
2. `admin-menus` component is sparse — global menu management functionality may live in subcomponents.
3. `admin-banking` and `admin-settings` are Coming Soon stubs in FM — defer until FM ships them.
4. `UpdateAdminComponent` (System Admin edit dialog) fields not fully captured — read source when building.
5. `RestaurantTableComponent` action menu items not enumerated — read template when building.

---

## 9. Recommended build order for Disco Cater admin portal

1. Login + auth + cookie + middleware
2. Layout + sidebar (full 10-tab sidebar even if some pages are stubs)
3. Restaurants → Ordering (most-used)
4. Orders
5. Customers
6. Users / System Admins
7. Dashboard
8. Bulk Menu Import (external API; needs API key)
9. Content Management (complex form; defer)
10. Menus / Banking / Settings (stubs)
