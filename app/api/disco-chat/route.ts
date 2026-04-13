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

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options)
    if (res.status === 529 && i < retries - 1) {
      const delay = 1000 * 2 ** i // 1s → 2s → 4s
      console.warn(`Anthropic overloaded (529), retrying in ${delay}ms... (attempt ${i + 1}/${retries})`)
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    return res
  }
  throw new Error('Max retries exceeded')
}

export async function POST(req: NextRequest) {
  try {
    const { messages, restaurants } = await req.json()

    const restaurantContext = buildEnrichedContext(restaurants || [])

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

    const cleanedMessages = messages
      .filter((m: any) => m.content != null && String(m.content).trim() !== '')
      .reduce((acc: any[], m: any) => {
        if (acc.length === 0 && m.role === 'assistant') return acc
        acc.push({ role: m.role, content: m.content })
        return acc
      }, [])

    if (cleanedMessages.length === 0) {
      return NextResponse.json({ reply: "Hi! Tell me about your event and I'll find the perfect catering for you!" })
    }

    const res = await fetchWithRetry(
      'https://api.anthropic.com/v1/messages',
      {
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
          messages: cleanedMessages,
        }),
      }
    )

    if (!res.ok) {
      const errorBody = await res.text()
      console.error('Anthropic API error:', res.status, errorBody)
      const isOverloaded = res.status === 529
      return NextResponse.json({
        reply: isOverloaded
          ? "Disco AI is a little busy right now — try again in a sec! 🪩"
          : "Sorry, I'm having trouble right now. Please try again in a moment!"
      })
    }

    const data = await res.json()
    const reply = data.content?.[0]?.text

    if (!reply) {
      console.error('Unexpected Anthropic response shape:', JSON.stringify(data))
      return NextResponse.json({ reply: "Sorry, I didn't get a response. Please try again!" })
    }

    return NextResponse.json({ reply })

  } catch (e) {
    console.error('disco-chat route error:', e)
    return NextResponse.json({ reply: "Sorry, something went wrong. Please try again!" })
  }
}