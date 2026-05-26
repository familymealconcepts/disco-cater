'use client'
import { useState, useEffect } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface TaxEntry {
  fixedAmount: number
  percent: number
}

interface OtherTaxEntry extends TaxEntry {
  types: unknown[]
}

interface TaxRate {
  stateSalesTax: TaxEntry
  localSalesTax: TaxEntry
  otherSalesTax: OtherTaxEntry
}

const DEFAULT_TAX: TaxRate = {
  stateSalesTax: { fixedAmount: 0, percent: 0 },
  localSalesTax: { fixedAmount: 0, percent: 0 },
  otherSalesTax: { fixedAmount: 0, percent: 0, types: [] },
}

interface EditState {
  row: 'stateSalesTax' | 'localSalesTax' | 'otherSalesTax'
  percent: string
  fixedAmount: string
  types: string
}

function fmt2(n: number) { return n.toFixed(2) }
function fmt3(n: number) { return n.toFixed(3) }

export default function TaxRatePage() {
  const [taxRate, setTaxRate] = useState<TaxRate>(DEFAULT_TAX)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    fetch('/api/restaurant/tax-rate')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) setTaxRate(d)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  function openEdit(row: EditState['row']) {
    const entry = taxRate[row]
    setEdit({
      row,
      percent: String(entry.percent),
      fixedAmount: String(entry.fixedAmount),
      types: row === 'otherSalesTax' ? JSON.stringify((taxRate.otherSalesTax).types || []) : '[]',
    })
    setError('')
    setSuccess('')
  }

  async function saveEdit() {
    if (!edit) return
    setSaving(true)
    setError('')
    const updated: TaxRate = {
      ...taxRate,
      [edit.row]: {
        ...taxRate[edit.row],
        percent: parseFloat(edit.percent) || 0,
        fixedAmount: parseFloat(edit.fixedAmount) || 0,
        ...(edit.row === 'otherSalesTax' ? { types: (() => { try { return JSON.parse(edit.types) } catch { return [] } })() } : {}),
      },
    }
    try {
      const res = await fetch('/api/restaurant/tax-rate', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      })
      if (!res.ok) {
        setError('Failed to save. Please try again.')
      } else {
        setTaxRate(updated)
        setEdit(null)
        setSuccess('Tax rate updated.')
        setTimeout(() => setSuccess(''), 3000)
      }
    } catch {
      setError('Network error. Please try again.')
    }
    setSaving(false)
  }

  const totalPercent = (taxRate.stateSalesTax.percent || 0) +
    (taxRate.localSalesTax.percent || 0) +
    (taxRate.otherSalesTax.percent || 0)
  const totalFixed = (taxRate.stateSalesTax.fixedAmount || 0) +
    (taxRate.localSalesTax.fixedAmount || 0) +
    (taxRate.otherSalesTax.fixedAmount || 0)

  const colHead: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: '#888',
    padding: '10px 12px', borderBottom: '1px solid #f0f0f0',
    textAlign: 'left', textTransform: 'uppercase', background: '#F7F8FC',
  }
  const cell: React.CSSProperties = { fontSize: 13, color: DARK, padding: '12px' }

  const rows: { key: EditState['row']; label: string }[] = [
    { key: 'stateSalesTax', label: 'State Sales Tax' },
    { key: 'localSalesTax', label: 'Local Sales Tax' },
    { key: 'otherSalesTax', label: 'Other Sales Tax' },
  ]

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 8px' }}>Tax Rate</h1>
      <p style={{ fontSize: 13, color: '#666', margin: '0 0 24px', lineHeight: 1.6, maxWidth: 640 }}>
        You are responsible for ensuring that your tax rate is an accurate summation of the taxes applicable for your restaurant.
      </p>

      {success && (
        <div style={{ background: '#E8F5E9', border: '1px solid #A5D6A7', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#2E7D32' }}>
          {success}
        </div>
      )}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={colHead}>Name</th>
                <th style={{ ...colHead, textAlign: 'right' }}>Tax Rate (%)</th>
                <th style={{ ...colHead, textAlign: 'right' }}>Tax Rate ($)</th>
                <th style={{ ...colHead, width: 48 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, label }) => (
                <tr key={key} style={{ borderTop: '1px solid #f5f5f5' }}>
                  <td style={cell}>{label}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{fmt3(taxRate[key].percent || 0)}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{fmt2(taxRate[key].fixedAmount || 0)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                    <button
                      onClick={() => openEdit(key)}
                      title="Edit"
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', color: '#aaa',
                        fontSize: 14, padding: '4px 6px', borderRadius: 6, lineHeight: 1,
                        transition: 'color 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = BLUE)}
                      onMouseLeave={e => (e.currentTarget.style.color = '#aaa')}
                    >
                      ✎
                    </button>
                  </td>
                </tr>
              ))}
              {/* Totals row */}
              <tr style={{ borderTop: '2px solid #e8e8e8', background: '#fafafa' }}>
                <td style={{ ...cell, fontWeight: 700 }}>Total</td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{fmt3(totalPercent)}</td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{fmt2(totalFixed)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 420, width: '90%', fontFamily: F }}>
            <h3 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: DARK }}>
              Edit {rows.find(r => r.key === edit.row)?.label}
            </h3>

            {error && (
              <div style={{ background: '#FFF0F0', border: '1px solid #FFCDD2', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13, color: '#C62828' }}>
                {error}
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>
                Tax Rate (%)
              </label>
              <input
                type="number"
                step="0.001"
                value={edit.percent}
                onChange={e => setEdit({ ...edit, percent: e.target.value })}
                style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none' }}
              />
            </div>

            <div style={{ marginBottom: edit.row === 'otherSalesTax' ? 14 : 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>
                Tax Rate ($)
              </label>
              <input
                type="number"
                step="0.01"
                value={edit.fixedAmount}
                onChange={e => setEdit({ ...edit, fixedAmount: e.target.value })}
                style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none' }}
              />
            </div>

            {edit.row === 'otherSalesTax' && (
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>
                  Types (JSON)
                </label>
                <textarea
                  value={edit.types}
                  onChange={e => setEdit({ ...edit, types: e.target.value })}
                  rows={3}
                  style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 12, fontFamily: 'monospace', outline: 'none', resize: 'vertical' }}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setEdit(null)}
                style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, cursor: saving ? 'default' : 'pointer', fontFamily: F, fontWeight: 600, opacity: saving ? 0.7 : 1 }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
