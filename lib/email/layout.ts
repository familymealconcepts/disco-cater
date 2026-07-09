// Shared branded HTML shell for all Disco Cater transactional emails.
//
// Extracted from the inline layout()/button() in
// app/api/cron/recurring-orders/route.ts so every email is visually consistent.
// NOTE: this is additive — the recurring-orders cron keeps its own copy and is
// intentionally left untouched.
//
// Email-client constraints:
//   - The header renders the Disco Cater logo IMAGE (white background baked into
//     the PNG so transparent-on-black clients render correctly), hosted at
//     discocater.com. This is a deliberate product decision that OVERRIDES the
//     "logo is always text" brand rule — do NOT revert to the text wordmark
//     without an explicit new instruction.
//   - Everything is inline-styled; the only <head> element is a Google Fonts
//     <link> for DM Sans (clients that strip it fall back to Helvetica/Arial).

// Minimal HTML escaping for any interpolated text content.
function escapeHtml(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Wraps inner HTML content in the branded Disco Cater email shell:
 * white background, 600px centered card, DM Sans, #1A1028 body text, and a
 * concierge contact footer.
 */
export function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
  <div style="max-width:600px;margin:0 auto;padding:24px;font-family:'DM Sans',Helvetica,Arial,sans-serif;color:#1A1028;font-size:16px;line-height:1.6;">
    <div style="margin-bottom:20px;">
      <img src="https://www.discocater.com/disco-cater-logo-white-bg.png" alt="Disco Cater" width="180" style="width:180px;max-width:180px;height:auto;display:block;border:0;outline:none;background:#ffffff;"/>
    </div>
    ${content}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0 16px 0;"/>
    <p style="color:#999999;font-size:13px;margin:0;">Questions? Contact us at <a href="mailto:concierge@discocater.com" style="color:#999999;">concierge@discocater.com</a></p>
  </div>
</body>
</html>`
}

/** Branded call-to-action button (blue pill → #5B6FE8, white text). */
export function button(text: string, url: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#5B6FE8;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;font-size:15px;">${escapeHtml(text)}</a></p>`
}
