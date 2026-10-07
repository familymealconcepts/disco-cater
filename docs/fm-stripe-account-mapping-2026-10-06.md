# FamilyMeal Stripe account mapping — the 26 that cannot be linked

**Resolved 2026-10-06 against `familymeal.tbl_stripe_connected_accounts`, through the
SSH tunnel to the FM API droplet. Re-verified against live Stripe 2026-10-07.**

## Why this file exists

These 26 Disco-native restaurants have a Stripe account recorded in FamilyMeal and
no link in Disco. The mapping is REAL and UNAMBIGUOUS — 26 rows, 26 restaurants,
exactly one account each, zero multi-mapped — but **not one of the accounts can be
used**, so there is nothing to link and no amount of tooling will change that.
The remedy is the restaurant reconnecting Stripe through Disco.

The mapping lives only in FamilyMeal's database, behind a tunnel a Vercel cron
cannot open. This file is the recoverable record so neither a restaurant asking
"which account was ours" nor a future restoration of Stripe access needs the
tunnel again.

## Why the ids are NOT stored in a column

Deliberate, and it should stay that way. 80 call sites read
`disco_restaurant_overrides.stripe_account_id`, and the load-bearing ones test
`IS NOT NULL` as a proxy for "payment-ready" — the marketplace feed
(`lib/marketplace-restaurants.ts`), `lib/native-go-live.ts`,
`lib/stripe-readiness.ts`. Writing a dead id there would list all 26 on the
marketplace and have every one refuse at checkout: the exact failure the 3-part
feed rule was built to prevent.

A separate `*_historical` column was considered and rejected too — a dead account
id in a `stripe_`-prefixed column is a trap for whoever reads it next, the same
shape as the sentinel password hash in `disco_restaurant_accounts` that later
needed `password_set_at` to disambiguate.

## The finding

Checked with BOTH the restricted (`rk_live`) and the full (`sk_live`) key; both
authenticate as `acct_1HyQsuKp5OWEZLTA` (Disco Cater), and both return
*"does not have access to account … Application access may have been revoked"*.
A known-good linked account retrieves fine with the same key, so this is not a
key-scope problem. FamilyMeal's own publishable key is `pk_live_51HyQsuKp5OW…` —
the SAME platform — so these are not sitting on a separate FM platform either.

- **25 revoked or deleted in Stripe**
- **1 already held by another restaurant** (linking it would point two restaurants at one payout destination)

## The mapping

| Restaurant | Slug | Restaurant reference | Stripe account (FamilyMeal) | Finding |
|---|---|---|---|---|
| Chicas Tacos - Stanton | `chicastacosstanton` | `6e23e1ba-a31e-4a36-a2df-39385553b2a3` | `acct_1NaPPBGgMUY7dl7m` | revoked or deleted in Stripe |
| DTLA Catering Company  | `dtlacateringcompany` | `aed20bd8-4116-4100-8952-868205c0be14` | `acct_1POnSiCrClya7vXn` | revoked or deleted in Stripe |
| Donna Jean - Los Angeles | `donnajeanlosangeles` | `53fcf938-8b13-4613-a23e-fcaaf99e4571` | `acct_1N3MckJxObXpBQQV` | revoked or deleted in Stripe |
| Firenze: Italian Street Food | `firenze-italian-street-food` | `5c538f30-edce-4820-9c85-007b9e1095ee` | `acct_1NWJwZCrLdN08Oql` | revoked or deleted in Stripe |
| Gordito's Burritos | `losangelescateringcompany` | `a27fa80f-6bba-4eb1-974a-5daffe7f5db1` | `acct_1POnFaBMGBROSKqy` | revoked or deleted in Stripe |
| Gordito's Burritos - Culver City | `gorditosburritosculvercity` | `14c0585d-0f28-4412-890f-e49ebc4f69f7` | `acct_1PJ1AtFDNw437D6w` | revoked or deleted in Stripe |
| Gordito's Burritos - Long Beach | `gorditosburritoslongbeach` | `28e26d54-5773-40c3-8608-fc5184ac35d0` | `acct_1PJ18DHfjvoRMcE2` | revoked or deleted in Stripe |
| Gordito's Burritos - Redondo | `gorditosburritosredondo` | `c665289e-309a-44bb-bc65-be6e38c03b69` | `acct_1PEZgqDROlH0Ixej` | revoked or deleted in Stripe |
| Gordito's Burritos - West Hollywood | `gorditosburritoswesthollywood` | `f316f081-78fd-40ec-98e2-74da43a24151` | `acct_1PJ15YKDV8daNbtK` | revoked or deleted in Stripe |
| HappyBoards Lower Manhattan | `happyboards` | `5f2cf34a-9474-4ad2-92ac-0c384055e895` | `acct_1HC5HEIOFd42CU42` | revoked or deleted in Stripe |
| Jemma Hollywood | `jemmahollywood` | `57f10edf-bfae-4e68-a6d4-e0e459381553` | `acct_1OcYF8LZzQUnGkTn` | revoked or deleted in Stripe |
| Jemma Pizzeria - Palisades Village | `jemmapizzeria-palisadesvillage` | `107aaddf-0dd2-489e-a4b0-089505d3a08d` | `acct_1OlbShF24RenSyPw` | revoked or deleted in Stripe |
| Kalamaki Greek La | `kalamakigreekla` | `54e58c57-ca80-4322-b23e-3c0b43b51b98` | `acct_1DwCdHHdt4L8v989` | revoked or deleted in Stripe |
| Long Beach Catering Company   | `longbeachcateringcompany` | `e50be725-f12c-4462-a464-19694b2a5cf5` | `acct_1POnVJGcGSVSZAYO` | revoked or deleted in Stripe |
| Mav's Top Buns | `Mav'sTopBuns` | `38ab2131-9f97-4631-b636-f0976e82b5cb` | `acct_1KWmijDA6D8DZMCo` | revoked or deleted in Stripe |
| OC Catering Company  | `occateringcompany` | `4bd560d6-5064-481a-8ec1-ef69936a78b2` | `acct_1POnXwKdyVsKBru7` | revoked or deleted in Stripe |
| Ospi Costa Mesa | `ospicostamesa` | `de278463-0890-4690-92f5-fdb4164e8173` | `acct_1QSWADKzp70ilJe9` | revoked or deleted in Stripe |
| Ospi Venice | `ospivenice` | `f395de0b-a134-4f7b-8dce-10e6fd62e05e` | `acct_1OgueqIhoh8D2g87` | revoked or deleted in Stripe |
| Parm Famous Italian - Brooklyn | `parmbrooklyn` | `3e07a8c8-d690-4f8a-97ce-afa7f6a06de7` | `acct_1Rl8s8F8Z3UqrTxg` | revoked or deleted in Stripe |
| Parm Famous Italian - UWS | `parmuws` | `1c82f522-0c47-440f-a6ce-833e5f57f5af` | `acct_1RlvuKHwQWHmkdFm` | revoked or deleted in Stripe |
| Taim Corporate | `copytaim-cityspire` | `48e0dcac-bf3c-49db-9b59-21f8ed6f8524` | `acct_1RTpyRRxs3rz69BJ` | held by another restaurant (Taim - City Spire) |
| Trattoria Moderna Italian Catering - West Hollywood | `trattoriamodernawesthollywood` | `33cb29d2-e4b4-47cd-aea5-43473a3f77a3` | `acct_1POnalD8cXssXdqh` | revoked or deleted in Stripe |
| Woo Woo Burgers - Kyle | `woowooburgerskyle` | `0f1cec77-8975-456e-aea8-0d65304fd3b0` | `acct_1OpaZpBmmYWW6lgO` | revoked or deleted in Stripe |
| Woo Woo Burgers - Scottsdale | `woowooburgersscottsdale` | `ee05785a-fa0a-4f4d-a256-c4d36ee0e4db` | `acct_1OpaapH2bDi0bpA4` | revoked or deleted in Stripe |
| Zucker's Bagels | `zuckersbagels` | `2fd6cf4c-a31c-4ba2-975c-1b9f4279c4e9` | `acct_1RM9s2JDbw6xDX9S` | revoked or deleted in Stripe |
| ¡Jaime! Taqueria | `jaimetaqueria` | `feb26a36-6f1b-4063-a873-e91c27cdc46f` | `acct_1R8jvHP3I6l7Syi3` | revoked or deleted in Stripe |

## If Stripe access is ever restored

Re-check each id with `stripe.accounts.retrieve(...)`. Anything that comes back
`charges_enabled` AND `payouts_enabled` can be linked by
`scripts/link-fm-stripe-accounts.ts`, which maps by reference (never by name or
email — both were measured and rejected; email produced 8 wrong payout
destinations in 179 matches) and refuses to overwrite an account Disco already
holds. Taim Corporate's account must NOT be linked regardless: Taim - City Spire
holds it and is live on it.
