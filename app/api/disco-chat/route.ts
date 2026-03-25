import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs'

let enrichedData: any[] = []
try {
  const dataPath = path.join(process.cwd(), 'scripts', 'output', 'restaurant-compact.json')
  if (fs.existsSync(dataPath)) {
    enrichedData = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
  }
} catch (e) {
  console.warn('Could not load enriched restaurant data:', e)
}

function buildEnrichedContext(restaurantsFromSanity: any[]) {
  return restaurantsFromSanity.map(r => {
    const enriched = enrichedData.find(e =>
      e.name?.toLowerCase().trim() === r.name?.toLowerCase().trim()
    )

    if (!enriched) return `- ${r.name} (${r.cuisine}, ${r.location})${r.orderUrl ? ` | Order: ${r.orderUrl}` : ''}`

    const ppp = enriched.pricePerPerson
    const priceStr = ppp?.min ? `$${ppp.min}-$${ppp.max}/person` : ''
    const delivery = enriched.offersDelivery ? `delivers within ${enriched.serviceRadiusMiles}mi` : 'pickup only'
    const events = (enriched.eventTypes || []).join(', ')

    const topPkgs = (enriched.topPackages || [])
      .map((p: any) => `    • ${p.name}${p.serves ? ` (serves ${p.serves})` : ''}${p.pricePerPerson ? ` - ${p.pricePerPerson}` : ''}`)
      .join('\n')

    return [
      `- ${r.name} (${r.cuisine}, ${r.location})`,
      priceStr ? `  Price range: ${priceStr}` : '',
      events ? `  Best for: ${events}` : '',
      `  Delivery: ${delivery}`,
      topPkgs ? `  Sample packages:\n${topPkgs}` : '',
      r.orderUrl ? `  Order: ${r.orderUrl}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

export async function POST(req: NextRequest) {
  const { messages, restaurants } = await req.json()

  const restaurantContext = buildEnrichedContext(restaurants)

  const systemPrompt = `You are Disco, a friendly and knowledgeable catering assistant for Disco Cater.

Your job is to help customers find the perfect restaurant for their catering needs. Be warm, concise, and specific.

When a customer describes an event, recommend 2-3 restaurants from the list. For each recommendation:
- Name the restaurant and explain why it fits their event
- Mention specific meal packages with serving sizes and prices per person
- Always include the order link so they can place an order

Key facts:
- Service radius is 20 miles for delivery
- Events are typically corporate, holiday, or social
- Always encourage customers to order early for large events

Available restaurants:
${restaurantContext}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: messages.map((m: any) => ({ role: m.role, content: m.content })),
    }),
  })

  const data = await res.json()
  const reply = data.content?.[0]?.text ?? 'Sorry, I had trouble responding. Please try again!'

  return NextResponse.json({ reply })
}
