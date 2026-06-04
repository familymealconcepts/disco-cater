import EditOrderClient from './EditOrderClient'

// Thin server wrapper — no server-side data fetching or auth redirects (those
// were navigating away before the details call could run). All loading now
// happens client-side in EditOrderClient so it's visible in the Network tab.
export default async function EditOrderPage({ params }: { params: Promise<{ orderRef: string }> }) {
  const { orderRef } = await params
  return <EditOrderClient orderRef={orderRef} />
}
