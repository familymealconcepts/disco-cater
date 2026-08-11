import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { sendCustomerOrderConfirmation, sendOrderUpdated } from '../../../../../lib/email/notifications'
import { sendEmail } from '../../../../../lib/email/send'

export const runtime = 'nodejs'

// TEMPORARY — verifies the orders@discocater.com -> noreply@familymeal.com bcc
// addition by triggering one real send of each of the 3 requested email types
// to a safe test address. Delete after verification.
export async function POST(req: NextRequest) {
  const role = await getAdminRole()
  if (role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const to = String(body?.to || '').trim()
  if (!to) return NextResponse.json({ error: 'to required' }, { status: 400 })
  const stamp = Date.now()

  const confirmation = await sendCustomerOrderConfirmation({
    to,
    firstName: 'Test', lastName: 'BccVerify',
    orderService: 'PICKUP',
    orderDate: 'Test Date', orderTime: '12:00 PM',
    orderReceived: 'Test Received',
    orderMealPackages: [{ name: 'Test Item', count: 1, price: 10 }],
    subtotal: 10, totalPrice: 10,
    orderNumber: `TEST-${stamp}-CONFIRM`,
    businessName: 'BCC Test Restaurant',
  })

  const signup = await sendEmail({
    to,
    subject: `Welcome to Disco Cater! (bcc test ${stamp})`,
    html: `<p>Welcome to Disco Cater! (bcc verification test ${stamp})</p>`,
  })

  const orderChange = await sendOrderUpdated({
    to,
    firstName: 'Test',
    orderNumber: `TEST-${stamp}-CHANGE`,
    businessName: 'BCC Test Restaurant',
    items: [],
    newTotal: 15,
    delta: 5,
  })

  return NextResponse.json({ stamp, confirmation, signup, orderChange })
}
