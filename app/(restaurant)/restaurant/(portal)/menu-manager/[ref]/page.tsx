'use client'
import { useEffect, useState, use as usePromise } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface Cat { reference: string; name: string; description: string | null; position: number; visible: boolean }
interface Item { reference: string; category_reference: string; name: string; description: string | null; price: string | number; serves: string | null; visible: boolean; position: number; image_url: string | null }

function money(v: unknown) { const n = parseFloat(String(v ?? '')); return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}` }

export default function MenuEditorPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = usePromise(params)
  const router = useRouter()

  const [menuName, setMenuName] = useState('')
  const [cats, setCats] = useState<Cat[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [selCat, setSelCat] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [kebab, setKebab] = useState<string>('')

  const [catDlg, setCatDlg] = useState<{ mode: 'create' | 'edit'; cat?: Cat } | null>(null)
  const [itemDlg, setItemDlg] = useState<{ mode: 'create' | 'edit'; item?: Item } | null>(null)
  const [addExisting, setAddExisting] = useState(false)

  const [dragCat, setDragCat] = useState<string>('')
  const [dragItem, setDragItem] = useState<string>('')

  function flash(m: string) { setToast(m); setTimeout(() => setToast(''), 2500) }

  async function load() {
    const [mRes, cRes] = await Promise.all([
      fetch(`/api/restaurant/disco-menus/${ref}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/restaurant/disco-menus/${ref}/categories`).then(r => r.ok ? r.json() : { categories: [], items: [] }),
    ])
    setMenuName(mRes?.menu?.name || 'Menu')
    const c: Cat[] = Array.isArray(cRes.categories) ? cRes.categories : []
    setCats(c)
    setItems(Array.isArray(cRes.items) ? cRes.items : [])
    setSelCat(prev => (prev && c.some(x => x.reference === prev)) ? prev : (c[0]?.reference || ''))
    setLoading(false)
  }
  useEffect(() => { load() }, [ref]) // eslint-disable-line react-hooks/exhaustive-deps

  const catItems = items.filter(i => i.category_reference === selCat).sort((a, b) => a.position - b.position)

  // ── Category actions ──
  async function saveCat(name: string, description: string, visible: boolean) {
    if (!catDlg) return
    const isEdit = catDlg.mode === 'edit'
    const res = await fetch(isEdit ? `/api/restaurant/disco-menu-categories/${catDlg.cat!.reference}` : `/api/restaurant/disco-menus/${ref}/categories`, {
      method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, visible }),
    })
    if (res.ok) { setCatDlg(null); await load(); flash('Saved') }
    else { const d = await res.json().catch(() => ({})); flash(d.error || 'Could not save category') }
  }
  async function deleteCat(c: Cat) {
    setKebab('')
    const res = await fetch(`/api/restaurant/disco-menu-categories/${c.reference}`, { method: 'DELETE' })
    if (res.ok) { await load(); flash('Category deleted') }
    else { const d = await res.json().catch(() => ({})); flash(d.error || 'Could not delete category') }
  }
  async function reorderCats(fromRef: string, toRef: string) {
    if (fromRef === toRef) return
    const order = [...cats]
    const from = order.findIndex(c => c.reference === fromRef)
    const to = order.findIndex(c => c.reference === toRef)
    if (from < 0 || to < 0) return
    const [moved] = order.splice(from, 1); order.splice(to, 0, moved)
    setCats(order.map((c, i) => ({ ...c, position: i })))
    await fetch(`/api/restaurant/disco-menu-categories/${fromRef}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: to }) })
  }

  // ── Item actions ──
  async function toggleItemVisible(it: Item) {
    setItems(prev => prev.map(x => x.reference === it.reference ? { ...x, visible: !x.visible } : x))
    await fetch(`/api/restaurant/disco-menu-items/${it.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible: !it.visible }) })
  }
  async function deleteItem(it: Item) {
    if (!confirm(`Delete "${it.name}"?`)) return
    const res = await fetch(`/api/restaurant/disco-menu-items/${it.reference}`, { method: 'DELETE' })
    if (res.ok) { await load(); flash('Item deleted') }
  }
  async function cloneItem(it: Item) {
    const res = await fetch(`/api/restaurant/disco-menu-items/${it.reference}/clone`, { method: 'POST' })
    if (res.ok) { await load(); flash('Item duplicated') }
  }
  async function reorderItems(fromRef: string, toRef: string) {
    if (fromRef === toRef) return
    const order = [...catItems]
    const from = order.findIndex(i => i.reference === fromRef)
    const to = order.findIndex(i => i.reference === toRef)
    if (from < 0 || to < 0) return
    const [moved] = order.splice(from, 1); order.splice(to, 0, moved)
    setItems(prev => prev.map(i => { const idx = order.findIndex(o => o.reference === i.reference); return idx >= 0 ? { ...i, position: idx } : i }))
    await fetch(`/api/restaurant/disco-menu-items/${fromRef}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: to }) })
  }

  if (loading) return <div style={{ padding: 40, color: '#aaa', fontFamily: F }}>Loading…</div>

  return (
    <div style={{ fontFamily: F, padding: '24px 28px' }} onClick={() => setKebab('')}>
      {toast && <div style={{ position: 'fixed', top: 20, right: 20, background: '#22C55E', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 999 }}>{toast}</div>}

      <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
        <a href="/restaurant/menu-manager" style={{ color: BLUE, textDecoration: 'none' }}>Menus</a>
        <span style={{ margin: '0 6px' }}>/</span><span>{menuName}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>{menuName}</h1>
        <button onClick={() => router.push(`/restaurant/menu-manager/${ref}/edit`)} style={{ background: 'none', border: '1px solid #ddd', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, color: '#555', cursor: 'pointer', fontFamily: F }}>Menu Settings</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, alignItems: 'start' }}>
        {/* ── Category sidebar ── */}
        <div style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 8px 10px' }}>Categories</div>
          {cats.length === 0 && <div style={{ fontSize: 12, color: '#aaa', padding: '8px' }}>No categories yet.</div>}
          {cats.map(c => (
            <div key={c.reference} draggable
              onDragStart={() => setDragCat(c.reference)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => { reorderCats(dragCat, c.reference); setDragCat('') }}
              onClick={() => setSelCat(c.reference)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 8px', borderRadius: 8, cursor: 'pointer', position: 'relative',
                background: selCat === c.reference ? '#EEF0FD' : 'transparent' }}>
              <span style={{ color: '#ccc', cursor: 'grab', fontSize: 13 }}>⠿</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: selCat === c.reference ? 700 : 500, color: DARK }}>{c.name}</span>
              <button onClick={e => { e.stopPropagation(); setKebab(kebab === c.reference ? '' : c.reference) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 16, padding: '0 4px' }}>⋯</button>
              {kebab === c.reference && (
                <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', right: 6, top: 34, background: '#fff', border: '1px solid #eee', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 20, minWidth: 120 }}>
                  <button onClick={() => { setCatDlg({ mode: 'edit', cat: c }); setKebab('') }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', fontSize: 13, color: DARK, cursor: 'pointer', fontFamily: F }}>Edit</button>
                  <button onClick={() => deleteCat(c)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', fontSize: 13, color: RED, cursor: 'pointer', fontFamily: F }}>Delete</button>
                </div>
              )}
            </div>
          ))}
          <button onClick={() => setCatDlg({ mode: 'create' })} style={{ width: '100%', marginTop: 8, background: 'none', border: '1px dashed #ccc', borderRadius: 8, padding: '9px', fontSize: 13, color: BLUE, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>+ Add Menu Category</button>
        </div>

        {/* ── Item table ── */}
        <div style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginBottom: 14 }}>
            <button disabled={!selCat} onClick={() => setAddExisting(true)} style={{ background: 'none', border: '1px solid #ddd', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, color: selCat ? '#555' : '#bbb', cursor: selCat ? 'pointer' : 'not-allowed', fontFamily: F }}>+ Add Existing Item</button>
            <button disabled={!selCat} onClick={() => setItemDlg({ mode: 'create' })} style={{ background: selCat ? BLUE : '#ccc', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: selCat ? 'pointer' : 'not-allowed', fontFamily: F }}>Create Menu Item</button>
          </div>
          {!selCat ? (
            <div style={{ color: '#aaa', fontSize: 14, padding: 24, textAlign: 'center' }}>Create a category to start adding items.</div>
          ) : catItems.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 14, padding: 24, textAlign: 'center' }}>No items in this category yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#999', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <th style={{ padding: '6px 8px', width: 28 }}></th>
                  <th style={{ padding: '6px 8px' }}>Title</th>
                  <th style={{ padding: '6px 8px' }}>Description</th>
                  <th style={{ padding: '6px 8px', width: 80 }}>Price</th>
                  <th style={{ padding: '6px 8px', width: 56 }}>Image</th>
                  <th style={{ padding: '6px 8px', width: 130, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {catItems.map(it => (
                  <tr key={it.reference} draggable
                    onDragStart={() => setDragItem(it.reference)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => { reorderItems(dragItem, it.reference); setDragItem('') }}
                    style={{ borderTop: '1px solid #f2f2f2', opacity: it.visible ? 1 : 0.5 }}>
                    <td style={{ padding: '10px 8px', color: '#ccc', cursor: 'grab' }}>⠿</td>
                    <td style={{ padding: '10px 8px', fontWeight: 600, color: DARK }}>{it.name}</td>
                    <td style={{ padding: '10px 8px', color: '#888', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.description || '—'}</td>
                    <td style={{ padding: '10px 8px', color: DARK }}>{money(it.price)}</td>
                    <td style={{ padding: '10px 8px' }}>{it.image_url ? <img src={it.image_url} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }} /> : <div style={{ width: 36, height: 36, borderRadius: 6, background: '#f4f4f8' }} />}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button title="Duplicate" onClick={() => cloneItem(it)} style={iconBtn}>⧉</button>
                      <button title="Edit" onClick={() => setItemDlg({ mode: 'edit', item: it })} style={iconBtn}>✎</button>
                      <button title="Delete" onClick={() => deleteItem(it)} style={{ ...iconBtn, color: RED }}>🗑</button>
                      <label title="Visible to customers" style={{ marginLeft: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={it.visible} onChange={() => toggleItemVisible(it)} style={{ accentColor: BLUE, cursor: 'pointer' }} />
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {catDlg && <CategoryDialog mode={catDlg.mode} cat={catDlg.cat} onCancel={() => setCatDlg(null)} onSave={saveCat} />}
      {itemDlg && <ItemDialog mode={itemDlg.mode} item={itemDlg.item} categoryRef={selCat} onCancel={() => setItemDlg(null)} onSaved={async () => { setItemDlg(null); await load(); flash('Saved') }} />}
      {addExisting && <AddExistingDialog categoryRef={selCat} onCancel={() => setAddExisting(false)} onAdded={async () => { setAddExisting(false); await load(); flash('Items added') }} />}
    </div>
  )
}

const iconBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#666', padding: '2px 5px' }
const dlgOverlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(10,0,20,0.5)', zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const dlgCard: React.CSSProperties = { background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 460, maxHeight: '90vh', overflow: 'auto', fontFamily: F }
const dlgInput: React.CSSProperties = { width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: F, border: '1px solid #ddd', borderRadius: 8, color: DARK, boxSizing: 'border-box', outline: 'none' }
const dlgLabel: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', margin: '12px 0 6px' }

function CategoryDialog({ mode, cat, onCancel, onSave }: { mode: 'create' | 'edit'; cat?: Cat; onCancel: () => void; onSave: (n: string, d: string, visible: boolean) => void }) {
  const [name, setName] = useState(cat?.name || '')
  const [desc, setDesc] = useState(cat?.description || '')
  const [visible, setVisible] = useState(cat?.visible !== false)
  return (
    <div style={dlgOverlay} onClick={onCancel}>
      <div style={dlgCard} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: DARK }}>{mode === 'edit' ? 'Edit Category' : 'Add Menu Category'}</div>
        <label style={dlgLabel}>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} style={dlgInput} autoFocus />
        <label style={dlgLabel}>Description</label>
        <input value={desc} onChange={e => setDesc(e.target.value)} style={dlgInput} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, color: DARK, cursor: 'pointer' }}>
          <input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} style={{ accentColor: BLUE }} /> Visible to customers
        </label>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={() => name.trim() && onSave(name.trim(), desc, visible)} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Save</button>
          <button onClick={onCancel} style={{ background: 'none', border: '1px solid #ddd', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, color: '#555', cursor: 'pointer', fontFamily: F }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function ItemDialog({ mode, item, categoryRef, onCancel, onSaved }: { mode: 'create' | 'edit'; item?: Item; categoryRef: string; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name || '')
  const [desc, setDesc] = useState(item?.description || '')
  const [price, setPrice] = useState(item?.price != null ? String(item.price) : '')
  const [serves, setServes] = useState(item?.serves || '')
  const [imageUrl, setImageUrl] = useState(item?.image_url || '')
  const [visible, setVisible] = useState(item?.visible !== false)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const isEdit = mode === 'edit'

  // Item fields (Stage 8)
  const ex = (item ?? {}) as Record<string, unknown>
  const [displayPrice, setDisplayPrice] = useState(String(ex.display_price || ''))
  const [minQuantity, setMinQuantity] = useState(ex.min_quantity != null ? String(ex.min_quantity) : '')
  const [allowSI, setAllowSI] = useState(ex.allow_special_instructions === true)
  const [vegetarian, setVegetarian] = useState(ex.vegetarian === true)
  const [containsNuts, setContainsNuts] = useState(ex.contains_nuts === true)
  const [glutenFree, setGlutenFree] = useState(ex.gluten_free === true)
  const [vegan, setVegan] = useState(ex.vegan === true)

  // Modifier groups attached to this item (edit mode only — the item must exist).
  const [libGroups, setLibGroups] = useState<{ reference: string; name: string; external_name: string | null }[]>([])
  const [attached, setAttached] = useState<{ reference: string; enabled: boolean }[]>([])
  useEffect(() => {
    if (!isEdit || !item?.reference) return
    Promise.all([
      fetch('/api/restaurant/disco-modifier-groups').then(r => r.ok ? r.json() : { groups: [] }),
      fetch(`/api/restaurant/disco-menu-items/${item.reference}/groups`).then(r => r.ok ? r.json() : { groups: [] }),
    ]).then(([lib, cur]) => {
      setLibGroups(Array.isArray(lib.groups) ? lib.groups : [])
      setAttached((Array.isArray(cur.groups) ? cur.groups : []).map((g: { reference: string; enabled?: boolean }) => ({ reference: g.reference, enabled: g.enabled !== false })))
    }).catch(() => {})
  }, [isEdit, item?.reference])
  const isAttached = (ref: string) => attached.some(a => a.reference === ref)
  const toggleAttach = (ref: string) => setAttached(a => isAttached(ref) ? a.filter(x => x.reference !== ref) : [...a, { reference: ref, enabled: true }])
  const toggleEnabled = (ref: string) => setAttached(a => a.map(x => x.reference === ref ? { ...x, enabled: !x.enabled } : x))

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    if (f.size > 5 * 1024 * 1024) { setErr('Image too large (max 5MB).'); return }
    setUploading(true); setErr('')
    try {
      const fd = new FormData(); fd.append('image', f)
      const res = await fetch('/api/become-a-partner/logo', { method: 'POST', body: fd })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d?.url) setImageUrl(String(d.url)); else setErr(d?.error || 'Upload failed')
    } finally { setUploading(false) }
  }
  async function save() {
    if (!name.trim()) { setErr('Item name is required.'); return }
    setSaving(true); setErr('')
    const res = await fetch(isEdit ? `/api/restaurant/disco-menu-items/${item!.reference}` : '/api/restaurant/disco-menu-items', {
      method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryReference: categoryRef, name: name.trim(), description: desc, price, serves, imageUrl, visible,
        displayPrice, minQuantity: minQuantity.trim() === '' ? null : parseInt(minQuantity, 10) || 1,
        allowedSpecialInstructions: allowSI, vegetarian, containsNuts, glutenFree, vegan,
      }),
    })
    if (!res.ok) { setSaving(false); const d = await res.json().catch(() => ({})); setErr(d.error || 'Could not save item'); return }
    // Persist attached modifier groups (edit mode only — the item exists).
    if (isEdit && item?.reference) {
      await fetch(`/api/restaurant/disco-menu-items/${item.reference}/groups`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups: attached }),
      }).catch(() => {})
    }
    setSaving(false)
    onSaved()
  }
  return (
    <div style={dlgOverlay} onClick={onCancel}>
      <div style={dlgCard} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: DARK }}>{mode === 'edit' ? 'Edit Item' : 'Create Menu Item'}</div>
        {err && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: RED, marginTop: 12 }}>{err}</div>}
        <label style={dlgLabel}>Title</label>
        <input value={name} onChange={e => setName(e.target.value)} style={dlgInput} autoFocus />
        <label style={dlgLabel}>Description</label>
        <textarea value={desc} onChange={e => setDesc(e.target.value)} style={{ ...dlgInput, minHeight: 64, resize: 'vertical' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={dlgLabel}>Price</label><input value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" style={dlgInput} /></div>
          <div><label style={dlgLabel}>Serves</label><input value={serves} onChange={e => setServes(e.target.value)} style={dlgInput} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={dlgLabel}>Display price (optional)</label><input value={displayPrice} onChange={e => setDisplayPrice(e.target.value)} placeholder="e.g. Starting at $45" style={dlgInput} /></div>
          <div><label style={dlgLabel}>Min quantity</label><input value={minQuantity} onChange={e => setMinQuantity(e.target.value)} inputMode="numeric" placeholder="1" style={dlgInput} /></div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: DARK, cursor: 'pointer' }}>
          <input type="checkbox" checked={allowSI} onChange={e => setAllowSI(e.target.checked)} style={{ accentColor: BLUE }} /> Allow special instructions
        </label>
        <label style={dlgLabel}>Dietary</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          {([['Vegetarian', vegetarian, setVegetarian], ['Contains nuts', containsNuts, setContainsNuts], ['Gluten-free', glutenFree, setGlutenFree], ['Vegan', vegan, setVegan]] as [string, boolean, (v: boolean) => void][]).map(([lbl, val, set]) => (
            <label key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: DARK, cursor: 'pointer' }}>
              <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} style={{ accentColor: BLUE }} /> {lbl}
            </label>
          ))}
        </div>

        <label style={dlgLabel}>Image</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {imageUrl ? <img src={imageUrl} alt="" style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', border: '1px solid #eee' }} /> : <div style={{ width: 56, height: 56, borderRadius: 8, background: '#f4f4f8', border: '1px solid #eee' }} />}
          <label style={{ fontSize: 13, color: BLUE, fontWeight: 600, cursor: 'pointer' }}>{uploading ? 'Uploading…' : (imageUrl ? 'Replace' : 'Upload')}<input type="file" accept="image/jpeg,image/png" onChange={upload} style={{ display: 'none' }} /></label>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, color: DARK, cursor: 'pointer' }}>
          <input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} style={{ accentColor: BLUE }} /> Visible to customers
        </label>

        <label style={dlgLabel}>Modifier Groups</label>
        {!isEdit ? (
          <div style={{ fontSize: 12.5, color: '#999' }}>Save the item first, then reopen it to attach modifier groups.</div>
        ) : libGroups.length === 0 ? (
          <div style={{ fontSize: 12.5, color: '#999' }}>No modifier groups yet — create some under Manage Menus → Modifier Groups.</div>
        ) : (
          <div style={{ border: '1px solid #eee', borderRadius: 8, maxHeight: 180, overflowY: 'auto' }}>
            {libGroups.map(g => {
              const on = isAttached(g.reference)
              const enabled = attached.find(a => a.reference === g.reference)?.enabled !== false
              return (
                <div key={g.reference} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderTop: '1px solid #f4f4f8', fontSize: 13 }}>
                  <input type="checkbox" checked={on} onChange={() => toggleAttach(g.reference)} style={{ accentColor: BLUE }} />
                  <span style={{ flex: 1, color: DARK }}>{g.name}{g.external_name ? <span style={{ color: '#aaa' }}> · “{g.external_name}”</span> : null}</span>
                  {on && (
                    <button type="button" onClick={() => toggleEnabled(g.reference)}
                      style={{ background: 'none', border: '1px solid #ddd', borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600, color: enabled ? '#2E9E5B' : '#999', cursor: 'pointer', fontFamily: F }}>
                      {enabled ? 'On' : 'Off'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={save} disabled={saving} style={{ background: saving ? '#aaa' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}>{saving ? 'Saving…' : 'Save'}</button>
          <button onClick={onCancel} style={{ background: 'none', border: '1px solid #ddd', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, color: '#555', cursor: 'pointer', fontFamily: F }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function AddExistingDialog({ categoryRef, onCancel, onAdded }: { categoryRef: string; onCancel: () => void; onAdded: () => void }) {
  const [items, setItems] = useState<{ reference: string; name: string; price: string | number }[]>([])
  const [sel, setSel] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    fetch(`/api/restaurant/disco-menu-items/add-existing?categoryRef=${categoryRef}`)
      .then(r => r.ok ? r.json() : { items: [] }).then(d => setItems(d.items || [])).finally(() => setLoading(false))
  }, [categoryRef])
  const chosen = Object.keys(sel).filter(k => sel[k])
  async function add() {
    if (chosen.length === 0) return
    setSaving(true)
    const res = await fetch('/api/restaurant/disco-menu-items/add-existing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryReference: categoryRef, itemReferences: chosen }) })
    setSaving(false)
    if (res.ok) onAdded()
  }
  return (
    <div style={dlgOverlay} onClick={onCancel}>
      <div style={dlgCard} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 6 }}>Add Existing Item</div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>Copies the selected items from your other categories into this one.</div>
        {loading ? <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
          : items.length === 0 ? <div style={{ color: '#aaa', fontSize: 13 }}>No other items available to add.</div>
          : (
            <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid #eee', borderRadius: 8 }}>
              {items.map(it => (
                <label key={it.reference} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid #f4f4f4', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={!!sel[it.reference]} onChange={e => setSel(s => ({ ...s, [it.reference]: e.target.checked }))} style={{ accentColor: BLUE }} />
                  <span style={{ flex: 1, color: DARK }}>{it.name}</span>
                  <span style={{ color: '#888' }}>{money(it.price)}</span>
                </label>
              ))}
            </div>
          )}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={add} disabled={saving || chosen.length === 0} style={{ background: (saving || chosen.length === 0) ? '#ccc' : BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: (saving || chosen.length === 0) ? 'not-allowed' : 'pointer', fontFamily: F }}>Add {chosen.length || ''}</button>
          <button onClick={onCancel} style={{ background: 'none', border: '1px solid #ddd', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, color: '#555', cursor: 'pointer', fontFamily: F }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
