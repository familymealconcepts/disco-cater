/**
 * Step 1: addCuisineTags.js
 * Migrates every restaurant from cuisine: "Mexican" → cuisines: ["Mexican"]
 * Safe to re-run — skips restaurants that already have cuisines array.
 *
 * Run with:
 * SANITY_TOKEN=your_token node scripts/addCuisineTags.js
 */

const { createClient } = require('@sanity/client')

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  apiVersion: '2024-01-01',
  token: process.env.SANITY_TOKEN,
  useCdn: false,
})

async function main() {
  console.log('Fetching all restaurants...')
  const restaurants = await client.fetch(
    `*[_type == "restaurant"]{_id, name, cuisine, cuisines}`
  )

  console.log(`Found ${restaurants.length} restaurants`)

  const toMigrate = restaurants.filter(r => {
    // Skip if already has cuisines array with content
    if (Array.isArray(r.cuisines) && r.cuisines.length > 0) return false
    // Skip if no cuisine string to migrate
    if (!r.cuisine) return false
    return true
  })

  console.log(`${toMigrate.length} need migration, ${restaurants.length - toMigrate.length} already done`)

  if (toMigrate.length === 0) {
    console.log('Nothing to do!')
    return
  }

  // Batch in groups of 50 to avoid rate limits
  const BATCH = 50
  let done = 0

  for (let i = 0; i < toMigrate.length; i += BATCH) {
    const batch = toMigrate.slice(i, i + BATCH)
    const mutations = batch.map(r => ({
      patch: {
        id: r._id,
        set: { cuisines: [r.cuisine] },
      },
    }))

    await client.mutate(mutations)
    done += batch.length
    console.log(`  Migrated ${done}/${toMigrate.length}...`)
  }

  console.log('✅ Migration complete! Every restaurant now has cuisines: [original cuisine]')
  console.log('Next step: run autoTagCuisines.js to enrich with additional tags')
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
