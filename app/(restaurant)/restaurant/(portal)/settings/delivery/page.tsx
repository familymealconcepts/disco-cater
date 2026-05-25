'use client'
import { useState, useEffect, useCallback, useRef } from 'react'

declare global { interface Window { mapboxgl?: any } }

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        style={{ width: 44, height: 24, borderRadius: 12, background: checked ? INDIGO : '#d1d5db', border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.15s', flexShrink: 0 }}
      >
        <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: checked ? 23 : 3, transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
      </button>
      {label && <span style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{label}</span>}
    </label>
  )
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '22px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, marginTop: 0, marginBottom: 18 }}>{title}</h2>
      {children}
    </div>
  )
}

const inputSt: React.CSSProperties = { width: '100%', padding: '10px 13px', border: '1.5px solid #e0e0e0', borderRadius: 9, fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }

export default function DeliverySettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<any>(null)
  const circleRef = useRef<any>(null)

  // Settings state
  const [deliveryEnabled, setDeliveryEnabled] = useState(true)
  const [pickupAddress, setPickupAddress] = useState('')
  const [pickupCity, setPickupCity] = useState('')
  const [pickupState, setPickupState] = useState('')
  const [pickupZip, setPickupZip] = useState('')
  const [pickupLat, setPickupLat] = useState<number | null>(null)
  const [pickupLng, setPickupLng] = useState<number | null>(null)
  const [radiusMiles, setRadiusMiles] = useState(10)
  const [feeType, setFeeType] = useState<'flat' | 'tiered'>('flat')
  const [flatFee, setFlatFee] = useState('0.00')
  const [tieredFees, setTieredFees] = useState([
    { label: '0–5 miles', key: 'tier1', value: '0.00' },
    { label: '5–15 miles', key: 'tier2', value: '0.00' },
    { label: '15+ miles', key: 'tier3', value: '0.00' },
  ])
  const [deliveryProvider, setDeliveryProvider] = useState('')
  const [deliveryMinimum, setDeliveryMinimum] = useState('0.00')

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/delivery', { credentials: 'include' })
      if (res.ok) {
        const d = await res.json()
        if (d.deliveryEnabled != null) setDeliveryEnabled(d.deliveryEnabled)
        if (d.pickupAddress) setPickupAddress(d.pickupAddress)
        if (d.pickupCity) setPickupCity(d.pickupCity)
        if (d.pickupState) setPickupState(d.pickupState)
        if (d.pickupZip) setPickupZip(d.pickupZip)
        if (d.lat) setPickupLat(d.lat)
        if (d.lng) setPickupLng(d.lng)
        if (d.radiusMiles) setRadiusMiles(d.radiusMiles)
        if (d.feeType) setFeeType(d.feeType)
        if (d.flatFee != null) setFlatFee(String(d.flatFee))
        if (d.tieredFees) {
          setTieredFees(prev => prev.map((t, i) => ({ ...t, value: String(d.tieredFees[i] || 0) })))
        }
        if (d.deliveryProvider) setDeliveryProvider(d.deliveryProvider)
        if (d.deliveryMinimum != null) setDeliveryMinimum(String(d.deliveryMinimum))
      } else {
        const err = await res.json()
        setError(err.error || `FM API returned ${res.status}`)
      }
    } catch {
      setError('Unable to load delivery settings.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Init Mapbox after load
  useEffect(() => {
    if (loading || !mapRef.current) return
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
    if (!token) return

    function initMap() {
      if (!mapRef.current || mapInstance.current) return
      const mapboxgl = window.mapboxgl
      const lng = pickupLng ?? -74.006
      const lat = pickupLat ?? 40.7128
      const map = new mapboxgl.Map({
        container: mapRef.current,
        style: 'mapbox://styles/mapbox/light-v11',
        center: [lng, lat],
        zoom: 11,
        accessToken: token,
      })
      mapInstance.current = map
      map.on('load', () => {
        // Add radius circle as GeoJSON
        const radiusKm = radiusMiles * 1.60934
        const center = [lng, lat]
        const points = 64
        const coords = Array.from({ length: points + 1 }, (_, i) => {
          const angle = (i * 360) / points * Math.PI / 180
          const dx = (radiusKm / 111.32) * Math.cos(angle)
          const dy = (radiusKm / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.sin(angle)
          return [center[0] + dy, center[1] + dx]
        })
        const geojson: any = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } }] }
        map.addSource('delivery-radius', { type: 'geojson', data: geojson })
        map.addLayer({ id: 'delivery-radius-fill', type: 'fill', source: 'delivery-radius', paint: { 'fill-color': INDIGO, 'fill-opacity': 0.12 } })
        map.addLayer({ id: 'delivery-radius-outline', type: 'line', source: 'delivery-radius', paint: { 'line-color': INDIGO, 'line-width': 2 } })
        new mapboxgl.Marker({ color: INDIGO }).setLngLat([lng, lat]).addTo(map)
        circleRef.current = { geojson, map }
      })
    }

    if (window.mapboxgl) {
      initMap()
    } else if (!document.getElementById('mapbox-gl-js')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'; link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.0.1/mapbox-gl.css'
      document.head.appendChild(link)
      const s = document.createElement('script')
      s.id = 'mapbox-gl-js'
      s.src = 'https://api.mapbox.com/mapbox-gl-js/v3.0.1/mapbox-gl.js'
      s.onload = initMap
      document.head.appendChild(s)
    }

    return () => {
      if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null }
    }
  }, [loading])

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/restaurant/delivery', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          deliveryEnabled,
          pickupAddress, pickupCity, pickupState, pickupZip,
          lat: pickupLat, lng: pickupLng,
          radiusMiles,
          feeType,
          flatFee: parseFloat(flatFee) || 0,
          tieredFees: tieredFees.map(t => parseFloat(t.value) || 0),
          deliveryMinimum: parseFloat(deliveryMinimum) || 0,
        }),
      })
      if (res.ok) {
        setLastSaved(new Date())
        showToast('Saved successfully', true)
      } else {
        const d = await res.json()
        showToast(d.error || 'Failed to save', false)
      }
    } catch {
      showToast('Failed to save', false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .d-input:focus { border-color: ${INDIGO} !important; outline: none; }
        input[type=range] { accent-color: ${INDIGO}; }
      `}</style>

      <div style={{ fontFamily: F, maxWidth: 760 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: 0 }}>Delivery Settings</h1>
          {lastSaved && <div style={{ fontSize: 12, color: '#aaa' }}>Last saved {lastSaved.toLocaleTimeString()}</div>}
        </div>

        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#DC2626' }}>
            <strong>API Error:</strong> {error}
            <div style={{ fontSize: 11, marginTop: 4, color: '#9CA3AF' }}>
              The FM endpoint at <code>/api/restaurant/delivery</code> may need configuration.
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#aaa', fontSize: 14 }}>Loading delivery settings…</div>
        ) : (
          <>
            {/* Delivery toggle */}
            <SectionCard title="Delivery Availability">
              <Toggle checked={deliveryEnabled} onChange={setDeliveryEnabled} label={deliveryEnabled ? 'Delivery is enabled' : 'Delivery is disabled'} />
              <p style={{ fontSize: 13, color: '#888', marginTop: 10, marginBottom: 0 }}>
                When disabled, customers will only see the Pickup option during checkout.
              </p>
            </SectionCard>

            {/* Pickup address + map */}
            <SectionCard title="Pickup Address">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Street address</label>
                  <input className="d-input" value={pickupAddress} onChange={e => setPickupAddress(e.target.value)} placeholder="123 Main St" style={inputSt} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>City</label>
                  <input className="d-input" value={pickupCity} onChange={e => setPickupCity(e.target.value)} placeholder="New York" style={inputSt} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>State</label>
                    <input className="d-input" value={pickupState} onChange={e => setPickupState(e.target.value)} placeholder="NY" style={inputSt} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Zip</label>
                    <input className="d-input" value={pickupZip} onChange={e => setPickupZip(e.target.value)} placeholder="10001" style={inputSt} />
                  </div>
                </div>
              </div>
              <div ref={mapRef} style={{ height: 240, borderRadius: 10, overflow: 'hidden', border: '1px solid #e0e0e0', marginTop: 16, background: '#f4f4f8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {!process.env.NEXT_PUBLIC_MAPBOX_TOKEN && <span style={{ fontSize: 13, color: '#aaa' }}>Map preview requires Mapbox token</span>}
              </div>
            </SectionCard>

            {/* Delivery radius */}
            <SectionCard title="Delivery Radius">
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: DARK }}>Radius</label>
                  <span style={{ fontSize: 14, fontWeight: 700, color: INDIGO }}>{radiusMiles} miles</span>
                </div>
                <input
                  type="range"
                  min={1} max={50}
                  value={radiusMiles}
                  onChange={e => setRadiusMiles(Number(e.target.value))}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#aaa', marginTop: 4 }}>
                  <span>1 mi</span><span>50 mi</span>
                </div>
              </div>
            </SectionCard>

            {/* Delivery fee */}
            <SectionCard title="Delivery Fee">
              <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                {(['flat', 'tiered'] as const).map(type => (
                  <button
                    key={type}
                    onClick={() => setFeeType(type)}
                    style={{ flex: 1, padding: '10px', border: `2px solid ${feeType === type ? INDIGO : '#e0e0e0'}`, borderRadius: 9, background: feeType === type ? '#EEEDFE' : '#fff', color: feeType === type ? INDIGO : '#555', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: F }}
                  >
                    {type === 'flat' ? 'Flat Fee' : 'Tiered by Distance'}
                  </button>
                ))}
              </div>

              {feeType === 'flat' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#aaa' }}>$</span>
                  <input type="number" className="d-input" value={flatFee} onChange={e => setFlatFee(e.target.value)} step="0.01" min="0" style={{ ...inputSt, width: 140 }} />
                  <span style={{ fontSize: 13, color: '#888' }}>for all deliveries</span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {tieredFees.map((tier, i) => (
                    <div key={tier.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ width: 120, fontSize: 13, color: '#555', fontWeight: 600 }}>{tier.label}</span>
                      <span style={{ fontSize: 16, fontWeight: 700, color: '#aaa' }}>$</span>
                      <input
                        type="number"
                        className="d-input"
                        value={tier.value}
                        onChange={e => setTieredFees(prev => prev.map((t, j) => j === i ? { ...t, value: e.target.value } : t))}
                        step="0.01"
                        min="0"
                        style={{ ...inputSt, width: 120 }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* Delivery provider */}
            {deliveryProvider && (
              <SectionCard title="Delivery Provider">
                <div style={{ background: '#f7f8fc', borderRadius: 9, padding: '12px 16px', fontSize: 13, color: '#555' }}>
                  <strong style={{ color: DARK }}>Provider:</strong> {deliveryProvider}
                  <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>Determined by FamilyMeal — not editable here.</div>
                </div>
              </SectionCard>
            )}

            {/* Delivery minimum */}
            <SectionCard title="Minimum Order for Delivery">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#aaa' }}>$</span>
                <input type="number" className="d-input" value={deliveryMinimum} onChange={e => setDeliveryMinimum(e.target.value)} step="0.01" min="0" style={{ ...inputSt, width: 140 }} />
                <span style={{ fontSize: 13, color: '#888' }}>minimum order</span>
              </div>
            </SectionCard>

            {/* Save all */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 32 }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ padding: '12px 28px', background: saving ? '#ccc' : INDIGO, color: '#fff', border: 'none', borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F }}
              >
                {saving ? 'Saving…' : 'Save All Settings'}
              </button>
            </div>
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.ok ? '#1D9E75' : '#E24B4A', color: '#fff', padding: '11px 22px', borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 900, boxShadow: '0 6px 20px rgba(0,0,0,0.15)', whiteSpace: 'nowrap', fontFamily: F }}>
          {toast.msg}
        </div>
      )}
    </>
  )
}
