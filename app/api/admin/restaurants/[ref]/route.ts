import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Deep-merge `patch` onto `base`: nested objects merge recursively; arrays and
// primitives replace; `undefined` patch values are ignored (keep base). Used to
// build the full FM restaurant object from only the fields a caller changed.
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const baseObj = (base && typeof base === 'object' && !Array.isArray(base)) ? (base as Record<string, unknown>) : {}
  const out: Record<string, unknown> = { ...baseObj }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    out[k] = deepMerge(baseObj[k], v)
  }
  return out
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch restaurant' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : null)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch restaurant' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to delete restaurant' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to delete restaurant' }, { status: 500 })
  }
}

// GET → merge → PUT. Callers send ONLY the fields they changed; we read the
// current FM object, deep-merge the changes onto it, and PUT the complete object
// back. A partial PUT to FM resets omitted fields (restaurantStatus, blocked,
// online-ordering flags) — this guarantees those are always preserved unless the
// caller explicitly changes them.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    // Parse the caller's changes (JSON, or a multipart `restaurant` JSON part).
    let incoming: Record<string, unknown>
    const ct = req.headers.get('content-type') || ''
    if (ct.startsWith('multipart/form-data')) {
      const fd = await req.formData()
      const part = fd.get('restaurant')
      const txt = typeof part === 'string' ? part : (part instanceof Blob ? await part.text() : '{}')
      incoming = JSON.parse(txt || '{}')
    } else {
      incoming = await req.json()
    }

    // 1) GET the current full FM restaurant object.
    const getRes = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: h })
    if (!getRes.ok) {
      return NextResponse.json({ error: 'Failed to load restaurant before save' }, { status: getRes.status })
    }
    const current = (await getRes.json().catch(() => ({}))) as Record<string, unknown>

    // Flag any online-ordering change away from ACCEPTED so it's easy to catch.
    if (incoming.restaurantStatus !== undefined && incoming.restaurantStatus !== 'ACCEPTED') {
      console.warn('[admin/restaurants PUT] restaurantStatus changing to non-ACCEPTED', {
        ref, from: current.restaurantStatus, to: incoming.restaurantStatus,
      })
    }

    // 2) Merge only the changed fields onto the current object.
    const merged = deepMerge(current, incoming)

    // 3) PUT the complete merged object back to FM.
    const fd = new FormData()
    fd.append('restaurant', new Blob([JSON.stringify(merged)], { type: 'application/json' }))
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { method: 'PUT', headers: h, body: fd })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to update restaurant', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (e) {
    console.error('[admin/restaurants PUT] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update restaurant' }, { status: 500 })
  }
}
