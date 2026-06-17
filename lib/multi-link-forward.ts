import { NextRequest } from 'next/server'
import { getRestaurantUserRef } from './restaurant-auth'

// Shared by the multi-unit-links POST/PUT and the dashboard-group PUT proxies.
// Reads the incoming request (multipart or legacy JSON), injects the trusted
// `userReference` (from the JWT — the httpOnly cookie can't be read client-side)
// into the JSON `request` part, and returns a FormData ready to forward to FM
// as multipart/form-data (request JSON part + optional image file part).
//
// Also returns the parsed `request` JSON so callers can mirror the link into
// Neon (slug/title/locations) without re-reading the already-consumed body.
export async function buildForwardForm(req: NextRequest): Promise<{ form: FormData; request: Record<string, unknown> }> {
  const userReference = await getRestaurantUserRef()
  const ct = req.headers.get('content-type') || ''
  const out = new FormData()
  let json: Record<string, unknown> = {}
  if (ct.startsWith('multipart/form-data')) {
    const incoming = await req.formData()
    const reqPart = incoming.get('request')
    if (typeof reqPart === 'string') json = JSON.parse(reqPart)
    else if (reqPart) json = JSON.parse(await (reqPart as Blob).text())
    if (userReference) json.userReference = userReference
    out.append('request', new Blob([JSON.stringify(json)], { type: 'application/json' }))
    const img = incoming.get('image')
    if (img && img instanceof Blob && (img as File).size > 0) out.append('image', img)
  } else {
    json = await req.json()
    if (userReference) json.userReference = userReference
    out.append('request', new Blob([JSON.stringify(json)], { type: 'application/json' }))
  }
  return { form: out, request: json }
}
