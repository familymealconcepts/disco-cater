'use client'
import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface Customer {
  customerReference: string
  username: string
  email: string
  phoneNumber?: string
  numberOfOrders: number
  totalspend: number
  sourceoforder?: string
}

// Personal email providers → "Social". Anything else → "Corporate".
// (docs/admin-customers-filters-audit.md B.3)
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'me.com', 'msn.com', 'live.com', 'mac.com', 'ymail.com', 'rocketmail.com',
  'googlemail.com', 'protonmail.com', 'proton.me', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'earthlink.net', 'optonline.net',
])
function isSocial(email?: string): boolean {
  const d = (email || '').split('@')[1]?.toLowerCase().trim()
  return !!d && PERSONAL_DOMAINS.has(d)
}
function custType(email?: string): 'Corporate' | 'Social' {
  return isSocial(email) ? 'Social' : 'Corporate'
}

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)
}

// US states + DC, alphabetical by full name; value = 2-letter code (FM stores
// restaurant address.state as a 2-letter code — add-restaurant maxLength 2).
const US_STATES: { name: string; code: string }[] = [
  { name: 'Alabama', code: 'AL' }, { name: 'Alaska', code: 'AK' }, { name: 'Arizona', code: 'AZ' },
  { name: 'Arkansas', code: 'AR' }, { name: 'California', code: 'CA' }, { name: 'Colorado', code: 'CO' },
  { name: 'Connecticut', code: 'CT' }, { name: 'Delaware', code: 'DE' }, { name: 'District of Columbia', code: 'DC' },
  { name: 'Florida', code: 'FL' }, { name: 'Georgia', code: 'GA' }, { name: 'Hawaii', code: 'HI' },
  { name: 'Idaho', code: 'ID' }, { name: 'Illinois', code: 'IL' }, { name: 'Indiana', code: 'IN' },
  { name: 'Iowa', code: 'IA' }, { name: 'Kansas', code: 'KS' }, { name: 'Kentucky', code: 'KY' },
  { name: 'Louisiana', code: 'LA' }, { name: 'Maine', code: 'ME' }, { name: 'Maryland', code: 'MD' },
  { name: 'Massachusetts', code: 'MA' }, { name: 'Michigan', code: 'MI' }, { name: 'Minnesota', code: 'MN' },
  { name: 'Mississippi', code: 'MS' }, { name: 'Missouri', code: 'MO' }, { name: 'Montana', code: 'MT' },
  { name: 'Nebraska', code: 'NE' }, { name: 'Nevada', code: 'NV' }, { name: 'New Hampshire', code: 'NH' },
  { name: 'New Jersey', code: 'NJ' }, { name: 'New Mexico', code: 'NM' }, { name: 'New York', code: 'NY' },
  { name: 'North Carolina', code: 'NC' }, { name: 'North Dakota', code: 'ND' }, { name: 'Ohio', code: 'OH' },
  { name: 'Oklahoma', code: 'OK' }, { name: 'Oregon', code: 'OR' }, { name: 'Pennsylvania', code: 'PA' },
  { name: 'Rhode Island', code: 'RI' }, { name: 'South Carolina', code: 'SC' }, { name: 'South Dakota', code: 'SD' },
  { name: 'Tennessee', code: 'TN' }, { name: 'Texas', code: 'TX' }, { name: 'Utah', code: 'UT' },
  { name: 'Vermont', code: 'VT' }, { name: 'Virginia', code: 'VA' }, { name: 'Washington', code: 'WA' },
  { name: 'West Virginia', code: 'WV' }, { name: 'Wisconsin', code: 'WI' }, { name: 'Wyoming', code: 'WY' },
]

// Orders list join key. FM's /api/admin/userOrders items expose firstName +
// lastName (no email / customer ref — confirmed in admin-orders-table.html), so
// we join orders→customers by normalized name (customers list `username`).
function normalizeName(s?: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

interface CustomerLoc { states: Set<string>; zips: Set<string> }

type SortKey = 'username' | 'email' | 'phone' | 'source' | 'type' | 'numberOfOrders' | 'totalspend'
// Sort value per column: numbers for orders/spend/phone (phone by leading
// digits ≈ area code), strings otherwise.
function sortValue(r: Customer, key: SortKey): string | number {
  switch (key) {
    case 'username': return (r.username || '').toLowerCase()
    case 'email': return (r.email || '').toLowerCase()
    case 'phone': return Number((r.phoneNumber || '').replace(/\D/g, '')) || 0
    case 'source': return (r.sourceoforder || '').toLowerCase()
    case 'type': return custType(r.email)
    case 'numberOfOrders': return r.numberOfOrders ?? 0
    case 'totalspend': return r.totalspend ?? 0
  }
}

const MAX_PAGES = 50
const FETCH_SIZE = 200

function CustomersInner() {
  const router = useRouter()
  const sp = useSearchParams()

  // Server-side filters (re-fetch FM): name search + last-order date range.
  // The date range only fetches when "Update" is clicked, so the inputs edit a
  // draft (fromInput/toInput) and "applied" (fromDate/toDate) drives load().
  const [searchInput, setSearchInput] = useState(sp.get('search') || '')
  const [search, setSearch] = useState(sp.get('search') || '')
  const [fromInput, setFromInput] = useState(sp.get('fromDate') || '')
  const [toInput, setToInput] = useState(sp.get('toDate') || '')
  const [fromDate, setFromDate] = useState(sp.get('fromDate') || '')
  const [toDate, setToDate] = useState(sp.get('toDate') || '')
  // Client-side filters.
  const [type, setType] = useState<'all' | 'corporate' | 'social'>((sp.get('type') as 'corporate' | 'social') || 'all')
  const [minOrders, setMinOrders] = useState(sp.get('minOrders') || '')
  const [maxOrders, setMaxOrders] = useState(sp.get('maxOrders') || '')

  // Click-to-sort: null = FM's natural return order. One column at a time;
  // click cycles asc → desc → off.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null)

  // Location filters (derived from restaurant addresses via orders).
  const [selectedStates, setSelectedStates] = useState<string[]>(
    (sp.get('states') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  )
  const [zip, setZip] = useState(sp.get('zip') || '')
  const [customerLoc, setCustomerLoc] = useState<Map<string, CustomerLoc>>(new Map())
  const [locLoading, setLocLoading] = useState(false)
  const [locReady, setLocReady] = useState(false)
  const locStartedRef = useRef(false)

  const [rows, setRows] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)

  // Debounce the name search box.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Persist filters to the URL (deep-linkable / survives reload).
  useEffect(() => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (type !== 'all') params.set('type', type)
    if (minOrders) params.set('minOrders', minOrders)
    if (maxOrders) params.set('maxOrders', maxOrders)
    if (fromDate) params.set('fromDate', fromDate)
    if (toDate) params.set('toDate', toDate)
    if (selectedStates.length) params.set('states', selectedStates.join(','))
    if (zip) params.set('zip', zip)
    const qs = params.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [search, type, minOrders, maxOrders, fromDate, toDate, selectedStates, zip, router])

  // Fetch the FULL matching set (all pages, capped) so client filters + export
  // operate over everything, not one server page. Server filters: search + date.
  const load = useCallback(async () => {
    setLoading(true)
    const url = (p: number) => {
      const params = new URLSearchParams()
      if (p > 0) params.set('page', String(p))
      params.set('size', String(FETCH_SIZE))
      if (search) params.set('search', search)
      if (fromDate) params.set('fromDate', fromDate)
      if (toDate) params.set('toDate', toDate)
      return `/api/admin/customers?${params}`
    }
    try {
      const first = await fetch(url(0)).then(r => (r.ok ? r.json() : null))
      if (!first) { setRows([]); setLoading(false); return }
      let all: Customer[] = first.content || []
      const totalPages = Math.min(first.totalPages ?? 1, MAX_PAGES)
      if (totalPages > 1) {
        const rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) => fetch(url(i + 1)).then(r => (r.ok ? r.json() : null))),
        )
        for (const pg of rest) if (pg?.content) all = all.concat(pg.content)
      }
      setRows(all)
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [search, fromDate, toDate])

  useEffect(() => { load() }, [load])

  // Location aggregation (lazy, cached for the session). FM returns no customer
  // address, so we derive location from each order's restaurant address:
  //   restaurant ref → { state, zip }  (GET /api/admin/restaurants)
  //   order → customer name + restaurantReference  (GET /api/admin/userOrders)
  //   customerLoc[name] = { states, zips }
  // Join is by NAME (orders have no email/customer ref on the list).
  const ensureLocData = useCallback(async () => {
    if (locStartedRef.current) return
    locStartedRef.current = true
    setLocLoading(true)
    try {
      const restJson = await fetch('/api/admin/restaurants?size=1000').then(r => (r.ok ? r.json() : null))
      const restMap = new Map<string, { state: string; zip: string }>()
      for (const rr of (restJson?.content || [])) {
        const a = rr.address || {}
        if (!a.state && !a.zipcode) { console.warn('[customers] restaurant missing address, skipped:', rr.reference); continue }
        restMap.set(rr.reference, { state: (a.state || '').toUpperCase(), zip: a.zipcode || '' })
      }
      const ordUrl = (p: number) => {
        const q = new URLSearchParams()
        if (p > 0) q.set('page', String(p))
        q.set('size', String(FETCH_SIZE))
        return `/api/admin/orders?${q}`
      }
      const first = await fetch(ordUrl(0)).then(r => (r.ok ? r.json() : null))
      let orders: { firstName?: string; lastName?: string; restaurantReference?: string }[] = first?.content || []
      const totalPages = Math.min(first?.totalPages ?? 1, MAX_PAGES)
      if (totalPages > 1) {
        const rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) => fetch(ordUrl(i + 1)).then(r => (r.ok ? r.json() : null))),
        )
        for (const pg of rest) if (pg?.content) orders = orders.concat(pg.content)
      }
      const loc = new Map<string, CustomerLoc>()
      for (const o of orders) {
        const r = o.restaurantReference ? restMap.get(o.restaurantReference) : undefined
        if (!r) continue
        const key = normalizeName(`${o.firstName || ''} ${o.lastName || ''}`)
        if (!key) continue
        let e = loc.get(key)
        if (!e) { e = { states: new Set(), zips: new Set() }; loc.set(key, e) }
        if (r.state) e.states.add(r.state)
        if (r.zip) e.zips.add(r.zip)
      }
      setCustomerLoc(loc)
      setLocReady(true)
    } finally {
      setLocLoading(false)
    }
  }, [])

  // Run aggregation on mount only if the URL deep-links a location filter;
  // otherwise it's deferred until the user opens the State/Zip filter.
  useEffect(() => {
    if (selectedStates.length || /^\d{5}$/.test(zip)) ensureLocData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reset to first page whenever the result set changes.
  useEffect(() => { setPage(0) }, [search, fromDate, toDate, type, minOrders, maxOrders, selectedStates, zip, pageSize])

  const zipValid = /^\d{5}$/.test(zip)
  const locActive = selectedStates.length > 0 || zipValid

  const filtered = useMemo(() => rows.filter(r => {
    if (type === 'corporate' && isSocial(r.email)) return false
    if (type === 'social' && !isSocial(r.email)) return false
    const n = r.numberOfOrders ?? 0
    if (minOrders !== '' && n < Number(minOrders)) return false
    if (maxOrders !== '' && n > Number(maxOrders)) return false
    // Location filter only applies once the aggregation is ready, so the list
    // isn't blanked while it loads.
    if (locActive && locReady) {
      const loc = customerLoc.get(normalizeName(r.username))
      if (!loc) return false
      if (selectedStates.length && !selectedStates.some(s => loc.states.has(s))) return false
      if (zipValid && !loc.zips.has(zip)) return false
    }
    return true
  }), [rows, type, minOrders, maxOrders, locActive, locReady, customerLoc, selectedStates, zip, zipValid])

  // Sort the filtered set. null sort → FM's natural order (filtered preserves it).
  const sorted = useMemo(() => {
    if (!sort) return filtered
    const mul = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const va = sortValue(a, sort.key)
      const vb = sortValue(b, sort.key)
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul
      return String(va).localeCompare(String(vb)) * mul
    })
  }, [filtered, sort])

  function toggleSort(key: SortKey) {
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null // third click clears
    })
  }

  const filtersActive = !!search || !!fromDate || !!toDate || type !== 'all' || minOrders !== '' || maxOrders !== '' || locActive
  const datesChanged = fromInput !== fromDate || toInput !== toDate
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize)

  function clearAll() {
    setSearchInput(''); setSearch('')
    setFromInput(''); setToInput(''); setFromDate(''); setToDate('')
    setType('all'); setMinOrders(''); setMaxOrders('')
    setSelectedStates([]); setZip('')
    setSort(null)
  }

  // Export reflects the CURRENT filtered set (all of it, not just the page).
  function exportCsv() {
    const headers = ['Name', 'Email', 'Phone', '# Orders', 'Total Spend', 'Source', 'Type', 'States', 'Zips']
    const body = sorted.map(r => {
      const loc = customerLoc.get(normalizeName(r.username))
      return [
        r.username, r.email, r.phoneNumber || '',
        String(r.numberOfOrders ?? 0), String(r.totalspend ?? 0),
        r.sourceoforder || '', custType(r.email),
        loc ? [...loc.states].sort().join(', ') : '',
        loc ? [...loc.zips].sort().join(', ') : '',
      ]
    })
    const csv = [headers, ...body]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filtersActive ? 'customers-filtered.csv' : 'customers.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Customers</h1>
        <button onClick={exportCsv} disabled={!filtered.length} style={{ ...primaryBtn, opacity: filtered.length ? 1 : 0.5 }}>
          Export CSV{filtersActive ? ' (filtered)' : ''}
        </button>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input type="text" placeholder="Search by name…" value={searchInput} onChange={e => setSearchInput(e.target.value)} style={{ ...inputSt, width: 200 }} />
        <select value={type} onChange={e => setType(e.target.value as 'all' | 'corporate' | 'social')} style={selectSt} aria-label="Type">
          <option value="all">All types</option>
          <option value="corporate">Corporate</option>
          <option value="social">Social</option>
        </select>
        <span style={chipLabel}>Orders</span>
        <input type="number" min={0} placeholder="min" value={minOrders} onChange={e => setMinOrders(e.target.value)} style={{ ...inputSt, width: 70 }} />
        <input type="number" min={0} placeholder="max" value={maxOrders} onChange={e => setMaxOrders(e.target.value)} style={{ ...inputSt, width: 70 }} />
        <StateMultiSelect value={selectedStates} onChange={setSelectedStates} onOpen={ensureLocData} />
        <input
          type="text" inputMode="numeric" placeholder="Zip"
          value={zip}
          onFocus={ensureLocData}
          onChange={e => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
          style={{ ...inputSt, width: 90 }}
          aria-label="Zip code"
        />
        <span style={chipLabel}>Last order</span>
        <input type="date" value={fromInput} onChange={e => setFromInput(e.target.value)} style={inputSt} aria-label="From date" />
        <span style={{ color: '#aaa' }}>–</span>
        <input type="date" value={toInput} onChange={e => setToInput(e.target.value)} style={inputSt} aria-label="To date" />
        <button
          onClick={() => { setFromDate(fromInput); setToDate(toInput) }}
          disabled={!datesChanged || loading}
          style={{ ...updateBtn, ...((!datesChanged || loading) ? updateBtnOff : null) }}>
          Update
        </button>
        {filtersActive && (
          <button onClick={clearAll} style={clearBtn}>Clear All</button>
        )}
      </div>

      {locLoading && (
        <div style={{ fontSize: 12, color: '#6B6EF9', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          Loading location data…
        </div>
      )}
      {filtersActive && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
          Showing {filtered.length} of {rows.length} customers
          {loading && ' · loading…'}
        </div>
      )}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <SortTh label="Name" k="username" sort={sort} onSort={toggleSort} />
              <SortTh label="Email" k="email" sort={sort} onSort={toggleSort} />
              <SortTh label="Phone" k="phone" sort={sort} onSort={toggleSort} />
              <SortTh label="Source" k="source" sort={sort} onSort={toggleSort} />
              <SortTh label="Type" k="type" sort={sort} onSort={toggleSort} />
              <SortTh label="# Orders" k="numberOfOrders" sort={sort} onSort={toggleSort} align="right" />
              <SortTh label="Total Spend" k="totalspend" sort={sort} onSort={toggleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !pageRows.length && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>No customers.</td></tr>}
            {!loading && pageRows.map(r => (
              <tr key={r.customerReference}>
                <td style={{ ...cell, fontWeight: 500 }}>{r.username}</td>
                <td style={{ ...cell, color: '#555' }}>{r.email}</td>
                <td style={{ ...cell, color: '#666' }}>{r.phoneNumber || '—'}</td>
                <td style={{ ...cell, color: '#666' }}>{r.sourceoforder || '—'}</td>
                <td style={{ ...cell, color: '#666' }}>{custType(r.email)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{r.numberOfOrders ?? 0}</td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(r.totalspend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{filtered.length} customer{filtered.length === 1 ? '' : 's'}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} style={smallSelect}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
    </div>
  )
}

export default function AdminCustomersPage() {
  return (
    <Suspense fallback={<div style={{ padding: 32, fontFamily: F, color: '#999' }}>Loading…</div>}>
      <CustomersInner />
    </Suspense>
  )
}

function SortTh({ label, k, sort, onSort, align }: {
  label: string; k: SortKey
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null
  onSort: (k: SortKey) => void
  align?: 'right'
}) {
  const active = sort?.key === k
  const arrow = active ? (sort!.dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th onClick={() => onSort(k)} title="Click to sort"
      style={{ ...colHead, textAlign: align || 'left', cursor: 'pointer', userSelect: 'none', color: active ? DARK : '#888' }}>
      {label}{arrow}
    </th>
  )
}

function StateMultiSelect({ value, onChange, onOpen }: { value: string[]; onChange: (v: string[]) => void; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  const label = value.length === 0
    ? 'All States'
    : value.length <= 2 ? value.join(', ') : `${value.slice(0, 2).join(', ')} +${value.length - 2} more`
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => { const n = !open; setOpen(n); if (n) onOpen() }} style={{ ...selectSt, cursor: 'pointer', minWidth: 120, textAlign: 'left' }}>
        {label} ▾
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 41, background: '#fff', border: '1px solid #eee', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', maxHeight: 300, overflow: 'auto', minWidth: 210, padding: 6 }}>
            <button onClick={() => onChange([])}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: F, fontWeight: 600, color: value.length === 0 ? BLUE : '#555' }}>
              All States
            </button>
            {US_STATES.map(s => {
              const on = value.includes(s.code)
              return (
                <label key={s.code} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13, color: DARK }}>
                  <input type="checkbox" checked={on}
                    onChange={() => onChange(on ? value.filter(x => x !== s.code) : [...value, s.code])}
                    style={{ accentColor: BLUE }} />
                  {s.name} <span style={{ color: '#aaa' }}>({s.code})</span>
                </label>
              )
            })}
          </div>
        </>
      )}
    </span>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const chipLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#888' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const clearBtn: React.CSSProperties = { background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: '#555' }
const updateBtn: React.CSSProperties = { background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F }
const updateBtnOff: React.CSSProperties = { background: '#e8e8e8', color: '#bbb', cursor: 'not-allowed' }
const primaryBtn: React.CSSProperties = { padding: '9px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
