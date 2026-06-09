import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs'

// Mode 2 — Menu advisor. Advises on a SINGLE restaurant's packages.
// Packages are resolved server-side from the compact file by restaurant name
// (the browser can't read scripts/output) — same pattern as disco-chat.

let enrichedData: any[] = []
try {
  const dataPath = path.join(process.cwd(), 'scripts', 'output', 'restaurant-compact.json')
  if (fs.existsSync(dataPath)) {
    enrichedData = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
  }
} catch (e) {
  console.warn('Could not load enriched restaurant data:', e)
}

function resolvePackages(restaurant: any): any[] {
  // Prefer packages the client passed; otherwise look them up by name.
  if (Array.isArray(restaurant?.packages) && restaurant.packages.length > 0) return restaurant.packages
  const target = restaurant?.name?.toLowerCase().trim()
  if (!target) return []
  const match = enrichedData.find(e => e.name?.toLowerCase().trim() === target)
  return match?.topPackages || []
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
    const { messages, restaurant, intake } = await req.json()

    const packages = resolvePackages(restaurant)
    // Verify the shape of the menu data the chatbot reasons over (name, serves,
    // pricePerPerson). Catches missing/renamed fields that cause bad answers.
    console.log('[Chatbot] First menu item:', JSON.stringify(packages[0], null, 2))
    const pkgLines = packages.length > 0
      ? packages.map((p: any) => `· ${p.name} — serves ${p.serves}, ${p.pricePerPerson}`).join('\n')
      : '(no packages listed)'
    const contextLine = intake
      ? `\nCustomer context: ${intake.occasion || 'an event'}, ${intake.headcount || 'their group'} people.\n`
      : ''

    const systemPrompt = `You are Disco — a concierge catering assistant advising on a specific restaurant.

Restaurant: ${restaurant?.name || 'this restaurant'} (${restaurant?.cuisine || ''}, ${restaurant?.location || ''})
Available packages:
${pkgLines}
${contextLine}
Recommend 2-3 specific packages from the list above that fit the event.

PRICING & SERVING RULES — follow these exactly, with no exceptions:
- NEVER calculate or invent per-person pricing. Only use the exact pricePerPerson or total price as listed in the menu data above.
- NEVER multiply package prices or serving sizes unless the user explicitly asks for multiple of the same package.
- When recommending a package for N people, find the package whose "serves" value is closest to N without going under. Do not combine packages unless a single package cannot serve the group.
- Always state the exact package name, exact price, and exact serves count exactly as provided in the data above. Never round or estimate.
- If the menu data above does not contain enough information to answer confidently, say so rather than guessing.

Do not recommend items not on the list. Do not suggest the customer contact anyone. Do not use filler language.`

    const cleanedMessages = (messages || [])
      .filter((m: any) => m.content != null && String(m.content).trim() !== '')
      .reduce((acc: any[], m: any) => {
        if (acc.length === 0 && m.role === 'assistant') return acc
        acc.push({ role: m.role, content: m.content })
        return acc
      }, [])

    if (cleanedMessages.length === 0) {
      return NextResponse.json({ reply: 'Tell me about your event and I will suggest packages.' })
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
          max_tokens: 800,
          system: systemPrompt,
          messages: cleanedMessages,
        }),
      }
    )

    if (!res.ok) {
      const errorBody = await res.text()
      console.error('Anthropic API error (menu-chat):', res.status, errorBody)
      const isOverloaded = res.status === 529
      return NextResponse.json({
        reply: isOverloaded
          ? 'Disco is busy right now. Try again in a moment.'
          : "I'm having trouble right now. Please try again in a moment.",
      })
    }

    const data = await res.json()
    const reply = data.content?.[0]?.text

    if (!reply) {
      console.error('Unexpected Anthropic response shape (menu-chat):', JSON.stringify(data))
      return NextResponse.json({ reply: "I didn't get a response. Please try again." })
    }

    return NextResponse.json({ reply })

  } catch (e) {
    console.error('disco-menu-chat route error:', e)
    return NextResponse.json({ reply: 'Something went wrong. Please try again.' })
  }
}
