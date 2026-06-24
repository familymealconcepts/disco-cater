// Single Twilio sender for Disco Cater transactional SMS.
//
// Mirrors lib/email/send.ts: a raw HTTP call to the provider (no SDK), and the
// same fire-and-forget contract — NEVER throws, always resolves to a result so
// callers can dispatch without risking an unhandled rejection.
//
// REQUIRED ENV (set in Vercel): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_PHONE_NUMBER. When any is missing we log and no-op.

export interface SendSmsParams {
  to: string
  body: string
}

export interface SendResult {
  success: boolean
  error?: string
}

export async function sendSms(params: SendSmsParams): Promise<SendResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER

  if (!sid || !token || !from) {
    console.warn('[sms] Twilio not configured — skipping SMS')
    return { success: false }
  }
  if (!params.to) {
    console.warn('[sms] no recipient — skipping SMS')
    return { success: false }
  }

  try {
    // Twilio's Messages endpoint takes application/x-www-form-urlencoded.
    const form = new URLSearchParams()
    form.append('To', params.to)
    form.append('From', from)
    form.append('Body', params.body)

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })

    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      const error = `Twilio ${res.status}: ${raw.slice(0, 300)}`
      console.error(`[sms] ${error} (to: ${params.to})`)
      return { success: false, error }
    }

    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[sms] send failed:', error)
    return { success: false, error }
  }
}
