import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-4-20250514'
const MAX_PDF_BYTES = 10 * 1024 * 1024 // 10MB

const SYSTEM_PROMPT = `You are a catering menu parser. Extract all catering packages/items from this menu PDF and return ONLY a JSON array with no markdown, no preamble, no explanation. Each object must have:
- name: string (the package or item name)
- description: string (full description as written, or empty string if none)
- price: number (price per person or per package as a decimal number, e.g. 14.99)
- serves: number (number of people served, extract from "serves X" or "feeds X" language; use 10 if unclear)
- itemType: "CATERING"

Return only the raw JSON array. Example:
[{"name":"Taco Bar","description":"Includes chicken, beef, rice, beans, tortillas, and toppings","price":18.00,"serves":10,"itemType":"CATERING"}]`

interface ParsedPackage {
  name: string
  description: string
  price: number
  serves: number
  itemType: string
}

// Strip accidental ```json fences / preamble and pull out the first JSON array.
function extractJsonArray(text: string): ParsedPackage[] | null {
  if (!text) return null
  let t = text.trim()
  // Remove markdown code fences if present.
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  // Direct parse first.
  try {
    const direct = JSON.parse(t)
    if (Array.isArray(direct)) return direct
  } catch { /* fall through to bracket extraction */ }
  // Otherwise grab the outermost [...] block.
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const arr = JSON.parse(t.slice(start, end + 1))
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  // 1. Auth gate (SUPER_ADMIN — same cookie/role gating as other admin routes).
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Menu parsing is not configured (missing API key).' }, { status: 500 })
  }

  let file: File | null = null
  let restaurantReference = ''
  try {
    const form = await req.formData()
    file = form.get('file') as File | null
    restaurantReference = String(form.get('restaurantReference') || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid form data.' }, { status: 400 })
  }

  if (!restaurantReference) {
    return NextResponse.json({ error: 'Restaurant Reference is required.' }, { status: 400 })
  }
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'A PDF file is required.' }, { status: 400 })
  }
  if (file.type && file.type !== 'application/pdf') {
    return NextResponse.json({ error: 'Only PDF files are supported.' }, { status: 400 })
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: 'PDF is too large (max 10MB).' }, { status: 400 })
  }

  // 2. Read the PDF as base64.
  let base64: string
  try {
    const buf = Buffer.from(await file.arrayBuffer())
    base64 = buf.toString('base64')
  } catch {
    return NextResponse.json({ error: 'Could not read the PDF file.' }, { status: 400 })
  }

  // 3. Call the Anthropic REST API directly (no SDK) with the PDF as a
  //    document block.
  let anthropicData: any
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              },
              { type: 'text', text: 'Extract the catering packages from this menu.' },
            ],
          },
        ],
      }),
    })
    anthropicData = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = anthropicData?.error?.message || `Parsing service error (${res.status}).`
      return NextResponse.json({ error: msg }, { status: 502 })
    }
  } catch {
    return NextResponse.json({ error: 'Could not reach the parsing service.' }, { status: 502 })
  }

  // 4. Pull the text out of the response and parse the JSON array.
  const text: string = Array.isArray(anthropicData?.content)
    ? anthropicData.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
    : ''
  const packages = extractJsonArray(text)
  if (!packages) {
    return NextResponse.json({ error: 'Could not parse menu — the document may be unreadable or not a catering menu. Please try a different PDF.' }, { status: 422 })
  }

  // 5. Normalize each package so the UI gets consistent shapes.
  const cleaned = packages.map(p => ({
    name: String(p?.name ?? '').trim(),
    description: String(p?.description ?? '').trim(),
    price: Number.isFinite(Number(p?.price)) ? Number(p?.price) : 0,
    serves: Number.isFinite(Number(p?.serves)) && Number(p?.serves) > 0 ? Math.round(Number(p?.serves)) : 10,
    itemType: p?.itemType === 'REGULAR' ? 'REGULAR' : 'CATERING',
  })).filter(p => p.name)

  return NextResponse.json({ packages: cleaned })
}
