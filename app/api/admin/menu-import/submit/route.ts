import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

interface ImportPackage {
  name: string
  description?: string
  price: number
  serves: number
  itemType: string
}

export async function POST(req: NextRequest) {
  // 1 + 2. Auth gate and grab the SUPER_ADMIN JWT. getAdminAuthHeader() returns
  // { Authorization: <raw JWT> } — NO "Bearer" prefix, which FM requires.
  let auth: Record<string, string>
  try { auth = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let restaurantReference = ''
  let packages: ImportPackage[] = []
  try {
    const body = await req.json()
    restaurantReference = String(body?.restaurantReference || '').trim()
    packages = Array.isArray(body?.packages) ? body.packages : []
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  if (!restaurantReference) {
    return NextResponse.json({ error: 'Restaurant Reference is required.' }, { status: 400 })
  }
  if (!packages.length) {
    return NextResponse.json({ error: 'No packages to import.' }, { status: 400 })
  }

  // 3 + 4. Create each meal package on FM independently — one failure must not
  // abort the rest. Run sequentially to avoid hammering FM.
  const results: { name: string; success: boolean; error?: string }[] = []
  for (const p of packages) {
    const name = String(p?.name ?? '').trim()
    if (!name) { results.push({ name: '(unnamed)', success: false, error: 'Missing name.' }); continue }
    try {
      const res = await fetch(`${FM}/api/mealPackages`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name,
          description: String(p?.description ?? ''),
          price: Number(p?.price) || 0,
          serves: Number(p?.serves) || 0,
          itemType: p?.itemType === 'REGULAR' ? 'REGULAR' : 'CATERING',
          restaurantReference,
        }),
      })
      if (res.ok) {
        results.push({ name, success: true })
      } else {
        const raw = await res.text().catch(() => '')
        let msg = `FM error ${res.status}`
        try { const j = JSON.parse(raw); msg = j?.message || j?.description || j?.error || msg } catch { if (raw) msg = raw.slice(0, 200) }
        results.push({ name, success: false, error: msg })
      }
    } catch {
      results.push({ name, success: false, error: 'Network error reaching FamilyMeal.' })
    }
  }

  // 5.
  return NextResponse.json({ results })
}
