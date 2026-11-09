import type { Metadata } from 'next'

// A password-reset form, reached from an email link: kept out of search.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children
}
