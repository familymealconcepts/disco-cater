'use client'
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

export interface AuthUser {
  reference: string
  email: string
  firstName: string
  lastName: string
  phoneNumber: string
  role: string
  companyName?: string
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
      companyName: u.companyName || '',
    }
  } catch { return null }
}

function writeLocalUser(u: AuthUser) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISCO_USER_KEY, JSON.stringify({
      reference: u.reference, email: u.email, firstName: u.firstName,
      lastName: u.lastName, phoneNumber: u.phoneNumber, role: u.role,
      companyName: u.companyName || '',
    }))
  } catch {}
}

function clearLocalUser() {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(DISCO_USER_KEY) } catch {}
}

/**
 * THREE OUTCOMES, NOT TWO. This returned `null` for both "the server says you
 * are signed out" and "the request did not complete", and the caller could not
 * tell them apart — so it treated every null as transient and kept the
 * optimistically-hydrated user. The comment there said as much: "this only
 * bridges a transient cookie read failure".
 *
 * An EXPIRED SESSION produces the identical null, and that assumption is what
 * stranded 116 of 338 customers signed-in on the client with no session on the
 * server: the avatar stayed, and every authenticated write 401'd. At checkout
 * that meant entering card details into a dead end — the customer read the
 * refusal as "not authorized" and tried a second card, which failed the same
 * way because Stripe was never reached.
 *
 *   'user'       the server returned an identity. Authoritative.
 *   'signed-out' a 401/403 that SURVIVED the forced refresh retry. Authoritative.
 *   'unknown'    the fetch threw, or the server answered something else (5xx).
 *                Not authoritative — the caller must change nothing.
 *
 * ONLY 'signed-out' MAY CLEAR A SESSION, and it is deliberately the narrowest of
 * the three. A thrown fetch is never signed-out, and neither is any status other
 * than 401/403 — that guard is the whole protection against signing every
 * customer out at once if /api/fm-user ever starts refusing incorrectly.
 */
type FetchUserResult =
  | { state: 'user'; user: AuthUser }
  | { state: 'signed-out' }
  | { state: 'unknown' }

async function fetchUser(): Promise<FetchUserResult> {
  try {
    const res = await fetch('/api/fm-user', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json()
      return { state: 'user', user: {
        reference: data.reference || '',
        email: data.email || '',
        firstName: data.firstName || '',
        lastName: data.lastName || '',
        phoneNumber: data.phoneNumber || '',
        role: data.role || '',
        companyName: data.companyName || '',
        address: data.address || '',
        deliveryInstructions: data.deliveryInstructions || '',
      } }
    }
    if (res.status === 401 || res.status === 403) {
      // FM rejected the token — force a refresh regardless of our local exp guess.
      const refreshRes = await fetch('/api/auth/refresh?force=1', { method: 'POST', credentials: 'include' })
      if (refreshRes.ok) {
        // Retry after refresh
        const retry = await fetch('/api/fm-user', { credentials: 'include' })
        if (retry.ok) {
          const data = await retry.json()
          return { state: 'user', user: {
            reference: data.reference || '',
            email: data.email || '',
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            phoneNumber: data.phoneNumber || '',
            role: data.role || '',
            companyName: data.companyName || '',
            address: data.address || '',
            deliveryInstructions: data.deliveryInstructions || '',
          } }
        }
      }
      // A 401/403 that survived the forced refresh. The server has had two
      // chances to find a session and has none — the only authoritative
      // signed-out signal there is.
      return { state: 'signed-out' }
    }
    // Any other status (5xx, a gateway, an unexpected redirect) says nothing
    // about this customer's session. Change nothing.
    return { state: 'unknown' }
  } catch {
    // The request did not complete. Never signed-out.
    return { state: 'unknown' }
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
      const r = await fetchUser()
      if (r.state === 'user') {
        // Cookie is authoritative + fresh — adopt it and keep the localStorage
        // shadow in sync so the next load hydrates correctly.
        setUser(r.user)
        writeLocalUser(r.user)
      } else if (r.state === 'signed-out') {
        // AUTHORITATIVE: a 401/403 that survived the forced refresh. The stale
        // localStorage shadow is what kept these customers looking signed in
        // while every authenticated write failed, so it is cleared here — this
        // is the only place that can reach it, since nothing server-side can
        // touch another browser's storage.
        clearLocalUser()
        setUser(null)
      } else if (!local) {
        // UNKNOWN — the fetch threw or the server answered something that says
        // nothing about this session. Unchanged behaviour: an optimistically
        // hydrated user is kept, so a network blip never signs anyone out.
        setUser(null)
      }
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
    const r = await fetchUser()
    if (r.state === 'user') { setUser(r.user); writeLocalUser(r.user) }
    else if (r.state === 'signed-out') { setUser(null); clearLocalUser() }
    // 'unknown' leaves the current user alone — a failed refresh is not a logout.
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
