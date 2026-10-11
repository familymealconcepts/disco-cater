'use client'
// ⚠️ TEMPORARY DEMO PAGE — see lib/demo/loyalty-demo.tsx for the kill switch + removal notes.
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthContext } from '../../../context/AuthContext'
import { isLoyaltyDemoUser, LoyaltyContent } from '../../../../lib/demo/loyalty-demo'

export default function LoyaltyPage() {
  const { user, isLoading } = useAuthContext()
  const router = useRouter()

  // Hard guard: anyone who is not the demo account is bounced away, so the page
  // can never be reached by a real customer via a direct URL.
  const allowed = isLoyaltyDemoUser(user?.email)
  useEffect(() => {
    if (!isLoading && !allowed) router.replace('/account/orders')
  }, [isLoading, allowed, router])

  if (isLoading || !allowed) return null
  return <LoyaltyContent firstName={user?.firstName} />
}
