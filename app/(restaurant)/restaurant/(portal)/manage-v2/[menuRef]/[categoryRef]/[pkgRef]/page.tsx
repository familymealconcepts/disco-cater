'use client'
import { useParams, useRouter } from 'next/navigation'
import MealPackageForm from '@/app/(restaurant)/restaurant/(portal)/manage-v2/[menuRef]/[categoryRef]/_MealPackageForm'

export default function EditItemPage() {
  const params = useParams<{ menuRef: string; categoryRef: string; pkgRef: string }>()
  const router = useRouter()
  const { menuRef, categoryRef, pkgRef } = params

  async function handleSave(payload: Record<string, unknown>) {
    const res = await fetch(`/api/restaurant/meal-packages/${pkgRef}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || 'Failed to update item')
    }
    router.push(`/restaurant/manage-v2/${menuRef}/${categoryRef}`)
  }

  return (
    <MealPackageForm
      menuRef={menuRef}
      categoryRef={categoryRef}
      pkgRef={pkgRef}
      mode="edit"
      onSave={handleSave}
      onCancel={() => router.push(`/restaurant/manage-v2/${menuRef}/${categoryRef}`)}
    />
  )
}
