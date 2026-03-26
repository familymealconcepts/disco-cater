
const { createClient } = require('@sanity/client')
const fs = require('fs')
const path = require('path')
const { parse } = require('csv-parse/sync')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })

const client = createClient({ projectId: '0j4eqnmw', dataset: 'production', token: process.env.SANITY_TOKEN, apiVersion: '2024-01-01', useCdn: false })
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
const CACHE_PATH = path.join(__dirname, 'output', 'places-cache.json')

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
  if (cityStateMap[name]) return cityStateMap[name]
  for (const [opp, cityState] of Object.entries(cityStateMap)) {
    const baseName = name.split(' - ')[0].trim()
    if (name.includes(opp) || opp.includes(baseName)) return cityState
  }
  return null
}

async function searchPlace(restaurantName, cityState) {
  const cacheKey = 'place:' + restaurantName
  if (cache[cacheKey]) return cache[cacheKey]

  const query = cityState ? restaurantName + ' ' + cityState : restaurantName
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json?query=' + encodeURIComponent(query) + '&key=' + GOOGLE_KEY

  try {
    const res = await fetch(url)
    const data = await res.json()
    if (data.status !== 'OK' || !data.results?.[0]) {
      cache[cacheKey] = null
      saveCache()
      return null
    }
    const place = data.results[0]
    const result = {
      placeId: place.place_id,
      address: place.formatted_address,
      lat: place.geometry.location.lat,
      lng: place.geometry.location.lng,
      photoRef: place.photos?.[0]?.photo_reference || null,
    }
    // Extract city, state from formatted_address
    const parts = place.formatted_address.split(',')
    const city = parts.length >= 3 ? parts[parts.length - 3]?.trim() : ''
    const stateZip = parts.length >= 2 ? parts[parts.length - 2]?.trim() : ''
    const state = stateZip.split(' ')[0] || ''
    result.location = city && state ? city + ', ' + state : (cityState || place.formatted_address)
    cache[cacheKey] = result
    saveCache()
    return result
  } catch(e) {
    console.error('Place search failed:', e)
    cache[cacheKey] = null
    saveCache()
    return null
  }
}

async function getPhotoBuffer(photoRef) {
  const url = 'https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=' + photoRef + '&key=' + GOOGLE_KEY
  const res = await fetch(url)
  if (!res.ok) return null
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

async function uploadImageToSanity(photoRef, restaurantName) {
  const cacheKey = 'img:' + restaurantName
  if (cache[cacheKey]) return cache[cacheKey]
  try {
    const buf = await getPhotoBuffer(photoRef)
    if (!buf) return null
    const asset = await client.assets.upload('image', buf, {
      filename: restaurantName.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.jpg',
      contentType: 'image/jpeg',
    })
    cache[cacheKey] = asset._id
    saveCache()
    return asset._id
  } catch(e) {
    console.error('Image upload failed for ' + restaurantName + ':', e.message)
    return null
  }
}

async function main() {
  const existing = await client.fetch('*[_type == "restaurant"]{_id, name, location}')
  console.log('Found ' + existing.length + ' restaurants in Sanity')
  let updated = 0, skipped = 0, failed = 0

  for (let i = 0; i < existing.length; i++) {
    const r = existing[i]
    const cityState = findCityState(r.name)
    process.stdout.write('[' + (i+1) + '/' + existing.length + '] ' + r.name + '... ')

    try {
      const place = await searchPlace(r.name, cityState)
      await sleep(150)

      if (!place) {
        skipped++
        console.log('SKIP (not found in Places API)')
        continue
      }

      // Build patch
      const patch = {
        location: place.location,
        lat: place.lat,
        lng: place.lng,
      }

      // Upload image if available
      if (place.photoRef) {
        const imageId = await uploadImageToSanity(place.photoRef, r.name)
        await sleep(100)
        if (imageId) {
          patch.image = { _type: 'image', asset: { _type: 'reference', _ref: imageId } }
        }
      }

      await client.patch(r._id).set(patch).commit()
      updated++
      console.log('OK ' + place.address + (patch.image ? ' + IMG' : ''))
    } catch(e) {
      failed++
      console.log('FAIL ' + e.message)
    }
  }

  console.log('\nDone! Updated: ' + updated + ', Skipped: ' + skipped + ', Failed: ' + failed)
}

main()
