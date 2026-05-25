'use client'
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

export interface RestaurantProfile {
  name?: string
  businessName?: string
  firstName?: string
  lastName?: string
  email?: string
  phoneNumber?: string
  reference?: string
  address?: string
  description?: string
  website?: string
  cuisineType?: string
  image?: string
}

interface RestaurantContextType {
  profile: RestaurantProfile | null
  isLoading: boolean
  refreshProfile: () => void
}

const RestaurantContext = createContext<RestaurantContextType | null>(null)

export function RestaurantProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<RestaurantProfile | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const refreshProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/profile', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setProfile(data)
      }
    } catch {
      // Profile fetch failed — portal still usable
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { refreshProfile() }, [refreshProfile])

  return (
    <RestaurantContext.Provider value={{ profile, isLoading, refreshProfile }}>
      {children}
    </RestaurantContext.Provider>
  )
}

export function useRestaurant() {
  const ctx = useContext(RestaurantContext)
  if (!ctx) throw new Error('useRestaurant must be used inside RestaurantProvider')
  return ctx
}
