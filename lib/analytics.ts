// Thin wrapper around the GA4 gtag global. Same pattern as the inline helper
// in fullmap/page.tsx, but accepts numeric param values (subtotals, totals,
// counts) in addition to strings. No-ops when gtag isn't present (SSR, no GA).
export function trackEvent(name: string, params?: Record<string, string | number>) {
  if (typeof window !== 'undefined' && (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag) {
    (window as unknown as { gtag: (...a: unknown[]) => void }).gtag('event', name, params)
  }
}
