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

// The legacy `disco_user` localStorage shadow (written by the homepage
// LoginModal/useAuth and read by FavoriteHeart). We hydrate the header from it
// optimistically and keep it in sync here so BOTH auth systems agree — that's
// what makes the logged-in avatar show on the restaurant pages immediately,
// instead of waiting on (or missing) the async cookie check.
const DISCO_USER_KEY = 'disco_user'

function readLocalUser(): AuthUser | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(DISCO_USER_KEY)
    if (!raw) return null
    const u = JSON.parse(raw)
    if (!u || (!u.reference && !u.email)) return null
    return {
      reference: u.reference || '', email: u.email || '',
      firstName: u.firstName || '', lastName: u.lastName || '',
      phoneNumber: u.phoneNumber || '', role: u.role || '',
    }
  } catch { return null }
}

function writeLocalUser(u: AuthUser) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISCO_USER_KEY, JSON.stringify({
      reference: u.reference, email: u.email, firstName: u.firstName,
      lastName: u.lastName, phoneNumber: u.phoneNumber, role: u.role,
    }))
  } catch {}
}

function clearLocalUser() {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(DISCO_USER_KEY) } catch {}
}

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
      // FM rejected the token — force a refresh regardless of our local exp guess.
      const refreshRes = await fetch('/api/auth/refresh?force=1', { method: 'POST', credentials: 'include' })
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
    // Optimistic hydration from the legacy `disco_user` localStorage so the
    // header avatar shows immediately — including on the restaurant pages, where
    // a user who logged in elsewhere would otherwise see "Log In" until (or
    // unless) the async cookie check below resolves.
    const local = readLocalUser()
    if (local) { setUser(local); setIsLoading(false) }
    ;(async () => {
      // Proactive refresh-on-load: silently rotates the token if it's expired or
      // within 24h of expiry (no-op otherwise), so a returning visitor stays
      // logged in for the full 30-day window without any action.
      try { await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }) } catch {}
      const u = await fetchUser()
      if (u) {
        // Cookie is authoritative + fresh — adopt it and keep the localStorage
        // shadow in sync so the next load hydrates correctly.
        setUser(u)
        writeLocalUser(u)
      } else if (!local) {
        setUser(null)
      }
      // If the cookie check returns null but we already hydrated a local user,
      // keep showing the avatar: both login paths set the cookie, so this only
      // bridges a transient cookie read failure. An explicit logout clears
      // disco_user, so a genuinely logged-out user never lingers here.
      setIsLoading(false)
    })()
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
    writeLocalUser(u)
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
    const u: AuthUser = {
      reference: data.reference || '',
      email: data.email || regData.email,
      firstName: data.firstName || regData.firstName,
      lastName: data.lastName || regData.lastName,
      phoneNumber: data.phoneNumber || regData.phoneNumber || '',
      role: data.role || '',
    }
    setUser(u)
    writeLocalUser(u)
    try { window.dispatchEvent(new CustomEvent('disco-user-changed')) } catch {}
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/fm-auth', { method: 'DELETE', credentials: 'include' })
    } catch {}
    setUser(null)
    clearLocalUser()
    try { window.dispatchEvent(new CustomEvent('disco-user-changed')) } catch {}
  }, [])

  const refreshUser = useCallback(async () => {
    const u = await fetchUser()
    setUser(u)
    if (u) writeLocalUser(u); else clearLocalUser()
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
