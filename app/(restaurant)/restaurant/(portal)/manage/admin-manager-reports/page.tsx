'use client'
import { useState, useEffect, useCallback } from 'react'
import { confirmDialog } from '../../../../../components/ui/feedback'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

type Tab = 'scheduled' | 'log'

interface ScheduledReport {
  reference: string
  name: string
  frequency: string
  time: string
  timezone: string
}

interface ReportRun {
  reference?: string
  reportName: string
  fileType: string
  runStatus: string
  createdDate?: string
}

interface LocationOption { reference: string; businessName: string }

interface ReportColumn { category: string; key: string; displayLabel: string }

interface ReportPayload {
  reference?: string
  name?: string
  frequency: 'WEEKLY' | 'MONTHLY'
  time: string
  timezone: string
  fileType: 'CSV' | 'PDF'
  columns: string[]
  recipients: string[]
  ownerReferences: string[]
  filter: {
    reference?: string
    dateType: 'orderDate' | 'createdDate'
    orderStatuses: string[]
    deliveryTypes: string[]
    locationReferenceIds: string[]
  }
}

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Phoenix', label: 'Mountain Time - Arizona' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HAT)' },
]

const ORDER_STATUSES = ['COMPLETED','REFUND','REFUNDED','IN_PROGRESS','CANCELED','RESERVED','EXPIRED','DUE','VOID','VOIDED','UNPAID','PAID']
const FULFILLMENT_TYPES = ['PICKUP','OWN_DELIVERY','DLIVRD_DELIVERY']

function fmtTime12(t?: string) {
  if (!t) return ''
  const parts = t.split(':')
  const h = parseInt(parts[0] || '0', 10)
  const m = parts[1] || '00'
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

// The scheduled-reports UI body (tabs + content + editor) without any page
// chrome. Rendered both by this page and embedded at the bottom of the
// Reporting (dashboard) page.
export function ScheduledReportsPanel() {
  const [tab, setTab] = useState<Tab>('scheduled')
  const [editing, setEditing] = useState<ReportPayload | null>(null)

  return (
    <div style={{ fontFamily: F }}>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e6e6e6', marginBottom: 20 }}>
        <TabBtn label="Scheduled Reports" active={tab === 'scheduled'} onClick={() => setTab('scheduled')} />
        <TabBtn label="Reports Log" active={tab === 'log'} onClick={() => setTab('log')} />
      </div>

      {tab === 'scheduled' && (
        <ScheduledTab onEdit={setEditing} onCreate={() => setEditing(emptyReport())} />
      )}
      {tab === 'log' && <LogTab />}

      {editing && (
        <ReportEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null) }}
        />
      )}
    </div>
  )
}

// Standalone Reports page. No longer linked in the sidebar (the panel now lives
// at the bottom of Reporting), but kept reachable by direct URL.
export default function ReportsPage() {
  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 16px' }}>Reports</h1>
      <ScheduledReportsPanel />
    </div>
  )
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        padding: '10px 18px', fontSize: 13, fontWeight: 600, fontFamily: F,
        color: active ? BLUE : '#888',
        borderBottom: `2px solid ${active ? BLUE : 'transparent'}`,
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  )
}

function emptyReport(): ReportPayload {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return {
    name: '',
    frequency: 'WEEKLY',
    time: `${hh}:${mm}`,
    timezone: 'America/New_York',
    fileType: 'CSV',
    columns: [],
    recipients: [],
    ownerReferences: [],
    filter: {
      dateType: 'createdDate',
      orderStatuses: [...ORDER_STATUSES],
      deliveryTypes: [...FULFILLMENT_TYPES],
      locationReferenceIds: [],
    },
  }
}

// ── Scheduled Reports Tab ────────────────────────────────────────────────────

function ScheduledTab({ onEdit, onCreate }: { onEdit: (r: ReportPayload) => void; onCreate: () => void }) {
  const [reports, setReports] = useState<ScheduledReport[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(pageSize))
    const res = await fetch(`/api/restaurant/reports/scheduled?${params}`)
    if (res.ok) {
      const d = await res.json()
      setReports(d.content || [])
      setTotal(d.totalElements || 0)
    }
    setLoading(false)
  }, [page, pageSize])

  useEffect(() => { load() }, [load])

  async function startEdit(ref: string) {
    const res = await fetch(`/api/restaurant/reports/scheduled/${ref}`)
    if (res.ok) {
      const r = await res.json()
      onEdit(normalizeIncoming(r))
    }
  }

  async function deleteReport(ref: string, name: string) {
    if (!(await confirmDialog(`Delete scheduled report "${name}"?`, { title: 'Delete report', confirmText: 'Delete', danger: true }))) return
    const res = await fetch(`/api/restaurant/reports/scheduled/${ref}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={onCreate} style={primaryBtn}>+ Schedule a report</button>
      </div>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={colHead}>Name</th>
              <th style={colHead}>Frequency</th>
              <th style={colHead}>Time</th>
              <th style={colHead}>Timezone</th>
              <th style={{ ...colHead, textAlign: 'right', width: 210 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !reports.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>No scheduled reports.</td></tr>}
            {!loading && reports.map(r => (
              <tr key={r.reference}>
                <td style={cell}>{r.name}</td>
                <td style={cell}>{r.frequency}</td>
                <td style={cell}>{fmtTime12(r.time)}</td>
                <td style={{ ...cell, color: '#666' }}>{r.timezone}</td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  <a href={`/api/restaurant/reports/scheduled/${r.reference}/download`} target="_blank" rel="noopener noreferrer" style={{ ...linkBtn, textDecoration: 'none', display: 'inline-block' }}>Download</a>
                  <button onClick={() => startEdit(r.reference)} style={linkBtn}>Edit</button>
                  <button onClick={() => deleteReport(r.reference, r.name)} style={{ ...linkBtn, color: '#E76F51' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} total={total} totalPages={totalPages} setPage={setPage} setPageSize={setPageSize} />
    </>
  )
}

function normalizeIncoming(r: Record<string, unknown>): ReportPayload {
  const filter = (r.filter as Record<string, unknown>) || {}
  return {
    reference: (r.reference as string) || undefined,
    name: (r.name as string) || '',
    frequency: ((r.frequency as 'WEEKLY' | 'MONTHLY') || 'WEEKLY'),
    time: (r.time as string) || '09:00',
    timezone: (r.timezone as string) || 'America/New_York',
    fileType: ((r.fileType as 'CSV' | 'PDF') || 'CSV'),
    columns: Array.isArray(r.columns) ? r.columns as string[] : [],
    recipients: Array.isArray(r.recipients) ? r.recipients as string[] : [],
    ownerReferences: Array.isArray(r.ownerReferences) ? r.ownerReferences as string[] : [],
    filter: {
      reference: (filter.reference as string) || undefined,
      dateType: ((filter.dateType as 'orderDate' | 'createdDate') || 'createdDate'),
      orderStatuses: Array.isArray(filter.orderStatuses) ? filter.orderStatuses as string[] : [...ORDER_STATUSES],
      deliveryTypes: Array.isArray(filter.deliveryTypes) ? filter.deliveryTypes as string[] : [...FULFILLMENT_TYPES],
      locationReferenceIds: Array.isArray(filter.locationReferenceIds) ? filter.locationReferenceIds as string[] : [],
    },
  }
}

// ── Reports Log Tab ──────────────────────────────────────────────────────────

function LogTab() {
  const [runs, setRuns] = useState<ReportRun[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(pageSize))
    const res = await fetch(`/api/restaurant/reports/runs?${params}`)
    if (res.ok) {
      const d = await res.json()
      setRuns(d.content || [])
      setTotal(d.totalElements || 0)
    }
    setLoading(false)
  }, [page, pageSize])

  useEffect(() => { load() }, [load])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={colHead}>Name</th>
              <th style={colHead}>Type</th>
              <th style={colHead}>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={3} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !runs.length && <tr><td colSpan={3} style={{ ...cell, textAlign: 'center', color: '#999' }}>No report runs.</td></tr>}
            {!loading && runs.map((r, i) => (
              <tr key={r.reference || i}>
                <td style={cell}>{r.reportName}</td>
                <td style={cell}>{r.fileType}</td>
                <td style={cell}>
                  <span style={statusPill(r.runStatus)}>{r.runStatus}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} total={total} totalPages={totalPages} setPage={setPage} setPageSize={setPageSize} />
    </>
  )
}

function statusPill(s?: string): React.CSSProperties {
  const status = (s || '').toUpperCase()
  const colors = status === 'DELIVERED' || status === 'SUCCESS'
    ? { bg: '#E8F5E9', fg: '#2E7D32' }
    : status === 'FAILED' || status === 'ERROR'
    ? { bg: '#FFF0F0', fg: '#C62828' }
    : { bg: '#F3F4F6', fg: '#555' }
  return {
    display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
    background: colors.bg, color: colors.fg,
  }
}

// ── Report Editor (Create / Edit) ───────────────────────────────────────────

function ReportEditor({ initial, onClose, onSaved }: { initial: ReportPayload; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ReportPayload>(initial)
  const [locations, setLocations] = useState<LocationOption[]>([])
  const [columns, setColumns] = useState<ReportColumn[]>([])
  const [emailInput, setEmailInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/restaurant/locations?size=1000')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.content) {
          setLocations(d.content.map((l: { reference: string; businessName: string }) => ({
            reference: l.reference, businessName: l.businessName,
          })))
        }
      })
      .catch(() => {})
    fetch('/api/restaurant/reports/columns')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (Array.isArray(d)) setColumns(d)
        else if (Array.isArray(d?.content)) setColumns(d.content)
      })
      .catch(() => {})
  }, [])

  // Default: select all columns on initial load if none selected
  useEffect(() => {
    if (!columns.length || form.columns.length) return
    setForm(f => ({ ...f, columns: columns.map(c => c.key) }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns])

  function addRecipient() {
    const e = emailInput.trim()
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setError('Enter a valid email'); return }
    if (form.recipients.includes(e)) { setEmailInput(''); return }
    setForm(f => ({ ...f, recipients: [...f.recipients, e] }))
    setEmailInput('')
    setError('')
  }

  function toggleArr<T extends string>(field: 'orderStatuses' | 'deliveryTypes' | 'locationReferenceIds', val: T) {
    setForm(f => {
      const arr = f.filter[field]
      const next = arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val]
      return { ...f, filter: { ...f.filter, [field]: next } }
    })
  }

  function toggleColumn(key: string) {
    setForm(f => {
      const arr = f.columns
      const next = arr.includes(key) ? arr.filter(x => x !== key) : [...arr, key]
      return { ...f, columns: next }
    })
  }

  async function save() {
    if (!form.recipients.length) { setError('At least one email recipient is required'); return }
    setSaving(true)
    setError('')
    const url = form.reference
      ? `/api/restaurant/reports/scheduled/${form.reference}`
      : '/api/restaurant/reports/scheduled'
    const method = form.reference ? 'PUT' : 'POST'

    const generatedName = form.name?.trim() || `${form.frequency}_SALES_SUMMARY_${formatNameStamp()}`

    // FM sets ownerReferences to the logged-in user's reference
    // (scheduled-report-option-create-update.component.ts:273 —
    //  ownerReferences: [customer?.reference], customer = localStorage
    //  'currentUser'). Disco stores the same login payload as
    //  'restaurant_user'. Sending an empty array makes FM reject the
    //  create with a 4xx ("Save failed").
    let ownerReferences = form.ownerReferences
    if (!ownerReferences?.length) {
      try {
        const u = JSON.parse(localStorage.getItem('restaurant_user') || '{}')
        if (u?.reference) ownerReferences = [u.reference]
      } catch { /* ignore */ }
    }

    // FM defaults locationReferenceIds to ALL of the user's restaurants
    // when none are explicitly checked (component.ts:268).
    const locationReferenceIds = form.filter.locationReferenceIds.length
      ? form.filter.locationReferenceIds
      : locations.map(l => l.reference)

    const payload: ReportPayload = {
      ...form,
      name: generatedName,
      ownerReferences,
      filter: { ...form.filter, locationReferenceIds },
    }

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    if (res.ok) { onSaved() }
    else { const d = await res.json().catch(() => ({})); setError(d?.error || 'Save failed') }
  }

  const grouped = groupByCategory(columns)

  return (
    <div style={modalBackdrop}>
      <div style={{ ...modalBody, maxWidth: 720, maxHeight: '90vh', overflow: 'auto' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700, color: DARK }}>
          {form.reference ? 'Edit Scheduled Report' : 'Schedule a Report'}
        </h3>

        {/* Name */}
        <Field label="Report name (optional — auto-generated if blank)">
          <input style={inputSt} value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </Field>

        {/* Frequency + Time + Timezone row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
          <Field label="Frequency*">
            <select style={inputSt} value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value as 'WEEKLY' | 'MONTHLY' }))}>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
            </select>
          </Field>
          <Field label="Delivery time*">
            <input type="time" style={inputSt} value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} />
          </Field>
          <Field label="Timezone*">
            <select style={inputSt} value={form.timezone} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}>
              {TIMEZONES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </div>

        {/* File type */}
        <Field label="File type*">
          <div style={{ display: 'flex', gap: 14 }}>
            {(['CSV', 'PDF'] as const).map(ft => (
              <label key={ft} style={radioLabel}>
                <input type="radio" name="fileType" value={ft} checked={form.fileType === ft} onChange={() => setForm(f => ({ ...f, fileType: ft }))} />
                {ft}
              </label>
            ))}
          </div>
        </Field>

        {/* Recipients */}
        <Field label="Email recipients*">
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input
              style={{ ...inputSt, flex: 1 }}
              type="email"
              placeholder="name@example.com"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRecipient() } }}
            />
            <button onClick={addRecipient} style={secondaryBtn}>Add</button>
          </div>
          {form.recipients.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {form.recipients.map(e => (
                <span key={e} style={chip}>
                  {e}
                  <button onClick={() => setForm(f => ({ ...f, recipients: f.recipients.filter(r => r !== e) }))}
                    style={chipClose}>×</button>
                </span>
              ))}
            </div>
          )}
        </Field>

        {/* Locations */}
        <Field label="Restaurants (leave empty for all)">
          <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
            {locations.map(l => (
              <label key={l.reference} style={checkLabel}>
                <input
                  type="checkbox"
                  checked={form.filter.locationReferenceIds.includes(l.reference)}
                  onChange={() => toggleArr('locationReferenceIds', l.reference)}
                />
                {l.businessName}
              </label>
            ))}
            {!locations.length && <div style={{ color: '#aaa', fontSize: 12 }}>Loading locations…</div>}
          </div>
        </Field>

        {/* Date type */}
        <Field label="Date filter type*">
          <div style={{ display: 'flex', gap: 14 }}>
            {(['createdDate', 'orderDate'] as const).map(dt => (
              <label key={dt} style={radioLabel}>
                <input type="radio" name="dateType" value={dt} checked={form.filter.dateType === dt}
                  onChange={() => setForm(f => ({ ...f, filter: { ...f.filter, dateType: dt } }))} />
                {dt === 'createdDate' ? 'Created Date' : 'Order Date'}
              </label>
            ))}
          </div>
        </Field>

        {/* Order statuses */}
        <Field label="Order statuses">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ORDER_STATUSES.map(s => (
              <label key={s} style={checkLabel}>
                <input type="checkbox" checked={form.filter.orderStatuses.includes(s)} onChange={() => toggleArr('orderStatuses', s)} />
                {s}
              </label>
            ))}
          </div>
        </Field>

        {/* Fulfillment types */}
        <Field label="Fulfillment types">
          <div style={{ display: 'flex', gap: 12 }}>
            {FULFILLMENT_TYPES.map(t => (
              <label key={t} style={checkLabel}>
                <input type="checkbox" checked={form.filter.deliveryTypes.includes(t)} onChange={() => toggleArr('deliveryTypes', t)} />
                {t.replace(/_/g, ' ')}
              </label>
            ))}
          </div>
        </Field>

        {/* Columns */}
        <Field label="Columns to include">
          {Object.keys(grouped).length === 0 && (
            <div style={{ color: '#aaa', fontSize: 12 }}>Loading columns…</div>
          )}
          {Object.entries(grouped).map(([cat, cols]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#666', textTransform: 'uppercase', marginBottom: 6 }}>{cat}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {cols.map(c => (
                  <label key={c.key} style={checkLabel}>
                    <input type="checkbox" checked={form.columns.includes(c.key)} onChange={() => toggleColumn(c.key)} />
                    {c.displayLabel}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </Field>

        {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={save} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

function groupByCategory(cols: ReportColumn[]): Record<string, ReportColumn[]> {
  const out: Record<string, ReportColumn[]> = {}
  for (const c of cols) {
    const cat = c.category || 'OTHER'
    if (!out[cat]) out[cat] = []
    out[cat].push(c)
  }
  return out
}

function formatNameStamp(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mm}${dd}${yyyy}_${hh}${min}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  )
}

function Pagination({ page, pageSize, total, totalPages, setPage, setPageSize }: {
  page: number; pageSize: number; total: number; totalPages: number;
  setPage: (n: number) => void; setPageSize: (n: number) => void;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
      <div style={{ fontSize: 12, color: '#666' }}>{total} report{total === 1 ? '' : 's'}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
        <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} style={pageBtn}>‹</button>
        <span>Page {page + 1} of {totalPages}</span>
        <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
        <span>Per page:</span>
        <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }}
          style={{ border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }}>
          {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </div>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%' }
const primaryBtn: React.CSSProperties = { padding: '9px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
const secondaryBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const radioLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: DARK }
const checkLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer', color: DARK, padding: '4px 8px', background: '#f8f8fc', borderRadius: 6 }
const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#f0f1ff', color: BLUE, borderRadius: 12, fontSize: 12, fontWeight: 500 }
const chipClose: React.CSSProperties = { background: 'none', border: 'none', color: BLUE, cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }
const modalBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
const modalBody: React.CSSProperties = { background: '#fff', borderRadius: 14, padding: '28px 32px', width: '100%', fontFamily: F }
