
const { createClient } = require('@sanity/client')
const fs = require('fs')
const path = require('path')
const { parse } = require('csv-parse/sync')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })

const client = createClient({ projectId: '0j4eqnmw', dataset: 'production', token: process.env.SANITY_TOKEN, apiVersion: '2024-01-01', useCdn: false })
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
const CACHE_PATH = path.join(__dirname, 'output', 'geocode-precise.json')

let cache = {}
if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
function saveCache() { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Load CityState lookup
const cityStateRows = parse(fs.readFileSync(path.join(__dirname, 'data', 'CityState.csv'), 'utf8'), { columns: true, skip_empty_lines: true, trim: true })
const cityStateMap = {}
for (const r of cityStateRows) {
  cityStateMap[r['Opportunity Name'].toLowerCase().trim()] = r['City, State']
}

function findCityState(restaurantName) {
  const name = restaurantName.toLowerCase().trim()
  // Exact match first
  if (cityStateMap[name]) return cityStateMap[name]
  // Fuzzy: find opportunity name that is contained in restaurant name
  for (const [opp, cityState] of Object.entries(cityStateMap)) {
    if (name.includes(opp) || opp.includes(name.split(' - ')[0].trim())) {
      return cityState
    }
  }
  return null
}

async function geocode(restaurantName, cityState) {
  const key = 'precise:' + restaurantName
  if (cache[key]) return cache[key]
  try {
    const query = cityState ? restaurantName + ' ' + cityState : restaurantName
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(query) + '&key=' + GOOGLE_KEY
    const res = await fetch(url)
    const data = await res.json()
    if (data.status === 'OK' && data.results?.[0]) {
      const result = data.results[0]
      const lat = result.geometry.location.lat
      const lng = result.geometry.location.lng
      const components = result.address_components
      const city = components.find(c => c.types.includes('locality'))?.long_name || ''
      const state = components.find(c => c.types.includes('administrative_area_level_1'))?.short_name || ''
      const location = city && state ? city + ', ' + state : (cityState || result.formatted_address)
      const geo = { lat, lng, location }
      cache[key] = geo
      saveCache()
      return geo
    }
  } catch(e) {}
  // Fallback: just use cityState as location with center coords
  if (cityState) {
    const fallback = { lat: 39.5, lng: -98.35, location: cityState }
    cache[key] = fallback
    saveCache()
    return fallback
  }
  return null
}

async function main() {
  const existing = await client.fetch('*[_type == "restaurant"]{_id, name, location}')
  console.log('Found ' + existing.length + ' restaurants in Sanity')

  // Only update ones that have imprecise locations or need fixing
  let updated = 0, skipped = 0, failed = 0

  for (let i = 0; i < existing.length; i++) {
    const r = existing[i]
    const cityState = findCityState(r.name)
    process.stdout.write('[' + (i+1) + '/' + existing.length + '] ' + r.name + '... ')

    if (!cityState) {
      skipped++
      console.log('SKIP (no city/state match)')
      continue
    }

    try {
      const geo = await geocode(r.name, cityState)
      await sleep(80)
      if (!geo) { skipped++; console.log('SKIP (no geo)'); continue }

      await client.patch(r._id).set({
        location: geo.location,
        lat: geo.lat,
        lng: geo.lng,
      }).commit()

      updated++
      console.log('OK ' + geo.location + ' [' + geo.lat.toFixed(3) + ', ' + geo.lng.toFixed(3) + ']')
    } catch(e) {
      failed++
      console.log('FAIL ' + e)
    }
  }

  console.log('\nDone! Updated: ' + updated + ', Skipped: ' + skipped + ', Failed: ' + failed)
}
main()
