import { createClient } from '@sanity/client'
const client = createClient({
  projectId: '0j4eqnmw', dataset: 'production',
  token: process.env.SANITY_TOKEN, apiVersion: '2024-01-01', useCdn: false,
})
const docs = await client.fetch('*[_type == "restaurant"]{_id}')
console.log(`Cleaning ${docs.length} documents...`)
await Promise.all(docs.map(d => client.patch(d._id).unset(['featured', 'tags', 'cuisine']).commit()))
console.log('Done.')
