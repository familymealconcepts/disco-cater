# Revyrie Ticket — SUPER_ADMIN "View as SYSTEM_ADMIN" Impersonation

**Title:** Add audit-logged SUPER_ADMIN impersonation of SYSTEM_ADMIN sessions

**One-line summary:** Replace the current practice of FM staff logging in with shared SYSTEM_ADMIN credentials (no audit trail) with a proper impersonation flow — SUPER_ADMIN clicks "View as", assumes a short-lived scoped session, and every action is audit-logged as "by [SUPER_ADMIN] as [SYSTEM_ADMIN]".

---

## Background — the security & audit gap

Today, when an FM employee needs to make changes on behalf of a restaurant group, they log in directly as that group's SYSTEM_ADMIN — using shared or reset credentials. Problems:

- **No audit trail.** Actions appear to come from the SYSTEM_ADMIN, not the FM employee who actually performed them. There's no record of who did what.
- **Credential sprawl.** Staff need the SYSTEM_ADMIN's password (or to reset it, locking out the real user).
- **No scoping.** The employee gets the full SYSTEM_ADMIN session indefinitely, not a time-boxed one.

This is the standard SaaS "impersonation" / "login as" pattern, which every mature multi-tenant platform has. FM doesn't have it yet.

---

## Proposed flow

1. SUPER_ADMIN, on the `/admin/manage-admins` System Admins list, clicks **"View as"** on a SYSTEM_ADMIN row.
2. Frontend calls `POST /api/admin/impersonate/{system-admin-ref}`.
3. FM mints a **short-lived impersonation JWT** (suggest 10-minute expiry) carrying BOTH:
   - `sub` — the SYSTEM_ADMIN being impersonated (so all FM endpoints scope to their assigned locations exactly as if they'd logged in)
   - `act` — the SUPER_ADMIN actor doing the impersonating (RFC 8693 "actor" claim, or a custom `impersonatedBy` claim)
4. Frontend stores the impersonation token (separate cookie, e.g. `fm_impersonation_token`), and redirects to `/restaurant/*` — the SYSTEM_ADMIN's portal.
5. A persistent banner shows "Viewing as [SYSTEM_ADMIN name] — End impersonation" while active.
6. Every mutating FM call made under the impersonation token is recorded in FM's audit log tagged with both the subject and the actor: **"Order refunded by chef@familymeal.com acting as westwoods-admin@…"**.
7. **Exit:** "End impersonation" discards the impersonation token, restores the SUPER_ADMIN's original admin token, and returns to `/admin/manage-admins`.

---

## Endpoint

```
POST /api/admin/impersonate/{system-admin-ref}
  Auth: SUPER_ADMIN only
  Returns: { token: string, expiresAt: ISO8601, subject: { reference, firstName, lastName, email }, actor: { reference, email } }
```

Optionally:
```
POST /api/admin/impersonate/{system-admin-ref}/end   (or just client-side token discard)
```

---

## JWT claims

The impersonation token should decode to something like:

```json
{
  "sub": "<system-admin-reference>",
  "role": "SYSTEM_ADMIN",
  "restaurant": "<…or the SA's normal claim shape…>",
  "act": { "sub": "<super-admin-reference>", "role": "SUPER_ADMIN" },
  "impersonation": true,
  "exp": "<now + 10min>"
}
```

The `act` claim is what the audit log reads to attribute actions. FM's existing JWT filter already scopes by `sub`/`role`, so the impersonated session automatically gets the right location access — no separate ACL work.

---

## Audit log requirements

- Every write (order status change, refund, menu edit, settings change, user invite, etc.) performed under an impersonation token must record: timestamp, action, target, the `sub` (impersonated SA), AND the `act` (real SUPER_ADMIN).
- Reads need not be logged (or log at a lower level) — focus on mutations.
- The audit log should be queryable by actor ("show everything chef@familymeal.com did while impersonating") and by subject ("show everything done to Westwoods, including by impersonators").
- This likely requires a new `audit_log` table if one doesn't exist (Project Orca flagged audit trails as not-yet-built — see `docs/project-orca-scope.md`).

---

## Edge cases

1. **Impersonation token expires mid-session** — frontend detects 401, shows "Impersonation session expired", returns to admin portal. Do NOT silently refresh an impersonation token (defeats the time-box); require a fresh "View as" click.
2. **Target SA is disabled/archived** — `POST /impersonate` returns 409/422; frontend shows "This account is disabled and can't be impersonated."
3. **SUPER_ADMIN's own token expired** — the impersonate endpoint itself 401s; frontend bounces to admin login.
4. **Nested impersonation** — disallow. An impersonation token cannot mint another impersonation token (reject if `act` already present).
5. **Sensitive actions while impersonating** — consider blocking irreversible actions (delete restaurant, payout changes) under impersonation, or require the SUPER_ADMIN's own re-auth. `[NEEDS REVIEW with Peter]`.

---

## Acceptance criteria

1. SUPER_ADMIN clicks "View as" on a SYSTEM_ADMIN → lands in that SA's restaurant portal, sees exactly the SA's assigned locations (no more, no less).
2. A banner clearly indicates impersonation is active with an "End impersonation" control.
3. An order action taken while impersonating shows in the audit log attributed to BOTH the SA and the SUPER_ADMIN.
4. Token expires after 10 minutes → session ends gracefully.
5. "End impersonation" restores the SUPER_ADMIN to the admin portal with their original privileges intact.
6. A SYSTEM_ADMIN cannot themselves impersonate (endpoint is SUPER_ADMIN-only).
7. Cross-location safety holds: impersonating SA-with-locations-[A,B] gives access to A and B only, never C.

---

## Estimated effort

Developer guess: **3–5 days.** The token minting + claim shape + endpoint is ~1 day; the audit-log table + attribution wiring is the bulk (2–3 days, more if no audit infrastructure exists yet); edge cases + QA ~1 day. If Project Orca's audit-log work lands first, this drops to ~2 days.

---

## Disco Cater frontend changes that follow once shipped

1. "View as" button on each row in `app/(admin)/admin/(protected)/manage-admins/page.tsx`.
2. New proxy `app/api/admin/impersonate/[ref]/route.ts` (POST) returning the impersonation token; set it as `fm_impersonation_token` cookie.
3. Middleware update: when `fm_impersonation_token` is present, treat `/restaurant/*` routes as authenticated under it (precedence over `fm_admin_token`).
4. A persistent impersonation banner component, shown across `/restaurant/*` while the token is active, with the "End impersonation" action that clears the cookie and redirects to `/admin/manage-admins`.
5. The existing `SelectedRestaurantContext` and sidebar gating already handle the SYSTEM_ADMIN experience — impersonation just swaps which token drives them.

Note: this supersedes the current ad-hoc "log in as the SA directly" workaround. Until shipped, FM staff continue using direct login.
