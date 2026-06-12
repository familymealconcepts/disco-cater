# Revyrie Ticket — Suppress USER Welcome Email for Restaurant-Admin Creation

**Title:** Don't send the USER welcome email to restaurant ADMINs provisioned via `POST /api/admin/restaurants`

**One-line summary:** When Disco Cater creates a restaurant through the SUPER_ADMIN service account, FM emails the new ADMIN the generic USER welcome template (wrong copy, wrong branding). That email should be suppressed for accounts created this way.

---

## Background & why

The Disco Cater "become a partner" flow creates a restaurant (and its ADMIN account) in a single call:

- `POST /api/admin/restaurants` (multipart/form-data, `restaurant` part as JSON), authenticated with our **SUPER_ADMIN service account** (`FM_ADMIN_EMAIL` / `FM_ADMIN_PASSWORD`).
- The `restaurant.admin` block (`{ email, firstName, lastName, password }`) is what provisions the ADMIN login.

There is **no separate FM USER registration** in this flow anymore — we removed it because FM keeps USER and restaurant-ADMIN accounts distinct and the USER never gained restaurant access.

The problem: provisioning the ADMIN this way still fires FM's **USER welcome email**. For a restaurant partner that template is wrong on two counts:

1. **Wrong template/content** — it's the consumer/diner "welcome to FamilyMeal" copy, not a restaurant-partner onboarding email. It references diner features the partner can't use.
2. **Wrong branding** — it's FamilyMeal-branded, but these partners signed up through **Disco Cater** and have never heard of FamilyMeal. It looks like a phishing / misdirected email.

The partner *does* need the **temporary-password email** (so they can set their password at `/reset-password`), so the fix is to suppress only the generic USER welcome — not all mail to the account.

---

## Requested change

Suppress the USER welcome email when the account is created as the `admin` of a restaurant via `POST /api/admin/restaurants` (i.e. service-account / SUPER_ADMIN-initiated restaurant creation).

Options, in order of preference:

1. **Don't trigger the USER welcome at all** for admins created through the restaurant-creation path. The restaurant-admin creation path is distinct from self-serve USER `/registration`, so the welcome hook can branch on that.
2. **Add a request flag** — e.g. `suppressWelcomeEmail: true` on the restaurant payload (or a `?suppressWelcomeEmail=true` query param) that our service-account call sets — and skip the welcome send when present.
3. At minimum, **keep sending the temporary-password / set-password email** regardless — that one is required for the partner to finish onboarding.

---

## Acceptance criteria

- Creating a restaurant via `POST /api/admin/restaurants` (SUPER_ADMIN service account) with an `admin` block does **not** send the generic USER welcome email.
- The new ADMIN still receives the temporary-password email needed to set their password.
- Self-serve consumer `POST /registration` is unaffected (still sends its welcome email).

---

## Disco-side context

- Caller: `app/api/become-a-partner/create-restaurant/route.ts` (uses `lib/fm-service-auth.ts` → SUPER_ADMIN JWT).
- Partner-facing flow: `app/become-a-partner/BecomeAPartnerClient.tsx`. Our success screen now tells partners to check email for the **temporary password**, set a new one at `/reset-password`, then log in at `/restaurant/login`.
- If FM exposes option (2) (a suppress flag), we'll set it on our create call — tell us the exact field/param name.
