/**
 * autoTagCuisines.js (v2)
 * Uses Claude to assign 1-3 cuisine tags to each restaurant.
 *
 * Run with:
 * SANITY_TOKEN=your_token ANTHROPIC_API_KEY=your_key node scripts/autoTagCuisines.js
 *
 * Options:
 *   --dry-run    Print what would be set without writing to Sanity
 *   --limit=50   Only process first N restaurants
 *   --skip=100   Skip first N restaurants (for resuming after a partial run)
 */

const { createClient } = require('@sanity/client')

const client = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  apiVersion: '2024-01-01',
  token: process.env.SANITY_TOKEN,
  useCdn: false,
})

const DRY_RUN = process.argv.includes('--dry-run')
const limitArg = process.argv.find(a => a.startsWith('--limit='))
const skipArg = process.argv.find(a => a.startsWith('--skip='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : null
const SKIP = skipArg ? parseInt(skipArg.split('=')[1]) : 0

const APPROVED_TAGS = [
  'American', 'Italian', 'Mexican', 'Japanese', 'Chinese', 'Indian',
  'Mediterranean', 'Thai', 'Korean', 'French', 'Middle Eastern',
  'Caribbean', 'BBQ', 'Vegan', 'Vegetarian', 'Latin',
  'Pizza', 'Burritos', 'Tacos', 'Sushi', 'Ramen', 'Burgers', 'Sandwiches',
  'Wings', 'Seafood', 'Steakhouse', 'Bakery', 'Breakfast', 'Brunch',
  'Dim Sum', 'Noodles', 'Salads', 'Wraps', 'Bowls', 'Tapas',
  'Greek', 'Spanish', 'Ethiopian', 'Vietnamese', 'Filipino', 'Peruvian',
  'Halal', 'Kosher', 'Gluten-Free', 'Cafe', 'Deli', 'Donuts',
]

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

async function callClaude(prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: prompt }],
        }),
      })

      if (res.status === 529 || res.status === 503 || res.status === 429) {
        const wait = attempt * 3000
        console.log(`    Rate limited (${res.status}), waiting ${wait / 1000}s before retry ${attempt}/${retries}...`)
        await sleep(wait)
        continue
      }

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      }

      const data = await res.json()

      if (!data.content || data.content.length === 0) {
        throw new Error(`Empty content. Stop reason: ${data.stop_reason}`)
      }

      const text = data.content[0]?.text?.trim()
      if (!text) throw new Error(`Empty text in response`)

      return text

    } catch (err) {
      if (attempt === retries) throw err
      console.log(`    Attempt ${attempt} failed: ${err.message}. Retrying...`)
      await sleep(2000 * attempt)
    }
  }
}

async function getTagsFromClaude(restaurant) {
  const prompt = `Tag this restaurant for a catering marketplace. Choose 1-3 tags from ONLY this exact list:
${APPROVED_TAGS.join(', ')}

Rules:
- Use ONLY tags from the list above, spelled exactly as shown
- 1-3 tags maximum, most specific first
- Return ONLY a JSON array like ["Tag1", "Tag2"] with no other text whatsoever

Restaurant name: ${restaurant.name}
Current cuisine: ${restaurant.cuisine || restaurant.cuisines?.[0] || 'Unknown'}
Description: ${(restaurant.description || '').slice(0, 200)}

JSON array:`

  const text = await callClaude(prompt)

  // Extract JSON array even if there's extra text around it
  const match = text.match(/\[.*?\]/s)
  if (!match) throw new Error(`No JSON array found in: ${text.slice(0, 100)}`)

  const parsed = JSON.parse(match[0])
  if (!Array.isArray(parsed)) throw new Error(`Not an array: ${text}`)

  const validated = parsed
    .filter(tag => APPROVED_TAGS.includes(tag))
    .slice(0, 3)

  if (validated.length === 0) throw new Error(`No valid tags in: ${JSON.stringify(parsed)}`)

  return validated
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is required')
    process.exit(1)
  }
  if (!process.env.SANITY_TOKEN && !DRY_RUN) {
    console.error('❌ SANITY_TOKEN is required (or use --dry-run)')
    process.exit(1)
  }

  // Test API connection first
  console.log('Testing Anthropic API connection...')
  try {
    const testRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Reply with just: ["test"]' }],
      }),
    })
    const testData = await testRes.json()
    if (!testRes.ok) {
      console.error('❌ API test failed:', JSON.stringify(testData))
      process.exit(1)
    }
    console.log('✅ API connection OK:', testData.content?.[0]?.text?.trim())
  } catch (err) {
    console.error('❌ API test error:', err.message)
    process.exit(1)
  }

  console.log('\nFetching restaurants from Sanity...')
  let restaurants = await client.fetch(
    `*[_type == "restaurant"]{_id, name, cuisine, cuisines, description}`
  )

  if (SKIP > 0) {
    restaurants = restaurants.slice(SKIP)
    console.log(`Skipping first ${SKIP} restaurants`)
  }
  if (LIMIT) {
    restaurants = restaurants.slice(0, LIMIT)
  }

  const total = restaurants.length
  console.log(`Processing ${total} restaurants${DRY_RUN ? ' (DRY RUN — no writes)' : ''}...\n`)

  let success = 0
  let failed = 0
  const failures = []

  for (let i = 0; i < restaurants.length; i++) {
    const r = restaurants[i]
    const displayIndex = i + 1 + SKIP
    const displayTotal = total + SKIP
    const prefix = `[${displayIndex}/${displayTotal}]`

    try {
      const tags = await getTagsFromClaude(r)
      console.log(`${prefix} ${r.name}`)
      console.log(`         ${JSON.stringify(tags)}`)

      if (!DRY_RUN) {
        await client.patch(r._id).set({ cuisines: tags }).commit()
      }

      success++
      await sleep(1000)

    } catch (err) {
      console.error(`${prefix} ❌ ${r.name}: ${err.message}`)
      failed++
      failures.push({ name: r.name, error: err.message })
      await sleep(1000)
    }
  }

  console.log('\n' + '─'.repeat(50))
  console.log(`✅ Success: ${success}`)
  if (failed > 0) {
    console.log(`❌ Failed:  ${failed}`)
    console.log('\nFailed restaurants:')
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`))
    if (success > 0) {
      console.log(`\nTo resume, re-run with --skip=${SKIP + success}`)
    }
  }
  if (DRY_RUN) {
    console.log('\nℹ️  Dry run — no changes written to Sanity')
  } else {
    console.log('\n🎉 Done! Run the bulk publish script to make changes live.')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})