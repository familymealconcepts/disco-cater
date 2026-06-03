import type { Metadata } from 'next'
import BecomeAPartnerClient from './BecomeAPartnerClient'

export const metadata: Metadata = {
  title: 'Become a Partner — Disco Cater',
  description: 'Sign up your restaurant for Disco Cater. Fast, free, no commitment or contract — create your account and start accepting catering orders.',
}

export default function BecomeAPartnerPage() {
  return <BecomeAPartnerClient />
}
