import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-4-20250514'
const MAX_PDF_BYTES = 10 * 1024 * 1024 // 10MB
// ezCater pages are large; strip script/style noise and cap the HTML we send so
// the Anthropic request stays within limits.
const MAX_HTML_CHARS = 400_000
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const PDF_SYSTEM_PROMPT = `You are a catering menu parser. Extract all catering packages/items from this menu PDF and return ONLY a JSON array with no markdown, no preamble, no explanation. Each object must have:
- name: string (the package or item name)
- description: string (full description as written, or empty string if none)
- price: number (price per person or per package as a decimal number, e.g. 14.99)
- serves: number (number of people served, extract from "serves X" or "feeds X" language; use 10 if unclear)
- itemType: "CATERING"

Return only the raw JSON array. Example:
[{"name":"Taco Bar","description":"Includes chicken, beef, rice, beans, tortillas, and toppings","price":18.00,"serves":10,"itemType":"CATERING"}]`

const URL_SYSTEM_PROMPT = `You are a catering menu parser. Extract all catering packages and menu items from this ezCater HTML page and return ONLY a JSON array with no markdown, no preamble, no explanation. Each object must have:
- name: string (the package or item name)
- description: string (full description as written, or empty string if none)
- price: number (price per person or per package as a decimal, e.g. 14.99)
- serves: number (number of people served; use 10 if unclear)
- itemType: "CATERING"

Focus on extracting the actual menu packages/items, not page navigation or UI text. Return only the raw JSON array.`

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

// Calls the Anthropic REST API directly (no SDK) and returns the text output.
// Throws { status, error } on transport/API failure.
async function runAnthropic(apiKey: string, system: string, content: unknown[]): Promise<string> {
  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, system, messages: [{ role: 'user', content }] }),
    })
  } catch {
    throw { status: 502, error: 'Could not reach the parsing service.' }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw { status: 502, error: (data as any)?.error?.message || `Parsing service error (${res.status}).` }
  }
  return Array.isArray((data as any)?.content)
    ? (data as any).content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
    : ''
}

// Extract + normalize the model output into the response shape (or a 422).
function finishParse(text: string): NextResponse {
  const packages = extractJsonArray(text)
  if (!packages) {
    return NextResponse.json({ error: 'Could not parse menu — the source may be unreadable or not a catering menu. Please try again.' }, { status: 422 })
  }
  const cleaned = packages.map(p => ({
    name: String(p?.name ?? '').trim(),
    description: String(p?.description ?? '').trim(),
    price: Number.isFinite(Number(p?.price)) ? Number(p?.price) : 0,
    serves: Number.isFinite(Number(p?.serves)) && Number(p?.serves) > 0 ? Math.round(Number(p?.serves)) : 10,
    itemType: p?.itemType === 'REGULAR' ? 'REGULAR' : 'CATERING',
  })).filter(p => p.name)
  return NextResponse.json({ packages: cleaned })
}

export async function POST(req: NextRequest) {
  // Auth gate (same cookie/role gating as other admin routes).
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Menu parsing is not configured (missing API key).' }, { status: 500 })
  }

  // multipart → PDF mode; JSON → ezCater URL mode.
  const ct = req.headers.get('content-type') || ''
  return ct.startsWith('multipart/form-data') ? handlePdf(req, apiKey) : handleUrl(req, apiKey)
}

async function handlePdf(req: NextRequest, apiKey: string): Promise<NextResponse> {
  let file: File | null = null
  let restaurantReference = ''
  try {
    const form = await req.formData()
    file = form.get('file') as File | null
    restaurantReference = String(form.get('restaurantReference') || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid form data.' }, { status: 400 })
  }

  if (!restaurantReference) return NextResponse.json({ error: 'Please select a restaurant.' }, { status: 400 })
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'A PDF file is required.' }, { status: 400 })
  if (file.type && file.type !== 'application/pdf') return NextResponse.json({ error: 'Only PDF files are supported.' }, { status: 400 })
  if (file.size > MAX_PDF_BYTES) return NextResponse.json({ error: 'PDF is too large (max 10MB).' }, { status: 400 })

  let base64: string
  try {
    base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
  } catch {
    return NextResponse.json({ error: 'Could not read the PDF file.' }, { status: 400 })
  }

  try {
    const text = await runAnthropic(apiKey, PDF_SYSTEM_PROMPT, [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: 'Extract the catering packages from this menu.' },
    ])
    return finishParse(text)
  } catch (e: any) {
    return NextResponse.json({ error: e?.error || 'Could not parse the menu.' }, { status: e?.status || 502 })
  }
}

async function handleUrl(req: NextRequest, apiKey: string): Promise<NextResponse> {
  let url = ''
  let restaurantReference = ''
  try {
    const body = await req.json()
    url = String(body?.url || '').trim()
    restaurantReference = String(body?.restaurantReference || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  if (!restaurantReference) return NextResponse.json({ error: 'Please select a restaurant.' }, { status: 400 })
  if (!url) return NextResponse.json({ error: 'A menu URL is required.' }, { status: 400 })
  // Validate it's an ezCater URL (with or without protocol / www).
  if (!/^(https?:\/\/)?(www\.)?ezcater\.com\//i.test(url)) {
    return NextResponse.json({ error: 'Please enter a valid ezCater URL.' }, { status: 400 })
  }
  const fetchUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`

  // Server-side fetch the ezCater page with a realistic browser User-Agent.
  let html: string
  try {
    const pageRes = await fetch(fetchUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    })
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`)
    html = await pageRes.text()
  } catch {
    return NextResponse.json({ error: 'Could not fetch the ezCater page. The restaurant may need to share their menu as a PDF instead.' }, { status: 502 })
  }

  // Strip script/style noise and cap length before sending to Anthropic.
  const cleanedHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .slice(0, MAX_HTML_CHARS)

  try {
    const text = await runAnthropic(apiKey, URL_SYSTEM_PROMPT, [{ type: 'text', text: cleanedHtml }])
    return finishParse(text)
  } catch (e: any) {
    return NextResponse.json({ error: e?.error || 'Could not parse the menu.' }, { status: e?.status || 502 })
  }
}
