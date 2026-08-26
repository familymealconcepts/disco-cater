# Restaurant-side email filtering

Why order confirmations reach a restaurant's Junk folder while Mailgun reports
success, which filter sits in front of each restaurant we send to, and what a
restaurant has to do to allowlist us.

Written up after the order-900000093 confirmation to `cory@dechecos.com`
(2026-08-23) was found in Junk. This is reference material — it exists so the
investigation does not have to be repeated.

---

## 1. The core problem: "delivered" does not mean "in the inbox"

Mailgun's `delivered` event means **one thing only**: the recipient's perimeter
mail server returned a `250 OK` at SMTP time. It says nothing about where the
message went afterwards.

Every commercial filter in the table below is an **accept-then-filter**
architecture. The perimeter MTA accepts the message, then scores it, then files
it — inbox, Junk, or quarantine. All of that happens *after* the `250`, inside
infrastructure we have no visibility into.

So for the DeCheco's message, both of these are simultaneously true:

- Mailgun logged `delivered` to `cory@dechecos.com` at 2026-08-23T16:26:56Z.
- The message was in the Junk folder.

**There is no API, webhook, or event that reports Junk placement.** Not from
Mailgun, not from the filter vendors. The only reason we learned about this one
is that a human at DeCheco's mentioned it.

That is the monitoring gap, and it cannot be closed with the tooling we have.
Treat any report of "we never got the order email" as plausible even when
Mailgun shows `delivered` — check Junk before checking our logs.

---

## 2. Which filter sits in front of each restaurant

Determined from the MX records of every recipient domain that received mail on
`mg.discocater.com` in the retained event window (2026-08-26).

| Recipient domain | Filter in front | Lowest-priority MX |
|---|---|---|
| `dechecos.com` | **Proofpoint Essentials** | `mx1-usg1.ppe-hosted.com` |
| `elmwoodparkpizza.com` | **Microsoft 365** | `elmwoodparkpizza-com.mail.protection.outlook.com` |
| `franpizzanj.com` | **Microsoft 365** | `franpizzanj-com.mail.protection.outlook.com` |
| `cenavegan.com` | **Google Workspace** | `aspmx.l.google.com` |
| `winkinrooster.com` | **Google Workspace** | `aspmx.l.google.com` |
| `firstcomm.com` | **Barracuda** (ESS) | `d104236a.ess.barracudanetworks.com` |
| `grantinc.com` | **AppRiver / SecureTide** (now OpenText) | `grantinc.com.1.0001.arsmtp.com` |
| `glenrockpizza.com` | **SiteGround spam protection** | `mx10.antispam.mailspamprotection.com` |
| `hugostacos.com` | self-hosted | `mail.hugostacos.com` |
| `hugosrestaurant.com` | self-hosted | `mail.hugosrestaurant.com` |

Recipient domains that are ours or FM's — `discocater.com`, `familymeal.com` —
are Google Workspace and are not restaurant-side risk.

**The headline: nearly every restaurant recipient sits behind a commercial
filter, and eight distinct vendors are represented in a list of ten
restaurants.** There is no single allowlist that covers the estate. This is
inherently per-restaurant work.

To re-derive this for a new restaurant:

```sh
dig +short MX <restaurant-domain>
```

and match the hostname against the table above (`ppe-hosted.com` = Proofpoint,
`mail.protection.outlook.com` = Microsoft, `aspmx.l.google.com` = Google,
`ess.barracudanetworks.com` = Barracuda, `arsmtp.com` = AppRiver,
`antispam.mailspamprotection.com` = SiteGround).

---

## 3. What we send, and why authentication is not the problem

As of 2026-08-26, on `mg.discocater.com`:

```
From        : Disco Cater <orders@discocater.com>
Sender      : orders@discocater.com          <- set explicitly; see below
Reply-To    : kealoha@discocater.com
envelope    : postmaster@mg.discocater.com
DKIM        : d=mg.discocater.com, selector krs
```

DNS:

```
discocater.com       SPF   v=spf1 include:_spf.google.com ~all      (no Mailgun)
                     DMARC v=DMARC1; p=quarantine; adkim=r; aspf=r
mg.discocater.com    SPF   v=spf1 include:mailgun.org ~all
                     DKIM  krs._domainkey.mg.discocater.com
                     DMARC (none — inherits discocater.com by tree-walk)
```

Because `discocater.com` publishes **relaxed** alignment on both axes
(`adkim=r; aspf=r`), `mg.discocater.com` aligns organizationally and **DMARC
passes**. SPF passes on the envelope domain. DKIM passes.

**Authentication is not why these land in Junk.** This is the important
difference from the September rebrand campaign, where From `@discocater.com`
signed by `mg.familymeal.com` was a genuine cross-organizational DMARC failure.
Transactional mail has never had that defect.

### The `Sender:` header (fixed 2026-08-26)

Mailgun adds its own `Sender:` header whenever the From domain differs from the
sending domain, in VERP form — `orders=discocater.com@mg.discocater.com`.
Outlook renders that as **"orders=discocater.com@mg.discocater.com — On behalf
of Disco Cater"**, which reads to restaurant staff like a spoof of their own
order mail.

`lib/email/send.ts` now sets `h:Sender` to the From address, so `Sender` equals
`From` and there is nothing for the "on behalf of" rendering to trigger on. It
is set **only when the From domain differs from the sending domain**, so paths
that already align (the rebrand campaign, which sends From
`noreply@mg.familymeal.com` over `mg.familymeal.com`) are untouched.

**This did not fix Junk placement and was not expected to.** The envelope still
differs from From, which is what every ESP does and is not a meaningful spam
signal on its own. The fix removes an anomalous header, not a receiver's
verdict.

### What actually drives the Junk placement

Most likely **sending reputation, not headers**. `mg.discocater.com` is a very
low-volume domain: roughly 78 events in the retained window, the majority of
them internal (`familymeal.com` and `discocater.com` recipients), against a
documented 358 accepted in 90 days with a 45-email peak day. A domain that
quiet has essentially no reputation for a filter to lean on, and these messages
carry a PDF attachment.

Low volume is not a thing we can fix by configuration. It improves as real
order volume grows, and it is helped in the meantime by recipient-side
allowlisting (section 5).

---

## 4. Open and click tracking are deliberately OFF — leave them off

Current state on `mg.discocater.com`:

```json
{"open":{"active":false},"click":{"active":false},"unsubscribe":{"active":true}}
```

This means **"0 opens" in Mailgun is not evidence of anything.** The signal does
not exist. Any question of the form "has a restaurant stopped opening our
confirmations?" cannot be answered from Mailgun today, and reading `opened: 0`
as engagement data would be a mistake.

**Do not turn these on to find out.** The reasons, in order of weight:

1. **Open tracking injects a tracking pixel** and **click tracking rewrites
   every link** to a Mailgun redirect domain. On transactional mail going to
   filtered business mailboxes, both are recognised spam heuristics — link
   rewriting in particular makes the visible URL differ from its target, which
   is exactly what phishing does. We would be degrading deliverability in order
   to measure deliverability.
2. Link rewriting on an order confirmation puts a third-party redirect between
   a restaurant and its own order. If the redirect fails, the order link fails.
3. `web_scheme` on this domain is `http`, so rewritten links would downgrade to
   plaintext HTTP.
4. It would not answer the question anyway. Open tracking cannot see Junk
   placement — a message sitting unread in Junk and a message sitting unread in
   the inbox produce the identical signal (none).

If engagement data is ever genuinely needed, the correct route is a per-send
opt-in on marketing sends only, never a domain-wide default that catches
transactional mail.

`unsubscribe` tracking is active but has empty footers, and does not inject
anything into transactional messages.

---

## 5. Getting a restaurant to allowlist us

### 5.1 What to give them

The values to allowlist, in descending order of usefulness:

| Value | What it is |
|---|---|
| `mg.discocater.com` | the **sending domain** — DKIM `d=`, envelope domain. Best single value. |
| `orders@discocater.com` | the visible **From** address |
| `discocater.com` | the From domain |
| `kealoha@discocater.com` | the **Reply-To** — where replies actually go |

Prefer allowlisting **`mg.discocater.com`**, because it is the domain that is
cryptographically authenticated (DKIM) and appears in the envelope, so it is
the value a filter can verify rather than merely read. Allowlisting only the
visible From address is weaker — it is a header, and headers can be claimed by
anyone.

**Do not ask a restaurant to allowlist by IP.** Mailgun sends from shared IP
pools; the IP changes and is not exclusively ours, so an IP allowlist is both
fragile and over-broad.

### 5.2 Proofpoint Essentials — DeCheco's

This is the one we need first. Proofpoint Essentials calls the feature
**Sender Lists** (the allow half is the **Safe Senders List**), and it exists at
two levels:

- **Organization level** — set by whoever administers the account. This is
  usually the restaurant's IT provider or reseller, *not* the restaurant
  itself, because Proofpoint Essentials is sold through partners. Expect to be
  routed to a third party.
- **Per-user level** — on the individual user's profile, and also reachable by
  the end user from the **quarantine digest** email Proofpoint sends them, which
  carries "Safe list this sender" style links per message.

The fastest path for DeCheco's is almost always the per-user route: Cory finds
the confirmation in Junk or in a Proofpoint quarantine digest and safe-lists the
sender from there. That requires no admin access and no ticket.

Add **`mg.discocater.com`** and **`orders@discocater.com`**.

> Confidence note: the feature names above (Sender Lists / Safe Senders List,
> org-level and per-user, digest-driven safe-listing) are stable Proofpoint
> Essentials concepts. The exact menu path moves between interface versions, so
> search the admin UI for "Sender Lists" rather than following a fixed
> click-path from this document. If a specific path is needed, get it from
> Proofpoint's current documentation at the time of asking.

### 5.3 Microsoft 365 — `elmwoodparkpizza.com`, `franpizzanj.com`

The supported tenant-wide mechanism is the **Tenant Allow/Block List** in the
Microsoft Defender portal, under Threat policies, where a domain or address is
added as an **Allow** entry. An alternative used by many admins is an **Exchange
mail flow rule** that sets the spam confidence level to `-1` for mail from the
sender.

Note two Microsoft-specific traps worth telling an admin about:

- Adding a sender to an **anti-spam policy's allowed senders/domains** list is
  the obvious-looking option and Microsoft explicitly discourages it, because it
  bypasses filtering more broadly than intended.
- A user adding us to their **personal Safe Senders** in Outlook often does not
  override tenant-level filtering. Per-user action is frequently not enough
  here, unlike Proofpoint.

> Confidence note: Tenant Allow/Block List and the SCL `-1` mail flow rule are
> both well-established. Microsoft renames portal sections often — treat the
> mechanism as reliable and the navigation as needing verification.

### 5.4 Google Workspace — `cenavegan.com`, `winkinrooster.com`

Admin console, Gmail settings, spam/phishing/malware section. The useful control
is the setting that **bypasses spam filtering for messages from senders or
domains in a selected address list**, pointed at an address list containing our
domain. There is also an **Email allowlist**, but it is **IP-based** — per 5.1,
do not use it for Mailgun.

Google is the least likely of the filters here to junk us given DMARC passes, so
this is lower priority.

> Confidence note: mechanism is reliable; exact labels shift.

### 5.5 Barracuda — `firstcomm.com`

Barracuda Email Security Service uses **Sender Policies**, set at domain or user
level, where a domain/address is given an explicit `allow`. Per-user quarantine
notifications also allow end users to allow-list a sender.

> Confidence note: "Sender Policies" is the right concept; verify the path.

### 5.6 AppRiver / SecureTide — `grantinc.com`

AppRiver (SecureTide, now part of OpenText) has an allow-list in its
administrative console, typically managed by the reseller rather than the
customer.

> Confidence note: **lower than the others.** The product has changed ownership
> and branding, and the current console differs from historical documentation.
> Establish the actual path with the customer's provider rather than relying on
> this entry.

### 5.7 SiteGround spam protection — `glenrockpizza.com`

`antispam.mailspamprotection.com` is SiteGround's hosted mail filtering. The
allow-list lives in the SiteGround hosting control panel's email/spam section
and is managed by whoever owns the hosting account.

> Confidence note: **lower.** This is a hosting-provider feature rather than a
> standalone security product; confirm with the account owner.

### 5.8 Self-hosted — `hugostacos.com`, `hugosrestaurant.com`

No vendor. Whoever runs the mail server sets the rule, and there is no general
guidance to give. Ask what they run.

---

## 6. Message Kealoha can send to a restaurant

Reusable as-is. Substitute the restaurant name; drop the last paragraph if the
contact is not technical.

> Subject: Making sure our order emails reach your inbox
>
> Hi <name>,
>
> Order confirmations from us are being filed as junk by your mail provider's
> spam filter rather than landing in your inbox. The emails are being accepted
> and delivered — they are just being put in the wrong folder, so it is easy to
> miss an order.
>
> Two things that fix it:
>
> 1. Find one of our order emails in your Junk or Spam folder and mark it "Not
>    junk" / "Not spam". If your provider sends you a daily quarantine summary,
>    you can also allow the sender directly from that email.
> 2. Ask whoever looks after your email to add these to your safe-sender or
>    allow list:
>
>    - `mg.discocater.com`
>    - `orders@discocater.com`
>
> Our mail is fully authenticated (SPF, DKIM and DMARC all pass), so there is no
> security reason for it to be filtered — allowing it does not weaken your spam
> protection.
>
> Thanks,
> Kealoha

---

## 7. Deliberately not done

- **Not verifying `discocater.com` as a Mailgun sending domain.** It would need
  `include:mailgun.org` added to a root SPF that currently authorises only
  Google Workspace, plus a new DKIM key, and it would couple the Google
  Workspace domain carrying human mail to Mailgun bulk-sending reputation —
  which is the entire reason to send from a subdomain. A brand-new sending
  identity also starts with *zero* reputation, worse than the little
  `mg.discocater.com` has. Real risk on the domain staff email depends on, for
  no deliverability gain.
- **Not switching From to `@mg.discocater.com`.** It aligns everything
  (including strict alignment) and would also remove the "on behalf of", but it
  shows a subdomain address to customers and restaurant staff permanently. The
  usual argument for accepting that — "staff need to be able to reply" — does
  not apply: `DEFAULT_REPLY_TO` is already `kealoha@discocater.com` on every
  send, so replies never go to the From address anyway. The cost is purely
  cosmetic and the benefit over `h:Sender` is negligible.
- **Not enabling open or click tracking.** See section 4.
- **Not asking restaurants to allowlist by IP.** See section 5.1.
</content>
