'use client'
import { useState, useEffect, useCallback } from 'react'

export interface DiscoUser {
  email: string
  firstName: string
  lastName: string
  reference: string
  token: string
  refreshToken: string
}

const STORAGE_KEY = 'disco_user'

export function useAuth() {
  const [user, setUser] = useState<DiscoUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) setUser(JSON.parse(stored))
    } catch {}
    setLoading(false)
  }, [])

  const login = useCallback((userData: DiscoUser) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userData))
    setUser(userData)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setUser(null)
  }, [])

  const initials = user
    ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()
    : ''

  return { user, loading, login, logout, initials }
}
