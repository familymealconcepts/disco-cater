import type { Metadata } from 'next'

// The map page is a client component, so its metadata lives here. Every
// search lands on /fullmap?lat=&lng=&q=; the canonical folds them all into
// the one map page.
export const metadata: Metadata = {
  alternates: { canonical: 'https://www.discocater.com/fullmap' },
}

export default function FullMapLayout({ children }: { children: React.ReactNode }) {
  return children
}
