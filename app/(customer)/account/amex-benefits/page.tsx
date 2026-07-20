'use client'
// ⚠️ TEMPORARY DEMO PAGE — see lib/demo/amex-demo.tsx for the kill switch + removal notes.
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthContext } from '../../../context/AuthContext'
import { isAmexDemoUser, AmexBenefitsContent } from '../../../../lib/demo/amex-demo'

export default function AmexBenefitsPage() {
  const { user, isLoading } = useAuthContext()
  const router = useRouter()

  // Hard guard: anyone who is not the demo account is bounced away, so the page
  // can never be reached by a real customer via a direct URL.
  const allowed = isAmexDemoUser(user?.email)
  useEffect(() => {
    if (!isLoading && !allowed) router.replace('/account/orders')
  }, [isLoading, allowed, router])

  if (isLoading || !allowed) return null
  return <AmexBenefitsContent firstName={user?.firstName} />
}
