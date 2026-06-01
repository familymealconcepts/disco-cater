import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// FM's saleStats endpoint parses dates in DD.MM.YYYY (DateFormatService.formatDate
// in the Angular client). The Order Counts tab sends YYYY-MM-DD (from <input
// type="date">), which FM can't parse → 400 → "Failed". Convert here.
function toFmDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d
}

export async function GET(req: NextRequest) {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { searchParams } = req.nextUrl
  const params = new URLSearchParams()
  searchParams.getAll('orderStatuses').forEach(s => params.append('orderStatuses', s))
  const fromDate = searchParams.get('fromDate')
  const toDate = searchParams.get('toDate')
  if (fromDate) params.set('fromDate', toFmDate(fromDate))
  if (toDate) params.set('toDate', toFmDate(toDate))

  const fmUrl = `${FM}/api/orders/saleStats?${params}`
  // DIAGNOSTIC (Vercel logs): exact URL + params sent to FM for Order Counts.
  console.log('[orders/sale-stats] → FM', JSON.stringify({ url: fmUrl, fromDate, toDate, params: params.toString() }))

  try {
    const res = await fetch(fmUrl, { headers: authHeaders })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.log('[orders/sale-stats] ← FM error', JSON.stringify({ status: res.status, body: body.slice(0, 500) }))
      return NextResponse.json({ error: 'Failed' }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('[orders/sale-stats] fetch threw', err)
    return NextResponse.json({ error: 'Unable to fetch' }, { status: 500 })
  }
}
