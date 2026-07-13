import { NextRequest, NextResponse } from 'next/server'
import { buildOrderPdfByReference } from '../../../../../lib/order/order-pdf'

export const runtime = 'nodejs'

// Order PDF — the downloadable order sheet linked in the restaurant SMS and used
// as the email attachment source. Gated by the order's opaque UUID reference
// (unguessable), matching how order-confirmation links are shared. `?dl=1`
// forces a download; default renders inline in the browser.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid order reference' }, { status: 400 })
  try {
    const pdf = await buildOrderPdfByReference(ref)
    if (!pdf) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    const dl = req.nextUrl.searchParams.get('dl') === '1'
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename="disco-cater-order-${ref.slice(0, 8)}.pdf"`,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (e) {
    console.error('[order/pdf] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to generate PDF' }, { status: 500 })
  }
}
