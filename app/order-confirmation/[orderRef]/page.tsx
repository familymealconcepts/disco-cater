import ConfirmationClient from './ConfirmationClient'

export default async function OrderConfirmationPage({
  params,
}: {
  params: Promise<{ orderRef: string }>
}) {
  const { orderRef } = await params
  return <ConfirmationClient orderRef={orderRef} />
}
