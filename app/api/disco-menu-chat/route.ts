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

// Grounding safety net — prompt instructions alone did not reliably stop the
// model from inventing a plausible-sounding item (confirmed live testing:
// "Large Cheese Pizza $16.95" / "Large Pepperoni $20.70" fabricated repeatedly
// for a "kids at the party" scenario when the real menu only has "Large White
// Pizza $19.95" — a strong enough learned prior that two rounds of stronger
// prompt wording reduced but did not eliminate it). This scans the model's own
// reply for "**Item Name** ... $price"-shaped mentions and cross-checks each
// against the real packages list by name overlap + price (exact, or a clean
// integer multiple, since the model is expected to show qty × price math).
// Anything that matches neither is flagged so the caller can force one
// corrective retry instead of silently shipping a fabricated item + price.
function extractItemMentions(text: string): { name: string; price: number }[] {
  const mentions: { name: string; price: number }[] = []
  const re = /\*\*([^*\n]{2,60})\*\*[^\n$]{0,30}\$([0-9]+(?:\.[0-9]{1,2})?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[1].replace(/\s*\(.*?\)\s*/g, '').trim()
    const price = parseFloat(m[2])
    if (!name || !Number.isFinite(price)) continue
    // Skip summary/computed-total lines, not real item names — a bolded
    // dollar figure or "X ÷ Y ="-style total (e.g. "**~$652.80**", "**Target
    // budget: ~$720 total**") is never a menu item, and its "$" or "="
    // already gives it away regardless of wording.
    if (/[$=:]/.test(name)) continue
    if (/^[^A-Za-z0-9]/.test(name)) continue
    if (/^(for|total|running total|grand total|budget|target|per person|subtotal|remaining|approx|estimate|full estimated total|exact listed price|serves)\b/i.test(name)) continue
    if (/\b(budget|headroom|leftover|remaining)\b/i.test(name)) continue
    mentions.push({ name, price })
  }
  return mentions
}
function priceMatchesRealOrMultiple(price: number, base: number): boolean {
  if (!(base > 0)) return false
  for (let qty = 1; qty <= 40; qty++) {
    if (Math.abs(price - base * qty) < 0.02) return true
  }
  return false
}
function findUnverifiedItems(reply: string, packages: any[]): { name: string; price: number }[] {
  const real = (packages || []).filter(p => p?.name)
  return extractItemMentions(reply).filter(({ name, price }) => {
    const normName = name.toLowerCase().trim()
    const matchesSomeReal = real.some(p => {
      const pn = String(p.name).toLowerCase().trim()
      const nameOverlaps = pn === normName || pn.includes(normName) || normName.includes(pn)
      if (!nameOverlaps) return false
      const pPrice = Number(p.price)
      return !Number.isFinite(pPrice) || priceMatchesRealOrMultiple(price, pPrice)
    })
    return !matchesSomeReal
  })
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
- For recommendations: if ONE existing item/package already reasonably fits the customer's headcount and budget, recommend it as-is by its exact name, price, and serves count — simplest good answer wins, no need to build a combination when a single item already works.

PRICING & SERVING RULES:
- Every item name, price, and "serves" figure you use MUST come exactly from the menu data above — never invent an item, a price, or a serving size that isn't listed.
- If no single item fits (the group is bigger than any one item serves, or the customer describes a scenario the restaurant hasn't pre-built a package for), assemble a combination of real menu items and quantities to cover it. When you do, SHOW YOUR MATH so it's checkable, not just an assertion:
  - For each item: its listed price and serves, how many of it you're including, and the resulting subtotal (quantity × price) and people covered (quantity × serves — for a range like "12-15" or "5+", use the LOW end, so the estimate stays conservative rather than optimistic).
  - Sum the subtotals for a total cost, and divide by the target headcount for an approximate per-person cost. Always label a derived number as an estimate ("approximately," "roughly") — never state a computed figure with the same false precision as a real listed price.
  - Prefer a little headroom over falling short: round the item count needed UP, not down.
  - If the customer mentioned a budget, explicitly say whether your assembled total fits it, and by roughly how much it's under or over.
- If the menu data above genuinely doesn't have enough real items to reasonably cover the request (too few items, or no prices at all), say so rather than forcing together a combination that doesn't really work.
- Never round or estimate a price/serves figure that's directly listed — only the derived totals (sum, per-person) are ever approximate.
- Do NOT feel obligated to use up the customer's entire stated budget. If there's leftover budget room but no other REAL item on the list above is a good fit to add, stop and leave the budget unused rather than inventing a plausible-sounding extra item (a pizza, a side, a dessert, etc.) that isn't actually on the menu above. Before naming any item in your final answer, re-check that its exact name and price appear verbatim in the menu data above — if you're not certain it's there, leave it out.
- A common specific mistake: when a party has kids, defaulting to "add a cheese/pepperoni pizza" as a crowd-pleaser even when no such item is listed above (e.g. inventing "Large Cheese Pizza $16.95" when the real menu only has "Large White Pizza $19.95", or inventing a plain-cheese/pepperoni variant that doesn't exist). Treat any pizza, side, or kid-friendly item you're about to add as a hallucination risk specifically — go back to the menu data above and find its EXACT listed name and price character-for-character before writing it down. If no pizza/kid item is actually listed, do not suggest one at all.

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

    async function askClaude(msgs: any[]): Promise<{ reply: string } | { errorReply: string }> {
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
            messages: msgs,
          }),
        }
      )
      if (!res.ok) {
        const errorBody = await res.text()
        console.error('Anthropic API error (menu-chat):', res.status, errorBody)
        const isOverloaded = res.status === 529
        return { errorReply: isOverloaded ? 'Disco is busy right now. Try again in a moment.' : "I'm having trouble right now. Please try again in a moment." }
      }
      const data = await res.json()
      const reply = data.content?.[0]?.text
      if (!reply) {
        console.error('Unexpected Anthropic response shape (menu-chat):', JSON.stringify(data))
        return { errorReply: "I didn't get a response. Please try again." }
      }
      return { reply }
    }

    const first = await askClaude(cleanedMessages)
    if ('errorReply' in first) return NextResponse.json({ reply: first.errorReply })
    let reply = first.reply

    // Grounding safety net (see findUnverifiedItems) — force one corrective
    // retry, telling the model EXACTLY what it invented, rather than shipping
    // a fabricated item/price to the customer on the first pass.
    const unverified = findUnverifiedItems(reply, packages)
    if (unverified.length > 0) {
      console.warn('[disco-menu-chat] unverified item(s) in first reply, forcing corrective retry:', unverified)
      const correction = `Your previous answer referenced item(s) that do not match anything in the real menu data above: ${unverified.map(u => `"${u.name}" at $${u.price.toFixed(2)}`).join(', ')}. That's not acceptable. Redo your recommendation using ONLY items whose exact name and price you can find verbatim in the menu data. If no real item fits well, say so plainly instead of inventing one.`
      const retryMsgs = [...cleanedMessages, { role: 'assistant', content: reply }, { role: 'user', content: correction }]
      const retry = await askClaude(retryMsgs)
      if ('reply' in retry) {
        const stillUnverified = findUnverifiedItems(retry.reply, packages)
        if (stillUnverified.length > 0) {
          console.error('[disco-menu-chat] retry STILL contained unverified item(s) — returning it anyway (logged for follow-up):', stillUnverified)
        }
        reply = retry.reply
      }
    }

    return NextResponse.json({ reply })

  } catch (e) {
    console.error('disco-menu-chat route error:', e)
    return NextResponse.json({ reply: 'Something went wrong. Please try again.' })
  }
}
