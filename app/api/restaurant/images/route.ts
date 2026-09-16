import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'
import { refuseIfNativeMenuSurface } from '../../../../lib/fm-menu-surface-guard'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  {
    // FM MENU SURFACE — REFUSED FOR A DISCO-NATIVE RESTAURANT. See
    // lib/fm-menu-surface-guard.ts. Keyed on the SELECTED RESTAURANT, never the
    // session: the master password issues an FM session, so a session-based check
    // sent our own team to FamilyMeal's menu screens for native restaurants.
    const guard = await refuseIfNativeMenuSurface(await getRestaurantRef())
    if (guard) return guard
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const formData = await req.formData()
    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const upstream = new FormData()
    upstream.append('file', file)

    const res = await fetch(`${FM}/public-api/images`, {
      method: 'POST',
      headers: h,
      body: upstream,
    })
    if (!res.ok) return NextResponse.json({ error: 'Upload failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to upload image' }, { status: 500 }) }
}
