'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const GOLD = '#EFB84A'
const GREEN = '#22C55E'
const RED = '#E53935'
const PAGE_BG = '#F7F8FC'

type Status = 'idle' | 'running' | 'passed' | 'failed' | 'skipped'
interface Step { name: string; status: 'passed' | 'failed' | 'skipped'; detail: string }
interface Result {
  status: Status
  duration?: number
  steps?: Step[]
  testData?: { createdRecords: string[] }
}

interface TestDef { id: string; num: number; name: string; description: string }

const TESTS: TestDef[] = [
  { id: 'test-1', num: 1, name: 'Restaurant Onboarding', description: 'Create restaurant → register Disco account → login → /me → confirm Neon row.' },
  { id: 'test-2', num: 2, name: 'Customer Account Creation', description: 'Register a customer via FM /registration.' },
  { id: 'test-3', num: 3, name: 'Place an Order', description: 'Draft + place a DISCO order (Stripe charge skipped unless configured).' },
  { id: 'test-4', num: 4, name: 'Neon Order Mirror', description: 'Recent disco_orders carry customer_email + order date/time.' },
  { id: 'test-5', num: 5, name: 'Email Configuration', description: 'Mailgun configured; send a test email to your admin address.' },
  { id: 'test-6', num: 6, name: 'Stripe Webhook', description: 'Webhook secret set + disco_stripe_payments populated.' },
  { id: 'test-7', num: 7, name: 'Map Visibility', description: 'Fullmap returns only visible + Stripe-connected restaurants.' },
  { id: 'test-8', num: 8, name: 'Export API', description: 'Customers + orders export endpoints return data.' },
  { id: 'test-9', num: 9, name: 'Slack Notifications', description: 'New-order + partner Slack webhooks configured.' },
  { id: 'test-10', num: 10, name: 'Password Reset Flow', description: 'forgot-password returns 200 (anti-enumeration).' },
  { id: 'test-11', num: 11, name: 'Edit Eligibility Check', description: 'Future order → /edit-status returns { canEdit: true, editCount: 0 }.' },
  { id: 'test-12', num: 12, name: 'Edit — No Payment Delta', description: 'Same items → delta 0, no charge; disco_order_edits audit row written.' },
  { id: 'test-13', num: 13, name: 'Edit Count Enforcement', description: 'Order with edit_count = 3 → POST /edit returns 400 "Maximum edits reached".' },
  { id: 'test-14', num: 14, name: '24-Hour Rule Enforcement', description: 'Pickup < 24hrs → POST /edit returns 400 "within 24 hours of pickup".' },
  { id: 'test-15', num: 15, name: 'Full Platform E2E: Onboard → Order → Edit → Refund', description: 'Sequential flow: customer + restaurant + menu, then a synthetic Neon order (subtotal/total/fee) → charge → Disco-native edit via POST /edit (reschedule + add item, FM read-only) → verify disco_orders Neon state (edit_count/order_date/total) → refund. All payments run in Stripe TEST mode.' },
  { id: 'test-16', num: 16, name: 'Restaurant-Funded Promo Settlement (Path B pre-charge)', description: 'Verifies the pricing engine reproduces FM’s composition to the cent (subtotal→discount→serviceCharge→tax→3% fee, transfer excludes the 3% fee and deducts the Stripe fee), then that adjusting a DIRECT destination-charge PaymentIntent’s amount + transfer_data.amount BEFORE confirm charges the customer the discounted total and pays the restaurant the discounted transfer (raw Stripe records) — no refund/reversal. Requires STRIPE_TEST_SECRET_KEY + STRIPE_TEST_CONNECTED_ACCOUNT for step 2; skips otherwise. Stripe TEST mode only.' },
]

function deriveStatus(steps: Step[]): Status {
  if (steps.some(s => s.status === 'failed')) return 'failed'
  if (steps.length > 0 && steps.every(s => s.status === 'skipped')) return 'skipped'
  return 'passed'
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { bg: string; color: string; label: string }> = {
    idle: { bg: '#ececed', color: '#777', label: 'Idle' },
    running: { bg: 'rgba(91,111,232,0.12)', color: BLUE, label: 'Running…' },
    passed: { bg: 'rgba(34,197,94,0.12)', color: '#179443', label: 'Passed' },
    failed: { bg: 'rgba(229,57,53,0.1)', color: RED, label: 'Failed' },
    skipped: { bg: 'rgba(239,184,74,0.16)', color: '#9a7b1e', label: 'Skipped' },
  }
  const s = map[status]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: s.bg, color: s.color, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 999 }}>
      {status === 'running' && <span className="td-spin" style={{ width: 10, height: 10, border: `2px solid ${BLUE}`, borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} />}
      {s.label}
    </span>
  )
}

const STEP_ICON: Record<Step['status'], { icon: string; color: string }> = {
  passed: { icon: '✓', color: '#179443' },
  failed: { icon: '✗', color: RED },
  skipped: { icon: '⊘', color: '#9a7b1e' },
}

export default function TestingDashboardPage() {
  const router = useRouter()
  const [adminEmail, setAdminEmail] = useState('')
  const [authChecked, setAuthChecked] = useState(false)
  const [results, setResults] = useState<Record<string, Result>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [runningAll, setRunningAll] = useState(false)
  const [cleanupMsg, setCleanupMsg] = useState('')
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [summary, setSummary] = useState('')

  // SUPER_ADMIN only (middleware also gates /admin/*; this is belt-and-suspenders).
  useEffect(() => {
    try {
      const raw = localStorage.getItem('admin_user')
      const u = raw ? JSON.parse(raw) : null
      if (!u || u.role !== 'SUPER_ADMIN') { router.replace('/admin/dashboard'); return }
      setAdminEmail(u.email || '')
      setAuthChecked(true)
    } catch { router.replace('/admin/dashboard') }
  }, [router])

  async function runTest(id: string): Promise<Status> {
    setResults(prev => ({ ...prev, [id]: { status: 'running' } }))
    try {
      const res = await fetch('/api/admin/tests/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId: id, adminEmail }),
      })
      const data = await res.json().catch(() => null)
      const steps: Step[] = data?.steps || []
      const status: Status = !res.ok ? 'failed' : deriveStatus(steps)
      setResults(prev => ({ ...prev, [id]: { status, duration: data?.duration, steps, testData: data?.testData } }))
      setExpanded(prev => ({ ...prev, [id]: status === 'failed' }))
      return status
    } catch {
      setResults(prev => ({ ...prev, [id]: { status: 'failed', steps: [{ name: 'Request failed', status: 'failed', detail: 'Network error' }] } }))
      return 'failed'
    }
  }

  async function runAll() {
    setRunningAll(true)
    setSummary('')
    let passed = 0, failed = 0, skipped = 0
    for (const t of TESTS) {
      const s = await runTest(t.id)
      if (s === 'passed') passed++
      else if (s === 'failed') failed++
      else if (s === 'skipped') skipped++
    }
    setSummary(`Ran ${TESTS.length} tests — ${passed} passed, ${failed} failed, ${skipped} skipped.`)
    setRunningAll(false)
  }

  async function cleanup() {
    setCleanupBusy(true)
    setCleanupMsg('')
    try {
      const res = await fetch('/api/admin/tests/cleanup', { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d?.deleted) { setCleanupMsg('Cleanup failed.'); return }
      const x = d.deleted
      setCleanupMsg(`Deleted — ${x.accounts} accounts, ${x.sessions} sessions, ${x.overrideRows} overrides, ${x.cacheRows} cache rows.`)
    } catch {
      setCleanupMsg('Cleanup failed.')
    } finally {
      setCleanupBusy(false)
    }
  }

  if (!authChecked) return <div style={{ padding: 32, fontFamily: F, color: '#999' }}>Loading…</div>

  const anyRunning = runningAll || Object.values(results).some(r => r.status === 'running')

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <style>{`@keyframes td-spin { to { transform: rotate(360deg) } } .td-spin { animation: td-spin 0.7s linear infinite }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Testing Dashboard</h1>
          <p style={{ fontSize: 13, color: '#888', margin: '6px 0 0', maxWidth: 720, lineHeight: 1.5 }}>
            Run end-to-end tests against production. All test data is prefixed with <code style={{ background: '#fff', padding: '1px 5px', borderRadius: 4, border: '1px solid #eee' }}>[TEST]</code> and uses <code style={{ background: '#fff', padding: '1px 5px', borderRadius: 4, border: '1px solid #eee' }}>playwright+*@discocater.com</code> emails.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={runAll} disabled={anyRunning || cleanupBusy}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, fontFamily: F, cursor: anyRunning ? 'wait' : 'pointer', opacity: anyRunning ? 0.6 : 1 }}>
            {runningAll ? 'Running all…' : 'Run All'}
          </button>
          <button onClick={cleanup} disabled={cleanupBusy || anyRunning}
            style={{ background: '#fff', color: RED, border: `1.5px solid ${RED}`, borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, fontFamily: F, cursor: cleanupBusy ? 'wait' : 'pointer', opacity: cleanupBusy ? 0.6 : 1 }}>
            {cleanupBusy ? 'Cleaning…' : 'Clean up all test data'}
          </button>
        </div>
      </div>

      {(summary || cleanupMsg) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {summary && <div style={{ background: '#fff', border: '1px solid #eee', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: DARK, fontWeight: 600 }}>{summary}</div>}
          {cleanupMsg && <div style={{ background: 'rgba(239,184,74,0.12)', border: '1px solid rgba(239,184,74,0.4)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#7a6020' }}>🧹 {cleanupMsg}</div>}
        </div>
      )}

      {/* Test grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
        {TESTS.map(t => {
          const r = results[t.id] || { status: 'idle' as Status }
          const isOpen = !!expanded[t.id]
          const running = r.status === 'running'
          return (
            <div key={t.id} style={{ background: '#fff', border: '1px solid #eee', borderRadius: 14, padding: '18px 20px', borderTop: `3px solid ${r.status === 'failed' ? RED : r.status === 'passed' ? GREEN : r.status === 'skipped' ? GOLD : '#eee'}` }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: DARK }}>
                    <span style={{ color: '#bbb', fontWeight: 800, marginRight: 6 }}>{t.num}.</span>{t.name}
                  </div>
                  <div style={{ fontSize: 12.5, color: '#888', marginTop: 4, lineHeight: 1.5 }}>{t.description}</div>
                </div>
                <StatusBadge status={r.status} />
              </div>

              {/* E2E test-mode warning + requirements note */}
              {t.id === 'test-15' && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', background: 'rgba(229,57,53,0.1)', color: RED, border: `1px solid ${RED}`, fontSize: 11.5, fontWeight: 800, padding: '4px 10px', borderRadius: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    ⚠ E2E Test — Uses Stripe Test Mode
                  </div>
                  <div style={{ background: 'rgba(239,184,74,0.12)', border: '1px solid rgba(239,184,74,0.4)', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#7a6020', lineHeight: 1.5 }}>
                    Requires <code style={{ background: '#fff', padding: '1px 5px', borderRadius: 4, border: '1px solid #eee' }}>STRIPE_TEST_SECRET_KEY</code> env var. Safe to run in production — uses Stripe test mode for all payments.
                  </div>
                </div>
              )}

              {/* Created data pills */}
              {r.testData?.createdRecords && r.testData.createdRecords.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                  {r.testData.createdRecords.map((rec, i) => (
                    <span key={i} style={{ fontSize: 11, background: '#f4f4f8', color: '#555', border: '1px solid #e6e6ee', borderRadius: 999, padding: '2px 9px' }}>
                      Created: {rec}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
                <button onClick={() => runTest(t.id)} disabled={running || runningAll}
                  style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 700, fontFamily: F, cursor: running || runningAll ? 'wait' : 'pointer', opacity: running || runningAll ? 0.6 : 1 }}>
                  {running ? 'Running…' : 'Run'}
                </button>
                {typeof r.duration === 'number' && (
                  <span style={{ fontSize: 12, color: '#999' }}>{r.duration} ms</span>
                )}
                {r.steps && r.steps.length > 0 && (
                  <button onClick={() => setExpanded(p => ({ ...p, [t.id]: !isOpen }))}
                    style={{ background: 'none', border: 'none', color: BLUE, fontSize: 12.5, fontWeight: 600, fontFamily: F, cursor: 'pointer', marginLeft: 'auto', padding: 0 }}>
                    {isOpen ? 'Hide details ▲' : 'Details ▼'}
                  </button>
                )}
              </div>

              {/* Expandable results */}
              {isOpen && r.steps && (
                <div style={{ marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {r.steps.map((s, i) => {
                    const ic = STEP_ICON[s.status]
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5 }}>
                        <span style={{ color: ic.color, fontWeight: 800, flexShrink: 0, width: 14 }}>{ic.icon}</span>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ fontWeight: 600, color: DARK }}>{s.name}</span>
                          {s.detail && <span style={{ color: '#888' }}> — {s.detail}</span>}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
