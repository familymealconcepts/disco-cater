// Disco Cater transactional email content.
//
// Each function mirrors a FamilyMeal FreeMarker template (see
// familymeal-java-backend/src/main/resources/mail/*.ftl) but:
//   - re-skins into the Disco Cater layout() shell,
//   - replaces "FamilyMeal" → "Disco Cater" and info@familymeal.com →
//     concierge@discocater.com,
//   - uses inline styles only and <hr> separators (no literal "----------"),
//   - never throws — every function returns { success: boolean }.
//
// Additive only: existing email code in become-a-partner / recurring-orders is
// untouched.

import { layout, button } from './layout'
import { sendEmail } from './send'

// ── small helpers ────────────────────────────────────────────────────────────

const HR = '<hr style="border:none;border-top:1px solid #eee;margin:16px 0;"/>'

function escapeHtml(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function money(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

// Mirrors the FM phone formatting: hyphenate a raw 10-digit number, otherwise
// leave as-is (already formatted, or an email-style contact).
function formatPhone(phone?: string): string {
  if (!phone) return ''
  if (!phone.includes('-') && !phone.includes('@') && phone.replace(/\D/g, '').length >= 10) {
    const d = phone
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
  }
  return phone
}

// ── shared param shapes ──────────────────────────────────────────────────────

export interface OrderAddOn {
  count: number
  name: string
  price: number
}

export interface OrderMealPackage {
  count: number
  name: string
  price: number
  comment?: string
  orderAddOns?: OrderAddOn[]
}

interface BaseOrderParams {
  firstName?: string
  lastName?: string
  userEmail?: string
  userPhoneNumber?: string
  dinerAddress?: string
  dinerAddress2?: string
  dinerDeliveryInstructions?: string
  orderService: string // 'PICKUP' | 'DELIVERY'
  orderDate: string
  orderTime: string
  orderReceived: string
  orderMealPackages: OrderMealPackage[]
  subtotal: number
  serviceCharge?: number
  serviceChargeDisplayName?: string
  taxesAndFees?: number
  deliveryFee?: number
  tip?: number
  promo?: number
  totalPrice: number
  orderNumber: number | string
  taxExemptId?: string
  deliveryTrackingUrl?: string
  businessName: string
  businessPhone?: string
  addressLine1?: string
}

export interface CustomerOrderConfirmationParams extends BaseOrderParams {
  to: string
  orderEditNotice?: string
  additionalInvoiceDue?: number
}

export interface RestaurantOrderNotificationParams extends BaseOrderParams {
  orderEditNotice?: string
  additionalInvoiceDue?: number
  deliveryType?: string
  deliveryId?: string
  restaurantEmail: string
  /** FM sourceoforder: "DISCO" → 3P (marketplace), "FAMILYMEAL" → 1P (direct). */
  sourceOfOrder?: string
}

export type CustomerOrderReminderParams = BaseOrderParams & { to: string }

// ── shared render fragments ──────────────────────────────────────────────────

const cellLeft = 'style="padding:2px 8px 2px 0;word-wrap:break-word;max-width:360px;vertical-align:top;"'
const cellRight = 'style="padding:2px 0;white-space:nowrap;vertical-align:top;"'

// Line-item table: "(qty) name — $total", add-ons indented, optional comment.
// Mirrors the orderMealPackages loop in user/restaurant-order-confirm.ftl.
function renderLineItems(packages: OrderMealPackage[]): string {
  if (!packages || packages.length === 0) return ''
  const rows = packages
    .map((pkg) => {
      let html = ''
      if (pkg.name != null && pkg.price != null && pkg.count != null) {
        html += `<tr><td ${cellLeft}>(${escapeHtml(pkg.count)}) ${escapeHtml(pkg.name)}</td><td ${cellRight}>${money(pkg.count * pkg.price)}</td></tr>`
      }
      if (pkg.orderAddOns && pkg.orderAddOns.length) {
        for (const a of pkg.orderAddOns) {
          if (a.name != null && a.price != null && a.count != null) {
            html += `<tr><td ${cellLeft}>&emsp;+ (${escapeHtml(a.count)}) ${escapeHtml(a.name)}</td><td ${cellRight}>${money(pkg.count * (a.count * a.price))}</td></tr>`
          }
        }
      }
      if (pkg.comment) {
        html += `<tr><td ${cellLeft}>&emsp;${escapeHtml(pkg.comment)}</td><td></td></tr>`
      }
      return html
    })
    .join('')
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0;">${rows}</table>`
}

// Financial breakdown. Conditional rows mirror the FM templates (service charge
// and delivery fee only when non-zero; promo shown as a negative).
function renderTotals(p: BaseOrderParams): string {
  const row = (label: string, value: string) =>
    `<tr><td ${cellLeft}>${label}</td><td ${cellRight}>&nbsp;${value}</td></tr>`
  const rows: string[] = []
  if (p.subtotal != null) rows.push(row('Subtotal:', money(p.subtotal)))
  if (p.serviceCharge != null && p.serviceCharge !== 0)
    rows.push(row(`${escapeHtml(p.serviceChargeDisplayName || 'Service Charge')}:`, money(p.serviceCharge)))
  if (p.taxesAndFees != null) rows.push(row('Taxes &amp; Fees:', money(p.taxesAndFees)))
  if (p.deliveryFee != null && p.deliveryFee !== 0) rows.push(row('Delivery Fee:', money(p.deliveryFee)))
  if (p.tip != null) rows.push(row('Tip:', money(p.tip)))
  if (p.promo != null && p.promo !== 0) rows.push(row('Promo:', `-${money(p.promo)}`))
  rows.push(row('<strong>Total:</strong>', `<strong>${money(p.totalPrice)}</strong>`))
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0;">${rows.join('')}</table>`
}

// Customer contact block (name/email/phone + delivery address & instructions).
function renderCustomerBlock(p: BaseOrderParams): string {
  const lines: string[] = []
  const name = [p.firstName, p.lastName].filter(Boolean).map(escapeHtml).join(' ')
  if (name) lines.push(`<strong>${name}</strong>`)
  if (p.userEmail) lines.push(escapeHtml(p.userEmail))
  if (p.userPhoneNumber) lines.push(escapeHtml(p.userPhoneNumber))
  if (p.dinerAddress) lines.push(escapeHtml(p.dinerAddress))
  if (p.dinerAddress2) lines.push(escapeHtml(p.dinerAddress2))
  if (p.dinerDeliveryInstructions) lines.push(`Delivery Instructions: ${escapeHtml(p.dinerDeliveryInstructions)}`)
  return `<p style="margin:0;">${lines.join('<br/>')}</p>`
}

function anyQuestions(p: BaseOrderParams): string {
  const phone = formatPhone(p.businessPhone)
  return `<p style="margin-top:28px;">ANY QUESTIONS?<br/>${escapeHtml(p.businessName)}${phone ? ` - ${escapeHtml(phone)}` : ''}</p>`
}

// ── 1. Customer order confirmation (user-order-confirm.ftl) ──────────────────

export async function sendCustomerOrderConfirmation(
  params: CustomerOrderConfirmationParams,
): Promise<{ success: boolean }> {
  try {
    const p = params
    const phone = formatPhone(p.businessPhone)

    const content = `
${p.orderEditNotice ? `<p style="font-size:15px;line-height:1.5;margin-bottom:12px;">${escapeHtml(p.orderEditNotice)}</p>` : ''}
${p.additionalInvoiceDue != null ? `<p style="margin-bottom:12px;"><strong>Additional amount due (invoice):</strong> ${money(p.additionalInvoiceDue)}</p>` : ''}
<p style="margin:0;"><strong>ORDER RECEIPT:</strong></p>
${HR}
<p style="margin:0;"><strong>${escapeHtml(p.orderService)}: ${escapeHtml(p.orderDate)}${p.orderTime ? ` at ${escapeHtml(p.orderTime)}` : ''}</strong></p>
${HR}
<p style="margin:0;">Thanks for your order${p.firstName ? `, ${escapeHtml(p.firstName)}!` : '!'} Your order has been submitted to ${escapeHtml(p.businessName)}.</p>
${HR}
<p style="margin:0;"><strong>${escapeHtml(p.businessName)}</strong>${phone ? `<br/>${escapeHtml(phone)}` : ''}${p.addressLine1 ? `<br/>${escapeHtml(p.addressLine1)}` : ''}</p>
${HR}
${renderCustomerBlock(p)}
${HR}
<p style="margin:0;">Order Received: ${escapeHtml(p.orderReceived)}</p>
${HR}
${renderLineItems(p.orderMealPackages)}
${HR}
${renderTotals(p)}
${HR}
<p style="margin:0;">Order ID: ${escapeHtml(p.orderNumber)}</p>
${p.taxExemptId ? `<p style="margin:8px 0 0 0;"><strong>Tax Exempt #: ${escapeHtml(p.taxExemptId)}</strong></p>` : ''}
${p.deliveryTrackingUrl ? `<p style="margin-top:20px;">You can track your delivery order <a href="${escapeHtml(p.deliveryTrackingUrl)}" style="color:#5B6FE8;">HERE</a>.</p>` : ''}
${anyQuestions(p)}
`
    return await sendEmail({
      to: p.to,
      subject: 'Your Disco Cater order is confirmed! 🪩',
      html: layout(content),
    })
  } catch (err) {
    console.error('[email/notifications] sendCustomerOrderConfirmation failed:', err instanceof Error ? err.message : err)
    return { success: false }
  }
}

// ── 2. Restaurant order notification (restaurant-order-confirm.ftl) ──────────

export async function sendRestaurantOrderNotification(
  params: RestaurantOrderNotificationParams,
): Promise<{ success: boolean }> {
  try {
    const p = params
    const isThirdPartyDelivery =
      p.deliveryType === 'NASH_DELIVERY' || p.deliveryType === 'DLIVRD_DELIVERY' || p.deliveryType === 'THIRD_PARTY'

    // Order timing block — Nash/Dlivrd show pickup + dropoff, otherwise order time.
    // Order Source helps the restaurant immediately see where the order came from.
    const sourceLabel =
      p.sourceOfOrder === 'DISCO' ? '3P — Disco Cater Marketplace' : '1P — Direct Entry'
    let timingHtml = ''
    if (p.orderService) timingHtml += `Order Type: <strong>${escapeHtml(p.orderService)}</strong><br/>`
    timingHtml += `Order Source: <strong>${sourceLabel}</strong><br/>`
    if (p.orderDate) timingHtml += `Order Date: <strong>${escapeHtml(p.orderDate)}</strong><br/>`
    if (isThirdPartyDelivery) {
      if (p.orderTime) timingHtml += `Delivery Drop-off: <strong>${escapeHtml(p.orderTime)}</strong><br/>`
    } else if (p.orderTime) {
      timingHtml += `Order Time: <strong>${escapeHtml(p.orderTime)}</strong><br/>`
    }

    const content = `
${p.orderEditNotice ? `<p style="font-size:15px;line-height:1.5;margin-bottom:12px;">${escapeHtml(p.orderEditNotice)}</p>` : ''}
${p.additionalInvoiceDue != null ? `<p style="margin-bottom:12px;"><strong>Additional amount due (invoice):</strong> ${money(p.additionalInvoiceDue)}</p>` : ''}
<p style="margin:0;">${timingHtml}</p>
${HR}
${renderCustomerBlock(p)}
${HR}
<p style="margin:0;">Order Received: ${escapeHtml(p.orderReceived)}</p>
${HR}
${renderLineItems(p.orderMealPackages)}
${HR}
${renderTotals(p)}
${HR}
<p style="margin:0;">Order ID: ${escapeHtml(p.orderNumber)}</p>
${p.taxExemptId ? `<p style="margin:8px 0 0 0;"><strong>Tax Exempt #: ${escapeHtml(p.taxExemptId)}</strong></p>` : ''}
${p.deliveryId ? `<p style="margin-top:20px;">Delivery Id: ${escapeHtml(p.deliveryId)}</p>` : ''}
${p.deliveryTrackingUrl ? `<p style="margin-top:20px;">You can track this delivery order <a href="${escapeHtml(p.deliveryTrackingUrl)}" style="color:#5B6FE8;">HERE</a>.</p>` : ''}
`
    return await sendEmail({
      to: p.restaurantEmail,
      subject: `New Disco Cater Order — ${p.businessName} #${p.orderNumber}`,
      html: layout(content),
    })
  } catch (err) {
    console.error('[email/notifications] sendRestaurantOrderNotification failed:', err instanceof Error ? err.message : err)
    return { success: false }
  }
}

// ── 3. Customer order reminder (user-reminder-about-order.ftl) ───────────────

export async function sendCustomerOrderReminder(
  params: CustomerOrderReminderParams,
): Promise<{ success: boolean }> {
  try {
    const p = params
    const phone = formatPhone(p.businessPhone)
    const name = [p.firstName, p.lastName].filter(Boolean).map(escapeHtml).join(' ')

    const content = `
<p style="margin:0;"><strong>${name ? `${name}, ` : ''}your order ${escapeHtml(p.orderNumber)} will be ready on:</strong></p>
${HR}
<p style="margin:0;">
${p.orderService ? `Order type: ${escapeHtml(p.orderService)}<br/>` : ''}
${p.orderDate ? `Order date: ${escapeHtml(p.orderDate)}<br/>` : ''}
${p.orderTime ? `Order time: ${escapeHtml(p.orderTime)}<br/>` : ''}
</p>
${HR}
${renderLineItems(p.orderMealPackages)}
${HR}
<p style="margin:0;"><strong>${escapeHtml(p.businessName)}</strong>${phone ? `<br/>${escapeHtml(phone)}` : ''}${p.addressLine1 ? `<br/>${escapeHtml(p.addressLine1)}` : ''}</p>
${HR}
${renderTotals(p)}
${HR}
<p style="margin:0;">Order ID: ${escapeHtml(p.orderNumber)}</p>
${p.deliveryTrackingUrl ? `<p style="margin-top:20px;">You can track your delivery order <a href="${escapeHtml(p.deliveryTrackingUrl)}" style="color:#5B6FE8;">HERE</a>.</p>` : ''}
${anyQuestions(p)}
`
    return await sendEmail({
      to: p.to,
      subject: `REMINDER: Your order will be ready on ${p.orderDate} at ${p.orderTime} for ${p.firstName || ''}`.trim(),
      html: layout(content),
    })
  } catch (err) {
    console.error('[email/notifications] sendCustomerOrderReminder failed:', err instanceof Error ? err.message : err)
    return { success: false }
  }
}

// ── 4. Customer order cancellation (order-cancellation-notification.ftl) ─────

export interface CustomerOrderCancellationParams {
  to: string
  firstName?: string
  lastName?: string
  businessName: string
  businessPhone?: string
}

export async function sendCustomerOrderCancellation(
  params: CustomerOrderCancellationParams,
): Promise<{ success: boolean }> {
  try {
    const p = params
    const phone = formatPhone(p.businessPhone)
    const name = [p.firstName, p.lastName].filter(Boolean).map(escapeHtml).join(' ')
    const content = `
<p>${name ? `${name},` : 'Hi,'}</p>
<p>Your order was canceled. Please contact ${escapeHtml(p.businessName)} for more information.</p>
<p style="margin-top:28px;">ANY QUESTIONS?<br/>${escapeHtml(p.businessName)}${phone ? ` - ${escapeHtml(phone)}` : ''}</p>
`
    return await sendEmail({
      to: p.to,
      subject: 'Your Disco Cater order has been canceled',
      html: layout(content),
    })
  } catch (err) {
    console.error('[email/notifications] sendCustomerOrderCancellation failed:', err instanceof Error ? err.message : err)
    return { success: false }
  }
}

// ── 5. Password reset (forgot-password.ftl) ──────────────────────────────────

export async function sendCustomerPasswordReset(params: {
  to: string
  firstName?: string
  password: string
  redirectUrl: string
}): Promise<{ success: boolean }> {
  try {
    const { password, redirectUrl } = params
    const content = `
<p>You're receiving this email because you requested a password reset for your Disco Cater account.</p>
<p>Please use <strong>${escapeHtml(password)}</strong> as your temporary password and click <a href="${escapeHtml(redirectUrl)}" style="color:#5B6FE8;">here</a> to reset your password.</p>
${button('Reset password', redirectUrl)}
<p>Thanks,<br/>The Disco Cater Team</p>
`
    return await sendEmail({
      to: params.to,
      subject: 'Reset your Disco Cater password',
      html: layout(content),
    })
  } catch (err) {
    console.error('[email/notifications] sendCustomerPasswordReset failed:', err instanceof Error ? err.message : err)
    return { success: false }
  }
}

// ── 6. Welcome (user-registered-notification.ftl) ────────────────────────────

export async function sendCustomerWelcome(params: {
  to: string
  firstName: string
}): Promise<{ success: boolean }> {
  try {
    const content = `
<p>Welcome, ${escapeHtml(params.firstName)}!</p>
<p>You're all set to start using Disco Cater to place catering orders.</p>
<p>If you didn't register for a Disco Cater account, please ignore this email or contact us at <a href="mailto:concierge@discocater.com" style="color:#5B6FE8;">concierge@discocater.com</a>.</p>
<p>Thanks,<br/>The Disco Cater Team</p>
`
    return await sendEmail({
      to: params.to,
      subject: 'Welcome to Disco Cater! 🪩',
      html: layout(content),
    })
  } catch (err) {
    console.error('[email/notifications] sendCustomerWelcome failed:', err instanceof Error ? err.message : err)
    return { success: false }
  }
}

// ── 7. Refund notification (no direct FM analog; simple message) ─────────────

export async function sendCustomerRefundNotification(params: {
  to: string
  firstName: string
  lastName?: string
  orderNumber: string | number
  refundAmount: number
  businessName: string
}): Promise<{ success: boolean }> {
  try {
    const { firstName, orderNumber, refundAmount, businessName } = params
    const content = `
<p>Hi ${escapeHtml(firstName)},</p>
<p>A refund of <strong>${money(refundAmount)}</strong> has been processed for order #${escapeHtml(orderNumber)}.</p>
<p>Please allow 5-10 business days for the credit to appear.</p>
<p>Questions? Contact ${escapeHtml(businessName)} or <a href="mailto:concierge@discocater.com" style="color:#5B6FE8;">concierge@discocater.com</a>.</p>
<p>Thanks,<br/>The Disco Cater Team</p>
`
    return await sendEmail({
      to: params.to,
      subject: 'Refund processed for your Disco Cater order',
      html: layout(content),
    })
  } catch (err) {
    console.error('[email/notifications] sendCustomerRefundNotification failed:', err instanceof Error ? err.message : err)
    return { success: false }
  }
}
