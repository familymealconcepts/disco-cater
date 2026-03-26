
const { createClient } = require('@sanity/client')
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })

const client = createClient({ projectId: '0j4eqnmw', dataset: 'production', token: process.env.SANITY_TOKEN, apiVersion: '2024-01-01', useCdn: false })
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const PLACES_CACHE = path.join(__dirname, 'output', 'places-cache.json')
const DETAILS_CACHE = path.join(__dirname, 'output', 'details-cache.json')

let placesCache = {}
let detailsCache = {}
if (fs.existsSync(PLACES_CACHE)) placesCache = JSON.parse(fs.readFileSync(PLACES_CACHE, 'utf8'))
if (fs.existsSync(DETAILS_CACHE)) detailsCache = JSON.parse(fs.readFileSync(DETAILS_CACHE, 'utf8'))
function saveDetails() { fs.writeFileSync(DETAILS_CACHE, JSON.stringify(detailsCache, null, 2)) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Map Google place types to clean cuisine labels
const TYPE_MAP = {
  'restaurant': null, 'food': null, 'point_of_interest': null, 'establishment': null,
  'store': null, 'locality': null, 'geocode': null, 'premise': null,
  'meal_takeaway': null, 'meal_delivery': null, 'cafe': 'Cafe',
  'bakery': 'Bakery', 'bar': 'Bar & Grill', 'night_club': 'Bar',
  'pizza_restaurant': 'Pizza', 'mexican_restaurant': 'Mexican',
  'italian_restaurant': 'Italian', 'chinese_restaurant': 'Chinese',
  'japanese_restaurant': 'Japanese', 'thai_restaurant': 'Thai',
  'indian_restaurant': 'Indian', 'mediterranean_restaurant': 'Mediterranean',
  'american_restaurant': 'American', 'seafood_restaurant': 'Seafood',
  'sandwich_shop': 'Sandwiches', 'hamburger_restaurant': 'Burgers',
  'fast_food_restaurant': 'Fast Casual', 'ice_cream_shop': 'Desserts',
  'dessert_shop': 'Desserts', 'bagel_shop': 'Bagels', 'bbq_restaurant': 'BBQ',
  'korean_restaurant': 'Korean', 'vietnamese_restaurant': 'Vietnamese',
  'greek_restaurant': 'Greek', 'french_restaurant': 'French',
  'middle_eastern_restaurant': 'Middle Eastern', 'vegan_restaurant': 'Vegan',
  'vegetarian_restaurant': 'Vegetarian', 'juice_bar': 'Juice Bar',
  'chicken_wings_restaurant': 'Wings', 'ramen_restaurant': 'Ramen',
  'sushi_restaurant': 'Sushi', 'breakfast_restaurant': 'Breakfast',
  'deli': 'Deli', 'donut_shop': 'Donuts', 'bubble_tea_store': 'Bubble Tea',
  'pizza_delivery': 'Pizza', 'african_restaurant': 'African',
  'latin_american_restaurant': 'Latin American', 'spanish_restaurant': 'Spanish',
  'turkish_restaurant': 'Turkish', 'lebanese_restaurant': 'Lebanese',
  'brunch_restaurant': 'Brunch', 'steak_house': 'Steakhouse',
  'fine_dining_restaurant': 'Fine Dining', 'catering_food_and_drink_supplier': 'Catering',
  'caribbean_restaurant': 'Caribbean', 'soul_food_restaurant': 'Soul Food',
  'southern_us_restaurant': 'Southern', 'taiwanese_restaurant': 'Taiwanese',
  'burmese_restaurant': 'Burmese', 'ethiopian_restaurant': 'Ethiopian',
  'peruvian_restaurant': 'Peruvian', 'ukrainian_restaurant': 'Ukrainian',
}

async function getPlaceDetails(placeId, name) {
  const cacheKey = 'details:' + placeId
  if (detailsCache[cacheKey]) return detailsCache[cacheKey]
  try {
    const url = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + placeId +
      '&fields=name,types,editorial_summary,website&key=' + GOOGLE_KEY
    const res = await fetch(url)
    const data = await res.json()
    if (data.status !== 'OK') return null
    const result = {
      types: data.result?.types || [],
      editorial: data.result?.editorial_summary?.overview || '',
      website: data.result?.website || '',
    }
    detailsCache[cacheKey] = result
    saveDetails()
    return result
  } catch(e) { return null }
}

function getCuisineFromTypes(types) {
  for (const t of types) {
    if (TYPE_MAP[t]) return TYPE_MAP[t]
  }
  return null
}

async function generateDescription(name, editorial, website, cuisine) {
  const cacheKey = 'desc:' + name
  if (detailsCache[cacheKey]) return detailsCache[cacheKey]
  const context = editorial || ('A ' + (cuisine || 'restaurant') + ' called ' + name)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: 'Write a 1-2 sentence catering description for "' + name + '". Base it on this context if available: ' + context + '. If no context, use the restaurant name to infer cuisine style. Focus on what makes it great for group orders, events, or office catering. Max 120 chars. Plain text only, no quotes, no hashtags, no markdown.' }]
      })
    })
    const data = await res.json()
    const desc = data.content?.[0]?.text?.trim() || context
    detailsCache[cacheKey] = desc
    saveDetails()
    return desc
  } catch(e) { return context }
}

async function main() {
  const existing = await client.fetch('*[_type == "restaurant"]{_id, name, cuisine, description}')
  console.log('Processing ' + existing.length + ' restaurants...')
  let updated = 0, skipped = 0

  for (let i = 0; i < existing.length; i++) {
    const r = existing[i]
    const placeCache = placesCache['place:' + r.name]
    process.stdout.write('[' + (i+1) + '/' + existing.length + '] ' + r.name + '... ')

    if (!placeCache?.placeId) {
      skipped++
      console.log('SKIP (no placeId)')
      continue
    }

    try {
      const details = await getPlaceDetails(placeCache.placeId, r.name)
      await sleep(100)

      const cuisine = getCuisineFromTypes(details?.types || []) || r.cuisine
      const desc = await generateDescription(r.name, details?.editorial, details?.website, cuisine)
      await sleep(100)

      await client.patch(r._id).set({ cuisine, description: desc }).commit()
      updated++
      console.log('OK | ' + cuisine + ' | ' + desc.substring(0, 50) + '...')
    } catch(e) {
      skipped++
      console.log('FAIL: ' + e.message)
    }
  }
  console.log('\nDone! Updated: ' + updated + ', Skipped: ' + skipped)
}
main()
