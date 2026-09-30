'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

// Map a Disco-native session/login payload to the restaurant_user shape the
// portal layout reads (name display + role-driven nav). The role comes from
// Neon (disco_restaurant_accounts.role): ADMIN → single-location nav,
// SYSTEM_ADMIN → all-locations nav.
function storeDiscoUser(d: { email?: string; firstName?: string | null; lastName?: string | null; restaurantReference?: string; restaurantName?: string | null; role?: string | null; businessName?: string | null }) {
  try {
    localStorage.setItem('restaurant_user', JSON.stringify({
      email: d.email || '', firstName: d.firstName || '', lastName: d.lastName || '',
      role: d.role || 'ADMIN', reference: d.restaurantReference || '',
      businessName: d.restaurantName || '', groupName: d.businessName || undefined,
    }))
  } catch { /* localStorage unavailable */ }
}

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

/**
 * Set a Disco Cater password, shown only after FamilyMeal has ALREADY verified
 * the password the person just typed.
 *
 * ── WHY THE WORDING IS LIKE THIS ───────────────────────────────────────────
 * A page that asks for a new password unprompted is indistinguishable from a
 * phishing prompt, so this one is built to be checkable by the person reading
 * it: it appears only after a correct password on a page they navigated to
 * themselves, it names their restaurant back to them, it explains the cause and
 * the consequence in plain terms, there is no link to click and nothing to
 * download, and it does not manufacture urgency. It also says explicitly that
 * their FamilyMeal password still works on FamilyMeal, because the single most
 * likely worry is that this is taking something away.
 */
function SetDiscoPassword({ setup, onDone }: {
  setup: { token: string; email: string; firstName: string | null; restaurantName: string | null }
  onDone: (user: Record<string, unknown>) => void | Promise<void>
}) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    if (pw.length < 8) { setErr('Please choose a password of at least 8 characters.'); return }
    if (pw !== pw2) { setErr('The two passwords do not match.'); return }
    setBusy(true)
    try {
      // The existing accept-invite endpoint: it consumes the one-time token,
      // writes the password through acceptInvite, and signs the person in.
      const res = await fetch('/api/restaurant/accept-invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ token: setup.token, password: pw }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d.error || 'Could not set your password. Please try logging in again.'); return }
      await onDone(d)
    } catch {
      setErr('Unable to connect. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }
  const input: React.CSSProperties = { width: '100%', padding: '11px 13px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }

  return (
    <div style={{ background: '#fff', borderRadius: 16, padding: '32px 28px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 10, marginTop: 0 }}>
        Choose a Disco Cater password
      </h1>
      <p style={{ fontSize: 13.5, color: '#555', lineHeight: 1.6, marginTop: 0, marginBottom: 10 }}>
        That password was correct{setup.restaurantName ? <> — thanks, {setup.firstName || 'and welcome back'}.</> : '.'}{' '}
        {setup.restaurantName
          ? <><strong>{setup.restaurantName}</strong> now takes its orders through Disco Cater directly, so the portal keeps its own password from here on.</>
          : <>Your restaurant now takes its orders through Disco Cater directly, so the portal keeps its own password from here on.</>}
      </p>
      <p style={{ fontSize: 13, color: '#777', lineHeight: 1.6, marginTop: 0, marginBottom: 20 }}>
        Your FamilyMeal password is unchanged and still works on FamilyMeal. This only sets the one you will use here.
        You will be signed in as soon as you have chosen it.
      </p>

      {err && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#DC2626', fontWeight: 500 }}>
          {err}
        </div>
      )}

      <form onSubmit={submit}>
        <div style={{ marginBottom: 6, fontSize: 12.5, color: '#888' }}>Signing in as {setup.email}</div>
        <div style={{ marginBottom: 14 }}>
          <label style={label}>New password</label>
          <input style={input} type="password" autoComplete="new-password" value={pw}
            onChange={e => setPw(e.target.value)} placeholder="At least 8 characters" />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={label}>Confirm password</label>
          <input style={input} type="password" autoComplete="new-password" value={pw2}
            onChange={e => setPw2(e.target.value)} />
        </div>
        <button type="submit" disabled={busy} style={{
          width: '100%', padding: '12px 0', border: 'none', borderRadius: 8, background: GRAD,
          color: '#fff', fontSize: 14.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1,
        }}>
          {busy ? 'Setting your password…' : 'Set password and continue'}
        </button>
      </form>
    </div>
  )
}

export default function RestaurantLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // Set only when the server says this person needs a Disco password. The FM
  // fallback below is untouched and still runs for everyone else.
  const [setup, setSetup] = useState<{ token: string; email: string; firstName: string | null; restaurantName: string | null } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Already signed in with a Disco-native session? Skip the form.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // 5s timeout so a slow FM/Neon session check can't hang the login page.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      try {
        const res = await fetch('/api/disco-restaurant-auth/me', { credentials: 'include', signal: ctrl.signal })
        if (!res.ok || cancelled) return
        const s = await res.json()
        storeDiscoUser(s)
        // Route to the right surface by role (regular users → orders, not the
        // dashboard) so there's no flash on an already-signed-in revisit.
        await navigateByRole(s.role || '')
      } catch { /* not logged in / timed out — show the form */ } finally { clearTimeout(timer) }
    })()
    return () => { cancelled = true }
  }, [router])

  // Post-login routing by role — shared by the Disco-native and FM login paths:
  //   SUPER_ADMIN  → /restaurant/dashboard (Reporting; all locations via the
  //                  top-right dropdown, no picker required)
  //   SYSTEM_ADMIN → /restaurant/manage/locations (so they can click into a
  //                  location to operate it). With exactly one location we
  //                  auto-pick + land on the dashboard.
  //   ADMIN / RESTAURANT_USER → /restaurant/orders (their daily surface)
  // Regular users go straight to /restaurant/orders — never via the dashboard,
  // so there's no dashboard flash before the redirect.
  async function navigateByRole(role: string) {
    if (role === 'SUPER_ADMIN') {
      router.push('/restaurant/dashboard')
      return
    }
    if (role === 'SYSTEM_ADMIN') {
      try {
        // Non-blocking probe: never let a slow/hung locations call trap the user
        // on "Signing in…". On timeout/failure we fall through to the Locations
        // page where they can pick a location.
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8000)
        const locRes = await fetch('/api/restaurant/locations?size=1000', { credentials: 'include', signal: ctrl.signal })
        clearTimeout(timer)
        if (locRes.ok) {
          const locData = await locRes.json()
          const list: { reference: string; businessName: string }[] = locData.content || []
          if (list.length === 1) {
            const only = list[0]
            await fetch(`/api/restaurant/selected-restaurant?restaurantReference=${only.reference}`, {
              method: 'PUT', credentials: 'include',
            })
            try {
              localStorage.setItem('selectedRestaurant', only.reference)
              localStorage.setItem('selectedRestaurantName', only.businessName)
            } catch {}
            router.push('/restaurant/dashboard')
            return
          }
        }
      } catch {
        // If the locations fetch failed, fall through to the Locations
        // management page — the user can pick from there.
      }
      router.push('/restaurant/manage/locations')
      return
    }
    // ADMIN / RESTAURANT_USER / RESTAURANT_ADMIN
    router.push('/restaurant/orders')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      // Try Disco-native auth first; fall back to FM for legacy restaurant users.
      try {
        const dres = await fetch('/api/disco-restaurant-auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include', body: JSON.stringify({ email, password }),
        })
        if (dres.ok) {
          const d = await dres.json()
          // ── SET A DISCO PASSWORD, THEN CONTINUE ────────────────────────────
          // The server verified this password against FamilyMeal and found the
          // person's restaurants are all on Disco now. It returned a one-time
          // token and NO session — nothing is signed in until the password is
          // actually set below.
          if (d.needsPasswordSetup) {
            setSetup({ token: d.setupToken, email: d.email, firstName: d.firstName, restaurantName: d.restaurantName })
            return
          }
          storeDiscoUser(d)
          await navigateByRole(d.role || '')
          return
        }
      } catch { /* fall through to FM login */ }

      const res = await fetch('/api/restaurant-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Login failed. Please check your credentials.')
        return
      }
      localStorage.setItem('restaurant_user', JSON.stringify(data))
      await navigateByRole(data.role || '')
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .r-input { width: 100%; padding: 11px 14px; border: 1.5px solid #e0e0e0; border-radius: 9px; font-size: 14px; font-family: ${F}; color: ${DARK}; outline: none; background: #fff; transition: border-color 0.15s; }
        .r-input:focus { border-color: ${INDIGO}; box-shadow: 0 0 0 3px rgba(107,110,249,0.12); }
        .r-btn { width: 100%; padding: 12px; background: ${INDIGO}; color: #fff; border: none; border-radius: 9px; font-size: 14px; font-weight: 700; font-family: ${F}; cursor: pointer; transition: opacity 0.15s; }
        .r-btn:hover:not(:disabled) { opacity: 0.9; }
        .r-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F8FC', fontFamily: F, padding: '24px 16px', position: 'relative' }}>
        {/* Back to the restaurant landing page */}
        <Link href="/for-restaurants" style={{
          position: 'absolute', top: 20, left: 20, display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 13, color: '#888', textDecoration: 'none', fontWeight: 600,
        }}>
          <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>←</span> Back
        </Link>
        <div style={{ width: '100%', maxWidth: 420 }}>
          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <span style={{ fontSize: 22, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: '#999' }}> cater</span>
            <div style={{ fontSize: 12, color: '#aaa', marginTop: 4, fontWeight: 500, letterSpacing: '0.04em' }}>Restaurant Portal</div>
          </div>

          {setup ? (
            <SetDiscoPassword
              setup={setup}
              onDone={async (user) => { storeDiscoUser(user); await navigateByRole((user.role as string) || '') }}
            />
          ) : (
          <div style={{ background: '#fff', borderRadius: 16, padding: '32px 28px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 6, marginTop: 0 }}>
              Log in to Restaurant Portal
            </h1>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 24, marginTop: 0 }}>
              Use your Disco Cater restaurant account credentials.
            </p>

            {error && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginBottom: 18, fontSize: 13, color: '#DC2626', fontWeight: 500 }}>
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
                  Email address
                </label>
                <input
                  className="r-input"
                  type="email"
                  name="restaurant-login-email"
                  id="restaurant-login-email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@restaurant.com"
                  required
                  autoComplete="username"
                />
              </div>
              <div style={{ marginBottom: 24 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
                  Password
                </label>
                <input
                  className="r-input"
                  type="password"
                  name="restaurant-login-password"
                  id="restaurant-login-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                />
                <div style={{ textAlign: 'right', marginTop: 8 }}>
                  <Link href="/restaurant/forgot-password" style={{ fontSize: 12, color: INDIGO, fontWeight: 600, textDecoration: 'none' }}>
                    Forgot password?
                  </Link>
                </div>
              </div>
              <button type="submit" className="r-btn" disabled={loading}>
                {loading ? 'Logging in…' : 'Log In'}
              </button>
            </form>
          </div>
          )}
        </div>
      </div>
    </>
  )
}
