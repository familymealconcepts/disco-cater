# FM Authorized Users — Restaurant Portal (SYSTEM_ADMIN) Audit

> Read-only audit, written 2026-05-27. Source of truth for the SYSTEM_ADMIN "Authorized Users" page in the restaurant portal. Different from the SUPER_ADMIN's `manage-admins` page (covered in `docs/fm-super-admin-audit.md`).
>
> One surprise finding: FM has shipped a **`REGIONAL_ADMIN`** role in its sidebar constants — Project Orca 3.1 turns out to be partially built already. See § A.7.

---

## Section A — FM source map

### A.1 List view

**Component**: `admin-manager/authorized-users/authorized-users.component.ts:15-171`. Template: same dir `.html`.

**Endpoint**: `GET /api/system-admin/users` — service method `userService.getManagedUsers(null, this.pagination)` (`_system/_services/user/user.service.ts:19`).

Pagination shape:

```ts
{ page: number, size: number, sort: string[] }
// default size = 25
// available page sizes = [25, 50, 100, 250]
```

**Displayed columns** (`authorized-users.component.ts:27`):

```ts
columnsToDisplay = ['firstName', 'role', 'email', 'createdDate', 'actions']
```

| Column header | Cell binding |
|---|---|
| NAME: | `{{element.firstName}} {{element.lastName}}` |
| ROLE: | `{{element.role === 'ADMIN' ? 'Restaurant User' : 'System Admin'}}` (template line 24) |
| EMAIL: | `{{element.email}}` |
| REGISTRATION: | `{{element.createdDate | date:'MM/dd/YY'}}` |
| ACTIONS | Edit, Delete (hidden if `element.locked`), `more_horiz` menu with "Send Password Reset" |

**Role enum vs display**:

```
'SYSTEM_ADMIN'  →  "System Admin"
'ADMIN'         →  "Restaurant User"
```

Tier 2 ("regional admin with a subset of locations") is — surprisingly — its own enum value in FM: `'REGIONAL_ADMIN'`. See § A.7.

### A.2 Create user dialog

**Component**: `admin-manager/authorized-users/update-authorized-users/update-authorized-users.component.ts:1-183`. Same component handles both create and edit (toggled by `data` being passed in or not — line 132).

**Endpoint on save**:

```
POST /api/system-admin/users                       (create)
PUT  /api/system-admin/users/{reference}           (update)
DELETE /api/system-admin/users/{reference}         (delete — list page)
```

Service methods: `userService.createByRestaurant(req)` / `updateByRestaurant(req, ref)` / `deleteByRestaurant(ref)` (`user.service.ts:19, 49, 106-107`).

**Form definition** (`update-authorized-users.component.ts:113-128`):

```ts
{
  firstName:           [null, Validators.required, minLength(1), maxLength(50)],
  lastName:            [null, Validators.required, minLength(1), maxLength(50)],
  email:               [null, Validators.required, Validators.pattern(EMAIL_PATTERN)],
  role:                [null, Validators.required],
  restaurantReference: [null, Validators.required]
}
```

**Role selector** (lines 27-36):

```ts
roles = [
  { name: 'System Admin',     key: 'SYSTEM_ADMIN' },
  { name: 'Restaurant User',  key: 'ADMIN' },
]
```

Submits the `key` value.

**Location picker — critical bit** (template lines 51-70):

- `role === 'SYSTEM_ADMIN'` → `<mat-select multiple>` (multi-select)
- `role === 'ADMIN'`        → `<mat-select>` (single-select)

Both populate from `locations` — see § A.5.

**Request body shape** (lines 78-84):

```ts
{
  firstName,
  lastName,
  email,
  role: 'SYSTEM_ADMIN' | 'ADMIN',
  restaurantReference:
    role === 'SYSTEM_ADMIN'
      ? string[]           // multi-select values
      : [ string ]         // single-select wrapped in array
}
```

Note: `restaurantReference` is **always an array** on the wire, even for single-location ADMIN. FM normalizes server-side.

**No password field on create.** FM either uses an invite-link flow or auto-generates and emails. The list-page "Send Password Reset" action triggers the reset flow.

### A.3 Edit user dialog

Same component, opened with `data: { user }` (line 132). On open, `patchValue`:

```ts
{
  firstName, lastName, email, role,
  restaurantReference:
    user.role === 'SYSTEM_ADMIN'
      ? user.restaurantReferences        // array
      : user.restaurant?.reference       // single ref
}
```

**Editable**: firstName, lastName, email, role, restaurantReference. Email changes tracked via `isEmailChanged` flag (line 85) — relevant if FM re-invites on email change.

**Locked**: none in the form itself. Row-level lock (`element.locked === true`) hides Edit/Delete from the list. We'll mirror that.

### A.4 Delete user

Endpoint: `DELETE /api/system-admin/users/{reference}`.

Confirmation: `ConfirmationDialogComponent` (`authorized-users.component.ts:122-138`). Title "Do you want to delete?", description "All data of this user will be lost.", action button "Delete".

Soft vs hard delete: response is void; backend behavior not visible in Angular source. **`[NEEDS REVIEW]`** — Disco Cater treats deletion as final (matching FM's UI copy).

### A.5 Location picker source — the most important question

**Endpoint**: `GET /api/system-admin/restaurants/list` (`restaurant.service.ts:31`, `getSystemAdminRestaurants()` at line 396-408).

Flat array (NOT paginated). Each item has at minimum:

```ts
{
  reference: string,
  businessName: string,
  editable: boolean,        // disabled in picker when false
}
```

**Backend security guarantee**: this endpoint MUST return only the inviter's assigned locations (not the platform's full 700). The Angular client doesn't filter — it trusts the server. Confirmed by inspection: the picker shows whatever the endpoint returns, no client-side filter against an assignedLocations cache. **`[NEEDS REVIEW]` against backend**, but the URL semantics (`/api/system-admin/restaurants/list` scoped under the SA's JWT) strongly imply it.

### A.6 Sidebar gating

`paths.constant.ts:14` exports `SIDEBAR_PATHS_LIST` keyed by role. `sidebar.component.ts:101-104`:

```ts
const role = this.jwtService.role(this.authenticationService.currentUserValue)
this.paths = SIDEBAR_PATHS_LIST[role]
```

Role keys + their nav items in FM:

| Role | Nav items (from `paths.constant.ts`) |
|---|---|
| `ADMIN` (lines 125-176) | Reporting, Orders, Manage Menus (Menus / Groups / Modifiers), Settings, Account (Profile / Banking) |
| `SYSTEM_ADMIN` (15-80) | Reporting, Locations, Authorized Users, Orders, Links, Reports, Customers |
| `REGIONAL_ADMIN` (81-124) | Reporting, Locations, Authorized Users, Orders, Global Menu, Reports |

**ADMIN does NOT see**: Authorized Users, Locations, Links, Reports, Customers. Just their own restaurant's operational items. ✅ matches Peter's spec.

### A.7 Surprise — `REGIONAL_ADMIN` is already a role

FM has a third role string `REGIONAL_ADMIN` in `paths.constant.ts:81-124` with its own sidebar (Reporting / Locations / Authorized Users / Orders / Global Menu / Reports). This is the "tier 2" role from Peter's spec — functionally a SYSTEM_ADMIN scoped to a subset.

What this means:

- Peter's spec said tier 2 is stored as `SYSTEM_ADMIN` until Project Orca 3.1 formalizes it. **FM has already shipped the role enum.** But the create-user dialog only offers two options (`SYSTEM_ADMIN`, `ADMIN`) — Regional Admins must be created/managed via a path I didn't find in this audit.
- Disco Cater should still implement two role options in the dialog (matching FM's UI), and treat `REGIONAL_ADMIN` users that come back from the list as a third display string. We'll do the bare minimum: render "Regional Admin" in the role cell if the row has that enum, leave the create dialog at two options.

`[NEEDS REVIEW]` — confirm with Peter whether to surface a Regional Admin option in the create dialog now or wait for Orca 3.1.

---

## Section B — Disco Cater state inventory

### B.1 Existing page

`app/(restaurant)/restaurant/(portal)/manage/authorized-users/page.tsx` (173 lines) has:

- ✅ List with columns Name / Role / Email / Created / Actions
- ✅ Edit dialog with firstName / lastName / email / role
- ✅ Reset Password action
- ✅ Delete with confirm
- ❌ No Create / Add User button
- ❌ No location picker (edit or create)
- ❌ Role displays raw enum ("ADMIN", "SYSTEM_ADMIN") instead of FM's "Restaurant User" / "System Admin"
- ❌ Role dropdown includes bogus values (`'RESTAURANT_USER'`, `'USER'`) that aren't in FM's two-option list
- ❌ Locked-row check (`element.locked`) not honored

### B.2 Existing proxies

| Proxy | FM endpoint | Status |
|---|---|---|
| GET `/api/restaurant/authorized-users` | GET `/api/system-admin/users` | ✅ exists |
| PUT `/api/restaurant/authorized-users/[ref]` | PUT `/api/system-admin/users/{ref}` | ✅ exists |
| DELETE `/api/restaurant/authorized-users/[ref]` | DELETE `/api/system-admin/users/{ref}` | ✅ exists |
| PUT `/api/restaurant/authorized-users/[ref]/reset-password` | PUT `/api/system-admin/users/{ref}/reset-password` | ✅ exists |
| **POST `/api/restaurant/authorized-users`** | POST `/api/system-admin/users` | ❌ **missing** |
| **GET `/api/restaurant/system-admin-restaurants`** | GET `/api/system-admin/restaurants/list` | ❌ **missing** |

### B.3 Sidebar gating in Disco Cater

`app/(restaurant)/restaurant/(portal)/layout.tsx` currently lists "Authorized Users" at line 35. The full sidebar audit was done in previous sessions and gating for ADMIN vs SYSTEM_ADMIN is already implemented per `docs/fm-super-admin-audit.md`. **`[NEEDS REVIEW]`** — confirm `REGIONAL_ADMIN` would also see Authorized Users; current Disco Cater code may not handle this role string at all.

---

## Section C — Changes landed this turn

| ID | Change |
|---|---|
| C.1 | Audit doc (this file) |
| C.2 | POST handler added to `/api/restaurant/authorized-users` |
| C.3 | New proxy `/api/restaurant/system-admin-restaurants` → FM `/api/system-admin/restaurants/list` |
| C.4 | Page rewrite: Add User button + dialog with role-conditional location picker (multi for SYSTEM_ADMIN, single for ADMIN), FM display strings, validation per § A.2 |
| C.5 | Edit dialog reuses same picker shape |
| C.6 | Role display in list now maps the enum to FM's friendly strings |

### Sidebar gating — verified, no change needed

`app/(restaurant)/restaurant/(portal)/layout.tsx`:
- `isSystemAdmin = role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN'` (line 89)
- ADMIN role → `inRestaurantUserView = true` → `NAV = RESTAURANT_USER_NAV` (line 104)
- `RESTAURANT_USER_NAV` (lines 44-63) has NO "Authorized Users" entry — only `SYSTEM_ADMIN_NAV` (line 35) exposes it.

So an ADMIN-role user cannot see or reach Authorized Users from the sidebar. ✅ The security-relevant gating is correct.

**Known gap (out of scope this session)**: `REGIONAL_ADMIN` role is unhandled in Disco Cater's layout — `isSystemAdmin` only checks SYSTEM_ADMIN/SUPER_ADMIN, so a REGIONAL_ADMIN user would fall to `RESTAURANT_USER_NAV` and lose access to Authorized Users / Locations even though FM grants it. No REGIONAL_ADMIN users exist to test against yet; flagged for the Project Orca 3.1 session.

**Note on RESTAURANT_USER_NAV item list**: it includes Tax Rate + Customers and omits Reporting, which diverges from FM's raw ADMIN nav (Reporting / Orders / Manage Menus / Settings / Account). This was Peter's explicit spec from the SUPER_ADMIN-sidebar session ("Mode B = Orders / Manage Menus / Settings / Account / Tax Rate / Customers, no Reporting"), not a bug — left as-is per that instruction.

---

## Section D — Security notes

- The picker source is `/api/system-admin/restaurants/list` — FM's backend filters by JWT, so a SYSTEM_ADMIN only sees their own locations. **Confirmed in spec, `[NEEDS REVIEW]` against actual backend behavior** (per `docs/fm-marketplace-and-access-audit.md` Finding 2 — the Angular client trusts the server filter).
- Client-side defense in depth: the picker only renders locations from the scoped endpoint, so the inviter can't even select forbidden locations.
- Audit log: FM source does not show who-invited-whom tracking. Project Orca audit-log work would add this; not in scope for this session.

---

## Section E — Performance

The picker endpoint returns ≤30 entries typically (SYSTEM_ADMIN's assigned locations only). No pagination needed. If load time exceeds ~500ms, that's an FM backend issue — not in scope to fix here.

---

## Section F — Verification checklist for Peter

After deploy:

### F.1 — As `chef@familymeal.com` (SYSTEM_ADMIN, multiple locations)
1. Sidebar shows "Authorized Users" item — click it.
2. List renders with columns Name / Role / Email / Created / Actions. Role cell shows "System Admin" / "Restaurant User" (not the raw enum).
3. Click `+ Add User` → dialog opens. Network tab: `GET /api/restaurant/system-admin-restaurants` fires once, returns ONLY your assigned locations (not all 700).
4. Pick role = "System Admin" → location picker becomes multi-select. Pick 2 locations, fill name + email → Save → success, user appears in list.
5. Pick role = "Restaurant User" → location picker becomes single-select. Save → user appears.
6. Edit an existing user → dialog opens with their role + locations pre-selected. Change locations → Save → persists on reload.
7. Delete → confirm → row gone.

### F.2 — As an ADMIN-role user (single location)
1. Sidebar does NOT show Authorized Users / Locations / Links / Reports / Customers.
2. Sees only their operational items.

### F.3 — Role gating defense
1. As `chef`, open Authorized Users, click + Add User. Try to forge a `restaurantReference` for a location chef isn't assigned to via DevTools (edit the network request).
2. FM should reject the request with 403. **`[NEEDS REVIEW]` against backend.**

---

## Open questions for Peter

1. **`REGIONAL_ADMIN` role**: FM has already shipped this enum — should Disco Cater offer it as a third option in the create dialog (alongside System Admin / Restaurant User)? Or wait for Project Orca 3.1?
2. **`element.locked` rows**: FM hides Edit/Delete when `locked: true`. Should Disco Cater mirror this? (My implementation does.)
3. **Backend enforcement** of the security boundary in § A.5 — has this been verified end-to-end via live test, or is the audit doc's `[NEEDS REVIEW]` still open?
4. **`createByRestaurant` vs `createByAdmin`** — FM source uses the former for SYSTEM_ADMIN-invokers. Confirming this is the right endpoint for our use case (it is, per the URL).
