import { redirect } from 'next/navigation'

// /portal was the legacy diner shell with its own top tabs + sidebar. The
// unified diner experience now lives at /account/* with a single left
// sidebar — redirect there permanently so old links keep working.
export default function PortalIndex() {
  redirect('/account/orders')
}
