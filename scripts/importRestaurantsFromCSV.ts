// Run with:
//   npx ts-node --skip-project scripts/importRestaurantsFromCSV.ts

import { createClient } from '@sanity/client'
import * as fs from 'fs'
import * as path from 'path'
import { parse } from 'csv-parse/sync'

import { fileURLToPath } from 'url'
import { dirname } from 'path'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  token: process.env.SANITY_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
})

const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!
const CSV_PATH = path.join(__dirname, 'data', 'Disco_Cater_Database3.25.26  Disco upload.csv')
const CACHE_PATH = path.join(__dirname, 'output', 'import-cache.json')

let cache: Record<string, any> = {}
if (fs.existsSync(CACHE_PATH)) {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
}
function saveCache() {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function geocode(name: string): Promise<{ lat: number; lng: number; location: string } | null> {
  if (cache[`geo:${name}`]) return cache[`geo:${name}`]
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(name + ' restaurant')}&key=${GOOGLE_KEY}`
    const res = await fetch(url)
    const data = await res.json() as any
    if (data.status !== 'OK' || !data.results?.[0]) return null
    const result = data.results[0]
    const lat = result.geometry.location.lat
    const lng = result.geometry.location.lng
    const components = result.address_components as any[]
    const city = components.find((c: any) => c.types.includes('locality'))?.long_name || ''
    const state = components.find((c: any) => c.types.includes('administrative_area_level_1'))?.short_name || ''
    const location = city && state ? `${city}, ${state}` : result.formatted_address
    const geo = { lat, lng, location }
    cache[`geo:${name}`] = geo
    saveCache()
    return geo
  } catch (e) {
    return null
  }
}

async function getRestaurantInfo(name: string): Promise<{ cuisine: string; description: string }> {
  if (cache[`info:${name}`]) return cache[`info:${name}`]
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `For the restaurant "${name}", respond with ONLY a JSON object (no markdown):\n{"cuisine": "one or two word cuisine type", "description": "one sentence catering description max 120 chars"}\nIf unknown, guess from the name.`
        }]
      })
    })
    const data = await res.json() as any
    const text = data.content?.[0]?.text || '{}'
    const info = JSON.parse(text.replace(/```json|```/g, '').trim())
    const result = {
      cuisine: info.cuisine || 'American',
      description: info.description || `${name} is a partner restaurant on Disco Cater.`
    }
    cache[`info:${name}`] = result
    saveCache()
    return result
  } catch (e) {
    return { cuisine: 'American', description: `${name} is a partner restaurant on Disco Cater.` }
  }
}

async function main() {
  const csvContent = fs.readFileSync(CSV_PATH, 'utf8')
  const rows = parse(csvContent, {
    columns: true, skip_empty_lines: true, trim: true, relax_quotes: true, delimiter: '\t',
  })
  console.log(`Found ${rows.length} restaurants in CSV`)
  const validRows = rows.filter((r: any) => r.disco_url?.trim())
  console.log(`${validRows.length} have a disco_url`)

  console.log('\nDeleting existing restaurants from Sanity...')
  const existing = await client.fetch(`*[_type == "restaurant"]._id`)
  console.log(`Found ${existing.length} existing restaurants to delete`)
  const deleteBatch = client.transaction()
  for (const id of existing) deleteBatch.delete(id)
  await deleteBatch.commit()
  console.log(`Deleted ${existing.length} restaurants`)

  console.log('\nImporting new restaurants...')
  let created = 0, failed = 0

  for (let i = 0; i < validRows.length; i++) {
    const row = validRows[i] as any
    const name = row.business_name?.trim()
    if (!name) continue
    const discoUrl = row.disco_url?.trim()
    const orderUrl = discoUrl.startsWith('http') ? discoUrl : `https://${discoUrl}`
    process.stdout.write(`[${i + 1}/${validRows.length}] ${name}... `)
    try {
      const geo = await geocode(name)
      await sleep(100)
      const info = await getRestaurantInfo(name)
      await sleep(100)
      await client.create({
        _type: 'restaurant',
        name,
        slug: { _type: 'slug', current: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') },
        location: geo?.location ?? 'United States',
        cuisine: info.cuisine,
        lat: geo?.lat ?? 39.5,
        lng: geo?.lng ?? -98.35,
        isDisco: true,
        orderUrl,
        description: info.description,
        featured: false,
      })
      created++
      console.log(`✓ ${geo?.location} | ${info.cuisine}`)
    } catch (e) {
      failed++
      console.log(`✗ FAILED: ${e}`)
    }
  }
  console.log(`\nDone! Created: ${created}, Failed: ${failed}`)
}

main()
