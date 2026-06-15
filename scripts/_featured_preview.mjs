import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)
const KATZ = '4cc15dd7-5b13-4808-af3b-b7862af3cbfb'

const katz = await sql`
  SELECT c.name, o.restaurant_reference, o.featured_order, o.visible, o.stripe_connected
  FROM disco_restaurant_cache c
  LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
  WHERE c.restaurant_reference = ${KATZ}`
console.log('=== KATZ (target) ===')
console.log(JSON.stringify(katz, null, 2))

const featured = await sql`
  SELECT o.featured_order, c.name, o.restaurant_reference
  FROM disco_restaurant_overrides o
  JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
  WHERE o.featured_order IS NOT NULL
  ORDER BY o.featured_order ASC`
console.log('\n=== CURRENT FEATURED (featured_order NOT NULL) ===')
for (const r of featured) console.log(`  #${r.featured_order}  ${r.name}  [${r.restaurant_reference}]`)
console.log(`  (total featured: ${featured.length})`)

const parm = await sql`
  SELECT c.name, c.restaurant_reference, o.featured_order
  FROM disco_restaurant_cache c
  LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
  WHERE c.name ILIKE '%parm%'
  ORDER BY c.name ASC`
console.log('\n=== PARM matches (name ILIKE %parm%) ===')
console.log(JSON.stringify(parm, null, 2))
