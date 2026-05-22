// add-apollo-bagels-locations.mjs
// Run from disco-cater/ directory:
//   SANITY_TOKEN=your_token node add-apollo-bagels-locations.mjs

import { createClient } from '@sanity/client'

const token = process.env.SANITY_TOKEN
if (!token) {
  console.error('❌ SANITY_TOKEN env var is required')
  process.exit(1)
}

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  apiVersion: '2024-01-01',
  token,
  useCdn: false,
})

const locations = [
  {
    _id: 'restaurant-apollo-bagels-williamsburg',
    _type: 'restaurant',
    name: 'Apollo Bagels - Williamsburg',
    slug: { _type: 'slug', current: 'apollo-bagels-williamsburg' },
    address: '197 Bedford Ave, Brooklyn, NY 11211',
    location: 'Williamsburg, Brooklyn, NY',
    cuisine: 'American',
    lat: 40.7195,
    lng: -73.9573,
    isDisco: true,
    description:
      'Apollo Bagels brings its legendary hand-rolled, kettle-boiled bagels to the heart of Williamsburg. Whether you\'re fueling a creative team or feeding a weekend gathering, their catering spreads — loaded with house-made schmears, smoked fish, and towering deli stacks — are a Brooklyn crowd-pleaser every time.',
    orderUrl: 'https://www.familymeal.com/apollo-bagels-williamsburg',
  },
  {
    _id: 'restaurant-apollo-bagels-kips-bay',
    _type: 'restaurant',
    name: 'Apollo Bagels - Kips Bay',
    slug: { _type: 'slug', current: 'apollo-bagels-kips-bay' },
    address: '401 2nd Ave, New York, NY 10010',
    location: 'Kips Bay, Manhattan, NY',
    cuisine: 'American',
    lat: 40.7429,
    lng: -73.9803,
    isDisco: true,
    description:
      'Apollo Bagels\' Kips Bay outpost serves Midtown South with the same New York bagel excellence the brand is known for. Perfect for corporate breakfast catering, office spreads, or any event that deserves a proper New York bagel moment.',
    orderUrl: 'https://www.familymeal.com/apollo-bagels-kips-bay',
  },
  {
    _id: 'restaurant-apollo-bagels-hoboken',
    _type: 'restaurant',
    name: 'Apollo Bagels - Hoboken',
    slug: { _type: 'slug', current: 'apollo-bagels-hoboken' },
    address: '234 Washington St, Hoboken, NJ 07030',
    location: 'Hoboken, NJ',
    cuisine: 'American',
    lat: 40.7440,
    lng: -74.0324,
    isDisco: true,
    description:
      'Apollo Bagels crosses the Hudson to bring hand-rolled, kettle-boiled perfection to Hoboken. Ideal for corporate catering, team breakfasts, and events that need a New York-caliber bagel spread on the Jersey side.',
    orderUrl: 'https://www.familymeal.com/apollo-bagels-hoboken',
  },
]

async function run() {
  console.log(`📡 Connecting to Sanity (project: 0j4eqnmw)...\n`)

  for (const restaurant of locations) {
    try {
      const result = await client.createOrReplace(restaurant)
      console.log(`✅ Upserted: ${result.name} (${result._id})`)
    } catch (err) {
      console.error(`❌ Failed: ${restaurant.name}`, err.message)
    }
  }

  console.log('\n🎉 Done! All Apollo Bagels locations processed.')
  console.log('👉 Check https://discocater.sanity.studio to review and publish.')
}

run()
