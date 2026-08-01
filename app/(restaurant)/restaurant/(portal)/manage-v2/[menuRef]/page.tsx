'use client'
import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { fetchWithAuthRetry } from '@/lib/restaurant-portal-fetch'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

interface Category {
  reference: string
  name: string
  position: number
}

export default function MenuDetailPage() {
  const router = useRouter()
  const params = useParams<{ menuRef: string }>()
  const menuRef = params.menuRef

  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState<Category[]>([])
  const [menuName, setMenuName] = useState('')
  // Distinct from "loaded, genuinely zero categories" -- an auth failure (401,
  // refresh failed) or any other fetch error sets this so the empty state
  // below can't be mistaken for "this menu just has no categories yet".
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    async function load() {
      // Get menu name
      try {
        for (const filter of ['ACTIVE', 'NON_VISIBLE', 'ARCHIVED']) {
          const res = await fetchWithAuthRetry(`/api/restaurant/menus?filter=${filter}&page=0&size=200`)
          if (res.ok) {
            const d = await res.json()
            const menu = (d.content || []).find((m: { reference: string; name: string }) => m.reference === menuRef)
            if (menu) { setMenuName(menu.name); break }
          }
        }
      } catch {}

      // Get categories
      try {
        const res = await fetchWithAuthRetry(`/api/restaurant/categories?menuReference=${menuRef}`)
        if (res.ok) {
          const data = await res.json()
          const cats: Category[] = Array.isArray(data) ? data : (data.content || [])
          const sorted = [...cats].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          setCategories(sorted)
          if (sorted.length > 0) {
            router.replace(`/restaurant/manage-v2/${menuRef}/${sorted[0].reference}`)
            return
          }
        } else {
          setLoadError(true)
        }
      } catch {
        setLoadError(true)
      }
      setLoading(false)
    }
    load()
  }, [menuRef, router])

  if (loading) {
    return (
      <div style={{ padding: '28px 32px', fontFamily: F }}>
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
      </div>
    )
  }

  // No categories empty state (or a real load error, distinguished below)
  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 20 }}>
        <Link href="/restaurant/manage-v2/menus" style={{ color: BLUE, textDecoration: 'none' }}>Menus</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <span>{menuName || menuRef}</span>
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 8px' }}>{menuName || 'Menu'}</h1>
      {loadError ? (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: 40, textAlign: 'center' }}>
          <div style={{ color: '#E53935', fontSize: 13, marginBottom: 16 }}>Couldn&apos;t load categories — your session may have expired.</div>
          <span style={{ color: BLUE, cursor: 'pointer', textDecoration: 'underline', fontSize: 13 }} onClick={() => window.location.reload()}>
            Try again
          </span>
        </div>
      ) : (
        <>
          <div style={{ color: '#888', fontSize: 13, marginBottom: 32 }}>
            This menu has no categories yet. Add a category to get started.
          </div>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: 40, textAlign: 'center' }}>
            <div style={{ color: '#bbb', fontSize: 13, marginBottom: 20 }}>No categories found.</div>
            <p style={{ color: '#888', fontSize: 13, margin: 0 }}>
              Navigate to{' '}
              <Link href={`/restaurant/manage-v2/${menuRef}/_new`} style={{ color: BLUE }}>
                a category page
              </Link>{' '}
              to add categories.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
