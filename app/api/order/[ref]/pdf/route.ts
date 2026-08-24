import { NextRequest, NextResponse } from 'next/server'
import { buildOrderPdfWithNamingByReference } from '../../../../../lib/order/order-pdf'
import { orderPdfFilename, contentDisposition } from '../../../../../lib/download-filename'

export const runtime = 'nodejs'

// Order PDF — the downloadable order sheet linked in the restaurant SMS and used
// as the email attachment source. Gated by the order's opaque UUID reference
// (unguessable), matching how order-confirmation links are shared. `?dl=1`
// forces a download; default renders inline in the browser.
//
// The filename is [Restaurant-Name]-[order-number].pdf, built by the shared
// helper in lib/download-filename.ts — the same helper that names the email
// attachment, so a restaurant saving from the browser and saving from its
// confirmation email gets the same file name. This used to be
// "disco-cater-order-<first 8 chars of the ref>.pdf", which named the file
// after an opaque fragment of a UUID that means nothing to anyone reading a
// downloads folder. Disposition is unchanged (inline by default) so the
// in-browser PDF viewer behaviour is preserved; the filename is what the
// viewer's own Save uses.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid order reference' }, { status: 400 })
  try {
    const built = await buildOrderPdfWithNamingByReference(ref)
    if (!built) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    const dl = req.nextUrl.searchParams.get('dl') === '1'
    const filename = orderPdfFilename(built.restaurantName, built.orderNumber, built.reference || ref)
    return new NextResponse(Buffer.from(built.pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition(dl ? 'attachment' : 'inline', filename),
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (e) {
    console.error('[order/pdf] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to generate PDF' }, { status: 500 })
  }
}
