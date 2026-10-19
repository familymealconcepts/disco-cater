# Disco Cater — Project Reference

*Consolidated 2026-09-20. Supersedes `disco-cater-status.md` (June 4, 2026), which is now wrong in several material ways — it lists Sanity as the data source, Revyrie as an active vendor, and describes the platform as FM-backed rather than mid-conversion.*

---

## 1. What this project is

Peter Venti is founder/operator of **FamilyMeal Concepts Inc.** and **Disco Cater** (discocater.com), a nationwide premium restaurant catering marketplace.

The core work is migrating off **FamilyMeal (FM)** — a Java/Spring backend historically built and operated by Revyrie — toward a fully standalone **Next.js / Neon Postgres** architecture, converting restaurants one at a time to "Disco-native" operation.

As of September 2026 the conversion is actively underway, with the remaining restaurants expected to convert over the following weeks. FamilyMeal is frozen: no further updates or deploys are planned.

---

## 2. Architecture

**Two codebases:**

| Repo | Purpose | Stack |
|---|---|---|
| `disco-cater` | Main platform — marketplace, restaurant portal, super admin | Next.js (App Router), Neon Postgres, Vercel |
| `noise-machine` | Internal CRM / outreach dashboard | Repo under KevinFMDC's GitHub, org transfer pending |

**FM source of truth for behavior:**
- `familymeal-java-backend` (GitHub) — backend
- `familymeal_client_ui` (GitLab, mirrored to `familymealconcepts` GitHub org) — Angular frontend
- Local: `/Users/peterventi/Desktop/VS Code/familymeal-java-backend`

**Infrastructure:**
- FM API: `api.familymeal.com` — droplet `prod-api-familymeal`, 68.183.151.221, DigitalOcean
- FM frontend: droplet `prod-familymeal`, 159.203.124.139
- Disco: Vercel, auto-deploys on push to `main`
- Neon Postgres — sole source of truth for Disco restaurant data
- Stripe Connect (FamilyMeal Live Stripe account — shared platform account)
- Mailgun (`mg.discocater.com`), Twilio (SMS), Expedite/dlivrd (3P delivery dispatch)
- Sanity CMS — **fully sunset** from all customer-facing reads

---

## 3. The FM-backed vs. Disco-native distinction

This is the single most important architectural rule.

**FM-backed restaurants** correctly rely on FM for auth, portal CRUD, and order placement. This is intentional, settled architecture. Do not propose fixing or removing these FM dependencies.

**Disco-native restaurants and their users must never call, read from, or write to FamilyMeal in any way.** This is a hard requirement. Audits should only flag the latter as real gaps.

**Important caveat, learned 2026-09-20:** most restaurant-facing areas have *two* implementations — an FM-backed route and a native route — with the portal selecting between them. A route lacking a native gate is **not** evidence that native support doesn't exist. Several FM routes (`/api/restaurant/business-info`, `/api/restaurant/scheduling`) are dead code with zero callers. Always check for a native counterpart before flagging anything.

Known native paths:

| Area | FM-backed route | Native path |
|---|---|---|
| Authorized users | `/api/restaurant/authorized-users` | `/api/restaurant/team*` → `disco_restaurant_accounts` + `disco_restaurant_location_access` |
| Fees & tips | `/api/restaurant/fees-and-tips` | `/api/restaurant/disco-menus` → `disco_menus` money columns |
| Scheduling | `/api/restaurant/scheduling` (dead) | `disco_menus` availability columns |
| Business info | `/api/restaurant/business-info` (dead) | `disco_restaurant_cache` / disco-settings |
| Menus | `/api/restaurant/menus` | `/restaurant/menu-manager` → `disco_menus` |

Guards must key on **the restaurant**, not the session cookie — the pattern used in `app/api/restaurant/team/route.ts` (`isDiscoNativeRestaurant(targetRef)`). A cookie-based guard silently no-ops for a Disco-native session, because native sessions have no `fm_restaurant_token`.

---

## 4. Conversion

- Standard path: **`convertToNative`** (capability-based — checks the Stripe account can accept and pay out). Never `goLiveNativeRestaurant`, which demands a manual live-charge attestation that doesn't scale and isn't independently re-verified.
- Conversions default to `visible = true`, `is_live = true`.
- **Stripe is not a conversion gate** — every restaurant converts regardless of Stripe status.
- FM stays live after conversion by deliberate policy ("cooperation not lockout"). Restaurants are expected to stop using their FM URLs on their own. Peter handles that conversation manually.
- Do not raise marketplace visibility, `is_live`, or "should this restaurant appear on the marketplace" as concerns — these are deliberate product decisions.

---

## 5. Roles

All FM role logic, permissions, and access control are mirrored **exactly**. Only frontend appearance, design, and minor UX improvements are permitted. If a prompt asks to change role functionality — refuse and flag it.

| FM role | Disco Cater meaning |
|---|---|
| `USER` | Diner |
| `ADMIN` | Restaurant staff (single location) |
| `SYSTEM_ADMIN` | Restaurant owner |
| `SUPER_ADMIN` | Disco Cater team |

Three functional tiers exist via two role strings:
1. `SYSTEM_ADMIN` with all locations = system admin
2. `SYSTEM_ADMIN` with a subset = regional admin (implicit, not a separate FM role — Project Orca 3.1 may formalize this)
3. `ADMIN` = single-location restaurant user

Test accounts: `peter@familymeal.com` (SUPER_ADMIN, use for super admin portal testing), `chef@familymeal.com` (SYSTEM_ADMIN, restaurant-level, *not* super admin).

---

## 6. Business model

**Two order sources:**

| Source value | Label | URL | Lead-gen fee |
|---|---|---|---|
| `FAMILYMEAL` | 1P | `/order/[slug]` | None |
| `DISCO` | 3P | `/restaurants/[slug]` | Applies |

- Restaurant portal shows only the 1P link. The 3P marketplace URL is Disco-employee-controlled.
- **Direct entry orders default to 1P.** The restaurant is creating the order itself, so it isn't a marketplace order and carries no lead-gen fee. The field remains editable.
- **Lead-gen rates:** converted restaurants carry FM's `lead_gen_one` / `lead_gen_two` rates (most are 0/0), *not* Disco's 15/5 defaults. The 15/5 default applies only to restaurants created new on Disco Cater.
- **3P delivery fee:** customer charged 15% of subtotal, capped at $85. Disco keeps 100% of tips (invoiced separately by DoorDash/Expedite). Verify against actual `native-checkout.ts` logic.

**Revenue statuses** — COMPLETED, DUE, PAID, and PARTIAL_REFUND are all real revenue.
- `DUE` = a normal card order where Stripe succeeded. The order **is** paid. Many restaurants never advance from DUE to COMPLETED — normal behavior. Never treat DUE as unpaid or exclude it from revenue logic.
- `PAID` = a direct entry invoice after payment. Unrelated to DUE.

---

## 7. Key people

| Person | Role |
|---|---|
| **Peter Venti** | Founder/operator. Handles everything technical himself. |
| **Kealoha Pomerantz** (kealoha@discocater.com) | Operations/support. BCC'd on all order confirmations; set as Reply-To so she receives customer replies. |
| **Kevin** | Co-developer, COO. noise-machine and outreach tooling. |
| **Revyrie** | Former FM backend dev team. Contract ended July 1, 2026. **No longer involved in the business.** |

---

## 8. Working principles

These were learned the hard way and are non-negotiable.

**FM is the specification — read source, never infer.**
FM's actual backend and frontend source must be read for any behavior question before building or claiming parity. Never describe unverified behavior as "by design" or "by construction." The recurring failure mode is substituting plausibility for reading FM source.

**Money flow requires empirical verification.**
Never assume or infer payment/settlement behavior from precedent. Verify actual fund flow (Stripe test mode, FM source, or live reconciliation) before considering any payment feature safe to ship. Flag any uncertainty about who money comes from or goes to.

**Architecture boundary changes must be called out explicitly.**
Any change switching restaurants, orders, or menus from one underlying system to another (FM-backed → Neon-native) must be flagged before proceeding — even if framed as reusing "already-built" work. These are platform-level architecture changes, not routine fixes.

**Never assume data is test or disposable.**
Applies to everything — restaurants, menu items, modifiers, orders, settings, customer accounts. Names like "Test," "Test1," or seemingly misattributed names do **not** mean data is junk. A faithful import means 100% of real source data with zero filtering based on naming heuristics. If something looks like leftover data, flag it and ask — never silently filter.

**Don't investigate from a list — investigate from the product.**
A mechanically-generated list (e.g. "routes lacking keyword X") is not a reachability analysis. Check the actual user path before drawing conclusions. This produced a badly wrong audit on 2026-09-20.

**Don't relay numbers.**
Claude Code prints figures; Peter reads them directly. Claude has repeatedly misreported dollar amounts.

**No scope creep.**
Answer what was asked. Do not add adjacent concerns, editing behavior, or extra scope that wasn't requested.

---

## 9. Technical rules

**FM API quirks:**
- Authorization header uses the **raw JWT with no `Bearer` prefix**
- Dates use **`DD.MM.YYYY`** — never `YYYY-MM-DD`. Wrong format breaks date filters silently.
- `restaurantStatus` filter uses `ACCEPTED`, not `ACTIVE`
- Explicit `page=0` causes 400s on some endpoints — omit for page 0
- FM PUT endpoints require a full GET-merge-PUT — never a partial body
- `orderType` must always be `"PICKUP"` or `"DELIVERY"` — never an empty string (causes FM 500)
- `extraItems` on POST, `orderAddOns` on GET
- Tip percentages are stored as percentage points (15 means 15%, not 0.15)
- SUPER_ADMIN uses an explicit `restaurantReference` param

**Environment:**
- `FAMILYMEAL_EDIT_API_BASE` was deleted from Vercel and **must never be re-added**. Falling back to `FM_API_BASE_URL` pointing at production is correct.
- `vercel env pull` returns blank for all Sensitive vars — only non-sensitive vars come through. Confirm presence via `vercel env ls`.
- Never include "curl the deploy hook" in Claude Code prompts — Vercel auto-deploys on push to main.
- macOS `sed -i` fails silently — use Python for in-place edits.

**Email/transactional:**
- Disco Cater **logo image** (not a text wordmark) in transactional emails, on white background. Deliberate override — do not revert without being asked.
- Kealoha is Reply-To on all order confirmation emails.

---

## 10. Current state (as of 2026-09-20)

### The September 19–20 outage — resolved

**What happened:** A change on 2026-09-18 (commit `64723a3`) made the restaurant portal's Orders page refresh itself in an infinite loop — a per-render array literal ended up in a `useCallback` dependency chain. A single open browser tab produced thousands of requests per minute, each asking FamilyMeal for an order list.

FamilyMeal has an N+1 query bug in `RestaurantOrderMapperImpl` — it lazy-loads each order's add-on collection with a separate SELECT. Against a Hikari pool of 15 with a 120s timeout, three or four concurrent order-list requests exhaust it entirely. One thread was measured holding a connection for 548 seconds. FM froze rather than crashed.

Consequences: the flood filled a 15GB Docker log cap, which filled the disk and took the site down. Separately, nothing was listening on ports 80/443 on the API droplet — whatever had terminated SSL was gone — so Cloudflare returned 521s.

The restaurant being polled was **Bird & Co.**, which is Disco-native. Its orders live in Neon. Every one of those requests asked the wrong system.

**Fixes shipped:**
- Orders page dependency stabilized (module-level constant). The intended 60s refresh works again — it had been dead since the 18th.
- Native gate added to `/api/restaurant/orders` so `syncRestaurantOrders` is skipped for Disco-native restaurants.
- nginx installed and configured on the API droplet: self-signed cert, proxy to `127.0.0.1:8080`, `worker_connections` 768 → 8192. Cloudflare SSL mode is Full, which accepts a self-signed origin cert.
- nginx rate limits keyed on `CF-Connecting-IP` (not `$remote_addr`, which is always a Cloudflare edge IP): 2r/s on `/login`, and a **`limit_conn` cap of 3** on the order-list paths. The conn cap is the load-bearing one — it makes it structurally impossible for that endpoint to consume more than 3 of FM's 15 connections.
- `lib/fm-login-guard.ts` — single-flight, circuit breaker, backoff with jitter, 10s timeout. Both service-credential bypasses closed.
- Menus guard rekeyed on the restaurant via `menuSurfaceRef(ctx)` instead of the cookie.
- Backend container recreated with a 200m log cap (was 5000m × 3 = 15GB). Old container removed; 3.3GB log reclaimed.

**Config backups on the droplet:** `/root/backend-recreate-20260920/` (`backend-inspect.json`, `recreate-backend.sh`), plus `nginx.conf.bak-*` and `fm.bak-*` files.

### Still open

- **FM's N+1 query bug is unfixed.** It's why a traffic spike became an outage. Given FM is being retired in weeks and the nginx conn cap holds it, fixing the Java backend is likely not worth it — but the fragility is real and any other load source can trigger the same freeze.
- **The FM deploy path is broken.** `docker-compose up -d` (what the GitLab `release-prod` job runs) would start the compose nginx service and collide with the host nginx on 80/443, breaking HTTPS. Moot while FM is frozen. A warning note is committed to `familymeal-java-backend` on branch `restaurant-archive-allowlist` (commit `39076986b`, unpushed) — note that this is a side branch and won't be visible from `dev` or `main`.
- **The 2026-09-20 boundary audit is wrong** and still sits in the repo at `docs/native-fm-boundary-audit-2026-09-20.md`. Its §2 (four settings areas "never ported") and its "50 ungated routes / ~20 that write" figures are void — they counted legacy routes that have native counterparts. What survives: the 19 FM order writes and their Neon comparison, the menus guard cookie hole (now fixed), `fm-orders-sync` being unsafe by default, the 133 tenant schemas being benign, and the FM N+1.
- **Direct entry orders are not defaulting to 1P.** Orders #900000200 and #900000199 (Pelican Delicatessen, Disco-native direct entry) show 3P. Existing orders are not to be corrected — default only.
- **Expedite/dlivrd credentials:** Disco's outbound dispatch is using FamilyMeal's dlivrd account as a stopgap (Disco's own secret was overwritten 2026-09-10 and permanently lost). Two risks: Disco deliveries created under FM's account, and dlivrd possibly sending status webhooks to FM's registered URL rather than Disco's `EXPEDITE_WEBHOOK_URL`. Approved as temporary — needs fixing. Related: FM's prod dlivrd credentials are committed in plaintext in the source tree (real exposure). Also latent: Disco's outbound signing does not escape non-ASCII before signing while FM does — any order containing an emoji or accented character will fail signature verification even with the correct secret.
- **Test Kitchen** (`restaurant_reference c8322ff4-32dd-47bc-8515-3f0cffc34bbf`) — a real live production restaurant whose FM record was soft-deleted by a bug (an e2e script hardcoded its reference, mislabeled it Disco-native, and a super-admin delete removed the real FM record). All 235 FM orders were soft-deleted with it. FM has a first-class restore (`RestaurantServiceImpl.restoreRestaurant`) gated by an allowlist in `application.yml` that includes `peter@familymeal.com`; the `testkitchen` slug is free, so restore should succeed. Restore is all-or-nothing and brings the 235 orders back. **Not yet done.** Note: even after restore, the Disco side has no menus, no tax config, no Stripe account, and no portal account.
- **26 native restaurants** have mismatched references in FM vs. Neon (e.g. Blasteran is `353bd8de…` in Neon, `b6f57a13…` in FM). Their FM calls 404, which is accidentally enforcing the boundary. On hold.
- **The FM service account uses `peter@familymeal.com`**, so its writes are indistinguishable from Peter's in FM's audit trail. Worth giving it its own identity.
- **Cloudflare rate-limit rule on `/login`** was added during the incident and is too broad — it also blocks real customer logins. Needs scoping or removal now that the origin-side limits are in place.

### Resolved non-issues

- **The 133 empty FM tenant schemas** are an abandoned 2021 multitenancy design, not data loss. The split is clean at restaurant id 77/79: ids 4–77 have full 19-table schemas (zero rows, migrations ran once on 2021-03-31); 79–283 have only `flyway_schema_history_restaurant`. Real orders live in `familymeal.tbl_restaurant_orders` (25,304 rows, 2021→2026). Every restaurant onboarded since 2021 looks like this. Nothing to do with conversion.

---

## 11. Backlog

**In priority order:**
1. **Disco Cater promo codes** — super admin sets discount codes Disco funds; restaurant receives the full amount; diner gets % off subtotal only (not tax, fee, tip, or delivery).
2. **Global menus** (Project Orca)
3. **Restaurant self-onboarding flow audit** + legal agreements check
4. **Refine the ezCater menu scraper** in super admin
5. **Marketplace scaling strategy**

**Additional TODO:**
- Remove the "No default" option from Menu Settings' default tip selector
- Remove "Log in: …" copy from the automated SMS notification template
- Staff login/password reset after conversion: `convertToNative` should trigger a "set your password" email to the restaurant's existing FM email — not yet implemented
- "For Restaurants" footer link needs adding to the main site nav/header so it appears on all pages (already on the homepage at `app/(customer)/page.tsx`)
- Staging + automated testing: Vercel staging branch → `stg.discocater.com` → `stg.familymeal.com`; Playwright (E2E), Vitest (unit), GitHub Actions CI. Priority flows: sign up → browse → checkout, plus admin. Needs a dedicated session.
- Become-a-partner: Stripe Connect (step 2) is wired but blocked — FM `/registration` creates a USER account with no restaurant reference. Menu upload (step 4) is a placeholder stub needing wiring to store/forward the file.
- Re-verify the four settings areas flagged during the incident (fees and tips, business info, scheduling, authorized users) — the audit claiming they were unported was wrong, but they were flagged for re-verification separately.

**noise-machine:** the daily Apollo sourcing job is live (cron 06:10, merged `bd1f04f`) — 50 approvals/day, A+/A tiers only (tier B excluded), max 3 contacts per restaurant per run, role-filtered. Contacts associate with a restaurant account **only** and must never auto-enter a sequence (structural separation: the job writes no `enrollment_queue` row). Framing: passive, scalable, low stakes, meant to be tested rather than perfected.

---

## 12. Workflow

1. Peter describes a requirement or problem
2. Claude drafts a Claude Code prompt
3. Peter pastes it into Claude Code (VS Code)
4. Claude Code implements and commits
5. Peter shares results for review and next steps

Claude Code handles all SSH work, file writing, git commits, and deployments.

**Response style:**
- Short and direct. No recaps of what was just done. No code snippets or file paths unless essential.
- Only flag plain-language concerns for genuinely significant issues (real risk, money, safety). Skip commentary otherwise.
- Never suggest pausing, stopping, or checking in about session length or workload volume.
- Never comment on time of day, session length, or how much has been done.
- Questions go in a distinct, clearly-marked **numbered** list with the question text in **bold** — never bulleted, never buried in prose.
- A Claude Code prompt is delivered as a single copyable block with **no framing text, preamble, explanation, or follow-up commentary** above or below.

---

## 13. Reference

**Brand:**
```
Purple           #6B6EF9
Magenta          #C044C8
Pink             #F0468A
Deep Aubergine   #1A1028
Blue (buttons)   #5B6FE8
Gold (AI button) #EFB84A
Gradient: linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)
Font: DM Sans
Logo: always on white background
```

**Local paths:**
- `/Users/peterventi/Desktop/VS Code/disco-cater`
- `/Users/peterventi/Desktop/VS Code/familymeal-java-backend`

**GitHub org:** `familymealconcepts`

**Analytics/tracking:** GA4 `G-KQV7RLHXTH`, Microsoft Clarity `vv8ibgkwby`, Apollo pixel app ID `698b7a4f08b116001d87b092`

**Sanity CMS** (sunset from customer-facing reads): project `0j4eqnmw`, dataset `production`, studio at `discocater.sanity.studio`

**Git:**
```bash
cd "/Users/peterventi/Desktop/VS Code/disco-cater" && git add . && git commit -m "message" && git push origin main
```

**Never paste API keys into chat.** Rotate immediately if accidentally shared.
