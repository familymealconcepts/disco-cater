
const { createClient } = require('@sanity/client')
const fs = require('fs')
const path = require('path')
const { parse } = require('csv-parse/sync')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })

const client = createClient({ projectId: '0j4eqnmw', dataset: 'production', token: process.env.SANITY_TOKEN, apiVersion: '2024-01-01', useCdn: false })

async function main() {
  const csv = fs.readFileSync(path.join(__dirname, 'data', 'DiscoRestaurantsWithAddresses.csv'), 'utf8')
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true, relax_quotes: true })
  console.log('Loaded ' + rows.length + ' rows from CSV')

  const existing = await client.fetch('*[_type == "restaurant"]{_id, name}')
  console.log('Found ' + existing.length + ' restaurants in Sanity')

  // Index Sanity restaurants by name
  const sanityByName = {}
  for (const r of existing) sanityByName[r.name.toLowerCase().trim()] = r._id

  let updated = 0, skipped = 0, failed = 0

  for (const row of rows) {
    const name = row.business_name?.trim()
    if (!name) continue

    const lat = parseFloat(row.addr_latitude)
    const lng = parseFloat(row.addr_longitude)
    const city = row.addr_city?.trim()
    const state = row.addr_state?.trim()
    const address = row.addr_address_line_1?.trim()
    const zip = row.addr_zipcode?.trim()

    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      skipped++
      console.log('SKIP (no coords): ' + name)
      continue
    }

    const sanityId = sanityByName[name.toLowerCase().trim()]
    if (!sanityId) {
      skipped++
      console.log('SKIP (not in Sanity): ' + name)
      continue
    }

    const location = city && state ? city + ', ' + state : name

    try {
      await client.patch(sanityId).set({
        lat,
        lng,
        location,
      }).commit()
      updated++
      process.stdout.write('.')
    } catch(e) {
      failed++
      console.log('FAIL ' + name + ': ' + e.message)
    }
  }

  console.log('\n\nDone! Updated: ' + updated + ', Skipped: ' + skipped + ', Failed: ' + failed)
}

main()
