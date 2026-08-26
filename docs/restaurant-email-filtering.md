# Restaurant-side email filtering

Why order confirmations reach a restaurant's Junk folder while Mailgun reports
success, which restaurants are most exposed to it, and what a restaurant has to
do to allowlist us.

Written up after the order-900000093 confirmation to `cory@dechecos.com`
(2026-08-23) was found in Junk. **Confirmed 2026-08-26: he received it, it was
filed as Junk by Proofpoint. Delivered, authenticated, filtered. Nothing was
broken on our side.** That case is closed; this document exists so the
investigation does not get repeated.

**Section 6 is the part to send to a restaurant.** Everything else is internal.

---

## 1. The core problem: "delivered" does not mean "in the inbox"

Mailgun's `delivered` event means **one thing only**: the recipient's perimeter
mail server returned a `250 OK` at SMTP time. It says nothing about where the
message went afterwards.

Every filter named in this document is an **accept-then-filter** architecture.
The perimeter server accepts the message, then scores it, then files it — inbox,
Junk, or quarantine. All of that happens *after* the `250`, inside
infrastructure we cannot see.

Both of these were true at once for the DeCheco's message:

- Mailgun logged `delivered` to `cory@dechecos.com` at 2026-08-23T16:26:56Z.
- The message was in his Junk folder.

**There is no API, webhook, or event that reports Junk placement.** Not from
Mailgun, not from the filter vendors. What we checked on that message, across
both sending domains:

```
mg.discocater.com  accepted 9, delivered 9 (code 250), failed 0, rejected 0, complained 0
mg.familymeal.com  accepted 6, delivered 6 (code 250), failed 0, rejected 0, complained 0
suppression lists  no dechecos.com address in bounces, complaints or unsubscribes — ever
```

No delayed bounce, no deferral, no complaint. The empty suppression list is the
durable evidence: events age out in a few days, suppression entries never do.

**The symptom of this failure is silence.** A restaurant does not get an error;
it just does not see the order. Treat "we never got the order email" as
plausible even when Mailgun says `delivered`, and check Junk before checking our
logs.

### What will not tell us either

- **DMARC aggregate reports** (now flowing to Cloudflare, see
  `_dmarc.discocater.com`). They cover mail claiming to be From our domain,
  which does include our mail to restaurants — but the only placement-ish field
  is `disposition`, and that is the DMARC *policy* action (`none` / `quarantine`
  / `reject`). Our mail passes DMARC, so it reads `none`, and spam-score
  filtering appears nowhere. Reports are also aggregate: daily counts per source
  IP, no per-message detail, no recipient addresses. Many small gateways do not
  emit them at all. Useful for spoofing and alignment breaks; useless for Junk.
- **Open tracking.** See section 5.

---

## 2. How exposed the estate is — fleet-wide census (2026-08-26)

Every `disco_restaurant_overrides.notification_emails` recipient, classified by
the MX record of its domain.

```
restaurants with notification_emails set : 782
distinct recipient addresses             : 980
distinct recipient domains               : 308
```

Domains by tier:

| Tier | Domains | What it means |
|---|---|---|
| mainstream (Google, Microsoft, Yahoo, iCloud, Zoho, hosts) | 261 | filters, but mostly visibly |
| **dedicated security gateway** | **14** | **accept-then-filter, silent** |
| no MX at all | 18 | cannot receive mail — see 2.2 |
| self-hosted / unknown | 14 | no vendor guidance possible |

Gateway vendors present:

```
8  Proofpoint          3  mailspamprotection      1  Mimecast
1  AppRiver/SecureTide 1  Hornetsecurity
```

### 2.1 The 28 restaurants behind a gateway

14 gateway domains map to **28 restaurants**, and **19 of those have no
non-gateway co-recipient** — meaning if the gateway files it away, nobody at the
restaurant sees the order at all.

The concentration matters more than the count. Two contacts cover most of it:

| Domain | Vendor | Restaurants |
|---|---|---|
| `webeggtodiffer.com` | Hornetsecurity | **7** — Eggstasy ×6 (Scottsdale, Queen Creek, The Colony, Norterra, Mesa, Chandler) + Morning Squeeze |
| `dechecos.com` | Proofpoint | **6** — DeCheco's ×6 (all locations) |
| `freshfinpoke.com` | Proofpoint | FreshFin - East Side MKE |
| `brandedgoodsonline.com` | Proofpoint | Mr. M's Sandwich Shop |
| `glenrockpizza.com` | mailspamprotection | Francesca Catering - Glen Rock (×2 records) |
| `sandyhookseafood.com` | mailspamprotection | Sandy Hook Seafood |
| `aygueynyc.com` | mailspamprotection | Ay Guey NYC |
| `bludsosbbq.com` | Mimecast | Bludso's BBQ - La Brea |
| `bestlobster.com` | Proofpoint | The Lusty Lobster |
| `rooted-cafe.com` | Proofpoint | Rooted Cafe & Catering |
| `shoregoodeats.com` | Proofpoint | Shore Good Eats |
| `lorenzofoodgroup.com` | AppRiver | Yella's |
| `southern.edu` | Proofpoint | Colette's Creations |
| `bagelpoint.com` | Proofpoint | (orphaned override rows, no cache row) |

**This is a handful, not dozens.** 28 of 782 restaurants, and one conversation
with Eggstasy's IT plus one with DeCheco's covers 13 of the 28. Worth Kealoha
getting ahead of manually; not worth building tooling for.

The six DeCheco's locations and Francesca Glen Rock **do** have a co-recipient
on Gmail, which is a free diagnostic — if the Gmail recipient has the message
and the gateway one does not, the problem is definitively the gateway. That is
how the DeCheco's case was closed.

**Outreach list — the 19 with no non-gateway email, by 90-day order volume.**
Most also have SMS enabled, which is a genuine (if lossy) fallback and was
omitted from the first version of this section.

| 90d orders | Restaurant | Gateway | SMS fallback | FM admin email usable as a 2nd recipient? |
|---|---|---|---|---|
| **420** | Sandy Hook Seafood | mailspamprotection | **none** | no — same address |
| **84** | Morning Squeeze | Hornetsecurity | yes | no — same gateway domain |
| **78** | Bagel Point - Manhattan | Proofpoint | yes | **YES — `bagelogycorp@gmail.com`** |
| 20 | Mr. M's Sandwich Shop | Proofpoint | yes | no — same address |
| 19 | Eggstasy - Scottsdale | Hornetsecurity | yes | none exposed |
| 10 | Eggstasy - Norterra Ctr. | Hornetsecurity | yes | no — same gateway domain |
| 7 | Rooted Cafe & Catering | Proofpoint | yes | no — same address |
| 6 | Eggstasy - Chandler | Hornetsecurity | yes | none exposed |
| 6 | Eggstasy - Queen Creek | Hornetsecurity | yes | none exposed |
| 3 | Eggstasy - The Colony | Hornetsecurity | yes | none exposed |
| 3 | Shore Good Eats | Proofpoint | yes | no — same address |
| 1 | Eggstasy - Mesa | Hornetsecurity | yes | none exposed |
| 1 | Ay Guey NYC | mailspamprotection | yes | no — same address |
| 0 | Yella's | AppRiver | none | **YES — `yellas@familymeal.com`** |
| 0 | The Lusty Lobster | Proofpoint | none | no — same address |
| 0 | Bludso's BBQ - La Brea | Mimecast | none | no — same address |
| 0 | FreshFin - East Side MKE | Proofpoint | none | no — same gateway domain |
| 0 | Coastal Steam Pots - Ship Ahoy | mailspamprotection | yes | none exposed |
| 0 | Bagel Point (2nd override row) | Proofpoint | none | as above |

**`Sandy Hook Seafood` is the priority by a wide margin** — 420 orders in 90
days, a single recipient behind a filtering gateway, and no SMS fallback. A
single point of failure carrying real volume.

**FM's admin record is almost never a useful fallback.** Checked all 19 via
`GET /api/admin/restaurants/{ref}` → `admin.email`: it is the *same* gateway
address already on the notification list in 10 cases, on the same gateway domain
in 2, absent in 6, and genuinely useful in only **2** (Bagel Point, Yella's).
The FM account owner and the notification recipient are usually one person.

Note `FreshFin`'s FM admin is `catering1@freshfinpoke.com` — the same address
that deferred twice with Proofpoint `4.1.1 unverified address` during the
rebrand campaign.

### 2.2 Domains that cannot receive mail at all

18 notification domains have **no MX record**. A domain with no MX cannot
receive mail; senders will not fall back to an A record. Those addresses are
unreachable, permanently and silently.

**Judge this per RESTAURANT, not per domain.** A dead domain only matters if the
restaurant has no other way of being told, and there are two other ways: a
second email address on a different domain, and SMS
(`notification_sms_numbers` + `text_notifications_enabled`). Counting dead
domains overstates the problem badly — the first version of this section did
exactly that.

Re-run at restaurant level: **6 restaurants have no working recipient of any
kind, and none of them are live.**

```
Hungry House            not live   1 order    catering@hungryhouse.com
Beatnic - Williamsburg  not live   2 orders   toddb@ + williamsburg@eatbeatnic.com
The Calimex Cafe        not live   0 orders   christopher.craig@thecalimexcafe.com
Stockyard Sandwich Co.  not live   0 orders   accounts@stockyardphily.com
dalla.ca                not live   3 orders   reservation@ + catering@dalla.ca
eatojaiburger.com       not live   1 order    patrick@ + kasper@eatojaiburger.com
```

Every other dead-domain restaurant has a working fallback. The two worth
knowing about:

```
Sip + Co East Village   LIVE, 0 orders ever, online ordering OFF
  DEAD   managers@sipandcoev.co   (ENOTFOUND — domain does not resolve)
  works  info@sipandco.co         [Google Workspace]
  SMS    917-736-2831 (enabled)
  -> NOT broken. Tidy up the dead address when convenient; nothing is at risk.

Shine Provisions        not live, 140 orders in 90 days
  DEAD   chefshine@shine-provisions.com
  SMS    720-688-6359 (enabled)
  -> highest-volume dead-email case; SMS is the only channel. Worth a real
     address, but no email is being lost that SMS is not covering.
```

`ztejas.com` (10 addresses across 6 override rows), `coppolasnj.pizza`,
`mariosnj.pizza`, `tacosdm.com`, `goodfantzye.com`, `thefoodguys.net`,
`robbyjay.com`, `redrocksog.com`, `cocu.nyc`, `famsfav.com` and
`fairlawnpizza.com` all have SMS enabled or a working co-recipient. Clean them
up if any restaurant is reactivated. Several also hard-bounced during the
rebrand campaign, which is consistent.

**`is_live` is not a reliable filter here.** Sandy Hook Seafood shows
`is_live = false` with **420 orders in the last 90 days**. For FM-backed
restaurants the mirrored liveness flag does not track reality — **order volume
is the better signal of whether a restaurant is actually operating**, and it is
what the outreach ordering in 2.1 uses.

Also noted: **142 `disco_restaurant_overrides` rows carry `notification_emails`
but have no matching `disco_restaurant_cache` row.** A data-integrity issue
rather than a deliverability one, but it means the census above slightly
under-counts named restaurants.

To classify a new restaurant:

```sh
dig +short MX <restaurant-domain>
```

`ppe-hosted.com`/`pphosted.com` = Proofpoint · `mimecast` = Mimecast ·
`ess.barracudanetworks.com` = Barracuda · `arsmtp.com` = AppRiver ·
`antispameurope`/`hornetsecurity` = Hornetsecurity ·
`antispam.mailspamprotection.com` = SiteGround · `iphmx.com` = Cisco ·
`mail.protection.outlook.com` = Microsoft · `aspmx.l.google.com` = Google ·
**no output at all = the domain cannot receive mail.**

---

## 3. The two sender pairs — which mail comes from where

**This is the thing most easily got wrong.** Restaurants receive order mail from
two different systems on two different domains, and allowlisting one does not
help the other.

| Mail | Sending domain | From address | Sent by |
|---|---|---|---|
| **Disco Cater** order confirmations, restaurant notifications, 24h reminders, password resets | `mg.discocater.com` | `orders@discocater.com` | disco-cater (`lib/email/send.ts`) |
| **FamilyMeal** order confirmations, cancellations, refunds, reminders | `mg.familymeal.com` | `noreply@mg.familymeal.com` | FM's Java backend |

Which one a restaurant gets depends on the order, not on the restaurant:
`disco_orders.source_of_order = 'DISCO'` → our mail; `'FAMILYMEAL'` → FM's mail.
A restaurant that takes orders through both channels receives both, so
**always give a restaurant both pairs.**

This was the live trap in the DeCheco's case: the messages Cory was missing that
week were FM's (all three orders since Aug 23 were `source_of_order =
FAMILYMEAL`), while the investigation and the original version of this document
were both about `mg.discocater.com`.

### Authentication (both domains pass — this is never the cause)

```
discocater.com       SPF   v=spf1 include:_spf.google.com ~all
                     DMARC p=quarantine; adkim=r; aspf=r;
                           rua=Cloudflare + GoDaddy processors
mg.discocater.com    SPF   v=spf1 include:mailgun.org ~all
                     DKIM  krs._domainkey.mg.discocater.com
mg.familymeal.com    SPF   v=spf1 include:mailgun.org ~all
                     DMARC inherits familymeal.com p=quarantine (relaxed)
```

Relaxed alignment on both axes means the `mg.` subdomains align
organizationally, so **SPF, DKIM and DMARC all pass.** When a restaurant's IT
asks whether the mail is authenticated, the answer is yes, verifiably.

### The `Sender:` header (fixed 2026-08-26)

Mailgun adds its own `Sender:` header when the From domain differs from the
sending domain, in VERP form — `orders=discocater.com@mg.discocater.com`.
Outlook rendered that as *"orders=discocater.com@mg.discocater.com — On behalf
of Disco Cater"*, which reads like a spoof of the restaurant's own order mail.

`lib/email/send.ts` now sets `h:Sender` to the From address so `Sender` equals
`From`, and sets it **only when the domains differ** — so the FM campaign path
(From `noreply@mg.familymeal.com` over `mg.familymeal.com`) is untouched and
byte-identical.

**This did not fix Junk placement and was not expected to.** It removed an
anomalous header. Do not present it as a deliverability fix.

---

## 4. What actually drives the Junk placement

**Sending reputation, not configuration.** `mg.discocater.com` is very
low-volume: ~88 accepted events in the retained window, mostly internal, against
a documented 358 accepted in 90 days with a 45-email peak day. That is roughly
four messages a day, **split across two shared Mailgun IPs**
(`204.220.184.35`, `69.72.42.241`), so each IP sees about two of our messages a
day among other customers' traffic. There is no meaningful IP or domain
reputation to lean on, and every order message carries a 24KB PDF.

Things that were investigated and are **not** worth doing:

- **A dedicated IP** would be worse. Warming needs thousands of messages over
  weeks; a dedicated IP at four a day looks worse to receivers than shared.
- **Moving transactional to a new subdomain** resets what little reputation
  exists. `mg.discocater.com` already carries only transactional mail — the
  separation is real (86 of 88 messages From `orders@discocater.com`, all
  order/reminder/password). Do not move it.
- **Dropping the PDF for a link.** The attachment is 24KB, identical min and
  max, on 65% of messages — not a size trigger. A rewritten link is a *stronger*
  filter signal than a small PDF, and restaurants want the printable ticket.
- **BIMI.** Needs a Verified Mark Certificate, which needs a registered
  trademark, at four figures a year, to show a logo in Gmail and Yahoo. Not a
  placement signal.
- **An explicit `Return-Path`.** Tested: the header is set and then receiving
  MTAs rewrite it from the real envelope. You cannot change the envelope without
  changing the sending domain.

**The real lever is volume and time**, to engaged recipients. It improves as
native order volume grows. There is no shortcut, and the honest position is that
recipient-side allowlisting (section 6) is the only thing that fixes a *named*
restaurant now.

---

## 5. Open and click tracking are deliberately OFF — leave them off

```json
{"open":{"active":false},"click":{"active":false},"unsubscribe":{"active":true}}
```

So **"0 opens" in Mailgun is not evidence of anything** — the signal does not
exist. Any question of the form "has this restaurant stopped opening our
confirmations?" cannot be answered from Mailgun today.

**Do not enable them to find out.** The reasoning that says "an open proves the
message reached an inbox" does not hold, in either direction:

1. **A Junk message can be opened.** People check Junk — that is exactly how the
   DeCheco's message was found. An open does not prove inbox placement.
2. **No open does not prove Junk.** Outlook and most corporate clients block
   remote images by default, so a message that was read often produces no event.
3. **Gateways generate false opens.** Proofpoint and Microsoft pre-fetch and
   scan embedded images, producing opens with no human involved. At exactly the
   recipients we care about, the signal is closest to noise.
4. **It would make the problem worse.** Open tracking injects a pixel; click
   tracking rewrites every link to a redirect domain, so the visible URL differs
   from its target — which is what phishing does. On transactional mail to
   filtered business mailboxes both are recognised spam heuristics. We would be
   degrading placement in order to measure it. `web_scheme` on this domain is
   also `http`, so rewritten links would downgrade to plaintext.
5. Link rewriting on an order confirmation puts a third-party redirect between a
   restaurant and its own order.

If engagement data is ever genuinely needed, it should be a per-send opt-in on
marketing sends only, never a domain-wide default that catches transactional
mail.

---

## 6. Send this to the restaurant

Self-contained. Substitute the restaurant name and send — no editing needed.
Covers both sender pairs and both the release and allowlist steps.

---

> **Subject: Making sure your order emails reach your inbox**
>
> Hi <name>,
>
> Your catering order emails from us are being delivered to your mail system but
> filed into Junk or quarantine by your spam filter instead of your inbox. The
> emails are arriving — they are just going to the wrong folder, which makes it
> easy to miss an order.
>
> There are two parts to fixing this. The first part you can do yourself in a
> couple of minutes, and it matters more than it sounds: spam filters learn from
> it.
>
> **Part 1 — rescue the messages you already have (please do this first)**
>
> If the emails are in your **Junk or Spam folder**: open one, and click **"Not
> Junk"** / **"Not Spam"** / **"Report as not junk"**. Do this for two or three
> of them if you can find them. Simply moving the message to your inbox by
> dragging it does *not* teach the filter anything — you have to use the Not
> Junk button.
>
> If instead you get a **daily or weekly "quarantine summary" email** from your
> security provider listing blocked messages: find our messages in that list and
> click **Release** (sometimes labelled "Deliver" or "Allow"). Releasing a
> message is the single most useful thing you can do, because most filters treat
> a release as a strong signal that mail from that sender is wanted. If the
> summary also offers **"Allow sender"** or **"Safe list sender"**, use that too.
>
> **Part 2 — ask your IT or email provider to allow our senders**
>
> Forward the section below to whoever looks after your email. If that is an
> outside IT company or your web host, they will know what to do with it.
>
> ---
>
> *For the IT contact:*
>
> Please add the following to the organisation's safe-sender / allow list. There
> are **two separate systems** that send this restaurant's order email, and both
> need allowing — allowing only one will leave the other still filtered:
>
> **Disco Cater order emails**
> - Sending domain: `mg.discocater.com`
> - From address: `orders@discocater.com`
>
> **FamilyMeal order emails**
> - Sending domain: `mg.familymeal.com`
> - From address: `noreply@mg.familymeal.com`
>
> Where the system offers a choice, **allow-list by sending domain**
> (`mg.discocater.com`, `mg.familymeal.com`) rather than only by From address.
> The sending domain is the one that is cryptographically signed with DKIM and
> appears in the SMTP envelope, so it is a value you can verify; a From address
> is only a header.
>
> **Please do not allow-list by IP address.** These messages are sent via
> Mailgun, which uses shared IP pools — the addresses change and are not
> exclusive to us, so an IP rule is both fragile and far broader than intended.
>
> Both domains are fully authenticated — SPF, DKIM and DMARC all pass, with
> DMARC published at `p=quarantine`. You can verify this on any received message
> by checking the `Authentication-Results` header. Allowing these senders does
> not weaken your spam protection or create a spoofing route: mail that fails
> authentication for these domains will still be rejected.
>
> Product notes that may be useful depending on what you run:
> - **Proofpoint Essentials** — Sender Lists / Safe Senders List, available at
>   organisation level and per-user. End users can also safe-list from the
>   quarantine digest.
> - **Microsoft 365** — the supported route is an **Allow** entry in the Tenant
>   Allow/Block List, or an Exchange mail flow rule setting SCL to `-1`. Note
>   that a user's personal Outlook Safe Senders list often does *not* override
>   tenant-level filtering, and Microsoft discourages using anti-spam policy
>   allowed-sender lists.
> - **Google Workspace** — Gmail spam settings, the option to bypass spam
>   filtering for senders in a selected address list. Do not use the "Email
>   allowlist" setting, which is IP-based.
> - **Mimecast** — a Permitted Sender policy, or Managed Sender set to Permit.
> - **Barracuda** — Sender Policies, at domain or user level, set to allow.
> - **Hornetsecurity** — the Allow/Deny list under spam and malware protection.
> - **SiteGround / mailspamprotection.com** — the spam filter allow-list in the
>   hosting control panel.
> - **AppRiver / SecureTide** — the allow list in the admin console; this is
>   usually managed by the reseller rather than the account holder.
>
> Menu paths move between product versions, so search the admin interface for
> "sender list", "permitted sender" or "allow list" rather than following a fixed
> click-path.
>
> ---
>
> Once both parts are done, new order emails should land in the inbox. If any
> still go to Junk after that, reply and let us know — we can confirm from our
> side exactly when each message was delivered and to which server.
>
> Thanks,
> Kealoha

---

## 7. `mg.familymeal.com` carries the campaign AND fleet transactional mail

Flagged 2026-08-26. **This is the more consequential version of the
domain-separation question**, and it cuts the other way from section 4.

`mg.discocater.com` is cleanly separated — transactional only.
`mg.familymeal.com` is not. In the retained window it carried **1428 accepted
messages**:

```
 499  rebrand campaign            (35% of the domain's traffic)
 434  FM order confirmations
 133  FM reminders
 106  FM welcome emails
  30  FM cancellations
   6  FM refunds
 ~220 other FM transactional (ORDER CONFIRMED / CHANGE / payment / password)
```

So a bulk marketing campaign and **the entire FM fleet's order mail** share one
domain reputation. Every restaurant that takes FamilyMeal orders — DeCheco's,
Apollo Bagels, Colonial, Wax Paper, Hugo's and the rest — depends on it.

The campaign's own bounce history on that shared domain:

| | Sent | Hard bounces | Rate | Complaints |
|---|---|---|---|---|
| Day one | 60 | 15 | 25% (12 were known-risky domains) | 0 |
| Day two | 325 | 17 | 5.2% | 0 |
| Day three (post-validation) | 301 | see run report | ~1% | 0 |

Two things keep this from being urgent: **zero complaints across the whole
campaign** — and complaints weigh far more heavily than bounces — and day
three's rate is back near 1% after pre-send validation, so the campaign is now
better behaved than the domain's own historical 2–3%.

It also did **not** cause the DeCheco's case: five of Cory's six FM emails
predate day one of the campaign entirely.

**Recommendations**

1. **Do not move the campaign mid-flight.** Changing sending domain partway
   through is worse than finishing on the one already warmed.
2. **Validate before any future bulk send.** Day two bounced 5.2% unvalidated;
   day three ~1% validated. That delta is the whole argument.
3. **Future bulk sends should not share a domain with fleet transactional mail.**
   A dedicated marketing subdomain is the correct shape — accepting that a new
   subdomain starts at zero reputation and needs warming.
   `hello.discocater.com` already exists, is verified, and has zero traffic if a
   Disco-side marketing lane is ever wanted.
4. **Never send bulk mail from `mg.discocater.com`.** It carries the native
   order confirmations and has almost no reputation buffer to absorb it.

---

## 8. Proposed standing check: notification reachability (SCOPED, NOT BUILT)

Both problems in section 2 were found by running a census because someone asked
— not by anything watching. **A restaurant with a dead notification domain, or
with only gateway-fronted recipients, fails silently: no bounce, no error, just
an order nobody sees.** Nothing in the system notices.

### What it would check

Nightly, for every restaurant with order activity in the last 90 days — **not
`is_live`**, which is unreliable for FM-backed restaurants (see 2.2):

1. Split `disco_restaurant_overrides.notification_emails` on `,` and `;`.
2. Resolve MX for each distinct domain (~308 domains today, DNS only).
3. Classify each recipient: `nomx` / `gateway` / `mainstream` / `self-hosted`.
4. Read `notification_sms_numbers` + `text_notifications_enabled` as a fallback
   channel.

### Alert conditions

| Severity | Condition | Why |
|---|---|---|
| **CRITICAL** | no recipient resolves **and** no SMS fallback | orders arrive, nobody is told by any channel |
| **WARNING** | no recipient resolves, SMS enabled | email channel dead, degraded but covered |
| **WARNING** | every usable recipient is behind a gateway | silent-Junk risk with no fallback (the 19) |
| **INFO** | a domain's MX vendor **changed** since the last run | a previously-safe restaurant just moved onto Proofpoint/Mimecast — the only way to catch new exposure |
| **INFO** | an individual recipient domain stopped resolving | partial loss while others still work |

The vendor-change alert is the one with ongoing value. The rest is a one-off
sweep that mostly stays quiet after the current backlog is cleared.

### Shape

- **Where**: a nightly Vercel cron, alongside the existing map-cache (04:00) and
  Sanity-mirror (05:00) jobs. **Do not add a cursor to `sync_state`** — that
  pattern has silently stalled two crons already.
- **State**: one small table, e.g.
  `notification_reachability(restaurant_reference, email, domain, mx_host,
  vendor, tier, checked_at)`, upserted per run. Needed only for the
  vendor-change diff; everything else is computable from a single run.
- **Output**: Slack to the ops channel, CRITICAL and WARNING only, with INFO
  rolled into a weekly digest so it does not become noise.
- **Cost**: DNS lookups only. ~308 domains, a few seconds, no API spend.
- **Effort**: small — half a day, most of it the alert-routing and the diff
  table.

### What it will NOT catch — state this when proposing it

**It would not have caught the DeCheco's case.** `dechecos.com` resolves fine,
Proofpoint accepted the message, and Cory's mailbox exists. A working mailbox
behind a working gateway that files our mail as Junk is invisible to this check,
as it is to every other signal available (see sections 1 and 5).

This closes the *dead-address* and *no-fallback* gaps. The *Junk-placement* gap
stays open, and the only detector for it remains a human telling us.
