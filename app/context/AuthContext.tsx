'use client'
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

export interface AuthUser {
  reference: string
  email: string
  firstName: string
  lastName: string
  phoneNumber: string
  role: string
  address?: string
  deliveryInstructions?: string
}

interface AuthContextType {
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<AuthUser>
  register: (data: { email: string; password: string; firstName: string; lastName: string; phoneNumber?: string }) => Promise<void>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
  openAuthModal: (pendingAction?: () => void, defaultTab?: 'login' | 'signup') => void
  closeAuthModal: () => void
  authModalOpen: boolean
  authModalDefaultTab: 'login' | 'signup'
  pendingAction: (() => void) | null
  setPendingAction: (action: (() => void) | null) => void
}

const AuthContext = createContext<AuthContextType | null>(null)

async function fetchUser(): Promise<AuthUser | null> {
  try {
    const res = await fetch('/api/fm-user', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json()
      return {
        reference: data.reference || '',
        email: data.email || '',
        firstName: data.firstName || '',
        lastName: data.lastName || '',
        phoneNumber: data.phoneNumber || '',
        role: data.role || '',
        address: data.address || '',
        deliveryInstructions: data.deliveryInstructions || '',
      }
    }
    if (res.status === 401) {
      // Try refresh
      const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (refreshRes.ok) {
        // Retry after refresh
        const retry = await fetch('/api/fm-user', { credentials: 'include' })
        if (retry.ok) {
          const data = await retry.json()
          return {
            reference: data.reference || '',
            email: data.email || '',
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            phoneNumber: data.phoneNumber || '',
            role: data.role || '',
            address: data.address || '',
            deliveryInstructions: data.deliveryInstructions || '',
          }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [authModalDefaultTab, setAuthModalDefaultTab] = useState<'login' | 'signup'>('login')
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  useEffect(() => {
    fetchUser().then(u => {
      setUser(u)
      setIsLoading(false)
    })
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/api/fm-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Login failed')
    const u: AuthUser = {
      reference: data.reference || '',
      email: data.email || email,
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      phoneNumber: data.phoneNumber || '',
      role: data.role || '',
    }
    setUser(u)
    try { window.dispatchEvent(new CustomEvent('disco-user-changed')) } catch {}
    return u
  }, [])

  const register = useCallback(async (regData: { email: string; password: string; firstName: string; lastName: string; phoneNumber?: string }) => {
    const res = await fetch('/api/fm-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', ...regData }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')
    setUser({
      reference: data.reference || '',
      email: data.email || regData.email,
      firstName: data.firstName || regData.firstName,
      lastName: data.lastName || regData.lastName,
      phoneNumber: data.phoneNumber || regData.phoneNumber || '',
      role: data.role || '',
    })
    try { window.dispatchEvent(new CustomEvent('disco-user-changed')) } catch {}
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/fm-auth', { method: 'DELETE', credentials: 'include' })
    } catch {}
    setUser(null)
    try { window.dispatchEvent(new CustomEvent('disco-user-changed')) } catch {}
  }, [])

  const refreshUser = useCallback(async () => {
    const u = await fetchUser()
    setUser(u)
  }, [])

  const openAuthModal = useCallback((action?: () => void, defaultTab: 'login' | 'signup' = 'login') => {
    setPendingAction(() => action || null)
    setAuthModalDefaultTab(defaultTab)
    setAuthModalOpen(true)
  }, [])

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false)
  }, [])

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated: !!user,
      isLoading,
      login,
      register,
      logout,
      refreshUser,
      openAuthModal,
      closeAuthModal,
      authModalOpen,
      authModalDefaultTab,
      pendingAction,
      setPendingAction,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthContext(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuthContext must be used within AuthProvider')
  return ctx
}
