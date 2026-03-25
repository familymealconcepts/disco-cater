
const { createClient } = require('@sanity/client')
const fs = require('fs')
const path = require('path')
const { parse } = require('csv-parse/sync')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })

const client = createClient({ projectId: '0j4eqnmw', dataset: 'production', token: process.env.SANITY_TOKEN, apiVersion: '2024-01-01', useCdn: false })
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
const CSV_PATH = path.join(__dirname, 'data', 'Disco_Cater_Database-3.25.26 - Disco upload.csv')
const CACHE_PATH = path.join(__dirname, 'output', 'geocode-cache.json')

let cache = {}
if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
function saveCache() { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const TIMEZONE_MAP = { 'America/New_York': 'New York, NY', 'America/Los_Angeles': 'Los Angeles, CA', 'America/Chicago': 'Chicago, IL', 'America/Denver': 'Denver, CO', 'America/Phoenix': 'Phoenix, AZ', 'America/Detroit': 'Detroit, MI', 'America/Seattle': 'Seattle, WA', 'America/Boise': 'Boise, ID', 'America/Indiana/Indianapolis': 'Indianapolis, IN' }

async function geocode(name, timezone) {
  const key = 'geo2:' + name
  if (cache[key]) return cache[key]
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(name) + '&key=' + GOOGLE_KEY
    const res = await fetch(url)
    const data = await res.json()
    if (data.status === 'OK' && data.results?.[0]) {
      const result = data.results[0]
      const lat = result.geometry.location.lat
      const lng = result.geometry.location.lng
      const components = result.address_components
      const city = components.find(c => c.types.includes('locality'))?.long_name || ''
      const state = components.find(c => c.types.includes('administrative_area_level_1'))?.short_name || ''
      const location = city && state ? city + ', ' + state : result.formatted_address
      const geo = { lat, lng, location }
      cache[key] = geo
      saveCache()
      return geo
    }
  } catch(e) {}
  const fallback = { lat: 39.5, lng: -98.35, location: TIMEZONE_MAP[timezone] || 'United States' }
  cache[key] = fallback
  saveCache()
  return fallback
}

async function main() {
  const rows = parse(fs.readFileSync(CSV_PATH, 'utf8'), { columns: true, skip_empty_lines: true, trim: true, relax_quotes: true })
  const existing = await client.fetch('*[_type == "restaurant"]{_id, name}')
  console.log('Updating ' + existing.length + ' restaurants...')
  let updated = 0, failed = 0
  for (let i = 0; i < existing.length; i++) {
    const r = existing[i]
    const csvRow = rows.find(row => row.business_name?.trim() === r.name?.trim())
    const timezone = csvRow?.timezone || 'America/New_York'
    process.stdout.write('[' + (i+1) + '/' + existing.length + '] ' + r.name + '... ')
    try {
      const geo = await geocode(r.name, timezone)
      await sleep(80)
      await client.patch(r._id).set({ location: geo.location, lat: geo.lat, lng: geo.lng }).commit()
      updated++
      console.log('OK ' + geo.location)
    } catch(e) { failed++; console.log('FAIL ' + e) }
  }
  console.log('Done! Updated: ' + updated + ', Failed: ' + failed)
}
main()
