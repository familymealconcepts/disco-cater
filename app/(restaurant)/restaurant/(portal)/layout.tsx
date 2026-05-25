import { RestaurantProvider } from './context/RestaurantContext'
import RestaurantPortalClient from './RestaurantPortalClient'

export default function RestaurantPortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <RestaurantProvider>
      <RestaurantPortalClient>{children}</RestaurantPortalClient>
    </RestaurantProvider>
  )
}
