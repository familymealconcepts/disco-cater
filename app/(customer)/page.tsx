import type { Metadata } from 'next'
import HomeClient from './HomeClient'

const TITLE = 'Disco Cater — Premium Restaurant Catering Marketplace | Nationwide'
const DESCRIPTION =
  'Order catering from hand-vetted restaurants nationwide. Disco Cater specializes in recurring office catering programs and exclusive holiday and social event menus. No commissions. Powered by Disco AI.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: 'https://www.discocater.com' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: 'https://www.discocater.com',
    siteName: 'Disco Cater',
    type: 'website',
  },
}

export default function Page() {
  return <HomeClient />
}
