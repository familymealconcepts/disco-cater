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

function resolvePackages(restaurant: any): { packages: any[]; source: 'live' | 'fallback' } {
  // Prefer the full live menu the client passed (the real, current menu the customer
  // sees). Only fall back to the static top-few file if live data is unavailable.
  if (Array.isArray(restaurant?.packages) && restaurant.packages.length > 0) {
    return { packages: restaurant.packages, source: 'live' }
  }
  const target = restaurant?.name?.toLowerCase().trim()
  if (!target) return { packages: [], source: 'fallback' }
  const match = enrichedData.find(e => e.name?.toLowerCase().trim() === target)
  return { packages: match?.topPackages || [], source: 'fallback' }
}

// Render the menu grouped by category, one line per item with serves, price, and a
// (trimmed) description — so attribute questions ("vegan cream cheese?") and
// headcount-appropriate recommendations both have the data they need.
function renderMenuLines(packages: any[]): string {
  if (!packages.length) return '(no packages listed)'
  const price = (p: any) => p.pricePerPerson || (p.price != null && p.price !== '' ? `$${Number(p.price).toFixed(2)}` : 'price on request')
  const byCat = new Map<string, any[]>()
  for (const p of packages) {
    const c = String(p.category || 'Menu').trim() || 'Menu'
    const list = byCat.get(c) ?? []
    list.push(p)
    byCat.set(c, list)
  }
  return [...byCat.entries()].map(([cat, items]) =>
    `${cat}:\n` + items.map((p: any) => {
      const serves = (p.serves != null && p.serves !== '') ? `serves ${p.serves}` : ''
      const desc = p.description ? ` — ${String(p.description).replace(/\s+/g, ' ').trim().slice(0, 240)}` : ''
      return `  · ${p.name} (${[serves, price(p)].filter(Boolean).join(', ')})${desc}`
    }).join('\n'),
  ).join('\n\n')
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
    const { messages, restaurant, intake, orderContext } = await req.json()

    const { packages, source } = resolvePackages(restaurant)
    console.log(`[Chatbot] menu source=${source}, items=${packages.length}, restaurant=${restaurant?.name}`)
    const pkgLines = renderMenuLines(packages)

    // Real order context (headcount / date / service type) entered in the setup
    // modal, falling back to the intake questionnaire's occasion.
    const ctxParts: string[] = []
    if (orderContext?.headcount) ctxParts.push(`${orderContext.headcount} people`)
    if (orderContext?.date) ctxParts.push(`on ${orderContext.date}`)
    if (orderContext?.service) ctxParts.push(String(orderContext.service).toUpperCase() === 'DELIVERY' ? 'for delivery' : 'for pickup')
    if (intake?.occasion) ctxParts.unshift(String(intake.occasion))
    if (!orderContext?.headcount && intake?.headcount) ctxParts.push(`${intake.headcount} people`)
    const contextLine = ctxParts.length ? `\nCustomer's order context: ${ctxParts.join(', ')}.\n` : ''

    const systemPrompt = `You are Disco — a concierge catering assistant advising on a specific restaurant.

Restaurant: ${restaurant?.name || 'this restaurant'} (${restaurant?.cuisine || ''}, ${restaurant?.location || ''})
This is the restaurant's COMPLETE current menu, grouped by category:
${pkgLines}
${contextLine}
ANSWER THE CUSTOMER'S ACTUAL QUESTION using the full menu above:
- For factual/lookup questions (e.g. "do you have X?", "any vegan options?", "what desserts are there?"): search the ENTIRE menu above and answer directly. If matching items exist, say yes and list them by exact name. Only say an item isn't available if nothing in the menu above matches — never claim you have no information when the menu is listed above.
- For recommendations: suggest 2-3 specific packages from the list that fit the customer's context (headcount, occasion, service type).

PRICING & SERVING RULES — follow these exactly, with no exceptions:
- NEVER calculate or invent per-person pricing. Only use the exact price as listed in the menu data above.
- NEVER multiply package prices or serving sizes unless the user explicitly asks for multiple of the same package.
- When recommending for N people, use the customer's headcount from the order context above; find the package whose "serves" value is closest to N without going under. Do not combine packages unless a single package cannot serve the group.
- Always state the exact package name, exact price, and exact serves count exactly as provided in the data above. Never round or estimate.
- If the menu data above genuinely does not contain the answer, say so rather than guessing.

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
          model: 'claude-sonnet-4-6',
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
