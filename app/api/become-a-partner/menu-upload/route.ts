import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

// AI-powered menu import for the become-a-partner onboarding (Step 4).
//
// Flow:
//   source 'pdf' | 'url'  → parse the menu with Claude into structured items.
//     · HIGH confidence (≥3 items with names + prices): return the items so the
//       client can preview them. If the restaurant already exists in FM, also
//       create the meal packages there (best-effort — failures are logged, never
//       surfaced; the concierge team backstops).
//     · LOW confidence / any error: silently fall back — email the menu (PDF
//       attachment or URL link) to the concierge team and return { confidence:
//       'low' }. The restaurant never sees the failure.
//   source 'skip'         → just notify the concierge team that the menu step
//     was skipped, and return success.
//
// This route is PUBLIC (no admin cookie), so FM calls use the SUPER_ADMIN
// service JWT via getFmServiceAuthHeader(), not the per-request admin session.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-4-6'

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
const TEAM_EMAIL = 'concierge@discocater.com'

const MAX_PDF_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_HTML_CHARS = 400_000 // cap the HTML we send to Claude (large menu pages)
const URL_FETCH_TIMEOUT_MS = 15_000
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const SYSTEM_PROMPT = `You are a menu parser. Extract all catering menu items from the provided content. For each item return: name, description (optional), price (number, 0 if not found), serves (string e.g. '10-15'), category (e.g. 'Entrees', 'Sides', 'Beverages'). Price is optional — set to 0 if not listed. Do not lower confidence just because prices are missing. Return JSON only: { items: [...], confidence: 'high' | 'low' }. Set confidence to 'high' if you found at least 3 items with clear names. Set confidence to 'low' only if the content is unclear, blocked, or yields fewer than 3 named items.`

interface MenuItem {
  name: string
  description: string
  price: number
  serves: string
  category: string
}

// ── Claude ────────────────────────────────────────────────────────────────────

// Calls the Anthropic REST API directly (no SDK) and returns the text output, or
// throws on transport/API failure.
async function runAnthropic(apiKey: string, content: unknown[]): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data as any)?.error?.message || `Anthropic error ${res.status}`)
  return Array.isArray((data as any)?.content)
    ? (data as any).content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
    : ''
}

// Rasterize the first few PDF pages to base64 images for Claude vision. Many
// catering PDFs are design-heavy with text baked into images, which the raw
// document mode can miss — rendering each page to a flat image fixes that.
// Pure-WASM (mupdf) + sharp; no native binaries, so it runs on Vercel. Throws
// on any failure so the caller can fall back to raw-document mode.
const PDF_RENDER_PAGES = 3
const PDF_RENDER_SCALE = 2.0 // 72dpi × 2 ≈ 144dpi — enough for OCR
const PDF_MAX_EDGE = 1568    // Anthropic downsizes beyond this anyway

async function pdfToImages(pdfBuffer: Buffer): Promise<{ media_type: string; data: string }[]> {
  const mupdf = await import('mupdf')
  const sharp = (await import('sharp')).default
  const doc = mupdf.Document.openDocument(new Uint8Array(pdfBuffer), 'application/pdf')
  const pageCount = Math.min(doc.countPages(), PDF_RENDER_PAGES)
  if (pageCount < 1) throw new Error('PDF has no pages')

  const images: { media_type: string; data: string }[] = []
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i)
    const pix = page.toPixmap(mupdf.Matrix.scale(PDF_RENDER_SCALE, PDF_RENDER_SCALE), mupdf.ColorSpace.DeviceRGB, false)
    const png = Buffer.from(pix.asPNG())
    try {
      // Recompress to a size-capped JPEG so the request stays lean.
      const jpeg = await sharp(png)
        .resize({ width: PDF_MAX_EDGE, height: PDF_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
      images.push({ media_type: 'image/jpeg', data: jpeg.toString('base64') })
    } catch {
      // sharp failed — send the raw PNG page instead.
      images.push({ media_type: 'image/png', data: png.toString('base64') })
    }
  }
  if (!images.length) throw new Error('No pages rendered')
  return images
}

// Pull the { items, confidence } object out of the model output, tolerating
// ```json fences / preamble. Returns null if no JSON object is found.
function extractResult(text: string): { items: MenuItem[]; confidence: string } | null {
  if (!text) return null
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: any = null
  try {
    parsed = JSON.parse(t)
  } catch {
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try { parsed = JSON.parse(t.slice(start, end + 1)) } catch { return null }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const rawItems = Array.isArray(parsed.items) ? parsed.items : []
  const items: MenuItem[] = rawItems.map((p: any) => ({
    name: String(p?.name ?? '').trim(),
    description: String(p?.description ?? '').trim(),
    price: Number.isFinite(Number(p?.price)) ? Number(p?.price) : 0,
    serves: String(p?.serves ?? '').trim(),
    category: String(p?.category ?? '').trim(),
  })).filter((p: MenuItem) => p.name)
  return { items, confidence: parsed.confidence === 'high' ? 'high' : 'low' }
}

// ── Mailgun ───────────────────────────────────────────────────────────────────

// Email the concierge team. `attachment` (a PDF buffer) is optional. Returns
// false on any send failure — callers treat the email as best-effort.
async function notifyConcierge(subject: string, text: string, attachment?: { buffer: Buffer; filename: string }): Promise<boolean> {
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.error('[menu-upload] Mailgun is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN).')
    return false
  }
  try {
    const mg = new FormData()
    // Verified envelope sender (same as lib/email/send.ts) — deriving it from
    // MAILGUN_DOMAIN can be rejected as an unauthorized sender.
    mg.append('from', 'Disco Cater <orders@discocater.com>')
    mg.append('to', TEAM_EMAIL)
    mg.append('subject', subject)
    mg.append('text', text)
    if (attachment) mg.append('attachment', new Blob([new Uint8Array(attachment.buffer)], { type: 'application/pdf' }), attachment.filename)
    const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
      body: mg,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error(`[menu-upload] Mailgun ${res.status}: ${raw.slice(0, 300)}`)
      return false
    }
    return true
  } catch (err) {
    console.error('[menu-upload] Mailgun send failed:', err)
    return false
  }
}

// ── FM meal package creation (best-effort) ─────────────────────────────────────

// Parse the leading integer out of a serves string like "10-15" / "serves 12".
function servesToNumber(serves: string): number {
  const m = String(serves || '').match(/\d+/)
  const n = m ? parseInt(m[0], 10) : 0
  return Number.isFinite(n) && n > 0 ? n : 10
}

// Create one FM meal package per high-confidence item. Never throws — returns a
// summary for logging. Skipped entirely when no restaurant reference exists yet.
async function createMealPackages(restaurantReference: string, items: MenuItem[]): Promise<{ created: number; failed: number }> {
  let auth: Record<string, string>
  try {
    auth = await getFmServiceAuthHeader()
  } catch (err) {
    console.error('[menu-upload] FM service auth unavailable, skipping package creation:', err instanceof Error ? err.message : err)
    return { created: 0, failed: items.length }
  }
  let created = 0, failed = 0
  for (const item of items) {
    if (!item.name) { failed++; continue }
    try {
      const res = await fetch(`${FM}/api/mealPackages`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name: item.name,
          description: item.description || '',
          price: Number(item.price) || 0,
          serves: servesToNumber(item.serves),
          itemType: 'CATERING',
          restaurantReference,
          category: item.category || undefined,
        }),
      })
      if (res.ok) { created++ } else {
        failed++
        const raw = await res.text().catch(() => '')
        console.error(`[menu-upload] FM mealPackage create failed for "${item.name}": ${res.status} ${raw.slice(0, 200)}`)
      }
    } catch (err) {
      failed++
      console.error(`[menu-upload] FM mealPackage create error for "${item.name}":`, err instanceof Error ? err.message : err)
    }
  }
  return { created, failed }
}

// ── Route ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const source = String(body?.source || '').trim() as 'pdf' | 'url' | 'skip'
  const restaurantName = String(body?.restaurantName || '').trim()
  const restaurantEmail = String(body?.restaurantEmail || '').trim()
  const restaurantReference = String(body?.restaurantReference || '').trim()
  const url = String(body?.url || '').trim()
  const fileBase64 = typeof body?.fileBase64 === 'string' ? body.fileBase64 : ''
  const safeName = restaurantName || 'Unknown Restaurant'

  // ── Skip: notify the team, no parsing. ──
  if (source === 'skip') {
    await notifyConcierge(
      `Menu Upload — ${safeName} (skipped)`,
      `Restaurant ${safeName} skipped menu upload.\n\nEmail: ${restaurantEmail || 'Not provided'}\nRestaurant ref: ${restaurantReference || 'Not yet created'}`,
    )
    return NextResponse.json({ success: true, confidence: 'skipped' })
  }

  if (source !== 'pdf' && source !== 'url') {
    return NextResponse.json({ error: 'Invalid source.' }, { status: 400 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY

  // Build the concierge fallback once — used for any low-confidence/error path.
  async function fallback(reason: string): Promise<NextResponse> {
    console.error(`[menu-upload] falling back to concierge for ${safeName}: ${reason}`)
    let attachment: { buffer: Buffer; filename: string } | undefined
    let sourceLine = ''
    if (source === 'pdf' && fileBase64) {
      try { attachment = { buffer: Buffer.from(fileBase64, 'base64'), filename: 'menu.pdf' } } catch { /* unreadable base64 */ }
      sourceLine = 'Menu PDF: attached'
    } else if (source === 'url') {
      sourceLine = `Menu URL: ${url || 'Not provided'}`
    }
    await notifyConcierge(
      `Menu Upload — ${safeName}`,
      `A restaurant submitted their menu during onboarding, but our AI could not parse it confidently. Please set it up manually.\n\nRestaurant: ${safeName}\nEmail: ${restaurantEmail || 'Not provided'}\nRestaurant ref: ${restaurantReference || 'Not yet created'}\n${sourceLine}\n\nReason: ${reason}\n\nMenu Import tool: https://www.discocater.com/admin/manage-restaurants/menu-import`,
      attachment,
    )
    return NextResponse.json({ confidence: 'low' })
  }

  // Without an API key we can't parse — fall straight back to the team.
  if (!apiKey) return fallback('Menu parsing is not configured (missing API key).')

  // 1) Parse the menu with Claude.
  let parsed: { items: MenuItem[]; confidence: string } | null = null
  try {
    if (source === 'pdf') {
      if (!fileBase64) return NextResponse.json({ error: 'A PDF file is required.' }, { status: 400 })
      let pdfBuffer: Buffer
      try { pdfBuffer = Buffer.from(fileBase64, 'base64') } catch { pdfBuffer = Buffer.alloc(0) }
      if (pdfBuffer.length > MAX_PDF_BYTES) return NextResponse.json({ error: 'PDF is too large (max 10MB).' }, { status: 400 })

      // Preferred: rasterize the first pages and send them as vision images
      // (catches text baked into images). If rendering fails for any reason,
      // fall back to sending the raw PDF as a document (the prior behavior).
      let content: unknown[]
      try {
        const images = await pdfToImages(pdfBuffer)
        content = [
          ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
          { type: 'text', text: 'These are page images of a catering menu. Extract the menu items.' },
        ]
        console.log(`[menu-upload] ${safeName}: sent ${images.length} rendered page image(s) to Claude.`)
      } catch (err) {
        console.warn('[menu-upload] PDF→image render failed, using raw document mode:', err instanceof Error ? err.message : err)
        content = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
          { type: 'text', text: 'Extract the catering menu items from this menu.' },
        ]
      }
      const text = await runAnthropic(apiKey, content)
      parsed = extractResult(text)
    } else {
      if (!url) return NextResponse.json({ error: 'A menu URL is required.' }, { status: 400 })
      const fetchUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS)
      let html = ''
      try {
        const pageRes = await fetch(fetchUrl, {
          headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
          redirect: 'follow',
          signal: controller.signal,
        })
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`)
        html = await pageRes.text()
      } catch (err) {
        return fallback(`Could not fetch the menu URL: ${err instanceof Error ? err.message : 'unknown error'}`)
      } finally {
        clearTimeout(timer)
      }
      const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .slice(0, MAX_HTML_CHARS)
      const text = await runAnthropic(apiKey, [{ type: 'text', text: `Menu page from ${fetchUrl}:\n\n${cleaned}` }])
      parsed = extractResult(text)
    }
  } catch (err) {
    return fallback(`Parsing failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  // 2) Decide confidence. Trust HIGH only when we actually have ≥3 named items —
  //    independent of the model's self-report. Price is optional (many public
  //    menus omit prices), so it does NOT factor into the threshold.
  const items = parsed?.items ?? []
  const namedItems = items.filter(i => i.name)
  const isHigh = parsed?.confidence === 'high' && namedItems.length >= 3

  if (!isHigh) return fallback(`Low confidence (${namedItems.length} named item(s) found).`)

  // 3) HIGH confidence → create FM meal packages if the restaurant exists yet.
  //    If there's no ref yet (Stripe Connect blocker) or some creates fail, send
  //    the parsed menu to the concierge so it still gets set up — the restaurant
  //    never sees any of this; they get the success preview either way.
  let needsConcierge = false
  let conciergeReason = ''
  if (restaurantReference) {
    const summary = await createMealPackages(restaurantReference, items)
    console.log(`[menu-upload] FM meal packages for ${restaurantReference}: ${summary.created} created, ${summary.failed} failed.`)
    if (summary.failed > 0) { needsConcierge = true; conciergeReason = `${summary.created} of ${items.length} packages created in FM; ${summary.failed} failed.` }
  } else {
    needsConcierge = true
    conciergeReason = 'Restaurant not yet created in FM (Stripe Connect pending) — packages could not be created automatically.'
    console.log(`[menu-upload] ${safeName} parsed ${items.length} items but no restaurant ref yet — emailing concierge.`)
  }

  if (needsConcierge) {
    const itemLines = items.map(i => `  · ${i.name}${i.price > 0 ? ` — $${i.price.toFixed(2)}` : ''}${i.serves ? ` (serves ${i.serves})` : ''}${i.category ? ` [${i.category}]` : ''}`).join('\n')
    await notifyConcierge(
      `Menu Upload — ${safeName}`,
      `Our AI parsed this restaurant's menu during onboarding, but some/all items still need to be set up in FM.\n\nRestaurant: ${safeName}\nEmail: ${restaurantEmail || 'Not provided'}\nRestaurant ref: ${restaurantReference || 'Not yet created'}\n\nReason: ${conciergeReason}\n\nParsed items (${items.length}):\n${itemLines}\n\nMenu Import tool: https://www.discocater.com/admin/manage-restaurants/menu-import`,
    )
  }

  return NextResponse.json({ confidence: 'high', items })
}
