'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Superseded: per-menu settings (including the "Include Utensils" toggle) now live
// in MenuSettingsDialog on the Menus page. This former standalone page was orphaned
// by the single-entry-point menu-manager rework (c0c8fba); redirect any stray
// bookmark/direct link to the live Menus surface so there's no dead entry point.
export default function OrphanedMenuSettingsRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/restaurant/manage-v2/menus') }, [router])
  return null
}
