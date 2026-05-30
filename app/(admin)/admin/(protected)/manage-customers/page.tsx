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

// Orders list join key. FM's /api/admin/userOrders items expose firstName +
// lastName (no email / customer ref — confirmed in admin-orders-table.html), so
// we join orders→customers by normalized name (customers list `username`).
function normalizeName(s?: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

interface CustomerLastLoc { city: string; state: string; ts: number }

// FM orderDate is DD.MM.YYYY (DateFormatService); orderTime is HH:mm:ss.
// Combine to an epoch ms so we can pick each customer's most-recent order.
// Returns 0 on invalid input so a malformed entry never beats a valid one.
function parseFmDateTime(date?: string, time?: string): number {
  if (!date) return 0
  const m = date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!m) return 0
  const t = (time || '00:00:00').split(':').map(Number)
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), t[0] || 0, t[1] || 0, t[2] || 0).getTime() || 0
}

// Extract city + state from a Google Place's address_components. state is the
// 2-letter short_name; city falls back through locality → postal_town →
// sublocality → administrative_area_level_3 so most US picks resolve cleanly.
function extractPlaceCityState(place: { address_components?: { types: string[]; long_name: string; short_name: string }[] } | null): { city: string; state: string } | null {
  const comps = place?.address_components || []
  let city = ''
  let state = ''
  for (const c of comps) {
    if (c.types.includes('locality')) city = c.long_name
    else if (!city && (c.types.includes('postal_town') || c.types.includes('sublocality') || c.types.includes('administrative_area_level_3'))) city = c.long_name
    if (c.types.includes('administrative_area_level_1')) state = c.short_name.toUpperCase()
  }
  if (!city && !state) return null
  return { city, state }
}

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

  // Location filter: a Google Place selection → city+state we match against
  // each customer's LAST order's restaurant. FM returns no customer address, so
  // we derive it via orders→restaurants and join orders→customers by name
  // (orders carry no customer ref). URL stores the chosen "City, ST" so the
  // filter is deep-linkable and survives reload.
  const initialPlace = useMemo(() => {
    const v = sp.get('location') || ''
    const m = v.match(/^(.+),\s*([A-Z]{2})$/i)
    return m ? { city: m[1].trim(), state: m[2].toUpperCase(), label: `${m[1].trim()}, ${m[2].toUpperCase()}` } : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [locInput, setLocInput] = useState(initialPlace?.label || '')
  const [placeFilter, setPlaceFilter] = useState<{ city: string; state: string; label: string } | null>(initialPlace)
  const [customerLastLoc, setCustomerLastLoc] = useState<Map<string, CustomerLastLoc>>(new Map())
  const [locLoading, setLocLoading] = useState(false)
  const [locReady, setLocReady] = useState(false)
  const locStartedRef = useRef(false)
  const locInputRef = useRef<HTMLInputElement>(null)
  const autocompleteRef = useRef<any>(null)

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
    if (placeFilter) params.set('location', placeFilter.label)
    const qs = params.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [search, type, minOrders, maxOrders, fromDate, toDate, placeFilter, router])

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
  // address, so we derive each customer's LAST order's location from the order's
  // restaurant city/state:
  //   restaurant ref → { city, state }  (GET /api/admin/restaurants)
  //   order → customer name + restaurantReference + orderDate/Time  (GET /api/admin/userOrders)
  //   customerLastLoc[name] = the city/state of the restaurant on the most
  //                           recent order (by orderDate + orderTime).
  // Join is by NAME (orders have no email/customer ref on the list).
  const ensureLocData = useCallback(async () => {
    if (locStartedRef.current) return
    locStartedRef.current = true
    setLocLoading(true)
    try {
      const restJson = await fetch('/api/admin/restaurants?size=1000').then(r => (r.ok ? r.json() : null))
      const restMap = new Map<string, { city: string; state: string }>()
      for (const rr of (restJson?.content || [])) {
        const a = rr.address || {}
        if (!a.city && !a.state) { console.warn('[customers] restaurant missing city/state, skipped:', rr.reference); continue }
        restMap.set(rr.reference, { city: a.city || '', state: (a.state || '').toUpperCase() })
      }
      const ordUrl = (p: number) => {
        const q = new URLSearchParams()
        if (p > 0) q.set('page', String(p))
        q.set('size', String(FETCH_SIZE))
        return `/api/admin/orders?${q}`
      }
      const first = await fetch(ordUrl(0)).then(r => (r.ok ? r.json() : null))
      let orders: { firstName?: string; lastName?: string; restaurantReference?: string; orderDate?: string; orderTime?: string }[] = first?.content || []
      const totalPages = Math.min(first?.totalPages ?? 1, MAX_PAGES)
      if (totalPages > 1) {
        const rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) => fetch(ordUrl(i + 1)).then(r => (r.ok ? r.json() : null))),
        )
        for (const pg of rest) if (pg?.content) orders = orders.concat(pg.content)
      }
      const last = new Map<string, CustomerLastLoc>()
      for (const o of orders) {
        const r = o.restaurantReference ? restMap.get(o.restaurantReference) : undefined
        if (!r) continue
        const key = normalizeName(`${o.firstName || ''} ${o.lastName || ''}`)
        if (!key) continue
        const ts = parseFmDateTime(o.orderDate, o.orderTime)
        const cur = last.get(key)
        if (!cur || ts > cur.ts) last.set(key, { city: r.city, state: r.state, ts })
      }
      setCustomerLastLoc(last)
      setLocReady(true)
    } finally {
      setLocLoading(false)
    }
  }, [])

  // Loads Google Maps Places SDK (idempotent — single shared script tag) and
  // wires the location input to a Places Autocomplete restricted to US geocodes.
  // Mirrors the homepage pattern (app/(customer)/page.tsx:20-60), inlined here
  // because no shared component exists yet.
  useEffect(() => {
    function init() {
      if (!locInputRef.current || autocompleteRef.current) return
      const g = (window as { google?: { maps?: { places?: { Autocomplete: new (input: HTMLInputElement, opts?: object) => { addListener: (e: string, cb: () => void) => void; getPlace: () => unknown } } } } }).google
      if (!g?.maps?.places) return
      const ac = new g.maps.places.Autocomplete(locInputRef.current, {
        types: ['geocode'],
        componentRestrictions: { country: 'us' },
        fields: ['address_components', 'formatted_address'],
      })
      ac.addListener('place_changed', () => {
        const cs = extractPlaceCityState(ac.getPlace() as { address_components?: { types: string[]; long_name: string; short_name: string }[] })
        if (!cs) return
        const label = cs.city && cs.state ? `${cs.city}, ${cs.state}` : (cs.city || cs.state)
        setPlaceFilter({ city: cs.city, state: cs.state, label })
        setLocInput(label)
        ensureLocData()
      })
      autocompleteRef.current = ac
    }
    if ((window as { google?: { maps?: { places?: unknown } } }).google?.maps?.places) { init(); return }
    if (document.getElementById('google-maps-script')) {
      const poll = setInterval(() => {
        if ((window as { google?: { maps?: { places?: unknown } } }).google?.maps?.places) { clearInterval(poll); init() }
      }, 100)
      return () => clearInterval(poll)
    }
    ;(window as { initGooglePlaces?: () => void }).initGooglePlaces = init
    const s = document.createElement('script')
    s.id = 'google-maps-script'
    s.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places&callback=initGooglePlaces`
    s.async = true; s.defer = true
    document.head.appendChild(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Run aggregation on mount only if the URL deep-links a location filter;
  // otherwise it's deferred until the user picks a place.
  useEffect(() => {
    if (placeFilter) ensureLocData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reset to first page whenever the result set changes.
  useEffect(() => { setPage(0) }, [search, fromDate, toDate, type, minOrders, maxOrders, placeFilter, pageSize])

  const placeActive = !!placeFilter

  const filtered = useMemo(() => rows.filter(r => {
    if (type === 'corporate' && isSocial(r.email)) return false
    if (type === 'social' && !isSocial(r.email)) return false
    const n = r.numberOfOrders ?? 0
    if (minOrders !== '' && n < Number(minOrders)) return false
    if (maxOrders !== '' && n > Number(maxOrders)) return false
    // Location filter only applies once the aggregation is ready, so the list
    // isn't blanked while it loads. Match the customer's LAST order against the
    // picked place's city + state (both case-insensitive; state must match).
    if (placeActive && locReady && placeFilter) {
      const last = customerLastLoc.get(normalizeName(r.username))
      if (!last) return false
      if (placeFilter.state && last.state !== placeFilter.state) return false
      if (placeFilter.city && last.city.toLowerCase() !== placeFilter.city.toLowerCase()) return false
    }
    return true
  }), [rows, type, minOrders, maxOrders, placeActive, locReady, customerLastLoc, placeFilter])

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

  const filtersActive = !!search || !!fromDate || !!toDate || type !== 'all' || minOrders !== '' || maxOrders !== '' || placeActive
  const datesChanged = fromInput !== fromDate || toInput !== toDate
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize)

  function clearAll() {
    setSearchInput(''); setSearch('')
    setFromInput(''); setToInput(''); setFromDate(''); setToDate('')
    setType('all'); setMinOrders(''); setMaxOrders('')
    setLocInput(''); setPlaceFilter(null)
    setSort(null)
  }

  // Export reflects the CURRENT filtered set (all of it, not just the page).
  function exportCsv() {
    const headers = ['Name', 'Email', 'Phone', '# Orders', 'Total Spend', 'Source', 'Type', 'Last order city', 'Last order state']
    const body = sorted.map(r => {
      const last = customerLastLoc.get(normalizeName(r.username))
      return [
        r.username, r.email, r.phoneNumber || '',
        String(r.numberOfOrders ?? 0), String(r.totalspend ?? 0),
        r.sourceoforder || '', custType(r.email),
        last?.city || '',
        last?.state || '',
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
        <input
          ref={locInputRef}
          type="text"
          placeholder="Location (city, state)…"
          value={locInput}
          onFocus={ensureLocData}
          onChange={e => {
            setLocInput(e.target.value)
            // Typing without picking a suggestion clears the active filter —
            // the box is now an unconfirmed search, not the applied place.
            if (placeFilter && e.target.value !== placeFilter.label) setPlaceFilter(null)
          }}
          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
          style={{ ...inputSt, width: 220 }}
          aria-label="Location"
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
