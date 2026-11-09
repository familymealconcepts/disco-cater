import type { Metadata } from 'next'
import ConfirmationClient from './ConfirmationClient'

// One customer's order: never a page for search.
export const metadata: Metadata = { robots: { index: false, follow: false } }

export default async function OrderConfirmationPage({
  params,
}: {
  params: Promise<{ orderRef: string }>
}) {
  const { orderRef } = await params
  return <ConfirmationClient orderRef={orderRef} />
}
