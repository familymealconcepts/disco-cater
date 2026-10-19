# Unconverted restaurants, ranked by lifetime sales

Generated 2026-09-23 · read-only snapshot · **nothing was changed to produce this**

## How this was built

- **"Not yet converted" = `disco_restaurant_cache.is_disco_native = false`.** That column is
  authoritative; `disco_restaurant_accounts.is_disco_native` is stale and was not used.
- **Gross excludes the FamilyMeal 3% fee**, per Peter's ruling of 2026-09-22 — the fee never
  reaches the restaurant. `SUM(order total) − SUM(sale_transaction.fee)`. Fee coverage is
  **99.95%** of revenue orders, so the figure is reliable.
- **Sales count only revenue-bearing statuses**: COMPLETED, DUE, PAID, PARTIAL_REFUND.
  Excluded: CANCELED, VOIDED, EXPIRED, REFUND, UNPAID, REOPEN, RESERVED, PAYMENT_FAILED.
- **NaN guard applied.** `disco_orders.total` holds at least one NaN (EXPIRED rows); coerced to
  0 rather than poisoning a restaurant's whole sum.
- **Active = last ordered on or after 2026-06-25** (90 days). Otherwise Dormant.
- Deleted orders excluded throughout.

### One data caveat worth knowing

"Last ordered" is `COALESCE(placed_at::date, order_date)`. **783 revenue orders have no
`placed_at`** — 503 of them mirror-inserted on 2026-07-27 — so falling back to `created_at`
would have reported the *sync date* as the order date and wrongly marked many restaurants
Active. Local Smoke BBQ - Red Bank, for one, reads 2026-08-15 rather than a spurious 2026-07-27.
`order_date` is the real fulfilment date and is the honest fallback. It is shown separately
because for catering it is often in the future: Colonial Ranch Market last ordered 2026-09-21
for delivery 2026-10-18.

## Headline

| | Restaurants | Gross (ex FM fee) | Share |
|---|---:|---:|---:|
| **Unconverted** | **3,871** | **$4,050,137.09** | 81.0% |
| Converted (Disco-native) | 215 | $950,985.07 | 19.0% |
| **Total** | **4,086** | **$5,001,122.16** | 100% |

Of the 3,871 unconverted restaurants, only **191** have ever placed a revenue
order. The other **3,680** have none — marketplace records with no sales history, not
conversion prospects in any practical sense.

**The opportunity is highly concentrated.** Of $4,050,137.09 across the 191 with sales:

| Segment | Gross (ex FM fee) | Share |
|---|---:|---:|
| Top 10 | $2,237,220.95 | 55.2% |
| Top 25 | $2,931,252.93 | 72.4% |
| Top 50 | $3,487,767.13 | 86.1% |
| Top 100 | $3,948,165.66 | 97.5% |

**Active vs dormant**, among those with sales: **72 active** ($2,719,230.08) ·
**119 dormant** ($1,330,907.01).

---

## 1. Unconverted restaurants WITH sales (191), ranked

| # | Restaurant | Reference | Gross (ex FM fee) | Orders | Last ordered | Latest fulfilment | Status |
|---:|---|---|---:|---:|---|---|---|
| 1 | Colonial Ranch Market (Point Pleasant, NJ) | `ecf9bfdc-eb23-4ce4-b8c6-91ab14061cd5` | $626,438.64 | 4,502 | 2026-09-21 | 2026-10-18 | Active |
| 2 | Westwoods BBQ & Spice Co. (Fresno, CALIFORNIA) | `6c3df4ba-2de5-46bc-8207-a47731956ffc` | $554,400.71 | 1,627 | 2026-09-11 | 2026-09-15 | Active |
| 3 | Bagel Point - Brooklyn (Brooklyn, NY) | `aaa36344-9331-4a84-9c33-1764a4e6ec4f` | $212,556.46 | 354 | 2026-07-27 | 2026-07-27 | Active |
| 4 | 2nd Jetty Seafood | `cc716341-75f4-46f8-b958-1c2426720d33` | $197,435.07 | 921 | 2025-12-22 | 2025-12-24 | Dormant |
| 5 | Local Smoke BBQ - Red Bank (Red Bank, NJ) | `b56b06c5-4ead-4e68-a26c-6e4ff0f82a23` | $195,258.12 | 388 | 2026-08-15 | 2026-08-15 | Active |
| 6 | Marcel Bakery and Kitchen (Montclair, NEW JERSEY) | `e2e1d8ad-6d72-49f5-93e0-ad3504475797` | $119,139.93 | 500 | 2026-05-28 | 2026-06-06 | Dormant |
| 7 | Pie Girl (Hightstown, NJ) | `d7e305da-e0e6-4947-9657-4de1f73d4208` | $95,638.01 | 1,219 | 2026-03-29 | 2026-04-04 | Dormant |
| 8 | Sandy Hook Seafood | `8423cd0f-8c6c-464d-bf03-1d5637cc19e1` | $88,556.35 | 414 | 2025-12-21 | 2025-12-24 | Dormant |
| 9 | Local Smoke BBQ - Sea Girt (Sea Girt, NJ) | `e3494c25-13be-4cf8-aef7-b32b6e88e2c1` | $79,466.09 | 165 | 2026-08-31 | 2026-08-31 | Active |
| 10 | Local Smoke BBQ - Neptune City (Neptune City, NJ) | `f9183a92-57c9-44c3-a9f7-42ed2fd1818b` | $68,331.57 | 145 | 2026-08-09 | 2026-08-09 | Active |
| 11 | Pismo's Coastal Grill (Fresno, CALIFORNIA) | `b8d7e273-3cd1-4827-bd38-ed99c215f6f4` | $63,826.47 | 240 | 2026-07-23 | 2026-07-23 | Active |
| 12 | Black Bear BBQ (Ashville, NC) | `fd1b3e4e-96cd-42f8-bdbe-dc7b822e78d3` | $63,784.61 | 449 | 2025-11-23 | 2025-11-26 | Dormant |
| 13 | Taim - Broadway | `2a41260e-7d69-400a-82da-ca55a21fb9b0` | $63,505.07 | 110 | 2026-01-05 | 2026-01-08 | Dormant |
| 14 | Yosemite Ranch (Fresno, CA) | `7d5aa38b-70d8-4faa-ab3d-18a001587243` | $63,367.98 | 275 | 2026-07-25 | 2026-07-25 | Active |
| 15 | The Speakeatery (Asbury Park, NEW JERSEY) | `a964a352-2e98-440e-8cd3-8af7a72ab39b` | $50,568.41 | 1,088 | 2025-11-19 | 2025-11-23 | Dormant |
| 16 | Point Lobster Co (Point Pleasant Beach, NJ) | `d7e9296e-eabf-41ec-850f-ae951f9871ff` | $48,968.29 | 284 | 2025-12-23 | 2025-12-24 | Dormant |
| 17 | De Nada | `770f731d-dbe0-42ef-89b7-499e2c91f584` | $48,496.81 | 88 | 2026-07-08 | 2026-07-08 | Active |
| 18 | Sweet Chick - Union Square (New York, NY) | `bd974dd6-3c93-4092-831e-8cbaccb73573` | $42,971.30 | 58 | 2026-07-01 | 2026-07-01 | Active |
| 19 | Taim - FIDI | `6c0e6c51-7449-4745-8b8d-9035829d510e` | $41,459.71 | 94 | 2025-12-15 | 2025-12-18 | Dormant |
| 20 | Kipos Greek (Seattle, WA) | `50132136-6008-445b-8c8f-c683ab705128` | $38,761.18 | 64 | 2026-08-26 | 2026-09-03 | Active |
| 21 | Local Smoke BBQ - Cookstown (Cookstown, NJ) | `855250be-d3b1-4932-9c72-2f5ffc52e50b` | $37,359.95 | 66 | 2026-07-25 | 2026-07-25 | Active |
| 22 | Beach Buns Bakery (Northfield, NJ) | `171ac0cd-0df5-4257-8b3d-14d60e5d2c57` | $33,445.24 | 500 | 2026-12-01 | 2026-12-01 | Active |
| 23 | Taim - Nolita | `40f1453c-8d3b-44a8-8831-a041f87909d6` | $33,308.05 | 59 | 2025-12-19 | 2025-12-19 | Dormant |
| 24 | Maciel's Plant-Based Butcher & Deli (Los Angeles, CA) | `5a71f537-14af-4db3-a355-11c188cbd758` | $32,431.94 | 234 | 2026-08-08 | 2026-08-08 | Active |
| 25 | Morning Squeeze (Tempe, AZ) | `8a7bb6f5-25fd-4672-b75c-e2912620116e` | $31,776.97 | 87 | 2026-09-21 | 2026-10-07 | Active |
| 26 | Bloomfield Deli + Catering (Bloomfield Hills, MI) | `70019b5f-8b18-45f3-a96c-6026914014b1` | $30,928.06 | 106 | 2026-07-28 | 2026-07-28 | Active |
| 27 | West Hill Deli (Auburn, WA) | `cab3a831-e8a6-4f90-9a48-b8dd7359e12a` | $30,465.11 | 84 | 2026-08-08 | 2026-08-08 | Active |
| 28 | Sweet Chick - Prospect Heights (NY, NY) | `e5bf4b04-6df2-4598-876c-32198a0df6c2` | $28,383.91 | 52 | 2026-06-28 | 2026-06-28 | Active |
| 29 | Taim - Dupont Circle | `cc260670-20f6-48a0-a051-2367aacb3396` | $28,201.49 | 65 | 2025-12-17 | 2026-01-23 | Dormant |
| 30 | Pete's Bagels - St. Pete (St. Petersburg, FL) | `27e20709-bb8f-4a18-8720-1fda18c0f945` | $28,193.28 | 245 | 2026-09-14 | 2026-09-18 | Active |
| 31 | The Eatery of Wallingford | `96cd6980-b4c4-4f93-8239-22631930edf7` | $25,009.13 | 77 | 2026-07-16 | 2026-07-16 | Active |
| 32 | Taim - City Spire | `9921339a-c3f2-4089-ab03-1770fda0fa5d` | $24,430.52 | 55 | 2025-12-19 | 2025-12-21 | Dormant |
| 33 | Chicas Tacos - Miracle Mile (Los Angeles, CA) | `52bdfffe-68a5-43ed-a5a7-277c1daccfcd` | $24,368.00 | 46 | 2026-09-15 | 2026-09-16 | Active |
| 34 | Krewe of McGinley Square (Jersey City, NJ) | `2231d163-eb41-4d23-8cd9-ab5238d82cc3` | $23,078.20 | 37 | 2026-09-16 | 2026-09-19 | Active |
| 35 | WannaBee Chef (Hillsdale, NJ) | `ba06ace8-8bc2-494d-b7e7-1002b24c5d80` | $22,215.94 | 188 | 2023-11-08 | 2023-11-13 | Dormant |
| 36 | El Burro (Pittsburgh, PA) | `d10052f1-0e36-47d1-8496-4fece29a0845` | $22,186.44 | 49 | 2026-07-15 | 2026-07-15 | Active |
| 37 | Taim - Hoyt | `7e6d3fc6-686c-4166-8104-2588197d9c37` | $21,999.11 | 36 | 2025-12-10 | 2025-12-12 | Dormant |
| 38 | FANTZYE (Kingston, NY) | `01d5c182-e8ed-454a-beb5-fc8f1354b4f2` | $21,965.35 | 248 | 2026-09-21 | 2026-09-27 | Active |
| 39 | Taim - West Village | `7d1314cd-1178-4e18-8d57-02ca42823269` | $21,507.59 | 47 | 2025-12-06 | 2025-12-21 | Dormant |
| 40 | 10th Ave. Burrito Co. (Belmar, NJ) | `99f78eb8-3d2e-4e48-8b10-d707055443e6` | $20,534.51 | 50 | 2026-08-12 | 2026-08-12 | Active |
| 41 | Wax Paper - Frogtown (Los Angeles, CA) | `1c2d6427-1b06-43ef-a109-e251992971c2` | $19,778.11 | 38 | 2026-09-17 | 2026-09-26 | Active |
| 42 | Little Chef Little Cafe (5-43 48th Ave, NEW YORK) | `ecc9a6e7-61e0-4808-98ba-3e43574a32af` | $19,477.15 | 265 | 2026-08-29 | 2026-09-01 | Active |
| 43 | Shine Provisions (Longmont, CO) | `c707d99e-7cb0-4ac2-a4c2-62bb747e8870` | $19,152.33 | 111 | 2022-11-22 | 2022-11-23 | Dormant |
| 44 | Bagel Miller (Chicago, IL) | `1726e0cf-168b-4bc3-9e50-444566b6dc16` | $18,853.54 | 230 | 2026-07-22 | 2026-07-24 | Active |
| 45 | 3 Pepper Burrito Co. Fort Myers – Daniels Crossing (Fort Myers, FL) | `72f5d6e0-f460-4c29-8073-1c809798269f` | $18,497.26 | 49 | 2026-05-13 | 2026-05-15 | Dormant |
| 46 | 3 Pepper Burrito Co. Estero (Estero, FL) | `c9f909fa-9494-4e96-b01c-4337db6e7120` | $18,195.21 | 45 | 2026-05-20 | 2026-05-24 | Dormant |
| 47 | Willa's (Tampa, FL) | `4b4aa9a9-1972-4c42-8b5e-7c276250bc90` | $17,757.01 | 71 | 2026-04-19 | 2026-04-25 | Dormant |
| 48 | oomi kitchen (Dallas, TX) | `f00dc9d9-57d4-4363-8bac-2d604844a89a` | $17,599.19 | 17 | 2026-05-22 | 2026-05-22 | Dormant |
| 49 | Sweet Chick - Long Island City (NY, NY) | `f45c3e57-664b-4760-9051-fe95717951bc` | $17,390.04 | 29 | 2026-08-18 | 2026-08-22 | Active |
| 50 | Tinga Fresh Mexican (Montclair, NJ) | `994a132d-b35d-427f-b57a-07d0880c85da` | $16,347.72 | 54 | 2026-07-10 | 2026-07-10 | Active |
| 51 | Son del North - LES (New York, NY) | `2156d12f-96bb-4b1d-9339-99fbfdbfd853` | $16,124.95 | 21 | 2026-09-15 | 2026-09-17 | Active |
| 52 | 3 Pepper Burrito Co. Fort Myers – College Plaza (Fort Myers, FL) | `a4221571-85f2-4416-b634-7f98e3e2d6f2` | $16,096.05 | 52 | 2026-05-19 | 2026-05-20 | Dormant |
| 53 | 3 Pepper Burrito Co. Cape Coral (Cape Coral, FL) | `c02f541a-8ee8-4e73-881d-72dd8a553629` | $15,841.88 | 46 | 2026-05-11 | 2026-05-16 | Dormant |
| 54 | Panatieri's Pizza & Pasta of Flemington (Flemington, NJ) | `d15f7b7e-7706-4a3e-8173-2546c8cd40dd` | $15,679.82 | 62 | 2026-07-18 | 2026-07-18 | Active |
| 55 | Pete's Bagels - Ybor (Tampa, FL) | `987c6e9d-3a6a-4101-a207-fe8ab1702c2d` | $15,643.51 | 120 | 2026-07-27 | 2026-07-27 | Active |
| 56 | Local Pig (Kansas City, MO) | `addc4871-8f98-451b-824f-26b58c426795` | $14,426.02 | 20 | 2026-07-15 | 2026-07-15 | Active |
| 57 | Signature Fitness (Belleville, NJ) | `8612519b-0c67-4da0-9f44-39cfe7452e13` | $14,340.98 | 122 | 2026-07-13 | 2026-07-13 | Active |
| 58 | Sweet Chick - Williamsburg (NY, NY) | `8316170c-5b34-499d-ad5f-013f0a1f3a87` | $13,862.37 | 22 | 2026-07-04 | 2026-07-04 | Active |
| 59 | 3 Pepper Burrito Co. Ft Myers - The Forum (Fort Myers, FL) | `9ea35001-2d8a-437e-8586-4a619d6118eb` | $13,740.45 | 33 | 2026-05-17 | 2026-05-30 | Dormant |
| 60 | Benchmark Breads (Little Silver, NJ) | `95adff9f-87d2-4eae-830c-732efe67babe` | $13,656.50 | 312 | 2025-12-22 | 2025-12-23 | Dormant |
| 61 | The Biz Catering (Los Angeles, CA) | `73a401e6-2733-4715-9ca9-b2edcb44836f` | $13,599.44 | 21 | 2025-06-13 | 2025-06-16 | Dormant |
| 62 | Tipsy Cafe & Catering (Philadelphia, PA) | `876ceb3f-d651-49aa-b8e2-f8589fb39fc6` | $13,559.96 | 30 | 2026-07-26 | 2026-07-26 | Active |
| 63 | Maíz Catering (Portland, ME) | `bf8ad038-1a3f-4075-8fcc-35e40e587b0c` | $12,590.04 | 29 | 2026-08-01 | 2026-08-01 | Active |
| 64 | Hatch 44 Cafe - Metuchen (Metuchen, NJ) | `602bc62b-06de-47f8-896a-cad6e951d98a` | $11,944.17 | 66 | 2026-06-09 | 2026-06-13 | Dormant |
| 65 | Hoboken Pie (Austin, TX) | `853a9b23-3626-4126-8804-1b07ade7756e` | $11,611.12 | 19 | 2026-05-18 | 2026-05-29 | Dormant |
| 66 | Northside Inc. Cafe (David City, NE) | `79adde42-639c-442b-8e31-781e3003b5c9` | $11,083.79 | 165 | 2026-09-21 | 2026-09-26 | Active |
| 67 | 3 Pepper Burrito Co. Ft Myers – Downtown (Fort Myers, FL) | `97a86475-ec10-4590-a2a9-ea358004735b` | $10,976.12 | 35 | 2026-05-04 | 2026-05-29 | Dormant |
| 68 | Taim - LIC / JACX&CO | `8a76bb6c-9d21-4b1c-9b05-88ca3a760bf2` | $10,862.38 | 15 | 2025-11-17 | 2025-11-19 | Dormant |
| 69 | Taim - Park Slope | `21e4c809-e932-4713-9d98-28b089d6cfd9` | $10,854.64 | 21 | 2025-12-12 | 2025-12-13 | Dormant |
| 70 | Pecking House - Chinatown (New York, NY) | `0a889051-3e7e-4b4d-a760-a8767153cd34` | $10,851.69 | 24 | 2026-05-08 | 2026-05-09 | Dormant |
| 71 | Taim - Plainview | `5ca70757-d75e-4472-baf3-0fd9b1d1848f` | $9,636.70 | 21 | 2025-12-04 | 2025-12-04 | Dormant |
| 72 | Surf Taco - Red Bank (Red Bank, NJ) | `5883ed95-d7c6-4c5a-b0da-a9ab02b6addf` | $9,364.41 | 19 | 2026-06-25 | 2026-06-25 | Active |
| 73 | The Onion Tree - Sea Cliff (Sea Cliff, NY) | `cee78f21-8ad6-4cf2-b9f8-f4249d6f90d5` | $9,323.50 | 27 | 2025-12-04 | 2025-12-06 | Dormant |
| 74 | 3 Pepper Burrito Port Charlotte (Port Charlotte, FL) | `dfe218bb-ec18-4620-9a8a-91fa9b90cb0c` | $9,087.95 | 35 | 2026-05-21 | 2026-05-23 | Dormant |
| 75 | Surf Taco - Point Pleasant (Point Pleasant, NJ) | `140bbdbb-fd95-4bff-9379-b6926ccb8f50` | $8,924.55 | 21 | 2026-07-19 | 2026-08-08 | Active |
| 76 | 29 Hance Bakehouse (Atlantic Highlands, NJ) | `8978b7a2-c373-48fb-ae07-e32d784f8903` | $8,378.15 | 109 | 2026-01-08 | 2026-01-10 | Dormant |
| 77 | Habana Cuba Restaurant (San Jose, CA) | `e68bb428-2136-4d73-9471-f9fad0ab3c03` | $7,858.25 | 16 | 2026-05-21 | 2026-05-26 | Dormant |
| 78 | Lechon Loco (Tacoma, WA) | `f4fe7c19-667a-44de-bd4e-635bb5ad6eca` | $7,730.23 | 20 | 2026-07-26 | 2026-07-26 | Active |
| 79 | Anchor Produce Market (Surf City, NJ) | `c825a64e-a5d3-4409-9f25-0612ed272ce2` | $7,727.21 | 33 | 2026-07-25 | 2026-07-25 | Active |
| 80 | Industry - Austin (Austin, TX) | `fc29f1ae-ef76-4d56-845e-2efd15adc7c0` | $7,517.86 | 11 | 2026-08-20 | 2026-08-24 | Active |
| 81 | Howlin' Willy's - Druid Hills (Druid Hills, GA) | `d8916675-b403-4035-87d8-0f3629f83b99` | $7,478.70 | 11 | 2025-10-01 | 2025-10-08 | Dormant |
| 82 | Sweet Chick - LES (New York, NY) | `96e03a5d-fc4f-45ea-a836-858f00cf1989` | $7,049.38 | 17 | 2026-05-14 | 2026-05-16 | Dormant |
| 83 | The Potato Concept | `941c9eab-8f58-49ad-8332-c8d73fac984c` | $6,717.44 | 17 | 2025-01-25 | 2025-03-01 | Dormant |
| 84 | General Tso's (Atlanta, GA) | `020c7411-1634-4700-b4fd-b4938442afbe` | $6,130.92 | 10 | 2025-04-20 | 2025-04-22 | Dormant |
| 85 | Howlin' Willy's - East Cobb (Marietta, GA) | `2b49792b-2e3e-4e9c-87c7-613da21af59c` | $6,101.26 | 23 | 2026-05-13 | 2026-05-16 | Dormant |
| 86 | The Tattooed Pig - Media (Media, PA) | `91067a15-0173-4541-95dd-deca007b111d` | $5,885.61 | 13 | 2025-04-01 | 2025-04-10 | Dormant |
| 87 | Lunetta (Santa Monica, CA) | `f25b21f9-716d-43f7-ae21-ce6a0e81939b` | $5,704.83 | 14 | 2026-06-25 | 2026-06-25 | Active |
| 88 | Urban CoalHouse - Red Bank (Red Bank, NJ) | `144d2786-88f5-499f-919e-cab20a5401e9` | $5,592.88 | 31 | 2026-07-21 | 2026-07-24 | Active |
| 89 | Mr. M's Sandwich Shop (Dania Beach, FL) | `e17118c1-bb26-4720-9725-6c8448c804f7` | $5,507.55 | 20 | 2026-07-21 | 2026-07-21 | Active |
| 90 | Pelons Tex Mex (Austin, TX) | `29f6688e-ee59-4226-af9f-8525c53fd8ec` | $5,410.84 | 10 | 2026-08-29 | 2026-08-31 | Active |
| 91 | Hatch 44 Cafe - Bradley Beach (Bradley Beach, NJ) | `78c5d87c-a460-43d7-b9e4-da79dd2a98de` | $5,225.06 | 21 | 2026-06-28 | 2026-06-28 | Active |
| 92 | Surf Taco - Wall (Wall Township, NJ) | `946e86f1-0cf3-4706-b985-4a5c7f75f211` | $5,003.73 | 12 | 2025-10-23 | 2025-10-24 | Dormant |
| 93 | Lil' Easy (Austin, TX) | `55e1ee63-91dd-49fc-b090-8e7334d2fa8d` | $4,850.62 | 8 | 2025-05-23 | 2025-05-29 | Dormant |
| 94 | Surf Taco - Manasquan (Manasquan, NJ) | `90104ec3-9713-4a1d-bb90-25362266842f` | $4,622.13 | 14 | 2026-06-27 | 2026-06-27 | Active |
| 95 | Crackin’ Yolks (Los Angeles, CA) | `14be4279-b234-40e9-9a03-9d0ade421440` | $4,613.58 | 8 | 2025-02-06 | 2025-02-10 | Dormant |
| 96 | Surf Taco - Silverton (Toms River, NJ) | `c9080d63-d875-4dcf-8216-d34eb46be2c8` | $4,479.87 | 14 | 2026-07-25 | 2026-07-25 | Active |
| 97 | Smokies Craft BBQ (Bayville, NJ) | `639cd82d-cec2-4464-8a5f-7c5beaebcc5f` | $4,385.25 | 10 | 2024-11-16 | 2024-11-27 | Dormant |
| 98 | 502 Baking Company (Brick Township, NJ) | `41f0fd33-9ccf-42c1-bbe0-f541cbef5c9f` | $4,307.43 | 74 | 2025-12-19 | 2025-12-24 | Dormant |
| 99 | Rinconcito DOMEX (Brooklyn, BROOKLYN) | `7ce53dc5-6f6e-499f-b13b-5bf51f774abe` | $4,241.05 | 5 | 2025-06-02 | 2025-06-04 | Dormant |
| 100 | Bakes Gone Wild (Lincroft, NJ) | `25318806-28a6-46ef-8319-32b28628a024` | $4,195.71 | 52 | 2023-08-22 | 2023-08-25 | Dormant |
| 101 | Son del North - West Village (New York, NY) | `2c39c942-d21b-43ec-b086-691760cb290d` | $4,132.88 | 6 | 2026-09-22 | 2026-09-30 | Active |
| 102 | Delco Rose Hoagies (Los Angeles, CA) | `1e379942-9460-4cb3-bbf8-921177e98495` | $4,081.88 | 15 | 2026-07-01 | 2026-07-04 | Active |
| 103 | Urban CoalHouse - Hoboken (Hoboken, NJ) | `1d7e9a99-37ed-4986-b19a-5d6ac32e06ed` | $3,611.84 | 23 | 2026-05-17 | 2026-05-22 | Dormant |
| 104 | Plum Caterers (Aston, PA) | `c2e1e477-29b4-4558-b9a6-ca811bf7096e` | $3,245.92 | 7 | 2025-06-17 | 2025-06-19 | Dormant |
| 105 | Junbi - San Francisco (San Francisco, CA) | `666ef413-1d42-496f-9cde-1d890737e3f6` | $3,215.60 | 14 | 2026-06-05 | 2026-06-24 | Dormant |
| 106 | Doce Donut Co (Seattle, WA) | `86091c9b-e1d3-453c-96eb-be183ebf7c2f` | $3,213.41 | 15 | 2026-06-08 | 2026-06-13 | Dormant |
| 107 | Dinner Parties Do Good (Chicago, IL) | `8e9de986-4682-403e-99a4-b19055a92bb1` | $2,913.50 | 28 | 2023-01-04 | 2023-01-14 | Dormant |
| 108 | Krewe De Fromage (New York, NY) | `a2010d86-3abc-43bc-973d-5c1387e0cef2` | $2,880.72 | 21 | 2023-04-07 | 2023-04-09 | Dormant |
| 109 | Tasty Dawg (Columbus, OHIO) | `e49197f1-64f2-4cd3-b769-273e9056da25` | $2,793.38 | 8 | 2026-07-27 | 2026-07-31 | Active |
| 110 | Three Dollar Cafe - Stockbridge (Stockbridge, GA) | `2d642782-4ef4-4029-b7f2-de24a47f950f` | $2,747.26 | 12 | 2026-09-22 | 2026-09-21 | Active |
| 111 | Railroad BBQ (Columbia, SC) | `147599e9-bc77-4b95-9045-8814813495e4` | $2,714.72 | 6 | 2026-07-01 | 2026-07-08 | Active |
| 112 | Bloom Restaurant  (Roanoke, VA) | `0b8bea35-171a-449b-b18d-d45f99a4a43d` | $2,486.39 | 40 | 2025-12-18 | 2025-12-19 | Dormant |
| 113 | 3 Pepper Burrito Co. Lehigh Acres (Lehigh Acres, FL) | `16a0ed89-fbd6-484f-a4e7-88cce9e66a44` | $2,478.53 | 6 | 2026-05-06 | 2026-05-09 | Dormant |
| 114 | The Tattooed Pig - Aston (Aston, PA) | `c15614db-ceb0-4d1f-9fad-47ac8f73651e` | $2,434.45 | 7 | 2025-03-20 | 2025-03-23 | Dormant |
| 115 | El Mercado Mexican Kitchen (Newport Beach, CA) | `be74639e-601d-4832-b794-37b3f22196cf` | $2,416.26 | 8 | 2026-08-15 | 2026-08-19 | Active |
| 116 | Broasted Brothers - Plymouth (Plymouth, MI) | `752fb7f6-7d75-4e09-ac87-416a8b28fb24` | $2,287.93 | 8 | 2024-12-19 | 2024-12-24 | Dormant |
| 117 | Moaaz Mediterranean Grill (Rahway, NEW JERSEY) | `76f854f0-7fe8-4edf-a60c-790c0fd22434` | $2,284.89 | 8 | 2025-09-06 | 2025-09-07 | Dormant |
| 118 | Urban CoalHouse - Brick (Brick Township, NJ) | `3938f480-0b55-4d16-b586-908115553b9c` | $2,141.98 | 15 | 2026-07-25 | 2026-07-26 | Active |
| 119 | Coliseum Caterers (Plainview, NY) | `91c64e55-5832-4ecd-ac7f-40aafa3cbeb8` | $2,122.19 | 6 | 2023-12-22 | 2023-12-30 | Dormant |
| 120 | Surf Taco - Lacey (Lacey Township, NJ) | `d150a80d-e88f-4936-8259-cf5bef0785ae` | $2,091.95 | 6 | 2026-04-30 | 2026-05-02 | Dormant |
| 121 | Pastosa Ravioli - Manasquan (Manasquan, NJ) | `e6b22697-d8a4-4bbd-bef4-197dd851db00` | $2,026.22 | 4 | 2026-06-27 | 2026-06-27 | Active |
| 122 | Zutto - Nolita (New York, NY) | `780e32c9-33dd-4ee0-829b-ea72a0b8907d` | $1,980.07 | 8 | 2024-07-12 | 2024-07-18 | Dormant |
| 123 | See No Evil Pizza (New York, NY) | `1464ab45-8b64-4f78-a634-6730bbe30bd3` | $1,952.00 | 5 | 2026-07-20 | 2026-07-22 | Active |
| 124 | Hearthly Burger - Shrewsbury (Shrewsbury, NJ) | `f3afe471-08b1-47ee-a121-95cd554408ea` | $1,783.94 | 18 | 2026-07-04 | 2026-07-04 | Active |
| 125 | Franco's Italian Restaurant (Henrico, VA) | `fedad06c-0720-44fa-be94-02e2553c8d1e` | $1,748.92 | 8 | 2025-12-22 | 2025-12-23 | Dormant |
| 126 | Barons Bagel's - Point Pleasant (Point Pleasant, NJ) | `171b5f5e-b8cc-4f51-9631-8bbff001f572` | $1,721.85 | 19 | 2026-09-22 | 2026-10-04 | Active |
| 127 | Surf Taco - Long Branch (Long Branch, NJ) | `c3f2e62f-5a76-4a6f-b6de-3cc858b4e81e` | $1,699.01 | 4 | 2026-03-18 | 2026-03-19 | Dormant |
| 128 | East Wind Snack Shop (NY, NY) | `11dfdac6-67cb-4289-ae79-e9fbcec59aa2` | $1,628.38 | 5 | 2026-08-18 | 2026-08-27 | Active |
| 129 | Sigri (North Brunswick Township, NJ) | `7062135b-6bc5-49ed-b97f-df9de350f3a0` | $1,617.68 | 4 | 2026-04-06 | 2026-04-07 | Dormant |
| 130 | Taqueria Al Pastor - Bushwick (Brooklyn, NY) | `831e3c2e-855a-4925-8919-2b463bf4cb63` | $1,523.23 | 2 | 2024-03-01 | 2024-03-16 | Dormant |
| 131 | Charlie’s Farm Market (Mantoloking, NJ) | `e4c33bfc-8aa9-4b79-a6ea-acc3246fe51e` | $1,482.70 | 8 | 2026-07-18 | 2026-07-18 | Active |
| 132 | Howlin' Willy's - Hapeville (Atlanta, GA) | `fcc7c70d-32b7-41a0-a1c9-f16951f7481d` | $1,313.01 | 3 | 2026-01-18 | 2026-01-19 | Dormant |
| 133 | Barons Bagel's - Brick (Brick Township, NJ) | `1f1dcfca-99ca-4017-b34f-4a1cd95cbd2e` | $1,268.42 | 11 | 2026-09-09 | 2026-09-13 | Active |
| 134 | Das Good Cafe  (Philadelphia, PA) | `d8d27e83-a9b5-421f-b13b-611a3e316772` | $1,263.60 | 9 | 2025-04-19 | 2025-04-23 | Dormant |
| 135 | Test Kitchen | `c8322ff4-32dd-47bc-8515-3f0cffc34bbf` | $1,245.08 | 81 | 2026-07-15 | 2026-07-15 | Active |
| 136 | The Smoky Cottage (Red Bank, NJ) | `36cda559-452f-4b54-9c5d-202bae55d6d0` | $1,203.70 | 4 | 2024-02-20 | 2024-02-24 | Dormant |
| 137 | Chef Kenneth Clay  | `776d00e0-a826-4cbd-a29f-1eab52a62245` | $1,173.70 | 16 | 2025-12-11 | 2025-12-12 | Dormant |
| 138 | The Commons Chelsea (New York, NY) | `c6258978-adac-4f41-9b56-f7b6ef379a99` | $1,149.31 | 1 | 2026-05-28 | 2026-06-02 | Dormant |
| 139 | Salad House  (Westfield, NJ) | `6b9d5c5b-0f2e-41a8-8323-0ed5d67e9086` | $1,143.68 | 25 | 2024-06-01 | 2024-06-02 | Dormant |
| 140 | Industry - San Marcos (San Marcos, TX) | `3e00758b-4fc0-43a2-bd3a-77955ba756ab` | $1,086.64 | 2 | 2025-10-10 | 2025-10-31 | Dormant |
| 141 | Bertolone's (Calera, AL) | `526c5ef1-8d5f-4ac5-995d-3134b549197a` | $1,073.41 | 3 | 2026-09-22 | 2026-09-27 | Active |
| 142 | Rooted Cafe & Catering (Austin, TX) | `caec6029-135a-4aa5-9866-38356f3955e1` | $973.49 | 7 | 2026-08-01 | 2026-08-01 | Active |
| 143 | Good&Fantzye (Oak Bluffs, MA) | `6bfd9d8f-3070-4a17-8051-4d82d4ba0633` | $952.00 | 4 | 2024-06-17 | 2024-06-20 | Dormant |
| 144 | Alfreda (Washington, DC) | `a7ebd350-e0e6-4321-ab56-047b9fc3f1be` | $928.90 | 3 | 2026-06-06 | 2026-06-14 | Dormant |
| 145 | Fotinis Fit Fuel (East Windsor, NJ) | `0943bf4d-ad2f-4ef3-b063-063030c6de38` | $925.57 | 11 | 2025-03-15 | 2025-03-20 | Dormant |
| 146 | Ugly Duckling (Portland, ME) | `c8447ce0-c4b9-4d66-ab31-c676df8bb21b` | $924.37 | 17 | 2025-12-16 | 2025-12-24 | Dormant |
| 147 | Little Egg (NY, NY) | `51c8f90a-bf9c-4ea0-8b83-ebcb47a9ead9` | $924.30 | 2 | 2026-07-18 | 2026-07-20 | Active |
| 148 | 3 Pepper Burrito Co. Bradenton (Bradenton, FL) | `5e35c2c0-f1fc-49d9-a487-7e41648d09ab` | $862.45 | 3 | 2026-04-29 | 2026-05-06 | Dormant |
| 149 | Donna Jean - San Diego (San Diego, CA) | `bcc6ff2c-07f6-4f90-bc26-37e95b9caf68` | $792.61 | 8 | 2023-11-17 | 2023-11-22 | Dormant |
| 150 | The Pink Waffle (Biddeford, ME) | `6de3d1d7-ebab-49ce-9b9d-f28d12327a9b` | $710.29 | 2 | 2023-12-04 | 2023-12-19 | Dormant |
| 151 | Brooklyn Boys Pizza & Deli (Edison, NJ) | `41bd3847-3dc7-49bc-b00d-b91c956dc3b9` | $697.61 | 4 | 2026-05-01 | 2026-05-04 | Dormant |
| 152 | Seymour's (St. Petersburg, FL) | `223c0ab5-c34a-4abc-aaae-087ce035c58a` | $558.02 | 4 | 2026-08-17 | 2026-08-19 | Active |
| 153 | Strange Delight (NY, NY) | `6ab75b4f-edf4-4b16-ab75-fd0690de8ea1` | $534.88 | 6 | 2026-05-28 | 2026-05-30 | Dormant |
| 154 | John's Place (Chicago, IL) | `6e4b3828-d96f-4975-aa92-47fb0e3821e2` | $473.90 | 2 | 2025-04-30 | 2025-05-02 | Dormant |
| 155 | Gordito's Burritos (Los Angeles, CA) | `cc006ff3-9013-47ec-a88f-d57886fd14eb` | $416.54 | 1 | 2026-02-11 | 2026-02-12 | Dormant |
| 156 | Rice N Spice | `0eff5d05-b021-4171-b856-fb80050a908b` | $414.44 | 5 | 2024-02-10 | 2024-02-11 | Dormant |
| 157 | Inga's Alpine Tavern (Denver, CO) | `31d0d046-ad5f-4ab1-be90-8483fc9bd2a0` | $399.84 | 3 | 2026-06-26 | 2026-06-27 | Active |
| 158 | Pollen Basket (Sea Bright, NJ) | `760d6c2f-ea51-42d8-9b35-1d98e2759735` | $299.04 | 8 | 2022-12-19 | 2022-12-23 | Dormant |
| 159 | Pancho LS (Little Silver, NJ) | `c4d87805-18f1-4dd8-ab13-8e666b2df290` | $284.87 | 4 | 2022-02-11 | 2022-02-13 | Dormant |
| 160 | White Maple Cafe (Ridgewood, NJ) | `c4ab5f8b-c97f-44cf-889b-cd4553d27048` | $261.49 | 1 | 2024-12-05 | 2024-12-22 | Dormant |
| 161 | Donna Jean - Los Angeles (Sherman Oaks, CA) | `53fcf938-8b13-4613-a23e-fcaaf99e4571` | $236.02 | 3 | 2023-11-10 | 2023-11-22 | Dormant |
| 162 | Rock n Roots (Williston Park, NY) | `9cce421e-fffb-4919-ac69-bd8a5bcf75ff` | $219.43 | 3 | 2023-05-31 | 2023-06-03 | Dormant |
| 163 | Shore Good Eats (Neptune City, NJ) | `f979249c-72ae-42e5-9656-b50373420bd0` | $215.51 | 3 | 2022-11-15 | 2022-12-17 | Dormant |
| 164 | Crispy Karma (NY, NY) | `3269312e-06c5-44f3-89fc-36b046d598e9` | $197.23 | 2 | 2026-08-21 | 2026-08-22 | Active |
| 165 | Keep It Sweet Desserts (Tenafly, NJ) | `872d4c9f-6486-4304-ae44-7aaada09dd30` | $185.00 | 5 | 2022-10-04 | 2022-10-29 | Dormant |
| 166 | Kneaded by Lady J (Brielle, NJ) | `bdf5b80c-29bb-4fb2-84e6-9c18bf8aee5b` | $160.86 | 4 | 2022-06-20 | 2022-06-24 | Dormant |
| 167 | Pixlcat Coffee - Mid Market | `6664c604-c440-4dea-9dee-28a7e8810801` | $146.04 | 1 | 2024-08-21 | 2024-08-22 | Dormant |
| 168 | Nina & Rafi (Atlanta , GA) | `cc7b656b-1ab8-40bb-8c98-b985b497a8fb` | $139.45 | 2 | 2022-02-11 | 2022-02-13 | Dormant |
| 169 | Pixlcat Coffee - Inner Richmond | `842cefa6-4f33-4936-a546-c055611b0e93` | $135.00 | 1 | 2025-04-20 | 2025-04-27 | Dormant |
| 170 | Starvin' Arvin's Catering (Huntington, WV) | `7159e4b8-0b6c-45f6-8425-27eb5c744502` | $131.10 | 2 | 2026-04-16 | 2026-04-17 | Dormant |
| 171 | SouzaFit - Hoboken (Hoboken, NJ) | `561fb1e9-8794-4e15-a5ad-90bce5610996` | $123.46 | 2 | 2023-09-15 | 2023-09-16 | Dormant |
| 172 | 5ive Spice LES | `362ac33f-e9a1-4112-b309-5481393d6f5e` | $108.28 | 2 | 2021-10-21 | 2021-10-25 | Dormant |
| 173 | Crum and Companie (Oceanport, NJ) | `f8d6237a-5fc7-4dca-98f0-0b705523546c` | $75.72 | 3 | 2023-07-06 | 2023-07-08 | Dormant |
| 174 | Taim - Fresh Meadows, Queens | `89255708-f0af-41bd-9f1e-01a863aa07a3` | $60.32 | 2 | 2025-08-22 | 2025-08-22 | Dormant |
| 175 | Johns Cracker Barrel (Neptune, NJ) | `f630672f-5e31-4a44-83a4-0271db1733aa` | $53.19 | 1 | 2022-02-11 | 2022-02-13 | Dormant |
| 176 | Tings Things Food Truck (Longmont, CO) | `8e542c81-fa92-4cb8-bb12-ff9b737d4087` | $38.15 | 2 | 2022-06-08 | 2022-06-11 | Dormant |
| 177 | Something Green (New York, NY) | `b4acebdb-7295-4870-af0d-1b29383449a6` | $5.45 | 5 | 2026-02-18 | 2026-02-25 | Dormant |
| 178 | Gnocchi on 9th - East Village (New York, NY) | `dfc2c8e4-03d3-47c4-aad5-4ed5eb7e73da` | $4.36 | 4 | 2026-04-09 | 2026-04-22 | Dormant |
| 179 | Mi 'N Tea (Philadelphia, PA) | `38d3a921-4fb4-4356-ab19-31cec0a233cb` | $2.41 | 2 | 2023-04-13 | 2023-04-14 | Dormant |
| 180 | eléa (New York, NY) | `7f8657c5-368a-4841-adbb-363a2030d1c3` | $2.28 | 2 | 2026-03-10 | 2026-03-16 | Dormant |
| 181 | GERTIE (NY, NY) | `b66136e0-b683-41ce-9061-21d0f6f18113` | $2.18 | 2 | 2025-04-16 | 2025-04-18 | Dormant |
| 182 | Slate Cafe (New York, NY) | `47b3b5bc-9ed5-4c35-9271-4aae9f6b9dfd` | $2.18 | 2 | 2026-04-17 | 2026-04-22 | Dormant |
| 183 | The Juice Standard (Henderson, NV) | `370a4ded-6a82-4f66-97b9-9a821ddd915b` | $2.16 | 2 | 2026-02-24 | 2026-02-27 | Dormant |
| 184 | Cotton’s Place (Philadelphia, PA) | `bed1392d-4e4f-465e-87e9-3ee2f24a6bc6` | $2.16 | 2 | 2026-01-29 | 2026-02-02 | Dormant |
| 185 | Pizza Heaven (Belmar, NJ) | `beafc22e-68dc-443c-a8a5-81dca1779c01` | $2.14 | 2 | 2023-06-20 | 2023-06-20 | Dormant |
| 186 | Three Dollar Cafe - McDonough (McDonough, GA) | `63d96c4d-761a-439f-bf95-9b6043986b6b` | $1.11 | 1 | 2026-05-04 | 2026-05-11 | Dormant |
| 187 | BurgerFi - Falls Church (Falls Church, VA) | `ca123d68-c04e-4edd-bc11-8d15f2fa45c1` | $1.10 | 1 | 2026-01-07 | 2026-01-09 | Dormant |
| 188 | Zucker's Bagels (New York, NY) | `2fd6cf4c-a31c-4ba2-975c-1b9f4279c4e9` | $1.09 | 1 | 2025-05-07 | 2025-05-08 | Dormant |
| 189 | SmackBird Chicken - Wylie (Wylie, TX) | `cb87b777-d972-473c-91d2-582a4b0bffc3` | $1.08 | 1 | 2026-06-21 | 2026-06-21 | Dormant |
| 190 | One Lev (Bogota, NJ) | `af6ade2d-de43-4832-8a86-9378af23be87` | $1.07 | 1 | 2026-04-22 | 2026-04-27 | Dormant |
| 191 | Winfield Street Coffee - Naples North (Naples, FL) | `b6365e09-3a30-4221-a724-e05876b70593` | $1.06 | 1 | 2024-04-19 | 2024-04-20 | Dormant |

---

## 2. Unconverted restaurants with NO revenue orders (3,680)

Every one has 0 revenue orders and $0.00 gross. Listed for completeness. Alphabetical.

| # | Restaurant | Reference |
|---:|---|---|
| 1 | &Lobster | `8450fcee-daf2-4a27-8448-2f0f0aed7be7` |
| 2 | 19th Street Italian Bistro | `56fcd815-ec5b-481a-9826-ad0ddf6aea1e` |
| 3 | 206 Burger Company | `21e694d9-b741-4f49-89c1-9e83551bebd2` |
| 4 | 212 New York Pizza | `28cedd4f-c50a-4291-976a-013ae35e678e` |
| 5 | 24/7 Tacos | `9ea8ea90-f40f-4383-9b9f-04768462652a` |
| 6 | 246 Thai | `332cd5c5-579c-4a20-b8a8-ea005accafd4` |
| 7 | 3 Dimensional Catering & Events | `dd426547-4a9f-4675-93ee-d2cca93c42d6` |
| 8 | 3 Ninjas Curbside and Catering | `1fcf2b6f-2c88-4dfa-82fc-c95fe42ad08c` |
| 9 | 360 Pizzeria | `af7a2f2d-fbbd-4da2-9728-85c53cd6bc5f` |
| 10 | 3Natives | `7470b16c-307f-43eb-bc38-76198b2318b0` |
| 11 | 3Natives Port St. Lucie | `28a1993b-2e02-4eaf-853f-81a3da6c4dee` |
| 12 | 400 Gradi | `c8a9a2cb-c3f6-4650-8958-b75f99d9e85d` |
| 13 | 414 Pizza & Pub | `9f8c7cfc-162d-4e5c-8b2a-368a494491a6` |
| 14 | 502 Baking Company | `502-baking-company` |
| 15 | 5280 Burger Bar | `f8e2c9e7-3b9e-4e63-bb66-47da00c9703f` |
| 16 | 5BB NY Pizza and Beer | `ef4bd64e-6cab-4a01-970a-704f719d8af5` |
| 17 | 7 Elephants | `6b826933-30c3-458f-a201-7a3fffc3dc8e` |
| 18 | 7Spice Halal Indian & Pakistani Kitchen | `9fc5fcaf-2059-47e3-b912-2b9cd63e81a0` |
| 19 | 9 Rabbits Bakery & Cafe | `c0340f5d-48de-4d66-ad5e-4b924b2c0343` |
| 20 | A La Carte Catering & Cakes | `7c8495c8-97e2-41dc-b682-f5a0e5f78bd5` |
| 21 | A salt n battered | `0fb302bd-b28e-464e-a54d-05300006f579` |
| 22 | A Spice of Life | `bafaab90-3e46-41da-b318-cfeafe1b8fdf` |
| 23 | A Table | `c2356ef4-e8b0-480c-a92d-816152fcbcf0` |
| 24 | A1 Pizza & Wings | `eee9b65e-9964-486d-a83c-c4335bd1b054` |
| 25 | A2Z Catering & Events | `714aadf2-ae6e-4240-b299-a3450072c378` |
| 26 | ABE Food | `f312e3de-1964-4be7-a68a-7eb9fe277234` |
| 27 | Aboca's | `2cc97826-cf2f-46f7-9a85-11205b240c5a` |
| 28 | Abu Omar Halal | `58b87bcc-c3b8-4bab-9afb-e1bdf8320a9d` |
| 29 | Abuelo's | `939c4e70-081a-426f-af1c-7ca75134f74f` |
| 30 | Abuelo's Chandler | `f5a69370-7b90-4ec8-931d-572dd74fecf7` |
| 31 | Acai Republic | `e236eca4-00c9-4266-b515-70d782386f9e` |
| 32 | Acai Republic Goodyear | `fdd14589-a7cd-4898-8653-10de3ac7dd31` |
| 33 | Acero | `e4907a59-1442-4f22-8112-d90447bdfb94` |
| 34 | Adalbertos Mexican Food | `7ff28486-9b2f-46f8-9000-aedd5cc46ab1` |
| 35 | Adamo's Pizza | `b05c7467-9213-43f0-a9ea-732f1598ecc6` |
| 36 | Adios Fajitas | `373ee0b1-b0b0-47b2-b4f8-13bdf29b5699` |
| 37 | Affordable Catering Dallas | `02c3df49-ed6a-4237-a310-39a661cd3111` |
| 38 | African Sister Restaurant | `40dd0464-d305-4bcc-8650-6f4271606c35` |
| 39 | Agave and Rye | `94f123e5-9174-4673-9721-52a497269e7c` |
| 40 | Ahipoki Bowl | `cb648e52-9a89-4044-9235-6aee3fb579a7` |
| 41 | Ahipoki Bowl Avondale | `582a1bd6-8dc3-425c-9b3f-832f4ef2e65f` |
| 42 | Aioli Gourmet Burgers and Catering | `3172fb4a-79f8-4903-9b85-f00a801a2ff2` |
| 43 | AJ Greek & Gyro | `71d6189e-bdae-4d76-9f52-edaf60a6d711` |
| 44 | AJ's Deli | `5039f3ea-72a0-4b64-8e7f-a3d6da960523` |
| 45 | AJ's Sandwiches & Burgers | `65ba95c1-885b-4792-821a-e8f7b4655f47` |
| 46 | Ajo Al's | `2f138c17-68fe-4cbf-8686-6ed5740f0ce8` |
| 47 | Al Shish Palace | `5bffdf8e-dab2-479c-b0e0-d2a5f202ddf7` |
| 48 | Al Volo Gastronomia Italiana | `80ed44ce-96c4-4d36-97a2-ca29f37b5179` |
| 49 | Al's Catering | `f33a9383-7016-448d-a226-78571c2ac693` |
| 50 | Al's New York Pizza | `13fdce47-f967-44f2-9571-720284b9bfe2` |
| 51 | Alcove Market | `53c1f811-acc2-4fd3-abbe-6c7f35a40f0e` |
| 52 | Ali Baba Grill | `57b7a56e-a9f8-4df5-828a-63afc137c2e7` |
| 53 | Alicia's Tamales Los Mayas | `de53620b-9383-45e8-bb5f-9479169a42c9` |
| 54 | Alidoro – Bryant Park | `3941ad4c-31cb-4130-b7a9-eca6ce9cdb2f` |
| 55 | All About Breakfasts | `5e2cb475-e50c-41a8-8652-33f46bc3cb04` |
| 56 | All Star Sandwich Bar | `ac4de99e-694a-4c96-a7fa-001c95a60ded` |
| 57 | Alliance Catering | `37da0a00-87e6-4c1d-9856-97b3a095168c` |
| 58 | Alma | `96e0918d-eab3-491b-b549-9313c3a26ea7` |
| 59 | Aloha Island Grill | `c5b1030e-4e29-4120-90cf-1fc6d62507eb` |
| 60 | Alonti Catering Kitchen | `60408a06-f8d0-4694-bd8e-e54bf56f2b7f` |
| 61 | Aloy Thai Cuisine | `1d8e2545-d840-47ec-879f-0b32e6b42e2a` |
| 62 | Alta Calidad | `12a4ac54-8fa3-41be-ae2a-09475c19b7b2` |
| 63 | Alzarrad Syrian Eatery | `8b0873d5-5d9e-4bfc-bca5-0cfb39385c79` |
| 64 | Amaravati Indian Restaurant | `5927cb89-fdee-4269-a3cc-9529b90802ad` |
| 65 | Amber India Restaurant | `4a9a4775-37b2-4b6d-9991-8ef1a23d9102` |
| 66 | America's Taco Shop | `db603d61-ec03-42e3-8a59-faad55b7f448` |
| 67 | American Grilled Cheese | `d8f3f154-eea5-45ed-99d8-b203673d630b` |
| 68 | Americano | `19e01989-a547-4c53-a579-59d2ef36d396` |
| 69 | Amia Bakery | `5705c24e-db4a-4329-8d6d-91902ba41954` |
| 70 | Amici Pizza | `aaa337ca-c8e5-4998-b95f-a9ec1f6af6c4` |
| 71 | Amir Grill | `ba228491-8b22-42a9-a7c3-9b220e6e6158` |
| 72 | Amor Y Queso | `bb61fb70-bdd5-4587-bcfa-62ea5809be83` |
| 73 | Amore Italian Bistro | `6fcf6c33-8429-4fa4-93e9-2ea58971ce5b` |
| 74 | Amore Pasta & Pizza The Colony | `b5d0ba5d-8220-4534-8f6e-671343bd08f5` |
| 75 | Amoretto Italian Restaurant | `2ada9e96-dda1-4d24-b768-cd37a0b32050` |
| 76 | Anant Cuisine of India | `e8730366-7386-4a36-82fb-ea10621a57b3` |
| 77 | Andalous Mediterranean Grill | `607cfc2e-2bf3-4831-8ce9-36f7b88547e0` |
| 78 | Andersen Bakery | `d0044ecb-36a9-45f1-acee-f617aff6377c` |
| 79 | Andiamo Italian Grill | `8790b221-2040-42bb-9308-e94360758606` |
| 80 | Andrew's BBQ | `04ec0eed-79fb-44f4-a35e-ac02c6f637fe` |
| 81 | Andy Boy's Pizza | `fe8b9feb-b008-4a25-a76b-489b24116026` |
| 82 | Anejo Kitchen and Cantina | `b017d64f-2da0-4ef2-ab35-fe811bcbe888` |
| 83 | Angel Chicken Kitchen | `97975f52-e09f-46c0-bda9-bfe985018365` |
| 84 | Anjappar Chettinad Restaurant | `bfb16430-3d32-48d4-b2b2-dabf4e8ee482` |
| 85 | Annie's Hot Donuts | `62aa93ba-b16e-4a1b-be36-956621011645` |
| 86 | Another Broken Egg Cafe | `51e5815f-3c92-4982-b169-cdcda0bb63f0` |
| 87 | Another Broken Egg Cafe Dallas | `24803dba-66cc-47dd-937d-656ebe260ec8` |
| 88 | Another Broken Egg Cafe Gilbert | `50c30f19-202e-4d20-bf88-a2cfc7baf222` |
| 89 | Another Broken Egg Cafe Huntsville | `471302fd-0e24-4730-b100-b8b0d52e4579` |
| 90 | Another Broken Egg Cafe Virginia Beach | `887d2557-5b4c-4d83-b40c-08ca87350bca` |
| 91 | Another Time & Place Grille | `d39028b1-c2ef-45ea-a713-b1d172da308c` |
| 92 | Anthony's Coal Fired Pizza & Wings | `87b0ade8-f0a1-4ff6-bd8c-547f394b8c4b` |
| 93 | Antonio's Restaurant | `411aa866-7921-4683-9c7c-f97b97519a03` |
| 94 | Anzio's Italian Restaurant | `8325fd75-13d9-4c0e-92c0-742e39fe50a3` |
| 95 | AP Personal Chef and Catering | `2f889cfc-5b6e-4772-a2c0-8a70f651b9b7` |
| 96 | Apollo's Flame Baked Pizza & Italian Grill | `9cb497dc-dd0c-4370-b1cd-5a8a30d01173` |
| 97 | Apollonia's Italian Kitchen | `21c2bcd8-644b-4868-90aa-7f7bb6516fb6` |
| 98 | Apple Fritter | `a8270e55-357a-4a54-b696-f790cbd4292e` |
| 99 | Apple Lane Farms | `47846a9d-b213-4115-acfa-fe5b56ed27bf` |
| 100 | Apple Spice Box Lunch Delivery & Catering Co | `d6e2a0cd-dae2-4fb4-964f-4d08f114e584` |
| 101 | Apple Spice Box Lunch Delivery & Catering Co Greensboro | `2a22f871-6d91-4835-b873-b712c7450a32` |
| 102 | Apple Spice Box Lunch Delivery & Catering Co Plano | `22a7fe0a-225e-4fac-936f-8da6186041ff` |
| 103 | Applebee's | `321f715e-c4a0-41d5-ac63-a451af549a92` |
| 104 | Applebee's Boise | `868d46f1-42d6-49f3-97fc-eef8c099478a` |
| 105 | Applebee's Broomfield | `ba26bdd6-4552-4bcb-9dea-663e49f08701` |
| 106 | Applebee's Chesapeake | `c8ed4d6f-5f96-4265-a81d-d0b0ae02007b` |
| 107 | Applebee's Fremont | `276f37b3-74df-4bbb-bcde-51eaffe61144` |
| 108 | Applebee's Glendale | `d0f58d6e-4a94-4a79-acaa-eeaf75d24721` |
| 109 | Applebee's Huntsville | `bc0af1b8-d243-41bb-8d34-2381fc6c3a21` |
| 110 | Applebee's Mechanicsville | `9330f099-25fc-44a9-a861-479989fde797` |
| 111 | Applebee's Norfolk | `40179c8d-cfdc-4a08-8c56-41e8f77382e0` |
| 112 | Applebee's Phoenix | `8fdd73e8-0cfa-490b-9ad8-edc66d613305` |
| 113 | Applebee's Port St. Lucie | `02606725-64ca-40de-ab3a-1501aa2d5a66` |
| 114 | Applebee's Portland | `48c1e315-7d08-4365-8cea-5fbe4396df0e` |
| 115 | Applebee's Redmond | `ceeed681-0b5a-4545-b99e-4b9b8a048801` |
| 116 | Applebee's Richardson | `19db3a3a-bb57-4149-b58f-7d2cbfb6d3d1` |
| 117 | Applebee's Spokane | `8eae708d-632f-4ece-816e-874129c79391` |
| 118 | Applebee's Winston-Salem | `6de9e379-69fb-4472-ae11-05f9cd485697` |
| 119 | Arcadia Family Restaurant and Pizzeria | `61279d61-2b01-4d8c-9130-91bf4a50fa2d` |
| 120 | Ardy's Grill | `20f4fe77-150b-49bc-b028-92edf943c5e3` |
| 121 | Ardy's Mediterranean Fusion | `2bfcedaa-31de-4d89-91ca-ea07599a1f91` |
| 122 | Arepas Caribbean Food | `63177e94-172e-43b9-86f7-5f459f2da9c8` |
| 123 | Arepas House | `3e307c2a-37d8-4b76-b813-3c2d7cf22c64` |
| 124 | Arepas Latin Cuisine | `6fb1ce27-56b8-48f7-8abd-8f7b44926c52` |
| 125 | Arguello Catering | `8cb7f873-bf00-4300-bbbb-9944004b3e10` |
| 126 | Ariana Cuisine | `0d11c19f-125f-4ba2-ac3a-38fecd8ba544` |
| 127 | Arianna's Italian Grill | `067c1bcb-b12f-485d-842f-3c6ce54fc203` |
| 128 | Arianna's Italian Grill & Pizza | `2e974b5b-971e-4375-8bd6-fb1c83798a58` |
| 129 | Arizona Corporate Catering | `47e5daac-b6a0-48a7-ac99-3e9dd5b3f09a` |
| 130 | Arizona Donut Co. | `5508ddee-6be1-4a32-a1cc-aa1c89cfd815` |
| 131 | Arizona Sandwich Co | `b04ca182-350e-41ea-83e6-9ba0ebb29624` |
| 132 | Asian Box | `e8af3673-2c91-496a-b8a4-e31cd869a80e` |
| 133 | Asian Grill | `4ace6a9d-476c-4ef3-b9fd-7b487c6c14eb` |
| 134 | Asian Mint | `053ede70-b834-4122-9afd-9a35c4a13bd0` |
| 135 | Assemble Coffee | `4eeb0d5a-adf6-4756-8cf1-f86c3e5f39c7` |
| 136 | Athena Grill | `adf77439-b3c9-4715-b57a-d8ea6302d9b7` |
| 137 | Athena Pita | `5dc443a4-a78c-4f08-9672-d692cc832960` |
| 138 | Atheneos Greek Village Cafe | `de16c311-4d7c-420a-84b0-07d9d42b23a2` |
| 139 | Atlantic Bagels | `7db91f45-fbf6-472f-a075-55943da930e6` |
| 140 | Atomic Wings | `b71da3a7-fbab-4f5e-b292-ae4bdb881bd0` |
| 141 | Attic Bar & Bistro | `cdc0c476-528b-44cf-b0fa-b075381a9104` |
| 142 | Aubergine Kitchen | `eb4ccdb9-5568-4548-a701-d09d1fb300fd` |
| 143 | Aunt Chilada's | `b0b601fd-c284-4859-9a5b-8608da778496` |
| 144 | Auntie Anne's Pretzels | `e500844d-f0a7-42d3-8072-98331b969ebb` |
| 145 | Auntie Anne's Pretzels Broomfield | `2d8b0d1d-3819-49f3-982b-755a55b41bd0` |
| 146 | Auntie Anne's Pretzels Chesapeake | `12d05043-a515-48d1-8df9-0b0173126c72` |
| 147 | Auntie Anne's Pretzels Garland | `c72810ea-74bd-4b8b-ab8a-fef5effc1e76` |
| 148 | Auntie Anne's Pretzels Glendale | `5075ba44-f059-4385-8a2f-1bfd99fa7d15` |
| 149 | Auntie Anne's Pretzels Hayward | `16becaf9-b748-45e3-be3c-0b3a14c1be37` |
| 150 | Auntie Anne's Pretzels Norfolk | `3b538584-d452-4056-b2e9-aa6989fe6307` |
| 151 | Auntie Anne's Pretzels North Charleston | `85a169a2-ff83-439e-9327-add7b55fa894` |
| 152 | Auntie Anne's Pretzels Richmond | `c9e130c5-e123-4ccb-9b14-afcaadd848dd` |
| 153 | Auntie Anne's Pretzels Scottsdale | `9661cabe-0011-4e63-9425-e0aa8aa3ff4b` |
| 154 | Auntie Anne's Pretzels Winston-Salem | `988eb844-f631-4ade-8d07-e50c1abbd5e4` |
| 155 | Auntie Ning's | `51d10761-4a40-45a6-97be-2ad059d5be0b` |
| 156 | Autumn Court Asian Restaurant | `842d061c-72c7-4c0d-a46f-3c7ef81a8533` |
| 157 | Ava J's Cupcakes | `7a2556f9-4d12-4bee-9c4d-35709ca53660` |
| 158 | Ava J's Cupcakes Phoenix | `c0b6ab9b-170a-4111-ac68-5857ea8f2adc` |
| 159 | Avocado Toast | `59cd7cb9-614f-4622-a983-24075f439956` |
| 160 | Awake (The Egg & I rebranded) | `77f9f759-7a1c-4f7c-aeb9-375a66c033f1` |
| 161 | Axcess Catering & Events | `ea114bec-47af-46b9-bb31-2ddd0d23eec2` |
| 162 | Ay Guey NYC Mexican Restaurant | `342c748e-3ec9-46a1-9013-21ffd16fc3a5` |
| 163 | Ay Mama Mexican Grill | `b0ab140d-70ac-4186-b30d-ea0ecf2279fd` |
| 164 | Ayam Zaman Cafe | `d7bcde34-988f-4013-bbc7-0c16452810b1` |
| 165 | Az Caterer | `b05f3cb0-0f27-4a41-be41-2ef5dfa6f2f9` |
| 166 | AZ Chimney Cakes | `c9469826-1dc2-4f6d-9cb3-b9bad0ed119b` |
| 167 | AZ Metro Cafe | `c632f17b-4a89-4486-9014-02e82189ed1b` |
| 168 | B&F Catering & Consulting  | `7f7c0fb6-4a75-4849-8f43-2590536eece1` |
| 169 | B.GOOD | `57eb5725-23da-4381-a40c-69622c7a446b` |
| 170 | Babbo Italian Eatery | `90b929f6-3bfc-4e54-8f6b-2846238be76c` |
| 171 | Baboush | `c90f675c-8d0d-4270-8909-8954a27bf3dc` |
| 172 | Baboushi | `f9c1e39a-65bb-41df-8c63-c80c1ea853a5` |
| 173 | Baby Brasa | `47935a56-8a67-4497-9122-b4d1c86688ce` |
| 174 | Baby's Buns & Buckets | `632389bc-f3bc-468b-89dc-e49e55008390` |
| 175 | Bacci's NY Pizza & Pasta | `2a250aab-34a9-4946-beb3-f1700f1c0059` |
| 176 | Backstreet Asia | `5f4f27e0-2e60-436d-ab7f-af2df809c8fa` |
| 177 | Backyard Brew and Kitchen | `b509cc8f-355c-47bd-a062-3d98dc1785f1` |
| 178 | Backyard Taco | `bf492c56-262d-4e44-bdb5-1956634e0c92` |
| 179 | Backyards | `c0a61e63-0050-4724-898a-93c646c2ebe3` |
| 180 | Bad Chicken | `293e6c7d-f2fd-4cca-8907-fc0c5055952b` |
| 181 | Bad Mutha Clucka | `e94f7055-cbfb-4c9e-84f2-68e7329cdbfb` |
| 182 | Bad Mutha Clucka Richardson | `070270cd-9a8d-42eb-a7f9-35bd60cab5a4` |
| 183 | Bad Mutha Clucka Tempe | `8d57e5d9-c3a6-4b86-be52-c0cca692c8d4` |
| 184 | Bad-Ass Breakfast Burritos | `dbc08221-b9f1-409f-b13c-dc3d120f6e42` |
| 185 | Bad-Ass Breakfast Burritos Phoenix | `ec38d210-4342-4a22-b625-1d25d3d4be9f` |
| 186 | Bagel Brothers of New York | `55dec700-bd39-4331-bb5a-087595d38fcd` |
| 187 | Bagel Fresh Deli | `aa65ede7-f940-48f4-99a3-fcfb5ae735ab` |
| 188 | Bagelfeld's | `99b07187-f61d-45fd-8340-f335bbd13f93` |
| 189 | Bagels by Kiss | `9a3f106b-a7e5-4e54-ad3a-dae9d702c6af` |
| 190 | Baggin's Gourmet Sandwiches | `0951592a-262f-4cf1-9bad-8d33285c544e` |
| 191 | Baja Coffee Co. | `4a3c217f-d764-4994-b255-de16de419953` |
| 192 | Baja Fresh Mexican Grill | `9fe11d0a-1c3b-486a-ab8a-c9e9c4cd007e` |
| 193 | Baja Fresh Mexican Grill Chandler | `17d86bd7-2e25-41a2-87c7-55cd923e17ec` |
| 194 | Bajis Cafe | `df8e17cb-0db7-45d5-b802-52ab4ee86807` |
| 195 | Baker's Crust | `5af38ce2-fe37-42a1-969b-68dc20ef4e10` |
| 196 | Baker's Crust Bagel | `c5092454-38e7-4932-842b-28d7401f6e33` |
| 197 | Baker's Crust Chesapeake | `e9e95375-8e98-4e5b-84d2-d3073d828564` |
| 198 | Baker's Crust Norfolk | `a3e15bed-3474-4a6b-9c1a-c7997e988d1a` |
| 199 | Balade Your Way | `13de50f3-963b-496a-b8f9-bfdf3133c579` |
| 200 | Baladi Mediterranean Cafe | `8aa41c9b-8566-438f-97ee-fecd6a1faacf` |
| 201 | Balance Grille | `32c23364-6f3a-4745-9d8c-82f241424d32` |
| 202 | Ball Park Pizza | `f22389d7-23d5-4eb3-bdd5-37b402ce8639` |
| 203 | Banana Leaf Thai Cuisine | `44ff79cc-d404-4146-9561-bf64d1be5ef9` |
| 204 | Banana Leaves | `1096aba6-6589-4bcb-bb2d-fe3467b96837` |
| 205 | Bangin' Vegan Eats | `79061163-2950-4cc5-8ab8-7ad2ab0f0d21` |
| 206 | Bangkok at Beltline | `77281ca0-e596-492b-9af6-b864ce428653` |
| 207 | Bangkok Bay Thai Cuisine | `d2ea61e5-28bf-48f4-93ac-e262d0d4b6b8` |
| 208 | Bangkok Grill | `66b866b4-1abd-4f33-a586-533415f1b414` |
| 209 | Banh Mi by Rice and Spoon | `d6f9d9ca-21db-4b1e-b3f3-a4d5576691a2` |
| 210 | Banh Mi Station | `9bfd5d5f-5825-4747-a45c-81d13ee9e7a8` |
| 211 | Bankhead Brewing | `15069f7e-89a0-493c-8221-b74d942d94c2` |
| 212 | Bao Redwood City | `77a5fa11-319b-42a3-b558-aa8470c4861d` |
| 213 | Baps Private Catering | `af027a87-feb5-4c8d-b949-797f385f623c` |
| 214 | Bar Louie | `45e4bb81-9bf9-4e2a-b9f3-661a6ff43d8e` |
| 215 | Bar Louie Glendale | `6ce4de6a-9560-4f0b-a622-b09d3b25f957` |
| 216 | Bar Louie Tempe | `2a8321f2-fc8d-4959-b693-075c0d33da2d` |
| 217 | Bar West | `f5940636-5694-4614-bfcb-acd83595a986` |
| 218 | Barberitos | `48586f66-225e-4357-8232-da24fe437e7e` |
| 219 | Barberitos Winston-Salem | `0d8345de-eda5-4efb-a45f-4470d9a050f5` |
| 220 | BARE Blends | `740b7639-be6c-4f5e-82a6-a8b6af3f6165` |
| 221 | Barrel & Bones | `d95aeb49-1354-4585-89fe-0e9b87569a9d` |
| 222 | Barrio Queen | `197e3e23-549e-4fc9-a65d-422fb31edb33` |
| 223 | Barrio Queen Glendale | `e080af1f-2d6b-41be-ab87-576856463736` |
| 224 | bartaco | `77dced34-7f4a-4b5f-90ab-7121970f5464` |
| 225 | bartaco Charleston | `b8e9b5e1-bd32-4d04-90c4-48d40ba800bb` |
| 226 | Basera Indian Cuisine | `d79e75ff-6ece-4edd-b161-561947b5bd03` |
| 227 | Basically Halal | `17191332-61c1-4bc4-855c-1d8f701656c4` |
| 228 | Baskin Robbins | `8f91a20d-7085-49df-98bb-e70726b82948` |
| 229 | Baskin Robbins Goodyear | `a23ff287-0f26-40cf-ba38-6764acaaf1a4` |
| 230 | Batch Bakery | `336b717b-17ae-4620-944f-534c60fd09f1` |
| 231 | Batter 'N Icing | `15d7a221-a1dc-411c-a1eb-e0145659daae` |
| 232 | Bawarchi Biryani's Indian Cuisine | `c3f7338c-3cce-4a9f-8679-ace81d99c61c` |
| 233 | bb.q Chicken | `99dfeefd-fe89-4dc6-b9f8-c0fcfd56248a` |
| 234 | BBQ Lover Korean Steak | `ae136e7a-cc85-463b-a025-17ce089e829b` |
| 235 | Beach Hut Deli | `007ace0f-54fb-4ee7-9698-286dc85cae0b` |
| 236 | Beanchain Coffee | `b45b2e4b-060b-48f7-a6e9-b66fff073c2c` |
| 237 | Bear Bitez | `694c70b7-c48e-4a4b-ae9f-ae46ec15effa` |
| 238 | Beard Papa's | `bb3562c3-2884-47cf-a8d7-ad2c7b824b5b` |
| 239 | Beard Papa's Scottsdale | `5530d5ba-22e2-46ea-b987-0c9b01915f72` |
| 240 | Beard Papa's Spokane | `9b0112fb-0cc0-4d01-b391-77e84ec64df8` |
| 241 | Beech | `dc454054-f134-459e-8986-2303026cc31f` |
| 242 | Beignets & Brew | `73e1c263-772e-4653-9462-48ebea21a223` |
| 243 | Bella Bella Mozzarella | `2a5b309f-212d-488f-8484-18d9114cdd90` |
| 244 | Bella Luna | `6abb8edc-98a2-4a09-bfad-24b500e1f48a` |
| 245 | Bella Pizza & Pasta | `066e5946-5706-4b50-9520-eddf2ab90eab` |
| 246 | Bellagreen | `04fae092-c8ab-4d08-b4b9-8085304c7610` |
| 247 | Bellatrino Neopolitan Pizzeria and Cucina | `cb1345cf-861f-4bee-a70d-7d54826bc7a7` |
| 248 | Bellota | `6e8a6b9a-2935-4761-82d6-770ec6a108a7` |
| 249 | Ben & Jerry's | `b792c3c4-655f-4afb-be1a-b7412cea87aa` |
| 250 | Ben & Jerry's Bend | `63d50d1d-e5b8-43c9-9fa6-5f36f18d8345` |
| 251 | Ben Bros Market | `c7d9edfb-6801-4f47-b7db-f4117166afac` |
| 252 | Ben's Fast Food | `af9b9bf8-2657-4e0c-9f7a-6788e8a5a4bd` |
| 253 | Ben's Pretzels | `67e6d28f-f754-4db7-9574-c2f4b6d4b735` |
| 254 | Bend Pizza Kitchen | `1e07aaca-fde9-4da4-8081-4f9d349f6c4a` |
| 255 | Benihana | `23ddbc88-b4e2-47b3-a77c-5974bc4fe2bd` |
| 256 | Benihana Dallas | `d7e08267-4841-409a-ba52-38d240e7aaff` |
| 257 | Benihana Scottsdale | `3a3e7d0d-467c-4ef0-be81-8cc8ba7d4757` |
| 258 | Benihana Sewall's Point | `56e5d429-ce06-4b95-820d-6f8742835328` |
| 259 | Benny Ravello’s | `f3bad586-eecd-4dab-8ade-3a0db0cb8324` |
| 260 | Benny Rinaldi’s | `9ccce1a3-4328-4271-8c84-fc766b8e5cb2` |
| 261 | Benny's Bagels Lakewood | `1a08d90a-05b5-4eb4-8c6e-87a2aedbef46` |
| 262 | BentoSprout | `60aae105-680b-4870-9adf-7a842d4d06c4` |
| 263 | Berries & Kream Sensational Cakes | `04714662-dd35-40ee-8d52-124cf4768b8e` |
| 264 | Bertha's Cafe | `ff8b4007-b20a-46f2-bcb3-2f276ca9ca6f` |
| 265 | Beyond The Box | `c8a88c2a-9314-4aff-8150-f893c96fe1d4` |
| 266 | Bibimbowl | `8e1f8f9d-865b-48c5-bf6e-efb5fb15bfc0` |
| 267 | BIBIO Modern Korean Kitchen | `844876f9-cd10-4ba6-8d32-40217eab8c20` |
| 268 | Bier Garden | `797f4a9a-1dbd-4269-9a16-e07d23aaeb70` |
| 269 | Big Al's Smoke House Barbecue | `8a3ded6a-b337-47f2-b223-bffe6a3953a6` |
| 270 | Big Apple Pizza | `b73e7d54-aeaa-4dc8-8b85-6af5454c86cd` |
| 271 | Big Apple Pizza & Pasta | `3d1b8f6d-e538-46db-8d0a-096612d04b72` |
| 272 | Big Bad Breakfast | `13b1c2b2-eff4-4c7a-afb3-181ee78a72e8` |
| 273 | Big Bad Breakfast Madison | `9daecde1-d30b-4251-8464-a74230df5518` |
| 274 | Big Bites Eatery | `d6ac44ec-ca9b-449a-84b0-f8620986cf87` |
| 275 | Big Box Catering | `a3b82df8-473f-4c43-8819-9a9ff97b726a` |
| 276 | Big Burger Spot | `f837a89e-7b2a-433d-8e2b-cc4aa9f67521` |
| 277 | Big Chicken | `777a215c-31f5-4ee9-bf83-46ecb9497d8a` |
| 278 | Big City Bagels | `2802ab09-6e9d-4128-8beb-42c1c4bbd646` |
| 279 | Big Daddy Bagels | `ae6c55d1-01e7-4a13-a2d2-4feba5ec0d47` |
| 280 | Big Daddy's BBQ | `26f1bf46-99c7-48d7-b56b-772a411e9a61` |
| 281 | Big Daddy's Hawaiian BBQ | `5849da83-ad67-4abd-8707-2a381b7bf640` |
| 282 | Big Deal Burger | `e0b44156-9713-43d4-b6dd-afcb516445e0` |
| 283 | Big Fat Breakfast Burrito | `7cdcc1ad-c33a-41cb-b947-ce9b5faad540` |
| 284 | Big Guy's Chicken & Rice | `846ad362-a67a-472c-b3ca-eef9208a56fb` |
| 285 | Big Nate's Family BBQ | `f24aa9d2-dc08-4e56-aad1-b19c23f49d04` |
| 286 | Big Papa Gyro | `b9cd1e33-b194-45d9-8eed-1d11d6646af0` |
| 287 | Biggby Coffee | `2b138f13-977e-49dd-8b67-50e230994329` |
| 288 | BigWife’s Mac n Cheese | `6e2bc3a3-817c-4ce2-bc52-e4433d670582` |
| 289 | Bill of Fare | `da0d44e7-5ecc-4ae8-ba28-cf3855d0c182` |
| 290 | Bill's Cafe | `22d59fa8-af77-4d53-8202-85abfca415df` |
| 291 | Binge Biryani - Forest Hills | `60f2a33a-1d51-4aac-9719-e6a2cb3ae924` |
| 292 | Birdcall | `cb8f1e77-1e05-486e-ac2f-b466494d0a73` |
| 293 | Birdcall Phoenix | `bee70c0f-86a8-40ce-8704-d098c2066dda` |
| 294 | Birdcall Richardson | `64d6d1d1-145f-4250-b784-2967c18a3034` |
| 295 | Birdcall Scottsdale | `a0b69d36-ed6d-4332-87af-fff66b268180` |
| 296 | Biryani and Bites | `aa10c23a-0c59-4261-b2e2-97f1aca4b30e` |
| 297 | Biryani Hub | `e3645e09-8f7e-4dfd-8dfd-975cdbf14c79` |
| 298 | Biryani Pot | `564f1d2c-eaa6-401f-bc61-362be7401680` |
| 299 | Biryani Xpress | `c1480c76-4424-42c0-adf4-e8b0452f49f0` |
| 300 | Bisbee Breakfast Club | `60c89de0-833c-4a3d-804b-4c5c4ce223ee` |
| 301 | Biscuit Belly Breakfast | `1fb751bd-f46a-4649-b212-a6e4ce27e03c` |
| 302 | Biscuit Belly Breakfast Chesapeake | `9eddf3bd-b106-4177-b91c-003a12684be7` |
| 303 | Biscuit Belly Breakfast Norfolk | `71c051e8-7d40-4259-ad45-203ddb6a665f` |
| 304 | Bismillah Restaurant | `d8b0aaf0-34da-4d16-ae3c-7c1c613de08d` |
| 305 | Bistro & Beignets | `180e7d58-2785-4187-b21a-43c61659f2c4` |
| 306 | Bistro Siam | `ea2311b6-44a9-497d-97b5-20564c9d4a2b` |
| 307 | Bite Bistro | `de48148c-b51a-454c-84ca-bb884c3829d9` |
| 308 | Bite by Bite & Co | `cb714b78-035f-49ca-9152-4002521c91dc` |
| 309 | Bizza | `1503fc25-c682-43ea-9b79-4e3a87106e9e` |
| 310 | BJ's Restaurant & Brewhouse | `0ff5f258-0cbe-4611-ac33-ea3c8ccadc9a` |
| 311 | BJ's Restaurant & Brewhouse Chandler | `3fada1eb-ee86-40ab-97af-fe00861cc51c` |
| 312 | BJ's Restaurant & Brewhouse Henrico | `15e17327-668d-4e33-86b8-6d7b5bdad935` |
| 313 | BJ's Restaurant & Brewhouse Huntsville | `e3541c41-9020-48b4-a93a-b71975393596` |
| 314 | BJ's Restaurant & Brewhouse Mesquite | `22fe65a5-d8db-44f6-8b30-5b88c51dd6a7` |
| 315 | BJ's Restaurant & Brewhouse Newark | `2eb8bf26-4a98-48b2-8b99-6c8c77ccdcbf` |
| 316 | BJ's Restaurant & Brewhouse Peoria | `81683df9-d40e-4941-bd1d-acaa44b2d2c5` |
| 317 | BJ's Restaurant & Brewhouse Winston-Salem | `68ad94b4-f79c-4e53-a2ec-0402ce694a8d` |
| 318 | Black Bear Diner | `e8be0d0e-164c-4b52-b375-2214e644d2dc` |
| 319 | Black Bear Diner Boise | `129bd7d9-7edd-4fd8-a40c-24de5287ec93` |
| 320 | Black Bear Diner Fremont | `8a37c78e-8d42-45ce-942b-9988b0b9543c` |
| 321 | Black Bear Diner Glendale | `79ba585b-168f-4530-ab06-411717d5f904` |
| 322 | Black Bear Diner Mesquite | `f1dd0bde-6e42-4a41-9409-cc5b88215066` |
| 323 | Black Bear Diner Scottsdale | `0429ffaa-1d1b-4e07-83d9-6142a31de8d4` |
| 324 | Black Eyed Peas | `5af95960-b4b3-4144-b750-4dfb6592d424` |
| 325 | Black Market Barbecue | `8934b38e-b152-47dd-8031-4bea6becaf51` |
| 326 | Black Seed Bagels | `e270148b-0f5b-4714-ab87-70b4adcd7d3f` |
| 327 | Black Tap Craft Burgers & Beer | `747ee19a-bfab-4ca9-ab72-1e55134124be` |
| 328 | Blackeyed Peas | `93b9713d-d3c8-4623-b444-107b783ff0b8` |
| 329 | Blackjack Pizza | `2e7ab65a-a00b-41f2-ae52-cd308ea2b397` |
| 330 | Blanco Cocina + Cantina | `4fe3e60e-c87f-4c02-b7d4-410dec51f08b` |
| 331 | Blanco Cocina + Cantina Peoria | `0eb63d0f-3869-4c67-bbbf-14014529ab53` |
| 332 | Blasteran | `4cdf589f-7a42-46d8-b63d-9bd72a39ec1f` |
| 333 | Blasteran | `b6f57a13-3efb-46b2-9cf6-9ccf332c36ac` |
| 334 | Blaze Pizza | `0720cf6d-6233-431f-bba4-4892ffdc907e` |
| 335 | Blaze Pizza Boise | `0121bacc-4c1c-4c73-937f-ed902da6eb72` |
| 336 | Blaze Pizza Greensboro | `eeb72fcd-2743-4307-a07b-0d7e5c460497` |
| 337 | Blaze Pizza Midlothian | `0711ad61-f5e3-47b7-962e-b2537571a04d` |
| 338 | Blaze Pizza Port St. Lucie | `c3aaa0a1-3cd7-4e86-aca6-7d2c5fbc4bd6` |
| 339 | Blaze Pizza Rowlett | `4867c8cd-f693-4f88-bbfa-97cee2549760` |
| 340 | Bleu Restaurant and Bar | `8c3f5ab8-f9a7-4cda-bc5f-e0badffc275c` |
| 341 | Blimpie | `40e8f30c-8c47-43ca-a5ba-160d35889cc0` |
| 342 | Blimpie Boise | `b010b91e-f70d-40fa-b6f6-e1b0e3f677f5` |
| 343 | Blimpie Phoenix | `247ba405-3a0f-44a7-b83c-fa23dbf15c2e` |
| 344 | Blimpie Scottsdale | `47e4f0c0-bea9-4c69-a15b-f1f1ff069e6a` |
| 345 | Blofish Sushi | `57df1397-a299-46e1-8def-b3614bb70635` |
| 346 | Blossom Kitchen | `3a6c45d4-cdae-4524-a8ab-7f4b0916eb9d` |
| 347 | Blu Burger Grille | `9f128131-61a6-4e43-b3d3-174b6c87a626` |
| 348 | Blu's Barbeque & BBQ Catering | `49ce1087-0fbf-4771-8698-92a4b607a94d` |
| 349 | Bludso's BBQ - La Brea | `c67ed017-3177-46db-a725-b37ce9313bfc` |
| 350 | Blue Agave Mexican Cantina | `64630af7-54f4-4cea-aca4-0021011591a6` |
| 351 | Blue Line Pizza | `e11b24ef-81d0-4012-aefb-586f44ac62fb` |
| 352 | Blue Mango | `0394a9db-e23d-44a4-ba19-5eaecf3c9572` |
| 353 | Blue Mesa Grill | `be0f2d72-aa69-4b2b-a9e6-91d8d726d67f` |
| 354 | Blue Moon Catering Marketplace | `d100be4d-1c05-4e04-b71a-8d704655d00e` |
| 355 | Blue Nile Mediterranean Catering | `0627d30e-52b6-4404-8157-153a87f4c5ea` |
| 356 | Blue Oak BBQ | `d83c90a8-6d34-4f0d-b8aa-23aee7c6a24d` |
| 357 | Blue Ribbon BBQ | `831bff41-22e0-41c6-a8c1-66d5a649c281` |
| 358 | Blue's Local Grill | `65db614c-7616-4379-be20-3fb66cd96a0e` |
| 359 | Bluestone Lane | `6723caeb-8cdb-4303-9fbb-7f6614bc78bf` |
| 360 | Board & Brew | `b43f3b58-042d-4761-b746-2a9a71235e36` |
| 361 | Board Bites | `deebb455-c687-47b0-8c6c-93b2a15412a2` |
| 362 | Bob Evans Restaurant | `d47b3dd8-b0f9-4464-85f9-9ac163f5e7f2` |
| 363 | Bobby Q's | `cfa4154d-67ac-4ae8-9ec8-e22968bb948f` |
| 364 | Bobby U’s BBQ Pop Up | `6a190f80-8f9a-4315-94a0-830de982b992` |
| 365 | Bobby's Cafe & Catering | `cce83cd9-c0ca-463d-b5a6-dd9468d4e084` |
| 366 | Bober Tea and Mochi Donut | `dbbef451-670e-40b7-bbbd-a5a17eb8ba7c` |
| 367 | Boca Taqueria | `f15c232c-a58f-4531-b159-dda25819405f` |
| 368 | Bocado | `435f2398-7078-4ef5-a8ef-e05f249e660d` |
| 369 | Boil Bay | `3f04813e-c439-4a80-aa58-e17b1f5f0a0d` |
| 370 | Boil Bay Virginia Beach | `0f2e0620-d476-40ec-a727-080064dcfaf0` |
| 371 | Boise Pie Co | `6be21cd0-44ee-4792-8021-08cbb534bbff` |
| 372 | Boise Pie Company | `e81b59fb-7030-4a63-97e2-9ff7d725b878` |
| 373 | Bojangles | `cb88fb43-83a4-4a11-94a5-d6518a6a3f62` |
| 374 | Bojangles Huntsville | `fb558a5f-ae7a-4ec1-970b-1c9aabde0676` |
| 375 | Bojangles Norfolk | `9b2bfdb5-d1d4-44aa-9463-689c538b2422` |
| 376 | Bojangles Richmond | `2e6cc992-cbf7-40f5-9030-79a4fdda7801` |
| 377 | Bojangles Winston-Salem | `d80b2778-a5c1-4060-a351-548801630912` |
| 378 | Bojangles Wylie | `b38c86af-afa8-4147-a7c2-421acb002f9c` |
| 379 | Bold BBQ Pit | `d70ff6b3-353d-4b6b-b96e-48b919a60ce6` |
| 380 | Boltiful Fresh Kitchen | `15a8cc2d-8fbf-4aef-ac76-895a12d0373f` |
| 381 | Bombay Bazar & Indian Restaurant | `3751dbb4-a564-4f4d-8fd9-07f132b6708b` |
| 382 | Bombay Pizza House | `d102857e-b9bd-41c3-b4e1-428fafed3166` |
| 383 | Bon Banh Mi Catering | `b91fa10c-b4f9-4e11-ad3c-5480537871da` |
| 384 | Bonchon | `79fd188d-e592-4203-8159-1189f31a55e3` |
| 385 | Bonchon Newark | `8c9ed90e-8c0f-4d5b-9f11-7c572a2be060` |
| 386 | Bonchon Norfolk | `57331184-7bf6-46ff-8abf-1928c2323ef0` |
| 387 | Bonchon Richardson | `3ad90232-a2f9-40a0-8a45-398235088064` |
| 388 | Bonchon Richmond | `958d044b-6ca0-4eb4-8a29-df2ddc5e7222` |
| 389 | Bonefish Grill | `f28b06e4-9be5-4b0c-bb37-dca050ee9325` |
| 390 | Bonefish Grill Allen | `03a02fe9-db9c-4f96-b2cf-f1203bf1796c` |
| 391 | Bonefish Grill Glen Allen | `fe696f97-3ffd-46e3-a60b-d739ad99dbd4` |
| 392 | Bonefish Grill Huntsville | `2137317b-c195-476c-aaac-371d483acda9` |
| 393 | Bonefish Grill North Charleston | `67663a3c-b2e2-47ed-a1f5-cbc739a19e9e` |
| 394 | Bonefish Grill Spokane | `5984607d-704b-4205-912a-e3dc7d412404` |
| 395 | Bonefish Grill Stuart | `3801e777-d4c9-4e60-99ba-70885502ebbe` |
| 396 | Bonefish Grill Virginia Beach | `9ca9116d-b7d6-461d-870a-f8c67c4a982c` |
| 397 | Bonfire Craft Kitchen and Tap House | `32f068e0-7fd0-4b52-be18-ae9e6141b036` |
| 398 | Bonjour Bakehouse | `c3080852-fc3c-44b1-804c-025b0ab908bc` |
| 399 | Borracho | `5db81a35-a9cd-4eaf-84b2-6f66189d39af` |
| 400 | Bossy Beulah's | `0151a8bb-ba1a-4087-8d2d-c33a0dd3e903` |
| 401 | Boston's Restaurant & Sports Bar | `c29c75a4-968b-4b38-acf4-0f8019f42e52` |
| 402 | Boston's Restaurant & Sports Bar Irving | `62390052-8c56-4054-9083-05fc39ce80dc` |
| 403 | Bottle and Bean Coffee House and Wine Shop | `1632500f-bf24-442b-ae7b-6ba92d2f2351` |
| 404 | Boudin Bakery | `d879a4ed-6404-47d1-b3c0-cd883f5b48e2` |
| 405 | Boulder Baked | `9da87a9a-1326-405f-8a51-59de059ceb94` |
| 406 | Boulevard Catering | `0982817b-f0bd-4b98-b65e-a5b92ce7df78` |
| 407 | Bowl Market by Smokey Bones | `7ccdacb3-0392-4912-992e-991a16e0ad0e` |
| 408 | Bowl Market by Smokey Bones Chesapeake | `d394d435-5e47-492a-8ced-c38460295e2c` |
| 409 | Bowl of Greens | `a6dfa3f5-b683-44e1-81a6-77162668688b` |
| 410 | Bowl of Greens Healthy Kitchen | `203c559f-02a7-485b-8f87-b50438c9c49b` |
| 411 | Bowlrito | `a17a190d-cc7e-4b77-9adf-7368df190d78` |
| 412 | Boxcar Betty's | `02ab12a9-227e-48a0-95e3-c98904eb6304` |
| 413 | Boychiks Deli | `7beea825-dc21-4095-9f6e-8a485727d8cb` |
| 414 | Bravo Italian Kitchen | `f7cef448-df2e-49ae-893b-2c80b375f3c7` |
| 415 | Bravo Italian Kitchen Virginia Beach | `a69dc5d4-45d7-4e8b-8dae-8907343db972` |
| 416 | Bread Zeppelin | `76c57f4f-682c-4cff-9f67-9701abcd2481` |
| 417 | Breakfast Brothers | `d484d439-14d1-4f24-a3e0-5982b8acb578` |
| 418 | Breakfast Kitchen Bar | `bca9f14b-e9eb-4c22-b7d5-34e3e18478e0` |
| 419 | Brekkie SPot | `811f1a64-31b8-4818-b596-ae1fdb7a7d09` |
| 420 | Brewer's Cafe | `b8e19470-45ff-4754-938a-72c5ba4e63e7` |
| 421 | Brickyard Hollow | `a1973d48-291d-4b56-9c51-d256c894430d` |
| 422 | Brio Italian Grille | `4fdfa8aa-5df2-4ed7-bc29-d6b0e3e8a5ac` |
| 423 | Brio Italian Grille Gilbert | `c95cbbb8-40ef-4dd6-b4af-864bfb6f885c` |
| 424 | Brixx Wood Fired Pizza + Craft Bar | `88febf81-189f-41f4-bec6-cc85dc43a94f` |
| 425 | Broadway Masala | `2883ff86-ca01-4ed6-96db-7536e62fcb77` |
| 426 | Broadway Pizza | `5dad18fe-7373-4c41-9668-9d1a0428cc32` |
| 427 | Broasted Brothers - Livonia | `59b9e7e1-f3b5-413d-975c-9baa91230714` |
| 428 | Brooklyn breakfast shop | `798315cf-81b2-40ce-b1f4-59cbf93f4cc8` |
| 429 | Brooklyn Dumpling Shop - Dallas | `0ad7bb78-3f21-4ff2-8f01-fb19efc7f07b` |
| 430 | Brooklyn Dumpling Shop - Downtown Miami | `17e17754-f2df-4769-a1b5-01ba30909a74` |
| 431 | Brooklyn Dumpling Shop - Garden City | `59429cc2-a9ed-41a3-9edf-3de4a54ee430` |
| 432 | Brooklyn Dumpling Shop - Sansom Street | `44d39bee-f61c-45be-81d9-1d28c948cb76` |
| 433 | Brooklyn Dumpling Shop - South Street | `c2084846-36ef-48f5-9381-d5052c7b41b8` |
| 434 | Brooklyn Dumpling Shop - Uni City | `aa71ed79-977c-4ab3-84d9-859f960ece43` |
| 435 | Brooklyn Dumpling Shop - Willowbrook | `463188f2-42b3-498b-a0dd-c0030032143d` |
| 436 | Brooklyn NY Pizza | `ed393b35-8cc6-47e9-b565-646f468dbbab` |
| 437 | Brooklyn V's Pizza | `c49f632f-30af-436c-8f07-7b3c08850bb4` |
| 438 | Brooklyn Water Bagel | `9f09ed5b-1278-4a3e-bb97-093a4d25873e` |
| 439 | Brother's BBQ | `e35e3552-af1c-460e-a930-f0d292b7b065` |
| 440 | Bruchi's | `4cda23e5-43f5-46ea-9d82-a916da22823f` |
| 441 | Bruegger's Bagels | `c140d08b-5737-4aa9-b45c-b11f23740c39` |
| 442 | Brunch & Sip | `e0fc0ad8-6317-46fa-9488-36fcf5ae2138` |
| 443 | Bruncheon Las Colinas | `ba8d9184-2ada-4ef7-a8f2-039dab41d795` |
| 444 | Brunetti Express 301 | `27b47d27-53c8-4813-a12b-0bfbc6cfb109` |
| 445 | Brushfire Tacos Y Tapas | `aa0e4c7f-fb90-41fe-abe1-52caf7dc746d` |
| 446 | Bubbakoo's Burritos | `0fe34cb8-c8e9-4684-ac4c-12973d6c9e28` |
| 447 | Buca di Beppo | `cd5606bf-de98-408c-9356-b03ecee887f1` |
| 448 | Buca di Beppo Dallas | `e788626a-06d7-440d-a0c9-a637662eab1f` |
| 449 | Buca di Beppo Mesa | `aec39850-9920-4ffe-9d7e-47a3a7cb764f` |
| 450 | Buca di Beppo Palo Alto | `88097019-fc24-4a7d-a4ff-8b80a1fcf91d` |
| 451 | Buca di Beppo Peoria | `d983279c-ecda-48e1-beaa-d2d1a5dd49a6` |
| 452 | Buffalo Wild Wings | `ad244d49-30d6-422f-b279-0b0750eeab8b` |
| 453 | Buffalo Wild Wings Gilbert | `184f0f36-fd2f-48a6-8336-c63dba31eac8` |
| 454 | Buffalo Wild Wings GO | `19447fd1-1a04-4d12-8e44-b73b2e4b94ce` |
| 455 | Buffalo Wild Wings Huntsville | `c02363ed-cea1-41f3-8cbe-4fa27416c7d1` |
| 456 | Buffalo Wild Wings North Charleston | `0ff8e63e-6b02-491d-a74f-1b953b7c1a0a` |
| 457 | Build-A-Pita Mediterranean Restaurant | `abc6acaa-0bbb-438e-82cf-95369e212697` |
| 458 | Bulla Gastrobar | `fca9a801-1278-4061-a473-b226d67e7fe6` |
| 459 | Bun Me Up | `5549bb68-d6b9-4d11-89bc-14c39326fac7` |
| 460 | BunBao | `9b94d36b-b3c1-44a2-9faa-f31370fcaf95` |
| 461 | Bund Wok | `3a1196b1-27d9-4b9b-a9de-d56c4386d5c4` |
| 462 | Bundoo Khan | `8e435fc9-a699-483e-bde6-dbbe21c6e0f5` |
| 463 | Bunny Chow - South African Food - Miramar Shebeen | `84fd2401-8f00-41e6-afe5-01080a830c65` |
| 464 | Bunny Chow - South African Food - North Park Shebeen | `0112c53e-1b89-4a39-91f5-9e6080d26d9d` |
| 465 | BUONGUSTO PIZZA RESTAURENT & CATERING | `c72d9ac5-1a0b-4146-b57b-5d7e075e50c5` |
| 466 | Buono's Pizza | `e7abe247-210e-4714-acda-2f03f1283daf` |
| 467 | Burger Hut | `62fd4e88-4fd3-4685-ad22-965710ec8e45` |
| 468 | Burger King | `8e4da03b-bdce-4621-83b2-fc09e0521b3a` |
| 469 | Burger Rush | `df7ec33c-098f-4c01-87d8-ff6e9a070a09` |
| 470 | Burger Street | `e31b29fd-cbd5-4f9c-a974-fcace1bd95d0` |
| 471 | BurgerFi - Altamonte Springs | `379cd922-5d36-4d22-b808-b1dfd4574105` |
| 472 | BurgerFi - Lake Mary | `77cea8e4-cb1a-4003-98c2-8bdba85e9eec` |
| 473 | BurgerFi - UCF | `abb4a9e4-2ad5-41cb-a675-3f6d35f972e1` |
| 474 | BurgerFi - Windermere | `f2f87bed-0272-4d19-933f-3e84cf15830f` |
| 475 | BurgerFi - Winter Garden | `f41734ab-f162-45cb-b21b-16e46ce3c2ff` |
| 476 | BurgerFi - Winter Park | `3ef5a496-02bc-49dd-8ced-842b5e07c306` |
| 477 | Burgerpop | `55434c3b-70da-4ed4-a8f7-42bbacf5f92f` |
| 478 | BurgerSear | `eb9bbd0a-c804-4524-a1a1-33a9e86d69a4` |
| 479 | Burma Bay | `51e98a95-b442-4f84-b5dc-e7d4f2c9b1bc` |
| 480 | Burma Burma | `cb965105-a193-4301-9506-17fc8f32fa97` |
| 481 | Burma Classic | `831a265d-f619-4e19-8d67-6b658bbfe331` |
| 482 | Burma Love | `ecf203b7-66a2-4dae-b11c-91b42fccb1c8` |
| 483 | Burma Ruby Burmese Cuisine | `0ae2268d-3c71-4c92-9fd2-3b0366792187` |
| 484 | Burma Spice | `de020aa7-d7b8-48b9-8540-b645b1841d2f` |
| 485 | Burning Rice | `5b64e752-6764-4fb2-b591-7e026200a342` |
| 486 | Burnt BBQ & Tacos | `704f056d-7502-45f4-a5e7-7816976304ee` |
| 487 | Burny Pit Stop | `5952d51e-ebb4-4574-be4b-5fb8442025ac` |
| 488 | Burrito Express | `e31ac8d6-eb89-419d-b24c-8b4c652197e0` |
| 489 | Burrito No Mas | `61b2914b-9f78-4e72-a8d9-8398624d8e70` |
| 490 | Burrito Perdido | `7c50681a-b460-4898-a07a-470f076b8204` |
| 491 | Burritos To Go | `968c7237-7963-4f89-84f6-9b0c7a5126b5` |
| 492 | Busaba Thai | `bdce3862-d1eb-4179-adba-a522de3295e0` |
| 493 | Butler's Unique Catering | `2f53d24c-f5fc-4d8e-8071-7c95d8cc0216` |
| 494 | Buttered Up Bakery | `5fe1d638-4225-445f-85e8-fc408b48594c` |
| 495 | Buttermilk and Honey | `dbea6752-d1be-450a-8bdf-88055e147bc9` |
| 496 | Buttermilk Sky Pie Shop | `458658fa-fd54-4ded-9b2e-d5a572997044` |
| 497 | Buzznbeez Good Food | `f61dbc9c-dc01-43f9-94ea-8ecd2e84394a` |
| 498 | Byrek & Baguette | `47d03559-6e38-40fc-ab73-3720dc84d148` |
| 499 | C Rolls Sushi | `11ca2f25-ea37-4084-9250-bc6a915094e3` |
| 500 | C&C Curry House | `4d4d510d-2917-4d4f-bb9c-b5d1e269bba0` |
| 501 | C&H Cafeteria | `f6315868-b1ec-47bf-8404-f1731c889e7a` |
| 502 | Cabo Fish Taco | `417fe90e-7532-433b-8164-acdfdd10b2c1` |
| 503 | Cabrera's Pizza | `598bf156-797a-4e4f-9ace-8830946c5df4` |
| 504 | Cabrillo Park Cafe | `a07e5379-2cc1-4512-87c7-a26123903180` |
| 505 | Cafe Buenos Aires | `29d0c624-d3a6-4464-8ade-411656391ff3` |
| 506 | Cafe Cour | `779f81af-90a0-4db1-a3a5-8a8b6cdb8e1f` |
| 507 | Cafe Da Fonk! | `5134dd15-52aa-492e-9736-dd6926f80881` |
| 508 | Cafe De Khan | `43d418d1-e3ef-4a0f-8956-5ecc3f7605a5` |
| 509 | Cafe Izmir | `8ac1cc51-8481-4005-a431-169facb32e4c` |
| 510 | Cafe Landwer - Audubon Circle | `cd43bfa0-fb5e-454a-9504-f1d464caa4d7` |
| 511 | Cafe Landwer - Back Bay | `7f0898ec-ddfb-47ff-ad0e-29e792b1b993` |
| 512 | Cafe Luna | `cc29d699-cac9-4dac-b905-d9df4bdb17d6` |
| 513 | Cafe Morning Buzz | `135eb0c7-f63f-4bf1-8591-f0400fff0b6a` |
| 514 | Cafe Nubia | `38b2292f-09dc-4c20-b758-76b269c25f42` |
| 515 | Cafe Rio | `a55e5d36-1217-4e78-9a49-b6130a0e239a` |
| 516 | Cafe Rio Boise | `60043250-f741-4b06-901c-cbef0b09e272` |
| 517 | Cafe Rio Peoria | `5c0dc46c-3f90-4feb-90b2-3e81eb919485` |
| 518 | Cafe Rio Scottsdale | `831944ff-0c5d-4b96-aabe-9f4c893ef7e8` |
| 519 | Cafe Rio Spokane Valley | `60ea224f-408a-4d51-8d72-1f1711864d49` |
| 520 | Cafe Rosalena | `0279226d-51cd-4588-b7d3-1860422b7e5a` |
| 521 | Cafe Rumba | `b8a7e6b8-6fc2-416a-98a2-47108f0cc124` |
| 522 | Cafe Yumm | `797e37c5-e932-4f54-892d-c584b448452e` |
| 523 | Cafe Yumm! | `53f8be7e-1be0-4133-8e0f-e54958f19fae` |
| 524 | Cafe Zupas | `a8f9f09b-fc33-429c-8cdc-f5c337c2be7b` |
| 525 | Cafe Zupas Phoenix | `d159ebb9-df6a-4ebb-930e-433022cf1726` |
| 526 | Cafe Zupas Phoenix | `2daf0070-a740-4b76-9dcb-7e6cbcc5bad8` |
| 527 | Caffe Boa | `3f613076-5bc7-43fb-b7f0-1193a4c9444e` |
| 528 | Cagneys Kitchen | `d1080d8b-86d9-47e5-bfe8-0b8dd19dc54b` |
| 529 | Cairo's Gyros | `589df3aa-349c-4909-89c7-b549a8700d30` |
| 530 | Cajun Crab Pub & Grill | `6b41aa5c-cebc-423e-8fbf-ed3ee9a0313b` |
| 531 | Cake Bar | `5b673680-cf1f-4bf4-9e1c-ace48630b866` |
| 532 | Cake4One | `7c324d21-05c3-4e0a-9650-a1ada87dd448` |
| 533 | Caliente Mexican Grill - URI  | `08900ea2-aeab-41d1-9470-8e3ff4316304` |
| 534 | California Fish Grill | `a959c36c-9b85-4945-9055-858bf698b6bd` |
| 535 | California Fish Grill Phoenix | `eff2928c-fdd5-42e8-8d5f-93c19d62ada1` |
| 536 | California Pizza Kitchen | `ddf41d9c-25dc-430d-99f4-9eb5a0fc7e06` |
| 537 | California Pizza Kitchen Paradise Valley | `fa97a75c-3ac9-4bfb-9320-1e288c3bb0b6` |
| 538 | California Pizza Kitchen Plano | `c5feb020-a4fb-43c2-a7d9-01db47b3a7c2` |
| 539 | California Pizza Kitchen Richmond | `b357a928-acd5-4dbe-9aed-2e63a4f634e9` |
| 540 | California Pizza Kitchen Virginia Beach | `1017f04b-220c-456b-af26-b30a442e90b6` |
| 541 | California Tortilla | `08c8627a-7254-476f-b732-5c419f56451b` |
| 542 | California Tortilla Chesapeake | `6f15389c-3eb7-40fc-9d38-13f1c102d2a4` |
| 543 | California Wet Burrito | `8be7444c-02fa-4e00-ba67-5455c1f5ce71` |
| 544 | Calikid Burgers | `b6d2363b-1051-41fc-b6d5-d3e484afd34d` |
| 545 | Calmette Viet | `03125bda-86c8-4288-aee6-1094df52575b` |
| 546 | Calzone Connection | `90c1d7e0-4418-45c0-b47a-2da6673eb356` |
| 547 | Calzone Life | `e6120904-60f0-4d74-a385-5d995cbbe602` |
| 548 | CamiCakes Cupcakes | `4a437350-93e2-4984-99fe-1559b88f5965` |
| 549 | Canastas Chicken | `c402ce3e-49a3-47fa-812e-143d1bf1c49e` |
| 550 | Cane Rosso | `22b5d4e0-778e-4aae-bc4f-82c921c2e427` |
| 551 | Cantina Laredo | `18c3b5c0-8d13-4b5d-8688-5bf687c5ff7c` |
| 552 | Cantina Laredo Addison | `c8d8b821-a81b-4e56-b34e-702f2635e4ad` |
| 553 | Canyons BBQ | `392f79a8-5520-4781-ad43-26c20c11f699` |
| 554 | Capital Tacos | `c7dbfe18-c19f-4a7d-8bb0-b118798d039d` |
| 555 | Capitol Waffle Shop | `8c64aaf1-6707-4f1d-b18a-9d907f26c862` |
| 556 | Capriotti's | `ec709c7a-8081-4829-99e5-c6a23ae309c3` |
| 557 | Capris International Cuisine | `53d881c5-825a-49c8-934c-d43c582c41fe` |
| 558 | Caprissi Pizza & Pasta | `29d2ed00-2ad3-4b4d-ad21-115dffe6a473` |
| 559 | Carbone Vino | `2d9088cf-3b50-48f1-b2f2-f1efcdcdbc8c` |
| 560 | Caribbean Fresh | `683a349a-dd32-4a8c-ad1a-668edf4c6d6d` |
| 561 | CariBlue Restaurant | `f6dd58d3-63c2-4077-8535-98216e6cb3f9` |
| 562 | Carl's Jr. | `4cc30d09-2a0a-46fa-a20e-a81a78f8c486` |
| 563 | Carmen's Tamales | `fd1196d1-6f3d-4602-8882-388f23e11a6c` |
| 564 | Carol's House Cafe | `79146f1e-6ea4-40bc-a4c5-762bffc257b8` |
| 565 | Carolina Ale House | `2d81a96c-a8bd-4db9-8f1b-9ff5c83fac2b` |
| 566 | Carolina Cupcakery | `04fd6bf7-6fb2-445e-b926-6055e4045cdc` |
| 567 | Carrabba's Italian Grill | `6bc78b2f-41ec-4895-8882-1b3127727af1` |
| 568 | Carrabba's Italian Grill Chandler | `7c58f0d9-48a2-4d9e-80a9-b301ab545615` |
| 569 | Carrabba's Italian Grill Chesapeake | `0fe8bc69-c411-4351-9f9d-2a26db59fc2d` |
| 570 | Carrabba's Italian Grill Glendale | `aaf50c24-0c0c-45e7-aee2-5f07d8bd0045` |
| 571 | Carrabba's Italian Grill Plano | `e7cb2b10-0dad-4e32-bdb9-03fa2eaaf5c2` |
| 572 | Carrabba's Italian Grill Port St. Lucie | `8b6347a6-138e-4de8-9d5c-2f6e6e650721` |
| 573 | Carrabba's Italian Grill Richmond | `12ee4fed-6793-4500-9f3f-50cf30855a91` |
| 574 | Carrabba's Italian Grill Winston-Salem | `48568f3b-b977-40a6-b480-75d8329a2390` |
| 575 | Carrabba's Sandwich Bistro | `defde730-c93b-405b-b877-f2ffd70fb12e` |
| 576 | Carrabba's Sandwich Bistro Chandler | `e02e9654-10db-4a94-9e4e-8b9d4e25deec` |
| 577 | Carrabba's Sandwich Bistro Chesapeake | `f5744ecf-0be8-4e7f-bc7e-768998308aea` |
| 578 | Carrabba's Sandwich Bistro Plano | `fc92f179-561f-4596-adb2-505d08cc7c36` |
| 579 | Carrabba's Sandwich Bistro Port St. Lucie | `fa3fb530-cb47-43a8-bb0f-b131e3e679fd` |
| 580 | Carrabba's Sandwich Bistro Richmond | `be8a4016-68e9-425b-ae9e-62efd523031b` |
| 581 | Carrabba's Sandwich Bistro Winston-Salem | `cf75c479-42c4-4716-af31-711c7e8c2810` |
| 582 | Carte Brunch | `94d325a0-a28c-418e-b91e-fbdbaf5dd716` |
| 583 | Caruso's | `1cb93f18-39ac-4433-be2b-a5fb7394e4e2` |
| 584 | Carytown Gyro | `bca999b4-1b2b-4460-b9be-f091eb8ff5e0` |
| 585 | Casa Del Barco | `64aeb691-d4e6-47c5-9719-8f401049aaf3` |
| 586 | Casa Italiana Restaurant | `a39d682a-1839-4d0b-accf-ea0b54533770` |
| 587 | Casa Linda Taqueria | `b56135a3-4f0d-4090-b3ff-a356ad99771f` |
| 588 | Cason Funnel Cakes | `192e7e5c-e8fa-4c13-bebb-0221d27faa4e` |
| 589 | Castanea Sicilian Cafe | `a27a7a6e-ee63-4e7a-bd41-5e160655953a` |
| 590 | CAVA | `aea26cbc-6243-4979-b365-89ed2d92f767` |
| 591 | Cazadores Catering | `78e05081-f151-4ab0-b65f-90aff228db99` |
| 592 | CC's on Central | `51120ffa-a229-4a82-bafa-5b4feb6a2409` |
| 593 | Cena Vegan | `4f33229a-7334-4d5c-8a47-c6162711aa02` |
| 594 | CERA | `cefee68f-543b-49c5-9a14-e4cb2d7c9e42` |
| 595 | Cha Thai | `000f1ba3-1657-4367-8e39-e9bf8c4594d9` |
| 596 | Chaat Bhavan | `1baeebfb-82e7-4762-956b-820bad9e40eb` |
| 597 | Chaats & Currys | `ae0cc1c9-f9f2-48ef-a621-121ef9594acc` |
| 598 | ChaChaGo | `8411f45f-4178-4010-8ca6-f43de8a38ff4` |
| 599 | Chai Thai Noodles | `47edd02d-8b13-4627-9894-5891fc4c2cfa` |
| 600 | Charcoal Grill | `9fc14192-cc67-4579-ab67-114fac20a379` |
| 601 | Charcuter-Marie | `279b9d2e-3880-45af-9ac5-4f67bde8cc8f` |
| 602 | Charcuterie Love | `4d67e6e1-be55-4564-b39d-ff4ceb1804d5` |
| 603 | Charleston Catering and Events | `47b5d7bc-461a-4515-bc09-8485767046d8` |
| 604 | Charleys Cheesesteaks | `c26db146-7345-4fd6-b2ea-571488bf7e96` |
| 605 | Charleys Cheesesteaks and Wings | `58e03784-f326-4124-bea9-dc5fa4754c94` |
| 606 | Charleys Cheesesteaks and Wings Chesapeake | `dd2de7df-cbd7-432c-8856-3ac35da75591` |
| 607 | Charleys Cheesesteaks and Wings Hayward | `dabe1c13-52d0-44fc-b8cb-43b4b420be3e` |
| 608 | Charleys Cheesesteaks and Wings Norfolk | `9482c8c3-293f-4c2a-8b7d-259f6f12da7e` |
| 609 | Charleys Cheesesteaks and Wings Peoria | `2224b82e-47e0-45fb-b4ed-a77202775daa` |
| 610 | Charleys Cheesesteaks and Wings Richmond | `201c898f-fb0c-42f7-a095-7c0c70387374` |
| 611 | Charleys Cheesesteaks and Wings Rowlett | `5222bdfa-9af3-4c81-8117-746f29215da3` |
| 612 | Charleys Cheesesteaks and Wings Scottsdale | `a54359ab-1e8c-4d1f-8892-615144ab0066` |
| 613 | Charleys Cheesesteaks and Wings Winston-Salem | `64c990da-fe15-4b2d-b6e2-0c908a3653d9` |
| 614 | Charleys Cheesesteaks North Charleston | `3a966d70-2dbb-4902-9998-2722fd466853` |
| 615 | Chart House | `dbec6ae7-5a60-4cdc-85c8-274d39c41815` |
| 616 | Chasu Kitchen | `c7ebe0c7-e698-43f6-b504-018161d30aad` |
| 617 | Cheat Eatz | `b2567f2b-f805-4b94-91f3-5dddbafe4121` |
| 618 | Cheba Hut | `825dcc18-6a02-4e4c-bbbd-bb4f4176fd9a` |
| 619 | Cheba Hut Dallas | `218a8438-70fc-44b8-b451-c85355d81787` |
| 620 | Cheese Meat Board | `b0c3f1e1-107a-4851-a0be-d97531221681` |
| 621 | Cheesesteak House | `a2e85326-263c-4623-8a7b-7ac3e8edad11` |
| 622 | Chef Alyssa Wong | `9e63e9e3-ffa1-442f-8eaa-e203caba928c` |
| 623 | Chef Chen | `7078c3a7-7afb-4aeb-b3f4-87a95c0920a5` |
| 624 | Chef Donta | `80fb759b-3c08-419e-9785-fa246be06e5d` |
| 625 | Chef J Dim Sum & Chinese | `193701f3-917e-4665-b177-624ee185ab95` |
| 626 | Chefika Mediterranean | `09dfed82-3979-4fec-9cfc-11fbe37f4b76` |
| 627 | Chelles Macarons | `4d9ce0f1-9b15-44d9-bcfa-d980edfb19f2` |
| 628 | Chennai Cafe | `784e6892-cc07-4b15-9f95-329531fbfe8d` |
| 629 | Chennai Chettinaad Palace | `8b6cbbb3-e65b-4da6-8f79-04ca907c25f4` |
| 630 | Chennai Fusion Grill | `4147e0c0-1eea-448d-b415-6314c2fc4ac2` |
| 631 | Chester's Chicken | `01b719c5-9fb0-4985-a97a-bcf488d42733` |
| 632 | Chestnut Pond Farm | `94020740-afc9-4252-9a5e-10221e836d6e` |
| 633 | Chicago Fire | `bcec3180-af58-4d1d-b5b6-872f62c0568c` |
| 634 | Chicago Pizza | `1eb17976-6c95-45bf-a458-0b033a210947` |
| 635 | Chicago Pizza and Pasta | `e7149725-a180-4559-90f3-c8f24115d016` |
| 636 | Chicas Tacos - Hermosa | `52e6378d-73d5-49d9-b475-857f35b99d56` |
| 637 | Chick A Dee | `7fd9b4d5-7f12-42b8-9cac-01925d232a25` |
| 638 | Chick-fil-A | `d33b04f4-de06-4fc1-aa26-ab124c48a289` |
| 639 | Chick-fil-A Bend | `ff7ff3e3-39a6-47da-bca1-a759a30f068f` |
| 640 | Chick-fil-A Chesapeake | `d1877deb-36ad-4a0d-894d-11fe3ff223db` |
| 641 | Chick-fil-A Glendale | `a7ea215c-765e-443c-aa65-99f0a472e088` |
| 642 | Chick-fil-A Huntsville | `e2f841b4-8d00-4abf-a31d-2d79ec052aaf` |
| 643 | Chick-fil-A Nampa | `73536195-435d-493a-a9c8-4f306c3dae60` |
| 644 | Chick-fil-A Phoenix | `9d1a0e5c-0be1-486e-a97b-a7a180ffeb5e` |
| 645 | Chick-fil-A Port St. Lucie | `a89b7c36-2088-42f3-b4b4-d5b139f5edea` |
| 646 | Chick-fil-A Portsmouth | `798104ea-77a6-4047-8910-f2bb15e22669` |
| 647 | Chick-fil-A Richardson | `3db18eb2-017c-4f7c-9b6c-177b4515b11e` |
| 648 | Chick-fil-A Richmond | `891b383c-4583-4d39-8976-57ddaa4307a4` |
| 649 | Chick-fil-A Winston-Salem | `42f4051b-f669-471b-94e5-ac97b98fc820` |
| 650 | Chicken & Waffles for the People | `b5fee545-c2d1-483f-855e-1fb266ffba91` |
| 651 | Chicken Express | `6a2d3827-ea49-48c2-8832-785e852b1513` |
| 652 | Chicken Guy! | `e65024a3-5c3e-4493-9a32-cdfa6a896fa4` |
| 653 | Chicken N Pickle | `f316ebb9-80a3-4eb7-bead-ad89ee943c65` |
| 654 | Chicken Paddy | `5c05f791-f7fd-4a94-aefe-34bbfdc99fbf` |
| 655 | Chicken Rebel | `675b6f87-217c-4ca1-82a6-f7dd61fa2b81` |
| 656 | Chicken Salad Chick | `31d2ae37-a699-4e03-9b15-90ef20a8197e` |
| 657 | Chicken Salad Chick Mechanicsville | `09ecd964-ba8a-44d7-bf15-68393d1c4e3d` |
| 658 | Chickii | `3dbc5b45-1eef-4066-a11d-2d118114a517` |
| 659 | CHIC’N & BEER | `852ecfee-8463-48bf-bd14-e4a4e71b2b63` |
| 660 | Chido Taco Lounge | `46c48559-6910-4517-9638-e381588ae739` |
| 661 | ChikisPancakes | `e19842cc-a78e-496e-9084-87d59c9ef3ed` |
| 662 | Chilangos Tacos | `780f2f09-f7fb-4dd5-bd14-3c43a5f5bd2a` |
| 663 | Chili's Grill & Bar | `64e2752b-de18-47ea-a95c-ce3ca18e3277` |
| 664 | Chili's Grill & Bar Chesapeake | `635d9f9d-7fae-4272-9f73-a731118e990a` |
| 665 | Chili's Grill & Bar High Point | `cff3a239-4d59-4986-b447-06bf0f953909` |
| 666 | Chiloso Mexican Bistro | `2d023a29-c807-4553-b480-7d54bbb29a42` |
| 667 | Chin Up Donuts | `269998b8-bfc5-422d-8d42-6ccf806aaee5` |
| 668 | China Fang | `4880aebd-48af-47b3-b742-221f7841b2db` |
| 669 | China Garden | `1feb309a-9c46-4dff-a6fb-131a573350fc` |
| 670 | Chip Cookies | `2df37d57-3b33-4eb0-b2ab-a906b854e95a` |
| 671 | Chip Cookies Boise | `b9668afc-4643-4422-bc7e-fd5ddf39fe7f` |
| 672 | Chip Cookies Plano | `1dd11882-0ce6-4c6a-abfb-8815367449ac` |
| 673 | Chompie's | `1b37a6bb-ac48-4827-88fc-dfc627a498d5` |
| 674 | Chompie's Glendale | `bfc22521-e3d9-4f1a-9f45-a6a2b370dc7a` |
| 675 | Chook - 8th Ave & Birch St | `0199d197-15f4-4e41-9ab1-b1825569793d` |
| 676 | Chook - Cherry Hills Marketplace | `cf51babd-baa5-4c19-9054-4c9711625092` |
| 677 | Chook - Platt Park | `e79ccfc1-e3c2-4d85-ab9f-98e7eff92301` |
| 678 | Chop House Burger | `b3a78fb7-1348-4f42-ac74-d7e38a6cf9af` |
| 679 | Chop House Gyro | `463fa97e-27cd-42c3-b5ab-6b6177eb5ba4` |
| 680 | Chop Shop | `56e9fe6f-5159-4c08-a889-4aef86750f44` |
| 681 | Chop Shop Casual Urban Eatery | `a931ec82-e8ef-4206-ac06-34783723a2d7` |
| 682 | Chopped Halal Grill | `2c370e02-0eda-4104-8d63-454fb59a377f` |
| 683 | Chopt Creative Salad Co. | `6c288f25-329c-47ed-9279-42a0877d2a9f` |
| 684 | Chopt Creative Salad Co. Winston-Salem | `a10870d0-ea85-4c88-99c8-c3382e87d3d5` |
| 685 | Chow Bella | `52cdcfcc-e932-49ec-abb8-1548d4aee3ab` |
| 686 | CHS Coastal Charcuterie | `7c64192d-f7cf-440e-81d1-0aee14515b17` |
| 687 | Chuck-A-Rama | `1cdf79df-ef33-4bac-b271-0e5415035e08` |
| 688 | CHUNK Cookies | `8cbaeda6-4751-43e9-81a6-a3ee931c9e86` |
| 689 | Church's Texas Chicken | `0f38c217-d55d-4879-b78b-72a7e2218ebb` |
| 690 | Church's Texas Chicken Glendale | `2b761fee-285b-42bf-b813-71a066b432e1` |
| 691 | Church's Texas Chicken Phoenix | `31dfee8f-f131-4e12-bcb1-c16db4f7e4dd` |
| 692 | Church's Texas Chicken Sachse | `23e3bce1-7a0c-4622-b7b6-ec93ed7b5c19` |
| 693 | Chuy's | `6fe48f93-fa98-42e1-b1f4-cfb1d1601164` |
| 694 | Chuy's Glen Allen | `bd821bca-19a8-4022-a783-0c019abc7c90` |
| 695 | Chuy's Huntsville | `f67d5b99-72a8-4737-8954-26c2883542d1` |
| 696 | Chuy's Plano | `c122c877-c8a9-4081-9391-e0e1b52544d5` |
| 697 | Cicis | `24074d8a-ba81-4cae-bd0e-426eceb4bc7c` |
| 698 | Cielito Mexican Flavors | `4dcd6b79-c1f7-466f-aad2-8da85908d103` |
| 699 | Cien Agaves | `f12a8450-7a50-440a-a850-0ccf87e23996` |
| 700 | Cin Cin Burger Bar | `42ecfeea-0eec-4e1d-9eac-34d61a6dc899` |
| 701 | Cinnabon | `9a8523c5-d48d-4ee0-93f6-04a7e28bef23` |
| 702 | Cinnabon Mount Pleasant | `bba7894b-a82b-4fad-ace2-82db6618841a` |
| 703 | Cinnabon Phoenix | `7c5acbaa-9a33-421c-a99c-43ed8c812659` |
| 704 | Cinnabon Scottsdale | `963f7340-4750-4e62-b945-f3be28e39947` |
| 705 | Cinnabon Spokane | `f71266e9-6fca-40ea-91cc-c8b824488962` |
| 706 | Cinnabon Virginia Beach | `41a5cd45-7e75-47d2-823c-4fb1cb3f8237` |
| 707 | Cinnabon Winston-Salem | `8570e772-7c67-45c5-9efc-bb043fcc7731` |
| 708 | Cinnaholic | `ae468afd-0cce-4ecb-8b7d-7fbecb604bdc` |
| 709 | Cinnaholic Gilbert | `04328946-2dc1-458f-b6ca-f102210a61f1` |
| 710 | Cinnaholic Greensboro | `4bee47aa-5622-4c39-8dc8-9f18cc359168` |
| 711 | Cinnaholic Richardson | `87c6b6e2-53c4-421f-89c6-fab413658e88` |
| 712 | Cinnaholic Virginia Beach | `f4302dde-44e3-4b61-a2bb-e782d91117d0` |
| 713 | Citti's Pizza | `d0b5f5b6-cf4f-4e27-a979-2057abca1e09` |
| 714 | City Bowls | `b1d554c8-0d1e-4222-a78f-a13918708943` |
| 715 | City Diner of Stuart | `0ac20f2b-a9a4-4f38-ab0d-2702de3702e4` |
| 716 | City Market Deli | `cb4b54a4-db97-4cab-8cad-9057ae885b31` |
| 717 | City of Spice | `09b4e17e-e330-4cd6-a3ff-009ec4af5679` |
| 718 | City Pop | `3006ff98-3770-4bb6-8cf1-40700c4346b2` |
| 719 | Classe Eats | `5016dd8d-931e-4f6e-892b-6609e6682db9` |
| 720 | Classic Catering | `962cc6c7-154f-4722-8c18-e394277a7a32` |
| 721 | Claude Bakery | `f58a6e41-c1a9-44f1-9ceb-21536f9347ca` |
| 722 | Clean Eatz | `8ebaaace-8130-4d65-a69f-94afdac7ecc6` |
| 723 | Clean Eatz Chesapeake | `258fc7f7-8465-4463-8b1a-89fe2cc3d28c` |
| 724 | Clean Eatz Glendale | `a501aa3f-2e82-4bd4-ae9d-c976a8b53be9` |
| 725 | Clean Eatz Meridian | `3180bda9-b75c-4d84-a8f4-bbbb4c1934d5` |
| 726 | Clean Eatz Norfolk | `a2e18668-ee6e-498b-aa44-28bda60db317` |
| 727 | Clean Eatz Scottsdale | `aabc5ee9-24ba-43ea-9dbf-4991cb1744db` |
| 728 | Clean Eatz Winston-Salem | `cbc7a1b6-0aa6-4a5c-a57c-8dc37da2746e` |
| 729 | Clean Juice | `73c17d96-dac0-4a78-b3e8-8cb7789bad10` |
| 730 | Clean Juice Gilbert | `4f2a7c1c-02af-43a8-b74f-043ec0cdf391` |
| 731 | Cleats. | `577d910d-a76b-4fee-9412-4cea3e91a909` |
| 732 | Clever Chef Catering | `bbd9248b-1058-42c4-918b-ad0a115f7863` |
| 733 | Clinkerdagger | `b7cc9ddd-0610-4c63-a0fa-8ed296193b93` |
| 734 | Clockwork Pizza | `a86a8d76-ed88-4b06-897a-7b9222dca52a` |
| 735 | Cloud9 Corporate Catering | `4844d24c-5b10-4d18-914f-48a476e7b9d3` |
| 736 | CM Chicken | `532dc280-4cf5-46df-b198-33f0c7aecaef` |
| 737 | Coal Mine Coffee & Sweets | `0e66ffe2-ab84-4e23-9386-13ba0de8ff6f` |
| 738 | Coastal Curries of India | `9d3603d1-139c-4a10-b52f-5bd6899003d4` |
| 739 | Cobani Gyro | `b7c026b1-a9c4-444b-861f-7cd0a9508aaf` |
| 740 | Cocina Hermanas | `89720f29-b6ce-4d88-8f1b-79ef51d2c351` |
| 741 | Coco Shrimp | `e73752b7-7f10-4102-87a1-078cd52a78b1` |
| 742 | Cocola Bakery | `59c9149c-449c-4012-a4d6-858bd91a5395` |
| 743 | Cocu Rotisserie  | `38bb1111-20a5-400d-b316-eb7bfdf02b32` |
| 744 | Coffee House Cafe | `c215ad53-a14e-42b3-8fbb-8de79e736664` |
| 745 | Cold Stone Creamery | `f2bcc75f-15cc-4a90-8f25-529b342a42da` |
| 746 | Cold Stone Creamery Boise | `93da307f-fbf7-489a-9c4d-fb7bed6345d9` |
| 747 | Cold Stone Creamery Fremont | `0c4112eb-82e2-4285-b06a-75c1aff1e4a7` |
| 748 | Cold Stone Creamery Kernersville | `abc713b5-5e9c-4ba1-8aa1-c4c9218382c6` |
| 749 | Cold Stone Creamery Phoenix | `fa7f5187-5242-447c-8d25-93c6d5b444e5` |
| 750 | Cold Stone Creamery Sachse | `08727410-f1be-4a49-a042-322e88e9dfaa` |
| 751 | Cold Stone Creamery Stuart | `e8185b4e-370b-412d-9963-a0acd6faf4da` |
| 752 | Cold Stone Creamery Suffolk | `a8aab771-5259-4834-a117-d683dbaf40f7` |
| 753 | Cold Stone Creamery Tempe | `c496d3a6-e11a-4acf-84ce-ca414248ed07` |
| 754 | Colosseum New York Pizza | `3563ba25-1ea3-493b-a6c7-b75a00fbd7a3` |
| 755 | Commissary | `fd851db5-eb62-474f-ae06-8c4f1961340a` |
| 756 | Community Tacos | `a30cc9e3-99f4-48f4-b1c0-3b4f84a9f1c5` |
| 757 | Con Madre Cocina | `c55ebc70-5ee0-4acc-8508-e518fadc13ed` |
| 758 | Conceptually Social Catering | `7032477c-bbb9-4cbf-a0c9-17d9b20bdacb` |
| 759 | Condado Tacos | `bc55c892-2f3f-4a60-a341-4a7bcdfdc4b0` |
| 760 | Condado Tacos Huntsville | `14309375-8365-4c31-a9d8-33c5b4f4ea3e` |
| 761 | Coniglio's  | `af302109-9b54-4b5a-b86c-c72c1da683a3` |
| 762 | Cookie Co. | `6008e25c-da8b-4bbe-a64d-216c6c5de87e` |
| 763 | Cookie Dough Bliss | `28c402a0-a7d4-4d48-8d3d-d3e195781677` |
| 764 | Cookie Plug | `89ff2b9b-a0f3-463a-9481-7c99e4af8811` |
| 765 | Cookie Plug Greensboro | `97fe68d6-e005-4519-b879-6aac41e2ee65` |
| 766 | Cookie Plug Phoenix | `f8a235c6-5f5c-46f5-961b-157956e3c4c4` |
| 767 | Cookies By Design | `2e402dac-bd9f-4a5a-b032-b6fb6f5e69ca` |
| 768 | Cooking With Carmen | `57912bad-8a6a-4104-9b5f-50b7990a9205` |
| 769 | Coop & Run | `f043de10-e223-46af-9b5d-00a3c0e0b892` |
| 770 | Copper & Vine | `1260ef1a-b136-4b2c-899a-a8d94b3f81bb` |
| 771 | Corleone's | `e5c4e21f-5c9d-4943-a6c9-a17f23a31295` |
| 772 | Corner Bakery Cafe | `d14dce33-cd20-42c1-a87e-09f97ccd275e` |
| 773 | Corner Bakery Cafe Dallas | `76bb4e5d-9cfd-46a5-8f5f-26855629deb0` |
| 774 | Corporate Caterers | `d947048c-d65d-4777-b791-346f1f04324a` |
| 775 | Corporate Caterers Carrollton | `d4aee891-5c68-434a-bfe9-96c9e8ff8dea` |
| 776 | Corporate Caterers Mesa | `fb7fef2b-96ff-4ad5-a0d3-01438ccb64c0` |
| 777 | Corso Italia | `272b881d-d086-4f9e-a307-b3d2fc6763cf` |
| 778 | Costa Vida | `bfdf374c-116a-46b6-bad8-0fe3d903d5a7` |
| 779 | Costa Vida Mesa | `4e3bb3d7-83c0-4469-beb1-22c8324f53df` |
| 780 | Cotton Patch Cafe | `6ee0a4ce-cff1-4de6-ba31-069ab3b99d47` |
| 781 | Country Club Cafe | `2a3204a1-14ef-4b69-87bb-7be7cf3f3dc2` |
| 782 | Cousin Vinny's Pizza and More | `7d82543a-2053-4562-803c-e61b5a77790c` |
| 783 | Cowbell | `0c1f5cb1-efc5-44b2-b672-5572a8fc6b53` |
| 784 | Cowboy Chicken | `2c8d5e89-db9b-47b5-8c7f-17c113435b4d` |
| 785 | Cracker Barrel | `0f42a4db-1b0a-4687-98af-e4d67de67bd0` |
| 786 | Cracker Barrel Boise | `6fcdd84b-3d6f-4cc3-99f8-dfc87f50fc49` |
| 787 | Cracker Barrel Chesapeake | `3bfdbfe2-2930-4a51-a94c-1458aeb90321` |
| 788 | Cracker Barrel Glendale | `5fddf347-8bc4-4c4f-8698-7f53d30f2f7d` |
| 789 | Cracker Barrel Henrico | `41dbe312-820f-4b37-8daa-8e239731fba9` |
| 790 | Cracker Barrel Huntsville | `fd1acb2f-9517-40fd-89bb-8e778bef4c24` |
| 791 | Cracker Barrel Jensen Beach | `1db78514-01af-4e0b-a4fe-01207f2954b9` |
| 792 | Cracker Barrel Kernersville | `3524297c-ae33-4451-b7bf-5f85efcd8f41` |
| 793 | Cracker Barrel Mesa | `8147fcdd-d8b9-4e5e-91e6-c0f4d80be29b` |
| 794 | Cracker Barrel Mesquite | `b6dd8863-8d87-4931-8402-d8c4dfc6804e` |
| 795 | Cracovia Polish-American Restaurant | `cd1358cf-aa85-4343-909b-887293560e37` |
| 796 | Craft Kitchen and Brewery | `77d7b4a9-566c-4b6a-a1bd-ba39a2f25f8f` |
| 797 | Craft Kitchen Express | `7589b7c0-5bb3-4680-b1d3-c2f3bda52af6` |
| 798 | Craft Pizza Catering | `6abdd927-2e12-426a-ad04-e8f2ce05a543` |
| 799 | Craft Pizzeria | `116ecc0d-48de-4788-a29e-4213fbcfa4a5` |
| 800 | Cranberry Hills Eatery & Catering | `06b2dbc6-52f3-4196-86ac-0aa15680fc42` |
| 801 | Crave Kitchen and Cocktails | `8e154ddc-32d1-4495-8eff-b9806ee756b0` |
| 802 | Crave Popcorn Co. | `fc5f85ae-acfc-45f8-bd46-038d0662d8ce` |
| 803 | CraveWell Juicery & Cafe | `751c8a01-60ce-456d-813b-c7c478cd129f` |
| 804 | Cravings Tapas Bistro | `29a65c8b-e98c-4567-8874-1f27d7c64d4e` |
| 805 | Crazy Burger Cafe and Juice Bar | `8da4266c-266f-456c-a293-317ea1a75181` |
| 806 | Crazy Pita - Las Vegas  | `3551dabd-bbc4-4edb-9012-92af3cccb057` |
| 807 | Crazy Pita - Port St. Lucie | `653052c5-4fd3-4555-99cf-73a0ee2b98ce` |
| 808 | Crazy Tomato Pizza | `abc88f6c-ca9d-4d81-bbc8-4eab830087f4` |
| 809 | Creekside Fine Grill | `a97faa90-3391-4bfc-b606-bf1e6d03da04` |
| 810 | Crepes Palace | `59018c17-53fc-416d-862e-69614120ab88` |
| 811 | Crickles and Co | `3457eaec-ab87-4583-a050-51616f2b0144` |
| 812 | Crimson Coward | `e1d41978-85b1-438a-afaa-a20f7da4bace` |
| 813 | Crisp & Green | `cba97a86-20da-49a0-9574-01807ff7985f` |
| 814 | Crisp & Green Dallas | `05322e03-aea6-4631-9c85-b37ef60cbfe2` |
| 815 | Crispy New York | `080395f9-0813-4454-860f-c7cd37872bba` |
| 816 | Cristina's Fine Mexican Restaurant | `24b32959-e4b2-49a5-91c7-0831161038a4` |
| 817 | Croc Soup Company | `a15d961b-09cd-4b2b-bd56-4f3e9ebaa250` |
| 818 | Crossbuck BBQ Catering | `b175dc77-0ddf-4404-80ca-f569ec421385` |
| 819 | Crouching Tiger | `b8444e07-7596-41d1-b1df-9bdb3141c3e7` |
| 820 | Crumbl | `93f5e211-3b36-41b5-a122-5d08dd8763d0` |
| 821 | Crumbl Cookies | `f576f3e8-ebfe-44a3-a585-e1ee160a9d6c` |
| 822 | Crumbl Milpitas | `f931b486-d6ea-42f6-9b16-1138f7690848` |
| 823 | Crumbl Phoenix | `0f800b25-5eb9-464f-ac94-e3d948410944` |
| 824 | Crumbl Port St. Lucie | `1a0f8097-d593-493b-bb46-d47799978462` |
| 825 | Crumbl Wylie | `d42da159-345e-436e-8993-f99b2383eb3d` |
| 826 | Crush Yard | `266f3982-ba6e-4b71-8e40-99a67b296107` |
| 827 | Crust | `f44aee59-a945-4516-8ff8-90d38e6d4efc` |
| 828 | CRUST - Sourdough Deli | `f5c7364d-63a4-449f-85be-c46563ec14c0` |
| 829 | Crust Tempe | `d056e6bc-290d-49a0-a8a9-c4b09a001c3e` |
| 830 | Cuban Kitchen | `9ee117fc-ad0f-468e-9c21-deaa524efd65` |
| 831 | Cubana Grille | `296d826e-c5b6-4d5b-bb43-5ba04335fa43` |
| 832 | Cubano X-Press | `e67c9a16-cd6b-4db0-8672-e3325759be96` |
| 833 | Cuco's Burritos | `1655e00a-b31e-4885-82da-9a2ccd0147c4` |
| 834 | Cuisine by Claudette | `71092270-4a81-4349-ac65-d121cf2ef646` |
| 835 | Cuisine Prive | `7deb6e33-eb1a-462e-9cb1-2529ea12efde` |
| 836 | Culinary Dropout | `092fb7ea-86f3-4b6e-9c38-dd69275e0d7c` |
| 837 | Culinary Dropout Phoenix | `05466402-75e2-4da4-bc85-9004d26a9fa2` |
| 838 | Culinary Dropout Scottsdale | `0f49e016-94b2-4b84-b75e-b15406db1279` |
| 839 | Culinary Visions | `7728da40-0eaa-4100-8327-2b8b40f98fc8` |
| 840 | Culpepper Cattle Co | `5cea9cf9-030f-484c-927e-13414646372a` |
| 841 | Culture Clash Greek Yogurt | `2971d819-5962-41c8-85a1-00be8690f05a` |
| 842 | Cupbop Korean BBQ | `89cc4026-bd05-4125-8ea7-1b4149928a88` |
| 843 | Cupbop Korean BBQ Glendale | `06ac649e-054a-47f8-af05-e9ee43a891c3` |
| 844 | Cupbop Korean BBQ Phoenix | `63f79c3b-06eb-4f13-b967-82c43560f8f0` |
| 845 | Curry and Kabab | `24d1ee56-38f3-45fb-81ef-94f892512600` |
| 846 | Curry Bliss | `bff45034-b06d-4b8e-9b1a-d31ebff2713d` |
| 847 | Curry Kingdom | `1c081632-4c66-4412-8ada-5a8938061c2c` |
| 848 | Curry Kitchen | `e7c834f2-2890-4098-84bc-5b1f9b7e18a1` |
| 849 | Curry Pizza House | `d867bf19-1b4e-4a98-a79d-8b4cbfae9c0f` |
| 850 | Curry Pizza House Plano | `2c1b3390-98f8-4a70-a087-3dd626d55795` |
| 851 | Curry Up Now | `629af39e-641f-48a1-9122-b0c7466c23b6` |
| 852 | Curry Up Now The Colony | `6e1f5836-d89f-4a44-993c-349f563f9a3d` |
| 853 | Curtis Park Delicatessen | `6904949a-e76c-4b41-ab35-642050866e01` |
| 854 | D Jackson BBQ & Catering | `7ab12601-ec0f-4083-bfa6-a5412666dc74` |
| 855 | D Mac N Wings | `e8d9bb97-207b-43e8-9918-3f2964a227d8` |
| 856 | d' Bali Asian Bistro & Catering | `cd311bed-6042-4a3f-8e0e-70dc2c043f3c` |
| 857 | D'Allesandro's Pizza | `b9cf7fe2-7624-4269-8d57-e8c86500891e` |
| 858 | D.P. Dough | `25da4c7e-e18e-4ea0-9df7-cf89e1a2b4ba` |
| 859 | Da Bomb Brownies | `3dd2bab4-b2d3-4522-bae0-6015482d30b8` |
| 860 | Da Vinci's Italian Grill | `6e039d38-0edf-4e98-93e2-82f9c758cdc6` |
| 861 | Dad's Catering Service | `ebac77de-56c2-487d-afb4-97329592e58e` |
| 862 | Daddy's Chicken Shack | `266faab3-24fe-4e15-9397-f0744d07787c` |
| 863 | Daily Jam | `d792d323-a3c8-47eb-b287-2023288dac51` |
| 864 | Dairy Queen | `9ee90a6d-a7da-4bcd-906c-b91989cef171` |
| 865 | Dairy Queen Mesa | `39df72ee-295e-4d67-b197-3418316bb18f` |
| 866 | Daisy Cakes | `410974b4-5649-4f04-8602-177a00f3c959` |
| 867 | Dale Arepa Bar & Healthy Bistro | `cc34d49b-b91c-4c31-a074-effcfce3bf0d` |
| 868 | Dallas Burger Company | `628c5f6a-8c63-4b62-a530-9d02c8b2b8a6` |
| 869 | Dallas Catering Kitchen | `a26a26da-f8c7-437f-8335-dae5d3dda4b5` |
| 870 | Dallas Healthy Foods | `e6158d63-4dc9-4d63-b8b9-f26becce72b5` |
| 871 | Daps Breakfast & Imbibe | `20268b77-b9e6-4ec3-8c0f-a5f36d96e9be` |
| 872 | Dark Side of the moo hell's kitchen | `a433353e-c46f-4c4a-b29a-676e2f2779c1` |
| 873 | Darna Mediterranean Market | `2f07ef74-5b1d-4167-a914-c64e70a35ea9` |
| 874 | Dashi | `9c1dda11-3d92-477d-9aca-efb437b72b4b` |
| 875 | Dashi Food Truck | `9c923da8-cfe4-418a-ae48-17429e9ba549` |
| 876 | Dave's Hot Chicken | `5960387a-9462-4a95-8216-f8e18d0b3901` |
| 877 | Dave's Hot Chicken Chesapeake | `1d6cbd67-d7bb-40ad-8024-64d592c8388e` |
| 878 | Dave's Hot Chicken Gilbert | `58f99ed1-1efa-4362-a740-8b8a03d810ce` |
| 879 | Dave's Hot Chicken Meridian | `e1431d32-7930-4c3e-8a39-5be297babaa1` |
| 880 | Dave's Hot Chicken Phoenix | `7f5db2b2-3fe5-4442-9bf7-76c8a8c7f121` |
| 881 | Dave's Hot Chicken Richardson | `11e4dc74-822a-4a9b-8163-717cce4e5205` |
| 882 | Dave's Hot Chicken Richmond | `c2adb4c6-5d0f-4ff7-995b-c28692e6d89b` |
| 883 | De Afghanan Kabob | `6c2819f9-ba0b-404d-86a2-0acc74ddcb31` |
| 884 | Decades Pizza | `4800a03e-c525-4230-a461-eed2987ae0b2` |
| 885 | Decent Bagel | `9acfcb25-b42a-41be-871a-5142f4b8b59c` |
| 886 | Deep Run Roadhouse | `938427e5-042a-4c6e-aec1-31a613fb969a` |
| 887 | DeEva Kitchen & Bar (formerly Mio Italian Kitchen) | `36e07c9e-ce6b-4e70-9d48-8ef49e59c914` |
| 888 | DeFazio's Catering | `ceaeae4d-b493-43fa-9193-53fac8213b9f` |
| 889 | Del Frisco's Double Eagle Steak House | `91cd657d-6623-4f13-9be3-67bbd7dae79d` |
| 890 | Del Frisco's Grille | `5bbf2431-2e13-49d9-b39b-0cb3e84d9ffc` |
| 891 | Del Rio Restaurant | `3f98e33f-6497-4ae8-8e94-a756f01756a5` |
| 892 | Del Sol Bistro | `853a454b-31b5-4cdd-b76f-955e5d77cbbc` |
| 893 | Del Taco | `eff32072-1010-47d7-a2f5-8d2049bffed1` |
| 894 | Del Taco Glendale | `c16706ab-2fdf-4813-803b-283c28820f25` |
| 895 | Del Taco Phoenix | `368c282d-c262-407a-8d08-899810761bff` |
| 896 | Del Toro BBQ | `deb0ffde-358f-47be-acf9-d596715abe19` |
| 897 | Delicious Cakes | `be8fa4f0-5f94-41bb-a5a0-3800366207cd` |
| 898 | Delico 21 gourmet deli  | `fccbea13-d09f-4c6b-9f97-559f6b08d4bc` |
| 899 | Delsa's Ice Cream Parlour | `adb054ab-1e62-4f09-9689-3f3791cf3036` |
| 900 | Delucca Guacho Pizza & Wine | `ef7aa3a3-53d0-4c39-a59a-a2022766b1a4` |
| 901 | Denny's | `eed53ad8-e7bd-4630-943a-37f364994a70` |
| 902 | Denny's Chesapeake | `49e7ba52-2519-45bf-9cac-a027f8790dba` |
| 903 | Denny's Dallas | `11f4274d-4f91-465e-aaa6-7ad8d93d3c86` |
| 904 | Denny's Phoenix | `7d82101b-9501-4342-9ee2-272bd8021d98` |
| 905 | Denny's Scottsdale | `d15debe1-fecb-4c11-befa-46d51373ddb7` |
| 906 | Der Wurst Hot Dogs | `15a947e2-1612-4fa5-a4c2-aae2b568c2a4` |
| 907 | Desert Island Eatery | `459ff4f3-bd03-48f5-aa1d-e33c52a5cc4b` |
| 908 | Desi District | `326d91f7-94a9-4c47-b40b-9a5f4da4e262` |
| 909 | Desigaadi | `c837cb95-1e9e-4378-b90a-ff34ce7f195f` |
| 910 | Desperados Mexican Restaurant | `ed9ab860-0da8-4c12-a15e-2b11a119ba97` |
| 911 | Detroit Coney Grill | `6bb8fe34-f50d-4af7-be6b-b751b4520608` |
| 912 | Di Fara Pizzeria  | `bf88afd9-df19-4595-8a06-5700d415fa85` |
| 913 | Di Lisios Italian Restaurant | `b2c75950-fc89-488c-a7c2-33e12fc752c3` |
| 914 | Di Rosani's | `3b411ef4-b246-4761-850a-d663ba32a04e` |
| 915 | Dia's Market | `56571a9d-daf3-479a-aab9-3a312da82ecd` |
| 916 | Dick's Last Resort | `e1f09c35-0774-466e-b51c-11ad7a05c2de` |
| 917 | Dickey's Barbecue Pit | `b523cef2-6d1a-4f9a-a137-90b48be60bb8` |
| 918 | Dickey's Barbecue Pit (Home Office) | `1e7a4b93-f7ae-43c6-9e98-71e5dd83a180` |
| 919 | Dickey's Barbecue Pit Garland | `669743c0-83b7-4509-b205-60833103fcb4` |
| 920 | Dickey's Barbecue Pit Huntsville | `43fee49f-005d-4636-bcd1-4118149d6d1f` |
| 921 | Dickey's Barbecue Pit Jensen Beach | `ee0d14fd-477f-42d0-8e89-0e859ce7145d` |
| 922 | Dickey's Barbecue Pit Phoenix | `4cdd5f5e-5fc0-4b57-b096-98abb2f85d85` |
| 923 | Dickey's Barbecue Pit Redwood City | `69bf0b40-0d2b-428f-84ff-89dff5c6845d` |
| 924 | Dickey's Barbecue Pit Spokane Valley | `94432ddf-c9a9-452d-aa38-bc5e964e5954` |
| 925 | Dickey's Barbecue Pit Star | `8b8bc9f7-ceb5-4ebe-9d77-4673f8bf500e` |
| 926 | Didi's Downtown | `2614f450-4cc4-48dc-aaa5-db53baf65ce8` |
| 927 | Dillas Quesadillas | `dfee7867-1a5f-4682-965f-277133e87564` |
| 928 | Dilly's Deli | `38c6dcda-0ce2-462c-b938-a61b21369219` |
| 929 | Dimassi's Mediterranean Buffet | `949df932-0850-4e07-bf6e-9ca460953885` |
| 930 | Dina's Cuisine | `1c0538ae-25cb-4dd3-a7cc-76257f93a9a5` |
| 931 | Dirty Bones | `742eaf85-deca-43a2-99af-e37bb7f620ee` |
| 932 | Dirty Dough Cookies | `bd9e893f-aacf-4ba6-9c8f-48e4c4f56fd5` |
| 933 | Dis Burrito | `dfe847d4-921e-4e70-8db8-a8c362aeb7bb` |
| 934 | District Taco | `c6d72168-a15b-4ca0-901d-751d498df7ec` |
| 935 | DJ's Watering Hole | `adf4179a-744f-4075-8160-495b49eae3c8` |
| 936 | Doc B's Fresh Kitchen | `72de20c0-c0db-4522-96db-ed6632aefaea` |
| 937 | Dock Local | `1236a9f6-c6f0-49d7-b431-288c6de48e7f` |
| 938 | Dog Haus | `224c56e0-c209-4f93-807d-9faf1b66b3fa` |
| 939 | Dog Haus Phoenix | `d74af74e-3130-4076-806d-1270c326e7e0` |
| 940 | Dog Haus Tempe | `1c406628-c9bb-4c4d-a7fa-5492cf505e54` |
| 941 | Dogwood Eatables | `a14338c1-95f9-4ebb-b818-113fe69c2032` |
| 942 | Dolce Vita | `9b35d371-4731-4db9-af18-f83b21960a33` |
| 943 | Domino's | `f9cac57f-64c2-4055-9b7f-61a9090fe7c1` |
| 944 | Domino's Fremont | `92d1275a-5958-4e2e-8f26-9e5d694aa9b5` |
| 945 | Domino's Glendale | `3602d4eb-d5e2-4b00-8c54-1258198e742a` |
| 946 | Domino's Portland | `2cf46ed3-03ad-4a95-9e0f-ef5c4511b956` |
| 947 | Domino's Scottsdale | `f0daf05a-5ba5-4305-bff3-8c89366cc39a` |
| 948 | Don Jose Mexican Food | `72346537-98a8-4c36-8181-19abd46173d0` |
| 949 | Donatos Pizza | `20142a58-d2f3-4b29-bec0-16da99967bc5` |
| 950 | Donatos Pizza Boise | `e7907c2e-765b-4c20-87b5-937581c0b419` |
| 951 | Donatos Pizza Charleston | `3ac08c25-3788-4031-9bc3-537ef7004099` |
| 952 | Donatos Pizza Frisco | `7f942dfc-102f-444d-9171-f55a90a4ec1b` |
| 953 | Donatos Pizza Glen Allen | `5c63e1d3-a72c-49ee-bfa0-13617aa83ea4` |
| 954 | Donatos Pizza Huntsville | `6351f94b-b26a-439a-a34d-21025225acdc` |
| 955 | Donatos Pizza Santa Clara | `fdee3f05-401c-49b6-aca2-50ba2f4f97d7` |
| 956 | Donatos Pizza Scottsdale | `8e533b6f-e563-48f5-a16a-91efe23468d8` |
| 957 | Donatos Pizza Spokane | `3bddbdb6-6f2a-4c0e-916a-a0de4d7ac38b` |
| 958 | Donatos Pizza Virginia Beach | `cfdf8948-2b57-4ca2-8ca0-241c4a08410b` |
| 959 | Donatos Pizza Winston-Salem | `ed3a4231-87db-43be-8685-86f7690dcdc3` |
| 960 | Donut House | `868e0308-6eca-4d5a-a0c1-ce600450adea` |
| 961 | Dos Coyotes Border Cafe | `1baccfd6-2ec7-4143-a3a7-c43d299dc0b9` |
| 962 | Dough Bro's | `9705a277-d531-416e-86e0-d8b712ebf04e` |
| 963 | Dough Gourmet Pizza | `8c19b4ca-afde-4408-85cd-a6e4698ae56e` |
| 964 | Doughbird | `db4de93a-6e0e-4241-af70-9a74bab103ac` |
| 965 | Doughbird Phoenix | `3c596e2c-aa4c-4bc3-8ee9-1bea18ef6415` |
| 966 | Doughbird Phoenix | `a9a8127f-e007-4f4a-9b5b-bd025514f348` |
| 967 | Doughboy's Deli | `ad27a546-8fb1-4da8-9e0f-069b65670add` |
| 968 | Doña Mary, Antojitos Mexicanos | `6c7c2433-8635-43fd-a77a-12f16a91335e` |
| 969 | Dragon Express | `e97cfcd3-1ee3-494e-b513-b4fdecc93009` |
| 970 | Dreamland BBQ | `1b298eae-750c-4078-b600-b4ec788ac991` |
| 971 | Dry Rub | `a0ad3bb8-46d3-4471-b19c-4827581457bf` |
| 972 | Duck Donuts | `728c29ca-3b0f-4d78-a9bf-ad1240b7b048` |
| 973 | Duck Donuts Chandler | `c6305091-5077-4656-a1d8-ae39796dadbd` |
| 974 | Duck Donuts Chesapeake | `217975b9-efd5-4491-87d1-a771f7fb89ae` |
| 975 | Duck Donuts Winston-Salem | `85504414-52f5-47dd-87a4-a20b1bec1f3b` |
| 976 | Due’ Cucina Italiana | `c2813497-110e-4927-bb08-262904d7e772` |
| 977 | Dulce Vida Mexican Restaurant | `db512ab6-9999-4ca0-8578-28d71bd8135a` |
| 978 | Duluth Rexall Grill | `130db19e-7980-47a0-a014-afdb44911b65` |
| 979 | Dumpling Capital | `93992a8f-4699-4717-b53d-e367394672fb` |
| 980 | Dumpling Depot | `a9698dd5-9884-4882-8416-d8cdc0be21aa` |
| 981 | Dumpling Garden | `6d3f979c-c0ef-4c72-9e9e-9765cde5699c` |
| 982 | Dumpling Kitchen | `83c83830-a5fb-4a3b-9a0a-f93c8a045925` |
| 983 | Dunkin' | `0ce8d535-93ca-450c-8f4c-2eba4038c0c5` |
| 984 | Dunkin' Fremont | `18d2e9b7-b046-4628-9dd6-85537aa95b6d` |
| 985 | Dunkin' Glendale | `bd6751e1-3c4a-412b-8009-bc9b7c8c501c` |
| 986 | Dunkin' Huntsville | `a93b8b64-e13b-464d-a3b5-541a9bb1f4d1` |
| 987 | Dunkin' Port St. Lucie | `aafff5b7-a4e1-4ca7-be09-3478910c9eb6` |
| 988 | Dunkin' Scottsdale | `d88a0642-8fb9-43a1-9263-3a96a546a540` |
| 989 | Durbar | `ea58a3ee-86c0-4e83-8622-f04f6a263d09` |
| 990 | Durga's OM Cooking  | `59213a70-82cb-4079-9ed5-34ef42b3078d` |
| 991 | Durkin's Pizza | `dcde561a-1011-4322-879a-de89f1400578` |
| 992 | Early Bird Vegan | `0c96948c-9785-44c4-82b4-208b3bacbfb3` |
| 993 | Earlybird Breakfast Burritos | `4e185a1b-ac19-44c6-93d1-372113fb580a` |
| 994 | East Bay Deli | `252f498f-75da-485b-b1e6-0f8795f73fe1` |
| 995 | East Coast Wings + Grill | `bf5666fa-e176-4883-bfa8-554973b0a1ca` |
| 996 | East Hampton Sandwich Co. | `29d2db5b-ef5f-447b-bc67-8e3042e35e85` |
| 997 | East Wall Chinese Cuisine | `a81ba39d-ef35-4535-a150-7b8117181bef` |
| 998 | Easy Slider | `6290ce47-0d03-487c-9dfb-1d788383589b` |
| 999 | Eat 66 | `211df5c0-eed4-4596-9dde-0a5aea46c937` |
| 1000 | Eat Kitchen and Catering | `8650c48e-80d2-489f-aa9f-058d1b461767` |
| 1001 | EAT! Food & Drink | `95cc3968-ee76-48d4-82df-6144e8c28d9e` |
| 1002 | Eating Royally | `7f6b3991-40a8-4067-8d18-0158b5fec828` |
| 1003 | Eats & Sweets | `8631c068-97bb-49f7-b605-31d10ab0a8cc` |
| 1004 | Eatya Pizza | `aef086e3-5112-4785-843b-2569cfa75129` |
| 1005 | eatZi's Market & Bakery | `30eca9d4-ea53-4025-a43e-c0ede14a52f4` |
| 1006 | Eclipse Cookies | `114eee73-1606-4b1b-88fc-36ac4c36ab22` |
| 1007 | Eddie and Anthony's Pizza | `4bface09-7b2b-488f-af91-0b67968353e2` |
| 1008 | EdgeMar Restaurant | `540eba2c-b472-4022-b685-7cac1276e498` |
| 1009 | Edgewater Pizza | `ad071ab0-617b-468e-8d28-0a736622d64e` |
| 1010 | Edible Arrangements | `8602d6e1-b1f2-4b4c-8e12-8efab7d856e7` |
| 1011 | Edible Arrangements Boise | `72121fe6-0ec0-4015-9a9d-3c0c53faef81` |
| 1012 | Edible Arrangements Chesapeake | `ed3de0b7-8172-4d91-808f-881ca1202790` |
| 1013 | Edible Arrangements Dallas | `552fae04-fe58-4244-a0ff-a44ed3d9dfa4` |
| 1014 | Edible Arrangements Norfolk | `32f99dff-2dc2-4c05-95e9-6d3f5782ab00` |
| 1015 | Edible Arrangements Peoria | `0be94f32-ddf1-42a0-9947-8c8173c9ad16` |
| 1016 | Edible Arrangements Port St. Lucie | `5c0dafa8-120b-49bd-afac-599c945b82f2` |
| 1017 | Edible Arrangements Richmond | `495be62e-9251-4a7c-8ecd-b7ecbb7953ad` |
| 1018 | Edible Arrangements Scottsdale | `d6113900-7bb5-4581-9011-ce99c58cb0a2` |
| 1019 | Edible Arrangements Winston-Salem | `d918613a-d514-4422-b2b9-6df1e61dfa75` |
| 1020 | Edible Creations by Gerry/Just Gerry's  | `629daaac-fed4-4ded-8ab0-ad654b7a7144` |
| 1021 | Edmond Burgers and More | `cb9ead1d-95c7-4dc2-9ce7-c4a9b03e2fab` |
| 1022 | Egg N Bird | `5d9ae95a-4a8e-41a3-9012-b8245a951bd2` |
| 1023 | Egg Stand | `ef54ed97-b8da-4a80-bf7f-97f12126041a` |
| 1024 | Eggholic - Veg & Egg Street Food | `129fe061-e114-4a6c-8bf4-9e1b30d8c08d` |
| 1025 | Eggs Up Grill | `a8d70aa0-c2f2-4fe0-8c67-c9d06972f726` |
| 1026 | Eggs Up Grill Bon Air | `2f059da5-9ba6-486d-9d6f-b58416d60c2a` |
| 1027 | Eggs Up Grill Dallas | `10dd701e-d8dc-48e8-81cc-b801fadcbac9` |
| 1028 | Eggs Up Grill Madison | `1d7017c5-6a64-4bce-b3fe-bcf5bf367f6d` |
| 1029 | Eggs Up Grill Norfolk | `afdf42c2-aba7-49d1-bcf7-764841b707ee` |
| 1030 | Eggs Up Grill Winston-Salem | `1a8b4cc0-bafc-43c8-8381-994c5ee48db2` |
| 1031 | Eggspectation | `c23c7bb3-7840-4dc3-8969-ad87ad607685` |
| 1032 | Eighty-Eight Sushi & Ramen | `4409f1b0-c87e-4853-a807-9b02f1901f61` |
| 1033 | Einstein Bros. Bagels Phoenix | `41fc0b7f-a237-4e5a-8a57-3508560391b3` |
| 1034 | Einstein Bros. Bagels Richmond | `a2f3b173-6750-4c2e-9294-942c9296422d` |
| 1035 | Einstein Bros. Bagels Scottsdale | `bf8a9531-5cd7-4e8c-a847-60b3749259ea` |
| 1036 | Eisenhauer’s Catering | `413c2335-08ac-4fc0-9ec5-17a3550980b1` |
| 1037 | El Amigo Burrito | `8dce3de7-c9f7-42d4-a7af-39807f2e898e` |
| 1038 | El Caminito Restaurant | `26a0639b-f20d-4766-8fe5-02ac47f21855` |
| 1039 | El Chico Cafe | `e2fe0030-2508-4c8c-919d-5fd997ac1f4f` |
| 1040 | El Diferente Taqueria | `5a77d534-af9a-4c71-adc3-d9dc91969a4c` |
| 1041 | El Gallo Giro (Boise) | `642daf66-704c-463e-b354-e299ffda975e` |
| 1042 | El Gallo Taqueria | `4c6489e6-dd34-4a47-8552-9136a7e2cc13` |
| 1043 | El Gaucho Catering | `f9c30704-e455-407e-8711-4083a12db5e0` |
| 1044 | El Greco Grill | `10028e01-ee0a-45ca-8bcc-a38fb8188672` |
| 1045 | El Grullo Restaurant | `b2a160bd-5ac0-444b-8e5d-86898eeb8b64` |
| 1046 | El Guayacan Mexican Restaurant | `2d8cbc41-2cc9-490d-96fe-7cb3e5fc50d8` |
| 1047 | El Halal Amigos | `1d6d2317-019e-4cef-bc16-f1f89c6e446f` |
| 1048 | El Jefe Tacos | `f78aeaf7-b56f-4d3f-8a3a-7362ca6fb7f8` |
| 1049 | El Mexsal | `f487f643-1fa2-4824-9c44-eb0f925986b6` |
| 1050 | El Mr. Camaron | `a9293db2-790b-425c-bcef-44daa7a45291` |
| 1051 | El Paisa Taqueria | `a0a58fa8-98d5-4f84-a638-d5c55401a061` |
| 1052 | El Patron Cantina | `b709a3f0-3a2c-4723-b50d-c27218658465` |
| 1053 | El Pollo Guapo | `5cf64cc8-457a-41d7-b7d2-1acdd4e44cb6` |
| 1054 | El Pollo Loco | `51faa3a7-b538-4968-b582-4cf0d8f49258` |
| 1055 | El Pollo Loco Glendale | `72e18dd9-6615-48a0-9b32-9b32470eaace` |
| 1056 | El Pollo Loco Phoenix | `62d90843-a7f7-4ad4-8c7d-337ae01785a4` |
| 1057 | El Pollo Loco Richardson | `cce186f8-c681-4c4e-9317-c47b390b5963` |
| 1058 | El Porton | `40625654-29d3-4964-8ca5-69920b28ed83` |
| 1059 | El Queso Fresh Mexican Grill | `5afccf89-c072-4c2d-a362-2230ea612735` |
| 1060 | El Rey Del Grill | `73309184-686b-4fb8-9d86-a5b1648e8ae6` |
| 1061 | El Rincon Mexican Kitchen | `ef948546-8a5f-4b48-abeb-258d1cc193d1` |
| 1062 | El Taco Tote | `674bd051-15e6-48be-a5c6-f7a42005ec79` |
| 1063 | El Tequileno Family Mexican Restaurant | `877b84eb-f491-4253-9bd3-c9843465875c` |
| 1064 | El Torito | `138069b6-02dd-4844-a5f9-1d7380b97fa6` |
| 1065 | El Xolo Tacos | `c8a5da61-15cc-4ea0-88ae-34061509270b` |
| 1066 | Elena's Taqueria | `f9709f5e-d356-4fc5-82a8-0c10298e6010` |
| 1067 | Elizabeth's Italian Restaurant & Pizzeria | `20e2f01e-649d-400e-999c-469f880028e1` |
| 1068 | Ellen's | `b166793f-8dfd-4b98-ba65-ed2b99baece2` |
| 1069 | Ellis Creek Fish Camp | `26de03eb-4043-4499-a761-04f3a3b3cea5` |
| 1070 | Eloisa's Kitchen | `2210e842-73ee-433c-a7c4-f2019d77adf3` |
| 1071 | Ember Smoked BBQ | `962546e1-0de2-4462-a521-fd8ef1b1cb47` |
| 1072 | Emelina Peruvian Restaurant | `ca66c526-768c-4f4b-9c76-da5e87fa6cc2` |
| 1073 | EmpaMamma's Signature Recipes | `108bf233-c59c-4220-ad3f-29437110ed83` |
| 1074 | Empanada Grill | `1d749683-eb66-4d52-9146-336f807cea50` |
| 1075 | Empire Asian Bistro | `90cb1c1a-d830-4652-8bce-5f9f52f4a535` |
| 1076 | Enchiladas Restaurant | `375c7b72-d5f2-4154-a4cf-6f53f51d2696` |
| 1077 | Eno's Pizza Tavern | `e713deb6-842b-470a-a2a0-097338ea61e0` |
| 1078 | Ephesus Bistro & Grill | `4664b2fe-7a0e-4dc4-a2da-426270fbd78c` |
| 1079 | Ephesus Mediterranean Grill | `efe6c5b8-0c9c-4866-89f8-c02f87298e75` |
| 1080 | Erik's DeliCafe | `03ca7bdb-4393-4ef6-acdb-9ca5cc7fece9` |
| 1081 | Espumoso Caffe | `07ba52d6-79a4-48f3-a1e9-4ec2df7fdb4e` |
| 1082 | Estilo Azteca | `be513a39-49f1-4db4-b94e-abc328ab2d53` |
| 1083 | Estrellita Restaurant | `95600c66-d5b4-4a02-90f0-fb3dd3fb458f` |
| 1084 | et al fine food & events | `0e42632d-ecef-4908-9b13-cb4b8317d6ca` |
| 1085 | Eureka! | `ea6930ee-fe65-4229-a6e6-f749109948e9` |
| 1086 | Eureka! Boise | `9727764d-9fd5-4a63-a38d-2bc5368f1fe3` |
| 1087 | Eureka! Tempe | `27911351-709c-4fb3-8611-d6a2680dfc93` |
| 1088 | Everbowl | `682a5727-37cc-490e-818d-40b264c2b00a` |
| 1089 | Everbowl Dallas | `a4c59a09-00fe-4031-b91e-81bf54a4848f` |
| 1090 | Everbowl Tempe | `22b2d2bd-9dc9-4b4e-8a95-6af2b051ca75` |
| 1091 | Everyday Gourmet RVA | `e58c7d05-0b0c-41ac-a957-01273dce2896` |
| 1092 | Executive One Catering | `a3cdd40a-3e4d-4659-a3f3-36b5817e9c7f` |
| 1093 | Experience Burma | `5f4fc1b8-1c4d-4b31-bad0-b22a51984583` |
| 1094 | Express India | `8cb2a0ab-12b2-4427-9f53-3cbdbca3706b` |
| 1095 | Extra Ordinary Events & Catering | `f9336170-e454-4fa3-9e77-1cf65870f18a` |
| 1096 | Extreme Pizza | `622fa6dc-da1a-439f-ac1c-dce271ba611a` |
| 1097 | F&F Japanese Grill | `53c23d1b-740a-421c-a582-fe4d968a3394` |
| 1098 | Fabio On Fire | `209e0e5a-8b75-4fa1-b3ef-0bd940ebe732` |
| 1099 | Fadi's Mediterranean Grill | `eaa5593c-0823-4ecf-b50b-1c484b5a53be` |
| 1100 | Fajita Pete's | `b50eaf4d-a5ec-4068-84c0-122ec4f04394` |
| 1101 | Falafel King | `1a5048b5-37a6-4b92-be6e-6e0bcf4c72fd` |
| 1102 | Falafel Tazah | `eb0e1331-1efd-49ea-8d01-e69556f1ed3d` |
| 1103 | Falafel, etc. | `9d39f688-a23a-4929-8a6e-32fdb45a6207` |
| 1104 | Family's Favorite Foods | `c6bb98d5-5711-4e4e-b02f-1860a71da3fd` |
| 1105 | Famous Dave's BBQ | `8928b0bf-7910-4a56-9d01-e61d222cd80e` |
| 1106 | Famous Dave's BBQ Meridian | `a5056502-0746-4b66-9702-51505b016f64` |
| 1107 | Famous Dave's BBQ Mesa | `45c9c999-1056-4404-bc15-7ac756d25a2f` |
| 1108 | Famous Dave's BBQ Peoria | `57fce172-402c-4437-be10-b29c492d854e` |
| 1109 | Famous Toastery | `d3988593-69e7-4b69-ad5d-706412a5a1d6` |
| 1110 | Far East Pizza | `d4004e9c-32d1-416a-a7b3-edc894520d14` |
| 1111 | Farm Burger | `3cb6018f-c522-4f42-be1c-cc73c7dc33a3` |
| 1112 | Farm Fresh | `858bf29d-0120-4dd7-b188-734e024deff8` |
| 1113 | Farmer Boys | `71fe7b7b-d1ca-401f-8888-22273507dbbd` |
| 1114 | Farmhouse Catering | `72626101-4195-44fc-aa08-a81f554a799a` |
| 1115 | Fast Bagel - Somerset | `3ec83e2d-7520-4e46-8e4d-85e676933091` |
| 1116 | Fast Bagel – Woodbridge | `08b4c9f2-82c5-4d01-8446-ca99fce63eaa` |
| 1117 | Fat Straws | `55ebbc8c-98d1-4404-9fae-ab8928343c18` |
| 1118 | Fat Tony's | `b9c72fbd-fc91-4ef0-b305-4a429b30205c` |
| 1119 | Federal Pizza | `6121e1ad-f81b-4f4a-b8d5-eead6ddcd66a` |
| 1120 | Feed Co. Burgers | `fe5cd535-f3ad-4b5d-b7e6-bfc1f8afd9ab` |
| 1121 | Fellow Osteria | `79e4fcae-0096-45e7-965b-f65be6658b42` |
| 1122 | Ferah Tex-Med Kitchen | `61f41300-b2b2-4ed7-931a-b9a837dea66e` |
| 1123 | Ferrante's Marketplace Cafe | `fa72fa32-1966-44f5-b074-2f4ec2dd3281` |
| 1124 | Ferris Wheelers Backyard & BBQ | `4c3bb67c-d044-4866-823d-3f492bb8503c` |
| 1125 | Fields Good Chicken - 40th & Mad | `3810a300-7218-435b-84a6-d2fb6043d4cd` |
| 1126 | Fields Good Chicken - 52nd & Lex | `6b2e8b4c-d04f-467c-8437-da34912451ad` |
| 1127 | Fiero Mexican Grill | `436a8471-cdea-45da-814a-31683e48bd5d` |
| 1128 | Fiery Hot Nashville Chicken | `14636276-669f-4e89-9abb-4de493b60653` |
| 1129 | FiGaMi Asian Fresh | `fd61368b-6633-4d00-ab73-50c586d5e53b` |
| 1130 | Fire & Chicken | `cef1dd2d-0fe7-457a-b923-11aff32f1251` |
| 1131 | Fire Island Grill - Simi Valley | `07faf5d8-c01e-49c5-9c51-929597dba15b` |
| 1132 | Firebirds Wood Fired Grill | `8f28ee3f-ede2-436d-81c7-721b66679ea4` |
| 1133 | Firebirds Wood Fired Grill Chandler | `8c924d8d-5a53-4e25-afc4-5e0c4af41f60` |
| 1134 | Firebirds Wood Fired Grill Peoria | `11fa50cf-40fb-416c-9eae-e0bd419707f7` |
| 1135 | Firebirds Wood Fired Grill Plano | `4db20340-38a6-4a3c-86d9-7cdcb3067e34` |
| 1136 | Firebirds Wood Fired Grill Winston-Salem | `1c438a37-0876-49e4-ba40-17a83dd688c4` |
| 1137 | Fired Pie | `b851c05f-fc5f-4de7-b7ea-9c896279c2a5` |
| 1138 | Fired Pie Phoenix | `5449c2c3-8615-442c-a440-6ef8ddfa49b8` |
| 1139 | Firehouse Subs | `35feea8a-026e-498f-9ab3-73d0f1051791` |
| 1140 | Firehouse Subs Chesapeake | `bd990d4f-7342-4310-b1f4-7f6c33297368` |
| 1141 | Firehouse Subs Fremont | `97ce0a2f-4456-4d92-87da-344730d9e3b9` |
| 1142 | Firehouse Subs Garland | `dbfbe231-0f7d-4202-9858-bbaf1ed08952` |
| 1143 | Firehouse Subs Glendale | `373706fb-67eb-4e23-8dec-e1928e55523c` |
| 1144 | Firehouse Subs Huntsville | `0a25caa4-b467-488a-b197-94638c5594f1` |
| 1145 | Firehouse Subs Meridian | `81233c95-99bf-4a90-b879-d2cdf87a7374` |
| 1146 | Firehouse Subs Norfolk | `841bbc60-29d6-41a2-bc48-f498f3f00b68` |
| 1147 | Firehouse Subs Phoenix | `2e14aca8-0e68-4758-a009-8b132b38af9b` |
| 1148 | Firehouse Subs Richmond | `910e0f08-ab2d-4fae-b1c1-a88829c839fe` |
| 1149 | Firehouse Subs Stuart | `57e14dc3-eedb-4d97-ba42-92a1454855fb` |
| 1150 | Firehouse Subs Westbrook | `8b7d380a-d9ef-4b03-8943-9db279d0770a` |
| 1151 | Firehouse Subs Winston-Salem | `3aa0c3fb-d23f-4a72-99c5-fdc62161a246` |
| 1152 | Firenze: Italian Street Food | `5c538f30-edce-4820-9c85-007b9e1095ee` |
| 1153 | Fireside Chicken and Tacos | `9aabc63b-67e4-45bd-8e13-17371268896f` |
| 1154 | Fish's Wild | `31fe6ee7-3989-4bd1-86e6-622b28694a93` |
| 1155 | Fishtail Cuisine of India and Nepal | `97f1714e-cb28-46d0-be8d-30da472b68f8` |
| 1156 | Fit Factory Grill and Smoothies | `690777fc-8511-4de7-a26b-8824ac57e2a9` |
| 1157 | Fitzy's Old Fashioned Diner | `3215a279-cb24-40c1-9fb8-8e442e738846` |
| 1158 | Five Guys Burgers and Fries | `f6f1c06d-bd39-4140-ba09-ff694e47468f` |
| 1159 | Five Guys Burgers and Fries Huntsville | `2b8e3c92-9380-472f-8ef3-4d019deec779` |
| 1160 | Five Guys Burgers and Fries South Portland | `4440dde9-53b0-4a45-93df-4d2de3ba950a` |
| 1161 | Five Loaves Cafe | `4a62e6e7-d6a5-4b8c-bc9c-8323f038b216` |
| 1162 | Flame Broiler | `7c514ecc-b7c3-476d-8e18-a8d679bea1ab` |
| 1163 | Flaming Grill Barbecue | `56d22f10-42f8-47ee-be4c-179c4ad78c6d` |
| 1164 | Flaming Kabob Cuisine | `1513c378-de2b-4349-937b-dfd5bbac66e8` |
| 1165 | Flancers | `60cc5167-a64e-425c-af44-0447e713d2cd` |
| 1166 | Flava Meal Prep | `6ecb03ba-351f-4f6f-b7a2-790dc571d081` |
| 1167 | Fleming's Prime Steakhouse & Wine Bar | `db4bbe51-6dfd-4c69-9ee5-e5096a19a1e9` |
| 1168 | Fleming's Prime Steakhouse & Wine Bar Peoria | `920bc256-e833-4dfa-a127-23f9f09bbb0b` |
| 1169 | Fleming's Prime Steakhouse & Wine Bar Plano | `24a2f265-6e4f-4b7a-b349-993178cafe7d` |
| 1170 | Fleming's Prime Steakhouse & Wine Bar Scottsdale | `d851a7b7-6cba-48c3-9c26-42715f790ef4` |
| 1171 | Flippers Pizzeria- SoDo | `a3101f6d-8608-4f00-b511-37bc507f3b5b` |
| 1172 | Flora Cantina | `7a9df318-a83a-4df9-b594-a91944ed7e85` |
| 1173 | Florentina’s Italian Bistro | `1cfe3120-d57d-48d8-a1af-68dabb040232` |
| 1174 | Floridino's Pizza | `11990da8-af7c-4e50-81bd-59e1b0ae1227` |
| 1175 | Flower Child | `5e582350-63fd-408c-a28f-a27ce1a25cb2` |
| 1176 | Flower Child Dallas | `d286ced6-725a-4253-9508-2390cdf8bc5f` |
| 1177 | Flower Child Phoenix | `ccefdec8-ca17-4bb5-9d14-8efbb7725561` |
| 1178 | Flower Child Phoenix | `fa992f09-7b2e-4550-80e8-1eb5c8264f8a` |
| 1179 | Fly Bye | `bec43b80-c176-4467-b838-d701ccf375dd` |
| 1180 | Flyfuel Food Co | `a83ab4a3-b476-4853-bd15-f3fdcf14db29` |
| 1181 | Flying Fish | `646e5ea7-2420-4b48-88aa-2776e328919b` |
| 1182 | Flying Saucer | `882e9e4d-bda2-4b49-8db8-f29655031eda` |
| 1183 | Foch Cafe & Bistro | `ce6bacb9-4ab3-46eb-b8fd-864170ca63fd` |
| 1184 | Fogo de Chão | `c63e6071-8212-4f58-bd01-9186404098cf` |
| 1185 | Fogo de Chão Dallas | `5b166853-1548-42c7-b7ff-ea03f5c92e62` |
| 1186 | Fogo de Chão Scottsdale | `0dcb46b5-a2fb-44d7-b4d6-4291342ed015` |
| 1187 | Foley Ranch Boots & BBQ | `45a71d5f-6c09-44df-bc99-bf57df6959e8` |
| 1188 | Food Passion Dallas | `1cea08f0-ab4c-4bfd-85a5-f30cbe31c560` |
| 1189 | Foodies - The Local's Market | `5e9fae2b-3382-48fd-8c1c-1e3be6af243e` |
| 1190 | Foraged Restaurant | `995cac19-cac3-466a-923f-0653ca2daeff` |
| 1191 | Ford's Garage | `b5122483-20c4-4e08-b7ff-732470234367` |
| 1192 | Forefathers | `29b8ac61-2c4f-46bf-825e-0bbe673803b9` |
| 1193 | Forever Pho | `9880260d-5710-4b66-aa16-1f1793f2ee36` |
| 1194 | Forsyth Seafood Market & Cafe | `5ef46942-b244-4f3a-b0d3-a172a3129fca` |
| 1195 | Forum Cafe | `e4d97724-13dd-4461-85aa-6f247391121c` |
| 1196 | Fox & Hound | `ded871ad-d4f1-41d9-b9ac-f4718b50ca49` |
| 1197 | Francesca Catering - Glen Rock - NEW | `35517041-ee5a-4209-9c45-033bec370472` |
| 1198 | Franco's Italian Restaurant Henrico | `50f4bea9-2573-4948-9e89-ec7d360fc318` |
| 1199 | Frank & Furter’s Handcrafted Hot Dogs | `7eae05d5-f8f5-460b-bbad-e756659ba624` |
| 1200 | Frankie's Downtown | `a57dcdbb-ddb5-4c47-a3e7-fc24b76ba0f9` |
| 1201 | Fratello Pizza & Doner Kebab | `ba634167-bc7b-4478-9452-570d5ec3c7c9` |
| 1202 | Freddie Parker's Pasta & Salad Shop | `cbc5965c-f549-4949-9793-e15a96e4fb1a` |
| 1203 | Freddy's Frozen Custard & Steakburgers | `2db8c107-2533-4cd8-a7a9-2227848526dd` |
| 1204 | Freddy's Frozen Custard & Steakburgers Boise | `9736b59a-d43a-423c-8785-1e5ba5009c03` |
| 1205 | Freddy's Frozen Custard & Steakburgers Chesapeake | `a819fe11-577f-416b-9b41-fe35717dc17a` |
| 1206 | Freddy's Frozen Custard & Steakburgers Glendale | `84512f81-36f8-4080-9227-eeccf025a90d` |
| 1207 | Freddy's Frozen Custard & Steakburgers High Point | `463565e4-bd0f-4c4b-b35f-aeed3d920438` |
| 1208 | Freddy's Frozen Custard & Steakburgers Madison | `e74f0e94-12d8-4ba4-a678-0c15842ac112` |
| 1209 | Freddy's Frozen Custard & Steakburgers Tempe | `e9f2e755-ac14-4912-9c8c-cf9988e2770b` |
| 1210 | Freddy's Frozen Custard & Steakburgers Wylie | `fb395ed5-634e-4be0-a306-b044f8e512e6` |
| 1211 | Fremont Kabob | `d317cbb3-99b4-4125-9350-7d2c467b5ebe` |
| 1212 | Fresh Deli Catering | `f10c27f0-370b-4916-b676-956075cc6eac` |
| 1213 | Fresh Gluten Free Cafe | `fa6e0b2b-8dc1-4e97-804d-355be3c461e6` |
| 1214 | Fresh Millions Restaurant | `d038266a-b9ea-46a1-b0c6-c2cd4f9a8fd4` |
| 1215 | Fresh Thyme | `e7cfeb75-5a1d-47c4-83d7-0cec52a16296` |
| 1216 | fresh&co catering | `238a1921-f3bf-4d86-b1fe-94e466916894` |
| 1217 | FreshFin - East Side MKE | `3bb2a88b-c0e9-4590-a563-881904950816` |
| 1218 | Freshnez | `a50b8c6a-5d3d-46e3-b489-d21879c6ed3c` |
| 1219 | Friendly's | `1e92e92f-7b7f-4c9d-839b-6b7ac382a54d` |
| 1220 | Frios Gourmet Pops | `8c2af61e-f0a0-4d60-a1c4-082c41f36498` |
| 1221 | Frios Gourmet Pops Buckeye | `22fae5be-349e-4328-94ed-00bf9ea8ef8e` |
| 1222 | Frost Cupcake Factory | `0b7d911f-b53c-4e8d-8779-6d5079255096` |
| 1223 | FruitBowl | `25ae3c9c-c711-452c-8b29-7dec5df0ce3f` |
| 1224 | Frutilandia | `469c4991-5103-4abc-9671-08cade037ccd` |
| 1225 | Frutta Bowls | `67326c09-afd3-4df3-9617-338c611c8d9c` |
| 1226 | Frutta Bowls Mesa | `32130d86-f3f9-46cc-a429-d426251c6cea` |
| 1227 | Frutta Bowls Virginia Beach | `f4532aa1-edd4-408e-b273-da12ff2f6e74` |
| 1228 | Fry Daddys | `76fd7905-9336-4d3c-a1bb-b7c0f6233552` |
| 1229 | FS Fruit Arrangements & Snacks | `0819a1fb-160a-46e0-86f1-c6c1491cb3e4` |
| 1230 | Fuddruckers | `f0502ed7-bd36-43f2-b278-05ef94220478` |
| 1231 | Fuel Charleston | `4a6fa1e4-cd13-4d6f-a3d4-44129eb56c7d` |
| 1232 | Fujiyama | `37698bbe-73eb-44e9-861e-89ee50d8b651` |
| 1233 | Fujiyama Sushi & Yakitori Bar | `e3064ad9-c929-4347-937d-2c31d84101c0` |
| 1234 | Fuku | `38716ced-8956-47b5-9095-80c340a4f521` |
| 1235 | Full Moon BBQ | `0860b20a-9229-4614-8c8d-2933ec25d46b` |
| 1236 | Furlough Brothers | `7fe1cbf4-6dfe-4489-bf6f-60b879a66f25` |
| 1237 | Fusion Mediterranean Grill | `25bd67d4-9b1c-4c61-b6b1-6da98aff2d34` |
| 1238 | Fuzzy's Taco Shop | `05e39787-35f3-4cf8-bd28-704de72e0c22` |
| 1239 | Fuzzy's Taco Shop Gilbert | `4e38d846-9a63-48e6-b1b9-10d82b00d2fd` |
| 1240 | Fysh Bar & Grill | `8647271b-37b5-45e3-afca-7ba897392be7` |
| 1241 | Gaia Masala & Burger | `773d29e5-6cbf-40cd-80e2-be36b0d6d46f` |
| 1242 | Galeto Brazilian Steakhouse | `b6326916-7e5a-4029-a4a8-8a73c05ccd3e` |
| 1243 | Gallo Nero Italian Bistro | `bd8f5421-d405-4d09-ad91-1ef90359b352` |
| 1244 | Garbanzo Mediterranean Fresh | `3cdc52f3-cd27-4aa1-9c86-c18d1dddf986` |
| 1245 | Garbanzo Mediterranean Fresh Chesapeake | `2ec3dc60-7dbe-47f1-ae71-9328766ea133` |
| 1246 | Garcia's Mexican Restaurant | `93218914-83d6-4086-8aa3-b56cc7de5220` |
| 1247 | Gaston's Bakeshop | `9ae72f1a-5162-4f4f-a738-7606dea0f454` |
| 1248 | Gaters Restaurant | `55643d3e-9cc3-48cd-8202-7b0be65aed4b` |
| 1249 | Gatti's Pizza | `3e5c80be-0d49-4a1d-9125-b378494658b9` |
| 1250 | Gayton Pizza & Wings | `8ed8f713-7114-42e2-b293-0bd9db7b994b` |
| 1251 | Gecko Grill | `3e59944f-44b7-4679-9773-3a9429ad5242` |
| 1252 | Gelati Celesti | `a20b153d-19fd-446d-ab64-c4854223d48d` |
| 1253 | Gelato La Boca | `ec2359be-6ad7-45eb-b128-11374ac9f723` |
| 1254 | Gelato Spot | `073fc7db-7595-4e2c-b26f-9f9ff3accb7f` |
| 1255 | Genghis Grill | `c77e3752-af1c-4297-bedd-9794cfdcdd9e` |
| 1256 | Genghis Grill - Lake Worth | `544f393c-1d4b-4a7d-926b-cd57b820dc89` |
| 1257 | Genghis Grill Mesquite | `9baefc14-06a6-4cfe-9189-a41c38b4f888` |
| 1258 | Geno's Pizza & Pub | `fdab0de1-18bf-4597-847c-bd5b8b24ad4d` |
| 1259 | Ghett Yo Wings | `9e551478-8429-4f8b-809a-b01f86405140` |
| 1260 | Ghett' Yo' Taco | `362b6fbe-cad9-4278-9b92-acbed041fa0f` |
| 1261 | Ghuma Ghumalu | `86bb41d5-2248-447d-a016-5fd668edb185` |
| 1262 | Ginger Juice Co. | `7bec2d40-6433-4678-9497-a1b949766d67` |
| 1263 | Ginger's | `06301360-d23e-4c33-9443-43f92ff4a221` |
| 1264 | Gio's Pizza | `f5c6450a-3ab5-425b-b594-67257fe2442c` |
| 1265 | Giordano's | `0138e3cc-d7c8-4f7a-8707-809d33ec0d34` |
| 1266 | Global Fusion RVA | `a942c9fa-b29f-4d16-bab2-836555e82bb7` |
| 1267 | Glory Days Grill | `4aeaf264-72b5-4b8a-bc04-0228e9b26aaa` |
| 1268 | Go Fish Poke | `b2c6eddd-42c3-4fc1-aa8d-5531f1dff0fc` |
| 1269 | Go Gourmet Catering | `7f5da87d-3ea7-4f2e-8bcb-d85f861dc381` |
| 1270 | Godfather's Pizza | `529ba323-ff6c-489e-94a1-a567f0529613` |
| 1271 | GoGogiri | `1f9ca763-07f0-44e0-a8bb-a3c190ad3565` |
| 1272 | Gold Chef | `307be297-9401-42c8-8746-70e4695d4c38` |
| 1273 | Gold Rush Eatery | `9edcd49c-4ad6-45b4-97c2-2df1344042f6` |
| 1274 | Golden 9th Deli | `e065b6de-b69d-4a07-adac-356bd13881f0` |
| 1275 | Golden Bay Seafood Harbor | `41e1a2cd-cded-4079-9f59-0e1415363451` |
| 1276 | Golden Chick | `7558cbfa-5c88-4568-92d5-b5ea7a1d4719` |
| 1277 | Golden Corral | `4a0de680-aab6-4a98-b9ad-e1a439a4ed60` |
| 1278 | Golden Goat Mac & Cheese | `8182b372-eab4-4e74-8498-788db0101d0b` |
| 1279 | Golden Harvest Catering | `bd8240a1-4627-4b90-b389-420f2fb7c3cd` |
| 1280 | Golden Palace | `d604134c-c5f8-4465-998c-e42ab9f49657` |
| 1281 | Golden Sun Chinese Restaurant | `9a9e9975-13b0-450c-9bfc-665569521051` |
| 1282 | Gong Cha | `0624eb20-3a8f-40bd-8d31-f95884bef169` |
| 1283 | Goodcents Deli Fresh Subs | `6b60bd65-7a2c-4cc0-87d4-5eccf6cfc382` |
| 1284 | Goodfellas Woodfired Pizza Pasta Vino | `5f0af3fa-6d43-4864-9f5a-06b9bb9d054c` |
| 1285 | Goodland Pour House | `8502950d-3f65-4a40-8c48-e11d837d555b` |
| 1286 | Goodrich Gourmet Delivered | `c660e09b-9ac9-4fe2-a850-bd449bdc207e` |
| 1287 | Goodrich Gourmet Delivered Virginia Beach | `6dc29dfc-14c9-429d-9cd0-c4dbc7af0d92` |
| 1288 | Goodwins | `6022501e-0e42-46ce-948a-fbe0cf45a98f` |
| 1289 | Gorditas Mexican Catering | `5cd1e3da-8355-460e-a164-f7f8de87df1b` |
| 1290 | Gordon Biersch | `89086014-ec0f-4622-863d-f8df57befa44` |
| 1291 | Gordos Tacos | `e7b212f6-5c54-4a01-a591-c9a17bca9fab` |
| 1292 | Gordos Tacos Scottsdale | `c5ee2c35-30f7-4d19-8601-9a2bc9ac708f` |
| 1293 | Got Dumplings | `23b5224b-07e1-46c7-aabb-7157de037424` |
| 1294 | Gotta Eatta Pita | `b6404c0f-4e3e-49f0-b7f6-b2dbd4affba3` |
| 1295 | Grace Deli & Cafe | `a60e7de3-c88f-4cf6-b47b-6f32de941f21` |
| 1296 | Grain and Berry | `327ce8fb-587e-4e06-b9cf-69a6dbf15c69` |
| 1297 | Granby Bistro & Deli | `3fbbea40-c86c-4f3c-a88b-f82fac1ea1a2` |
| 1298 | Granby Waffle Shop | `d8141811-eb9d-4695-8dae-589235e6fc0f` |
| 1299 | Graze Cafe and Catering | `c43fcbd8-3c00-4886-9f7e-b2160372a395` |
| 1300 | Graze Craze Charcuterie Boards and Boxes | `5ad772b9-06e2-4c64-a089-214c19a03875` |
| 1301 | Graze Craze Charcuterie Boards and Boxes Phoenix | `221e91d1-c3d3-48fd-aabe-b10e6bb9839b` |
| 1302 | Graze Craze Charcuterie Boards and Boxes Plano | `687ccae5-8205-4ecf-b0e8-8c3e89a031ec` |
| 1303 | Great American Cookies | `5cf93539-0992-4691-972d-cf4699214c24` |
| 1304 | Great American Cookies Huntsville | `71209196-f950-45ea-adbf-02c4fbc834cd` |
| 1305 | Great Harvest Bread Co | `065b8511-bfed-4cb4-9e6f-3d2293e12a1b` |
| 1306 | Great Harvest Bread Co Bend | `bb218a02-f295-4654-b2fc-aeffe383f057` |
| 1307 | Great Harvest Bread Co Boise | `7cbe5c10-e350-4f5b-acd9-e11470d31cb6` |
| 1308 | Great Harvest Bread Co Huntsville | `217d4351-31b8-4d4c-b37c-0bdc14214ace` |
| 1309 | Great Harvest Bread Co North Charleston | `253fb12e-7009-43ff-bf80-1683986ad58b` |
| 1310 | Great Harvest Bread Co Spokane | `ddaddc95-fcf2-41e4-a6ec-b30dc013630d` |
| 1311 | Great Harvest Bread Co Tempe | `22baec8d-30f1-43d3-a53f-899604f2c488` |
| 1312 | Great Indian Cuisine | `db8e7050-acc9-4e32-b5b9-3870e1d19c2f` |
| 1313 | Great One Cookie Company | `e2143b66-07e2-4199-8333-fa44efa7a12b` |
| 1314 | Great Papas Gyro | `a15de15f-7e93-487d-bc43-bc6e710dc509` |
| 1315 | Great Steak | `bd36aa0f-ee38-4684-b50c-77bb7df048e8` |
| 1316 | Great Steak Glendale | `9604bad6-c271-4aab-af15-43f2ebe74bc5` |
| 1317 | Great Wraps | `9fdf8430-91ab-498b-8137-608b39afad6e` |
| 1318 | Greedy's Burgers | `22613875-e7c7-4dd9-bdc3-ecb860d2e0c8` |
| 1319 | Greek Isles Grille and Taverna | `0408656a-3b32-4875-be06-46328f288c95` |
| 1320 | Greek On Cary | `28b7998a-32b2-4351-9a7f-ee2c6be0ec80` |
| 1321 | Green Apple Truly Healthy | `a63ad20d-70e5-4481-8e4e-822cb3a6ed4e` |
| 1322 | Green Chile Love | `0cde0593-a456-4c8c-a6a7-6362ed339116` |
| 1323 | Green Leaf's | `cabfd056-39c3-4b2c-84bb-50010d13980c` |
| 1324 | Green Leaf's Chandler | `7061f0bb-7651-4932-9dd8-43e35c48dfe9` |
| 1325 | Green Thai Bistro | `a2c066ce-21e2-4218-99aa-eede41269778` |
| 1326 | Greens N Grills | `6a5d0f79-c26d-416d-9796-c579c4dc788d` |
| 1327 | Greenville Avenue Pizza Company | `62402853-932f-4f43-8ae8-243e65c20f2e` |
| 1328 | GREGORIO'S TRATTORIA - BETHESDA | `1319389f-f7f4-4a2f-bebe-461665fb1506` |
| 1329 | GREGORIO'S TRATTORIA - POTOMAC | `f1d05c05-4573-45e7-aedf-3ec63a07b64a` |
| 1330 | GREGORIO'S TRATTORIA - RESTON | `863ce24f-55d1-444d-98c1-7235e4dafd31` |
| 1331 | Greystone Cafe, Bakery, and Provisions | `6dd7eef2-17ad-4226-bfba-b4953bd97aff` |
| 1332 | Griffy’s Organics - Long Branch | `e2813ec4-56fa-401c-a2c9-73685437bf34` |
| 1333 | Griffy’s Organics – Asbury Park, NJ | `92abbcae-716a-47ef-bb22-72415d0c6b70` |
| 1334 | Griffy’s Organics – Colts Neck, NJ | `78a16781-e84f-461f-84ff-878e557d8769` |
| 1335 | Griffy’s Organics – Red Bank, NJ | `a4c07b5e-0fba-414e-9078-3600228af5ae` |
| 1336 | Grist & Grind Bakery | `c6bfd9b2-79a8-4583-ab4f-567eda57eea6` |
| 1337 | Groucho's Deli | `44b2ff49-b262-4582-94b5-16a4fec0c403` |
| 1338 | gtk | `660f3954-032b-4e1b-8b4b-b1bf57703234` |
| 1339 | Guapas Mexican Grill | `6b36a177-cdd8-4d4b-8608-6469a10fcfa2` |
| 1340 | Gundruk Taste of Nepal and India | `79db74c2-2979-40a9-ad0b-3c390f9509c5` |
| 1341 | Gus's New York Pizza | `0a38bc05-3bdc-495b-a0e8-963d246eb1dc` |
| 1342 | Gus's World Famous Fried Chicken | `6d212099-252b-4464-8356-1bca92c1e8f4` |
| 1343 | Gus's World Famous Fried Chicken Phoenix | `09f564df-7660-46db-bf9d-92ebd3c0de9d` |
| 1344 | Gyro 101 | `ec98ed7c-e5f3-485e-aeb2-f6c7976d6012` |
| 1345 | Gyro House 32 | `cfd3b8ad-e0a4-4dbb-878b-713dc7b6b237` |
| 1346 | Gyro Wrap | `7d925276-31b0-4ffd-bb36-2e707be76d11` |
| 1347 | Gyros Express | `72bd0af4-c09e-45c4-abbe-96a3e0a7c5d8` |
| 1348 | Gyros Palace | `83928605-f60c-46d1-97bf-37dc46470db7` |
| 1349 | Gyros Plus | `b8dbb061-05d2-4c14-afa6-b762c710e5f2` |
| 1350 | Habit Burger & Grill | `74aa5139-a16d-462d-904f-2dae13423e95` |
| 1351 | Habit Burger & Grill Chesterfield County | `0d2387fe-1d8b-4979-ab84-f63145c0e31d` |
| 1352 | Habit Burger & Grill Meridian | `8a8341db-d5a1-4fd9-bfe9-4c42df3c7c7f` |
| 1353 | Habit Burger & Grill Phoenix | `d0b57c8c-2e43-4b4a-b73f-097f1216043e` |
| 1354 | Habit Burger & Grill Phoenix | `60b880e4-92b5-4754-8ed7-6f08ef12e9e2` |
| 1355 | Habit Burger & Grill Virginia Beach | `d4ba86a9-bcd4-4cd2-9d66-610fa397be2c` |
| 1356 | Hadramout Restaurant | `7d965405-7a99-49c0-8641-e739eca3043d` |
| 1357 | Halal Fusionz | `214a9c89-deb8-4cae-80fc-cbc9a2dfac26` |
| 1358 | Halal Mother Truckers | `a4fa6fba-5d77-43ca-8cab-839d687f1fde` |
| 1359 | Haldi Indian Cuisine | `57ab24ee-03f5-42ba-98c9-e5856c175716` |
| 1360 | Haldi Indian Cuisine Surprise | `d906e847-df42-4708-b366-f88daa1c2144` |
| 1361 | Hana House | `0664dc65-7f82-4649-b05e-a9a6768a05cb` |
| 1362 | Handel's Homemade Ice Cream | `406ba16d-efa3-4764-9220-67320185b651` |
| 1363 | Handel's Homemade Ice Cream Tempe | `a3fdc048-a2f2-4689-9c5c-4fd5d78ff96f` |
| 1364 | Hang 10 Hawaiian BBQ | `32525b09-61da-4777-958a-967ddcf668a4` |
| 1365 | Hap's Pit Barbecue | `9cc5f20f-c20d-4d8d-8b19-00d20bec808a` |
| 1366 | Hapa Sushi Grill | `66907bb9-97b1-48b3-b88e-6299d0b1ed97` |
| 1367 | Happy Chicks | `3f148c00-11f8-4f24-abd4-bd50f1996e37` |
| 1368 | Happy Kitchen Chinese Restaurant | `bf323b9e-eae6-4603-8379-bd1fc9ef5f95` |
| 1369 | Happy Teriyaki | `421361b2-2cf9-4af6-97b5-f35551a286b2` |
| 1370 | Happy's Pizza - Battle Creek | `919a1c90-5522-47eb-bf22-e07ebf9811b6` |
| 1371 | Happy's Pizza - Belleville | `53ce20b9-67af-4808-8d8e-552532745594` |
| 1372 | Happy's Pizza - Chesterfield | `2e36f407-5d2d-4f01-94cc-3679e74a706f` |
| 1373 | Happy's Pizza - Cincinnati | `4dca0752-51a9-43f6-b540-f8b9286ba73d` |
| 1374 | Happy's Pizza - Columbus | `667d28f7-2966-40e2-9bfe-dca495cb5fc3` |
| 1375 | Happy's Pizza - Commerce | `790231df-d435-4e5a-9a7b-068850428fbf` |
| 1376 | Happy's Pizza - Dayton | `1b9dfc76-b9e0-4f9b-a23e-b91ce7ae86f4` |
| 1377 | Happy's Pizza - Dearborn Heights | `99d12eca-dc54-4650-bb33-36b5ff786970` |
| 1378 | Happy's Pizza - Detroit (Store 003) | `8471b87e-145f-4942-9d6f-2bd79fa269ee` |
| 1379 | Happy's Pizza - Detroit (Store 004)  | `412dd855-9f41-4726-887c-4cdcd4c5bd44` |
| 1380 | Happy's Pizza - Detroit (Store 005) | `5f33098b-da0b-46ce-8e02-7171264c310e` |
| 1381 | Happy's Pizza - Detroit (Store 006) | `e19b97fd-3f89-4c2e-ba7a-9fe7250f6fbb` |
| 1382 | Happy's Pizza - Detroit (Store 009) | `fe3355f6-a980-4f4e-b411-cefe7d37b818` |
| 1383 | Happy's Pizza - Detroit (Store 011) | `e54f7b6b-ebe8-4160-b5e4-d39e115cc091` |
| 1384 | Happy's Pizza - Detroit (Store 016) | `c4d14004-26cd-4d3c-96b6-a72db3373f4c` |
| 1385 | Happy's Pizza - Detroit (Store 044) | `f529445b-9449-4af0-8550-95580a560036` |
| 1386 | Happy's Pizza - Detroit (Store 100) | `af734ea3-5c3f-45e0-9658-9098a40d4b5c` |
| 1387 | Happy's Pizza - Eastpointe | `d89c41a8-53d6-4644-a049-b0454f969243` |
| 1388 | Happy's Pizza - Farmington Hills | `87a00dff-9609-41f4-97c1-6b0a4894215f` |
| 1389 | Happy's Pizza - Flint | `7f04ee24-45f7-4acd-a4d1-dfab941448d6` |
| 1390 | Happy's Pizza - Fraser | `2c1777f1-cffd-4015-aa59-b9f38ab8d5bb` |
| 1391 | Happy's Pizza - Hazel Park  | `5369a412-5132-4e18-92d2-afaab14f6bf0` |
| 1392 | Happy's Pizza - Lansing | `d5e6476c-5c73-4e68-a202-9a2606d2dfd5` |
| 1393 | Happy's Pizza - Monroe | `fb2c95b9-1c16-4263-9e81-bb7c88985078` |
| 1394 | Happy's Pizza - Mount Clemens | `e46d5abe-6ee7-49eb-a034-62357b76c8c0` |
| 1395 | Happy's Pizza - Oak Park  | `49f36819-ba86-4f5a-a206-74872c1901b2` |
| 1396 | Happy's Pizza - Pontiac | `07105b07-efbd-434b-b63e-5095e17c7fe9` |
| 1397 | Happy's Pizza - Redford Twp | `e79e90e8-d113-4a98-9aa9-54e290eaf754` |
| 1398 | Happy's Pizza - Saginaw | `ddc06090-e839-41c8-a9e9-7b82c51bd19b` |
| 1399 | Happy's Pizza - Shelby Twp | `07a287ba-4f19-4537-bca5-30692c3017a2` |
| 1400 | Happy's Pizza - Southfield (Store 008) | `c09be82c-54ae-470f-a77a-1b7b85d9084d` |
| 1401 | Happy's Pizza - Southfield (Store 034) | `ad7195e1-4007-4f65-b224-41fc0d2ac177` |
| 1402 | Happy's Pizza - Southgate | `157c0dac-c657-4334-b070-c997d4244607` |
| 1403 | Happy's Pizza - Sterling Heights | `35aa542f-6add-4312-bd7a-8522ef059e8b` |
| 1404 | Happy's Pizza - Taylor (Store 021) | `3dbc50a6-0157-48bc-8c86-c38ba47273de` |
| 1405 | Happy's Pizza - Taylor (Store 039) | `d47cb024-a9eb-47ee-b702-4fecf925e32c` |
| 1406 | Happy's Pizza - Toledo | `a42409cf-4c69-45f4-a910-07e8f5b18928` |
| 1407 | Happy's Pizza - Trenton | `20c22cd0-f90f-4492-be0b-b5d93741980d` |
| 1408 | Happy's Pizza - Warren | `85bf1383-8dab-4b7e-b5b7-ead41d9693e4` |
| 1409 | Happy's Pizza - Waterford | `bc033998-08dd-4a47-9798-fe067a221ad7` |
| 1410 | Happy's Pizza - Wayne | `d0c2f78d-cb59-4fd0-aa7a-28a5a9b82ce1` |
| 1411 | Happy's Pizza - Westland (Store 027) | `c0520f14-30e5-448d-b10a-8220088c65f9` |
| 1412 | Happy's Pizza - Westland (Store 043) | `bd33ac0f-8675-4587-932a-1f82092ddc34` |
| 1413 | Happy's Pizza - Ypsilanti | `9c150d0a-c324-49ed-a9fd-8100d4c19979` |
| 1414 | HappyBoards Lower Manhattan | `5f2cf34a-9474-4ad2-92ac-0c384055e895` |
| 1415 | Harbor One | `f29b7ca6-be19-4698-95a1-1594b30c77fe` |
| 1416 | Hard 8 BBQ | `d1492d8c-5eb7-48eb-8c86-eb1929791f47` |
| 1417 | Harue | `e4ff392e-9faf-4e56-891b-1edebeaeec41` |
| 1418 | Hash Kitchen | `dc02a087-5c7b-421e-a2b5-7a62fc78d370` |
| 1419 | Hash Kitchen Peoria | `0c7afecf-6330-45fa-8bdb-782538362c79` |
| 1420 | Hat Creek Burger Company | `0669d288-a401-4745-b846-60b40b7c7893` |
| 1421 | Hattie B's Hot Chicken | `77d76ecd-ca1a-4830-9959-f3a028f939f4` |
| 1422 | Haute Dogs | `2a804dfd-9180-4dba-84e9-879207528cd1` |
| 1423 | Havana Cafe | `fdddf60d-38ad-40bc-93fa-9463329d0705` |
| 1424 | Haven Hot Chicken - Middletown | `ec7281f1-6278-46cf-b840-2dc45e635165` |
| 1425 | Haven Hot Chicken - New Haven | `91a74e52-08ab-4597-af63-6291ff99531e` |
| 1426 | Haven Hot Chicken - North Haven | `867ca3ab-c1a6-495a-bebc-44b00dcefbfd` |
| 1427 | Haven Hot Chicken - Norwalk | `79f35dfd-ed98-46e7-8235-673eb7625d1e` |
| 1428 | Haven Hot Chicken - Orange | `e4f9e414-b03f-4225-b1c5-eea65a3c4c9c` |
| 1429 | Haven Hot Chicken - Storrs | `c5e0d480-0252-48ab-af03-9f78d430174b` |
| 1430 | Hawaiian BBQ Nishikawa Ramen | `11d91de9-0e3a-4027-82ec-b3d08e283b57` |
| 1431 | Hawaiian Bros | `887d8240-0f62-4a0e-89e9-a7bec8bf7ef8` |
| 1432 | Hawaiian Bros Phoenix | `acbebc99-5d42-46ea-9cb2-fc75fef44bef` |
| 1433 | Hawaiian Bros Phoenix | `8372d083-13ec-4a89-9cfb-eaf04c961806` |
| 1434 | Hawk's Fish & BBQ | `b275cac5-8b93-4021-87ec-13c48a4ead89` |
| 1435 | Hawkers Asian Street Food | `4cd2b1fb-c9c0-4e70-b144-359d631d4fd0` |
| 1436 | Heart City BBQ | `2709fae7-ed13-4367-8d89-6441791895a7` |
| 1437 | Hearthly Burger - Sea Bright | `a5d64264-77fb-4d4f-a192-e549874d895f` |
| 1438 | Heavenly Catering (Richardson) | `e75e8a50-75ea-441a-88e2-ede0856d0d77` |
| 1439 | Heavenly Scent Catering | `a9cc914d-a896-42a0-9f9f-e9f2d8f7c8e0` |
| 1440 | Heidi's Brooklyn Deli | `394f9a42-87f2-4ae2-9071-3ec7df2b9374` |
| 1441 | Hella Mediterranean | `5cbfdc83-e258-4235-b6c5-225b55b037d3` |
| 1442 | Hello Dumpling | `e85c9d04-1f2a-411b-bf01-37cd7366ba57` |
| 1443 | Hendrix Hill Provisions | `fdce3860-8ded-44d7-93b1-ed6cad75a6d9` |
| 1444 | Hero Doughnuts & Buns | `a19c52b7-621d-435d-a70d-0e16fd8c7b04` |
| 1445 | HG Sply | `6f863374-3fd7-45e6-bf1f-285b7cbed587` |
| 1446 | Hibachi Grill | `b6e6ec6a-2dcf-4b84-a7c4-bd8cd38ad31b` |
| 1447 | Hibachi House | `8db7c723-7ef2-4e59-91c0-bcf78cebe95c` |
| 1448 | Hickory Store BBQ | `4b6bad6d-0b84-4923-aca5-0a2aefa411c2` |
| 1449 | High Point Creamery | `e3b3a73c-a3fe-448d-a99f-e054be45b07c` |
| 1450 | Higher Grounds Roastery & Cafe | `1e2f1fad-26c0-4e49-b096-e4498b1efd92` |
| 1451 | Hightower Cafe | `19f71ea1-ba5d-4dee-a2aa-b1b3a50f89cf` |
| 1452 | Himalayan Chef | `63d6e624-eb96-4b08-9917-ad3b474e5651` |
| 1453 | Hippos & Hashbrowns | `2818a0df-6722-46ff-8c40-1825b5429570` |
| 1454 | Hit the spot catering cafe  | `6029839c-c698-436a-a6aa-cd47286e086a` |
| 1455 | Ho Mei Express | `718a208a-d327-4821-b510-e4af578b98ec` |
| 1456 | Hob Nobs | `d2c80b75-bd90-4136-9650-c0c123f96026` |
| 1457 | HogsHead Cafe | `ba77cd59-8c01-4910-b58e-7d32130212d7` |
| 1458 | Holland Country Gourmet | `152066cc-eae2-4445-92c0-76ed5f997e8c` |
| 1459 | Holy Basil | `b700e299-8a95-42be-b346-9016aa51af15` |
| 1460 | Holy Cow | `b8054db9-6a6f-4cdc-9fbd-66840557933f` |
| 1461 | Hom Korean Kitchen | `f79828c4-d40d-4b7c-894d-96a28e63ea19` |
| 1462 | Home Team BBQ | `ec73180c-5159-4e95-ba50-72ccbd9651e6` |
| 1463 | Home Team Deli | `15d186e2-e486-4f5c-8cc6-d4408c3e8569` |
| 1464 | Honest Restaurant | `d91efb90-9ac4-4d89-a685-b40b60735059` |
| 1465 | Honey Baked Ham | `b07216ac-6749-4981-8cb6-e919597958f7` |
| 1466 | Honey Baked Ham Glendale | `ae84bffa-2c55-4d7a-8648-ee2b667d0689` |
| 1467 | Honey Baked Ham Huntsville | `198557c0-db53-4822-b647-a87c75f27784` |
| 1468 | Honey Baked Ham Mechanicsville | `2c94c076-fd13-45e7-bdb4-640cac3006a4` |
| 1469 | Honey Baked Ham Mount Pleasant | `5550b193-51ca-4ba6-b278-ebe31c9019cf` |
| 1470 | Honey Baked Ham Murphy | `0253d403-f536-4937-b9a3-25d9ff708386` |
| 1471 | Honey Baked Ham Pleasanton | `47cdc5e6-1b9e-4c5a-9c3c-a5e98abaf25e` |
| 1472 | Honey Baked Ham Stuart | `3d7e0783-6ca8-4d90-aef3-11616db28b61` |
| 1473 | Honey Baked Ham Virginia Beach | `2fa461e9-74ae-4121-a5c2-411bf5909b4b` |
| 1474 | Honey Baked Ham Winston-Salem | `2f3a8157-0b29-483e-87e6-e1bcd25dba4e` |
| 1475 | Honey Bear’s BBQ | `84aa85fa-b4f3-4b59-b2cc-d28eaf1b83ce` |
| 1476 | Honeybrains | `79488081-597a-4c7b-8239-dcda10e6d358` |
| 1477 | Hong Kong Express | `55a65251-98fe-4d7b-99b1-0648e7a4f2a1` |
| 1478 | Honky Tonk Smokehouse | `9f26d3f4-276a-46aa-8d31-13546aca354e` |
| 1479 | Hook & Reel | `9f6a332b-8c5c-4cf6-81dd-4b646abe3efc` |
| 1480 | Hooked Up Pizza | `b062f4a0-4a8a-4297-92d8-3bb4f2cd022a` |
| 1481 | Hootenannny BBQ | `cfff0016-a358-4cd9-9306-c38610302f05` |
| 1482 | Hooters | `32444438-0098-43a7-81a9-ff8590d590ae` |
| 1483 | Hooters Garland | `d4505db5-3799-44b0-92bf-4c1ef89e94d0` |
| 1484 | Hooters Richmond | `68ff9270-d7ca-4435-a7fd-63dd23021da6` |
| 1485 | Hootie's Burger Bar | `8aeecadc-b853-43e0-87a3-8b9de9afffc8` |
| 1486 | Hootie's Burger Bar Mesquite | `44a99876-6227-44aa-ab94-725dfaf057e5` |
| 1487 | Hootie's Burger Bar Richmond | `d71eaf0f-9d91-4479-8e65-031da1201411` |
| 1488 | Hoover's Cooking | `a310624e-bfb2-4a02-94b6-2fc4a25cea43` |
| 1489 | Hot & Spicy | `9a94c8d5-17bf-4c7f-a7a4-2cc14e5bf030` |
| 1490 | Hot Chicken Alley | `7969b167-be3f-494a-99e5-41f390865331` |
| 1491 | Hot Pizza | `e7affcfd-e2b1-4ad2-af72-d366ea850130` |
| 1492 | Hot Sauce and Pepper | `18827ff1-09dd-4156-a85f-cef65d559e41` |
| 1493 | Houlihan's | `fcad328b-ee4f-48eb-83a2-a22280071e8f` |
| 1494 | House of Bagels | `1668b48a-231d-4f9e-abec-702e2baebc93` |
| 1495 | House of Bagels Mountain View | `57308e98-0eb7-48ff-b0dd-91a262f44c5b` |
| 1496 | House of Falafel | `1c73c7d9-857b-439f-aee3-3a3fe6581e88` |
| 1497 | Houston TX Hot Chicken | `a7f2d818-0922-417e-94e8-5ec67cd34429` |
| 1498 | Houston TX Hot Chicken Meridian | `48d38e68-c8bf-4ed0-b402-ef59921aca13` |
| 1499 | Houston TX Hot Chicken Tempe | `ddc6d1c0-82ba-44b6-bfd0-3764bf5ff8ee` |
| 1500 | HP Taco Shop | `a71ce435-c1d0-4afd-a958-1bf4575ca59e` |
| 1501 | Huckleberry's | `54d71258-40a5-4126-852a-d8bd4449bbe0` |
| 1502 | Huddle House | `4387298f-b1c7-4c62-b4d0-8c4ef5376573` |
| 1503 | Huey Magoo's | `0e7b8ae8-22c2-44f8-922e-73b3a1a8c0fc` |
| 1504 | Hugh-Baby's BBQ & Burger Shop | `98aef70a-fcb0-46ce-a5da-aaaf5b9d8031` |
| 1505 | Hummus Mediterranean Kitchen | `996736d9-9373-4313-840c-97707aef639b` |
| 1506 | Hummus Xpress | `4fd8ea9f-2e45-4ff0-897f-4bbd15f02741` |
| 1507 | Hunan Cafe | `3a5b9ff9-20e4-41ee-9a0b-388f3f8b2ca0` |
| 1508 | Hundy's | `4e1d19e4-b95e-455e-8709-8393de7d9e4d` |
| 1509 | HungerBox | `47dbce9b-d2b5-4e92-922e-0c88a26afc3a` |
| 1510 | Hungry Howies | `98288e64-55d6-4942-8dcc-e1719e67a758` |
| 1511 | Hurricane Grill & Wings | `e7532d98-d580-47e7-8970-c48263b01235` |
| 1512 | Hyderabad Dum Biryani | `62f06368-511c-4c80-8f30-61f3a1ea156e` |
| 1513 | I Heart Mac & Cheese | `a0443716-7d9f-4397-b36e-48a3c04ef046` |
| 1514 | I Heart Yogurt | `1dca7017-662a-47e5-b753-e127d6be57e2` |
| 1515 | I Luv Pho | `795f3c51-a4d2-48bd-82c0-45d1aa8cfb1e` |
| 1516 | Iacofano's Catering & Events | `efb1b022-55b0-45b6-b748-c8c1a5d10aa9` |
| 1517 | Iced Out Ice Cream | `c17406f9-9bc9-4f13-9b69-186cc9f1c735` |
| 1518 | Icicles | `931188c7-f543-4cf7-9b29-ea8f09ab3f65` |
| 1519 | IGrill | `90a45b73-126c-4854-81b4-3d1cefb6b6d5` |
| 1520 | IHOP | `434bb71f-0498-4b3c-9486-2feb4722f924` |
| 1521 | IHOP Boise | `fe986f03-e0a4-49a7-97ab-3986b46f9286` |
| 1522 | IHOP Charleston | `4d2b144e-c091-4312-9469-7397008550e6` |
| 1523 | IHOP Chesapeake | `1e54f888-dc3b-454c-a9f8-4814ec31ce90` |
| 1524 | IHOP Garland | `bc766b09-758a-4fb5-b4f4-837f2efe8256` |
| 1525 | IHOP Glendale | `749d928f-61a7-4d96-8f14-48e66fc1df04` |
| 1526 | IHOP Hayward | `b1bfaa8f-0ea4-44ea-8994-96e02b6da733` |
| 1527 | IHOP Norfolk | `cdf60434-f430-411f-8503-a44c982f45f0` |
| 1528 | IHOP Phoenix | `fba2eaa4-62e4-4f88-8b3f-9896041917ab` |
| 1529 | IHOP Port St. Lucie | `6dc15cf2-c6f9-4812-b87a-649aa09e4466` |
| 1530 | IHOP Richmond | `15579660-4542-42f0-97bf-7fe4092be1d0` |
| 1531 | IHOP South Portland | `83a90509-aa3f-42d3-9b8e-bc1cc56796a7` |
| 1532 | IHOP Spokane Valley | `8e42a975-3d1a-46de-93d4-2384d3accfe2` |
| 1533 | IHOP Winston-Salem | `54314c57-3048-460b-8c12-eeb49a01cabd` |
| 1534 | III Forks | `8da5efca-73eb-4e45-bd72-8b23e69c1f3a` |
| 1535 | Ike's Love & Sandwiches | `7e9c6bfd-ce7d-483d-af99-384a3c971a6c` |
| 1536 | Ike's Love & Sandwiches Fremont | `a4107376-fa87-43b5-8e31-990729a369d9` |
| 1537 | Ike's Love & Sandwiches Peoria | `17d7ac42-8bb6-42aa-87e9-0c924450b0ca` |
| 1538 | Ike's Love & Sandwiches Scottsdale | `60e45d1d-ecd4-4d8b-b1b0-a126dc6a3a09` |
| 1539 | Ikura Sushi & Hibachi | `da8b9602-5f78-462c-913b-c4e2f4f3eaee` |
| 1540 | il Capo | `3bee2350-5508-464c-bf7f-c5dd6ff794d1` |
| 1541 | Il Fornaio | `4c564b8e-ff41-47fe-9c54-222dbb873c4a` |
| 1542 | Il Forno Bar + Grill | `0411c4cd-7f11-4702-bdf7-318d8387b442` |
| 1543 | iLava Hawaiian BBQ | `9b1371f4-18bd-4871-9308-52723068b9ed` |
| 1544 | Illegal Pete's | `d52131b3-0e91-45ec-9887-08cd482ad887` |
| 1545 | Inchin's Bamboo Garden | `1927c716-398f-4eb1-8bca-72c9bc67655a` |
| 1546 | India K' Raja | `c8ad8ff4-6aa0-4139-b1d7-2661c664c1f2` |
| 1547 | India Palace Restaurant | `ddabb13d-9442-4cbf-8b23-b9eadc8557e8` |
| 1548 | India's Flame | `0ef9b22d-cdf1-4735-bb1b-264f425470c7` |
| 1549 | Indian Delhi Palace | `9d4dee9f-98e5-4257-ad7f-56de4dd66130` |
| 1550 | Indo Chinese Bistro | `5c77ab1d-ce86-4ae6-a63b-179a1bc7f2d7` |
| 1551 | Indy's Sandwich | `3d0029a8-5dc6-4eb0-b819-bf7cf8111283` |
| 1552 | Infinitus Pie | `1f316d6a-1aa3-4ce1-9d96-5bf978ce64f0` |
| 1553 | Ingo's Tasty Food | `0557779b-bd98-4009-8ec6-75a70b9b3449` |
| 1554 | iniBurger | `c64b2f96-eed6-4a9f-9d16-e697d9e5954f` |
| 1555 | Inland Northwest Catering | `6aee51eb-35c9-4422-88b8-9a4cd444e192` |
| 1556 | Inner Circle Cafe | `e1f2b41d-531a-4f56-b9f4-288f25c549a7` |
| 1557 | Inner City Blues | `064c11fc-960e-478c-9189-b296289dc709` |
| 1558 | Insomnia Cookies | `b03381da-da9d-4572-929c-d5969b278867` |
| 1559 | Insomnia Cookies Phoenix | `d45239da-d1c2-4523-8555-d2794c00824c` |
| 1560 | Intentional Foods | `c8518df6-e4f3-4910-9c35-43c65358a3e4` |
| 1561 | iPizza | `b71661a1-c0be-4126-ab95-f896aeac122d` |
| 1562 | IPizza | `8c293521-db42-4147-8840-1d75df387f04` |
| 1563 | Iron Chef AZ | `1ba18ae7-efeb-47ed-a1ab-eae09fb87006` |
| 1564 | Island Boyz Jerk Spot | `fe9edbc9-41b6-40ad-95f7-32f1d978712e` |
| 1565 | Island Fin Poke Co. | `972dfca4-7ac2-4f66-a2c2-5fa668676e3d` |
| 1566 | Island Shrimp Co. | `19cfc2d3-6483-4270-aa39-c884d53b9130` |
| 1567 | It's A Grind Coffee House | `d829fca2-66b5-41e7-8116-2f29b83b748d` |
| 1568 | It's All Greek to Me | `428b3da5-7695-436f-9f29-09802d3074a8` |
| 1569 | Italian and Indian Pasta | `8868378c-142d-4b82-84a5-72bd8d22c0d8` |
| 1570 | Italian Cafe | `70d6f41e-7ce3-4154-889d-378e7886efe7` |
| 1571 | Italian Pasta Kitchen | `35f91416-df2c-401e-92d1-2c033b015b2b` |
| 1572 | Italian Spoon | `de5c6bba-3039-400e-bc5a-7a09f3eba6c0` |
| 1573 | Italian Villa | `5747d57f-6434-4ea1-9d28-cd54ade91f00` |
| 1574 | Italic Catering and Events | `8bb2a186-10ef-4f83-9d81-d64b26b05744` |
| 1575 | Its a Win Win Catering | `8caaaf6e-1543-42bb-8c9c-d6c0e7211e6f` |
| 1576 | J Pepe's Mexican Restaurant | `67ea1b55-575e-49a7-8313-88719f8d219a` |
| 1577 | J&K Style Grill | `f987dba4-39a0-4c72-97c3-f7a5221621f5` |
| 1578 | Jabbar Bhai Biriyani Restaurant | `1e23f9bc-adb0-4631-b96b-f8e0dd1f8912` |
| 1579 | Jack's Restaurant & Bar | `6094a4e7-acf5-48e3-adbb-0d26c5f9d387` |
| 1580 | Jackson's Eatery and Bar | `13e90f50-3259-4f83-9fcc-137bc28a528e` |
| 1581 | Jaffa Mediterranean Grill | `299ebd97-56b0-4874-9e64-b15023c0f258` |
| 1582 | Jagdish Farshan | `c48c9548-82c7-40ec-a0d3-0c0272535020` |
| 1583 | Jailbird | `4bd76a5d-1693-45a3-9238-9c2caa74eae7` |
| 1584 | Jake's Place Restaurant & Market | `45300905-eb99-491b-aa6f-1cf8d9bd877f` |
| 1585 | Jalapeno Inferno Park West | `97932859-1b56-4fa9-8264-bc6ac8698b20` |
| 1586 | Jam'It Bistro | `2dbf1b78-615b-4d7d-8e1f-19f572796d9a` |
| 1587 | Jamaica Coast Catering | `af992dbd-ce8b-4215-bb01-9e81d528c334` |
| 1588 | Jamaris' Kitchen | `62481fd1-8e8d-4e72-8a41-85ec20f3124c` |
| 1589 | Jamba | `face08b8-a275-4a83-8734-70333ca32986` |
| 1590 | Jamba Boise | `a091f99a-6773-4a55-895e-2c779d6f8c92` |
| 1591 | Jamba Boulder | `ca6813ba-8ec2-424d-9b09-3b14d6e32a2b` |
| 1592 | Jamba Phoenix | `b2dc1a96-fc7f-485e-9828-6bd1516501c6` |
| 1593 | Jamba Scottsdale | `9ce91f9c-3579-4598-ba36-ca34413a370f` |
| 1594 | Jamba Spokane Valley | `14a63176-8ff5-4111-92bf-b4176130f621` |
| 1595 | Jambalaya Shack | `c2d58fe0-17ec-4337-85d4-be0d55f13be5` |
| 1596 | Janakpur Indian Restaurant | `0fc5b685-cc1a-4943-b303-0f6a9983512b` |
| 1597 | Jarams Artisan Donuts Since 2012 | `2062fd70-50d2-464e-83d2-a63bcc9ee7d1` |
| 1598 | Jasmine Restaurant | `1e928a84-8e49-41bb-a3c1-cf61b70d936c` |
| 1599 | Jason's Deli | `22b7f050-5507-4766-a966-b9f7401608c2` |
| 1600 | Jason's Deli Charleston | `1cb664a0-2a81-4ecd-9a40-c5e0181cf22d` |
| 1601 | Jason's Deli Chesapeake | `a295e203-94b2-4d2c-9023-19f7e2f7a446` |
| 1602 | Jason's Deli Phoenix | `c8ca1aa8-4adb-4a84-9ab1-1b38b7b1e7bb` |
| 1603 | Jason's Deli Richardson | `ca4dd44d-7e6b-4db5-9872-f68c7aa14fa6` |
| 1604 | Jason's Deli Richmond | `4ecbe515-a1fe-4be0-97e9-a8e621d3b44e` |
| 1605 | Jason's Deli Scottsdale | `07caa715-cc57-4e5d-9303-5487882e2e1c` |
| 1606 | Jason's Deli Winston-Salem | `bf0b42e4-dff1-4b3c-be82-8d37287c3dc1` |
| 1607 | Jay Hind Indian Cuisine | `39803dd4-556a-441c-8c10-24d6708f92cb` |
| 1608 | JC's Philly Cheesesteaks | `09e2186e-fceb-4d05-8d48-0136766dc9e0` |
| 1609 | Jefe's Cantina | `619f06f2-234b-47cd-b747-acdbbce7c2b2` |
| 1610 | Jefferson's Restaurant | `d33442c4-6a09-4950-a2ca-9c90b475241e` |
| 1611 | Jen's Place Bakery & Cafe | `23db89f5-31ba-405f-a7aa-9407b92b8f4b` |
| 1612 | Jeng Chi Restaurant | `3f269f4d-35ff-4244-b14e-3105c6c63bb0` |
| 1613 | Jeremiah's Italian Ice | `0cea247a-9f67-43f3-9de1-a5342a01d722` |
| 1614 | Jeremiah's Italian Ice Chandler | `560a8a31-43f0-4a16-8958-876611084343` |
| 1615 | Jeremiah's Italian Ice Lucas | `500b9044-0da7-4152-9c7c-9abb908c7c98` |
| 1616 | Jerk Sauce | `6395de11-3336-414f-81eb-c728fa666de2` |
| 1617 | Jerkin Chicken | `04f4250e-074e-42f8-a793-e52b6d676b9a` |
| 1618 | Jersey Joe's Deli | `abc95ecd-4807-4bab-a683-1e28f6fdf350` |
| 1619 | Jersey Mike's Subs | `d86f683b-e574-48a4-a701-726e0cf18db0` |
| 1620 | Jersey Mike's Subs Charleston | `d444d19d-05b9-4a72-b45c-4601468ed1bf` |
| 1621 | Jersey Mike's Subs Chesapeake | `9c8b7509-0203-4d3b-8d42-7fe7feaa4605` |
| 1622 | Jersey Mike's Subs Glendale | `641cd000-8d2f-442a-99d4-21e75aaed25f` |
| 1623 | Jersey Mike's Subs Huntsville | `1289fd59-72ec-41bf-9ca3-d49646951611` |
| 1624 | Jersey Mike's Subs Louisville | `0c72d432-fbe8-4842-8947-64a7efccccb9` |
| 1625 | Jersey Mike's Subs Norfolk | `c8c8b0bd-d5d7-4b83-b935-1c64df03960d` |
| 1626 | Jersey Mike's Subs Pleasanton | `d4fad701-3688-40b8-9d2d-13bf58a3dff1` |
| 1627 | Jersey Mike's Subs Portland | `5f80aa59-c87b-4ce8-abac-198bec4bf019` |
| 1628 | Jersey Mike's Subs Richardson | `f4d1e86d-9065-4a8c-948c-03b3056f6dde` |
| 1629 | Jersey Mike's Subs Richmond | `46437996-128c-4eab-9ee6-46ae5118aa26` |
| 1630 | Jersey Mike's Subs Scottsdale | `2099c330-dc32-4b96-81a7-740c79c264d8` |
| 1631 | Jersey Mike's Subs Spokane | `071cd2f9-d801-4ed3-a251-afc1af243b37` |
| 1632 | Jersey Mike's Subs Winston-Salem | `5ef14336-69fc-41ef-a011-781f498a0b56` |
| 1633 | Jessy's Taco Bistro | `d3882f18-7aa0-4b54-bcee-1b3f79ed7bfe` |
| 1634 | Jessy's Taqueria | `220ba905-9f03-461c-9f3c-40dcdc581cf0` |
| 1635 | Jet's Pizza | `61478c9d-8e95-42b7-8ef8-b4881ad4d150` |
| 1636 | Jet's Pizza Dallas | `d3a727ee-a76d-4774-9c9f-de775748e02d` |
| 1637 | Jet's Pizza Phoenix | `174f340c-f617-430e-b2c0-339ad7babd30` |
| 1638 | Jiaren Cafe | `c99a8ff4-81e9-4b01-815b-8d231255ec47` |
| 1639 | Jibble Jabble Eatz | `f36ce940-c8f9-435d-9bc9-7c7946adadc8` |
| 1640 | Jim 'N Nick's Bar-B-Q | `9a7309b8-b187-466f-a22f-9e237d80929d` |
| 1641 | Jimmy G's | `cc157a68-d863-475e-9ddf-85c7d746abf9` |
| 1642 | Jimmy John's | `4e3a04f5-322c-4314-a6d8-6f036a3165d9` |
| 1643 | Jimmy John's Chesapeake | `00e99822-9882-4de5-aacf-aadf23bef54b` |
| 1644 | Jimmy John's Glendale | `502e2d2b-c8aa-40fa-8338-7f35e6e723f2` |
| 1645 | Jimmy John's Henrico | `960fb52e-a57a-409f-80c7-28687f7364a9` |
| 1646 | Jimmy John's Norfolk | `3e1af8ac-87a4-479a-b270-98a765a65c36` |
| 1647 | Jimmy John's Scottsdale | `83ae6af1-fca1-4df8-8233-107c0426d929` |
| 1648 | Jimmy John's Winston-Salem | `ec230d26-2bb9-43b1-a1e6-120030147dc0` |
| 1649 | Jimmy John's Wylie | `92336cf1-6756-4e86-8c00-e650c59b98c7` |
| 1650 | Joe & The Juice | `d18c2a6f-f979-4481-afd9-6637967d2170` |
| 1651 | Joe Chinese Fast Food | `92e3f16b-ab5c-4f42-bfd6-4afa04756657` |
| 1652 | Joe Leo Fine Tex-Mex | `eb13c23d-fb98-49e6-879d-a27ffcd1a6e9` |
| 1653 | Joe's Crab Shack | `bbced51d-e061-4f84-bcae-479eba06db27` |
| 1654 | Joe's New York Pizza | `978bdaf0-1b9f-4458-91bc-b5e927db244d` |
| 1655 | Joe's Pizza, Pasta & Subs | `65d4cd4c-df60-4bc7-b459-a12fc3272d75` |
| 1656 | Johnny Carino's | `dfc0550b-2634-4006-857c-712422b5d7c9` |
| 1657 | Johnny Q's | `7bff5c36-2fc9-42f3-b401-019f32388012` |
| 1658 | Johnny Rebs' True South | `03abaf54-e75e-4bc7-98fe-3c0cdce4adb4` |
| 1659 | Johnny Rockets | `6418957e-5d53-4b69-a56b-40a5cef72e25` |
| 1660 | Johnny Rockets Glendale | `e022a807-20f7-408c-b405-20f7df2beeaf` |
| 1661 | Johnny's Greek Deli | `6db32717-fdff-48e6-96fb-0b286f553b97` |
| 1662 | Johns Gourmet Catering | `03e37530-1a74-4198-9182-176770aecba0` |
| 1663 | JoJo's ShakeBAR | `8bb266f4-887e-4bd5-8da0-0449ef52e96b` |
| 1664 | JoJo's ShakeBAR Scottsdale | `ac8d5bb2-9428-4bae-955d-92fd5b36660d` |
| 1665 | Jon Smith Subs | `0bf8bf2b-3283-463c-a236-3e65256ebc80` |
| 1666 | Jon Smith Subs Madison | `f9a8ef10-6eea-4dc2-8dca-1037325eccae` |
| 1667 | Jones Family Kitchen | `d31cd3c9-d6e3-40e3-9b10-f4c297fffaeb` |
| 1668 | Josephines Soul Kitchen | `7917bd9a-83b3-421b-bab7-89543a47eac9` |
| 1669 | Joyful DimSum Bistro | `cc771aa2-981d-4c18-9df2-69ca1c4273aa` |
| 1670 | Joyride Taco House | `7a1d2056-bccd-4868-a8ef-963519f77437` |
| 1671 | Joyride Taco House Phoenix | `7cdf50b8-0da5-4442-a506-29c555070d6b` |
| 1672 | JT Gyros | `94cbd48c-643a-49df-887a-bbf534df03be` |
| 1673 | Juan's Rooftop and Cantina | `d9154a52-067f-43c2-a3f0-dd102d5225c0` |
| 1674 | Juan's Taqueria and Cantina | `3cc2d0ab-f122-439d-8a05-462bcf3903c0` |
| 1675 | Jugo | `cff76dab-718f-4f33-8e98-aaf3602f1de4` |
| 1676 | Juiceria Smoothie Bar & Cafe | `205e54a3-b06e-4760-a8a2-ed537025fa08` |
| 1677 | Julie's Sweets Bakery | `1e4e28e6-7be3-4cdb-9025-6c641aa495de` |
| 1678 | June House Asian Kitchen | `95141947-3396-414c-bf55-d002097f965d` |
| 1679 | Jungle Burger | `3627727c-7b4d-48e9-ad57-40f8bb25905f` |
| 1680 | Just BE Kitchen | `549c3250-5ac1-4dd0-8c2e-079489887f13` |
| 1681 | Just Love Coffee Cafe | `64ec9742-6324-4dca-938d-0d8f0a250655` |
| 1682 | Just Salad - Shrewsbury | `e45a4f89-32a0-45d9-9bfe-a2b99c5bb7a5` |
| 1683 | K&W Cafeteria | `f4fb3e64-4145-4d56-83b3-650d3e953a4f` |
| 1684 | K-Pop Ramen | `8b1eaa85-e549-42a0-96bd-4632d0f9455f` |
| 1685 | K-Star Doshirak | `0696eb79-1def-4ae1-a1ea-9c3798f3d9fb` |
| 1686 | Kabuki Japanese Restaurants | `8850720f-04df-4595-b200-96a64fa8ba8b` |
| 1687 | Kabuki Japanese Restaurants Glendale | `0c22e903-a353-4228-a269-e7a2da032e35` |
| 1688 | Kairos Mediterranean | `272fb703-596c-43a1-9727-f9e937eef2a4` |
| 1689 | Kakuna Sushi | `f1c2c710-ddaa-47b1-80ef-0d825b2c6d55` |
| 1690 | Kalamaki Greek La | `54e58c57-ca80-4322-b23e-3c0b43b51b98` |
| 1691 | Kale Chef Service | `8216de88-4de0-4d09-b531-f899f0df2f6a` |
| 1692 | Kali Greek Kitchen | `f400536c-9faa-4c26-8d1d-0f1963a3da2f` |
| 1693 | Kanak Attack Katering | `ab98f31f-e38f-43bf-b5b5-18c59adb59e7` |
| 1694 | Kanji Sushi & Ramen | `1e21137f-1703-400c-a97c-a85f39ed49c3` |
| 1695 | Katsuyaki | `3ecfb29a-02f2-46ac-afc4-9cfb97a86d46` |
| 1696 | Katz's Deli | `katz-s-deli` |
| 1697 | Kayleigh Michele's | `a0db0260-fbb6-48df-b7e5-0a7a128c08d4` |
| 1698 | Kayleigh Michele's Farmers Branch | `1a425a2f-ca8a-40ba-8733-c56928c5df90` |
| 1699 | Kazoo Japanese Restaurant | `f952fe21-f7bb-4499-adc5-a2937522e844` |
| 1700 | KB Catering & Grilling | `805eb818-b942-4033-9c54-349eba1c928f` |
| 1701 | KCI Hospitality | `1a17afc3-37ce-4967-ab88-90353afa3e0b` |
| 1702 | Kebab House (Newport News) | `8217ded0-7976-4885-9307-03d0e53627d6` |
| 1703 | Kebabs To Go | `5ba5af9f-1f4e-4c00-9e24-099740c4b047` |
| 1704 | Kees Kitchen | `7918a4e2-27e0-4cd0-bad9-09717eb0549e` |
| 1705 | Keke's Breakfast Cafe | `1be83ebd-8f3e-4be2-8758-e42c763362bf` |
| 1706 | Keke's Breakfast Cafe Dallas | `b3da06b4-5c76-4b46-aafb-6396d625986c` |
| 1707 | Kessler Baking Studio | `dd8ab163-314c-4f3e-aced-12d2929ebcda` |
| 1708 | KetchAFire Jerk And Seafood | `ce971c5a-affc-4a13-b63f-fe5c19d95db1` |
| 1709 | KFC (Kentucky Fried Chicken) | `8a80b1ed-4a75-4d0f-90ab-111342d0de3c` |
| 1710 | KFC (Kentucky Fried Chicken) Boise | `5cec7fd4-04d5-40af-9fe4-614d62b37ef6` |
| 1711 | KFC (Kentucky Fried Chicken) Chesapeake | `992d2c27-f1fa-46e2-9bf4-7548895d54e8` |
| 1712 | KFC (Kentucky Fried Chicken) Fremont | `ccecb543-08ae-4feb-a317-36bbd2cc13b0` |
| 1713 | KFC (Kentucky Fried Chicken) Huntsville | `3658dab5-8449-40ef-a61b-1b0b61f7bec4` |
| 1714 | KFC (Kentucky Fried Chicken) Norfolk | `ece83481-9c82-4fdb-a999-f92c18512dcd` |
| 1715 | KFC (Kentucky Fried Chicken) Port St. Lucie | `e2283a99-56bc-48ff-87d9-7f79dc8ab297` |
| 1716 | KFC (Kentucky Fried Chicken) Richmond | `4a99336c-8312-4dc0-a118-a529e759b3b4` |
| 1717 | KFC (Kentucky Fried Chicken) Spokane | `ed962a67-00b3-4f70-a287-44761f621457` |
| 1718 | KFC (Kentucky Fried Chicken) Winston-Salem | `d8b2f80b-ff9b-4f5b-bfee-c7243a47eab4` |
| 1719 | Kid Cashew | `6957f3fa-a35e-47f5-ad10-59b4c86b8084` |
| 1720 | Killer Burger | `92e5ee34-576b-419f-843b-56ed0c285eb9` |
| 1721 | Kim's Chinese Kitchen | `636ef1c3-51b6-4869-857b-f60ca5e4ae99` |
| 1722 | King David Tacos | `c8f5583d-8e3e-4759-9131-e59247291499` |
| 1723 | King Eggroll | `1b370e0c-41ea-48bc-a74a-9eb191dd432d` |
| 1724 | King Eggroll Express | `8b8fb8a9-a9f1-4cb7-8439-a9a26c3c5bb3` |
| 1725 | King Kong NY Pizza | `48232bda-4f54-4872-81ac-202580a6d806` |
| 1726 | King's Gyro | `51c0b5c3-f563-4a22-b14f-d1850cee553a` |
| 1727 | Kismet Modern Indian | `ef8c6932-ac47-4281-8925-f1e756312f52` |
| 1728 | Kitchen + Kocktails | `63fd2b0b-6d18-45b5-94a4-531f5b31f40f` |
| 1729 | Kitchen 101 | `4fe928ce-0c71-4cba-8021-3b8838a8152d` |
| 1730 | Kizuki Ramen & Izakaya | `cd8ac890-eca7-499a-b086-5de0157d932a` |
| 1731 | Knickerbockers Deli | `36427ffe-9619-4139-9d7f-93f5be54b135` |
| 1732 | Knuckle Sandwiches | `7ef8b11f-03e1-4f52-b37b-a5b342310475` |
| 1733 | Kobe Japanese Restaurant | `649e0965-2a6d-46e4-9748-f4584e058d6b` |
| 1734 | Koibito Poke | `97e54c55-5636-425e-ad8e-43c29dc8539f` |
| 1735 | Koibito Poke Glendale | `4ef0447b-c405-414d-ba5f-4b855731348c` |
| 1736 | Koja Kitchen | `cd37501f-f4c4-4fbf-b93a-ab7a88385c08` |
| 1737 | Koko Fruteria | `37173e3b-8af2-47a5-863a-b28c46b3d828` |
| 1738 | Kokobelli Bagel Cafe | `5202d818-1f9e-4fa1-bd2b-2b2231e2b417` |
| 1739 | KoKoLo | `8ccb5b6d-b60c-48fc-84cc-2d15dd48a478` |
| 1740 | Kolache Factory | `360fcfd4-9d40-4c9d-b0ea-3c151cb7b57c` |
| 1741 | Kona Grill | `b629228b-0a2d-47b1-b57e-4d8e6e403105` |
| 1742 | Kona Grill Dallas | `e1856747-80c5-41fd-b4f2-39af036b7bbd` |
| 1743 | Kona Grill Gilbert | `6d22537c-95c0-45d0-aebb-4dbe2e9bde14` |
| 1744 | Kona Grill Meridian | `4adeee0d-3b9a-4598-b20c-c2e45f428aa1` |
| 1745 | Kona Grill Phoenix | `31a274ce-1d21-464f-a6b9-20f8ec0955f1` |
| 1746 | Kona Hawaiian BBQ | `ac7b29d6-e164-44d7-91d7-0913cec107c2` |
| 1747 | Kookie's Cakes & Shakes | `81cbb126-8a9e-4f5e-9c8a-08c2db471496` |
| 1748 | Korean House | `c279660b-2619-43dd-a020-d272e5cb2a2f` |
| 1749 | Koriander Indian Cuisine | `4e752b07-aa73-4518-b522-a5efae8c7cb0` |
| 1750 | Kosta's Greek Cafe | `a93ea036-5dd1-41ce-876e-cc3cd985c60f` |
| 1751 | Kozies Pot Pies | `b63fab8f-c528-4ab1-bcaa-d795a877fef8` |
| 1752 | Krav | `55f86f6b-c39b-4906-88b6-9b6c6a5a59f4` |
| 1753 | Krispy Dogz | `66bb2b4e-13b6-4409-9dc6-8d5e320adbc0` |
| 1754 | Krispy Kreme Doughnuts | `1ffc78d0-3d25-4677-a489-0ed2440cd8a0` |
| 1755 | Krispy Kreme Doughnuts Charleston | `bc8d9545-f22e-426c-a038-deacdf59fd8b` |
| 1756 | Krispy Kreme Doughnuts Chesapeake | `29f87b85-93c7-481a-9073-3855d2d87c8b` |
| 1757 | Krispy Kreme Doughnuts Dallas | `f68912c9-d7aa-44c1-95ca-07831e758177` |
| 1758 | Krispy Kreme Doughnuts Fremont | `5283fa87-e994-4d14-8669-a09c376a5562` |
| 1759 | Krispy Kreme Doughnuts Huntsville | `001fcec4-ea71-4c6d-a00a-47627e9d6829` |
| 1760 | Krispy Kreme Doughnuts Mesa | `4d06b1d0-c227-4cd5-b99b-ee9a0566d386` |
| 1761 | Krispy Kreme Doughnuts Phoenix | `09712853-8586-44df-b640-5049b3bcde9c` |
| 1762 | Krispy Kreme Doughnuts Portsmouth | `23fed4c7-79a2-440f-9d06-63f5812552dc` |
| 1763 | Krispy Kreme Doughnuts Richmond | `8aa1fd55-2531-4fdd-ae1a-d0bb11776667` |
| 1764 | Krispy Kreme Doughnuts Spokane Valley | `2e52edbd-43a2-4372-9a0a-bb7ddd2c1365` |
| 1765 | Krispy Kreme Doughnuts Winston-Salem | `1ba77239-c048-455a-b498-bc186d782850` |
| 1766 | Krispy Krunchy Chicken | `f27d3898-bada-459b-82a1-c79dc12cbacd` |
| 1767 | Krispy Krunchy Chicken Port St. Lucie | `baa709c8-d1a3-4587-95b5-d9c79c28165d` |
| 1768 | Krispy Krunchy Chicken Tempe | `4b3c0ddc-a1d4-440c-920a-46c2aeb93ed0` |
| 1769 | Krua Thai | `6948f849-b1eb-402e-b35e-16f7fa3718ec` |
| 1770 | Krystyna's Polish | `407135c2-ff91-4b0c-bea3-2d3dacdd3fce` |
| 1771 | Kuai Asian Kitchen | `cbb5f97b-2612-433c-b77d-ef5e22e382d9` |
| 1772 | Kwality Kabob & Grill | `b475a990-73e8-4582-b96c-47741daaea75` |
| 1773 | KyotoRamen and Hawaiian BBQ | `6e52db08-1355-4ecd-8fb1-f3ee96d156b7` |
| 1774 | L & L Hawaiian Barbecue | `ead27bb7-59d1-4081-9bb3-7e12aea87bb7` |
| 1775 | LA Burger | `cbd9d07b-632c-47cf-8514-2eed361a1cff` |
| 1776 | La Catering Southwest Barbecue | `6b43b973-d1d1-44d7-9d20-6912a4504953` |
| 1777 | LA Divine Cuisine | `3519f21c-0725-4756-9e88-29084445e45e` |
| 1778 | La Duni Baking Studio | `b282f95a-0080-4508-8a36-5e20fe37310b` |
| 1779 | La Duni Latin Cafe | `27921926-470f-484d-85d6-89e2c65e884f` |
| 1780 | La Grullensa Restaurant | `841d8a2b-0db6-4383-85b9-55169ea6d80e` |
| 1781 | La Lune Sucree | `e53fa4b7-6481-4d02-b90e-741b83d0fddd` |
| 1782 | La Madeleine French Bakery & Cafe | `3af9da77-dc26-45c2-b980-56b4498f066e` |
| 1783 | La Madeleine French Bakery & Cafe Chandler | `d801f012-319c-4604-b90c-1d56ee611025` |
| 1784 | La Maja | `4dd89bce-5cbb-4373-865b-06aa2791ae4f` |
| 1785 | La Palais Sucre | `80338c28-80a2-4338-a359-e7e3e303b955` |
| 1786 | La Parisienne French Bistro | `6bff88a5-3eca-4dc3-92b3-2c4372b085b3` |
| 1787 | La Patisserie Bakery | `5bd2e64c-7066-4aba-9617-a71c90bfd228` |
| 1788 | La Ristra | `ae8d9cd5-9cd9-4969-8823-c4aff8356942` |
| 1789 | La Rue Doughnut | `ed255c5f-6aaf-4da4-9922-b26aae0eedad` |
| 1790 | La Salsa | `b61e0c5b-949a-4a43-a803-67fcbd06acad` |
| 1791 | La Salsa Loca Tacos & More | `eeaae206-69a6-4a6b-aad8-f85753dd6f80` |
| 1792 | La Sandwicherie - Chelsea | `fc5483ce-be24-4709-b4cb-16f0e8802d6e` |
| 1793 | La Sandwicherie - Upper East Side | `babb1e9f-8b08-4c1e-a66f-30ad9dd447ba` |
| 1794 | La Stella Cucina Verace | `20e22d51-e339-40aa-924c-8e275995f402` |
| 1795 | La Veganeria | `3fbe0faf-87ac-450b-b855-b2e07b92e719` |
| 1796 | La Vita E Bella Ristorante Italiano | `7f11879f-234d-465d-ba1d-8b58cb8ea5c3` |
| 1797 | Lake House Bar and Grill | `4d247bc2-720a-45e5-aa0c-ef18ee3d81b6` |
| 1798 | Lamberti's Ristorante and Wine Bar | `54b9614e-7bf9-4ee8-8a3e-ebc6f32f4545` |
| 1799 | Lapana Asian Cuisine | `0ded2d60-bb7c-4b18-85c9-dcaa1c4fa337` |
| 1800 | Laredo Taco Company | `440828d0-5dde-46eb-ba71-d03d74901a0d` |
| 1801 | Larkin's Catering & Events | `1176ac36-76dc-47b8-a365-fd223a65bf41` |
| 1802 | Lasgidi Cafe | `88ada604-ba59-4174-96b3-c49d33861a68` |
| 1803 | Latin Deli | `5093706c-8d1b-4e4e-a22d-9aa989f97725` |
| 1804 | Latin Deli Tacos | `1ea766a6-0143-41af-9785-55b13146612a` |
| 1805 | Latin Healthy Bowls | `5d99a1f0-6108-405b-9caa-7bcb84980cb0` |
| 1806 | LawLers Barbecue | `d2de1f13-b3ca-485c-88ca-c98779b745de` |
| 1807 | Layne's Chicken Fingers | `3e4ecc0b-fa68-4f24-9211-9ee98cd2d3e5` |
| 1808 | Lazo Empanadas | `4e986f73-56a2-44e2-8835-8fb6ef0abdeb` |
| 1809 | Lazy Dog Restaurant and Bar | `0327ba8a-a59a-4c01-a49c-8e495f19def2` |
| 1810 | Lazy Dog Restaurant and Bar Garland | `602d16e2-2dbe-4968-8c82-83e929b29d4c` |
| 1811 | LB Kitchen | `42017d98-ae00-463f-8bbf-0832619381b5` |
| 1812 | Le Boulanger | `aa8eebe8-95e5-4338-882e-117448e95a8d` |
| 1813 | Le Moose Crepe Cafe | `acd0c164-d1ba-46f1-b2c5-c5464ee31d1d` |
| 1814 | Lean Feast | `3370b5f2-ad8e-44ad-b870-df17bf6ee9c6` |
| 1815 | Leela's Uptown | `80fde212-2165-4a3b-9616-746c7274d054` |
| 1816 | Left Bank Brasserie | `db1dc197-8f93-4af6-a1c9-23d9a3a3d02e` |
| 1817 | Legacy Point Catering | `88603c8e-76f4-4847-827b-9b39632ecf3c` |
| 1818 | Leila Bakery and Cafe | `8ee13a85-5c6a-49ee-a152-568a3b0aef54` |
| 1819 | Leo's Chinese Restaurant | `ea9a11f9-7482-4b20-9e68-3e78e935d83a` |
| 1820 | Leo's Cuisine | `4ba621a8-cd3b-4f29-843d-11af3cea8048` |
| 1821 | Leo's Italian Kitchen | `984208ba-60c4-48e1-a80e-bebad08b0a9f` |
| 1822 | Leo's Italian Kitchen Boise | `5bdfff69-376d-4e3b-b5c1-733a2bbbd9cd` |
| 1823 | Leo's Italian Kitchen Huntsville | `8ef43149-b966-47b6-b0ee-de4dae962cfd` |
| 1824 | Leporini's Paninis | `1e0ef347-073e-486a-a5a2-fbaa733da606` |
| 1825 | Lexington Barbecue | `87650034-a609-48ad-b7c6-588075ba63a5` |
| 1826 | Leyla Fine Lebanese Cusine | `6f6a90e6-de97-4451-8ef9-a538472e6612` |
| 1827 | Liang's Village | `401c5359-60dc-4634-8a68-d825e64ebe5d` |
| 1828 | Liberty Burger | `9618f1b7-1c0e-405e-ac59-a2edf3d97a33` |
| 1829 | Lickity Chicken | `f29104be-65b0-4132-a95a-b5d76eeeb5c0` |
| 1830 | Lighthouse Catering | `089a9c75-3e48-4a0c-8554-43fea7362328` |
| 1831 | Lilikoi Boba | `2e148793-fea4-4921-9ebc-ba307286f18d` |
| 1832 | Limon Rotisserie | `3dc159fb-a12d-4c4a-95c0-fe17f9bd25d0` |
| 1833 | LIMóN Urban Kitchen | `239d3105-acf0-409a-a8cb-3958e974b3ec` |
| 1834 | Linda Renee Sweets | `2fb07e55-4b7b-4180-b335-18154df4ca4b` |
| 1835 | Lindsay's Boulder Deli at Haagen-Dazs | `7110e8b5-dfd0-4a6f-af8e-d418661e8bb2` |
| 1836 | Ling & Louies Asian Bar and Grill | `cc79ce00-5832-4336-babf-c6660bb05128` |
| 1837 | Ling's Wok Shop | `91e7ec9a-dd9b-4108-8f12-14d500292055` |
| 1838 | Lita's La Mexicana | `e8cba944-17d1-438f-b440-72b94d80c5f3` |
| 1839 | Little Caesars Pizza | `01b66cfe-fcb1-41f5-ae97-22fb26674b1f` |
| 1840 | Little Caesars Pizza Portsmouth | `b2c6a13c-4bd9-48dd-9a69-b2e7c7650861` |
| 1841 | Little Caesars Pizza Richmond | `2c974419-0123-49fb-85a7-2e1c9bb074aa` |
| 1842 | Little Caesars Pizza Spokane | `8ec0a105-a690-4c1f-897a-b5a3ca5534c0` |
| 1843 | Little Fatty | `0f5f54d7-a93e-481c-b696-89279e2d04da` |
| 1844 | Little Greek Fresh Grill | `367d4faa-d644-452c-8f09-e31611a4c7c7` |
| 1845 | Little India Restaurant & Bar | `55b2a715-7077-45e6-a5d1-d7900563a6da` |
| 1846 | Little Italy Restaurant | `39d36f5a-f9f1-4f22-ae92-71d40b4a2f1e` |
| 1847 | Little Line Kitchen & Provisions | `24e2faa4-3c44-4026-94cf-e46c56d358f9` |
| 1848 | Little Lou's BBQ | `12e3bd18-0edf-4069-aaae-75c229c77c44` |
| 1849 | Little Mesa Cafe | `1a23878d-9a11-4b3d-a7ee-7947da73aba2` |
| 1850 | Little Richard's BBQ | `9f041c07-857a-4ede-b966-3b324b4fcfa8` |
| 1851 | Little Rosie's Taqueria | `5dbbf356-73a7-47e9-91bd-6f219aa34a04` |
| 1852 | Little Tibet Restaurant | `fc34bef2-d20d-4743-a313-02c67d498396` |
| 1853 | Live Crawfish & Seafood | `c7285cf8-82a6-4aff-9e42-3e2b9d986c38` |
| 1854 | Liz Modern Asian | `88c75f04-17f8-4dcf-81e4-d10de06d39d5` |
| 1855 | Lo-Lo's Chicken & Waffles | `db0f21e3-eac9-47ff-8774-e047572f6fd3` |
| 1856 | Local Kitchens | `d2b66ae5-58b1-4995-ae87-bbaf8d6201c4` |
| 1857 | Local Pizza & Wings | `17524f21-5bb9-429e-8b30-9bceef7c9759` |
| 1858 | LoCascio's | `60ade187-e7b0-42c2-b8c3-2e1f6552ec78` |
| 1859 | Lockwood Distilling Company | `49110a9e-4dcc-4692-b979-c28be08ee21b` |
| 1860 | Logan's On the Road | `c7c43034-8b83-4ecf-953d-91e134b7f18e` |
| 1861 | Logan's Roadhouse | `3c9fe6e9-1383-4e15-b6ce-5440b9167dc5` |
| 1862 | Logan's Roadhouse Huntsville | `99bb1954-bbb3-429a-9082-96e888b5d5ba` |
| 1863 | Longhorn Barbecue | `7aade5a1-419e-498a-961b-36071354789f` |
| 1864 | Longhorn Catering | `0ac8f1f0-8876-4b56-9b9a-0cd6ef5d92ad` |
| 1865 | Lookout Tavern | `ffe07d3c-5584-4ce5-abe1-b07f7b4463ce` |
| 1866 | Lorenzo's Italian Kitchen | `aadc7bd1-c1a6-4a0f-b4e3-20b6095865b7` |
| 1867 | Lori Gobeli | `7208ca46-d1ba-4cb4-8010-419083ede671` |
| 1868 | Loro | `faf47cf0-e71a-449a-8cfb-96ed92562e33` |
| 1869 | Los Amigos | `a28866c5-0b3d-43f4-bb3a-8a6eea50824d` |
| 1870 | Los Cantaros Taqueria | `2602c856-f35c-4584-8d77-ccf07eed51e8` |
| 1871 | Los Dos Molino's AZ | `acda7e54-3599-4749-b86f-e994e00d04a3` |
| 1872 | Los Olivos | `ece221b5-8ad2-4a0d-ab98-95b4f2b99ebd` |
| 1873 | Los Sombreros | `136c5f0d-6a45-4322-89a3-9cbdca654f8f` |
| 1874 | Lotus Thai Bistro | `7a43fc11-1c0c-4d66-950e-cc996a85cb51` |
| 1875 | Lou Malnati's Pizzeria | `76aeecdf-07a4-473f-ac0f-164715708b09` |
| 1876 | Lou Malnati's Pizzeria Glendale | `109a6036-4220-4fcd-8e7f-a17a8584ebbb` |
| 1877 | Lovers Pizza & Pasta | `4f3c390b-c343-4c55-bb88-5ae38feb7f69` |
| 1878 | Loving Hut | `dd81b9fd-39b4-4adf-91f8-c63a1f255004` |
| 1879 | Low Country Quisine | `12c4eaab-0dc7-44ca-86ec-a4935422abe4` |
| 1880 | Luana's Coffee | `c0c03e09-55af-43f8-95cd-dd191e066e60` |
| 1881 | Lubbies Bagels | `542d536e-7451-4c04-a73e-2f3a4e242c78` |
| 1882 | Luby's | `74979e9c-5d17-4114-94e6-2d69ffeb4930` |
| 1883 | Lucharitos - Center Moriches | `cfc12be4-a400-4772-a10f-6762bbcac9a5` |
| 1884 | Luci's at the Grove | `2e67da50-a135-4e1f-a629-491aafe02b02` |
| 1885 | Luci's Marketplace | `1686b7b7-6c19-401a-b90d-b2563595ef28` |
| 1886 | Lucile's Creole Cafe | `45cc2120-4792-4935-b43d-968565adfd8c` |
| 1887 | Lucky Cat Poke Company | `5493f1d3-6252-49ec-b693-6eb14d6d2e74` |
| 1888 | Lucky Cat Poke Company Rockwall | `ba21712b-fc03-49cf-8ee0-952bda0e6113` |
| 1889 | Lucky Fins Seafood Grill | `7066a44c-33e6-440f-be4c-640fe5344d6e` |
| 1890 | Lucky's Hot Chicken | `c39689c9-6c1b-44ea-9960-5852d44eaa6b` |
| 1891 | Luckys | `6ce3484f-3971-4577-a60e-72f01fa910de` |
| 1892 | Ludwigs Biergarten | `b80a3353-02c4-4177-b92a-3e047a48d398` |
| 1893 | LuLu's Fine Pizza & Sushi | `75133615-a956-4428-af51-9bacb02f31e3` |
| 1894 | Lulubowls | `68c48be5-de13-41bf-9a21-339e884a4999` |
| 1895 | Lulubowls Dallas | `5955a4f1-84e6-413a-86cf-d080c68ce9ae` |
| 1896 | Luna Grill | `7192a558-a441-4ac0-8e4d-62afd7b86024` |
| 1897 | Luna Playa | `470b3dbe-8ef0-4391-9a71-965b76460986` |
| 1898 | MAC Pizza & Wings | `b944d032-addc-4859-a4c1-9b8bb170909b` |
| 1899 | Macaroni Grill | `6622a35c-c01c-47b4-8812-98297be3cf72` |
| 1900 | Macaroni Grill Milpitas | `d3fa8cb9-ecd0-4ac1-a194-2343f54c49c1` |
| 1901 | Macayo's Mexican Food | `6ea65e9a-daa6-45d9-8f50-ffb660d0fbbf` |
| 1902 | Macology | `75884382-0560-450f-a0e5-0d2ec515de7c` |
| 1903 | MAD Greens | `021890a5-6cdb-40ef-a0b8-1d31545f8649` |
| 1904 | MAD Greens Peoria | `59a26650-8504-48f5-bdd2-94a2861780d0` |
| 1905 | MAD Greens Tempe | `f370eeac-f56f-4199-aec5-5c1848a0b816` |
| 1906 | Mademoiselle Colette | `563b2ef4-cd9b-400b-9c52-a47225eddeb2` |
| 1907 | Madina Restaurant | `eae3a7f5-0013-4d57-99ec-4f2abfe7f3bf` |
| 1908 | Madurai Mes | `f2fd785d-90c1-4377-8e73-4bd0e5245556` |
| 1909 | Maggiano's Little Italy | `b056dfd0-ac51-49b0-a62b-4cb9dcd6a3f7` |
| 1910 | Maggiano's Little Italy Richmond | `de9dd53f-51e2-4208-8c33-902d26b55a4c` |
| 1911 | Maggiano's Little Italy Scottsdale | `d035ada2-8d0d-4b84-999e-0751f335d8b2` |
| 1912 | Maggie McFly's | `c0ca4a4d-0f57-4065-bfd3-d4e0743675f0` |
| 1913 | Maggie's Catering | `41b154d0-eb52-462e-ba7a-f5d5c11bf685` |
| 1914 | Magic Cup Cafe | `fbf1dd25-3d03-4806-8bae-384bbe7062f1` |
| 1915 | Maguire Bistro | `66075d4f-392a-48bc-9bfb-5ea87581f4b6` |
| 1916 | Main Squeeze Juice Co | `a35f7973-1214-4a84-bb3e-6860d334c75f` |
| 1917 | Maison Alyzee | `7986a048-3472-4b57-bee2-259a03280bc1` |
| 1918 | Maki Fresh | `8e4419f5-f1d6-4065-954e-8461f2ad1fe4` |
| 1919 | Malai Kitchen | `c2cad527-1f7e-4a78-bfd0-7b1ae7960480` |
| 1920 | Maldini's Ristorante Pizzeria | `5a9628e2-50d2-40b8-a01e-a90219da2730` |
| 1921 | MaLi Thai Kitchen | `f5305c2c-1832-47ce-8dcd-ec372950b726` |
| 1922 | Malibu Farm Restaurant  | `46e962b8-c77c-47b3-a302-b6cd746445ba` |
| 1923 | Mama's Daughters' Diner | `73876fc1-f4d2-4b5b-bd0c-40e272ad5505` |
| 1924 | Mamma Lucy's | `c4204764-2b58-490b-9d4d-2d98df67ac71` |
| 1925 | Mamma Ramona Pizzeria | `5a261c68-5b57-4691-89a2-963edb424b4e` |
| 1926 | MAMMA ROMA DELI & CATERING | `ffc9b976-853b-4abf-9572-331081159e4e` |
| 1927 | Mandrino's Italian Kitchen | `e3da7c09-1244-45b3-87bb-9fccf45eb55d` |
| 1928 | Mandrino's Italian Kitchen Glen Allen | `e2b1daa8-7c3f-49f9-8341-749b2d659dfa` |
| 1929 | Mandy's Fish & Chips | `6cf72101-9538-4579-b18f-b2917ad2c7e1` |
| 1930 | Manee Thai | `1c534880-7d2f-421a-805b-31d5b28ccdad` |
| 1931 | Manga's Mini Treats | `71712a0e-a49a-4b69-b548-02e9cc3a86b4` |
| 1932 | Mangal Turkish Grill | `8c9ca0a1-570d-4952-be06-b918db5159dc` |
| 1933 | Mangia Catering | `34d5cdac-b85b-4d7d-9b98-ca09e2a38756` |
| 1934 | Mango Rabbit | `4f2e0f33-543e-4af4-b565-a0dcb4e151bf` |
| 1935 | Mango Thai 2 Go | `2a42cddc-37eb-413b-86df-f571bf588aee` |
| 1936 | Manley's Donuts & Bagels | `1c978bc1-0682-4dbd-81b0-d85e8afd44cd` |
| 1937 | Manny's Uptown Tex Mex | `515adcdf-6181-4396-aaea-a30e72d8f3a1` |
| 1938 | Mantra India | `6b1a6519-19d7-430d-a511-1916e88a6176` |
| 1939 | Manuel's Mexican Restaurant | `92c7898d-81d0-402f-9ebe-2ec4d3c5a73b` |
| 1940 | Maple Landing | `cba98c8f-2525-4088-b518-cfec1fbc6dd3` |
| 1941 | Maple Street Biscuit Company | `fd97c3a1-b5f8-4a5e-8ccc-33a1dc731488` |
| 1942 | Maple Street Biscuit Company Madison | `48e17010-8740-4601-a458-155f8dca536e` |
| 1943 | Maple Street Biscuit Company Richmond | `ad402b36-e552-4486-a11f-c932c860d944` |
| 1944 | Maple Street Biscuit Company Wylie | `aaef80d6-f47d-4832-bc0f-a6243cec241d` |
| 1945 | Marble Slab Creamery | `15817641-af6c-4bf0-942e-149dd8d815f0` |
| 1946 | Marco's Pizza | `03d232c6-9d59-4768-9311-6fdd172ff8df` |
| 1947 | Marco's Pizza Athens | `f6506607-c7b2-4674-90d0-5ec7e7e50cf6` |
| 1948 | Marco's Pizza Boise | `265308fe-27cc-4d2c-aa1c-1517b2f6afbb` |
| 1949 | Marco's Pizza Chesapeake | `c143c993-67ad-4698-bdde-3a951e55bb82` |
| 1950 | Marco's Pizza Garland | `57727224-c0f4-447c-ad60-48b529fbdbc4` |
| 1951 | Marco's Pizza Gilbert | `e74cc0fe-7a60-4fbf-96b5-ec80ad1f6fc9` |
| 1952 | Marco's Pizza Norfolk | `16db4fa9-1ff8-484f-9bf1-f353887c8934` |
| 1953 | Marco's Pizza Phoenix | `bd37e889-c39d-4c81-bd73-d6c798bb89e5` |
| 1954 | Marco's Pizza Richmond | `ba9a278e-3946-4b1d-be48-e10fe1e19b58` |
| 1955 | Marco's Pizza Stuart | `ead9ef69-745f-48a8-864c-03639e1d6241` |
| 1956 | Marco's Pizza Winston-Salem | `10c2e794-6094-4952-9626-4af52b5bf0ea` |
| 1957 | Margaritas | `05f1a5e9-d8dc-43ad-af39-93bfbe005caa` |
| 1958 | Maria Andree Boutique Bakery | `7a3e385a-9a7b-410f-a3f8-86b73ef1bb8a` |
| 1959 | Marie Callender's | `39a7227e-805b-43b3-9b51-0d56654658cb` |
| 1960 | Marina Indian Restaurant | `da12f95a-d123-4576-90f5-8ac2971fee47` |
| 1961 | Mary's Mountain Cookies | `34106815-7796-40a5-a2ce-48e361eee515` |
| 1962 | Masala Wok | `51b5a2ef-d717-47ca-9f35-9a8b511c0525` |
| 1963 | Maskaras Mexican Grill | `193178cd-5f91-4549-bffa-16e5c08fae6b` |
| 1964 | Mason Dixon Bakery & Bistro | `4d8d6cfd-e43c-44fc-ace0-2c7fd1f6040f` |
| 1965 | Mason's Famous Lobster Rolls | `d4464b3a-5e98-4416-92a2-c13156eda674` |
| 1966 | Mastro's City Hall Steakhouse | `c86b70d3-9bd0-46e8-b6c1-038bf1257d70` |
| 1967 | Mastro’s Steakhouse | `0e6a40d5-16d4-4521-bb0d-3fbe3183f580` |
| 1968 | Mattito's | `1dc6216b-700d-4bd6-8a31-c97710e06afa` |
| 1969 | Maurice's Piggie Park BBQ | `3de53033-6a1e-4602-8b42-9430f3c209c9` |
| 1970 | Max Devros | `aad1113b-1e37-4c39-b643-849d94338525` |
| 1971 | May Dragon | `921bfd58-f57f-4f7c-baf1-01ff8d160295` |
| 1972 | Mayura Indian Cuisine | `4557b03d-2db4-4259-8f37-33bd9d58fe05` |
| 1973 | MBG Catering | `9d1ca4e3-cec4-4fa7-aa9b-b626c1b38eaa` |
| 1974 | McAlister's Deli | `9d6276da-92ee-4a60-92da-37f36787117d` |
| 1975 | McAlister's Deli Hampton | `ab7f185d-53a1-4b44-ac79-64383388255b` |
| 1976 | McAlister's Deli Midlothian | `1d25184d-2898-422a-ba23-630c8506e609` |
| 1977 | McAlister's Deli Peoria | `4f3a722a-8966-4dc6-b7d7-0fa3ea136fd8` |
| 1978 | McAlister's Deli Rowlett | `cb186824-4541-4fa0-a51e-f0c81a0ac85c` |
| 1979 | McAlister's Deli Winston Salem | `daa41486-3f68-4c64-b27e-97f9bf2e295d` |
| 1980 | Meddlesome Moth | `68222b64-15c2-4515-8df1-ea0203ffd586` |
| 1981 | Mediterranean Delite | `b1db2fc3-4d67-4977-ae86-17dc8bfb8d4e` |
| 1982 | Mediterranean Grill House | `93d20f9d-bde9-45f4-a75d-1207b8fb270f` |
| 1983 | Mediterranean Kebab | `a51728e5-da57-4ac7-aace-935a7520a696` |
| 1984 | Mediterranean Wraps | `fa582859-15ad-4c10-9847-1c2479c78be6` |
| 1985 | Mediterraneo Pizza & Grill | `f937a3ab-8c67-4a8e-b086-176be15d725b` |
| 1986 | Mehran Restaurant & Catering | `ff469bde-1b1d-4fa9-adad-7d38f8328de7` |
| 1987 | Mei Wei Asian Bistro | `c1f00d15-d58b-4ff7-b928-5e5a1c8be92a` |
| 1988 | Mellow Mushroom | `6d3bb9a5-3b33-4430-83e8-a867909b8f47` |
| 1989 | Mellow Mushroom Huntsville | `a5e7c710-9d6e-4c01-bd8e-9a23d9882f90` |
| 1990 | Mellow Mushroom McKinney | `26648f46-0739-46c4-8f28-5e21571ef502` |
| 1991 | Mellow Mushroom Phoenix | `cd28ea36-7407-42ac-ba8f-424912173f8a` |
| 1992 | Mellow Mushroom Richmond | `b02ed0f6-e763-42cf-b949-460b6e10feba` |
| 1993 | Mellow Mushroom Tempe | `a364ffbb-5507-469b-9a07-d7d443f66bc2` |
| 1994 | Mellow Mushroom Virginia Beach | `60752eab-c856-4a8c-9e96-938510e709c1` |
| 1995 | Mellow Mushroom Winston-Salem | `3e38bc91-23b2-46f3-b8ec-9be631762fbd` |
| 1996 | Melo's Pizza & Pasta | `0b2e15e3-6a4a-486f-b630-6354290e9103` |
| 1997 | Melt | `0f17cc13-6f23-4bcb-8ff4-694ebd34e4aa` |
| 1998 | Melt Shop - Maiden Ln | `6594dd01-dc28-4790-bd16-8da05a87d62c` |
| 1999 | Melt Shop - Midtown West | `0256284e-4146-4e64-a857-35e173ca7e58` |
| 2000 | Melt Shop - Westchester Mall | `53c2298c-fe2e-4c3c-aa6f-3dbc6fac8259` |
| 2001 | Menchie's Frozen Yogurt | `f6cd265f-35e9-4cab-9dd9-a9aeb60648fe` |
| 2002 | Menchie's Frozen Yogurt Fremont | `4d7e886c-c75e-4c5a-a5f7-d8e1dd1f3e75` |
| 2003 | Menchie's Frozen Yogurt Gilbert | `ca2ccae4-47a8-4ecf-a00b-033709349f6c` |
| 2004 | Menchie's Frozen Yogurt Plano | `dd934406-648b-4146-9d82-d505e21c553f` |
| 2005 | Mermaid Catering | `3008a175-1baa-48a4-9284-8405d8486b40` |
| 2006 | Mermaid Winery | `57bcb4e3-d960-41ae-9564-437cbb4e15d0` |
| 2007 | Mermaid Winery Virginia Beach | `7ebf7061-1c4f-4aa5-9c4f-b2ddf9dff3f1` |
| 2008 | MerryMaker Catering | `f8d2c700-54f3-4f8e-8d41-cd86250efc97` |
| 2009 | Mesas Mexican Grill | `b6721d16-d335-4b2a-8319-c73aa784cdc1` |
| 2010 | Meso Maya | `31bb7273-179f-4d84-89b3-e5df87f69e4d` |
| 2011 | Mesob Restaurant  | `c21ad852-f94c-4b41-ba18-ea4255b0868e` |
| 2012 | Mesquite Fresh Street Mex | `58503b58-cb9e-4eb9-a18e-541ffe5b7ef0` |
| 2013 | Mesquite Fresh Street Mex Phoenix | `865bbf49-6111-418c-a843-2016930b11a0` |
| 2014 | Messy | `be99c20e-3dc4-4380-a16e-ee51ecfcf024` |
| 2015 | Meta Burger | `1c4007d8-6391-4b7b-bd67-1a0b3fd96673` |
| 2016 | Metro Diner | `a1e77dcf-aab3-455a-b33e-51df7647cbc9` |
| 2017 | Metro Diner Chesapeake | `dad199c5-2d83-4609-b1fe-f5ada8606a99` |
| 2018 | Metro Diner Huntsville | `29c601b3-2866-4b2f-9349-677e3f85a932` |
| 2019 | Metropolis | `ca17211c-117c-4f50-baba-67266a0d1706` |
| 2020 | Mex 1 Coastal Cantina | `d31e5d92-ac16-4f70-abc5-9a35ece9b232` |
| 2021 | Mexi-Go Restaurant | `e5dea3ea-ccbe-4166-9961-976192f8ddca` |
| 2022 | Mexican Sugar | `e9795028-2812-4721-97aa-b029cdda6e13` |
| 2023 | Mexxi's | `52119ecc-58b0-40f2-bbb9-39bd290d1853` |
| 2024 | Meymuni Cafe | `cc4eb690-3d9d-4f46-92bc-a076946b2f28` |
| 2025 | Mezcla Maggie | `e73df218-20ae-44ca-a589-cbd25f4224ce` |
| 2026 | Mezeh | `d02d6b2c-b589-4068-baf1-a0e263ab0571` |
| 2027 | Mezeh Chesapeake | `9843a613-eeee-435b-b619-d605dcb0e27f` |
| 2028 | Mi Hacienda | `e8e6ca08-ed85-4737-8f84-4b2b494480cc` |
| 2029 | Mi Pueblo Mexican Grill | `140c64c3-af77-4542-af6c-24a3b7c45dbf` |
| 2030 | Midtown Cafe & Dessertery | `011629f7-1ea0-4bb6-845b-ba8ccaa73499` |
| 2031 | Midwest Wings XL | `114d41b2-2a7f-4698-8ce8-4e2bc105dfb1` |
| 2032 | Miel de Agave | `e8ab9d92-fab3-43e2-addb-de7ece784864` |
| 2033 | Mijana | `679f4c2c-f2d4-420b-b65b-3e462913894a` |
| 2034 | Mika's Greek | `ab83be11-579e-4535-a62f-d6948ae6565d` |
| 2035 | Mikayla's Cafe & Catering | `662565d2-a537-4c52-8d07-1fc3cf5ccf4d` |
| 2036 | Mike Anderson's BBQ House | `10d33a5e-0e09-4463-8648-f92db167e9c8` |
| 2037 | Mikhael's Cafe & Catering | `cd45dca8-ebe4-48d1-a891-8bca0b2c81f9` |
| 2038 | Mile End Delicatessen | `2cb91e10-78e8-4cbe-a5a1-1fffba8f5559` |
| 2039 | Mile High Pho | `cdcca7a5-7ca9-445d-bec1-f19c9a534ebd` |
| 2040 | Mill Creek | `12b4f6b3-03a3-418a-8e55-1bc07693bd54` |
| 2041 | Miller's Ale House | `0d7bf7ba-6080-4e01-9666-9cfb5ee9279e` |
| 2042 | Milwaukee Joe's Artisan Ice Creams | `879f1dcb-e80c-4d3e-a17e-7b8894b90456` |
| 2043 | Mimi's Cafe | `bbcb10ff-bf4c-4f39-b7a5-2cd559633ed1` |
| 2044 | Mimi's Cafe Glendale | `f9acd80e-b8e7-4ec9-9d6b-c988a46ab235` |
| 2045 | Mimi's Pizzeria | `2a659ff7-4fb7-484a-8be9-eb243f6ce3ce` |
| 2046 | Mimi’s Too Bagel & Deli  | `422df751-0c23-4b10-986c-43488030c3c3` |
| 2047 | Minero Mexican Grill & Cantina | `3843c7a0-1765-416f-b36c-e4e01ed950da` |
| 2048 | Ming Garden Chinese Restaurant | `407e739f-ee8a-4eec-a855-afe7a9867469` |
| 2049 | Mini Mart Caribbean Grocery & Cuisine | `cc80d46a-d7e4-4864-bf22-69d3267a53b9` |
| 2050 | Mint & Limone | `253631a9-cdf7-4f13-b0bd-c987514a752d` |
| 2051 | Miracle Mile Delicatessen | `e02caa4a-e579-4d02-aa47-303b36592f4e` |
| 2052 | Miracle's Tasty Express Hotdog | `96dc8a05-63d1-4a93-87e2-3cf2062b7177` |
| 2053 | Miriam Cocina Latina | `06c45364-2b0d-462b-a33a-f2599f135008` |
| 2054 | Miss Pasta | `165d5eb0-85f7-4931-8697-f8cad1c10dfc` |
| 2055 | Mission Sandwich Social | `ccdcf510-7b06-4643-811f-5d9e164ca8ff` |
| 2056 | MISSISSIPPI BOY CATFISH & RIBS | `814e1dab-5697-4dc0-8734-0cc9b747312b` |
| 2057 | Mister Tater’s Tater Shack | `8c0eb40b-a615-44fb-849e-8c574cafdbee` |
| 2058 | Mixing Bowl on the Go | `d5d11fc9-8195-48d9-ba00-c7e9bd8f87a2` |
| 2059 | MIXT | `e476e29e-91f9-4da0-9351-51df8be44ab8` |
| 2060 | MIXT Dallas | `6384b180-48d3-4304-8467-4df0e8aeda1a` |
| 2061 | Miznon | `b5d98b17-5fe4-454e-88fa-b81e0261618d` |
| 2062 | Miznon Dallas | `9a4808d8-2fdc-4fc1-8a89-fba2451366ef` |
| 2063 | Mo' Bettahs | `e9cbc480-8355-4dbd-9783-ad386baa402e` |
| 2064 | Mo' Bettahs Sachse | `9788622d-1abf-4fcc-8ac3-f40aa4a36ed4` |
| 2065 | Mobile Yum Yum | `732414ea-b155-4ec7-9bc0-66a099058876` |
| 2066 | Mochi Waffle Corner | `84c418ac-b78a-4215-a84e-54569deacf83` |
| 2067 | Mochinut | `39ce5c5d-f6bb-4c62-8019-76689a955454` |
| 2068 | Mochio Mochi Donut & Boba Tea | `a8e4eb95-4db4-4a3b-91fe-1be0646c229a` |
| 2069 | MOD Pizza | `9bdef093-390a-4ad9-aaa3-fd8852d1e230` |
| 2070 | Modak Korean Chicken | `05224154-3f0e-4c28-a2d0-ac98a1ee7711` |
| 2071 | Modern Catering | `72e5a403-2986-4d75-be87-5d52e874247d` |
| 2072 | Modern Market | `10095c2a-3321-447c-a733-4863dffdd13e` |
| 2073 | Modern Tortilla | `ce5b4f74-971c-493d-8fee-0ac1ef9df1c2` |
| 2074 | MoDo Hawaii | `2674c6ab-b3d8-47d7-bba0-2461902e72bc` |
| 2075 | Moe's Original BBQ | `7d2e499e-362d-490f-8fcb-4b62d2ce312b` |
| 2076 | Moe's Original BBQ Huntsville | `5e3ddc80-9901-4450-87fe-e9ccaf6607be` |
| 2077 | Moe's Southwest Grill | `e86e25b8-b93b-41e1-b2cc-1dfa8040884f` |
| 2078 | Moe's Southwest Grill Chesapeake | `43835025-c0c1-436b-a324-ba5971400509` |
| 2079 | Moe's Southwest Grill Goodyear | `4ffd2317-e824-4891-abe4-0567e9043df5` |
| 2080 | Moe's Southwest Grill Huntsville | `0ddae6e9-9f37-4f30-8c53-7b1376c46bbc` |
| 2081 | Moe's Southwest Grill Mechanicsville | `900ee609-c622-492c-85a6-309c4454c725` |
| 2082 | Moe's Southwest Grill Norfolk | `a1ade320-2dfe-4938-9513-dd96237528af` |
| 2083 | Moe's Southwest Grill Port St. Lucie | `8c13ecb8-8a96-4420-a513-196a4655dafe` |
| 2084 | Moe's Southwest Grill Winston Salem | `67ba5f95-4535-49a5-a22d-578ec4a056bd` |
| 2085 | Mohinga Asian Food | `818e58f7-3848-4ae0-bcc4-2a579d06dcf0` |
| 2086 | Mojo Taqueria | `bfca3754-4c05-4fc5-9bea-9339f66e8937` |
| 2087 | Mommies Catering  | `10ff5ace-1816-4217-913b-b270a0620320` |
| 2088 | Mommy's Banh Mi | `e02f4166-14a1-4728-b669-5b9f92abe198` |
| 2089 | MoMo's Pasta | `01a80cae-e338-43b0-8481-831f54cdcdee` |
| 2090 | Momosan Ramen & Sake | `d719c052-1895-4313-9c4a-7cc92658ec41` |
| 2091 | Mona Lisa Pizza | `97ebff63-bd93-429c-8758-cf7ce025c485` |
| 2092 | Mondo's Pizza | `22086568-8b15-4c71-8b17-218290d0cf13` |
| 2093 | Monroe's Hot Chicken | `ac856a3c-01ae-46b4-931f-1c388a6b1d5b` |
| 2094 | Monster Yogurt | `c5091d66-6549-4638-a913-52d95d91fde3` |
| 2095 | Montana Gold Bread Co. | `ac365aad-61f0-4ff1-889c-7bec67b7d049` |
| 2096 | Moom Muum | `8b02ab25-3df8-46af-b1ea-c81a884a03e2` |
| 2097 | Moon Valley Cafe | `f7838dd2-dc1c-4f40-a013-a8f6d50f1ca7` |
| 2098 | Moon Wok | `29dac6e4-28e6-4983-bff3-ebc754207f4e` |
| 2099 | moonbowls | `c5e70c03-a59b-4ebf-9fbf-e8d2360fa0ab` |
| 2100 | moonbowls Dallas | `ef787efb-34a8-4ec4-b94d-a8a77001b15e` |
| 2101 | MOOYAH Burgers Fries & Shakes | `26763440-a798-46f7-9ff3-58dafddf7c62` |
| 2102 | Mordisko & Salsa | `488395b3-bdc4-4016-b8d5-33cbe663cba4` |
| 2103 | Moreno's Mexican Grill | `af40bc70-67ef-4809-9e2b-b48f3b104e4a` |
| 2104 | Morrissey's Catering Co | `26680c99-fb02-4e4d-920a-d78d94731400` |
| 2105 | Morton's The Steakhouse | `720a3d01-42e6-4e9a-bb90-38a7ba23b5ce` |
| 2106 | Moses Specialty Kitchen | `cc089d82-24a4-4ab9-8427-b5ae656a01de` |
| 2107 | Motomaki | `aac8ce83-4b7a-445d-8dd3-1f5cd34ec63f` |
| 2108 | Mount Everest Momo Cafe | `9c0ef5eb-68d4-4ea5-80b7-d9ef5614798a` |
| 2109 | Mountain Mike's Pizza | `37d8ed6f-7960-469e-8436-965a595fa0d6` |
| 2110 | Mountain Mike's Pizza Lewisville | `de48242a-9c0f-407a-8417-a2d343d27b16` |
| 2111 | Mountain Mike's Pizza Meridian | `0f2dbdb2-a91e-427e-b629-2e548107efb8` |
| 2112 | Mountain Mike's Pizza Surprise | `55ad950a-12fc-4143-82f3-ffa9ad728601` |
| 2113 | Mr. B's Restaurant & Catering | `41a3f7d8-6e08-4001-9c1c-2d1f898232c6` |
| 2114 | Mr. Natural | `a4797224-417b-49f1-a0d7-e7831fd11018` |
| 2115 | Mr. Pickle's Sandwich Shop | `5a97c709-6f2f-4162-9544-28222fa9c5dd` |
| 2116 | Mr. Pickle's Sandwich Shop Phoenix | `ef371960-f0e8-4199-b57b-1d7c98706688` |
| 2117 | Mr. Pickle's Sandwich Shop Scottsdale | `ce02805d-a380-4e49-a27e-8606c60392f6` |
| 2118 | Mr. Pizza Man | `43a44f27-d4a9-4bac-a507-c21ce02c3af4` |
| 2119 | Mr. Pizza Slice | `1691a774-d1ef-4ed5-8f1c-32734f6ac1fc` |
| 2120 | Mr. Shawarma | `e3abf379-7875-4bb1-852b-f965256d54e5` |
| 2121 | Mr. Shawarma Virginia Beach | `edfe955e-5a6a-4f55-a363-d6c6a2f14f88` |
| 2122 | Mr. Taco Man | `cd538b70-9f49-4312-bda3-98ec100e6f2d` |
| 2123 | Mrs. Fields Cookies | `32ed799a-ad7c-4a15-bbd3-cc0cc6022d09` |
| 2124 | Mughlai Indian Restaurant | `919d8443-a2bf-423d-b44e-e791ceeb4be2` |
| 2125 | Mugizo San Jose | `ee916de6-5767-4633-8854-fb043dce8f62` |
| 2126 | Mugsy Dogs | `e13b641c-d91f-4fb4-987a-43f403cd8389` |
| 2127 | Mumbai Chowk | `0d421010-f39b-422b-9f85-3e1e03446051` |
| 2128 | Murphy's Deli | `a8e9d58d-bf7b-4e9d-9c18-5e588d5cc3e7` |
| 2129 | MVPita Mediterranean Grill | `692bd4fe-ce7e-4d88-980e-c696b4f693bc` |
| 2130 | My Big Fat Greek Trailer | `10b6cbc7-a532-403f-a081-d4b62f333ae2` |
| 2131 | My Dumpling | `af25f279-ccb6-4c3d-a4d6-b0fe07298076` |
| 2132 | My Empanada | `e1284cf4-c5f1-4e3b-ba00-2a55c01b6aa6` |
| 2133 | My Hero Kitchen | `6b4c8f9d-943a-4bf7-8114-da48714803e7` |
| 2134 | My Indian Pizza | `e796588d-7174-411d-bdfd-ad1be0f6522a` |
| 2135 | My Life Cafe | `a370e3f1-9070-4c34-94d5-de92fd437169` |
| 2136 | Mykonos Meze House | `a952a643-0986-41dd-aec1-6657aed7a212` |
| 2137 | Myungrang Hotdog | `4a93e23e-1b04-49a0-b203-10894fbde5dc` |
| 2138 | N.D.A Cuisine | `6606fe1d-8fea-4ab3-8b6e-325895bd5e43` |
| 2139 | Naan & Curry | `5913d52c-f275-4359-9174-ea3472a98641` |
| 2140 | Nadas Colombian Gluten Free Empanadas | `e6901317-48f8-47c3-bbdd-50fef0dcc294` |
| 2141 | NakedQ | `0f704fd4-cb5a-423b-ae0b-76c2c7fcd038` |
| 2142 | Namaste India | `df615f98-b82f-4d67-abdb-699d4aaa3638` |
| 2143 | Namkeen - Astoria | `f127467e-0567-4d3f-933e-4fb94e200cad` |
| 2144 | Nana Dot's Southern Sweets | `47fef504-800a-442d-a557-249f29326b30` |
| 2145 | Nana Morrison's Soul Food | `1b08d18f-1ada-40b6-9108-06ad83dc4bab` |
| 2146 | Nana's Dim Sum & Dumplings | `b6e0a462-8c27-4de3-af9a-8f303fa80084` |
| 2147 | Nando's Mexican Cafe | `0f6fb4a8-33d1-4dfd-bdcd-745690613525` |
| 2148 | Nando's Peri-Peri | `2a7d3382-b0a3-49c2-832e-e733564dae5d` |
| 2149 | Nando's Peri-Peri Dallas | `3e136201-57cf-4e68-8cbb-74cd4fbe2100` |
| 2150 | Nashville Hot Chicken | `e7843f69-5eee-4e77-90b6-5fae820f0a1e` |
| 2151 | Natalie's Taste of Lebanon | `0b9fc57c-8d9b-4f20-bfe2-b5287df2ef97` |
| 2152 | Native Grill | `f9a95126-3562-4294-a07c-7e1ceb2e3e7c` |
| 2153 | Natuur Bowls & Smoothies | `75ea8586-582b-4daf-be05-44bd0b610699` |
| 2154 | Nautical Bowls | `95c7e24e-0174-46ff-bd8e-47728d5e6110` |
| 2155 | Nautical Bowls Huntsville | `c2585e9e-9685-4a42-a396-3661f0f437ff` |
| 2156 | Nautical Bowls Phoenix | `9f757b4f-034b-4edc-83f4-88046aaca0ad` |
| 2157 | Navah Coffee House | `4393a46a-01b6-4a4a-bbe0-4d54243c930c` |
| 2158 | Nawabi Hyderabad House | `ed33bdea-c342-479f-9003-61cd1bd7a54a` |
| 2159 | Nazareth Restaurant & Deli | `5445769f-f3ad-47a2-a0b9-f289ce4a54c0` |
| 2160 | Negeen Restaurant | `4d84e0a0-aa43-4725-baf9-f342ba7a40ef` |
| 2161 | Neighbor Tim's BBQ | `3936cedf-9ed6-4ab3-ab77-c8df0e51d334` |
| 2162 | Nekter Juice Bar | `d6b250d0-96b8-456a-aa35-fea03eccb27f` |
| 2163 | Nello's Pizzeria + Italian Kitchen | `f19c4631-76cc-4dcb-bf0a-2778f0f9d3d1` |
| 2164 | Nelson's | `f8af17be-1861-4a8a-aa4b-f16efccadff4` |
| 2165 | Nest Burger | `e227b9a2-29b2-4a5c-a3ed-2d51a52e272e` |
| 2166 | New Canton Restaurant | `9459a783-f70c-4299-ac5c-fed551441ad7` |
| 2167 | New York Bagels 'N Bialys | `4e1d18cc-7518-4ffb-a8f8-0ab423290faf` |
| 2168 | New York Deli News | `7e1ee67e-c6b3-4e84-b061-6e9a0ecee815` |
| 2169 | New York Pizza & Pasta | `38d0615f-1d61-4edc-8c82-877cb8819d23` |
| 2170 | New York Pizza Dept. | `fa860953-8ca4-46fd-ad29-4d629f3bcb38` |
| 2171 | Newk's Eatery | `2ada5ff9-3b5c-4529-b837-65773431615e` |
| 2172 | Newk's Eatery Huntsville | `54f04c8a-5300-4f90-8173-c0253dedb948` |
| 2173 | Newk's Eatery Plano | `30e3e82e-2410-4642-8786-3bd31ff74804` |
| 2174 | Newk's Eatery Summerville | `b493757f-a879-43d0-84de-ccb0b2e90b7c` |
| 2175 | Nick The Greek | `8f7d7a4a-965f-44d3-ba52-fdf872984255` |
| 2176 | Nick The Greek Irving | `8f78c6a9-7b0a-45f1-af88-6d86e2dc1e72` |
| 2177 | Nick The Greek Phoenix | `a24e049c-eb41-4e98-8650-f337886c8cb0` |
| 2178 | Nico's Tex Mex Cantina | `d334d33c-a465-4c7c-961f-4af1ac46ea73` |
| 2179 | Nidhi Caterers | `54415120-2a1d-4759-a4aa-96111d1419e6` |
| 2180 | Nigel's Good Food | `721c9ba8-c307-4183-8203-9958695075a9` |
| 2181 | Nika's Confectionery | `ebdd90a1-e9d6-4c84-8d14-750be2af7ffc` |
| 2182 | Nikki's Popcorn Company | `289e7db8-2d25-4bfb-be05-1ed59177a676` |
| 2183 | Nkechi's Pot | `73bb6931-e796-4af2-83d6-b7c964085879` |
| 2184 | No Bull Burger Bar | `50f465d0-0208-46a2-a6d1-bd29d5d8c38f` |
| 2185 | Noah's New York Bagels | `6fcd2d2f-1003-4ccb-8b7d-7b06a8e33e9f` |
| 2186 | Noble Restaurant Co | `c5049704-b981-4fb8-a41f-d56ebd1cacaa` |
| 2187 | Nomad Deli and Catering Company | `80a228b0-9b2d-4a11-8458-8877c5a5952c` |
| 2188 | Nonna’s Pizza and Sandwiches | `83a18d3b-bf98-4746-91ac-307e4465f6c0` |
| 2189 | Noodle Wave | `48352084-53c5-45df-b4e6-092a98c50ff1` |
| 2190 | Noodles & Company | `39815f97-462b-45ac-8963-3d1a0352a720` |
| 2191 | Noodles & Company Boise | `c8f46ea4-9793-419d-9666-cbd4315caa8c` |
| 2192 | Noodles & Company Norfolk | `e3a72657-f5cc-49ea-910a-49c0177ee1c9` |
| 2193 | Noodles & Company Peoria | `facfd745-6474-4f2b-a781-7eb588a8056e` |
| 2194 | Noodles & Company Richmond | `77a18a18-0321-4fd0-8dcc-173ea2332ce8` |
| 2195 | Noodles & Company Tempe | `e3a3959a-1490-44ef-817f-38a6c708b701` |
| 2196 | Noor Kitchen & Cocktails | `96f6f7f1-9a94-4e9c-8dab-3d720f5adeb2` |
| 2197 | Noorsha Cafe & Catering | `a7c3ce0c-5748-4e23-b951-8a2a4384d4d3` |
| 2198 | NoRa Asian Fresh | `77dc2fcc-2c7d-4bb9-bd28-dcf8b35600dd` |
| 2199 | NoRa Asian Fresh Phoenix | `409bdda0-5771-4efd-b359-c589481f8bea` |
| 2200 | Norfolk Catering Company | `1b9f4a6e-b8b3-4c6c-abdf-c30beb1766af` |
| 2201 | Norma's Cafe | `ddefaf0a-872e-4c0f-9b06-b11c5882c384` |
| 2202 | North Beach Pizza | `8b4d5f5f-8dbd-4079-a41f-ef972aa0adb3` |
| 2203 | North Beach Sandwicheez | `f06b153e-343f-4ebc-b6ba-5a1f8f5dde38` |
| 2204 | Nosh Box Eatery | `3fa1fc5f-fdad-4d7b-becb-abebcead3491` |
| 2205 | Nothing Bundt Cakes | `4067338b-4a99-4522-bb97-44005c177aa0` |
| 2206 | Nothing Bundt Cakes Fremont | `65540fae-b217-4149-afe6-5de5453fdce2` |
| 2207 | Nothing Bundt Cakes Garden City | `a5e3a05b-d1b7-4e8f-8201-2d1b3675c495` |
| 2208 | Nothing Bundt Cakes Glendale | `e4e0e42b-af35-4ffe-8f54-664c85b21303` |
| 2209 | Nothing Bundt Cakes Phoenix | `a4c2753b-c786-4c01-b40b-17915cbee2ba` |
| 2210 | Nothing Bundt Cakes Richmond | `21201b13-bd7a-4294-acc1-8b2abb152640` |
| 2211 | Nothing Bundt Cakes Rowlett | `98ef6d6a-b017-4cdc-b653-530a3a53e074` |
| 2212 | Nothing Bundt Cakes Scarborough | `84cea71e-7d2e-4524-921d-f2bace25ed58` |
| 2213 | Nothing Bundt Cakes Spokane | `52f179b3-dd31-41ff-a592-a45d34e529f0` |
| 2214 | Nothing Bundt Cakes Winston-Salem | `87d95e34-4117-4694-b07f-9522549633f6` |
| 2215 | Nothing But Noodles | `aca9039a-87aa-4170-8cdc-d613ccb86026` |
| 2216 | Notova Cafe | `0091fa08-420e-4d90-97c8-0f4bba427168` |
| 2217 | Nox Cookie Bar | `74c1b265-3086-4617-a023-2b059b6c364c` |
| 2218 | NTT Nutrition | `55bf673c-773a-498b-a6d9-f5dc977d22de` |
| 2219 | NYC Bagel & Deli | `bf5dbba6-8633-422e-91bc-36b6ddc29c63` |
| 2220 | NYC Catering Company LLC | `92218093-9648-4d63-babd-82cb90612065` |
| 2221 | O'Charley's | `a4c37baa-1658-4a11-bc6e-30e7e0d95651` |
| 2222 | O'Desi Aroma | `a634da87-817d-4bbb-8e50-8706a67cabbe` |
| 2223 | Oak Ridge Bagel & Deli | `3f419a5a-fe8f-407e-9b55-2548577c4add` |
| 2224 | OAK'D BBQ | `db7f91d1-c773-43ab-855e-2283c9bfdf8c` |
| 2225 | Oakland's Grind Coffee House | `60fcef5d-1795-4fdb-8309-574e21930f4a` |
| 2226 | Oasis Bagels | `fc642ce2-8651-40b7-a875-196906d4fbd7` |
| 2227 | OBAO | `b4938622-ed39-4c16-ab5e-6deb7de85c7e` |
| 2228 | Oceanic Thai Kitchen | `0f3c2d7b-ef93-4726-af65-626d4b4952df` |
| 2229 | Odd Duck Market | `e18db007-ac30-423d-b255-99288f078b44` |
| 2230 | Off The Record | `fe620101-1bec-4f41-8ece-480c4210dacb` |
| 2231 | Ogi's European Bakery & Deli | `0154054a-ef7b-4386-9722-11f4005fa877` |
| 2232 | Ohana Hawaiian BBQ | `a8cc20df-59be-468a-9ffe-19c5d3cb3788` |
| 2233 | Ohlone Deli & Catering | `b0a04fa6-8636-4286-8f75-6600314c0672` |
| 2234 | Old Chicago Pizza & Taproom | `76c0f2d6-2e40-4eb1-a08d-127a4f662201` |
| 2235 | Old Chicago Pizza & Taproom Boise | `4bcffef5-bf85-48fc-8718-ee01407c6784` |
| 2236 | Old Chicago Pizza & Taproom Chandler | `961f5a46-3a39-4fa5-89e8-9dc887873c3c` |
| 2237 | Old Chicago Pizza & Taproom Goodyear | `4e55c886-eaa1-401a-a7d2-6bf529a736e2` |
| 2238 | Old Hag's Pizza Dallas | `9421c981-7884-4560-81d8-8272973b0ee2` |
| 2239 | Old House BBQ | `52563e91-0447-457a-b26d-2644637b67ae` |
| 2240 | Old Man Rafferty's | `36eb32d9-25c3-44f3-95e5-d1f5106cb7a3` |
| 2241 | Olio | `1f45a412-d390-4606-b9e6-6b30cf58ab2a` |
| 2242 | Olive and Oak | `a9811632-7894-48f7-b17f-4147431f47ef` |
| 2243 | Olive Burger | `a01f74a5-02e5-4e3c-a749-328853983cbc` |
| 2244 | Olive Garden | `6b52b5ac-d829-4202-a117-ad04e3710e0d` |
| 2245 | Olive Garden Bend | `a65d24b1-14d3-4c48-a003-b90bfac3c66d` |
| 2246 | Olive Garden Boise | `6e259da9-049d-4c1c-bdaa-c52e9d6b3987` |
| 2247 | Olive Garden Fremont | `3901db27-85e0-46a6-aefb-0a6eedf73046` |
| 2248 | Olive Garden Garland | `f4803b6f-5685-49f0-a81f-06e95063ac30` |
| 2249 | Olive Garden Glendale | `063ff21c-377c-456c-bd8b-03f2876bfd2b` |
| 2250 | Olive Garden Henrico | `1b400226-9f8f-4c0a-a352-b67fc6573624` |
| 2251 | Olive Garden Huntsville | `08a9d8d2-70fb-4f06-8aea-6f7e8d10c088` |
| 2252 | Olive Garden North Charleston | `b3b561f6-d7be-47fe-9295-9731a908255b` |
| 2253 | Olive Garden Port St. Lucie | `5bac0089-eeae-4cec-8e68-72801eef931d` |
| 2254 | Olive Garden Scottsdale | `a627c299-8eb2-47f4-9f9a-f762065876c0` |
| 2255 | Olive Garden South Portland | `982d1b05-ae46-43ae-8d78-267f456d6dc3` |
| 2256 | Olive Garden Spokane | `6303d93c-ddca-4b06-8f3c-f8aba5df5340` |
| 2257 | Olive Garden Winston-Salem | `7d1734f6-7184-4cac-a9aa-7834530c7227` |
| 2258 | Olivella's | `ef920f14-472a-4afe-81c6-e0e0f6a8f0ef` |
| 2259 | Olobe's Kitchen | `014c21e1-9f88-42b0-8d8b-4669004dc94d` |
| 2260 | OMO Catering | `042b2e73-22c0-43ca-8d61-c5b505fff261` |
| 2261 | On A Roll Italian Subs | `c6d75c0e-eabe-4e38-8222-44ff1de11d7b` |
| 2262 | On Rotation Brewery & Kitchen | `b7acaecc-00a3-45c5-ba36-38b1eb5c9ae1` |
| 2263 | On The Border | `3b9d5783-598a-426e-9af0-263f1fdea9cf` |
| 2264 | Onassis Greek Taphouse & Kitchen | `f4c0aadd-7b6c-43f3-9575-6437fbd808e8` |
| 2265 | One90 Smoked Meats | `667c9e5d-99c5-4b86-9638-b0d3dd512172` |
| 2266 | Onigilly | `d6b409ef-880e-4a9d-9bbf-da637d0a7c11` |
| 2267 | Opa Greek Taverna | `03e631d9-ebb2-4240-9a20-a6c035396d85` |
| 2268 | Open Crumb | `9d648552-a319-4938-948f-9be479e54e51` |
| 2269 | Open Sesame Lebanese Grill | `58bef623-5be9-4908-af9b-e2ccbefe9774` |
| 2270 | Operation Brew Coffee and Bakery | `aeefacaf-f29b-4d08-9763-95fd19be5088` |
| 2271 | Ophelia's Wines & Bites | `c8068a3e-3fbe-4f99-94f0-dff0ac648558` |
| 2272 | Orange Leaf Frozen Yogurt | `240f6d12-7e45-4209-81f0-04ea26b55f1d` |
| 2273 | Orapax Restaurant | `eabc0ac2-4185-41de-8f7c-9c2ec7a69952` |
| 2274 | Oren's Hummus Shop | `9156724c-e500-4b48-837d-892e0d976aac` |
| 2275 | Oreste's New York Pizza | `688a7b3e-4660-4d6a-9a75-8daeac0101e9` |
| 2276 | organic krush | `506f2209-e4fe-4d2f-90cd-b3a8303daa21` |
| 2277 | Organic Sandwich Company | `b6174de7-72d2-4604-921a-2bf198bdd43a` |
| 2278 | Original ChopShop | `46a315da-2711-4a4c-8abe-236008b89d9e` |
| 2279 | Original ChopShop Phoenix | `d02dfd11-e4a7-4844-8227-1aeae07cd515` |
| 2280 | Original Mexican Restaurant | `4ddcdfad-2782-4083-872d-252497ca76f6` |
| 2281 | OTTO Pizza | `c376003e-218b-4060-88f0-189c3fd115dc` |
| 2282 | Out of the Cave Foods | `3a4a12d7-4607-4207-b523-549e939509a3` |
| 2283 | Outback Steakhouse | `14f858ea-26a4-45ae-a407-988a11fe4fbc` |
| 2284 | Outback Steakhouse Boise | `68beed99-e551-4e15-8a62-9c5ab55af721` |
| 2285 | Outback Steakhouse Garland | `1925e4dd-afa6-4f06-9f11-83811c58da72` |
| 2286 | Outback Steakhouse Glendale | `3e24979f-f904-40d3-b094-d38115cf1c71` |
| 2287 | Outback Steakhouse Mechanicsville | `f325fc9d-c8b8-448d-acbc-666e02d90feb` |
| 2288 | Outback Steakhouse Port St. Lucie | `80e932be-e7ed-44f9-a54e-40cf7c246c91` |
| 2289 | Outback Steakhouse Spokane | `4f189d28-74db-4540-afdd-5307bf3ac9c6` |
| 2290 | Outback Steakhouse Virginia Beach | `44545ec6-d1d2-4781-9d6b-f761ff9ec256` |
| 2291 | Over Easy | `b8822ac5-4b79-4048-8fc9-0bd073c5a90a` |
| 2292 | Oyster Bliss | `fc4b9189-f012-4cb8-9a69-04fdcd688974` |
| 2293 | P.B.E. Catering | `c948c3cf-aed2-4dc9-bb74-36914d052441` |
| 2294 | Pacific Catch | `3dca18e9-931a-4a14-86e9-fa8d92f7f5f8` |
| 2295 | Paciugo Gelato & Caffe | `6ff5c0fe-7a8d-4b85-9bc6-b2ce22d5c062` |
| 2296 | Packin Bowls | `aad128a5-a23b-429f-b400-bdd93679cf0f` |
| 2297 | Padow's Hams & Deli | `d6154a5b-3f8b-4302-84b4-963b2f079e47` |
| 2298 | Page's Okra Grill | `678dac34-befc-475b-9225-9c7ef99f084a` |
| 2299 | Paisano's Pizza | `f8cc05b1-757f-4df5-bd79-42aa939e6f75` |
| 2300 | Pakwaan Indian Cuisine | `3a054271-e11e-405a-89e4-66b89c27da31` |
| 2301 | Paleo Keto Catering by Sapiens Kitchen | `9eaa8716-9146-4158-97e2-7737148d6dde` |
| 2302 | Palio's Pizza Cafe | `35178cee-b1d9-4576-ba76-516977c059f7` |
| 2303 | Palmer's Hot Chicken, Catfish and Shrimp | `5481e58b-6916-4c2c-9b6a-c1bed7577347` |
| 2304 | Palmieri Cafe | `a34bc709-3790-416f-97ca-7a4381246e8c` |
| 2305 | Palmita | `2b82562d-a2be-4af6-8395-efd4106b8c2b` |
| 2306 | Panda Express | `9baacce6-e4ce-4a14-862b-e4b7f9bb2356` |
| 2307 | Panda Express Garland | `4b35c6ab-3c06-44f8-a5b9-f806258513a4` |
| 2308 | Panda Express Glendale | `4d3623c9-46f4-4457-829d-1d1172f836c4` |
| 2309 | Panda Express Huntsville | `55d698de-c512-4e27-8530-c5253b78c52e` |
| 2310 | Panda Express North Charleston | `8176eed9-b95e-4a93-add3-2f7a15e72094` |
| 2311 | Panda Express Port Saint Lucie | `9023f0af-9909-475b-8954-6ac253076dfe` |
| 2312 | Panda Express Richmond | `ed88db48-4d11-490e-999b-986b005d97cf` |
| 2313 | Panda Express Scottsdale | `515ed639-d636-45c3-a385-bc1b990ec883` |
| 2314 | Panda Express Winston-Salem | `e83edfa3-bfa6-4e60-bdd9-eca667d0ab25` |
| 2315 | Panera Bread | `60039074-331a-417b-8f0b-ad4c33e2e7e5` |
| 2316 | Panera Bread Boise | `717ee6eb-f808-4ce0-ab7a-79b907f9da0e` |
| 2317 | Panera Bread Boulder | `e5b3544a-9c4b-4ee7-aa97-09513c47ea00` |
| 2318 | Panera Bread Charleston | `a00ac011-3212-46b2-af47-7f488f37e8fc` |
| 2319 | Panera Bread Chesapeake | `c5a96e02-ad9a-4bb1-88e4-a7d1e8352802` |
| 2320 | Panera Bread Fremont | `88b0052f-3fc3-4c3f-bca1-19f2072f36b1` |
| 2321 | Panera Bread Garland | `c532eedf-258f-432f-9dd9-f7dee0ede5d7` |
| 2322 | Panera Bread Huntsville | `719918fe-83df-4846-826f-06a073f42ad1` |
| 2323 | Panera Bread Norfolk | `eda1a73d-c776-4add-b95c-d0fb2e73a80f` |
| 2324 | Panera Bread Phoenix | `c3b057cb-df9a-4125-88ee-bbc3657f9daf` |
| 2325 | Panera Bread Port St. Lucie | `9f7e329c-4c0f-4473-9892-0ee610b269b6` |
| 2326 | Panera Bread Richmond | `8c6c5d64-a708-4d2c-b010-4a2d364dd9b4` |
| 2327 | Panera Bread Scottsdale | `bdb74ae5-65db-44f9-b805-d562b64f5e09` |
| 2328 | Panera Bread Spokane | `f5cef1bc-fe5e-4bc8-ba76-d4acfcb2f729` |
| 2329 | Panera Bread Westbrook | `1091be17-07e8-4b7b-880a-4c8ab9b1aa36` |
| 2330 | Panera Bread Winston-Salem | `5357ed6c-358c-42f2-8383-ee92188786da` |
| 2331 | Panini Bread & Grill | `0bc85db5-9746-49c9-a49a-4b1c6d9eff47` |
| 2332 | Panzón | `14d7b530-0887-4df9-a59b-bac30fc622b3` |
| 2333 | Papa Johns Biddeford | `6568ba86-a1b2-4e07-b71e-f06c1c284bb0` |
| 2334 | Papa Johns Boise | `e52869ee-d503-4fb0-bd41-8f0d8c9922dc` |
| 2335 | Papa Johns Charleston | `2fe3de78-db77-4bd5-8e12-c8bfae3538f1` |
| 2336 | Papa Johns Chesapeake | `23cf6503-013e-46b0-a494-35b1e04cb062` |
| 2337 | Papa Johns Garland | `632fde34-a24d-4184-862b-2de7b47fda6a` |
| 2338 | Papa Johns Glendale | `7b8b4eee-4519-4391-8ee1-1575ba134867` |
| 2339 | Papa Johns Newark | `264ca866-f5e7-453f-a5e6-7c36992f4fe2` |
| 2340 | Papa Johns Phoenix | `b9796a21-3d42-4a13-bf51-35ea3432ecf6` |
| 2341 | Papa Johns Port St. Lucie | `7e1bd7a4-ddb3-4a4a-8398-86a9b2a31c15` |
| 2342 | Papa Johns Richmond | `b8fa1c7f-c5da-4d46-810b-a05c612a3569` |
| 2343 | Papa Johns Spokane | `72a20221-6cb4-4202-b59c-907b617d2ced` |
| 2344 | Papa Johns Walkertown | `4c1b4816-037c-417f-b6bc-75d164d2f846` |
| 2345 | Papas & Eggs | `8d51f7a5-cc61-49e5-a49e-d6be7409beb9` |
| 2346 | Papaya Thai | `8c3f3b25-e3b9-4470-8737-808663f3f725` |
| 2347 | Papille Gustative | `1bdb91d9-963c-49af-ba33-75221f02da5b` |
| 2348 | Paradise Bakery & Cafe | `9f015500-42ff-4112-961e-b679a8d728b7` |
| 2349 | Paradise Express Biryanis & Kebabs | `ecf33608-2a36-4131-9e14-400f62cfad71` |
| 2350 | Paris Baguette | `f393c13a-aa03-4e8c-a964-f37aefcac9cd` |
| 2351 | Paris Baguette Phoenix | `2f92d781-7d69-470d-a4a5-63f9cd06df64` |
| 2352 | Park and Grove | `eb4e4ffb-a8f3-4048-ab79-760876e6b62f` |
| 2353 | Park Street Cafe | `b1394729-85e0-4041-b24f-da962bac24df` |
| 2354 | Parktown Pizza Company | `891ed853-6494-4fbc-b1d5-26ec2c7abc00` |
| 2355 | Parlor Doughnuts | `cedf4763-569e-44f7-8e55-d1b0751a2b65` |
| 2356 | Parlor Doughnuts Virginia Beach | `67089db5-5519-41a8-9da1-677c9b1337fa` |
| 2357 | Parm Famous Italian - UWS | `1c82f522-0c47-440f-a6ce-833e5f57f5af` |
| 2358 | Parry's Pizza | `a6c5d976-77cd-47f1-b467-e1037c28c882` |
| 2359 | Parry's Pizza Avondale | `69c01e19-e5d2-4423-afcb-14971823b080` |
| 2360 | Pasta Americana by Ruby Tuesday | `3959c7a1-7cba-438e-95f7-2f04fec0ccc9` |
| 2361 | Pasta Americana by Ruby Tuesday Chesapeake | `32bddb47-3580-496d-98d7-4c8d2e43a21e` |
| 2362 | Pasta Americana by Ruby Tuesday Mechanicsville | `7d19d239-17d9-4bed-a3f2-b544e6d7d1dc` |
| 2363 | Pasta Americana by Ruby Tuesday Norfolk | `b9feb469-d0e8-49fb-960b-f585052726bc` |
| 2364 | Pasta Americana by Ruby Tuesday Thomasville | `e8e32be9-e555-4727-86d9-58c6cc547f01` |
| 2365 | Pasta Brioni | `2d9c9928-597f-40bb-a829-586dd860b9e2` |
| 2366 | PastaMasta | `0048b8dc-43b0-458c-a823-71deed17a856` |
| 2367 | Pastini | `774e9efb-7fdb-48e4-8378-884a771e26dd` |
| 2368 | Pastosa Ravioli - Manalapan | `a3f4b213-c888-48f5-b46e-1a1caf829acc` |
| 2369 | Patacon Pisao - LES | `b459084c-3b9a-474d-ada8-ba5f8871dfac` |
| 2370 | Patacon Pisao - Queens | `bb3c8a59-dbeb-4fd4-81e9-d1e07432e87c` |
| 2371 | Patxi's Pizza | `21633a6f-3f9b-454d-bfcd-7712706822d6` |
| 2372 | PDQ Chicken | `0c8bed20-fcd7-49b7-8a9d-885ec434598d` |
| 2373 | PDubbz Catering | `4677a789-52d2-4b0c-8900-4c94f08a271e` |
| 2374 | Peace Love and Little Donuts | `6a41fbde-50fc-4705-a8f8-65e75f9566ac` |
| 2375 | Peace Pie | `9e2497f4-56a4-49ca-80f3-3b6eb6fac016` |
| 2376 | Peach Cobbler Factory | `111fa66a-ce12-4682-9771-23f8c81346aa` |
| 2377 | Peach Cobbler Factory Richardson | `09f95b77-f45f-4671-8485-3b260eff26fd` |
| 2378 | Peach Cobbler Factory Stuart | `9f248ff1-509a-4bb2-a984-6e020d3c3953` |
| 2379 | Peach Cobbler Factory Winston-Salem | `28690d8b-d918-4357-8753-46eee81f8061` |
| 2380 | Peacock Indian Cuisine | `d08839ec-fd1e-4209-89e8-945602e659af` |
| 2381 | Peacock Pansy | `2f7c94f2-ee38-430d-8050-b1084a8ba5ab` |
| 2382 | Pearl River Chinese Restaurant | `d4275888-5682-4ddd-ab6e-dc8b4a6b1ad2` |
| 2383 | Pearl's Bake Shoppe | `68d83062-3315-40eb-99e2-193ddbe326df` |
| 2384 | Pei Wei Asian Kitchen | `3628dfe0-6665-4abc-bf29-d31704bbef2d` |
| 2385 | Pei Wei Asian Kitchen Phoenix | `6e107132-60eb-4864-946f-8c6b4e56c289` |
| 2386 | Pei Wei Asian Kitchen Stuart | `576c21fe-efe7-4563-8c05-34925eeed2d7` |
| 2387 | Peking Restaurant | `9ba3db61-063b-4e33-9e07-92d7c6ff1689` |
| 2388 | Pelican Delicatessen Location 2 | `05b5f624-131b-4bd5-9cd3-6c58ecbf2223` |
| 2389 | Pelican Delicatessen Location 3 | `bc5f981c-49fa-4868-8e92-fcf7e718c8ef` |
| 2390 | Penelope's Coffee and Tea | `7948430a-7ebe-40c6-b248-477449b51c2c` |
| 2391 | Peninsula Catering & Events | `e855459f-e336-4c9e-a35a-e86e94691836` |
| 2392 | Penn Station East Coast Subs | `9390378b-bad2-4a99-8119-de2bd14faf5c` |
| 2393 | Penn Station East Coast Subs High Point | `8cdc0f9f-ffeb-4800-a96a-f5f2b71aa756` |
| 2394 | Pepperazzy | `e65bd606-9f0c-4eb3-bc7e-f7ce567e9ab6` |
| 2395 | Perkins Restaurant & Bakery | `e0d3a96c-9265-4b25-8bb2-6a92b77e3c52` |
| 2396 | Perky's Cafe & Catering | `b5b04a73-fe63-4f86-abb6-aae03c63739b` |
| 2397 | Peshawari Kababs | `407aee85-e5b7-4c70-8aab-1351c731c2e4` |
| 2398 | Pete's Bagels - Tarpon Springs | `ffe3efd0-c2ff-43a5-98f9-9abfcbbc4b93` |
| 2399 | Peter Piper Pizza | `8c0a0a44-e366-4bc1-ba6d-b322eef9fe24` |
| 2400 | Petit Dejeuner | `9c129dc0-f8d4-4fe2-b002-f9ca42061391` |
| 2401 | Petro's Chili & Chips | `5e4e068f-91b2-4457-9155-454c25ec255b` |
| 2402 | PF Chang's | `068219c1-49f0-43c4-b58a-f4df6d766296` |
| 2403 | PF Chang's Boise | `016d01cf-14f8-4b22-bbf3-8e4965d99b5a` |
| 2404 | PF Chang's Dallas | `e80e14ed-6e2a-4e96-841f-353de569eb1b` |
| 2405 | PF Chang's Huntsville | `dd6f93cb-50fa-4427-a796-e14d0de26d49` |
| 2406 | PF Chang's Mount Pleasant | `8f912187-7346-498b-aa59-690ab4632e50` |
| 2407 | PF Chang's Peoria | `82cedd8f-51d8-4ea4-8135-7aa7567cbd03` |
| 2408 | PF Chang's Pleasanton | `be22b147-0441-4f35-9855-51da306a357f` |
| 2409 | PF Chang's Richmond | `b5c64556-393d-4e86-b20e-441063215ccd` |
| 2410 | PF Chang's Scottsdale | `b9ab7cae-39ea-41bf-9eeb-75c08e80cda3` |
| 2411 | PF Chang's Spokane | `3be222d0-605e-4d95-a663-6e0b34439f26` |
| 2412 | PF Chang's Virginia Beach | `044194fc-4ded-437a-bf15-328b106495e7` |
| 2413 | PF Chang's Winston-Salem | `48cb1cac-b8fc-496b-b572-624c52cb44aa` |
| 2414 | Phil's Philly Grill | `3b0b9a44-7487-45ba-bced-cd5e0b5ef7c8` |
| 2415 | Philly Affairs | `215d9254-0dba-40e5-8f9f-180e018b3f1a` |
| 2416 | Philly Pretzel Factory | `abe582d0-0372-44b8-b596-d93a59d27722` |
| 2417 | Philly Steak & Burger Co. | `1ff17dcc-9345-4b6b-83cf-95e1d29c4a79` |
| 2418 | Pho Banh Mi | `58f103dd-215f-474f-ba97-d4889e586667` |
| 2419 | PHO KHANG | `32408643-82a9-4654-bc85-4091f85011aa` |
| 2420 | Pho Lotus | `e877b9c5-6197-4007-ab75-5f6cc987e0fc` |
| 2421 | Phuket Catering | `0f226b9a-4e81-48c4-9ed2-7414219d89b0` |
| 2422 | PHX Eats Cafe | `c2c528c0-57cf-460f-9179-e8b1b2ac6d13` |
| 2423 | PHX Lechon Roasters | `dd2b6c9f-7d31-4c1c-8b96-d7f9ac4f42ea` |
| 2424 | Pia's Thai Kitchen | `86f0c309-59ee-499f-bd5b-896cd6b2bf8c` |
| 2425 | Piada Italian Street Food | `043e9d7b-4b7a-405b-990d-eda8cca60299` |
| 2426 | Piccadilly Cafeteria | `f9653f6f-6fe7-4bc1-a906-259b74816a40` |
| 2427 | Pico Taco | `14d7c8c9-3f29-4c86-98c5-e7072ba1f9eb` |
| 2428 | Pie Five Pizza | `9070dccc-5ba5-4ebd-9b86-cfeefa1de658` |
| 2429 | Pie Tap Pizza Workshop + Bar | `9497ffd5-3163-4895-8f42-6282ac77929a` |
| 2430 | Pierogies Factory | `5ba25ff2-7107-4df0-9f04-27c8d17e304e` |
| 2431 | Pig and Brew | `4e192742-fd19-4691-9d22-4083f36cc502` |
| 2432 | Piggie Pies | `4fb0312f-e8d8-409a-a883-8a06c1d21924` |
| 2433 | Pinay Good-Eats | `98f9e6ea-df2d-4c8b-8c8a-47af1dda956f` |
| 2434 | Pinwheel | `d3dfe311-0ea3-4339-804e-d34bd6ef0c1c` |
| 2435 | Pita Bistro | `3f21f6be-b073-482a-9f31-c8aa05c055e4` |
| 2436 | Pita Cafe | `2ac6c6b3-e009-4329-9c7f-cd0bb4818817` |
| 2437 | Pita Cafe Glendale | `17417c1f-4f16-4760-b8c2-4baf57a5496e` |
| 2438 | Pita Delite | `ac54ca9f-3105-4e33-a453-d4feb3c8b841` |
| 2439 | Pita Fresh | `8518a0f9-d428-41d1-b04d-079a98c612b1` |
| 2440 | Pita Fresh Express | `6ac1946c-f15f-4c8b-bdae-4abaa3fd7078` |
| 2441 | Pita Island | `2aeab95c-5855-4491-8639-671dd09b8f10` |
| 2442 | Pita Jungle | `fefe962a-818e-42b3-9176-bc88bc219a9a` |
| 2443 | Pita Jungle Peoria | `2ea8ddb9-8b81-4c08-95a5-123b53614247` |
| 2444 | Pita Kitchen | `ea0b3cc2-f452-456e-b67e-1980f0bce700` |
| 2445 | Pita Mediterranean Street Food | `1c765ffb-157e-41ca-86a7-6158adc3e759` |
| 2446 | Pita Pit | `2a5986c1-dd2d-4b02-b6e5-5d1669ab2097` |
| 2447 | Pita Pit Boise | `69f24e4b-7c20-4955-8fbe-9183c19398b2` |
| 2448 | Pita Pit Kent - Team Meals | `fb55347e-a42d-43c9-9469-cc89e41d7477` |
| 2449 | Pita Valley | `27bfd025-2e50-4813-83aa-627db34f7882` |
| 2450 | PitaDale | `16ef5e62-7adc-4f22-8f8f-1a43e9345b21` |
| 2451 | Pitbull BBQ | `a4e1a981-217b-4ba7-9d2a-4ab2a7c2162d` |
| 2452 | Pitch Pizzeria | `f6e210ef-f12a-4ba5-a79f-4973cabfe899` |
| 2453 | Pittie Dog Grill | `5af995ab-1719-480d-a90c-2914b0d22bc4` |
| 2454 | Pizza Chicago | `ed4df246-1e71-4c0b-9152-b65b2047ba49` |
| 2455 | Pizza Colore | `8b93073c-b449-4e20-8eb8-3ad73102c67b` |
| 2456 | Pizza Factory | `6e25aec8-57ac-44e6-b0d8-a8ea52485cfd` |
| 2457 | Pizza Getti | `c5ce715a-3879-4742-a575-b988594067d1` |
| 2458 | Pizza Guys | `68db5d92-f998-4b22-9126-2aa82336d4e0` |
| 2459 | Pizza Guys Fremont | `a76daac0-b88f-4e1d-b81e-4fdba75df2c9` |
| 2460 | Pizza Heaven Bistro | `796c3c22-5c7e-4fbd-8f01-5e4b2cd5534e` |
| 2461 | Pizza Hub | `55b82f57-bf7b-4a48-b327-a08c14b743a4` |
| 2462 | Pizza Hut | `611c207c-5379-4d5e-8193-83ff3703cf93` |
| 2463 | Pizza Hut Garland | `2711f020-4bec-4f05-b2e4-6e1564b30e7f` |
| 2464 | Pizza Hut Glendale | `d29cc381-65a4-4684-b53f-4cc54d26345f` |
| 2465 | Pizza Hut King | `ceecb6ee-ac99-4ae6-a9c2-ba168f4f630c` |
| 2466 | Pizza Hut Scottsdale | `2289202f-d0dd-4306-8229-d662fa84dc7d` |
| 2467 | Pizza Hut Smithfield | `334e11a7-88de-4006-8c37-17a6f84926c1` |
| 2468 | Pizza Hut Spokane | `697795d4-a804-45ec-a1a1-2bf98038b9f1` |
| 2469 | Pizza Leila | `7872ddb5-f984-4dcb-b309-4f9f7ddd35d7` |
| 2470 | Pizza My Heart | `bd56800b-623c-4deb-9237-2bf99e250010` |
| 2471 | Pizza Twist | `491bdd51-b4d5-4400-8612-c95491f18e71` |
| 2472 | Pizza Twist Chandler | `051da83c-7c35-4648-92ad-6f0eb2fc9163` |
| 2473 | Pizza Vino | `c6228e93-37e8-4f26-aaf0-47ca46a42bf2` |
| 2474 | Pizzati | `8e43dc9b-97ce-4c4b-9a6e-6655e2f1df28` |
| 2475 | Pizzati Dallas | `b745c350-5292-407c-bb94-842a2716c811` |
| 2476 | PizzaVola Express | `e2bd5fea-0582-4b61-924f-3b5daef77a18` |
| 2477 | PJ's Coffee of New Orleans | `e0802ff6-651a-462a-9bdb-169fbd539e19` |
| 2478 | PJ's Coffee of New Orleans Farmers Branch | `e31c5d32-7b47-431f-b557-a945b8b4a0c9` |
| 2479 | Planet Sub | `a3ab63ba-a138-4717-9596-8133da154919` |
| 2480 | Plant B | `8f180448-7277-4cfb-8bce-b02e31096a4b` |
| 2481 | Plant B Tempe | `92c7978c-05d2-49da-becf-4e877669e030` |
| 2482 | Plant Life Vegan Catering | `9adf276b-af85-4069-a040-c0f9f61e40d6` |
| 2483 | Platesfromparis  | `8a4873c9-59c8-4dfe-978e-17201166cc1b` |
| 2484 | Playa Bowls | `2961e178-16be-4a4e-9325-224ee5008e9d` |
| 2485 | Playa Bowls Chandler | `298de0f4-e7e9-4ece-9fd0-d6bf34dd7cad` |
| 2486 | Playa Bowls Glen Allen | `6502384c-f7c0-4d45-a5f3-0f16e3aecd33` |
| 2487 | Playa Bowls Stuart | `06610503-21a3-4f39-adb8-a7ccefb0a716` |
| 2488 | Plaza Restaurant | `2d65edaf-ba14-41aa-a965-375101cfa5c9` |
| 2489 | Plomo Quesadillas | `f9f36287-c71b-4d3e-819b-fdcfa577d714` |
| 2490 | PMS Deli and Catering | `01b891c4-8fdd-4d80-9209-a23d29b9e4a9` |
| 2491 | Pok-U | `eebf90a7-bade-4d1c-9cf0-80a7148e1b52` |
| 2492 | Poke Cafe | `dd31d359-ab5c-4679-83b3-bbf34f503668` |
| 2493 | Poke House | `b3d5b09f-779c-4fb9-ad3c-432563562f6e` |
| 2494 | Poke Loa | `324832ec-7603-4143-9b71-c5a97b2285b0` |
| 2495 | Poke Maki | `0e7fe532-f451-4042-81d6-6e02feed7dd3` |
| 2496 | Poke Poke Fish Bar | `727e0aff-0578-4942-b25e-cb6d1d420514` |
| 2497 | Poke Sushi Bowl | `e42fd089-5ef7-452b-8b8a-2b919c410fc5` |
| 2498 | Pokeme | `50601277-67b1-41f3-81da-e8f58deacbf9` |
| 2499 | Poketastic | `38b60af7-c027-4de4-b47a-d83670feda81` |
| 2500 | Pokeworks | `988a447b-71bc-4daf-8ca5-4f3598eab2ed` |
| 2501 | Pokeworks Tempe | `47fcb5e0-2593-49e0-8bb8-e7daf63fa766` |
| 2502 | Pollard's Chicken & Catering | `5aa29145-e53b-4cca-9b07-2b402489223f` |
| 2503 | Pollard's Chicken & Catering Chesapeake | `0f010b61-2f90-446e-9d19-65cf7f615853` |
| 2504 | Pollo Campero | `5690244d-e78f-4700-b53a-bc1a5190d690` |
| 2505 | Pollo Campero Richardson | `3855b0e5-c290-403b-b51d-36734f3034bf` |
| 2506 | Pollo Lukas | `901ef3cd-9fd4-40f4-809b-6acc7ed73d5f` |
| 2507 | Pollo Tropical | `b9a06b41-1f0e-4be7-952c-70aeca4fc9a1` |
| 2508 | Poogan's Smokehouse | `c1839631-ae54-42e4-a3a0-789997c162bb` |
| 2509 | Poor Richard’s Cafe | `92e512b4-c541-4053-8322-4dc3aa820cf4` |
| 2510 | Popeyes Louisiana Kitchen | `2aabef44-d453-4c01-9437-c0dfa12d2115` |
| 2511 | Popeyes Louisiana Kitchen Boise | `bd8a1be4-9468-4606-939d-934fbb928df1` |
| 2512 | Popeyes Louisiana Kitchen Chesapeake | `96afbea7-fffb-4c3c-afea-57d06197cc20` |
| 2513 | Popeyes Louisiana Kitchen Fremont | `5a07c71b-47f0-4f75-b582-835e1685b571` |
| 2514 | Popeyes Louisiana Kitchen Garland | `6b358b3d-7e95-45ca-a475-ab3636e558b7` |
| 2515 | Popeyes Louisiana Kitchen Glendale | `a1cc152e-418b-4e76-8035-445fc73a8e9c` |
| 2516 | Popeyes Louisiana Kitchen Huntsville | `848498d5-94e3-44c3-930b-46d173439f80` |
| 2517 | Popeyes Louisiana Kitchen Norfolk | `cb99de80-b722-4a47-8c0c-b11c1df94471` |
| 2518 | Popeyes Louisiana Kitchen North Charleston | `cf59f0b7-a904-4397-8463-428727e2d466` |
| 2519 | Popeyes Louisiana Kitchen Port St. Lucie | `bd09cdaf-1253-46d6-a7ff-22ec6d7c23d2` |
| 2520 | Popeyes Louisiana Kitchen Scottsdale | `256a4018-8e44-465d-9b1f-c8710512ded3` |
| 2521 | Popeyes Louisiana Kitchen South Portland | `6e06d4df-f0e2-4c43-ac87-88373441efdc` |
| 2522 | Popeyes Louisiana Kitchen Winston-Salem | `8f57ce2a-5a54-4cbb-826e-7949193d8d91` |
| 2523 | Porcha's Southern Delight | `b0085600-df96-4903-9af4-d40730646e06` |
| 2524 | Porco's Porchetteria & Small Oven Pastry Shop | `6f940365-fd2a-4e97-b9d3-9f078551ebd9` |
| 2525 | Porky's Pizza Palace | `40b53ebe-4cad-40d3-80e3-6902f103b260` |
| 2526 | Port of Subs | `3197eaac-5131-4522-9c78-dbd60572e30e` |
| 2527 | Port of Subs Boise | `5134b593-aa8a-44d7-a3b5-124b57248767` |
| 2528 | Port of Subs Tempe | `7bc13ff8-41a2-44f0-931f-acdea4610a04` |
| 2529 | Porta Di Roma | `446e1556-582a-4e17-b5bc-3be9978f7dce` |
| 2530 | Portland Pie Co | `6fb341b1-4be6-4eb5-82e7-c5cf0c48f29d` |
| 2531 | Postino | `f8110735-fb39-487b-8881-d49091fe4258` |
| 2532 | Postino Dallas | `80277264-e1dd-4832-a040-f403df941859` |
| 2533 | Postino Scottsdale | `3cd6a5c2-3579-4771-89fd-1b87671b87e0` |
| 2534 | Potbelly Sandwich Shop Garland | `e984ad6b-a3e9-417d-8228-70de5f0e3d5a` |
| 2535 | Potbelly Sandwich Shop Phoenix | `96d7f166-b66d-4be2-8e9d-60fca4c5e8ba` |
| 2536 | Potbelly Sandwich Shop Richmond | `c60c4c1c-7036-4eed-b39a-fbbe262ae007` |
| 2537 | Potbelly Sandwich Shop Tempe | `4ec46368-5b75-40a8-be8e-29498b307910` |
| 2538 | Pour Decisions | `cf7b0ef3-91b5-476e-90d8-05519f60fef8` |
| 2539 | Pour Girls | `c0ea7c85-6460-4dc9-87cc-07f281835b4d` |
| 2540 | Prego Pasta House | `469ac637-409e-4833-8211-e397561caa56` |
| 2541 | Presidio Cocina Mexicana Food | `80a587ba-f8b2-49ef-9756-3d51a14b0580` |
| 2542 | Pressed | `3d5458b4-79b4-4a44-bf55-878be7e84b49` |
| 2543 | Pressed Scottsdale | `2496b1fa-5eb5-4f4a-aeca-b3dfe97a375c` |
| 2544 | Primo Hoagies | `86936735-cdd1-48bb-96c9-69b5dec172b6` |
| 2545 | Primo Hoagies Mount Pleasant | `152747e4-5931-4672-82e4-2224f3fe2ee0` |
| 2546 | Primo Tacos and Hot Dogs | `ebcc4a95-1ac3-4482-9472-3b4a5b1c9dc9` |
| 2547 | Primos Brothers Pizza | `6bee3dcb-be7e-4dc6-a5b1-2f66400cf0d0` |
| 2548 | Princess Market | `b438e338-d78b-4b86-938d-9885c5f6d299` |
| 2549 | Princess Pita | `b2be84c8-089b-48ff-90f7-a296410ee977` |
| 2550 | Princi Italia | `b614b890-d6a4-454a-a798-92c69adbefaf` |
| 2551 | Prissy Polly's Pig-Pickin' Bar-B-Que | `b218509e-fb77-4d2b-a35b-6246cab0a19a` |
| 2552 | Prohibition Bar and Grill | `4715e2bb-31d8-4805-91dd-047f2a9cf315` |
| 2553 | Protein & Poke | `db91c91e-5909-45b0-8a22-baeb92614c58` |
| 2554 | ProteinHouse | `802bd307-4752-42f9-ab12-27ba60aa014a` |
| 2555 | PT's Fried Chicken & Fish | `b64d31c3-cc80-4fad-a520-eeb5af2c1848` |
| 2556 | Punjab Kitchen Indian Cuisine | `24edfa03-d0de-43e6-afdc-c4f05c505851` |
| 2557 | Pupatella | `9f678781-3116-419d-b92a-82b61b59c8b3` |
| 2558 | Pupusa Time | `a99af46b-c40d-4aec-84ed-34d331d462dd` |
| 2559 | Pure Green | `888a87bc-9605-436f-8bc3-050f0910b2da` |
| 2560 | Pure Green Phoenix | `ab373221-226c-4cfc-bf27-b83f8b09b4b9` |
| 2561 | Pure Milk & Honey | `5dbfd25f-c8d6-464d-84a8-5207f93e71a6` |
| 2562 | PurePoke | `5e4de855-522d-438f-8eb5-3a61d5905eac` |
| 2563 | Puttery | `c642465e-ec9b-4d35-8a3c-506015d1541a` |
| 2564 | QDOBA | `70f74ee0-c1d6-4135-b815-aecfe8c79474` |
| 2565 | Qdoba | `90995f8a-90f7-4a2d-a6c8-fabc069ed2a7` |
| 2566 | QDOBA Boise | `0dce4839-69e8-4ab6-989f-4b7efd4cf84a` |
| 2567 | QDOBA Norfolk | `e04fcd24-8c70-4ffb-8191-6bd1eaecfad5` |
| 2568 | QDOBA Richardson | `38797d36-ea6c-41db-ac84-7aedfa64b7a7` |
| 2569 | QDOBA Scottsdale | `46b0506f-0f65-4cd8-b005-692a6b44caa0` |
| 2570 | QDOBA Spokane | `7bdc1f44-baae-4383-bf48-8112b31612a9` |
| 2571 | Quartino | `eda484e3-35df-452a-be78-54bdfcfb80fe` |
| 2572 | Que Viva! Latin Street Grill | `09268f9e-d9f5-4209-a17f-eba192f22b55` |
| 2573 | Queen Trini Lisa | `9730f0c2-2fd4-4c1c-ac1c-ee692dda32e5` |
| 2574 | Quinto Neighborhood Pizzeria & Taphouse | `423e3051-ab6c-4def-affb-288ccd237035` |
| 2575 | Quinto Sol Mexican Grill | `7a4c5684-74db-48a8-8069-70a135328d60` |
| 2576 | Quiznos | `50d09dee-a937-4303-a706-95aec6a5611a` |
| 2577 | Quiznos Fremont | `7a382c98-a26f-4324-948a-b1bcd5e135fb` |
| 2578 | Quiznos Glendale | `c8fbdd77-a0af-4ef9-be09-5856dd35b30b` |
| 2579 | Quiznos Phoenix | `d60625b8-e910-4cb6-89c6-a75c1e955898` |
| 2580 | Quiznos Plano | `24dd45d4-d0d8-4f88-bc1b-da711d2fddfe` |
| 2581 | Qwik Chinese McCormick Ranch | `37032aab-5e11-46bb-bd3b-562794c076c5` |
| 2582 | R&R BBQ | `6e9c9946-5a31-4ddb-8571-971fb78d0fd6` |
| 2583 | RA Sushi Bar Restaurant | `34d460ef-7fef-4ae4-b3da-ab34078b13d6` |
| 2584 | RA Sushi Bar Restaurant Dallas | `dcaa265b-fa45-470c-b026-7e27e4c9ddd2` |
| 2585 | Rachel's Kitchen | `58b2aeb1-ebba-4d9b-8342-94a95a1713fb` |
| 2586 | Rainforest Cafe | `8b043aa8-37e8-4eaa-8b10-81ea6b0ca454` |
| 2587 | Raise the Roost | `8ea7ffb5-ef8b-4be3-b989-cbe6f197bba8` |
| 2588 | Raise the Roost Dallas | `7d9dc43c-41a2-40f6-ba02-b8714a97b810` |
| 2589 | Raise the Roost Newport News | `1b735945-a914-4562-80e6-233d86887689` |
| 2590 | Raj & Rani's Indian Kitchen | `d77588d4-5153-4f5a-98c2-a3f47adee02c` |
| 2591 | Rajput Indian Cuisine | `e313498e-20df-402e-b881-8d89da68654e` |
| 2592 | Rajput Indian Cuisine Chesapeake | `6ee26a84-1644-4caf-8649-c1ec3b8ba411` |
| 2593 | Rally's | `b9a79f80-c45e-430e-be7e-14c408af3608` |
| 2594 | Ramen Lab Eatery - Boynton Beach | `93c63a45-fec5-4570-a10a-255e16b2b1f2` |
| 2595 | Ramen Lab Eatery - East Boca Raton | `3121c03e-51c6-4b9c-bda0-af127e4055e4` |
| 2596 | Ramen Lab Eatery - West Boca Raton | `3e335897-2e8d-48f8-8c65-e93e4805cbfc` |
| 2597 | Rangoon - Chelsea | `7ec381e2-f35e-43cc-83da-b3dd820e844c` |
| 2598 | Rangoon Ruby | `826c365d-c5e4-4263-9844-a7d9d7af0330` |
| 2599 | Rapid Pizza | `c10c13fa-5141-4963-b270-c57e56c77749` |
| 2600 | Rasoi IV | `b04d642e-2ac9-48d4-9f33-3060253ef5c8` |
| 2601 | Rasta Stand Juice Bar | `a157a1de-0a7b-46ae-b18f-e8e7a16245fb` |
| 2602 | Ravenna Italian Restaurant & Bar | `994ce06e-87dd-42bb-a901-60db8799ee4b` |
| 2603 | Rayo's Pizza | `80d38245-7e46-4619-86bd-ad05f58c399d` |
| 2604 | Razzis Pizzeria - Downtown | `0f293250-4cef-4a00-a7c6-ee6c6ffff0a0` |
| 2605 | Razzis Pizzeria - Greenwood | `3bf5999d-b224-4b91-b5da-96b0b55d8a07` |
| 2606 | Real Mediterranean Kitchen | `9b31c0c7-6909-4b06-9a15-28d09f217e99` |
| 2607 | Realmuto Pasticceria | `af24fb4d-6557-4c3a-98a6-0f5b46eeaf0d` |
| 2608 | Red Chili | `db1ed5f5-de9b-43d5-9608-32b4781a4e41` |
| 2609 | Red Devil Italian Restaurant and Pizzeria | `04e858b3-8bef-413a-ab2a-62bff34d2ed8` |
| 2610 | Red Donut Shop | `2d99c20a-d01a-4007-aac1-04ca334fa74d` |
| 2611 | Red Fort Cuisine of India | `7012c6b0-07ae-4cdc-9b7d-2fb3eec8e454` |
| 2612 | Red Hibachi & Beer | `5ed706df-4aa3-4de0-8879-6b017442892e` |
| 2613 | Red Hot Chilli Pepper | `16aeb17a-c9e0-42ca-aeb2-f3a0dcf75100` |
| 2614 | Red Lobster | `b1fe022b-4469-42b3-8464-0617a55bbcb5` |
| 2615 | Red Lobster Boise | `b2d62878-e137-4659-b49d-90f4ebf8055a` |
| 2616 | Red Lobster Chesapeake | `9d118f47-5e55-4e00-aed0-28b0d84eee88` |
| 2617 | Red Lobster Fort Pierce | `4e925a96-eb98-4c33-aed3-17e8bdcb8566` |
| 2618 | Red Lobster Mesquite | `b30cd533-7f96-44e3-9fcf-55b7d93a5f57` |
| 2619 | Red Lobster North Charleston | `4f3b1b1d-c17a-4569-bc79-9e255c9f501f` |
| 2620 | Red Lobster Phoenix | `aa3c9aff-7b69-473b-8e70-01c05450754f` |
| 2621 | Red Lobster Richmond | `79f0f1fc-5946-43ed-915b-aceb3066f342` |
| 2622 | Red Lobster Scottsdale | `b5f829fd-945f-4eba-9d35-1f94ac7eb7e0` |
| 2623 | Red Lobster Winston-Salem | `ceaba157-b25f-4d88-b238-58afdb0a32e9` |
| 2624 | Red Mango | `9c570795-ac1e-441f-9357-833f40c3ae5c` |
| 2625 | Red Robin | `89319b90-90c7-4d22-a344-068acafe55da` |
| 2626 | Red Robin Boise | `e545a7c1-0e16-4f08-ac8a-455a5828dd87` |
| 2627 | Red Robin Chesapeake | `d12ef851-64c9-4403-80ef-661af1ee3767` |
| 2628 | Red Robin Garland | `a1bc3761-5405-4865-90a8-fdc41a19bdc6` |
| 2629 | Red Robin Glen Allen | `2472a38c-c16f-49c9-ad86-292e2bd9980a` |
| 2630 | Red Robin Glendale | `2511868f-6d09-4bca-bf6e-28b94b1bb937` |
| 2631 | Red Robin Huntsville | `976121f5-c515-4f6b-b38a-08925ddf200c` |
| 2632 | Red Robin Scarborough | `25f0aa38-4737-464b-afdc-43433338469c` |
| 2633 | Red Robin Scottsdale | `1842bfa1-0683-47eb-92e3-f0a757fb8696` |
| 2634 | Red Robin Spokane | `47444af6-4851-4fe5-8177-a6400eba4db0` |
| 2635 | Red Robin Winston-Salem | `f08984cb-5f8a-47f1-bda5-68c80fb81c09` |
| 2636 | Red Stix Street Food | `e639fdbe-e222-4336-984b-8443ee47d476` |
| 2637 | Red Velvet Bakery | `69bab256-6ecd-4dca-8189-cea2e05617eb` |
| 2638 | Red Wheel | `f5d20006-6697-47ec-9309-2210537a2b12` |
| 2639 | Red White & Brew | `430c76c1-4267-429b-8bfa-4c7977d1720a` |
| 2640 | RedRock Catering | `15bd3f8e-ec44-404e-b1cd-d506c6b8a07c` |
| 2641 | Redwood Catering | `ad416c03-868a-42e2-8f70-27b0d0b94dcd` |
| 2642 | Redwood City BBQ | `30913f75-5caf-431b-a1ee-df15e0f841b7` |
| 2643 | Redwood Grill | `79c7e41f-1ec8-4b95-9254-165808881e78` |
| 2644 | Rendang Republic | `896fc510-8e9d-4d20-a45e-b4bc1534763b` |
| 2645 | Renegade Burrito | `df926857-8689-4d5f-92c6-1f7ade428fb3` |
| 2646 | Renny's Bar & Grill | `1af0f0ad-cc76-4060-a267-748f29735ac2` |
| 2647 | Restaurant | `f46b35bd-a45c-4694-8348-41ceea0ce0a1` |
| 2648 | Restaurant Beatrice | `abe99d25-ed03-48fa-8282-499426f96377` |
| 2649 | Revel Patio Grill | `4f1e127c-f06a-4ad6-aa32-7ca8a4ae939a` |
| 2650 | Rice and Spoon Vietnamese Cuisine | `b5b4f27a-208a-45c9-a096-3bbe2924486f` |
| 2651 | Riddim N Spice | `e1fdac1d-4160-4540-8212-b3f89d8a6cfa` |
| 2652 | Rihana's Pizza & Wings | `9516c2d8-5c34-45d2-b068-aa6cad958b94` |
| 2653 | Rinaldi's Deli | `76695c47-ca6d-4cd6-b447-6d6cc61abc9e` |
| 2654 | Rise Pizzeria | `d44de603-35ea-4c73-be8a-c91e37b05e7e` |
| 2655 | Rise Southern Biscuits & Righteous Chicken | `92e3acf6-83f6-4599-b9fe-c352bea3feff` |
| 2656 | Rise Southern Biscuits & Righteous Chicken Dallas | `7d784e27-62b8-4c2f-b94c-6c54ef2a240d` |
| 2657 | Rita's Italian Ice and Frozen Custard | `49aa236e-6581-40a5-9290-36046ec710e3` |
| 2658 | Robby J Catering | `c8a128ca-d332-4851-903d-14aaeea43b27` |
| 2659 | Robeks | `874b779b-b484-4c57-a59d-7caf77622f14` |
| 2660 | Roberto Italian Restaurant | `d0199fc4-64c2-4840-9017-38a6c9a5a6c5` |
| 2661 | Rocco's Catering | `c35a2273-2f08-4bb1-84e6-5a51a9997ff9` |
| 2662 | Rock & Brews | `00d284ed-53de-402a-97dd-af73b26f425a` |
| 2663 | Rock City Pie and Ice | `a74a6bfd-5060-400d-90a4-af81c7e118ae` |
| 2664 | Rock N Roll Sushi And Hibachi | `b60448df-712a-427d-a8e2-33c73c621a98` |
| 2665 | Rock N Roll Sushi And Hibachi Glendale | `feaaaa73-e2a4-4b45-a34a-3148a76a7605` |
| 2666 | Rock N Roll Sushi And Hibachi Stuart | `3f705909-74d0-427d-be63-fd61f49bc4b9` |
| 2667 | Rocket City Market | `5e48f160-5f79-42c8-9ca9-c616ebdefecf` |
| 2668 | Rocket City Tavern | `76affc8d-dbe4-4cf4-8399-95576df5da75` |
| 2669 | RocknWraps & Kabobs | `1d33657d-f0b8-4d93-8b73-5db9d9a80e02` |
| 2670 | Rocky Mountain Chocolate Factory | `f729755d-c437-4a19-8173-5a26603aea5a` |
| 2671 | Rocky Mountain Tap & Garden | `6466ac73-4654-4a9a-8485-36d30e1b8e72` |
| 2672 | Rodeo Goat | `d93d4037-3c0a-4529-9b09-97a6612568f9` |
| 2673 | Rodney Scott's BBQ | `0f7d8c9e-eb40-4441-9493-2d80d0ac5b57` |
| 2674 | Rokstar Chicken - Bronx | `5309aba0-3180-464e-bead-1cfff857c033` |
| 2675 | Rokstar Chicken - Douglaston | `b5f529d7-1c42-4f98-98e0-6a2a6edadc91` |
| 2676 | Rokstar Chicken - Long Island City | `35fe301f-5d31-47f7-a553-2eef34e512dc` |
| 2677 | Roly Poly Sandwiches | `45dee9c2-4bce-45c8-824e-6b0c88e76a2c` |
| 2678 | Roma's Italian Bistro | `0eaa7bc9-88dd-4827-a025-8d94e793c3d7` |
| 2679 | Roma's Italian Kitchen | `cfd9e555-89ac-483f-b73c-69abc0d0368c` |
| 2680 | Roma's Italian Restaurant | `63f240fb-8e25-4bac-8722-a58d2e09137e` |
| 2681 | Roma's Pizza & Italian Restaurant | `457ac951-5bf8-4fb8-9ac9-42b2bb9867fe` |
| 2682 | ROOH Palo Alto | `831289fe-ef93-4a89-8222-ec91abd50c03` |
| 2683 | Roost & Roast | `24ff0602-8b6b-406b-8d3a-b4fda1282902` |
| 2684 | Rooster & Rice | `9f29dae0-5b3d-48bd-a9db-70f61369589c` |
| 2685 | Roots Catering | `4254cb19-dee7-4d14-90d1-3c8577c0df2d` |
| 2686 | Roots Chicken Shak | `f286d3b2-7f87-491d-bd26-b6910f6bcddc` |
| 2687 | Roots Natural Kitchen | `8519fb35-033e-4f0b-8303-0594991892da` |
| 2688 | Rosati's Pizza | `b9ea65ac-29f7-4ef6-bc8f-615bfba85a39` |
| 2689 | Rosati's Pizza Chandler | `9e285db6-fd6d-4751-b3e6-520508677b01` |
| 2690 | Rosati's Pizza Peoria | `453f1af3-c3d4-4b0a-9709-7f2127075f42` |
| 2691 | Rose's Kitchen | `e5231625-b471-41fb-b71d-3f45dd06c99c` |
| 2692 | Rositas Catering Company | `8eecba69-cb37-473e-801f-795aab185343` |
| 2693 | Roti Grill | `df0c4d5c-c638-4a9e-a8f4-2f9840cc8fd8` |
| 2694 | Round Table Pizza | `141efb24-c0f2-4a89-a1f7-0fc7b7cba9fd` |
| 2695 | Round Table Pizza Fremont | `298a8bb5-a693-4c38-b4e8-470cd38bd101` |
| 2696 | Round Table Pizza McKinney | `3760c4f3-9cf5-43f2-aae4-938da67508be` |
| 2697 | Royal Catering Inc. | `dd29565d-cf10-4b60-b0a4-6e111d6d97c2` |
| 2698 | RubaLee's Southern Kitchen | `516830a5-bb9e-4072-9ea3-da06078ecfa4` |
| 2699 | Rubio's Coastal Grill | `74956ead-6fa9-4b58-8c96-afee2be661b1` |
| 2700 | Rubio's Coastal Grill Peoria | `6d2e2319-d1ae-49ad-9103-85b094220533` |
| 2701 | Ruby Sunshine | `05e06f20-879e-47a0-8aa8-95c3e529821a` |
| 2702 | Ruby Tuesday | `13cc6393-5e1b-4165-b73f-a53a6e580cbd` |
| 2703 | Ruby Tuesday Greensboro | `9f99f7cf-0536-4ee7-90b4-ab8f39127ab0` |
| 2704 | Ruby Tuesday Jensen Beach | `140684ef-d84e-4b97-adcc-4d5d00cb7ab4` |
| 2705 | Ruby Tuesday Mechanicsville | `bc6512f6-1489-408c-88cc-a7f6e3ed9d9c` |
| 2706 | Ruby Tuesday Norfolk | `bc147240-54af-486b-87fd-8dccb4571d7b` |
| 2707 | Ruby's New York Style Bagels | `3bb9ecdb-ece3-43fc-af1b-cd5df9885200` |
| 2708 | Rudi's Napoli's | `003f076a-486a-4c75-a5ac-6d3f61c15063` |
| 2709 | Rudy's BBQ | `136c95a5-61a9-49c2-8cd2-a15f2984eaf4` |
| 2710 | Rumbi Island Grill | `fbb09e3f-0a4a-42b4-91b6-e613c0ecbd87` |
| 2711 | RuRu's Tacos & Tequila | `4408fead-b1f1-4351-ba52-09833458c230` |
| 2712 | Rush Bowls | `85dc9b7e-11e1-4f20-a3ec-8799eefbc7e9` |
| 2713 | Rush Bowls Boise | `27c68834-6b3c-443c-b545-898cc0557326` |
| 2714 | Rush Bowls Dallas | `25f4cbad-a3f0-4030-8639-fd5ae9537ed9` |
| 2715 | Rush Bowls Phoenix | `a0594391-76c7-4c67-a42b-cf1320383c66` |
| 2716 | Russo's New York Pizzeria and Italian Kitchen | `12341dcd-9649-4bfa-9425-e2282564d533` |
| 2717 | Rusty Taco | `ef60e6aa-198e-4d55-a37b-a5c0ceb4b94b` |
| 2718 | Rusty Taco Scottsdale | `c886f33a-28ee-47a7-8b32-cd0ee3ddc16a` |
| 2719 | Rusty Taco Tempe | `525bd8e3-bde8-4e57-81a5-f28176a34b07` |
| 2720 | RVA Cafe | `c004c694-2050-4c94-a883-c6608bc70d79` |
| 2721 | S&D Catering To All Events | `e5bc55d9-4438-4caa-802d-f5324e0323c0` |
| 2722 | S&S Cheesesteaks | `09bf1d6c-2714-4b62-9d50-3f44837dca97` |
| 2723 | Sababa Mediterranean Cuisine | `408f0325-6bbd-4b8f-8b05-2afbf0e19f8f` |
| 2724 | Sabaidee | `c6a5f24a-b486-42c0-8530-9d039b1bbb9c` |
| 2725 | Sabor a Michoacan | `5bdf866f-bded-46ab-bbf5-b5c9e65a8794` |
| 2726 | Sabor Latino | `431631af-7e03-4f11-a5ac-2edc1eda0de7` |
| 2727 | Sacks Sandwiches | `8847ef47-639c-44eb-a818-0290cf67fc88` |
| 2728 | Safeway Grocery & Catering | `9022a9c2-a616-402c-8ec5-be2387fc8cab` |
| 2729 | Saffron Indian Cuisine | `7d5c1cd8-829d-46e7-a10e-19507591f7b4` |
| 2730 | Saima's Grill | `126522f6-5370-4127-9df7-3f49338f779d` |
| 2731 | Sajj Mediterranean | `84a6e6fc-2347-47e3-9285-b764bf4b7501` |
| 2732 | Sakebomb Sushi & Grill | `a51f1b22-6802-4fc3-87d2-33f023db120d` |
| 2733 | Sakura Sushi & Sake Bar | `8b7713ab-e7ce-4723-9d34-a886ee192c12` |
| 2734 | Sal's Italian Ristorante | `2ad0c2cd-17da-48e0-abc7-2036848d018b` |
| 2735 | Sal's NY Pizza Company | `a1391a35-d7e5-4335-9120-f5717f41a6e0` |
| 2736 | Sal's NY Slice Pizzeria | `1fb2e14a-e385-4c5e-8cbe-aaef49ef6a91` |
| 2737 | Sal's NY Slice Pizzeria Virginia Beach | `c35c44ff-e3f1-4376-9b53-944e1e5f42ba` |
| 2738 | Saladworks | `4f00696e-0226-423f-8269-d9586807bf41` |
| 2739 | Saladworks Chesapeake | `71858cde-89c9-41e7-9ab4-7005efcbb34d` |
| 2740 | Salata | `30183883-a444-4207-937d-7dd79feb50fd` |
| 2741 | Salerno Pizza | `fde70577-d7a1-4963-9376-fe13f2b3f8db` |
| 2742 | Sally Boy's | `9a306e44-fc99-495d-84ec-7cf92eaf4b45` |
| 2743 | Salomay | `cac503ce-d98e-468a-9751-956df3bdf943` |
| 2744 | Salsa Leedos Mexican Grill | `9f5dd87d-418e-43af-a3fe-8dd89cecd93f` |
| 2745 | Salsa Limon | `985da367-af1c-4721-a202-16544e9cee34` |
| 2746 | Salsarita's Fresh Mexican Grill | `a516c262-a3e3-4d6d-a7a1-e71e0ca4ce1e` |
| 2747 | Salsarita's Fresh Mexican Grill High Point | `a01020ad-b948-40f6-bf8f-e31d58fdaaad` |
| 2748 | Salsas Don Sebastian | `04e54926-d5eb-4300-babd-629ddb88ca2e` |
| 2749 | Salt Tacos y Tequila | `e741947f-16fb-4dbd-9580-52287053f5f3` |
| 2750 | Salt Tacos y Tequila Glendale | `553bd7ab-12e3-4ffd-bd26-cd648cc41b9f` |
| 2751 | SaltFire Brewing Taphouse | `d2c80e80-bfb5-4880-a98d-082c9b8e94f4` |
| 2752 | Saltgrass Steak House | `33954a72-08b4-46ec-90e2-03bcbbbd7821` |
| 2753 | Saltgrass Steak House Dallas | `736d0333-3074-4ce0-8ea0-73d1096225f8` |
| 2754 | Salubrious Juice & More | `17dcd24c-116f-47c1-82e5-8a3739baae4d` |
| 2755 | Sal’s Nashville Hot Chicken | `1a452386-a29b-4d9f-bce0-7c8aa43e8be5` |
| 2756 | Sam and Curry | `403ee43e-9dab-4c42-acc7-307a101857e9` |
| 2757 | Sam's Chicken | `acc94062-edd9-4d27-9ea9-f37192a76f1b` |
| 2758 | Samurai Sam's | `551f77f1-abdb-450f-8d0b-ade26559cfca` |
| 2759 | Samurai Sam's Phoenix | `da048e79-f9f6-4185-a5f0-b78cc7a98293` |
| 2760 | San Martin Bakery & Restaurant | `9a1b8fe2-a96d-452b-824a-925a60c8ddfe` |
| 2761 | Sanabels Mediterranean Grill | `6308858f-2604-4c9b-9692-5dfd23a697f4` |
| 2762 | Sandoitchi | `80df8b7c-39b8-4db4-be53-0c4241af9325` |
| 2763 | Sandwich Monkey | `24b756b1-f622-4ddc-8cb6-3461207585a6` |
| 2764 | Sankalp | `2c1b7b9e-9bd5-403e-9cbe-de24dfb1a6ed` |
| 2765 | SanTan Brewing Company | `17be68a9-1b34-4a69-9afe-61da72548093` |
| 2766 | Santorini Greek Grill | `32014344-1c43-4fa9-a513-3710b876c008` |
| 2767 | Saquic Taco | `fe9909d8-d81a-42a5-aa80-0a1c4b09b26d` |
| 2768 | Sara's Market & Bakery | `49712b90-ce0a-4b02-91a0-90fcb2122b2c` |
| 2769 | Sara's Pizza | `1b8c28f9-1326-4a4f-9486-c7a2461cf1b0` |
| 2770 | Saratoga Bagels | `a96b9f46-2034-43d2-840d-0f4bb0200dca` |
| 2771 | Sassy's Cafe & Bakery | `0f804b16-984d-4d71-88c8-39cecd0c5723` |
| 2772 | sate texas indonesian bbq & cuisine | `c8ededc0-dbb7-4896-a663-a1800677d61d` |
| 2773 | Sauce Pizza and Wine | `edbeb6a4-5195-4c5a-b99f-e0f09b2cc36c` |
| 2774 | Sauce Pizza and Wine Phoenix | `de14d207-fecf-45d5-a087-fe23d70089ba` |
| 2775 | SauceBros Pizza | `7690e150-eb7a-4389-b07c-199ce84c60ff` |
| 2776 | Saucy's Southern BBQ & Cuisine | `7211a9bb-ac1c-496e-be77-6487f802b03b` |
| 2777 | Savie Cafe | `27adf326-8a28-48d4-8ca0-3bc0b0312aea` |
| 2778 | Savory Kitchen (Chef D’s) | `08653549-9ef7-40a9-b261-a0c74b7d73a5` |
| 2779 | Savvy Sliders | `be3391f5-af37-4103-9f6c-95f62f5baad6` |
| 2780 | Savvy Sliders - Battle Creek | `c2845ebc-1e0b-4ccf-b3e1-b989c8209743` |
| 2781 | Savvy Sliders - Brook Park | `3824ebad-b4ce-4555-901b-395bb184b96c` |
| 2782 | Savvy Sliders - Cincinnati | `cedd3914-ab49-4ba6-80d4-7c4ba5ab871b` |
| 2783 | Savvy Sliders - Columbus | `dd1b3960-904b-477e-8b2f-ead5e3648f3c` |
| 2784 | Savvy Sliders - Commerce | `c29db912-81b9-4e42-8c78-5317e5f15197` |
| 2785 | Savvy Sliders - Detroit (Store 006) | `f68d0790-76fa-481d-ba5d-6eb6b43b503d` |
| 2786 | Savvy Sliders - Detroit (Store 100) | `d829b5a5-d903-4846-9d9f-d022507b1e9d` |
| 2787 | Savvy Sliders - Shelby Twp | `97a4843f-b2dd-43bc-bbc9-df49db5f2586` |
| 2788 | Savvy Sliders - Southfield (Store 008) | `7daaa5f5-0811-49c8-85db-5a9613a28cdb` |
| 2789 | Savvy Sliders - Toledo | `82c041a8-f292-4148-9089-a0ff503b5324` |
| 2790 | Savvy Sliders - Westland (Store 027) | `4a5ff5c0-5861-43e0-8df6-a34def6e37b6` |
| 2791 | SaZa Serious Italian | `0220085d-f60d-4d2d-a824-c915ec897a56` |
| 2792 | Sbarro | `45a7faff-fb91-4e3b-92d2-b0930b6e419c` |
| 2793 | Sbarro Boise | `12c74a52-30e7-41db-bc87-8f03dd76e75a` |
| 2794 | Sbarro Mesa | `e0e4a040-bbdb-4614-bc1f-f595138720d6` |
| 2795 | Sbarro Mesquite | `77e3ac21-1fa9-4195-bbbe-611477e18b21` |
| 2796 | Sbarro Spokane Valley | `118af035-b0b5-4613-9623-b77bdb9c708e` |
| 2797 | Sbarro Winston-Salem | `94e51156-1e8c-4ecd-8108-9d4893ef3da5` |
| 2798 | Scardello | `c69e97e2-d4f2-4945-99a8-ae27b66182e7` |
| 2799 | Schlotzsky's | `818c6ab1-a6c8-4f1b-877d-bd82eb42304a` |
| 2800 | Schlotzsky's Dallas | `a3d0fe07-a066-4023-ba38-8c7da5949b18` |
| 2801 | Schlotzsky's Huntsville | `e42634fa-53b9-4e9c-bb9b-1b4fb6285933` |
| 2802 | Schlotzsky's Phoenix | `b7da55c4-ac03-4a7f-a402-078368b10ae8` |
| 2803 | Schooners Grill | `6c711540-0e96-4d76-a2c0-a7c9362add32` |
| 2804 | Sclafani's New York Bagels & Sandwiches | `bfff7b0e-0502-4ded-9e33-dc734fa29374` |
| 2805 | Scotty P's | `d4e5f119-04c8-4de5-8ba3-28d5dd12c4d6` |
| 2806 | Scramble | `464f5922-89ad-4e0e-86b8-e572843ef404` |
| 2807 | Scratch Bakery | `93aa5ecf-9c7d-42d2-a2b0-ff1bd84708c0` |
| 2808 | Scrumpdiliumptious | `08cbd2b7-86ee-4f71-aac4-a7c41d9a8e74` |
| 2809 | Scrumptious Events Atlanta | `scrumptious-events-atlanta` |
| 2810 | Scrumptious Fare Catering | `f77d2136-402c-462e-af54-08d7ae0b3bca` |
| 2811 | Sea & Soil Co-op | `8e98456f-5ca1-42e3-8b8d-bbef8ee195f0` |
| 2812 | Seasoned Street Food | `a1489e22-d32e-4e91-8d9b-bf8a59e0baea` |
| 2813 | Sedona Taphouse | `97a2fb98-13cc-4d35-ad3d-717645534ca5` |
| 2814 | Seido Sushi | `3c7d862f-ae9c-4f43-b609-b87af6e5f9a7` |
| 2815 | Semilla | `336cf993-b34f-4501-a7d7-553d6f471af4` |
| 2816 | Seoul Kitchen | `85dbd8d0-724c-44ba-b10e-5d3e9af23338` |
| 2817 | Serendipity Catering | `9c3ceb04-1971-4db7-ad83-2b6f92b1cf67` |
| 2818 | Seto Japanese | `1d60e65d-37b8-4123-8747-cea483e73268` |
| 2819 | Seven Doors Kitchen & Cocktails | `f714b7bc-454e-4b8d-88ee-07b859ddfdd4` |
| 2820 | Sgt. Pepper's Pizza | `6daeb710-1f7b-49ed-9c7e-54ec43a95ffa` |
| 2821 | Shaggy's Burgers and Tacos | `1fe32d00-819f-487e-99a5-c16854bb4de4` |
| 2822 | Shakedown Eats Food Truck & Catering | `8b40adb1-c216-40e7-a7e7-913ddea85e26` |
| 2823 | Shana Thai | `7eac81bf-c51b-43d3-a73b-644b77388614` |
| 2824 | Shane's Pizza on 87 | `b202198f-c087-4685-b05b-148a9735bbb8` |
| 2825 | Shane's Rib Shack | `b451323c-a799-4041-aa9a-c32e319dbec9` |
| 2826 | Shane's Rib Shack Glendale | `c1fe0e89-b427-4aa5-b736-fb2260bb68d1` |
| 2827 | Sharko's Catering | `ea68b1ca-0e39-4772-b982-79eb9ae9412a` |
| 2828 | Shawarma Bar | `36a363f0-7994-4f20-ba74-e94537e1015b` |
| 2829 | Shawarma Mediterranean Grill | `afae7992-8f7e-46e7-8e77-4287a43a7aa6` |
| 2830 | Shawarma Paradise | `c1d236cc-bcbd-455a-b5ec-1a6fe9f364a9` |
| 2831 | Shawarma Press | `9b8e2f06-7110-42da-9bc9-ef09b2848a2d` |
| 2832 | Shaw’s Grocery & Catering | `d98b6626-116c-4878-aab6-6884afc94ba9` |
| 2833 | She Z | `244d74f5-44ae-4264-9136-ef95ffa8161d` |
| 2834 | Shinnecock Lobster Factory | `c041227d-b195-4e4f-92ba-4da8159adc45` |
| 2835 | Shipley Do-Nuts | `305434da-2cab-4d9c-9926-3a43c57d57a5` |
| 2836 | Shishman Halal Mediterrenean | `429bcb68-7334-46c5-8563-7bbfaab163b8` |
| 2837 | Shoagies | `714215fe-2ac9-4be4-b04a-097bf2b9d5fd` |
| 2838 | Shopey's Pizza | `ef740eaa-7d4f-46f6-8220-9aaeddd69097` |
| 2839 | Short Grain | `4e2f043b-b3b6-48b6-91d8-400a9d0234b7` |
| 2840 | Shorty's Diner | `f3216e13-068c-426e-ad82-e0bef0449b71` |
| 2841 | Shorty's Sandwich Shop | `3fcac40c-d8f8-4e28-997e-91b899e6140a` |
| 2842 | Shuk | `d2b049bf-e320-445d-92b5-105da094d82e` |
| 2843 | Si Senor Restaurant | `7540fa74-6366-48a6-94f2-f3cc59bdfb41` |
| 2844 | Siam Paragon Thai Cuisine | `a618affc-75e6-49de-a012-fc868dc021db` |
| 2845 | Side Chic | `ce29aa4e-3b20-4e37-bed2-913f23f0b958` |
| 2846 | Sigree Indian Restaurant | `751fc5ff-a5e6-4171-894d-28219f0de970` |
| 2847 | Silver Diner | `2d745951-d492-4c5b-9f83-974cec0777ad` |
| 2848 | Silver Fox Steakhouse | `5e3d1798-aac5-4d6d-9022-a296451d3af0` |
| 2849 | Simply Shroom Cafe | `9179e406-7f06-4d17-be2a-2097995cd0da` |
| 2850 | Simply Southern Cuisine | `c44c226f-7ae1-49d0-b535-54df74fb6065` |
| 2851 | Simply Thai Kitchen | `5983b5fa-a4a4-459e-a895-733b427a0ac7` |
| 2852 | Sip + Co East Village | `4cd1e9f0-9d49-4081-a5a8-71ac30d6240d` |
| 2853 | Sitar Indian Cuisine | `d7d05eda-660b-4731-9fc2-443a711b5d87` |
| 2854 | Sizzler | `5c0b68a1-0e65-4197-9cc5-f2e236c5dc77` |
| 2855 | Skrimp Shack | `9bde3677-08a1-4179-a3ab-7281ec62660b` |
| 2856 | Skrimp Shack Chesapeake | `cb76b835-5c8f-4289-a2a1-644fb385e908` |
| 2857 | Skrimp Shack Norfolk | `478f9a3b-a01f-4679-84c0-35e4da5a212b` |
| 2858 | Sky Rocket Burger | `c3fe3932-093d-436c-9e48-232bf89973b2` |
| 2859 | SL Kitchen | `e3a9eb5b-0b0b-47ce-8de5-4331cfa93da8` |
| 2860 | Slate Cafe - 2nd Ave | `slate-cafe-2nd-ave` |
| 2861 | Slider and Blues | `7ca61766-23dc-4a18-b406-c9b1c9c19ff1` |
| 2862 | Sliderz | `945e42e8-0c0c-4bfa-9b57-1263e84ba80e` |
| 2863 | Slim Chickens | `cbb8b0f3-d92d-4968-88a4-28c66f5d6bf0` |
| 2864 | Slim Chickens Dallas | `5ccdb0d0-3e08-4129-8258-fab2d495905e` |
| 2865 | Slim Chickens Glendale | `5dba398d-387c-4dde-bd37-4d8833d45a7b` |
| 2866 | Slow Bone Barbeque | `1ee625a6-eeae-4c98-8a14-6975030bea66` |
| 2867 | SmackBird Nashville Hot Chicken | `8433176a-2bbb-400d-bb6b-f8069661f027` |
| 2868 | Smacky's on Broadway | `72f869f2-a788-49a4-91a3-39c03881f37f` |
| 2869 | Smallcakes | `26621823-fa79-4abe-9e2d-333f9fb8c0d1` |
| 2870 | Smallcakes Frisco | `0624c3a1-9549-48de-84ee-852208db6c9e` |
| 2871 | Smallcakes Stuart | `0c1aab97-8310-4aea-ae2f-4c9c4b349b04` |
| 2872 | Smash City Burgers | `250397a3-5983-4087-8ce3-ecd5666c6032` |
| 2873 | Smashburger | `2bea6e89-d2e3-4c26-903c-6263e42604a7` |
| 2874 | Smashburger Boise | `413ef177-f22b-4de6-a643-e9ad0ddae347` |
| 2875 | Smashburger Chesapeake | `f444b7ae-d045-4169-8160-d7695fd07565` |
| 2876 | Smashburger Phoenix | `604b6241-3e01-4cfb-8065-dbabe0d96f64` |
| 2877 | Smashburger Richardson | `22bdab70-59dc-4c6f-a7cc-fcfb27593feb` |
| 2878 | Smashburger San Jose | `2f7d110d-88fd-4cdc-8799-317329f70021` |
| 2879 | Smashburger Scottsdale | `99ddc314-ea37-4a19-b2b9-a0d3423ba698` |
| 2880 | Smoakie Kitchen BBQ | `04264ccb-19fa-43ed-9885-e7f98b2d4c18` |
| 2881 | Smoke & Thyme | `cf72de91-8816-43c9-a6a8-8e38b6ab2a07` |
| 2882 | Smokey Bones | `21e6fb72-86ab-43d8-9568-68ae7311d330` |
| 2883 | Smokin Fins | `31045a5f-e3aa-44ec-8053-b55ea83e8351` |
| 2884 | Smoothie King | `4d0a5bbf-e195-4f69-a29f-d0afd51971c4` |
| 2885 | Smoothie King Phoenix | `adb967e7-c047-4d51-8b31-7d5b2dfa9408` |
| 2886 | Smoothie King Phoenix | `98133877-441c-4f29-9c31-b42e86569a89` |
| 2887 | Smoothie King Richardson | `c8d5454e-67dc-4896-9dc2-4ac2ce947bb0` |
| 2888 | Smoothie Run | `07c8b0be-bd16-40f4-8f78-a4710302d8c3` |
| 2889 | Smögen Appetizers | `57d6ce37-b484-4a11-9e97-04bd03eac7a9` |
| 2890 | Snakes and Lattes | `b45b5340-555a-4bdc-8b38-bc4231b3eaa3` |
| 2891 | Snap Kitchen | `d06e51bd-8d32-47a0-b7f2-099487cade8e` |
| 2892 | Snappy Salads | `96fc9ac9-17bd-4041-80a6-c578f9642091` |
| 2893 | Snarf's Sandwiches | `af55f669-71eb-4fbf-8457-9d893f832a12` |
| 2894 | Sneakybird | `dc7086a7-7cbe-4470-b27b-2d64ad8d8077` |
| 2895 | Snooze an A.M. Eatery | `1cb8be3a-f447-495d-9f6d-06401f5b4969` |
| 2896 | Snooze an A.M. Eatery Dallas | `f1a9bf5c-86a9-4bf5-b76d-0790b1ccff67` |
| 2897 | Snooze an A.M. Eatery Phoenix | `f9b169bb-9baf-4335-a9dc-74880f66eb24` |
| 2898 | Snooze an A.M. Eatery Tempe | `21128410-7789-4167-8d08-cb5700638346` |
| 2899 | Snuffer's Restaurant & Bar | `26e7585f-6174-4624-9823-4ee06791c230` |
| 2900 | Social Pie | `50a877c1-ea3d-4bd9-8905-47dae5c00e61` |
| 2901 | Sofrito Latin Innovation Kitchen | `16b88a10-5ad9-4812-8b9b-ab3bdc4ab7ec` |
| 2902 | SoFull SoulFood | `ca3c6731-ba68-4175-be72-357fefbac7b1` |
| 2903 | Sol Mexican Cocina | `0df7f452-436f-49ca-9b06-8a453adb077a` |
| 2904 | Solo Burgers and Wings | `6a6a8c7e-2141-4e9f-9c7e-bfc51b82499e` |
| 2905 | Someburros | `2ee67c1f-4dee-401b-88a1-bfad6fa34331` |
| 2906 | Someburros Peoria | `9b1499c8-06ed-45ea-8166-0c63cfdfa1fe` |
| 2907 | Son of a Butcher | `21556fb0-2acb-42f2-8e65-ab04bcc577df` |
| 2908 | Sonny Bryan's Smokehouse | `abfb6cd4-0fc3-4660-927c-977115331660` |
| 2909 | Sophia's Kitchen | `d88970f3-c565-4f0d-a099-2d929443f3ec` |
| 2910 | Soul 2 Go Catering | `37ef565e-25ef-4859-b71f-361c6b49fcaf` |
| 2911 | Soul Foods India | `c45d0181-798a-4d66-a805-a403e41589b3` |
| 2912 | Soul Taco | `4cd0e0a1-8af2-483b-9772-9eaf24e9417c` |
| 2913 | Soulman's Bar-B-Que | `ee2ef991-7a0f-4aed-a4cc-23117801e12c` |
| 2914 | Sourdough & Co | `77f91d4c-53fe-4bad-bc66-42387e2df01d` |
| 2915 | Sourdough & Co. | `72970ee3-7bf6-4de3-98e0-71f3e437e63f` |
| 2916 | South Winchester Barbeque | `5c5df0d9-f8cd-48c9-a33d-3366714b6652` |
| 2917 | Southern Comfort Catering | `8012a87c-8224-467f-bc36-92071045827c` |
| 2918 | Southern Gourmet Kitchen | `8ea4409f-3241-4213-bbf1-da705cfcdcd6` |
| 2919 | Southern Roots Smokehouse | `0a8d1c18-19f2-4c69-af92-c58c2b21d446` |
| 2920 | Southern Spice TX | `845a1232-5b22-4cac-9d3f-6b668257e47f` |
| 2921 | SouzaFit - Mount Vernon | `0c156d51-9ba2-4fa8-a79f-2d5bfb151a09` |
| 2922 | SouzaFit - Newark | `7f606df5-c747-4af5-bd8a-4aa3591e6667` |
| 2923 | SPACEBAR CAFE | `a7a4fd65-d003-427b-a3d0-1d0e7728cebd` |
| 2924 | Spazo Restaurant & Bar | `610ff66b-9f8f-4d7d-a10c-d818fbd28389` |
| 2925 | Speedy’s Fish & Chips | `f129e662-b563-4661-991c-d71f46bb14bb` |
| 2926 | Spice Creations | `dc24c499-99ef-44ec-aa5a-bcf7ac4a426d` |
| 2927 | Spice of India | `0d15e9ab-2c92-4c29-9e88-ba628511534b` |
| 2928 | Spice Rack | `cce7d28d-1ef3-4888-b4b1-439558c34f88` |
| 2929 | SPIN! Pizza | `ef313c1a-38a1-4b99-a70f-d68dd5b01b5b` |
| 2930 | Spinato's Pizzeria | `d08a104b-da5d-4280-a68f-0a1cf74d0ed6` |
| 2931 | Spinelli's Pizzeria | `0fb539b6-47b2-48e9-a9dc-bc695245a317` |
| 2932 | Spiro's Taverna | `9f3933dd-4b6d-49db-a7ab-896cf65b492e` |
| 2933 | Spiros Taverna | `e6d97dd4-9955-47ab-9f40-0c30efcb29df` |
| 2934 | Spitz | `e02943b8-1a9d-4670-a8bd-c74aa848e850` |
| 2935 | Spitz Goodyear | `573d29a1-cbbe-4faf-b5d2-ef2afc61dcd5` |
| 2936 | Spitz Plano | `b54a4202-f1d2-4329-b293-4e491698ba56` |
| 2937 | Spitz Tempe | `52af1e74-b618-4846-9257-8d216b507d60` |
| 2938 | Spokes on Southern | `e5b3ba07-6178-4254-96ab-f20cc51c171d` |
| 2939 | SportsBook of Charleston | `9c12159a-f3d8-4cfc-8e71-8f3e10d68e09` |
| 2940 | Spread & Co | `9d969a03-ca77-46d3-8076-dd8ce6fb0f9d` |
| 2941 | Spring Lake Seafood | `0c9b001f-fbf7-496b-ad0b-c48b6231f0a0` |
| 2942 | Sprinkles | `784ab413-a8cc-445e-b4ec-fc9bb0a15e94` |
| 2943 | Sprinkles Dallas | `81f01dbc-9c40-4dc8-a79d-fb4e2d3aa706` |
| 2944 | Sprinkles Scottsdale | `c5f957b2-853a-43e9-9ab3-b8a61b38a567` |
| 2945 | Sprout Cafe | `a27e9746-abe4-47ec-8ac2-99edcd0b7222` |
| 2946 | Sqirl | `f0655c87-1c0c-4ef2-b884-1e8817f0e647` |
| 2947 | Squarz Bakery & Cafe | `dfb4ba87-189e-4e43-9e38-74e5b0908f88` |
| 2948 | Sr. Ozzy's Tacos Y Mariscos | `e9364675-b76d-4ea9-861f-aa860a96e891` |
| 2949 | Srasa | `9f0ca414-0bf6-4b9d-8451-895ee1d9373d` |
| 2950 | Sri Venkateswara Grocery & Kitchen | `35b5c792-d04d-47a5-8ed5-247ca97e8fe6` |
| 2951 | St. Roccos | `0df1f85a-e803-4741-afa7-cfa5898d6c37` |
| 2952 | Stacked Deli | `61c5bbbf-e661-49f2-a455-38c379977178` |
| 2953 | Star Catering & Cafe | `9d4e9500-169c-4764-99a7-721bf437d8f7` |
| 2954 | Starbird | `cd897429-2916-4d29-8617-58f2e78a2ba2` |
| 2955 | Starvin' Arvin's Meal Prep | `c6a82abd-af77-4932-a3eb-c6446fb96f04` |
| 2956 | State & Allen | `b2100ea5-5616-45ea-a349-d9fa93cdc851` |
| 2957 | Stateline Subs and Pizza | `30f8b1cd-2b6c-4d21-8c4a-44a5c905f563` |
| 2958 | Steak 'n Shake | `5b8cf0ca-097d-487e-b237-ba3b73b507a4` |
| 2959 | Steak 'n Shake Plano | `cdb5df59-324b-46c9-a162-ee662585eeac` |
| 2960 | Steak 'n Shake Stuart | `79f958ec-a325-4fe9-af15-bb11f3b1cc3c` |
| 2961 | Steam Boys | `dac2688e-384b-44cd-b219-0ba3cf2cdb6c` |
| 2962 | Steins Beer Garden | `a7c063c4-8554-4e85-84b5-7955de1f96e0` |
| 2963 | Steve's Krazy Sub | `1fa4cd54-080c-436e-ba59-ddbca92011c9` |
| 2964 | Steven's Corporate Catering | `d856c70f-7f62-42d7-ba27-b3d5c366fce7` |
| 2965 | STICK TO MY POT | `23c6bb4d-c2ea-488f-9fd7-a0e71c724209` |
| 2966 | Sticklers | `fa638d86-80f5-4635-83af-064a83a295d7` |
| 2967 | Sticks Kebob Shop | `5e310288-39a4-478a-818b-3e2bd42653ea` |
| 2968 | Sticky Fingers | `1c59018f-9d12-44ef-a3a0-e6c58301c851` |
| 2969 | stingaz empire | `7068846e-9cf6-40e4-80af-475ce18e169d` |
| 2970 | STK Steakhouse | `ea5b6296-ed5d-4a71-bc58-e21a01f15fb3` |
| 2971 | Stockyard Sandwich Co. | `48d98c8e-4367-40c6-b2d9-982cb4eefa20` |
| 2972 | Stone & Vine Urban Italian | `ed3b3d04-a0a9-4fa0-b47f-0f875a7e6135` |
| 2973 | Stone Stew | `48782b39-09c3-4077-b8c1-26f0180fa502` |
| 2974 | Stop-N-Go Gyros | `f847d2ba-a96c-4550-bb77-d7ef2cff7517` |
| 2975 | Strawberries Catering | `0f2dafec-1765-4d8d-8ca3-0c712880c9a1` |
| 2976 | Street Bird, Westside | `bf5da449-2c99-4596-8e99-fc9d0f6ca1b6` |
| 2977 | Street Bites | `aeaca623-1a5a-4a7e-90c9-52b6d1694d16` |
| 2978 | Street Suya | `fc263580-7d0b-410d-a760-4a8e995e0030` |
| 2979 | Street's Fine Chicken | `e4095422-af48-4d91-8542-8c17a28d493f` |
| 2980 | Streets of New York | `3f5021c9-2582-40a1-b489-c2933121de2b` |
| 2981 | Streets of New York Phoenix | `6de3f931-7a7b-43a8-856c-f6d52ad5282a` |
| 2982 | Strizzi's Restaurant | `06262525-0be6-4891-b879-5b6259794876` |
| 2983 | Strokers Ice House | `b6d72f03-9621-46df-9faa-d99aded703fb` |
| 2984 | Stufrageous Stuffed Burgers | `e129e3fc-a905-4f4b-9dd9-a6f8dd2c89c5` |
| 2985 | Stuft Pizza | `ee2ae7d2-7344-4490-9ea8-276c72e6b7ee` |
| 2986 | Sub Shack | `6b661255-3aa1-418f-8a5f-c5fc1507e76c` |
| 2987 | Suben Sushi | `9926bc7e-0740-47e0-bbfc-dbcf986af872` |
| 2988 | Subway | `93f0a943-5efa-4644-adf9-0e41c9e792b4` |
| 2989 | Subway Bend | `cac335f5-d3d7-4133-a2c0-7d8a77070c3e` |
| 2990 | Subway Boise | `3cd8dfe1-eb47-4841-be72-01f57ab9eb32` |
| 2991 | Subway Boulder | `c9f27b60-d1b2-4598-9815-b255f78a84e5` |
| 2992 | Subway Chesapeake | `94740d62-1e93-4764-93cb-3bbbbb488eab` |
| 2993 | Subway Fremont | `dd5bc12a-3621-4dfa-b9ce-653c526c2a6d` |
| 2994 | Subway Garland | `022d934e-8b59-435c-a185-3fb11426ce34` |
| 2995 | Subway Glendale | `3f1bf4f2-12cf-4799-8cdf-db0862ec39b2` |
| 2996 | Subway Huntsville | `1e59aab7-0a34-4ef2-8be2-d5d3e0746bf0` |
| 2997 | Subway Norfolk | `8a3a30cb-e4b8-4ac1-950a-0c0cb5cb0e1d` |
| 2998 | Subway North Charleston | `12432820-ca66-412a-bb25-5fffc5f780a8` |
| 2999 | Subway Port St. Lucie | `926647b4-79b5-4561-8cc6-85ba0636a917` |
| 3000 | Subway Portland | `4b8ff42d-5195-4416-bc33-d2fda0c0a093` |
| 3001 | Subway Richmond | `001c9194-ae48-4996-8701-4bd66cb5386f` |
| 3002 | Subway Scottsdale | `d60e3cea-4702-46c5-84c9-86d0b28e4554` |
| 3003 | Subway Spokane | `74c0c819-446b-4d67-a4a7-7453c4496271` |
| 3004 | Subway Winston-Salem | `7a614845-aebf-4b98-aac4-eafbc71e521a` |
| 3005 | Sugar & Sage Bakery | `da154fdf-001f-4219-8e00-0593a457bf4e` |
| 3006 | Sugar Shack Donuts | `969e1f51-a77a-457e-bcbf-99c84b6653b2` |
| 3007 | Sugar Sweet Bakery Company | `8b251224-8543-4e6d-9bca-b191d83be6fd` |
| 3008 | Sugarfire | `82949b77-6826-4ef5-95eb-0aa47858252b` |
| 3009 | Sugo.Cooking | `574f71c5-72a8-4958-a1f7-7afcbb14e484` |
| 3010 | Sultan Grill | `da6757ed-2051-4b5b-b280-3d4696424c69` |
| 3011 | Sultan Kebab and Falafel | `4fada2fa-1be2-4820-8237-eaa6111a59c5` |
| 3012 | Sultan's Kebab | `72e9fcba-8291-4bfb-b6d0-13d969820d3f` |
| 3013 | Sultana | `69fbc6a3-800b-4578-8765-5c17a610a6b8` |
| 3014 | Sultana's Cafe | `b99ff4b1-08f9-4d4b-9d43-493b28e53ced` |
| 3015 | Sum Dang Good Chinese  | `776e4ffc-c475-4e02-8399-0e546153c89f` |
| 3016 | Sumac Mediterranean Grill | `362c4a2b-6ce9-44a9-be41-2be16a6fd3fc` |
| 3017 | Sumela Restaurant | `654376f0-f573-442a-8de8-c26a92b37862` |
| 3018 | Summer Salt - Flatiron | `9e4996ca-eebe-4928-b280-42d41a060a74` |
| 3019 | Summer Salt - Midtown | `52164999-dd5b-4e01-a07e-62b655655be2` |
| 3020 | Summer Salt - Union Square | `8a5defcc-b530-4b8c-be9b-9e205116ca8c` |
| 3021 | Summerville Burrito Co | `477aa0a6-7eb1-4942-8225-01c90bfdd795` |
| 3022 | Sun-Ly Chinese Foods | `96bf0e55-30a1-4bbc-8794-8ce2a3e7c755` |
| 3023 | Sunfish Poke Bar | `cf71bbb0-d69d-4932-919c-7550b66a0b98` |
| 3024 | Sunny Street Cafe | `ce536bf3-a4b2-4818-8420-c4392417f89a` |
| 3025 | Sunrise Caribbean Cuisine | `81457450-52f2-45d1-85eb-1d49173350b9` |
| 3026 | Sunrise Pizzeria Family Restaurant | `bfa7e67a-6874-47b3-9ac2-6a5fb3ea5d99` |
| 3027 | Sunset Squares Pizza - Divisadero | `016b97ee-3ecc-4b51-b560-4be6c9ee3145` |
| 3028 | Sunset Squares Pizza - San Jose | `7d0e3526-eb09-4abe-84a3-06f72b0afde3` |
| 3029 | Sunshine Breakfast Bar | `67eca42e-b5d8-48a4-8ca5-f44f844070b1` |
| 3030 | Super Chix | `313c24ca-2c3d-4d09-bd8d-54400f91503e` |
| 3031 | Super Chix Chesapeake | `c3c263be-36df-4c04-bf4c-2918d887a8da` |
| 3032 | SUPER CRAB JUICY SEAFOOD | `a1f08302-44cf-40e9-af09-93b9c6361078` |
| 3033 | Super Mac Bros | `011e8c96-f855-462b-8f93-1b1668b456f9` |
| 3034 | Superhero Chefs | `518225ba-b300-44c9-b991-4912cb544c5c` |
| 3035 | Surf City Sandwich | `4351e801-f22b-4a5a-8c6a-f34c67bdd4a8` |
| 3036 | Sushi 85 | `4e1049cf-920e-4af9-be09-678b9f027e69` |
| 3037 | Sushi Brokers | `a7768529-e894-48a8-bea4-29a03794aa93` |
| 3038 | Sushi Confidential | `66df2f07-67e6-421b-a5ef-d360e2cb705c` |
| 3039 | Sushi Dojo  | `aab63601-e663-4099-bba7-ead63d9c3d7e` |
| 3040 | Sushi Ichimoto | `bddfa45b-4fd2-4182-a55a-a9ef1c8b7a8f` |
| 3041 | Sushi Kuro | `f1eef6db-060d-4051-9d42-3b5918e08ed6` |
| 3042 | Sushi Leo | `73262779-9a1c-46ac-b877-2296b9a5af61` |
| 3043 | Sushi Mockï | `ae328d27-a1fe-4df8-a953-fc2d4ec43af0` |
| 3044 | Sushi-To | `9c9aaa8c-3915-4105-80e5-2914754e46ef` |
| 3045 | sushidan | `aaabdef0-a75a-4b29-891a-e1245c6a0ad5` |
| 3046 | Sushime Asian Bistro | `f38839e5-2027-4d14-b508-df876b71d581` |
| 3047 | SusieCakes | `ad74c30a-4b58-48d2-9fce-878914b4f2cb` |
| 3048 | SusieCakes Dallas | `f3d9ad88-17aa-4d30-98a7-03a990aafa37` |
| 3049 | Swagath Biryanis Indian Cuisine | `933513c7-d530-4578-8f7e-cf2700eba97c` |
| 3050 | Swamp Cafe | `e9de1894-53af-4a1e-b09e-0b28ccee5f94` |
| 3051 | Sweet Bella Soul Food Kitchen | `4dbb1518-ff56-4fe4-b02c-db8a90bf67b1` |
| 3052 | Sweet Chick LIC | `449f0f26-8158-4e44-8e03-9511ba631ab6` |
| 3053 | Sweet Chick Lower East Side | `9092e66f-7663-46e1-b4cd-066a71f2aed1` |
| 3054 | Sweet Chick Prospect Heights Brooklyn | `0429055e-1615-4398-b586-1a7d72259eac` |
| 3055 | Sweet Chick Union Square | `df452f74-e17b-4d47-910c-8bc783666a71` |
| 3056 | Sweet Chick Williamsburg Brooklyn | `44da53da-558f-4488-9339-7bec12d62969` |
| 3057 | Sweet Hut Bakery & Cafe | `a8d6bc8c-152b-4c4a-af86-7029ddb4d53d` |
| 3058 | Sweet Julep's | `cf9b19f8-b9f1-4157-8489-f5249c08936e` |
| 3059 | Sweet Lake Biscuits & Limeade | `78b8c16e-b5c5-4a7d-b11e-98325f4cb5d2` |
| 3060 | Sweet Magic | `3c507473-34b3-47c1-8694-559eee96e165` |
| 3061 | Sweet Magnolia Smokehouse | `071cd936-01aa-41df-89c2-d4c3121111e5` |
| 3062 | Sweet Tooth Custom Cakes | `87013a0e-9ad4-4f92-8a6f-7304c074e57c` |
| 3063 | sweetFrog Premium Frozen Yogurt | `1677e37c-bfe5-43d9-bb4e-27efc68bd0c3` |
| 3064 | sweetFrog Premium Frozen Yogurt Norfolk | `69263e76-1b99-44d3-be04-b41b7b4f031a` |
| 3065 | sweetgreen | `cf36189f-5150-41b0-a65c-b576a327460c` |
| 3066 | sweetgreen Dallas | `38e733d5-d3e9-4a32-98a2-6407f2764ead` |
| 3067 | sweetgreen Mountain View | `f0d59d40-5df2-4e9a-b7ec-bc3b30073a1d` |
| 3068 | Sweetwaters Coffee & Tea | `884ef277-1eb2-4bf9-bf6a-d443012e2e0c` |
| 3069 | Sweetwaters Coffee & Tea Scottsdale | `d0884973-c851-4526-959f-abc1efe5c1ad` |
| 3070 | Swig & Swine | `bd0815c6-d440-45c8-a276-89a3625a2819` |
| 3071 | Sycamore Tap Table | `ec01c86e-fc7d-4fb2-8d60-1090ba2ced6d` |
| 3072 | T Swirl Crepe | `f64f182c-a9b8-4d6c-b37c-e36956f5e916` |
| 3073 | T&T Fusion | `97660c45-cbb1-4213-911a-3b98613094d7` |
| 3074 | T&Y Hawaiian BBQ | `561ab1ef-8faf-47da-9ac7-e85b7623ce02` |
| 3075 | T4 | `2aad8520-2721-41c1-ac13-249b731a7ea3` |
| 3076 | Ta'Carbon Mexican Grill | `d76f4ccf-4038-4891-aa73-3361b4cc14f4` |
| 3077 | Taco Bamba | `c93dda51-5408-4e9e-ba39-0b84d6fdb0e4` |
| 3078 | Taco Bartina | `b126f659-3ab4-4a2d-814e-54d7b8e74ade` |
| 3079 | Taco Boy | `96fb7fa2-9b41-48d1-b620-08662cfb72ca` |
| 3080 | Taco Bueno | `33029efb-a142-4898-9efb-966d4a957df8` |
| 3081 | Taco Cabana | `74bbaf7a-13e3-4607-8871-ba2cb602acd4` |
| 3082 | Taco Chisco | `b7f49bd6-c427-46a7-8dec-2604d29a2e5a` |
| 3083 | Taco Del Mar | `3bfb79ea-f970-4590-960e-13d0ec700cc8` |
| 3084 | Taco Del Mar Boise | `c152527b-7be8-465c-b6c3-51230044731a` |
| 3085 | Taco Guild | `78f07d38-405f-46c6-898a-39af56d457e2` |
| 3086 | Taco In A Bag (North Charleston) | `71d45a8b-9a5e-4222-af3e-8728235b31c3` |
| 3087 | Taco John's | `bce0d20f-1a56-4359-85e1-8183c62f037f` |
| 3088 | Taco Joint | `68ecb8ae-62d7-40f4-ba01-d88da6e99f7d` |
| 3089 | Taco Ocho | `08ce13fb-0121-4318-ae5d-2af817b36fdc` |
| 3090 | Taco Papi | `25836e86-0002-48a5-a06a-f8dec7da3a00` |
| 3091 | Taco Y Vino | `43897a99-20ae-4f80-8cdf-577cdd9f84be` |
| 3092 | Tacodeli | `4cc31925-c0d0-4691-9d07-a63be56a5fe5` |
| 3093 | Tacolicious | `cdb402ab-638d-4329-9dee-55972eb31182` |
| 3094 | TacoLingo | `e45f7eae-6d4e-4db1-a33b-5c492942b7c7` |
| 3095 | Tacos Calafia | `ed0b4134-de4c-4df8-abb2-07acb736d3de` |
| 3096 | Tacos Don Jorge | `11d6199e-f0e3-416a-8b13-bb416b698b97` |
| 3097 | Tacos Don Manolito  | `c0f4db2d-62a3-4399-8484-a2c13a23681e` |
| 3098 | Tacos El Grullense | `86c25c97-195d-4172-9944-041164df98dd` |
| 3099 | tacos la calle | `e05b9f87-e47a-4c6f-af12-79aa3793822a` |
| 3100 | Tacos y Mariscos El Limón | `d343382e-e445-4d3e-a7f9-8e58f93f3c65` |
| 3101 | Tacos Y Mas | `d047e548-4a9c-4c00-919f-e06c91cba58f` |
| 3102 | Tahn Thai | `edb9dce3-d24d-42f8-bb56-1e87f8da6511` |
| 3103 | Tail-Gators Brews & Grill | `cc1e0ec2-639b-4847-9e91-b6fe85439ddf` |
| 3104 | Tailgaters Sports Bar & Grill | `c12cd6ed-f039-4bac-87c5-416457de5382` |
| 3105 | Tal Bagels | `25d2cbe9-5a49-4ba4-82fb-77b06ba90359` |
| 3106 | Talkin Tacos | `b30eda0c-6d24-45e4-8562-74c331304f74` |
| 3107 | Tallio's | `d0cea6fd-3542-48eb-907e-0fcc2bca9353` |
| 3108 | Tande Thai | `94b4f657-76e3-47ff-815e-88b7fb700de5` |
| 3109 | Tandoori Grill | `684f907e-7898-4ee2-b4bb-c32054b38669` |
| 3110 | Tandoori Kitchen | `fdecf88c-0198-4b9e-8950-8e18b3386f0a` |
| 3111 | Tandoori Pizza | `55044d57-1c11-4ac7-9dcb-b4c5185bedf6` |
| 3112 | Tannourine Cuisine | `7a1a9a2e-02c7-45b9-a932-93ce1833ecf7` |
| 3113 | Taqueria Extra | `659b6eeb-6c82-4635-9de2-99c36936aa13` |
| 3114 | Taqueria Factory | `5e3bf27e-1eff-4dcf-98b3-427856bc55dc` |
| 3115 | Taqueria Factory Tempe | `eb06bda1-40c8-4a12-a123-59984c22c0e8` |
| 3116 | Taqueria La Ventana | `2a2ef95e-fa83-4ffe-8964-b7ef39cbab9e` |
| 3117 | Taqueria Nixtamal  | `117e67ec-9640-4605-b596-8156357309c2` |
| 3118 | Taqueria Taxco | `4fc109e8-ef48-42c3-a65e-50d149470a6b` |
| 3119 | Taqueria Tepito | `042eabb2-0b87-44a1-b70f-ca9c957d296b` |
| 3120 | Taro San Japanese Noodle Bar | `4da8e3eb-333a-4a43-96ac-58e1eae7f550` |
| 3121 | Tarrant's Cafe | `e8449c5b-96b6-4219-b323-1cfe54fb84bb` |
| 3122 | Tarrant's West | `fb68f173-ef32-4c87-a016-1fdaa83381da` |
| 3123 | Tasi Bites and Blends | `8b44640f-ac53-4656-91db-e8aa2d8b8f2b` |
| 3124 | Taste Catering | `4c487ade-5071-4009-a1e1-8ed7f3e16a62` |
| 3125 | Taste of India | `bc4d7dcb-a09e-48bb-898c-172f69b5e4c5` |
| 3126 | Taste of Persia | `183f3dea-8579-40b7-9d80-adadaf13d40b` |
| 3127 | Taste of Tokyo | `ade56b70-8106-4243-83f7-bd7dae84a4ed` |
| 3128 | Tasty Chicken Wings | `f8cd9740-cc91-41ec-9c31-5a0bd2bd257a` |
| 3129 | Tasty Paella Catering | `0341bf74-187d-4b24-9e1e-657c118e4198` |
| 3130 | Tasty Pizza | `41f68e83-88dc-4302-be09-da718b0726a7` |
| 3131 | Tatum's Table | `3a3a8254-2d8c-42dd-b2a7-66f485e66896` |
| 3132 | tava bar grill | `0ed0a35f-4e35-4ab0-968d-b46dd7758620` |
| 3133 | Taza Deli & Cafe | `17ae4973-d657-46b7-baf9-b76119916ac6` |
| 3134 | Taziki's Mediterranean Cafe | `0b6f574f-16b3-4dbe-be85-5c91791f6805` |
| 3135 | Taziki's Mediterranean Cafe Dallas | `f507ea94-4e02-4932-bf1a-02f85214106c` |
| 3136 | Taziki's Mediterranean Cafe Huntsville | `7384ebb0-7dd3-4d43-b302-ddb66cb031ca` |
| 3137 | Teaspoon | `c021192d-4392-40f3-9bc7-21c29374721c` |
| 3138 | Teazona & Dim Sum | `3f78c962-91ef-49bd-be9f-27bd927fa088` |
| 3139 | Teeny B's Catering Company | `aaff69d7-426c-43ed-9e4d-b9302fb7a73f` |
| 3140 | Ten Sushi | `73c298ed-5a54-4862-b5db-f0613d7bbf8a` |
| 3141 | Tender Box | `02117681-96d9-424c-9024-041304820972` |
| 3142 | Tender Greens | `02d4d46e-8cbc-4d71-80d0-9c321b52be3c` |
| 3143 | Tepeyolot Cerveceria | `d363fffd-7b4f-47ca-83ae-bcdb3d364ab6` |
| 3144 | Tequila's Time Restaurant | `de06c5e9-058b-473d-9564-10a2234acc7f` |
| 3145 | Teriyaki 4 U | `572784aa-69b3-4184-88cb-223e348e22ed` |
| 3146 | Teriyaki City Grill | `4b533880-98c5-4208-b3f5-6a5a3a0cb7c8` |
| 3147 | Teriyaki Dojo | `36297c87-725d-4c17-93b6-506b4fb317f3` |
| 3148 | Teriyaki Madness | `15179fbc-d213-4479-b148-32ea130af7d5` |
| 3149 | Teriyaki Madness Bend | `768e07c2-db28-4ce0-a5c7-ddbf3163f0a2` |
| 3150 | Teriyaki Madness Huntsville | `598b984f-95fd-49da-ba46-4b8b8973fe3f` |
| 3151 | Teriyaki Madness Meridian | `65cda3da-ed3e-4d9b-9a0e-06d5d7806016` |
| 3152 | Teriyaki Madness Virginia Beach | `bb533e09-bd70-4787-b07d-17e2c9be6ef3` |
| 3153 | Teriyaki Tom's | `60862935-e699-47d2-bcf1-a6942008321d` |
| 3154 | Tex-Mex Joe's | `8c5f5b3e-800f-435d-9b63-0f6e9204b657` |
| 3155 | Texadelphia Sandwiches and Sports | `1b4711e0-c537-408a-9c63-0837469aac2d` |
| 3156 | Texas de Brazil | `c897a1cc-fc11-4a87-b3d4-e3463ed87ba4` |
| 3157 | TG Brazilian Steakhouse | `39531f35-b485-4819-b61e-92036bbd5f26` |
| 3158 | TGI Fridays | `bcc738c7-9184-4336-bb8c-7c224f37a46d` |
| 3159 | TGI Fridays Greensboro | `eed79ce7-42e3-4438-91f0-d8659d092700` |
| 3160 | TGI Fridays Richmond | `b5203166-cb1c-48c4-b4df-6731ff52d375` |
| 3161 | Thai Bamboo Restaurant | `c6fc4401-4e24-4892-acf7-ffc2be550016` |
| 3162 | Thai Cafe Restaurant (CA) | `9d310a5b-7c41-4901-a2d6-a02a735c0915` |
| 3163 | Thai Chili Cuisine | `d62d1077-df80-4765-8646-32c629415117` |
| 3164 | Thai Express | `d01aedfb-c691-4dea-afb5-fddfe1359612` |
| 3165 | Thai Kitchen | `306671c3-e62c-40ad-8b1d-d20799a7778f` |
| 3166 | Thai Orchid Restaurant | `60392ace-1cef-4faf-af5b-ea613b2a8f89` |
| 3167 | Thai Recipe | `5f4d7cde-6a9a-4beb-9085-943cd9830494` |
| 3168 | Thai Recipe Bistro | `fbae1964-daba-4099-8455-eea23af7ebf6` |
| 3169 | Thai Soon Restaurant | `eb9425f1-4ccd-43e4-81e4-201a5e129fbd` |
| 3170 | Thai Spices | `706952d2-79d5-4849-bbf2-e2e6d69c8aaf` |
| 3171 | Thai Tempo | `65d60ce6-bba4-4dc3-9f17-5c38fe12ee47` |
| 3172 | Thaibodia | `81ba734b-7c5a-42c2-b010-38c319cd9cc7` |
| 3173 | Thaijindesu Thai and Sushi Bar | `3d415920-a8a9-4275-8004-647aa6e0bc88` |
| 3174 | The Argentos Empanadas | `3cf9b003-50b7-44db-9ade-f818678bcb8c` |
| 3175 | The Artisan | `5ff518a8-b793-4a4c-a5da-7fc8e7c90255` |
| 3176 | The Baked Bear | `e143a39d-bce4-4fbb-96b2-6e4af0e16787` |
| 3177 | The Beach Bully BBQ Restaurant | `9e18c8f3-d925-4087-b92c-2231e5a27527` |
| 3178 | The Beet Box | `ac2266ed-134b-4eb2-aa59-eda63b6828a4` |
| 3179 | The Bloom Lounge | `4975fa57-bc90-434d-ae33-74642dca698b` |
| 3180 | The Board Babe | `5cdbd27a-0f63-4429-9262-f1b6c8835588` |
| 3181 | The Boathouse | `df333960-39b4-4ed2-916e-40f0b329bb1d` |
| 3182 | The Bomb Bar | `c2d0b76a-8f26-4ad5-95fb-c8f1f9d09509` |
| 3183 | The Brass Tap | `3b5d4c27-1a66-4c37-af28-4f5f9b75aeec` |
| 3184 | The Bread and Honey House | `a978bb12-8c27-4a7f-8bc5-4463e3477548` |
| 3185 | The Breakfast Cafe | `910604c9-bb27-4217-87e7-5a0c86319d2f` |
| 3186 | The Breakfast Cafe Phoenix | `eb16558d-acf7-4b36-9281-e05bfd2ad3fe` |
| 3187 | The Breakfast Joynt | `d2429bc7-594e-44be-89f1-9c897ca815ff` |
| 3188 | The Broken Yolk Cafe | `4bdc5b81-05b7-449c-9755-173754e42f7b` |
| 3189 | The Broken Yolk Cafe McKinney | `33b26d9a-5e32-4915-bd34-81343c729543` |
| 3190 | The Broken Yolk Cafe Phoenix | `685ef48f-196d-4da9-8082-9a24429cd891` |
| 3191 | The Budlong Southern Chicken - Hayden Hall | `688c0c44-3d6e-46bd-9ee4-d3ef2129230c` |
| 3192 | The Burger Experience by Smokey Bones | `fba04775-0820-4588-81a8-e0caf184f78c` |
| 3193 | The Burger Experience by Smokey Bones Chesapeake | `49b2096d-b59e-47cb-84a8-c081971b6bfb` |
| 3194 | The Butcher's Son | `4332fb96-abd2-470a-ab39-c061bc00dc5a` |
| 3195 | The Calimex Cafe  | `ce4fb76b-9f99-4351-b73f-787230d4e0ef` |
| 3196 | The Candy Tree | `9c8fb64c-a2e0-4344-a1ad-f4824a256e07` |
| 3197 | The Caribbean Cajun | `f2811aac-8cad-4331-8d9e-ec7da3622c6e` |
| 3198 | The Clever Koi | `6c05d809-5794-4777-b6e2-cda358b0b95c` |
| 3199 | The Cocky Rooster | `e6bdeb9f-af40-483f-b3f7-095900dc8f47` |
| 3200 | The Coffee Bean and Tea Leaf | `96d52d40-4d40-4573-a735-f0b21aed2f09` |
| 3201 | The Coffee Bean and Tea Leaf Peoria | `5a9302c3-61f8-4b62-961f-ebb6d6a6968d` |
| 3202 | The Cookie Society | `b44d7018-b24a-46d1-b46f-264c9153e19e` |
| 3203 | The Cupcake Experience | `954e8871-1303-4588-b453-501eeb68e2e6` |
| 3204 | The Curry Leaves Indian Restaurant | `c5463273-96bf-4f3b-879e-609625f566c3` |
| 3205 | The Daily | `611aefc3-8b61-4146-b4ed-7dd8555aa1d2` |
| 3206 | The Daily Menu | `a28aadb0-3875-422b-b372-dd7ae2dc59b3` |
| 3207 | The Dancing Blender Smoothie Co. | `the-dancing-blender-smoothie-co` |
| 3208 | The Dancing Blender Smoothie Co. - A Kosher Business | `2625cb51-a64e-468d-9b6a-94f722c9dafc` |
| 3209 | The Delectable Egg | `c0c857ed-f914-45aa-a8eb-bfc64bc6cffb` |
| 3210 | The Diner Boys | `7d0c91bd-22ec-4650-a1f4-1ea69a9b5e3d` |
| 3211 | The Dirty Buffalo | `2f610c60-cb28-43f7-97ef-22aa62168715` |
| 3212 | The Dirty Buffalo Chesapeake | `ca8d67f5-728a-423b-94d0-74996ce224fb` |
| 3213 | The Dolly Llama | `400bbad0-a324-4b2f-adb9-3dd4392be98f` |
| 3214 | The Don's Deli | `e15d2ede-1323-4826-9f4c-15e20b89485c` |
| 3215 | The Donut Depot | `2f154fc6-d0b8-421f-aeea-3e29a447a625` |
| 3216 | The Don’s BBQ | `37526402-8671-491e-96a4-2307cf37713a` |
| 3217 | The Dream Cafe | `6d426585-c5e8-4e4a-ad00-e8c895e11cec` |
| 3218 | The Dream Kitchen | `60e54fcf-1d2c-43e7-ac17-fb94c80df2bf` |
| 3219 | The Empanada CookHouse | `97b4d207-3cfc-485d-acda-f4242a02a491` |
| 3220 | The Empanada Joint | `df6e8157-e941-46cb-b9b6-7d78777dc723` |
| 3221 | The Empanadas King | `69797a8c-2ff3-4736-9bd1-69e9620d0967` |
| 3222 | The Factory Kitchen | `a869fb00-3c02-43eb-b788-6b4d800f2ed2` |
| 3223 | The Fancy Biscuit | `6739c36a-3a48-40df-9c4f-5faa873de5d5` |
| 3224 | The Feast India Company | `341999e3-c6dc-432f-a0ac-b6ace9c193e3` |
| 3225 | The Flavor Lounge | `e8ea95d6-6161-45cd-bfeb-483e3e25251a` |
| 3226 | The Flying Biscuit Cafe | `c0d5bcf6-ffb4-4fdc-8fb4-07ae1ee6f07a` |
| 3227 | The Food Trap Dallas | `aa8eab88-ef2b-4416-8a1e-da8db91285ce` |
| 3228 | The Fresh Market | `30479104-076a-48f8-bbe4-78c7d1189e0d` |
| 3229 | The Fresh Market Norfolk | `2e4f6096-aa7f-4688-8c03-d5a8c50bfa28` |
| 3230 | The Fresh Market Port St. Lucie | `f2451a01-cd35-4749-8f73-67aa702f5b73` |
| 3231 | The Fresh Market Richmond | `8e4b3f1d-8c8d-4ba0-b1dc-4e0adc7632cd` |
| 3232 | The Fresh Market Winston-Salem | `290d36a7-9bbb-4067-90f5-7b3520ae1413` |
| 3233 | The Friendly Toast | `8396800e-04e4-4ac5-8e78-9ad36c4c07b2` |
| 3234 | The Giambancos Italian Grill | `aecef016-3e08-4902-931f-ac01b8feaff6` |
| 3235 | The Good Salad | `94ccf66f-2627-478e-871d-127d4e8df1f6` |
| 3236 | The Grapevine | `93311431-ca43-4112-bf8b-9e05e008fbf8` |
| 3237 | The Great Greek Mediterranean Grill | `264f83e3-fafd-49e1-b76d-40bfda631020` |
| 3238 | The Great Greek Mediterranean Grill Port St. Lucie | `b93e8b77-fe43-46a9-b1aa-ee5a71484a21` |
| 3239 | The Great Greek Mediterranean Grill Richmond | `4627b286-1537-40a4-af0e-51988dcda37c` |
| 3240 | The Great Greek Mediterranean Grill San Ramon | `d3793ee9-cf94-45a4-9e14-5d709f816a4f` |
| 3241 | The Great Greek Mediterranean Grill Scottsdale | `3945e0ed-2536-4d73-a417-3bba7fe76f05` |
| 3242 | The Great Greek Mediterranean Grill The Colony | `f9e71351-4925-42f2-8301-908e5a62116e` |
| 3243 | The Great Outdoors Sub Shop | `84682741-45fc-47b0-a87d-6d7a64abbf7e` |
| 3244 | The Greeks Grill | `8f26b1f7-7916-4d76-881b-34ae65be7b12` |
| 3245 | The Green Olive | `e7bbd842-2b59-4975-8a08-88ac075db8f7` |
| 3246 | The Grey Goose | `fab43f68-83c2-43eb-90ec-dc6a5d50ccaa` |
| 3247 | The Gurkha Kitchen | `63c3108b-7b9e-4443-9d7c-4e94d3cb2b2d` |
| 3248 | The Gyro Project  | `78d1ff51-abb1-49c8-b1a0-19a9d5168a93` |
| 3249 | The Gyro Shop | `cf04b9f5-b531-4d4c-986f-9e2038a2e1cc` |
| 3250 | The Habit Burger Grill | `1c9e73ce-5ef7-4fd4-9b33-9dad20022c70` |
| 3251 | The Halal Guys | `c7e8ce41-ef7a-4836-9e4e-024a3ec1bbb0` |
| 3252 | The Halal Guys Richardson | `23794c8b-1318-4080-98f8-56ea26c476e9` |
| 3253 | The Halal Guys Tempe | `97cb0830-7b19-4fb8-aa77-a50f649fe5e3` |
| 3254 | The Herb Box | `3a955bc9-ac22-404a-a545-2f3ea089206b` |
| 3255 | The Herb Box Scottsdale | `f69d6a26-0d7b-4d1f-a2e8-5fdddb8bd3a4` |
| 3256 | The Honey Drizzle At The Riviere | `1b248c1f-5939-45f9-bc9d-369bf7240a36` |
| 3257 | The Hudson | `efd2d50d-8cc1-4489-b5a5-6c5304a392e8` |
| 3258 | The Ice Cream Team | `412d1e45-6e64-40ea-b97d-3eed902c3ba5` |
| 3259 | The Impossible Shop | `3b3a4501-9b9c-4b48-815a-e3a1db9f224c` |
| 3260 | The Island Spot | `9de76af7-75eb-450a-b212-c6e187f48b74` |
| 3261 | The James | `d37204ab-049a-4912-97fa-e7e89c99a3a5` |
| 3262 | The Jar Bar DFW | `aa399171-a134-4f81-8606-2efcf3bca372` |
| 3263 | The Kati Roll Company | `47be1439-f680-4122-9a6e-2ca4f37c7ca3` |
| 3264 | The Kebab Guys | `bd95cec3-09ce-4f94-b15d-dd26ca6200d2` |
| 3265 | The Kebab Shop | `e71e66f6-fd16-4043-baa8-3c084cd2fe7f` |
| 3266 | The Kickin' Chicken | `66fd22ce-0ea3-4cf3-bf12-6089281c081e` |
| 3267 | The Lusty Lobster | `33c658ec-2d99-4efa-bd4f-404e622c2712` |
| 3268 | The Mantu | `7e87065c-9d33-4f07-adbf-f595442c147f` |
| 3269 | The Market at Edgewood Catering | `60a83eed-84b7-4745-ab36-0fd9637069be` |
| 3270 | The Matador | `00b35673-e873-4a51-87ba-5e9730537a10` |
| 3271 | The Matador Boise | `b3595fb1-6993-4f18-a639-9065e2221db6` |
| 3272 | The Mayor's House by Selda | `a11e15a7-ffb4-40fb-b9aa-a9abaa860ba7` |
| 3273 | The Mediterranean Catering Company | `9748a4e1-4bb3-415d-a7db-36e7c1d2041e` |
| 3274 | The Melt | `5ef3a593-3a95-4dc1-892e-a598bd6ae7ed` |
| 3275 | The Mexicano | `1b610777-fea8-41ff-848f-d21af7c2e744` |
| 3276 | The Mini Donut Company - Liberty Public Market | `59dbba11-f8c0-4ce3-8813-daac4bea728b` |
| 3277 | The Mini Donut Company - Westfield UTC | `35bd6c9e-ae64-4b67-8ef8-0228c391a143` |
| 3278 | The Mini Donut Company - Windmill Food Hall | `96bd01f0-3ec1-4227-b7b0-b4f0d96f853d` |
| 3279 | The Motown Diet | `a08e8b1b-941a-4c85-a7a5-12d9ce68192b` |
| 3280 | The Mynt | `461dd8a5-9cf8-4cf7-94f6-04f5bc88fd5f` |
| 3281 | The Nest Craft | `00a546d0-bd1b-4cbc-9c09-447cf84bfdf3` |
| 3282 | The Nodding Donkey | `9e63c6a9-05b3-4b65-af6c-4213aa3e6713` |
| 3283 | The Nosh Cafe and Bagelry | `aba17f83-d5c0-4723-ab93-eff035ba7bf7` |
| 3284 | The Oceanaire Seafood Room | `b15e8251-4f1e-4b75-9873-ceb1497dca43` |
| 3285 | The Old Causeway Steak & Oyster House | `d792d9c1-f673-4899-ade8-76d85bd8e081` |
| 3286 | The Old Spaghetti Factory | `99848230-7367-4eca-be39-5f8611ce0cfa` |
| 3287 | The Original Geno's | `6cd3178c-8b73-4529-bdd1-e81acc29d5ea` |
| 3288 | The Original Marketplace | `5824d60f-88ea-4163-ab04-6ad5dd532638` |
| 3289 | The Original Pancake House | `b5e0f91b-5524-4d3c-8031-97a5e23aaa3c` |
| 3290 | The Original Ronnie's BBQ | `ddf07d0f-696e-4a0a-9de8-c329f48508bc` |
| 3291 | The Pass | `cf8c162e-45d7-4093-b8c2-613d6662f343` |
| 3292 | The Pasta Factory | `46edc949-3ca7-46b9-8278-c3d81bec416e` |
| 3293 | The Patio Thai | `01894243-a47a-404f-af87-42e5d91f8125` |
| 3294 | The Penalty Box | `1b4c238c-40f4-464e-92a7-aacefa856188` |
| 3295 | The Philly Special | `cfa38800-56a1-401e-ad58-6960294f294e` |
| 3296 | The Pig Shop | `f4fffaed-fa45-4ce0-ae02-14768de748cd` |
| 3297 | The Pit and The Peel | `860b82c4-2a4b-47ea-b284-dde4f262c94a` |
| 3298 | The Pita Stroller | `687970b9-32e5-437d-98ac-61c342872213` |
| 3299 | The Pizza Guy | `773bc7c0-ff22-40f4-b31b-7e4e03cc8d2e` |
| 3300 | The Porch | `c75405f7-0e6b-4ea8-a8b5-7a4473025e95` |
| 3301 | The Port of Peri Peri | `47066d22-d331-429a-9de8-8250ea4b6ab0` |
| 3302 | The Port of Peri Peri Fremont | `cb0fecba-fb97-499a-8609-80ca436ea5d7` |
| 3303 | The Post Chicken & Beer | `00bb6d52-83a2-441c-b4c6-e8c69d54edb9` |
| 3304 | The Pot Baked Potato Bar | `9009b9cd-1a46-46ad-be5c-e575e9b2ed90` |
| 3305 | The Press | `6a445609-94db-4e71-957d-a113ce3c0926` |
| 3306 | The Quarterdeck Seafood bar & grill | `1a5eee3f-9de1-454c-a729-8f9ad5ceb692` |
| 3307 | The Rara Restaurant | `93b953e7-bbf2-4de8-9260-49ca167001cb` |
| 3308 | The Red Radish | `d9d8cddb-af10-4088-b85e-20943c2ad986` |
| 3309 | The Reserve | `beb0968c-cada-42fc-8c31-5cc924fe3527` |
| 3310 | The Royal American | `0a8eac40-678f-4e64-ad8e-8833a851d700` |
| 3311 | The Saint | `c5979bae-1e43-4084-ac15-6042f546efc9` |
| 3312 | The Salty Donut | `57a90992-4aec-4982-b4bb-05ff4399b3cf` |
| 3313 | The Sandwich Catering Company | `7f66922d-4996-45c3-859f-f73a4740683d` |
| 3314 | The Sandwich Spot | `fbb858ea-c443-4465-aa46-a9d4e7e402ba` |
| 3315 | The Savory Grain | `dd452cac-36ef-40b8-a940-7cd51a1bf462` |
| 3316 | The Sicilian Butcher | `d89860f8-06b9-400e-95fd-53d25b855bde` |
| 3317 | The Sicilian Butcher Peoria | `cdb2cc48-aa3e-4225-b38f-42f2d2e3e9c7` |
| 3318 | The Simple Greek | `7654e05d-3f15-460c-bad8-1ecc008355e6` |
| 3319 | The Simple Greek Chesapeake | `cb85a334-9e23-4021-a10a-193d9bf31aa3` |
| 3320 | The Spaghetti Shack | `bf7771ea-5ef9-4670-9a17-15b5297a881b` |
| 3321 | The Spot Neighborhood Grill | `109a8730-f6f5-4712-b38a-3af6365bde74` |
| 3322 | The Stand | `f474307d-d5a2-4dbc-9404-f6e8dfa6e680` |
| 3323 | The Stones Common House & Kitchen | `138e6fd8-8552-4715-a2e3-1ae08ed8c6c9` |
| 3324 | The String Bean | `58a7239f-2e2a-4749-be0e-4d70540d2c0a` |
| 3325 | The Taco Catering Company | `2cd7013f-550c-4da5-bc6e-3dd836b51f20` |
| 3326 | The Taco Kitchen | `466c30f7-d821-44c6-8a76-bca8af32dd97` |
| 3327 | The Taco Spot | `1ec4d69e-a060-4cce-a6a1-d435e800db6d` |
| 3328 | The Thumb | `f87bf60d-e478-450a-ba30-41f3db294c0c` |
| 3329 | The Tiny Kitchen | `d4cf68f5-430f-4126-ba20-1fa385ded414` |
| 3330 | The Toasted Yolk Cafe | `8247c44b-209c-4841-b783-b03de748b9b3` |
| 3331 | The Vessel Catering Company | `93470bb1-c486-446b-a572-16fdf6001f98` |
| 3332 | The View Cafe | `6b5c0f30-4e08-423a-b84d-2241e34aa6cf` |
| 3333 | The Waffle Roost | `022bf7cf-2633-48f0-ac25-eb340e059f2d` |
| 3334 | The Wing Experience by Smokey Bones | `eae72f24-537b-4d78-8e2f-fcaa8b59ffac` |
| 3335 | The Works Bakery Cafe | `3ca5decd-5e51-409c-a4f7-69e7b09439e0` |
| 3336 | The X Pot | `270a367a-abeb-4032-9583-506085bc1d49` |
| 3337 | The Yellow Chilli | `b70f31d3-39f3-405f-8f45-19b03e73ec91` |
| 3338 | Think Greek | `f96a0519-39bf-403e-8688-2a61d72bba2f` |
| 3339 | Thinking Tacos | `b2293198-3fe8-4f62-a248-4ca4728f70ec` |
| 3340 | Thirsty Lion | `b117e71d-3106-42c4-8aa5-575ab176de19` |
| 3341 | Thirsty Lion Glendale | `a8c3d2fa-5d39-4ccb-87ab-7bfae0c8514e` |
| 3342 | Thornhill Catering | `e5e42bcc-0dff-455f-9874-40b79287a4f5` |
| 3343 | Three Dollar Cafe - Alpharetta | `9347503e-a862-4274-a11a-c7b29a591f95` |
| 3344 | Three Dollar Cafe - Buford | `632a3cd5-0097-4c45-b4e4-024ca29e3cfc` |
| 3345 | Three Dollar Cafe - Chamblee | `b37cdc97-5b20-426c-b475-84d56083c7bf` |
| 3346 | Three Dollar Cafe - Chastain | `191a39ca-1275-4948-bfc3-9e8e79fc19cf` |
| 3347 | Three Dollar Cafe - Kennesaw | `fdfdaa28-72f0-4a53-afc8-ee1e983fd742` |
| 3348 | Three Dollar Cafe - Marietta | `e12a4908-c51c-4496-bdf4-a1d6f488b2e0` |
| 3349 | Three Dollar Cafe - Peachtree Corners | `c343028b-1ca1-4701-a4a2-6f5b1fd4d325` |
| 3350 | Three Dollar Cafe - Sandy Springs | `4b302fee-20ae-4080-82db-7963b1d047a4` |
| 3351 | Three Egg Muffins | `e194bac6-aeb2-4e31-99c9-c5614bedea3d` |
| 3352 | Thunderbird Pies | `a07649c5-2bf2-492c-a582-65d13f14e0ce` |
| 3353 | Tibet Kitchen | `db69995b-f56a-49be-8141-99f9aa07e692` |
| 3354 | Tier 7 Eatery | `2605a0f3-8c40-48b1-99b1-9066a4b8f369` |
| 3355 | Tiff's Treats | `5c5ec450-8f12-4518-89c7-394d34c17050` |
| 3356 | Tiff's Treats Garland | `ec3cb102-05c7-4ae6-8e52-5865c6e38bb7` |
| 3357 | Tiff's Treats Phoenix | `0f0e0bea-7411-4c75-b5f8-be5b3b229d03` |
| 3358 | Tiff's Treats Winston-Salem | `422c8d6c-499c-4b20-bd65-86243250beb8` |
| 3359 | Tiger Dumplings | `ae5e7e7a-2ae6-4406-a9af-30ee260cc41d` |
| 3360 | Tijuana Flats | `35a61ecf-83ce-4282-9cc0-62c110943d4b` |
| 3361 | Tiki Tiki Restaurant | `6e7fa44c-453c-4290-88e3-a38ff13e9a24` |
| 3362 | Tikka Bowls and Tacos - St Johns | `cd28f565-1a5a-4f29-b24f-0b6b258e67fe` |
| 3363 | Tikka Bowls and Tacos - Tapestry Park | `344235a6-4996-4181-b24b-1c7d2f7175db` |
| 3364 | Tikka Shack | `da74b4f2-3d4a-4a6a-aec6-90f83c583899` |
| 3365 | Tikka Shack Dallas | `69b58c4e-2c60-4ca4-83bd-5ff3a971638c` |
| 3366 | Tinta Mexicana | `a372fe74-3e87-4017-b80e-30fbff5305da` |
| 3367 | Toast! | `c6e45e9f-6566-4e60-96ab-f18831675959` |
| 3368 | Toasted Coffee + Kitchen | `7a74e6ff-4144-442b-895b-3f249439db71` |
| 3369 | Toastique | `9706e6e4-5d56-4880-8007-6bd0603d4b54` |
| 3370 | Toasty & Sweetz | `9d8b68c5-8ef9-497e-bb58-579c4232c255` |
| 3371 | Tocaya Modern Mexican | `385f6b2f-3f5e-4b8b-9124-3f2ad82ec287` |
| 3372 | Todo Pasapalos | `b4d28c26-d033-4eae-ae1d-9b23501300a4` |
| 3373 | TOGO'S Sandwiches | `e07b52e6-500c-4613-8d58-b53365583d8a` |
| 3374 | TOGO'S Sandwiches Fremont | `b7b2cb05-ede7-41ab-954a-1b082139b669` |
| 3375 | TOGO'S Sandwiches Gilbert | `6a87c766-47a9-40f1-9d21-a5d4e0604049` |
| 3376 | Tokyo House | `bb32b7f5-c86e-458f-b2db-2b625bd016ac` |
| 3377 | Tokyo Joe's | `f6cc6c0c-24cf-4b76-b397-9105fbc6bcb8` |
| 3378 | Tokyo Joe's Avondale | `723edd93-60b4-41ef-89c5-f945b2465248` |
| 3379 | Tokyo Joe's Mesa | `94393bb0-51a8-4be0-ba27-aefe9fa8c0c3` |
| 3380 | Tokyo Sushi & More | `ff4ceda8-0dc7-40cb-b24f-365f42e041c7` |
| 3381 | Tokyo Sushi Richmond | `e47f52a1-e873-4605-8d64-85954de23ca5` |
| 3382 | Tom/Cen Cafe | `c7e92ffb-3e9b-4ef0-b79f-7d29cf294de8` |
| 3383 | Tomatina | `1fecb557-a8d0-4d30-ace8-b79bc27afb25` |
| 3384 | Tomato Street | `41670ae1-b0af-44fe-a372-6db996190b15` |
| 3385 | Tommy Thai | `c84167c5-bc52-4729-a0cf-f56bd8a60abd` |
| 3386 | Tonari | `ffc0bcb4-7558-4d42-a28d-c28589adf470` |
| 3387 | TONG | `799cd8f1-1b84-4588-8062-25d2f1b7bba6` |
| 3388 | Tony's Italian Restaurant | `a09e6f82-4702-4620-a93e-ccd49f768b07` |
| 3389 | TooJay's | `cbba07bc-e005-421f-8021-413b554477ba` |
| 3390 | Torchy's Tacos | `1d7cb653-aef9-4038-9e01-22ab09e7b02a` |
| 3391 | Torchy's Tacos Phoenix | `722fe7f2-8c4f-43c6-b24a-12c5b13129fb` |
| 3392 | Torchy's Tacos Phoenix | `c6e458ce-bd77-4277-9d1a-434f781cfd6a` |
| 3393 | Torchy's Tacos Richardson | `ab3ff576-5a88-4f1c-be13-e70c04022aea` |
| 3394 | Torchy's Tacos Richmond | `01fa2901-569d-4c3a-8a41-76c68a7eef05` |
| 3395 | Tortas Paquime | `c09d9d83-48ff-4851-8182-01e79ad0a9c1` |
| 3396 | Toss'd | `f54a25f7-dc8d-4157-8e84-47f76da90904` |
| 3397 | Touch By Geechee Catering | `d38018c9-1b73-43ff-bd5a-36444777221a` |
| 3398 | Town Center Pizzeria | `a5701e32-68e3-41b6-96a1-c95be347bf62` |
| 3399 | Trades Delicatessen | `a761ddab-d988-4988-8f52-742b37957b59` |
| 3400 | Trailer Birds Hot Chicken | `34fe3bed-f3df-4338-a4b7-ccaff719af1c` |
| 3401 | Trailer Birds Hot Chicken Phoenix | `721ea57c-cd1c-43e8-93c1-cd32fc605075` |
| 3402 | Trailer Birds Hot Chicken Scottsdale | `acc358b1-c02b-4e03-8478-f3c53b68f1f3` |
| 3403 | Trapeze Restaurant | `bf3e12be-2156-4836-b2f4-76e50e56ebd7` |
| 3404 | Trattoria D'Amico | `6875afe9-6a28-4acf-b360-381f3c96e2a4` |
| 3405 | Trejo's Coffee & Donuts | `c3736e94-0101-4657-90c0-ece275a6a215` |
| 3406 | Trejo's Tacos | `b9a97fd7-6648-4fc7-8599-7f006a185a5f` |
| 3407 | Tropical Smoothie Cafe | `61b2c513-10db-4148-8e9c-09b3ed093dbb` |
| 3408 | Tropical Smoothie Cafe Boise | `68257fe0-dbf8-4540-b899-b432840b10b6` |
| 3409 | Tropical Smoothie Cafe Chesapeake | `f7df3abc-9eab-4876-9a7a-335b3a737ae1` |
| 3410 | Tropical Smoothie Cafe Glendale | `a1db84a0-81a4-4cbb-bc9c-00dba244f665` |
| 3411 | Tropical Smoothie Cafe Huntsville | `75748740-666b-4e40-baa2-9678567533d2` |
| 3412 | Tropical Smoothie Cafe Norfolk | `c8eafaef-5cbe-40a1-8067-4d66740f1a30` |
| 3413 | Tropical Smoothie Cafe Port St. Lucie | `9687bdaf-5cdc-4882-80c6-70ca176bc32e` |
| 3414 | Tropical Smoothie Cafe Richmond | `4faf77ac-8fe9-4aac-a7e8-ff3bdd2cfc40` |
| 3415 | Tropical Smoothie Cafe Scottsdale | `c0a78886-707f-403b-a139-a2d561e4ef2d` |
| 3416 | Tropical Smoothie Cafe South Portland | `d99d5a4d-c292-40a7-b117-e0194af7e622` |
| 3417 | Tropical Smoothie Cafe Winston-Salem | `d13d5433-7aee-47ab-b68a-3550e4223ef0` |
| 3418 | TROPICALI Brazilian Kitchen | `eb955cda-bfd4-402e-82c7-666c5a78964b` |
| 3419 | True Food Kitchen | `f019000a-2077-4d1a-b22f-ad358a83b201` |
| 3420 | True Food Kitchen Dallas | `43f87c4a-09b4-4e03-b20a-23941627b5e1` |
| 3421 | True Food Kitchen Phoenix | `493e50ca-1889-4b19-975b-f09588f01d89` |
| 3422 | True Food Market | `e0544566-17d7-4972-bb83-e6850f7bb821` |
| 3423 | True Texas BBQ | `7d1752dc-b3c0-42c9-adc4-3be865196dbb` |
| 3424 | Truewin | `0b17d566-582f-49d9-a13f-33e43c0cd085` |
| 3425 | Truffle Poke Bar | `ddb4ad29-173e-4815-b970-6bb0ed907cb1` |
| 3426 | Truly California | `a5bfa706-1a7e-4c6c-963b-7e3919e8e8b5` |
| 3427 | Truva Mediterranean Grill | `1b7972f9-4f18-4795-9a2e-ea26b858e5ea` |
| 3428 | Tryst Cafe | `42a9b41b-cb1a-4449-94fb-2ebc199c5b3a` |
| 3429 | Tsaocaa | `b373d22d-54e8-4f6a-a143-c900d0892724` |
| 3430 | Tupelo Honey Southern Kitchen & Bar | `44f882d1-2502-4828-8a87-2efd752629db` |
| 3431 | Tupelo Honey Southern Kitchen & Bar Virginia Beach | `376b0fc1-3dd8-4ae6-9937-51939702a7af` |
| 3432 | Turkish Chef on Wheels | `a4fb1992-76df-4262-98da-8d04d367e124` |
| 3433 | Twenty Two Juice Bar | `441f7e7f-56bd-48be-a5fb-594967a9dd13` |
| 3434 | Twisted Mac | `2e7b6566-96ca-4249-82e3-d36ab8d2ba4d` |
| 3435 | Twisted Tenders | `eeb98c5c-45c8-4dbd-9d31-1fb364130ecc` |
| 3436 | Twisted Tenders Boise | `e3d50f3b-25d3-4fde-8386-cfe27b1c151e` |
| 3437 | Twisted Trompo | `80c856e7-7561-4c95-b9b3-8aab452bc506` |
| 3438 | Two Guys Pizza | `37f357dd-43ef-4a43-9520-7d2c78c0e87f` |
| 3439 | Two Hands Korean Corn Dog | `3ec5393a-94ec-4796-8800-99d17273e2c7` |
| 3440 | TZIKI | `d577bc71-3ae6-46d9-9f27-936a6718ba0f` |
| 3441 | Tío nacho  | `ceedb684-609d-41ac-a0d7-3ba088c7485b` |
| 3442 | U.S. Egg Restaurant | `7b9243a8-bc50-432e-bbad-2f8a2e122160` |
| 3443 | U.S. Egg Restaurant Phoenix | `abcab7b9-6051-4f2b-a84c-14f5be3192f1` |
| 3444 | Uhane Hawaiin BBQ | `b6f38c9f-38f3-4b23-85fd-3f2673ef77d4` |
| 3445 | UlavacharU Indian Cuisine | `7acb2dff-a3fa-4dba-9cf9-b2f4fb86cccd` |
| 3446 | Umami Express | `96ad51fa-f003-451f-91cf-027750258226` |
| 3447 | Ume Tea | `9bfad364-0914-4966-8175-89ac88bd5fbc` |
| 3448 | Una Mas Mexican Grill | `b4373d9e-bb50-424e-8f07-6dccda25bfd1` |
| 3449 | UnaVida | `8497538d-da18-4cc3-90fd-d18b82edf8ff` |
| 3450 | unbelievaBowl Asian Grill | `ccfeee01-cec4-4a2d-9a2c-9c65d9d70b3a` |
| 3451 | Uncle Biff's Killer Cookies | `f5442768-d75a-4345-b8b8-4e89c007adc1` |
| 3452 | Uncle Jim's Dress Blue BBQ | `104636bb-c9bf-402a-b866-a69c11d3edeb` |
| 3453 | Uncle Julio's | `9f585618-2807-4941-8ee7-7b55ee6e1787` |
| 3454 | Uncle Maddio's Pizza | `7972e111-bd3c-4150-b9c5-3a2883b9bca4` |
| 3455 | Uncle Paulie's Deli - W 3rd St. | `d100f615-ceb3-47c8-9fc5-34f85f1b1813` |
| 3456 | Uncle Willie's BBQ | `d889cd53-5b41-468c-b52f-a4558553bc9b` |
| 3457 | United Catering | `cb463628-4ff8-4f31-8e88-3dd0d47f2357` |
| 3458 | Uno Pizzeria & Grill | `c789e09f-110c-415c-95d8-2286c12969ff` |
| 3459 | Uno Pizzeria & Grill Norfolk | `6d06961f-30b6-4bbd-9c43-e6e4863aa1f9` |
| 3460 | Unregular Pizza | `c9e5d0d9-e19c-451b-bbbc-dabc4122a085` |
| 3461 | Urban Comfort Foods | `f3c1a1c6-4234-4317-9211-4318fb48bcb4` |
| 3462 | Urban Cookhouse | `f0c999bc-c472-464c-b34a-05b73101c052` |
| 3463 | Urban Donut | `0303f89c-521c-40db-9cf6-7ba933096cd9` |
| 3464 | Urban Eatz | `239bd083-b777-4a03-9b46-ea69270af8a0` |
| 3465 | Urban Farmhouse Market & Cafe | `deb29ae4-07e0-47e9-b763-05a6665607aa` |
| 3466 | Urban Kitchen | `ae1307cc-9eed-4d5b-ab4c-c591e0e365af` |
| 3467 | Urban Momo | `a1a01a0b-86ab-4209-81c2-89410ec485e4` |
| 3468 | Urban Plates | `157b3a38-62a2-4349-af99-aee8c3a68e70` |
| 3469 | Urban Taco | `3993a201-f3c1-4ec4-b08f-061a39bad5de` |
| 3470 | Valley Wings | `357504f8-0165-40bd-b398-9f2017aefbe2` |
| 3471 | Valley Wings Phoenix | `7467c5cd-3df9-4fea-a931-12c88312d640` |
| 3472 | Vamos Vamos | `ae5dabd2-d76a-4395-a71a-06fb42ae8846` |
| 3473 | Vegan and Vine | `4f503134-217d-421a-b6ad-fd1288ae9f8d` |
| 3474 | Vegan Eats and Drinks | `c30bff6d-4548-4afb-8c90-9cd0ed5b4883` |
| 3475 | Vegano Cosmico | `021cf0ff-f303-45ce-8145-d1b88ca4bee3` |
| 3476 | Veggie Grill By Next Level | `11b613ec-e89a-4316-bf74-2489be12374b` |
| 3477 | Venezia's Pizzeria | `d26d91de-80f6-469f-a632-7c59f25c9e40` |
| 3478 | Venezia's Pizzeria Phoenix | `ff529fdc-af52-4cc6-bbbe-66f1c6b9ad0f` |
| 3479 | Venezuelan Flavors | `33c891e1-08a1-44f6-899f-82a8ec58f0f1` |
| 3480 | Verde | `84c4c521-eea5-4a95-8067-9d6e96fb66a4` |
| 3481 | Vero Chicago Pizza | `ffad48cb-ad1d-42f0-bf24-1a72292776b0` |
| 3482 | Via Real | `f738a693-a788-4f23-b187-3539064afedb` |
| 3483 | Vicious Biscuit | `1650af50-1c07-424d-8bb0-7342508ea547` |
| 3484 | Victors Restaurant & Deli | `d64ec1f8-8397-4e4f-9a09-41baa7bc782e` |
| 3485 | Victory Social | `c4056b39-31d6-406a-a620-7b907c887a43` |
| 3486 | Vida Eats | `e7e130c0-0743-4f8b-a21f-89796a8aebbe` |
| 3487 | Vieni Ristobar  | `3fa9e71c-0025-4aaf-b5c5-0a63c551e33d` |
| 3488 | Viking Burger | `be6e4ffd-1022-441c-9f5b-9e1ebdf42f07` |
| 3489 | Villa Italian Kitchen | `7b67927d-9748-4e69-b48c-4e6129ae02a0` |
| 3490 | Villa Italian Kitchen Chandler | `e7b62fc1-f14c-4539-84af-9747e2b2110b` |
| 3491 | Village Baking Co. | `4d83df73-bd2e-4249-874f-da4372e714b6` |
| 3492 | Village Bowls | `6893acac-0b73-4d05-85a8-f56a26f1a425` |
| 3493 | Village Bowls Surprise | `baf1ed56-3adb-4ef7-923d-34c8144ce08a` |
| 3494 | Village Burger Bar | `42c03ca2-534d-4575-baef-9b1ee5c35d30` |
| 3495 | Village Inn | `4e098dd3-2730-4efd-bad4-3b50e76d7c39` |
| 3496 | Village Inn Chesapeake | `f1967df5-0850-436f-83f1-f65411efa5f1` |
| 3497 | Village Inn Peoria | `ecd9875c-f0d3-40bc-afba-c5f1a1e46dd9` |
| 3498 | Village Inn Phoenix | `d3164d6f-9e6f-4d11-a04c-7e6bb884b222` |
| 3499 | Village Juice and Kitchen | `33e899c0-2864-40be-9e12-83590902deb5` |
| 3500 | Vinal General Store | `3fc5db6f-aa32-4f1f-a3e9-b86305d2abaa` |
| 3501 | Vindu Indian Cuisine | `203f945e-15bc-4014-85a3-be87b2ca3c5b` |
| 3502 | Vinny's Italian Grill & Pizzeria | `59682250-dc71-4cd1-a5a1-2e47175137e3` |
| 3503 | Vino's Pizzeria | `5d4e0226-b39f-4bff-a387-e81bf0e6a08c` |
| 3504 | Vinum Bar | `68d05727-709a-4002-bf91-69164b9f36ab` |
| 3505 | Vital Root | `6b7833fc-e07a-4759-a5b3-0d6ca0e095c8` |
| 3506 | Vitality Bowls | `c59dd183-6bfd-4950-ae2f-4e61763527cf` |
| 3507 | Vitality Bowls Fremont | `c0763b8e-e7d6-42a5-816a-4b65ac89a7c0` |
| 3508 | Vitality Bowls Gilbert | `a08f22a7-4491-4eea-84b7-42a7b9af8e37` |
| 3509 | Vito's Pizza & Italian Ristorante | `5cbb2fb8-9666-4bbe-8a62-bdb2d00295c8` |
| 3510 | Vito's Pizza & Italian Ristorante Scottsdale | `d38f524a-a847-403a-9377-616b627d8a56` |
| 3511 | Viva Chicken | `6b737c74-f395-47a5-b193-7eb714dc31a8` |
| 3512 | Viva Chicken Winston-Salem | `3f4076ee-426d-479d-8825-43932821f66d` |
| 3513 | Voodoo Doughnut | `274679cb-82b4-484f-b00e-4d975fcfbfc5` |
| 3514 | Voodoo Doughnut Tempe | `47b2b587-46eb-467a-9955-4b7059a028ed` |
| 3515 | Vybez Kitchen | `3b701a3a-f46e-4bb0-9241-89ae21c79474` |
| 3516 | WaBa Grill | `42c7bc24-28dc-481d-8a54-4eb8d5ab6e73` |
| 3517 | WaBa Grill Avondale | `ae3dd89f-9672-466c-9807-e81eb943b7d2` |
| 3518 | WaBa Grill Tempe | `b897c240-a8e1-414e-9926-bb24fc841595` |
| 3519 | Wacamole Latin Food & Pizzas | `78e6630a-7842-4ce4-bb9e-0a1ff1fb679c` |
| 3520 | Waffle Love | `138c2bc5-0358-4043-afe6-30e193f0e4a6` |
| 3521 | Waffle O'licious | `9311dc38-b5fd-406d-a651-c45657fce7b2` |
| 3522 | Wagamama | `73540d43-82db-4658-be68-c1c9e78d5763` |
| 3523 | Wagon Wheel BBQ | `baeb62a4-9a6f-4d7e-bfb8-6b5ab20ce89c` |
| 3524 | Wahlburgers | `b8aaf7ee-378f-4683-bff8-23b31787ce27` |
| 3525 | Wahoo's Fish Taco | `3482815b-3d4d-4d9a-b4ff-b7ce0a018607` |
| 3526 | Waldo Cafe | `a16bf974-182a-47b3-9028-86dca5d845b7` |
| 3527 | Waldo's BBQ Catering | `7583c477-4c6b-4769-a27e-9474effbbeeb` |
| 3528 | Walia Ethiopian Cuisine | `17f2c519-2a19-40e8-ad2d-83fcd8064644` |
| 3529 | Walk On's Sports Bistreaux | `6ef1d29f-5984-4cf4-ac3b-24c3d13a763f` |
| 3530 | Walk On's Sports Bistreaux The Colony | `befc3c10-cf6c-42ec-98a9-9df08cca2a29` |
| 3531 | Walter's Kitchen Restaurant & Bar | `456fcbb6-94be-4f34-9319-ba2fd3a25083` |
| 3532 | WannaBee Chef Catering | `8250746a-3555-4458-a479-2e80c3463206` |
| 3533 | Wattles' Roost | `56f924a9-d4aa-4bde-bf67-57d652c86b0b` |
| 3534 | Wava Halal Grill | `755522b6-dd4d-4248-be4d-df0b8fe5d6e2` |
| 3535 | Wavershak's Deli and Grill | `3cfb7dbf-af5b-4d0c-ad25-fe2116ac8725` |
| 3536 | Wawa | `0f190a60-615a-4606-8e76-f5bb9a9fd736` |
| 3537 | Wawa Chesapeake | `8e8dc0b7-ffc3-4ba1-9ea0-18c4a8742249` |
| 3538 | Wawa Port St. Lucie | `1b001bbd-e1ad-4757-88bd-aae03fbb0c47` |
| 3539 | Wawa Portsmouth | `c10923f7-237a-4ba7-87ff-9a433f10b364` |
| 3540 | Wayback Burgers | `6d73875f-71b2-4354-a72e-608c556ba457` |
| 3541 | Wayback Burgers Allen | `3d2c06c1-c8c6-442b-88b7-3917fc85ce93` |
| 3542 | Wayback Burgers Gilbert | `aa2a5842-112b-4a34-b6db-e285ba86b0b2` |
| 3543 | We Wok Thai Food | `71941ab5-20f4-4058-a13b-eb217fc797df` |
| 3544 | Wegmans | `d394588c-ae6c-411b-8955-e8efb08a5616` |
| 3545 | Wegmans Virginia Beach | `149a0158-2d8d-497a-8aba-b2d31fc52cb9` |
| 3546 | Welcome Diner | `09875a0b-7ecc-4a4a-9baa-ec8dd89e1718` |
| 3547 | Wessen International Kitchen | `8c0393c8-3284-4ab0-a5a0-64727b748c95` |
| 3548 | West Alley BBQ | `04081c3a-0813-4440-8609-f9cc5a3825ae` |
| 3549 | West Park Bistro | `a3d1237f-66eb-4ec8-836f-acca1941d7e3` |
| 3550 | West Park Farm & Sea | `acfc1626-7a6b-4cf8-971e-f672b2f39843` |
| 3551 | Westfresh Catering | `d981bae4-6d6a-47dd-89c0-3f7a8e64730d` |
| 3552 | Westtown Restaurant | `2828fb50-3c92-4f84-a82f-a4008da4600c` |
| 3553 | Westwood Fountain | `9080b495-9773-4aec-81e1-a5d48bfdb623` |
| 3554 | Westwoods BBQ & Spice Co | `e77ff7c5-c687-42e7-8a19-3b5b383c3169` |
| 3555 | Wetzel's Pretzels | `cdd4e336-351b-4a7f-85c9-0dc6a1c3775d` |
| 3556 | Wetzel's Pretzels Glendale | `ebe5f937-d239-4338-ada8-7b5b9f7a71d7` |
| 3557 | WF Catering | `768671f3-776f-4c36-bfd3-7745da847602` |
| 3558 | What's Crackin Cafe | `1aaa2c70-fb00-416b-9013-ab27d1f95a4d` |
| 3559 | Whatever Works Catering Co | `6ff903c0-4057-48f6-b822-548ff2f1303c` |
| 3560 | Which Wich | `8e3e60bf-cbad-437a-b7ba-456d2d766481` |
| 3561 | Which Wich Chandler | `092b5cca-e84a-4714-94e0-3a8402fc483f` |
| 3562 | Which Wich Norfolk | `01c0bded-52b0-47d1-9d18-1de2e9b74449` |
| 3563 | Which Wich Richardson | `bb998dbf-a6ab-4dd4-a6b5-fd8cca11855d` |
| 3564 | Which Wich Richmond | `8c1c93ca-be10-4b3a-9c59-ab06b392e57c` |
| 3565 | Whiskey Cake | `de99366b-b356-4b17-8c5e-eede90c21797` |
| 3566 | White Chocolate Grill | `06a4d8a9-84d9-4fa0-b264-19661da02976` |
| 3567 | White Duck Taco Shop | `99686653-289f-49c3-8f44-07f02076fe6e` |
| 3568 | Why Not Chicken | `a0182d5d-c384-4874-87db-f24f1e72be08` |
| 3569 | Wild Salsa | `9582395a-739e-466e-bc2e-de0793b1d968` |
| 3570 | Wildflower | `7293ed49-52aa-40ac-aa18-baf90954055e` |
| 3571 | Wildflower Peoria | `f4050335-169f-45b7-b186-8e7df586a234` |
| 3572 | Willy's Mexicana Grill  | `e4673d03-03da-4015-89b0-ecef569a8a0b` |
| 3573 | Windsor | `18011c45-1e0b-4aaf-b41f-8763cbdfd67e` |
| 3574 | Wing Boss | `6c527058-be65-4616-a40f-750f518f236d` |
| 3575 | Wing Boss Phoenix | `641826e8-d485-4217-8c3f-5773b81a650f` |
| 3576 | Wing Boss Scottsdale | `6adf507f-454f-41d1-b8ef-615d4f6de985` |
| 3577 | Wing Dome - Kirkland | `4ee31a2c-7eef-4597-9b8c-851021dbb76c` |
| 3578 | Wing Dome - Waterfront | `4372b88e-56d3-46de-b8ec-e63b34f6a83a` |
| 3579 | Wing It | `02853436-b28a-4528-a56a-90af8ad4e954` |
| 3580 | Wing Snob | `f8f143e0-a745-4b97-8e3d-78bce792c30f` |
| 3581 | Wing Zone | `25d8d83e-a820-4767-b330-3d9af2219559` |
| 3582 | Winger's | `39d93b93-a097-41a8-9be9-72925dff5cfb` |
| 3583 | Wingstop | `9ded5b16-6d82-44d3-b5e0-a19df433d245` |
| 3584 | Wingstop Boise | `e924ed41-519e-4c37-9885-637084f8d240` |
| 3585 | Wingstop Fort Pierce | `29d4a5bd-f4b6-46c9-b5d8-ed3a782fbfe9` |
| 3586 | Wingstop Richmond | `4b8f7cac-12d9-49a1-8be1-ba9010785634` |
| 3587 | Wingstop Union City | `0de8bd88-a3d1-4595-92d8-9688d6424afc` |
| 3588 | Wingstop Winston-Salem | `c08d9fb7-f36c-4550-b72a-f7a41b4390fa` |
| 3589 | Winners BBQ-Plano | `321e703f-0aeb-45da-b47f-e1fd19d02d8e` |
| 3590 | WNB Factory | `b4a9e10c-6474-4dbe-bbd0-22bd7d3185ec` |
| 3591 | Wok & Roll Teriyaki | `2903e5a1-6fc7-4d0d-b700-dec8d305dc58` |
| 3592 | Wok In Duane | `5a24d627-3975-4d90-b331-99d2ae3c5e49` |
| 3593 | Wok Star Chinese | `fdf8122c-bf56-480b-abe7-c5b1d7cefb04` |
| 3594 | Woo Woo Burgers | `7d7fbb7a-79ea-4fcb-8265-d34c5e4b3f09` |
| 3595 | Woodstock's Pizza | `bd52bd72-919b-4e06-b813-1ef59ba91eb2` |
| 3596 | Woops! French Macarons & Pastries | `74cd44d4-78bb-4aef-a2f0-a9da3d2b8f58` |
| 3597 | World Wrapps | `f8fc7541-6fc5-495a-84aa-09a5080a9ef7` |
| 3598 | Wow Bao | `5a7ba31a-1eb9-4e31-a244-0e1a80bcb49c` |
| 3599 | Wow Bao South Portland | `97c5b81a-b14c-4c4c-baa7-aa0bdcb95fb6` |
| 3600 | Wow Wow Hawaiian Lemonade | `67539785-3385-45f4-aa77-7cdd761b3323` |
| 3601 | WTF Burger | `dde3715e-b52c-4601-a193-abdb02391468` |
| 3602 | WtfExp | `0ce8f7d4-4843-4561-93dd-6a6cfb699406` |
| 3603 | WtfExp Phoenix | `11efccad-d919-4dde-80d9-dc19f340a45f` |
| 3604 | Wu's Asian Bistro | `cd0a20a8-c0be-4720-86f2-e10a0247e5a7` |
| 3605 | Xian Sushi and Noodle | `1aef3120-3d5d-4016-8bd0-0da19a5b7fbc` |
| 3606 | Xoomi Sushi | `d60d89d8-21b9-4221-a8fe-779b32bf33b1` |
| 3607 | Yafa Hummus | `b930b0e1-8671-4dd6-b2a1-b95fdff6c8c0` |
| 3608 | Yama Sushi | `4bb090a9-2bda-499a-b34a-085cb9db37a5` |
| 3609 | Yamas Mediterranean Street Food | `80269c40-4edc-4092-9212-0ea1a21d61fb` |
| 3610 | Yardbird | `70a7367d-736f-4338-850d-c889ac92712d` |
| 3611 | Yardie Ting | `c630eeb6-be22-4efe-89fd-2cd696d10fad` |
| 3612 | Yas Restaurant | `713e8767-4c59-4c98-ad5d-cfa3b8e46292` |
| 3613 | Yasso's Greek & Mediterranean Catering | `a724dd16-2c55-471a-a6ab-bed740d94a0f` |
| 3614 | Yeah Buddy Barbecue | `385e7c53-24c3-4276-a540-e253351dae9c` |
| 3615 | YeeShaans Grubb | `1490e92d-c02a-4f03-8390-080a4c667028` |
| 3616 | Yella's | `65193f65-5046-42d5-8986-128892c62221` |
| 3617 | Yely | `d6ba2244-806d-49f4-9b4b-102ab99cad4e` |
| 3618 | YNot Pizza & Italian Cuisine | `171ff9fc-0613-4fcf-83ad-f13fadca3374` |
| 3619 | YNot Pizza & Italian Cuisine Virginia Beach | `5b9c2de0-2c8d-4f73-8a61-2434d32c86da` |
| 3620 | Yo Bo Cantina Fresca | `05cc2561-c263-450e-a1f1-5f3a5fc45088` |
| 3621 | Yo Mommas Cantina | `0b898af2-a741-425c-bd72-fcaf06fba769` |
| 3622 | Yo Pop Sandwich Shop | `b38d0e00-54ff-4a0a-9919-27e43070b373` |
| 3623 | Yogi's Sushi Bar | `9d1ab3fb-e98d-42b2-aee3-c6a9bddf5c0f` |
| 3624 | Yogis Grill | `651a379f-275c-443e-a5e9-227356fb0f9d` |
| 3625 | Yogis Grill Phoenix | `a24d9c27-8f3f-4455-8899-bb22e6d77381` |
| 3626 | Yogurt Mountain | `cb2ebe27-59ca-4fa2-b36e-a842ad4db0cf` |
| 3627 | Yogurtini Self Serve Frozen Yogurt | `be60c05b-ec18-4ddf-84e4-ec9dde9e5187` |
| 3628 | Yogurtland | `86d37012-07a5-4c19-b40e-1e2efda63ee8` |
| 3629 | Yogurtland Avondale | `d0dc1682-31be-4a8f-8ea4-261efaf4fc53` |
| 3630 | Yogurtland Garland | `670a3c5c-72c5-4bc9-94f8-a48426f60485` |
| 3631 | Yogurtland Mesa | `7a08cdd3-cd8b-4ab8-974f-442ba84595bd` |
| 3632 | Yolk | `6236a124-5b5b-486c-992f-3dd5c79e74a9` |
| 3633 | Yonutz! | `62ae2cc6-559e-49ab-82ee-69f391012755` |
| 3634 | Yonutz! Phoenix | `7586459f-0ea8-435d-a1b7-e879f97ce810` |
| 3635 | Yosemite Ranch | `yosemite-ranch` |
| 3636 | Yoshi Express | `10f1691c-b3c0-42db-bd63-38fd93592b70` |
| 3637 | Yoshi Food Truck | `a4c07838-1f8f-4390-8704-f045ab71016d` |
| 3638 | Your Fresh Kitchen | `1b727762-c7c5-403c-8aab-cf3e1bf82bd2` |
| 3639 | Your Pie Pizza | `293fa10a-df57-417b-8a4b-17f9782ab966` |
| 3640 | Your Pie Pizza High Point | `3302b63c-d75c-4fe0-9e53-86ddc93797a8` |
| 3641 | Yugo Ramen | `91de3e8b-5c40-4669-ae47-4d94a03afc5f` |
| 3642 | Yummy Chinese Food | `aea45e59-83be-42ab-bc71-74ff3ba43bc8` |
| 3643 | Yummy Grill Afghan Kabob House | `410cf1fa-37da-4ec4-b784-bcff6c5a8912` |
| 3644 | Yummy Yummy Chinese | `eb3534f2-b149-4fb8-9588-8e946ffa9885` |
| 3645 | Z'Tejas | `6f4ebc36-6c82-4ee0-8c43-f5752772174b` |
| 3646 | Zaap Kitchen | `b33ae8df-282a-4847-8fd1-dd703fc9f0b1` |
| 3647 | Zaika Indian Kitchen | `7c1bf122-84c3-4587-b77c-f9c0580a0db4` |
| 3648 | Zalat Pizza | `081d4064-2576-4e42-936c-919c0ca5bd6a` |
| 3649 | Zara Mediterranean Grill | `db6dc25c-b9e1-49a9-9c70-8a3bc6f820a0` |
| 3650 | Zara Mediterranean Grill Glen Allen | `7dad9b94-fefd-4501-9a45-47237926c2d3` |
| 3651 | Zareen's | `062cfce3-3f29-499c-b496-9f49af83870b` |
| 3652 | Zaxbys | `ead12f3a-4b80-4d45-a53d-c031dd4e1371` |
| 3653 | Zaxbys Chesapeake | `aa2ae55c-41e8-4e48-a137-9ee9ddc7ee14` |
| 3654 | Zaxbys Huntsville | `50b7a688-99ee-47d9-97de-6334e8bc4975` |
| 3655 | Zaxbys Richardson | `83468680-def4-4b3b-963d-ae106081fce7` |
| 3656 | Zaxbys Richmond | `70eb1be4-3c76-4199-ad02-6f6da308706b` |
| 3657 | Zaxbys Winston-Salem | `dde4a698-c5d9-4867-8ddc-0f44d874756b` |
| 3658 | Zest Café | `c1dc7086-5c8f-46da-b08e-4f6662c5327b` |
| 3659 | Zest Kitchen & Bar | `9626256a-582b-47f8-896e-1c44c35181d3` |
| 3660 | Zesty Zzeeks Pizza & Wings | `55c414b4-1b68-4f22-b5cf-b4224c256af9` |
| 3661 | Zheng Chinese Restaurant | `8f4652f3-19f2-42ed-a35d-ee954e27a266` |
| 3662 | Zimo's | `7a1a2789-74f5-47b6-96ef-610186a88d3f` |
| 3663 | Zinburger | `53cadeb8-eb35-4725-b1f4-7fe28a4b4c70` |
| 3664 | Zini's Pizza | `f069146c-6aa4-4b93-bea3-54d2ea6cab8e` |
| 3665 | Zinque | `d6eb5996-16fb-40bf-850d-c85fb0bd33f5` |
| 3666 | ZK Grill | `a71649f2-15d6-4b9d-bfbd-b3c8690c7bd4` |
| 3667 | Zodiac Lounge | `bb58d646-9a98-4b87-a310-81a04c1956f5` |
| 3668 | Zodiac Subs | `2453e912-ee18-4aa3-bc72-e5116a3ea7da` |
| 3669 | Zoli's NY Pizza | `dc3bc020-c4ed-46ff-bd39-0508151df5ff` |
| 3670 | Zookz Sandwiches | `36bbcc48-019b-4ec8-9f49-569e48047449` |
| 3671 | Zorba's Greek Cafe | `f83fe09a-f3c6-4006-b8a0-15a2844e64f9` |
| 3672 | Zoyo Neighborhood Yogurt | `4d3c4964-ad38-473d-8328-6ee3370ad4d6` |
| 3673 | Zoyo Neighborhood Yogurt Phoenix | `c9a0c9fb-f011-4d15-9678-770751c6c2d6` |
| 3674 | Zpizza | `39f6497d-382f-4afc-ab92-2fb7cdef1ac2` |
| 3675 | Zuki's Pita | `e4b58f00-0004-47b6-8a34-567ff2115247` |
| 3676 | Zullee Mediterranean Grill | `8d2fdd89-4f37-45d0-8171-0e30efda9abf` |
| 3677 | Zullee Mediterranean Grill Meridian | `90bef620-8f2c-498c-9480-6be9334be646` |
| 3678 | Zunkaa Authentic Indian Cuisine  | `1933dfa6-ae86-46de-bfa8-7f6f29acdf7b` |
| 3679 | Zutto - Tribeca | `a3fad151-dc9e-4626-a073-8cf86909147a` |
| 3680 | Zzaam! | `66115b10-2676-4a43-96ef-4358471b0d58` |

---

## 3. Set aside as test / copy records (12)

**Each was verified before being set aside** — it matched a test/copy naming pattern **and** has
**zero revenue orders and $0.00 gross**. Nothing was excluded on its name alone.

| Restaurant | Reference | Orders | Gross |
|---|---|---:|---:|
| [COPY] Inga's Alpine Tavern | `377ace8a-510d-40ec-acaa-35db8433b891` | 0 | $0.00 |
| [COPY] Stacks & Cordials - Clawson | `5f58947a-9551-4a4d-9dbc-a0c15e4cb29d` | 0 | $0.00 |
| [COPY] Stacks & Cordials - Royal Oak | `6ea5fb51-3b79-4ef5-ba85-0ca371305ff2` | 0 | $0.00 |
| [COPY] Stacks & Cordials - Royal Oak | `3fd3bf85-dca6-4931-b3d2-6caa1a48ecd9` | 0 | $0.00 |
| [COPY] Tap 42 - Aventura | `b92e35c8-b702-42f3-9f4e-ffa92e60bd66` | 0 | $0.00 |
| Test 13 | `82eaa17a-6241-48a2-ab5e-264e0a9ad07b` | 0 | $0.00 |
| Test 15 | `c84295fb-54be-4659-a7a1-32de40262bea` | 0 | $0.00 |
| Test 17 | `e067470a-5005-4dc5-b15c-b6b4b1205b79` | 0 | $0.00 |
| Test 18 | `0c8e7455-f638-4628-b8fa-249ba6eb0f7e` | 0 | $0.00 |
| Test 50 | `41ac8ade-7a8f-4c31-8016-57c031d39c99` | 0 | $0.00 |
| This is a test | `dcb59f24-b75e-4d47-920b-614d3239ff76` | 0 | $0.00 |
| This is a test 2 | `31e8c76a-18e0-4326-9827-e4b00d2f5c5e` | 0 | $0.00 |

### Deliberately NOT set aside

**Test Kitchen** (`c8322ff4-32dd-47bc-8515-3f0cffc34bbf`) matches the test naming pattern but has
**81 revenue orders worth $1,245.08**, last ordered 2026-07-15. Because it has
real order history it is **kept in the main list above**, not dropped. It is FamilyMeal's own
live-testing restaurant and its orders are mostly $1–$4 test charges, so it is almost certainly
not a conversion prospect — but that is Peter's judgement to make, not a silent exclusion. Its FM
record is currently soft-deleted (`Test Kitchen [Deleted]`).
