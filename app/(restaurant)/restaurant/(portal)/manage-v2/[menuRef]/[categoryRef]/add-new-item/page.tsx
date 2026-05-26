'use client'
import { useParams, useRouter } from 'next/navigation'
import MealPackageForm from '@/app/(restaurant)/restaurant/(portal)/manage-v2/[menuRef]/[categoryRef]/_MealPackageForm'

export default function AddNewItemPage() {
  const params = useParams<{ menuRef: string; categoryRef: string }>()
  const router = useRouter()
  const { menuRef, categoryRef } = params

  async function handleSave(payload: Record<string, unknown>) {
    const res = await fetch(`/api/restaurant/meal-packages?menu=${menuRef}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, itemCategoryReference: categoryRef }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || 'Failed to create item')
    }
    router.push(`/restaurant/manage-v2/${menuRef}/${categoryRef}`)
  }

  return (
    <MealPackageForm
      menuRef={menuRef}
      categoryRef={categoryRef}
      mode="create"
      onSave={handleSave}
      onCancel={() => router.push(`/restaurant/manage-v2/${menuRef}/${categoryRef}`)}
    />
  )
}
