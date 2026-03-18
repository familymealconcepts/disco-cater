'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

type Restaurant = {
  _id: string
  name: string
  location: string
  cuisine: string
  lat: number
  lng: number
  isDisco: boolean
  orderUrl: string
  image?: string
  description?: string
}

export default function FullMapPage() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<{ [id: string]: mapboxgl.Marker }>({})
  const searchParams = useSearchParams()

  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [filtered, setFiltered] = useState<Restaurant[]>([])
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<'all' | 'disco'>('all')
  const [cuisineFilter, setCuisineFilter] = useState('all')
  const [activeId, setActiveId] = useState<string | null>(null)

  // Address search state (top-left of map)
  const [locInput, setLocInput] = useState('')
  const [locLoading, setLocLoading] = useState(false)
  const [locError, setLocError] = useState('')

  // Fetch restaurants
  useEffect(() => {
    fetch('/api/restaurants')
      .then(r => r.json())
      .then(data => { setRestaurants(data); setFiltered(data) })
  }, [])

  // Init map
  useEffect(() => {
    if (map.current || !mapContainer.current) return
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-96, 39.5],
      zoom: 3.5,
    })
    map.current.addControl(new mapboxgl.NavigationControl(), 'bottom-right')

    // If lat/lng passed from homepage search, fly there
    const lat = searchParams.get('lat')
    const lng = searchParams.get('lng')
    if (lat && lng) {
      map.current.on('load', () => {
        map.current?.flyTo({ center: [parseFloat(lng), parseFloat(lat)], zoom: 11, speed: 1.2 })
      })
    }
  }, [searchParams])

  // Address search handler
  async function doLocSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!locInput.trim()) return
    setLocLoading(true)
    setLocError('')
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locInput)}&format=json&limit=1&countrycodes=us`,
        { headers: { 'Accept-Language': 'en' } }
      )
      const data = await res.json()
      if (data && data[0]) {
        const { lat, lon } = data[0]
        map.current?.flyTo({ center: [parseFloat(lon), parseFloat(lat)], zoom: 11, speed: 1.2 })
      } else {
        setLocError('Not found')
      }
    } catch {
      setLocError('Error')
    } finally {
      setLocLoading(false)
    }
  }

  // Update markers
  useEffect(() => {
    if (!map.current) return
    const visibleIds = new Set(filtered.map(r => r._id))

    Object.entries(markersRef.current).forEach(([id, marker]) => {
      if (!visibleIds.has(id)) { marker.remove(); delete markersRef.current[id] }
    })

    filtered.forEach((r, i) => {
      if (markersRef.current[r._id]) return
      const el = document.createElement('div')
      const mkDiv = document.createElement('div')
      Object.assign(mkDiv.style, {
        width: '30px', height: '30px', borderRadius: '50%',
        background: '#111', color: '#fff', fontSize: '10px', fontWeight: '700',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '2.5px solid #fff', boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
        fontFamily: "'DM Sans',sans-serif", cursor: 'pointer', transition: 'all 0.15s',
      })
      mkDiv.textContent = String(i + 1)
      el.appendChild(mkDiv)

      const popup = new mapboxgl.Popup({ offset: 15, closeButton: true, maxWidth: '290px' })
        .setHTML(`
          <div style="font-family:'DM Sans',sans-serif;width:270px;border-radius:12px;overflow:hidden">
            ${r.image ? `<div style="height:140px;overflow:hidden"><img src="${r.image}" style="width:100%;height:100%;object-fit:cover"/></div>` : ''}
            <div style="padding:14px 16px 16px">
              <div style="font-size:14px;font-weight:700;margin-bottom:2px;color:#111">✦ ${r.name}${r.isDisco ? ' 🪩' : ''}</div>
              <div style="font-size:11px;color:#999;margin-bottom:8px">${r.location}</div>
              ${r.description ? `<div style="font-size:11.5px;color:#555;line-height:1.55;margin-bottom:10px">${r.description}</div>` : ''}
              <div style="display:flex;gap:5px;margin-bottom:12px">
                <span style="font-size:10px;background:#f5f1eb;border:1px solid #e8e0d8;padding:2px 8px;border-radius:10px;color:#888">${r.cuisine}</span>
              </div>
              <a href="${r.orderUrl || '#'}" target="_blank" rel="noopener"
                style="display:block;width:100%;padding:10px 0;background:${GRADIENT};color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;text-align:center;text-decoration:none;box-sizing:border-box">
                Order Catering →
              </a>
            </div>
          </div>
        `)

      el.addEventListener('click', () => {
        setActiveId(r._id)
        mkDiv.style.background = GRADIENT
        mkDiv.style.transform = 'scale(1.2)'
        map.current?.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.current.getZoom(), 11), speed: 0.8 })
      })

      popup.on('close', () => {
        mkDiv.style.background = '#111'
        mkDiv.style.transform = 'scale(1)'
        setActiveId(null)
      })

      new mapboxgl.Marker(el)
        .setLngLat([r.lng, r.lat])
        .setPopup(popup)
        .addTo(map.current!)

      markersRef.current[r._id] = new mapboxgl.Marker(el).setLngLat([r.lng, r.lat])
    })
  }, [filtered])

  // Filter logic
  useEffect(() => {
    let out = restaurants
    if (stageFilter === 'disco') out = out.filter(r => r.isDisco)
    if (cuisineFilter !== 'all') out = out.filter(r => r.cuisine === cuisineFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      out = out.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.location.toLowerCase().includes(q) ||
        r.cuisine.toLowerCase().includes(q)
      )
    }
    setFiltered(out)
  }, [search, stageFilter, cuisineFilter, restaurants])

  const cuisineCounts: Record<string, number> = {}
  restaurants.forEach(r => { cuisineCounts[r.cuisine] = (cuisineCounts[r.cuisine] || 0) + 1 })
  const topCuisines = Object.entries(cuisineCounts).sort((a, b) => b[1] - a[1]).slice(0, 7).map(e => e[0])

  const fbStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 20,
    border: `1.5px solid ${active ? 'transparent' : '#e8e8e8'}`,
    background: active ? GRADIENT : '#fff',
    color: active ? '#fff' : '#555',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: "'DM Sans',sans-serif", flexShrink: 0,
  })

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff', color: '#111' }}>

      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, overflowX: 'auto', background: '#fff' }}>
        <Link href="/" style={{ flexShrink: 0, marginRight: 4 }}>
          <Image
            src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=200w"
            alt="Disco Cater"
            width={100}
            height={26}
            style={{ objectFit: 'contain', display: 'block' }}
          />
        </Link>

        <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />

        <button style={fbStyle(stageFilter === 'all')} onClick={() => setStageFilter('all')}>All</button>
        <button style={fbStyle(stageFilter === 'disco')} onClick={() => setStageFilter('disco')}>🪩 Premium</button>

        <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />

        <button style={fbStyle(cuisineFilter === 'all')} onClick={() => setCuisineFilter('all')}>All Cuisines</button>
        {topCuisines.map(c => (
          <button key={c} style={fbStyle(cuisineFilter === c)} onClick={() => setCuisineFilter(c)}>{c}</button>
        ))}
      </div>

      {/* ── Main ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Sidebar ── */}
        <div style={{ width: 320, minWidth: 320, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0', background: '#fff' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
            <div style={{ position: 'relative' }}>
              <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#bbb', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search restaurants…"
                style={{ width: '100%', padding: '9px 10px 9px 32px', borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fafafa', color: '#111', fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
          <div style={{ padding: '6px 12px', fontSize: 11, color: '#bbb', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
            {filtered.length} restaurants
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#bbb', fontSize: 13 }}>No restaurants match.</div>}
            {filtered.map((r, i) => (
              <div
                key={r._id}
                onClick={() => {
                  setActiveId(r._id)
                  map.current?.flyTo({ center: [r.lng, r.lat], zoom: 12, speed: 0.8 })
                  setTimeout(() => markersRef.current[r._id]?.togglePopup(), 500)
                }}
                style={{
                  display: 'flex', alignItems: 'center', cursor: 'pointer', minHeight: 74,
                  borderLeft: `3px solid ${activeId === r._id ? '#6B6EF9' : 'transparent'}`,
                  background: activeId === r._id ? 'rgba(107,110,249,0.05)' : '#fff',
                  transition: 'all 0.12s',
                }}
              >
                {r.image
                  ? <img src={r.image} alt={r.name} style={{ width: 74, height: 74, objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 74, height: 74, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>✦</div>
                }
                <div style={{ flex: 1, padding: '10px 12px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                      background: activeId === r._id ? GRADIENT : '#f0f0f0',
                      color: activeId === r._id ? '#fff' : '#999',
                      fontSize: 9, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>{i + 1}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.name}{r.isDisco ? ' 🪩' : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>{r.location}</div>
                  <span style={{ fontSize: 10, background: '#f5f1eb', padding: '2px 7px', borderRadius: 10, color: '#888' }}>{r.cuisine}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Map container ── */}
        <div style={{ flex: 1, position: 'relative' }}>

          {/* Address search — top left of map */}
          <form
            onSubmit={doLocSearch}
            style={{
              position: 'absolute', top: 12, left: 12, zIndex: 10,
              display: 'flex', alignItems: 'center', gap: 0,
              background: '#fff', borderRadius: 10, overflow: 'hidden',
              boxShadow: '0 2px 16px rgba(0,0,0,0.12)', border: '1.5px solid #e8e8e8',
            }}
          >
            <div style={{ padding: '0 10px', color: '#bbb', flexShrink: 0 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                <circle cx="12" cy="9" r="2.5"/>
              </svg>
            </div>
            <input
              value={locInput}
              onChange={e => { setLocInput(e.target.value); setLocError('') }}
              placeholder="Search by location…"
              style={{
                padding: '9px 4px', fontSize: 12.5, border: 'none', outline: 'none',
                background: 'transparent', color: '#111', width: 190,
                fontFamily: "'DM Sans',sans-serif",
              }}
            />
            <button
              type="submit"
              disabled={locLoading}
              style={{
                padding: '8px 14px', border: 'none', cursor: 'pointer',
                background: GRADIENT, color: '#fff', fontSize: 11,
                fontWeight: 700, fontFamily: "'DM Sans',sans-serif", flexShrink: 0,
              }}
            >
              {locLoading ? '...' : 'Go'}
            </button>
          </form>
          {locError && (
            <div style={{ position: 'absolute', top: 52, left: 12, zIndex: 10, background: '#fff', border: '1px solid #f0c0c8', borderRadius: 8, padding: '6px 12px', fontSize: 12, color: '#F0468A', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
              {locError}
            </div>
          )}

          <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    </div>
  )
}