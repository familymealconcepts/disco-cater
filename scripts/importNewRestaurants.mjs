import { createClient } from '@sanity/client'
import Anthropic from '@anthropic-ai/sdk'
import { parse } from 'csv-parse/sync'
import { readFileSync } from 'fs'
import { JSDOM } from 'jsdom'

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '9999')
const SKIP = parseInt(process.argv.find(a => a.startsWith('--skip='))?.split('=')[1] ?? '0')

const SANITY_TOKEN = process.env.SANITY_TOKEN
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if (!SANITY_TOKEN) { console.error('SANITY_TOKEN not set'); process.exit(1) }
if (!ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }

const sanity = createClient({ projectId: '0j4eqnmw', dataset: 'production', apiVersion: '2024-01-01', token: SANITY_TOKEN, useCdn: false })
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

const VALID_CUISINES = ['American','Italian','Mexican','Japanese','Chinese','Indian','Mediterranean','Thai','Korean','French','Middle Eastern','Caribbean','BBQ','Vegan','Other']

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }

async function fetchAddress(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const html = await res.text()
    const dom = new JSDOM(html)
    const body = dom.window.document.body.textContent ?? ''
    const match = body.match(/\d+\s+[A-Za-z][A-Za-z0-9\s.,'-]{5,60},\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5}/)
    return match ? match[0].trim() : null
  } catch(e) { console.warn('  Could not fetch ' + url + ': ' + e.message); return null }
}

async function geocodeAddress(address) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(address) + '&format=json&limit=1&countrycodes=us'
    const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'DiscoImporter/1.0' } })
    const data = await res.json()
    if (data?.[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name }
  } catch(e) { console.warn('  Geocode failed: ' + e.message) }
  return null
}

async function geocodeByName(name, slug) {
  const cityMap = { ashville: 'Asheville NC', asheville: 'Asheville NC', decatur: 'Decatur GA', peachtreecorners: 'Peachtree Corners GA', sandysprings: 'Sandy Springs GA', cumming: 'Cumming GA', woodstock: 'Woodstock GA', smyrna: 'Smyrna GA', westside: 'Atlanta GA', eastvillage: 'New York NY' }
  const slugLower = slug.toLowerCase()
  let cityHint = ''
  for (const [key, val] of Object.entries(cityMap)) { if (slugLower.includes(key)) { cityHint = val; break } }
  const query = cityHint ? name + ' restaurant ' + cityHint : name + ' restaurant'
  console.log('  Geocoding: ' + query)
  return await geocodeAddress(query)
}

function shortLocation(displayName) {
  if (!displayName) return 'United States'
  const parts = displayName.split(',').map(p => p.trim())
  const usIdx = parts.findIndex(p => p === 'United States')
  if (usIdx > 1) return parts[usIdx - 2] + ', ' + parts[usIdx - 1]
  return parts.slice(0, 2).join(', ')
}

async function guessCuisine(name) {
  const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: 'Pick one cuisine for "' + name + '" from: ' + VALID_CUISINES.join(', ') + '. Reply with just the cuisine word, nothing else.' }] })
  const raw = msg.content[0].text.trim()
  return VALID_CUISINES.find(c => c.toLowerCase() === raw.toLowerCase()) ?? 'Other'
}

async function generateDescription(name, cuisine, location) {
  const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 80, messages: [{ role: 'user', content: 'Write a 1-2 sentence catering description for "' + name + '", a ' + cuisine + ' restaurant in ' + location + '. Focus on corporate/event catering. Max 35 words. No fluff.' }] })
  return msg.content[0].text.trim()
}

const CSV_PATH = process.argv.find(a => a.endsWith('.csv')) ?? '4_20_upload.csv'
let rows
try { rows = parse(readFileSync(CSV_PATH, 'utf-8'), { columns: true, skip_empty_lines: true }) }
catch(e) { console.error('Could not read CSV: ' + e.message); process.exit(1) }

rows = rows.slice(SKIP, SKIP + LIMIT)
console.log('\nDisco Cater Import — ' + rows.length + ' restaurants | dry-run: ' + DRY_RUN + '\n')

let imported = 0, skipped = 0, failed = 0

for (const row of rows) {
  const name = row['Restaurant Name']?.trim()
  const orderUrl = row['URL']?.trim()
  if (!name || !orderUrl) { skipped++; continue }
  console.log('\n' + name)
  const urlSlug = orderUrl.split('/').filter(Boolean)[1] ?? slugify(name)
  let address = await fetchAddress(orderUrl)
  let geo = address ? await geocodeAddress(address) : null
  if (!geo) geo = await geocodeByName(name, urlSlug)
  if (!geo) { console.log('  Could not geocode — skipping'); failed++; await sleep(1100); continue }
  const location = shortLocation(geo.displayName)
  console.log('  ' + location + ' (' + geo.lat.toFixed(4) + ', ' + geo.lng.toFixed(4) + ')')
  const cuisine = await guessCuisine(name)
  console.log('  Cuisine: ' + cuisine)
  const description = await generateDescription(name, cuisine, location)
  console.log('  ' + description)
  const doc = { _id: 'restaurant-' + slugify(name), _type: 'restaurant', name, slug: { _type: 'slug', current: slugify(name) }, cuisine, description, location, address: address ?? '', lat: geo.lat, lng: geo.lng, orderUrl, isDisco: false, featured: false, tags: [] }
  if (DRY_RUN) { console.log('  [DRY RUN] OK') }
  else {
    try { await sanity.createOrReplace(doc); console.log('  Imported'); imported++ }
    catch(e) { console.error('  Sanity error: ' + e.message); failed++ }
  }
  await sleep(1200)
}
console.log('\nDone — Imported: ' + imported + ' | Skipped: ' + skipped + ' | Failed: ' + failed)
