// ── WHICH FAMILYMEAL-PASSWORD SESSIONS MAY USE THE RESTAURANT PORTAL (11 Nov 2026) ──
//
// Peter's rule: a restaurant user who signs in with their FamilyMeal password must
// set a Disco Cater password before ANY part of the portal works, and after that
// only the Disco password signs them in. The team's master-password login keeps
// working exactly as before.
//
// The decision is made once, at sign-in, in app/api/restaurant-auth (the only route
// that issues an fm_restaurant_token). A sign-in that is ALLOWED to hold an FM
// session — the team's master password, a FamilyMeal SUPER_ADMIN (the team), or a
// user whose restaurants still run on FamilyMeal — is issued this signed clearance
// cookie beside the FM token. A sign-in that must move to a Disco password gets no
// FM session at all.
//
// middleware.ts (edge, no Neon) refuses any fm_restaurant_token that arrives
// WITHOUT a valid clearance for the same email: pages redirect to the login page,
// /api/restaurant/* answers 403. That is what shuts every FM session issued before
// this rule (they carry no clearance) and any FM token obtained by calling
// FamilyMeal directly. lib/fm-portal-gate.ts repeats the check server-side.
//
// WHY A SIGNED COOKIE, NOT A FLAG IN THE TOKEN: the FM JWT is FamilyMeal's and a
// master-password FM token is indistinguishable from the account holder's own.
// The only moment Disco knows which password was typed is the sign-in request, so
// that is where the fact is recorded — HMAC-signed with a server-only secret so it
// cannot be forged or moved to another email.
//
// Edge-safe: Web Crypto only, no Node imports.

export const FM_PORTAL_CLEARANCE_COOKIE = 'fm_portal_clearance'

export type ClearanceKind =
  /** The team's master password (audited as MASTER_PASSWORD_LOGIN). Never re-checked. */
  | 'master'
  /** A FamilyMeal SUPER_ADMIN account — the team. Never re-checked. */
  | 'super-admin'
  /** A restaurant user whose restaurants still run on FamilyMeal. Re-checked server-side. */
  | 'fm-backed'

export interface Clearance { email: string; kind: ClearanceKind; exp: number }

const KINDS: ClearanceKind[] = ['master', 'super-admin', 'fm-backed']
const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
}

// Derived from MASTER_PASSWORD_HASH, a server-only secret already present wherever
// the portal runs (master login depends on it). Derived rather than used directly,
// so the signing key is never the stored hash itself. Missing secret = no key =
// every clearance invalid (fails closed).
async function key(): Promise<CryptoKey | null> {
  const secret = process.env.MASTER_PASSWORD_HASH
  if (!secret) return null
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const derived = new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode('fm-portal-clearance-v1')))
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export function normaliseEmail(e: unknown): string {
  return typeof e === 'string' ? e.trim().toLowerCase() : ''
}

/** The email an FM JWT names (sub / email / user_name), unverified — callers verify the token elsewhere. */
export function fmTokenEmail(token: string | null | undefined): string {
  if (!token) return ''
  try {
    const p = JSON.parse(b64urlDecode(token.split('.')[1] || '')) as Record<string, unknown>
    for (const c of [p.sub, p.email, p.user_name]) {
      if (typeof c === 'string' && c.includes('@')) return normaliseEmail(c)
    }
  } catch { /* undecodable */ }
  return ''
}

export async function signClearance(email: string, kind: ClearanceKind, maxAgeSec: number): Promise<string | null> {
  const k = await key()
  const e = normaliseEmail(email)
  if (!k || !e) return null
  const body = b64url(enc.encode(JSON.stringify({ e, k: kind, x: Math.floor(Date.now() / 1000) + maxAgeSec })))
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(body))))
  return `v1.${body}.${sig}`
}

/** The clearance, if the cookie is genuine, unexpired, and names `email`. Otherwise null. */
export async function verifyClearance(cookie: string | null | undefined, email: string): Promise<Clearance | null> {
  try {
    const want = normaliseEmail(email)
    if (!cookie || !want) return null
    const [v, body, sig] = cookie.split('.')
    if (v !== 'v1' || !body || !sig) return null
    const k = await key()
    if (!k) return null
    const sigBytes = Uint8Array.from(b64urlDecode(sig), c => c.charCodeAt(0))
    if (!(await crypto.subtle.verify('HMAC', k, sigBytes, enc.encode(body)))) return null
    const p = JSON.parse(b64urlDecode(body)) as { e?: string; k?: string; x?: number }
    if (normaliseEmail(p.e) !== want) return null
    if (!p.x || p.x * 1000 <= Date.now()) return null
    if (!KINDS.includes(p.k as ClearanceKind)) return null
    return { email: want, kind: p.k as ClearanceKind, exp: p.x }
  } catch {
    return null
  }
}

/** What the portal tells a refused FM session — one wording for pages and APIs. */
export const FM_SESSION_REFUSED = {
  error: 'Please sign in to the restaurant portal again. If your restaurant is on Disco Cater, you will be asked to set your Disco Cater password.',
  reason: 'disco-password-required',
} as const
