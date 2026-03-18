'use client'
import { useEffect, useRef, useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import Script from 'next/script'  // ← CHANGE 4: for Google Maps script
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

// ─── CHANGE 5: Haversine helper for proximity filtering ───────────────────────
function getDistanceMiles(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 3958.8
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ─── CHANGE 5: Chat message type ──────────────────────────────────────────────
type ChatMessage = { role: 'user' | 'assistant'; content: string }

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

function FullMapInner() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<{ [id: string]: mapboxgl.Marker }>({})
  const searchParams = useSearchParams()
  const autocompleteRef = useRef<any>(null)      // ← CHANGE 4: Google autocomplete instance
  const locInputRef = useRef<HTMLInputElement>(null) // ← CHANGE 4: ref for autocomplete input
  const chatBottomRef = useRef<HTMLDivElement>(null) // ← CHANGE 5: chat scroll anchor

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

  // ─── CHANGE 3: anchor point for proximity filtering ───────────────────────
  const [proximityAnchor, setProximityAnchor] = useState<{ lat: number; lng: number } | null>(null)
  const PROXIMITY_MILES = 25  // show restaurants within this radius

  // ─── CHANGE 5: chat state ─────────────────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: "Hi! I'm Disco 🤖 Tell me about your event and I'll find the perfect catering for you!\n\nTry: *\"Birthday party for 20 people\"* or *\"Office lunch, need vegetarian options\"*" }
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)

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

    const lat = searchParams.get('lat')
    const lng = searchParams.get('lng')
    if (lat && lng) {
      map.current.on('load', () => {
        map.current?.flyTo({ center: [parseFloat(lng), parseFloat(lat)], zoom: 11, speed: 1.2 })
        // ─── CHANGE 3: set proximity anchor from URL params ───────────────
        setProximityAnchor({ lat: parseFloat(lat), lng: parseFloat(lng) })
      })
    }
  }, [searchParams])

  // ─── CHANGE 4: Init Google Maps autocomplete once script loads ─────────────
  const initAutocomplete = useCallback(() => {
    if (!locInputRef.current || !(window as any).google) return
    const ac = new (window as any).google.maps.places.Autocomplete(locInputRef.current, {
      types: ['geocode', 'establishment'],
      componentRestrictions: { country: 'us' },
    })
    ac.addListener('place_changed', () => {
      const place = ac.getPlace()
      if (!place.geometry?.location) return
      const lat = place.geometry.location.lat()
      const lng = place.geometry.location.lng()
      setLocInput(place.formatted_address || place.name || '')
      setLocError('')
      map.current?.flyTo({ center: [lng, lat], zoom: 11, speed: 1.2 })
      // ─── CHANGE 3: update proximity anchor when location is picked ────
      setProximityAnchor({ lat, lng })
    })
    autocompleteRef.current = ac
  }, [])

  // ─── CHANGE 3: filter sidebar by proximity whenever anchor changes ─────────
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
    // ─── CHANGE 3: apply proximity filter if anchor is set ────────────────
    if (proximityAnchor) {
      out = out
        .map(r => ({ ...r, _dist: getDistanceMiles(proximityAnchor.lat, proximityAnchor.lng, r.lat, r.lng) }))
        .filter(r => r._dist <= PROXIMITY_MILES)
        .sort((a: any, b: any) => a._dist - b._dist)
    }
    setFiltered(out)
  }, [search, stageFilter, cuisineFilter, restaurants, proximityAnchor])

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
        // ─── CHANGE 3: set proximity anchor when marker is clicked ────────
        setProximityAnchor({ lat: r.lat, lng: r.lng })
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

  // ─── CHANGE 4 (fallback): manual Nominatim search if user hits "Go" without picking autocomplete ─
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
        setProximityAnchor({ lat: parseFloat(lat), lng: parseFloat(lon) })
      } else {
        setLocError('Not found')
      }
    } catch {
      setLocError('Error')
    } finally {
      setLocLoading(false)
    }
  }

  // ─── CHANGE 5: scroll chat to bottom on new messages ──────────────────────
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  // ─── CHANGE 5: send chat message via /api/chat ────────────────────────────
  async function sendChat() {
    if (!chatInput.trim() || chatLoading) return
    const userMsg: ChatMessage = { role: 'user', content: chatInput }
    const next = [...chatMessages, userMsg]
    setChatMessages(next)
    setChatInput('')
    setChatLoading(true)

    try {
      const res = await fetch('/api/disco-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next,
          restaurants: restaurants.map(r => ({
            name: r.name, cuisine: r.cuisine, location: r.location,
            isDisco: r.isDisco, orderUrl: r.orderUrl, description: r.description,
          })),
        }),
      })
      const data = await res.json()
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again!' }])
    } finally {
      setChatLoading(false)
    }
  }

  const cuisineCounts: Record<string, number> = {}
  restaurants.forEach(r => { cuisineCounts[r.cuisine] = (cuisineCounts[r.cuisine] || 0) + 1 })
  const topCuisines = Object.entries(cuisineCounts).sort((a, b) => b[1] - a[1]).slice(0, 7).map(e => e[0])

  // ─── CHANGE 1: fixed pill button style — added overflow:'hidden' ──────────
  const fbStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px',
    borderRadius: 20,
    overflow: 'hidden',            // ← FIX: clips bg color to rounded edges
    border: `1.5px solid ${active ? 'transparent' : '#e8e8e8'}`,
    background: active ? GRADIENT : '#fff',
    color: active ? '#fff' : '#555',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: "'DM Sans',sans-serif", flexShrink: 0,
    WebkitBackgroundClip: active ? 'padding-box' : undefined, // ← FIX: ensures gradient stays inside border
  })

  return (
    <>
      {/* ─── CHANGE 4: Load Google Maps Places script ──────────────────────── */}
      <Script
        src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`}
        strategy="afterInteractive"
        onLoad={initAutocomplete}
      />

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

          {/* ─── CHANGE 2: Login button ───────────────────────────────────── */}
          <a
            href="https://www.familymeal.com/?action=signIn"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              marginLeft: 'auto',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 14px',
              borderRadius: 20,
              border: '1.5px solid #e8e8e8',
              background: '#fff',
              color: '#111',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "'DM Sans',sans-serif",
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            Log In
          </a>
        </div>

        {/* ── Main ── */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ─── CHANGE 5: AI Chat panel (slides in to the left of sidebar) ── */}
          {chatOpen && (
            <div style={{
              width: 320, minWidth: 320,
              display: 'flex', flexDirection: 'column',
              borderRight: '1px solid #f0f0f0',
              background: '#fff',
            }}>
              {/* Chat header */}
              <div style={{
                padding: '12px 14px', borderBottom: '1px solid #f0f0f0',
                background: GRADIENT, display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <div style={{ fontSize: 22 }}>🤖</div>
                <div>
                  <div style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>Disco AI</div>
                  <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 }}>Catering Assistant</div>
                </div>
                <button
                  onClick={() => setChatOpen(false)}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.8)', fontSize: 18, lineHeight: 1, padding: 0 }}
                >×</button>
              </div>

              {/* Messages */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 10px', background: '#fafafa', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {chatMessages.map((msg, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: 6 }}>
                    {msg.role === 'assistant' && (
                      <div style={{
                        width: 26, height: 26, borderRadius: '50%', background: GRADIENT,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 13, flexShrink: 0, marginBottom: 2,
                      }}>🤖</div>
                    )}
                    <div style={{
                      maxWidth: '82%',
                      padding: '9px 12px',
                      borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      background: msg.role === 'user' ? GRADIENT : '#fff',
                      color: msg.role === 'user' ? '#fff' : '#111',
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      boxShadow: msg.role === 'assistant' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
                      border: msg.role === 'assistant' ? '1px solid #f0f0f0' : 'none',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {msg.content}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>🤖</div>
                    <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: '16px 16px 16px 4px', padding: '10px 14px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {[0, 150, 300].map(delay => (
                          <div key={delay} style={{
                            width: 6, height: 6, borderRadius: '50%', background: '#ccc',
                            animation: 'bounce 1s infinite',
                            animationDelay: `${delay}ms`,
                          }} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatBottomRef} />
              </div>

              {/* Suggestion chips */}
              {chatMessages.length <= 1 && (
                <div style={{ padding: '8px 10px 4px', background: '#fafafa', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {['Birthday party for 20 🎂', 'Office lunch for 50 💼', 'Need vegetarian options 🥗', 'Last-minute catering ⚡'].map(chip => (
                    <button key={chip} onClick={() => setChatInput(chip)} style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 12,
                      border: '1.5px solid #e8e8e8', background: '#fff',
                      color: '#555', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif",
                    }}>{chip}</button>
                  ))}
                </div>
              )}

              {/* Input */}
              <div style={{ padding: '10px', background: '#fff', borderTop: '1px solid #f0f0f0', display: 'flex', gap: 8 }}>
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendChat()}
                  placeholder="Ask about catering…"
                  style={{
                    flex: 1, padding: '9px 12px', borderRadius: 20,
                    border: '1.5px solid #e8e8e8', fontSize: 12.5,
                    fontFamily: "'DM Sans',sans-serif", outline: 'none',
                    background: '#fafafa', color: '#111',
                  }}
                />
                <button
                  onClick={sendChat}
                  disabled={chatLoading || !chatInput.trim()}
                  style={{
                    width: 36, height: 36, borderRadius: '50%', border: 'none',
                    background: GRADIENT, cursor: 'pointer', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    opacity: (chatLoading || !chatInput.trim()) ? 0.4 : 1,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>
                  </svg>
                </button>
              </div>

              <style>{`@keyframes bounce { 0%,80%,100% { transform:translateY(0) } 40% { transform:translateY(-6px) } }`}</style>
            </div>
          )}

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
            <div style={{ padding: '6px 12px', fontSize: 11, color: '#bbb', borderBottom: '1px solid #f0f0f0', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              {filtered.length} restaurants
              {/* ─── CHANGE 3: show proximity badge + clear button ─────────── */}
              {proximityAnchor && (
                <>
                  <span style={{ fontSize: 10, background: '#f0f0ff', color: '#6B6EF9', padding: '1px 7px', borderRadius: 8, fontWeight: 600 }}>
                    📍 Nearby ({PROXIMITY_MILES}mi)
                  </span>
                  <button
                    onClick={() => setProximityAnchor(null)}
                    style={{ fontSize: 10, color: '#bbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                  >clear</button>
                </>
              )}
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
                    // ─── CHANGE 3: clicking a sidebar item also sets anchor ─
                    setProximityAnchor({ lat: r.lat, lng: r.lng })
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
              {/* ─── CHANGE 4: ref attached so Google autocomplete targets this input ── */}
              <input
                ref={locInputRef}
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

            {/* ─── CHANGE 5: Floating Disco robot button ───────────────────── */}
            <button
              onClick={() => setChatOpen(o => !o)}
              style={{
                position: 'absolute', bottom: 24, right: 24, zIndex: 20,
                width: 52, height: 52, borderRadius: '50%', border: 'none',
                background: GRADIENT, cursor: 'pointer', boxShadow: '0 4px 20px rgba(107,110,249,0.45)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'transform 0.15s, box-shadow 0.15s',
                fontSize: 24,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.1)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)' }}
              title="Ask Disco AI"
            >
              🤖
              {/* Green "online" dot */}
              {!chatOpen && (
                <div style={{
                  position: 'absolute', top: 3, right: 3,
                  width: 11, height: 11, borderRadius: '50%',
                  background: '#22c55e', border: '2px solid #fff',
                }} />
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

export default function FullMapPage() {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'DM Sans, sans-serif', color: '#999' }}>Loading map…</div>}>
      <FullMapInner />
    </Suspense>
  )
}