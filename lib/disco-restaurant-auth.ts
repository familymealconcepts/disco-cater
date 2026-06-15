import { sql } from './db'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'

export interface DiscoRestaurantSession {
  restaurantReference: string
  email: string
  firstName: string | null
  lastName: string | null
  restaurantName: string | null
}

// httpOnly session cookie shared by the disco-restaurant-auth routes. secure is
// gated on NODE_ENV (mirrors the FM restaurant cookie) so local http dev works.
export const DISCO_RESTAURANT_COOKIE = 'disco_restaurant_token'
export const DISCO_RESTAURANT_SESSION_MAX_AGE = 30 * 24 * 60 * 60 // seconds (30 days)
export const DISCO_RESTAURANT_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: DISCO_RESTAURANT_SESSION_MAX_AGE,
}

// Hash a password
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

// Verify a password
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

// Create a session token (30 day expiry)
export async function createDiscoRestaurantSession(restaurantReference: string, email: string): Promise<string> {
  console.log('[disco-session] creating session for:', email)
  const token = randomUUID()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await sql`
    INSERT INTO disco_restaurant_sessions (token, restaurant_reference, email, expires_at)
    VALUES (${token}, ${restaurantReference}, ${email}, ${expiresAt.toISOString()})
  `
  return token
}

// Validate a session token — returns session data or null
export async function validateDiscoRestaurantSession(token: string): Promise<DiscoRestaurantSession | null> {
  const rows = (await sql`
    SELECT s.restaurant_reference, s.email, a.first_name, a.last_name, a.restaurant_name
    FROM disco_restaurant_sessions s
    JOIN disco_restaurant_accounts a ON a.email = s.email
    WHERE s.token = ${token} AND s.expires_at > NOW()
    LIMIT 1
  `) as Array<{
    restaurant_reference: string; email: string
    first_name: string | null; last_name: string | null; restaurant_name: string | null
  }>
  if (!rows.length) return null
  return {
    restaurantReference: rows[0].restaurant_reference,
    email: rows[0].email,
    firstName: rows[0].first_name,
    lastName: rows[0].last_name,
    restaurantName: rows[0].restaurant_name,
  }
}

// Delete a session (logout)
export async function deleteDiscoRestaurantSession(token: string): Promise<void> {
  await sql`DELETE FROM disco_restaurant_sessions WHERE token = ${token}`
}

// Whether the email currently has at least one non-expired session.
export async function hasValidDiscoRestaurantSession(email: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_sessions WHERE email = ${email} AND expires_at > NOW() LIMIT 1
  `) as unknown[]
  return rows.length > 0
}

// Get account by email
export async function getDiscoRestaurantAccount(email: string) {
  const rows = (await sql`
    SELECT * FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1
  `) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

// Create account
export async function createDiscoRestaurantAccount(data: {
  email: string
  passwordHash: string
  restaurantReference: string
  fmUserReference?: string
  firstName?: string
  lastName?: string
  phone?: string
  restaurantName?: string
}) {
  await sql`
    INSERT INTO disco_restaurant_accounts (
      email, password_hash, restaurant_reference, fm_user_reference,
      first_name, last_name, phone, restaurant_name
    ) VALUES (
      ${data.email}, ${data.passwordHash}, ${data.restaurantReference},
      ${data.fmUserReference ?? null}, ${data.firstName ?? null},
      ${data.lastName ?? null}, ${data.phone ?? null}, ${data.restaurantName ?? null}
    )
    ON CONFLICT (email) DO NOTHING
  `
}
