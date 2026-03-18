import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  // Route: /api/disco-chat
  const { messages, restaurants } = await req.json()

  const restaurantList = restaurants
    .map((r: any) =>
      `- ${r.name} (${r.cuisine}, ${r.location})${r.isDisco ? ' ⭐ Premium' : ''}` +
      `${r.description ? `: ${r.description}` : ''}` +
      `${r.orderUrl ? ` | Order: ${r.orderUrl}` : ''}`
    )
    .join('\n')

  const systemPrompt = `You are Disco, a friendly and knowledgeable catering assistant for Disco Cater — a platform that connects customers with top catering restaurants.

Your job is to help customers find the perfect restaurant for their catering needs. Be warm, concise, and specific.

When a customer describes an event, recommend 2-3 restaurants from the list below. For each recommendation:
- Name the restaurant and its cuisine
- Give a 1-sentence reason why it fits their event
- Always include the order link as a clickable URL

If they ask a general question about catering, answer helpfully and then offer to suggest specific restaurants.

Available restaurants:
${restaurantList}

If no restaurants closely match, suggest the closest options and explain why.`

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