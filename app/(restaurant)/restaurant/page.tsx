import { redirect } from 'next/navigation'

// Bare /restaurant has no UI of its own — send users straight to their daily
// surface. This is a server component, so the redirect fires before any content
// is rendered (no dashboard flash).
export default function RestaurantIndex() {
  redirect('/restaurant/orders')
}
