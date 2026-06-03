import type { Metadata } from 'next'
import SignupClient from './SignupClient'

export const metadata: Metadata = {
  title: 'Create your account — Disco Cater',
  description: 'Sign up for Disco Cater. Fast and free — create your account to order premium restaurant catering.',
}

export default function SignupPage() {
  return <SignupClient />
}
