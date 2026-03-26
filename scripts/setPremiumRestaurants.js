
const { createClient } = require('@sanity/client')
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') })

const client = createClient({ projectId: '0j4eqnmw', dataset: 'production', token: process.env.SANITY_TOKEN, apiVersion: '2024-01-01', useCdn: false })

// Original 80 premium restaurants from the hand-curated list
const PREMIUM_NAMES = new Set([
  'Chef Jordan Bailey', 'Hearthly Burger', 'Marcel Bakery and Kitchen', 'Almost Home',
  'Firenze: Italian Street Food', 'The Speakeatery', '2nd Jetty Seafood', 'Benchmark Breads',
  "Julio's Pizza Co.", 'Krewe de Fromage', 'Sandy Hook Seafood', 'Point Lobster',
  'Dinner Parties Do Good', 'Local Smoke BBQ', '502 Baking Company', 'Francesca Pizza',
  'Keep It Sweet Desserts', 'White Maple Cafe', 'Wax Paper Co', 'Black Bear BBQ',
  'Bird & Co.', 'Best Pizza', 'Gertie', 'Lunetta', 'Chicas Tacos', 'Doce Donut Co.',
  'Zutto', "Uncle Paulie's Deli", 'Sweet Chick', 'Rangoon', 'Little Fatty',
  'Black Seed Bagels', 'Zara Mediterranean Charcoal Grill', 'Alta Calidad', 'Little Egg',
  'Mission Sandwich Social', 'Purslane', "Mekelburg's", 'Springbone Kitchen',
  'Pecking House', 'Utopia Bagels', 'Veselka', 'See No Evil Pizza', 'Namkeen',
  'La Sandwicherie', 'Aunts et Uncles', 'Teranga', 'Miss Ada', 'Fish Cheeks',
  'Thea Bakery', 'Motorino', 'COPS', 'Strange Delight', 'Brown Bag Sandwich Co.',
  'Mile End Deli', 'Decades Pizza', 'Brooklyn Dumpling Shop', 'Rokstar Chicken',
  'Son del North', "Wexler's Deli", 'Pine & Crane', 'De Nada Cantina', "Lil' Easy",
  "Pete's Bagels", "Willa's", 'Hatch 44', 'Pie Girl', 'Colonial Ranch Market',
  'Good&Fantzye', 'Smogen Appetizers', '29 Hance Bakehouse',
  "Maciel's Plant-Based Butcher Shop", 'Major Food Group', 'Vesti', 'Animo!', 'gtk',
  'Sandy Hook Seafood', 'Local Smoke BBQ', 'Francesca Pizza',
])

async function main() {
  const all = await client.fetch('*[_type == "restaurant"]{_id, name, isDisco}')
  console.log('Total restaurants: ' + all.length)

  let setPremium = 0, setRegular = 0

  for (const r of all) {
    // Check if name matches any premium name (partial match)
    const isPremium = [...PREMIUM_NAMES].some(p =>
      r.name?.toLowerCase().includes(p.toLowerCase()) ||
      p.toLowerCase().includes(r.name?.toLowerCase().split(' - ')[0].trim())
    )

    await client.patch(r._id).set({ isDisco: isPremium }).commit()
    if (isPremium) { setPremium++; console.log('  🪩 PREMIUM: ' + r.name) }
    else setRegular++
  }

  console.log('\nDone! Premium: ' + setPremium + ', Regular: ' + setRegular)
}

main()
