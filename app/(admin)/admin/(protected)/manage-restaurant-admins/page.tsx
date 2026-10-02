'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'

// Super Admin → Admins. Every ADMIN and the restaurant(s) they can reach.
//
// READ ONLY, deliberately. It reports the settled reach model rather than
// offering to change it — an ADMIN reaches their own location, and this screen
// exists so the gaps are visible, not so they can be edited here.
//
// The sibling System Admins page covers SYSTEM_ADMINs, which this one excludes:
// between them they account for every person who can sign into a restaurant
// portal.

const DARK = '#1A1028'
const F = "'DM Sans', sans-serif"

interface AdminRow {
  email: string
  name: string
  source: 'DISCO' | 'FM' | 'BOTH'
  hasDiscoPassword: boolean
  restaurants: { reference: string; name: string | null; isDiscoNative: boolean }[]
  extraGrants: number
}
interface Totals { admins: number; withDiscoPassword: number; fmOnly: number; multiLocation: number }

const cell: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid #f0f0f0', fontSize: 13.5, verticalAlign: 'top' }
const colHead: React.CSSProperties = { padding: '9px 12px', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#777', borderBottom: '1px solid #e5e5e5', textAlign: 'left', background: '#fafafc' }
const pill = (bg: string, fg: string): React.CSSProperties => ({ display: 'inline-block', fontSize: 10, fontWeight: 700, letterSpacing: 0.3, padding: '2px 6px', borderRadius: 4, background: bg, color: fg })

export default function AdminsPage() {
  const [rows, setRows] = useState<AdminRow[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [onlyNoPassword, setOnlyNoPassword] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/restaurant-admins')
      if (!res.ok) { setError('Could not load admins.'); return }
      const d = await res.json()
      setRows(Array.isArray(d?.admins) ? d.admins : [])
      setTotals(d?.totals ?? null)
    } catch { setError('Could not load admins.') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase()
    return rows.filter(r => {
      if (onlyNoPassword && r.hasDiscoPassword) return false
      if (!term) return true
      return (r.name + ' ' + r.email + ' ' + r.restaurants.map(x => x.name || '').join(' ')).toLowerCase().includes(term)
    })
  }, [rows, q, onlyNoPassword])

  return (
    <div style={{ fontFamily: F, padding: '28px 30px', maxWidth: 1200 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Admins</h1>
      <p style={{ fontSize: 13.5, color: '#777', margin: '0 0 18px', maxWidth: '72ch', lineHeight: 1.6 }}>
        Every restaurant <strong>admin</strong> and the location they can reach. System admins are on their own
        page — an admin reaches one location, their own, so this list is one row per person with the restaurants
        each is named on.
      </p>

      {totals && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, padding: '14px 18px', background: '#f7f8fb', border: '1px solid #e6e8f0', borderRadius: 10, marginBottom: 18 }}>
          {[
            ['Admins', totals.admins, ''],
            ['With a Disco password', totals.withDiscoPassword, 'can sign in without FamilyMeal'],
            ['FamilyMeal only', totals.fmOnly, 'no Disco Cater account yet'],
            ['Named on 2+ restaurants', totals.multiLocation, ''],
          ].map(([label, value, note]) => (
            <div key={String(label)} style={{ minWidth: 130 }}>
              <div style={{ fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#888', marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 21, fontWeight: 700, color: DARK }}>{String(value)}</div>
              {note && <div style={{ fontSize: 11.5, color: '#999', marginTop: 2 }}>{note}</div>}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, email or restaurant…"
          style={{ flex: '1 1 260px', minWidth: 200, padding: '9px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13.5, fontFamily: F }} />
        <button onClick={() => setOnlyNoPassword(v => !v)}
          style={{ padding: '8px 14px', borderRadius: 999, border: `1px solid ${onlyNoPassword ? '#5B6FE8' : '#ddd'}`, background: onlyNoPassword ? '#5B6FE8' : '#fff', color: onlyNoPassword ? '#fff' : '#555', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
          No Disco password
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#999' }}>{shown.length} of {rows.length}</span>
      </div>

      {error && <div style={{ padding: 12, background: '#fdecea', border: '1px solid #f5c6c2', borderRadius: 8, color: '#8a2a21', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={colHead}>Name</th>
              <th style={colHead}>Email</th>
              <th style={colHead}>Source</th>
              <th style={colHead}>Disco password</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Restaurants</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !shown.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>No admins match.</td></tr>}
            {!loading && shown.map(u => (
              <tr key={u.email}>
                <td style={{ ...cell, fontWeight: 600, color: DARK }}>{u.name}</td>
                <td style={{ ...cell, color: '#555' }}>{u.email}</td>
                <td style={cell}>
                  {u.source === 'DISCO' && <span style={pill('#eef0ff', '#4a4fd0')}>DISCO</span>}
                  {u.source === 'FM' && <span style={pill('#f3f3f3', '#777')}>FAMILYMEAL</span>}
                  {u.source === 'BOTH' && <span style={pill('#fbeffb', '#9c3aa3')}>BOTH</span>}
                </td>
                <td style={cell}>
                  {u.hasDiscoPassword
                    ? <span style={pill('#e8f5ee', '#0F7B4F')}>YES</span>
                    : <span title="Signs in through FamilyMeal — their restaurant can still be administered" style={{ ...pill('#f3f3f3', '#999'), cursor: 'help' }}>VIA FAMILYMEAL</span>}
                </td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  <div style={{ fontWeight: 700 }}>{u.restaurants.length}</div>
                  {u.restaurants.length > 0 && (
                    <div style={{ fontSize: 11.5, color: '#999', lineHeight: 1.4, marginTop: 2, whiteSpace: 'normal', maxWidth: 420 }}
                      title={u.restaurants.map(r => r.name || r.reference).join('\n')}>
                      {u.restaurants.slice(0, 3).map(r => r.name || r.reference.slice(0, 8)).join(', ')}
                      {u.restaurants.length > 3 ? `, +${u.restaurants.length - 3} more` : ''}
                    </div>
                  )}
                  {u.extraGrants > 0 && (
                    <div title="Grant rows beyond their own location. An ADMIN's reach is their own location regardless of grants, so these do not widen it — worth a look."
                      style={{ fontSize: 11, color: '#9A6212', marginTop: 3, cursor: 'help' }}>
                      +{u.extraGrants} unused grant{u.extraGrants === 1 ? '' : 's'}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
