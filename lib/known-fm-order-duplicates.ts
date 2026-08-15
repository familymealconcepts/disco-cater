// A closed, historical set of (restaurant, order_number) pairs where FM's own
// raw data has more than one order sharing the same order_number — confirmed
// via fm_backup (the frozen 2026-06-17 snapshot), not inferred. Extracted
// 2026-08-15: exactly one restaurant, Mav's Top Buns
// (38ab2131-9f97-4631-b636-f0976e82b5cb), 185 colliding order_number groups /
// 548 rows total, all from 2022 order data — a historical burst-creation
// artifact in FM's own order-number generation, not an ongoing issue and not
// fleet-wide (verified: every other restaurant in fm_backup has zero
// (restaurant, order_number) collisions).
//
// disco_orders_restaurant_order_number_uq means only ONE order per colliding
// group can ever hold that real order_number in Neon; every attempt to
// insert one of the others is a genuine, permanent, expected unique-
// constraint violation — not a new problem each time the sync retries it.
// Used by lib/fm-orders-sync.ts to downgrade that ONE specific, known
// collision shape from an alert to a debug log, while still alerting loudly
// on any duplicate-key error this set doesn't cover (a different restaurant,
// or a (restaurant, order_number) pair not in this list) — genuinely new
// information, never silently swallowed.
//
// This is a snapshot, not a live query — fm_backup is a local-only database,
// unreachable from production. If FM's own data changes (new restaurants
// develop the same burst-creation pattern), this list needs a fresh
// extraction; it does not grow itself.
const MAVS_TOP_BUNS = '38ab2131-9f97-4631-b636-f0976e82b5cb'

const MAVS_TOP_BUNS_DUPLICATE_ORDER_NUMBERS: string[] = [
  '308202210009', '308202210010', '308202210013', '310202210009', '310202210031',
  '310202210034', '310202210039', '310202210040', '310202210041', '310202210051',
  '310202210053', '310202210055', '310202210056', '310202210100', '310202210106',
  '310202210136', '310202210222', '404202203027', '404202203030', '404202203033',
  '404202203034', '404202203035', '404202203040', '404202203041', '404202203044',
  '404202203045', '404202203046', '404202203048', '404202203051', '404202203101',
  '710202210016', '710202210017', '710202210018', '710202210019', '710202210020',
  '710202210021', '710202210022', '710202210024', '710202210126', '1010202210007',
  '1010202210027', '1010202210028', '1010202210032', '1010202210033', '1010202210036',
  '1010202210038', '1010202210039', '1010202210040', '1010202210041', '1010202210042',
  '1010202210043', '1010202210044', '1010202210045', '1010202210046', '1010202210047',
  '1010202210048', '1010202210051', '1010202210053', '1209202210008', '1209202210009',
  '1209202210010', '1209202210011', '1209202210012', '1209202210029', '1209202210030',
  '1209202210031', '1209202210032', '1209202210034', '1410202210008', '1410202210010',
  '1410202210011', '1410202210014', '1410202210020', '1410202210024', '1410202210027',
  '1410202210028', '1410202210029', '1410202210030', '1410202210031', '1410202210032',
  '1410202210033', '1410202210034', '1410202210035', '1410202210036', '1410202210037',
  '1410202210039', '1410202210041', '1703202203204', '2007202200025', '2007202200037',
  '2007202200039', '2007202200043', '2007202200044', '2007202200048', '2007202200049',
  '2007202200050', '2007202200054', '2007202200056', '2007202200059', '2007202200100',
  '2007202200101', '2007202200103', '2007202200105', '2007202200107', '2032022130251',
  '2032022130306', '2032022130331', '2032022130353', '2309202210016', '2309202210017',
  '2309202210018', '2309202210024', '2309202210025', '2309202210026', '2309202210027',
  '2309202210029', '2309202210030', '2309202210031', '2309202210032', '2309202210033',
  '2405202200029', '2405202200055', '2405202200952', '2609202210011', '2609202210012',
  '2609202210013', '2609202210014', '2609202210017', '2609202210018', '2609202210020',
  '2609202210021', '2609202210023', '2609202210026', '2609202210030', '2609202210033',
  '2609202210034', '2609202210038', '2609202210039', '2609202210040', '2609202210042',
  '2609202210044', '2609202210045', '3008202210006', '3008202210007', '3008202210008',
  '3008202210009', '3008202210010', '3008202210020', '3008202210021', '3008202210022',
  '3008202210023', '3008202210024', '3008202210025', '3008202210027', '3008202210033',
  '3008202210034', '3008202210037', '3008202210041', '3008202210055', '3008202210108',
  '3009202210010', '3009202210018', '3009202210019', '3009202210021', '3009202210022',
  '3009202210024', '3009202210025', '3009202210026', '3009202210027', '3009202210042',
  '3009202210101', '30042022140037', '30042022140043', '30042022140044', '30042022140045',
  '30042022140055', '30042022140120', '251020220001100', '251020220001354', '251020220001442',
  '251020220001829', '2310202219002427', '2310202219002736', '2310202219002928', '2310202219003016',
]

const KNOWN_DUPLICATE_KEYS = new Set<string>(
  MAVS_TOP_BUNS_DUPLICATE_ORDER_NUMBERS.map(n => `${MAVS_TOP_BUNS}:${n}`),
)

// True only for a (restaurant, order_number) pair confirmed, offline, against
// fm_backup to already collide within FM's own data — never a blanket
// per-restaurant or per-error-code suppression. A duplicate-key error at any
// other restaurant, or a different order_number at this one, returns false
// and should still alert.
export function isKnownFmDuplicateOrderNumber(restaurantReference: string, orderNumber: string): boolean {
  return KNOWN_DUPLICATE_KEYS.has(`${restaurantReference}:${orderNumber}`)
}
