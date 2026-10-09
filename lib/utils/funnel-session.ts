'use client'

import { type FunnelStage, funnelCookieName } from '../checkout-funnel-shared'

// One first-party cookie PER RESTAURANT, not one global cookie — a customer
// with two restaurant tabs open (or who visits a second restaurant later in
// the same browser) must get a fresh session id for each, never share one
// across restaurants. 6h covers any realistic single visit (survives a
// reload/back-and-forth while browsing + checking out) while still starting a
// new funnel session on a return visit days later, rather than merging into a
// stale one.
const COOKIE_MAX_AGE_SECONDS = 6 * 60 * 60

// Shared with the server (see funnelCookieName in checkout-funnel-shared.ts).
const cookieName = funnelCookieName

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; path=/; SameSite=Lax`
}

// Client-generated, restaurant-scoped session id. Created once per restaurant
// visit and persisted so it survives a page reload within that visit. This
// (not orderReference, which doesn't exist until checkout-open) is what keys
// every funnel row — some stages (date/time picked, first item added) happen
// before any server-side order draft exists at all.
export function getOrCreateFunnelSessionId(restaurantReference: string): string {
  if (typeof document === 'undefined' || !restaurantReference) return ''
  const name = cookieName(restaurantReference)
  const existing = readCookie(name)
  if (existing) return existing
  const id = crypto.randomUUID()
  writeCookie(name, id, COOKIE_MAX_AGE_SECONDS)
  return id
}

export interface PostFunnelStageInput {
  sessionId: string
  restaurantReference: string
  stage: FunnelStage
  fulfillmentType?: 'PICKUP' | 'DELIVERY' | null
  cartValueCents?: number | null
  itemCount?: number | null
  // The date/time the customer picked -- only ever sent alongside DATE_TIME_SELECTED (see
  // RestaurantClient.tsx's own effect). 'YYYY-MM-DD' / 'HH:MM', matching selDate/selTime as-is.
  selectedOrderDate?: string | null
  selectedOrderTime?: string | null
}

// Fire-and-forget by design: callers must NOT await this in a way that blocks
// UI or checkout. Errors are swallowed here too, so even a caller that
// mistakenly awaits it never sees a rejection.
export function postFunnelStage(input: PostFunnelStageInput): void {
  if (!input.sessionId || !input.restaurantReference) return
  try {
    fetch('/api/checkout-funnel/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      keepalive: true, // let it land even if this fires right before navigation
    }).catch(() => {})
  } catch {
    /* never let a capture call throw into the checkout flow */
  }
}

export interface PostCheckoutContactInput {
  restaurantReference: string
  firstName: string
  lastName: string
  email: string
  phone: string
  company: string
}

// Abandoned-checkout contact capture (see 006_checkout_contacts.sql). Sends only
// what the diner typed into the drawer's contact fields. Deliberately carries NO
// session id and NO account identity: the server reads the session id from the
// disco_fn_<ref> cookie and the account from the signed-in customer session, so
// nothing here can name a row or an account. Same fire-and-forget contract as
// postFunnelStage -- never awaited, never throws, response ignored.
export function postCheckoutContact(input: PostCheckoutContactInput): void {
  if (!input.restaurantReference) return
  try {
    fetch('/api/checkout-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* never let a capture call throw into the checkout flow */
  }
}
