import type { Page } from '@playwright/test'

// gtag() pushes its arguments onto window.dataLayer; with gtag.js blocked, that queue is the whole
// record of what the page tried to send. Exposed binding: it survives a navigation.
// (Same recorder as checkout-conversion-event.spec.ts, kept there untouched.)
export async function recordGtagEvents(page: Page) {
  const events: Array<{ name: string; params: Record<string, unknown> }> = []
  await page.exposeBinding('__e2eGtagEvent', (_src, name: string, params: Record<string, unknown>) => { events.push({ name, params }) })
  await page.addInitScript(() => {
    const w = window as unknown as { dataLayer: unknown[]; __e2eGtagEvent: (n: string, p: unknown) => void }
    w.dataLayer = w.dataLayer || []
    const push = w.dataLayer.push.bind(w.dataLayer)
    w.dataLayer.push = (...items: unknown[]) => {
      for (const it of items) {
        const a = it as ArrayLike<unknown>
        if (a && a[0] === 'event') w.__e2eGtagEvent(String(a[1]), JSON.parse(JSON.stringify(a[2] ?? {})))
      }
      return push(...items)
    }
  })
  return events
}
