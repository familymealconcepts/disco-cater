'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const IMG_BASE = 'https://api.familymeal.com/public-api/images'

interface Category {
  reference: string
  name: string
  position: number
}

interface MealPackage {
  reference: string
  name: string
  description?: string
  price: number
  serves?: string
  visible?: boolean
  image?: { reference: string }
}

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', maxWidth: 400, width: '90%', fontFamily: F }}>
        <p style={{ margin: '0 0 24px', color: DARK, fontSize: 15 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '8px 18px', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={onConfirm} style={{ background: '#E53935', border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 13, color: '#fff', cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Confirm</button>
        </div>
      </div>
    </div>
  )
}

function CategoryDialog({ initial, onSave, onCancel }: { initial?: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial || '')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', maxWidth: 380, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: DARK }}>
          {initial ? 'Rename Category' : 'Add Category'}
        </h3>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Category name"
          autoFocus
          style={{
            width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: F,
            border: '1px solid #ddd', borderRadius: 8, color: DARK,
            outline: 'none', boxSizing: 'border-box', marginBottom: 20,
          }}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '8px 18px', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button
            onClick={() => { if (name.trim()) onSave(name.trim()) }}
            disabled={!name.trim()}
            style={{ background: BLUE, border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 13, color: '#fff', cursor: name.trim() ? 'pointer' : 'not-allowed', fontFamily: F, fontWeight: 600 }}
          >
            {initial ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CategoryDetailPage() {
  const router = useRouter()
  const params = useParams<{ menuRef: string; categoryRef: string }>()
  const { menuRef, categoryRef } = params

  const [menuName, setMenuName] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [packages, setPackages] = useState<MealPackage[]>([])
  const [loadingCats, setLoadingCats] = useState(true)
  const [loadingPkgs, setLoadingPkgs] = useState(true)
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null)
  const [catDialog, setCatDialog] = useState<{ initial?: string; ref?: string } | null>(null)

  const currentCategory = categories.find(c => c.reference === categoryRef)

  const loadCategories = useCallback(async () => {
    setLoadingCats(true)
    try {
      const res = await fetch(`/api/restaurant/categories?menuReference=${menuRef}`)
      if (res.ok) {
        const data = await res.json()
        const cats: Category[] = Array.isArray(data) ? data : (data.content || [])
        setCategories([...cats].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)))
      }
    } finally { setLoadingCats(false) }
  }, [menuRef])

  const loadPackages = useCallback(async () => {
    setLoadingPkgs(true)
    try {
      const res = await fetch(`/api/restaurant/meal-packages?categoryReference=${categoryRef}&page=0&size=100`)
      if (res.ok) {
        const data = await res.json()
        setPackages(data.content || [])
      }
    } finally { setLoadingPkgs(false) }
  }, [categoryRef])

  // Load menu name
  useEffect(() => {
    async function getMenuName() {
      for (const filter of ['ACTIVE', 'NON_VISIBLE', 'ARCHIVED']) {
        try {
          const res = await fetch(`/api/restaurant/menus?filter=${filter}&page=0&size=200`)
          if (res.ok) {
            const d = await res.json()
            const menu = (d.content || []).find((m: { reference: string; name: string }) => m.reference === menuRef)
            if (menu) { setMenuName(menu.name); return }
          }
        } catch {}
      }
    }
    getMenuName()
  }, [menuRef])

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { loadPackages() }, [loadPackages])

  function ask(message: string, onConfirm: () => void) {
    setConfirm({ message, onConfirm })
  }

  async function handleAddCategory(name: string) {
    setCatDialog(null)
    await fetch('/api/restaurant/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, menuReference: menuRef }),
    })
    await loadCategories()
  }

  async function handleRenameCategory(ref: string, name: string) {
    setCatDialog(null)
    await fetch(`/api/restaurant/categories/${ref}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, menuReference: menuRef }),
    })
    await loadCategories()
  }

  async function handleDeleteCategory(ref: string, name: string) {
    ask(`Delete category "${name}"? This cannot be undone.`, async () => {
      setConfirm(null)
      await fetch(`/api/restaurant/categories/${ref}`, { method: 'DELETE' })
      const remaining = categories.filter(c => c.reference !== ref)
      if (remaining.length > 0) {
        router.push(`/restaurant/manage-v2/${menuRef}/${remaining[0].reference}`)
      } else {
        router.push(`/restaurant/manage-v2/${menuRef}`)
      }
      await loadCategories()
    })
  }

  async function handleDeletePackage(ref: string, name: string) {
    ask(`Delete "${name}"? This cannot be undone.`, async () => {
      setConfirm(null)
      await fetch(`/api/restaurant/meal-packages/${ref}`, { method: 'DELETE' })
      await loadPackages()
    })
  }

  async function handleClonePackage(ref: string) {
    await fetch(`/api/restaurant/meal-packages/${ref}/clone`, { method: 'POST' })
    await loadPackages()
  }

  async function handleToggleVisible(ref: string, current: boolean) {
    await fetch(`/api/restaurant/meal-packages/${ref}/visible?isVisible=${!current}`, { method: 'PUT' })
    await loadPackages()
  }

  // ── Drag-to-reorder ──────────────────────────────────────────────────────
  // HTML5 DnD; on drop we optimistically reorder, persist the moved item's new
  // index via FM's /position endpoint (FM reindexes the rest), then reload to
  // reconcile with server truth.
  const [dragCat, setDragCat] = useState<number | null>(null)
  const [dragPkg, setDragPkg] = useState<number | null>(null)

  async function reorderCategories(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return
    const next = [...categories]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setCategories(next)
    try {
      await fetch(`/api/restaurant/categories/${moved.reference}/position?position=${to}`, { method: 'PUT' })
    } catch {}
    await loadCategories()
  }

  async function reorderPackages(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return
    const next = [...packages]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setPackages(next)
    try {
      await fetch(`/api/restaurant/meal-packages/${moved.reference}/position?position=${to}`, { method: 'PUT' })
    } catch {}
    await loadPackages()
  }

  const thStyle: React.CSSProperties = {
    textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#888',
    padding: '10px 12px', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap',
  }
  const tdStyle: React.CSSProperties = {
    padding: '12px', fontSize: 13, color: DARK, verticalAlign: 'middle',
  }

  return (
    <>
      <style>{`
        .cat-item:hover { background: rgba(107,110,249,0.06) !important; }
        .pkg-row:hover { background: #fafafa !important; }
        .action-btn:hover { opacity: 0.8; }
      `}</style>

      <div style={{ padding: '28px 32px', fontFamily: F }}>
        {/* Breadcrumb */}
        <div style={{ fontSize: 12, color: '#999', marginBottom: 20 }}>
          <Link href="/restaurant/manage-v2/menus" style={{ color: BLUE, textDecoration: 'none' }}>Menus</Link>
          <span style={{ margin: '0 6px' }}>/</span>
          <Link href={`/restaurant/manage-v2/${menuRef}`} style={{ color: BLUE, textDecoration: 'none' }}>
            {menuName || menuRef}
          </Link>
          {currentCategory && (
            <>
              <span style={{ margin: '0 6px' }}>/</span>
              <span>{currentCategory.name}</span>
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          {/* Left: Categories Sidebar */}
          <div style={{
            width: 220, flexShrink: 0, background: '#fff', borderRadius: 12,
            border: '1px solid #eee', overflow: 'hidden',
          }}>
            <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {menuName || 'Menu'}
              </div>
            </div>

            <div style={{ padding: '8px 0' }}>
              {loadingCats ? (
                <div style={{ padding: '12px 16px', color: '#aaa', fontSize: 12 }}>Loading…</div>
              ) : categories.length === 0 ? (
                <div style={{ padding: '12px 16px', color: '#aaa', fontSize: 12 }}>No categories.</div>
              ) : (
                categories.map((cat, ci) => (
                  <div
                    key={cat.reference}
                    className="cat-item"
                    draggable
                    onDragStart={() => setDragCat(ci)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); if (dragCat !== null) reorderCategories(dragCat, ci); setDragCat(null) }}
                    onDragEnd={() => setDragCat(null)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '9px 12px 9px 16px',
                      background: cat.reference === categoryRef ? `${BLUE}18` : 'transparent',
                      borderLeft: cat.reference === categoryRef ? `3px solid ${BLUE}` : '3px solid transparent',
                      cursor: 'pointer', opacity: dragCat === ci ? 0.45 : 1,
                    }}
                    onClick={() => router.push(`/restaurant/manage-v2/${menuRef}/${cat.reference}`)}
                  >
                    <span style={{
                      fontSize: 13, color: cat.reference === categoryRef ? BLUE : DARK,
                      fontWeight: cat.reference === categoryRef ? 600 : 400,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                    }}>
                      {cat.name}
                    </span>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                      <button
                        title="Rename"
                        className="action-btn"
                        onClick={() => setCatDialog({ initial: cat.name, ref: cat.reference })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#999', padding: '2px 4px' }}
                      >
                        ✎
                      </button>
                      <button
                        title="Delete"
                        className="action-btn"
                        onClick={() => handleDeleteCategory(cat.reference, cat.name)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#ccc', padding: '2px 4px' }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ padding: '10px 12px', borderTop: '1px solid #f0f0f0' }}>
              <button
                onClick={() => setCatDialog({})}
                style={{
                  width: '100%', background: 'transparent', border: `1px dashed ${BLUE}`,
                  borderRadius: 7, padding: '8px 12px', fontSize: 12, color: BLUE,
                  cursor: 'pointer', fontFamily: F, fontWeight: 600,
                }}
              >
                + Add Category
              </button>
            </div>
          </div>

          {/* Right: Packages List */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: 0 }}>
                {currentCategory?.name || 'Category'}
              </h2>
              <button
                onClick={() => router.push(`/restaurant/manage-v2/${menuRef}/${categoryRef}/add-new-item`)}
                style={{
                  background: BLUE, color: '#fff', border: 'none', borderRadius: 8,
                  padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F,
                }}
              >
                + Add Item
              </button>
            </div>

            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
              {loadingPkgs ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading…</div>
              ) : packages.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#aaa', fontSize: 13 }}>
                  No items in this category.{' '}
                  <span
                    style={{ color: BLUE, cursor: 'pointer' }}
                    onClick={() => router.push(`/restaurant/manage-v2/${menuRef}/${categoryRef}/add-new-item`)}
                  >
                    Add an item
                  </span>
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      <th style={thStyle}>Image</th>
                      <th style={thStyle}>Name</th>
                      <th style={thStyle}>Price</th>
                      <th style={thStyle}>Serves</th>
                      <th style={thStyle}>Visible</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packages.map((pkg, i) => (
                      <tr
                        key={pkg.reference}
                        className="pkg-row"
                        draggable
                        onDragStart={() => setDragPkg(i)}
                        onDragOver={e => e.preventDefault()}
                        onDrop={e => { e.preventDefault(); if (dragPkg !== null) reorderPackages(dragPkg, i); setDragPkg(null) }}
                        onDragEnd={() => setDragPkg(null)}
                        style={{ borderTop: i > 0 ? '1px solid #f5f5f5' : undefined, cursor: 'pointer', opacity: dragPkg === i ? 0.45 : 1 }}
                        onClick={() => router.push(`/restaurant/manage-v2/${menuRef}/${categoryRef}/${pkg.reference}`)}
                      >
                        <td style={tdStyle}>
                          {pkg.image?.reference ? (
                            <img
                              src={`${IMG_BASE}/${pkg.image.reference}/download?size=70`}
                              alt=""
                              style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid #eee', display: 'block' }}
                            />
                          ) : (
                            <div style={{ width: 40, height: 40, background: '#f0f0f4', borderRadius: 6, border: '1px solid #eee' }} />
                          )}
                        </td>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 600, color: DARK }}>{pkg.name}</div>
                          {pkg.description && (
                            <div style={{ fontSize: 12, color: '#888', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                              {pkg.description}
                            </div>
                          )}
                        </td>
                        <td style={tdStyle}>
                          {pkg.price != null ? `$${Number(pkg.price).toFixed(2)}` : '—'}
                        </td>
                        <td style={tdStyle}>{pkg.serves || '—'}</td>
                        <td style={tdStyle} onClick={e => e.stopPropagation()}>
                          <button
                            title={pkg.visible ? 'Hide' : 'Show'}
                            onClick={() => handleToggleVisible(pkg.reference, !!pkg.visible)}
                            style={{
                              background: pkg.visible ? '#EEF2FF' : '#f5f5f8',
                              border: `1px solid ${pkg.visible ? '#C7D2FE' : '#e8e8ee'}`,
                              borderRadius: 6, padding: '4px 10px', fontSize: 11,
                              color: pkg.visible ? BLUE : '#999', cursor: 'pointer', fontFamily: F, fontWeight: 600,
                            }}
                          >
                            {pkg.visible ? 'Visible' : 'Hidden'}
                          </button>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                            <ActionBtn
                              title="Edit"
                              onClick={() => router.push(`/restaurant/manage-v2/${menuRef}/${categoryRef}/${pkg.reference}`)}
                            >
                              Edit
                            </ActionBtn>
                            <ActionBtn title="Clone" onClick={() => handleClonePackage(pkg.reference)}>
                              Clone
                            </ActionBtn>
                            <ActionBtn title="Delete" red onClick={() => handleDeletePackage(pkg.reference, pkg.name)}>
                              Delete
                            </ActionBtn>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}

      {catDialog !== null && (
        <CategoryDialog
          initial={catDialog.initial}
          onSave={catDialog.ref
            ? (name) => handleRenameCategory(catDialog.ref!, name)
            : handleAddCategory
          }
          onCancel={() => setCatDialog(null)}
        />
      )}
    </>
  )
}

function ActionBtn({ children, onClick, title, red }: { children: React.ReactNode; onClick: () => void; title?: string; red?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="action-btn"
      style={{
        background: red ? '#FEF2F2' : '#f5f5f8',
        border: `1px solid ${red ? '#FECACA' : '#e8e8ee'}`,
        borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
        color: red ? '#E53935' : '#555', fontFamily: F,
      }}
    >
      {children}
    </button>
  )
}
