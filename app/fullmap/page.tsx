// v4 — FAQ link, #5B6FE8 user bubbles, multi-turn chat fix
'use client'
import { useEffect, useRef, useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import Script from 'next/script'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

function trackEvent(name: string, params?: Record<string, string>) {
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag('event', name, params)
  }
}

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

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setIsMobile(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isMobile
}

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
  availableDays?: string[]
}

function FullMapInner() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<{ [id: string]: mapboxgl.Marker }>({})
  const popupsRef = useRef<{ [id: string]: mapboxgl.Popup }>({})
  const searchParams = useSearchParams()
  const locInputRef = useRef<HTMLInputElement>(null)
  const chatBottomRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [filtered, setFiltered] = useState<Restaurant[]>([])
  const [restaurantsLoaded, setRestaurantsLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<'all' | 'disco'>('all')
  const [cuisineFilter, setCuisineFilter] = useState('all')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [locInput, setLocInput] = useState('')
  const [locLoading, setLocLoading] = useState(false)
  const [locError, setLocError] = useState('')
  const [showLocModal, setShowLocModal] = useState(false)
  const [proximityAnchor, setProximityAnchor] = useState<{ lat: number; lng: number } | null>(null)
  const PROXIMITY_MILES = 25
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: "Hi! I'm Disco 🤖 Tell me about your event and I'll find the perfect catering for you!\n\nTry: \"Birthday party for 20 people\" or \"Office lunch, need vegetarian options\"" }
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [mobileMapOpen, setMobileMapOpen] = useState(false)
  const filteredRef = useRef<Restaurant[]>([])

  useEffect(() => {
    const latParam = searchParams.get('lat')
    const lngParam = searchParams.get('lng')
    if (latParam && lngParam) return
    const t = setTimeout(() => {
      if (!navigator.geolocation) return
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude: lat, longitude: lng } = pos.coords
          map.current?.flyTo({ center: [lng, lat], zoom: 11, speed: 1.4, essential: true })
          setProximityAnchor({ lat, lng })
        },
        () => {}
      )
    }, 1200)
    return () => clearTimeout(t)
  }, [searchParams])

  function requestLocation() {
    setShowLocModal(false)
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        setProximityAnchor({ lat, lng })
        map.current?.flyTo({ center: [lng, lat], zoom: 12, speed: 3, essential: true })
      },
      () => {}
    )
  }

  useEffect(() => {
    fetch('/api/restaurants')
      .then(r => r.json())
      .then(data => { setRestaurants(data); setFiltered(data); setRestaurantsLoaded(true) })
  }, [])

  function initMapInstance() {
    if (map.current || !mapContainer.current) return
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v10',
      projection: { name: 'mercator' },
      center: [-96, 39.5],
      zoom: 4,
      maxBounds: [[-168, 15], [-52, 72]],
      cooperativeGestures: false,
    })
    map.current.addControl(new mapboxgl.NavigationControl(), 'bottom-right')
    const lat = searchParams.get('lat')
    const lng = searchParams.get('lng')
    if (lat && lng) {
      map.current.on('load', () => {
        map.current?.flyTo({ center: [parseFloat(lng), parseFloat(lat)], zoom: 11, speed: 1.2 })
        setProximityAnchor({ lat: parseFloat(lat), lng: parseFloat(lng) })
      })
    }
  }

  useEffect(() => {
    if (isMobile) return
    initMapInstance()
  }, [isMobile]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isMobile) return
    if (mobileMapOpen) {
      const t = setTimeout(() => {
        initMapInstance()
        map.current?.once('load', () => {
          map.current?.resize()
          addMarkersToMap(filteredRef.current)
        })
      }, 50)
      return () => clearTimeout(t)
    } else {
      if (map.current) {
        map.current.remove()
        map.current = null
        markersRef.current = {}
        popupsRef.current = {}
      }
    }
  }, [mobileMapOpen, isMobile]) // eslint-disable-line react-hooks/exhaustive-deps

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
      map.current?.flyTo({ center: [lng, lat], zoom: 11, speed: 3, essential: true })
      setProximityAnchor({ lat, lng })
    })
  }, [])

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
    if (proximityAnchor) {
      out = (out as any[])
        .map(r => ({ ...r, _dist: getDistanceMiles(proximityAnchor!.lat, proximityAnchor!.lng, r.lat, r.lng) }))
        .filter(r => r._dist <= PROXIMITY_MILES)
        .sort((a, b) => a._dist - b._dist)
    } else {
      out = [...out].sort((a, b) => (b.isDisco ? 1 : 0) - (a.isDisco ? 1 : 0))
    }
    setFiltered(out)
    filteredRef.current = out
  }, [search, stageFilter, cuisineFilter, restaurants, proximityAnchor])

  function closeAllPopups() {
    Object.values(popupsRef.current).forEach(p => { if (p.isOpen()) p.remove() })
  }

  function addMarkersToMap(list: Restaurant[]) {
    if (!map.current) return
    const visibleIds = new Set(list.map(r => r._id))
    Object.entries(markersRef.current).forEach(([id, marker]) => {
      if (!visibleIds.has(id)) {
        marker.remove()
        delete markersRef.current[id]
        delete popupsRef.current[id]
      }
    })
    list.forEach((r, i) => {
      if (markersRef.current[r._id]) return
      const el = document.createElement('div')
      const mkDiv = document.createElement('div')
      Object.assign(mkDiv.style, {
        width: '30px', height: '30px', borderRadius: '50%',
        background: '#111', color: '#fff', fontSize: '10px', fontWeight: '700',
        position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '2.5px solid #fff', boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
        fontFamily: "'DM Sans',sans-serif", cursor: 'pointer', transition: 'all 0.15s',
      })
      mkDiv.textContent = String(i + 1)
      el.appendChild(mkDiv)

      const popup = new mapboxgl.Popup({
        offset: [0, -44],
        closeButton: false,
        closeOnClick: false,
        maxWidth: '290px',
        className: 'disco-popup',
      }).setHTML(`
        <div style="font-family:'DM Sans',sans-serif;width:270px;border-radius:12px;overflow:hidden;position:relative;box-shadow:0 4px 24px rgba(0,0,0,0.13)">
          <button onclick="this.closest('.mapboxgl-popup').remove()" style="
            position:absolute;top:8px;right:8px;z-index:10;
            width:26px;height:26px;border-radius:50%;
            background:rgba(0,0,0,0.55);color:#fff;border:none;
            font-size:14px;font-weight:700;cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            line-height:1;backdrop-filter:blur(4px);">×</button>
          ${r.image ? `<div style="height:140px;overflow:hidden"><img src="${r.image}" style="width:100%;height:100%;object-fit:cover"/></div>` : ''}
          <div style="padding:14px 16px 16px">
            <div style="font-size:14px;font-weight:700;margin-bottom:2px;color:#111">✦ ${r.name}${r.isDisco ? ' 🪩' : ''}</div>
            <div style="font-size:11px;color:#999;margin-bottom:8px">${r.location}</div>
            ${r.description ? `<div style="font-size:11.5px;color:#555;line-height:1.55;margin-bottom:10px">${r.description}</div>` : ''}
            <div style="display:flex;gap:5px;margin-bottom:12px">
              <span style="font-size:10px;background:#f5f1eb;border:1px solid #e8e0d8;padding:2px 8px;border-radius:10px;color:#888">${r.cuisine}</span>
            </div>
            <a href="${r.orderUrl || '#'}" target="_blank" rel="noopener"
              style="display:block;width:100%;padding:10px 0;background:#5B6FE8;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;text-align:center;text-decoration:none;box-sizing:border-box">
              Order Catering →
            </a>
          </div>
        </div>
      `)

      popupsRef.current[r._id] = popup

      el.addEventListener('click', () => {
        closeAllPopups()
        setActiveId(r._id)
        trackEvent('restaurant_click', { restaurant_name: r.name, cuisine: r.cuisine })
        mkDiv.style.background = GRADIENT
        mkDiv.style.transform = 'scale(1.2)'
        const mapH = mapContainer.current?.clientHeight ?? 600
        const popupH = r.image ? 340 : 220
        const verticalOffset = Math.round((mapH / 2) - (popupH / 2) - 44)
        map.current?.flyTo({
          center: [r.lng, r.lat],
          zoom: Math.max(map.current.getZoom(), 11),
          speed: 3,
          essential: true,
          offset: [0, -verticalOffset],
        })
      })

      popup.on('close', () => {
        mkDiv.style.background = '#111'
        mkDiv.style.transform = 'scale(1)'
        setActiveId(null)
      })

      const marker = new mapboxgl.Marker(el)
        .setLngLat([r.lng, r.lat])
        .setPopup(popup)
        .addTo(map.current!)

      markersRef.current[r._id] = marker
    })
  }

  useEffect(() => {
    addMarkersToMap(filtered)
  }, [filtered]) // eslint-disable-line react-hooks/exhaustive-deps

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
        map.current?.flyTo({ center: [parseFloat(lon), parseFloat(lat)], zoom: 11, speed: 3, essential: true })
        setProximityAnchor({ lat: parseFloat(lat), lng: parseFloat(lon) })
      } else {
        setLocError('Location not found')
      }
    } catch {
      setLocError('Error searching location')
    } finally {
      setLocLoading(false)
    }
  }

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  async function sendChat() {
    if (!chatInput.trim() || chatLoading) return
    trackEvent('ai_chat_message_sent', { message_preview: chatInput.slice(0, 50) })
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
      if (!res.ok) throw new Error(`API ${res.status}`)
      const data = await res.json()
      const reply = data.reply || "Sorry, I couldn't get a response. Please try again!"
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again!' }])
    } finally {
      setChatLoading(false)
    }
  }

  function handleSidebarClick(r: Restaurant) {
    trackEvent('restaurant_click', { restaurant_name: r.name, cuisine: r.cuisine })
    closeAllPopups()
    setActiveId(r._id)
    if (!map.current) return
    const mapH = mapContainer.current?.clientHeight ?? 600
    const popupH = r.image ? 340 : 220
    const verticalOffset = Math.round((mapH / 2) - (popupH / 2) - 44)
    map.current.flyTo({
      center: [r.lng, r.lat],
      zoom: 14,
      speed: 3,
      essential: true,
      offset: [0, -verticalOffset],
    })
    map.current.once('moveend', () => {
      const marker = markersRef.current[r._id]
      const popup = popupsRef.current[r._id]
      if (marker && popup && !popup.isOpen()) marker.togglePopup()
    })
  }

  const cuisineCounts: Record<string, number> = {}
  restaurants.forEach(r => { cuisineCounts[r.cuisine] = (cuisineCounts[r.cuisine] || 0) + 1 })
  const topCuisines = Object.entries(cuisineCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0])

  const pillStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 20, overflow: 'hidden', border: 'none',
    background: active ? '#1A1028' : '#efefef', color: active ? '#fff' : '#555',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: "'DM Sans',sans-serif", flexShrink: 0,
  })
  const gradientPillStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 20, overflow: 'hidden', border: 'none',
    background: active ? 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)' : '#efefef',
    color: active ? '#fff' : '#555',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: "'DM Sans',sans-serif", flexShrink: 0,
  })
  const darkPillStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 20, overflow: 'hidden', border: 'none',
    background: active ? '#1A1028' : '#efefef', color: active ? '#fff' : '#555',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: "'DM Sans',sans-serif", flexShrink: 0,
  })
  const mobilePillStyle = (active: boolean, gradient = false): React.CSSProperties => ({
    padding: '8px 16px', borderRadius: 999, border: 'none',
    background: gradient && active ? 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'
      : active ? '#1A1028' : '#f0f0f0',
    color: active ? '#fff' : '#555',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const,
    fontFamily: "'DM Sans',sans-serif", flexShrink: 0, minHeight: 36,
    display: 'flex', alignItems: 'center',
  })

  const mapDivStyle: React.CSSProperties = { width: '100%', height: '100%' }

  const locModal = showLocModal && (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 20, padding: '32px 28px', maxWidth: 360, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', animation: 'fadeUp 0.25s ease', textAlign: 'center', fontFamily: "'DM Sans',sans-serif" }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>📍</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 8 }}>Find catering near you</div>
        <div style={{ fontSize: 13, color: '#888', lineHeight: 1.6, marginBottom: 24 }}>Share your location to instantly see restaurants that can cater near you.</div>
        <button onClick={requestLocation} style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: GRADIENT, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10, fontFamily: "'DM Sans',sans-serif" }}>Share my location</button>
        <button onClick={() => setShowLocModal(false)} style={{ width: '100%', padding: '11px', borderRadius: 12, border: '1.5px solid #e8e8e8', background: '#fff', color: '#888', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Maybe later</button>
      </div>
    </div>
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE LAYOUT
  // ═══════════════════════════════════════════════════════════════════════════
  if (isMobile) {
    return (
      <>
        <Script src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`} strategy="afterInteractive" onLoad={initAutocomplete} />
        <style>{`
          .pac-container { z-index: 9999 !important; font-family: 'DM Sans', sans-serif !important; }
          @keyframes bounce { 0%,80%,100% { transform:translateY(0) } 40% { transform:translateY(-6px) } }
          @keyframes fadeUp { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
          @keyframes slideUp { from { transform:translateY(100%) } to { transform:translateY(0) } }
          .disco-popup .mapboxgl-popup-content { padding:0; border-radius:12px; overflow:hidden; box-shadow:none; }
          .disco-popup .mapboxgl-popup-tip { display:none; }
          .mobile-filter-scroll::-webkit-scrollbar { display:none; }
          .mobile-filter-scroll { -ms-overflow-style:none; scrollbar-width:none; }
        `}</style>

        {locModal}

        {/* AI Chat full-screen overlay */}
        {chatOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: '#fff', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans',sans-serif" }}>
            <div style={{ padding: '12px 16px', background: '#EFB84A', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
              <div style={{ fontSize: 22 }}>🤖</div>
              <div><div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Disco AI</div><div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>Catering Assistant</div></div>
              <button onClick={() => setChatOpen(false)} style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.2)', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 20, lineHeight: 1, padding: '6px 10px', borderRadius: 8 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px', background: '#fafafa', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {chatMessages.map((msg, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: 8 }}>
                  {msg.role === 'assistant' && <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#EFB84A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}>🤖</div>}
                  <div style={{ maxWidth: '80%', padding: '11px 14px', borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px', background: msg.role === 'user' ? '#5B6FE8' : '#fff', color: msg.role === 'user' ? '#fff' : '#111', fontSize: 14, lineHeight: 1.6, boxShadow: msg.role === 'assistant' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none', border: msg.role === 'assistant' ? '1px solid #f0f0f0' : 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {msg.role === 'assistant'
                      ? msg.content.split(/(https?:\/\/[^\s]+)/).map((part, j) =>
                          /^https?:\/\//.test(part) ? (() => {
                            const preceding = msg.content.substring(0, msg.content.indexOf(part))
                            const nameMatch = preceding.match(/\*\*([^*]+)\*\*[^*]*$/) || preceding.match(/[-•]\s*([^\n(]+?)\s*[\n(](?=[^\n]*$)/)
                            const restaurantName = nameMatch ? nameMatch[1].trim() : 'this restaurant'
                            return <a key={j} href={part} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '9px 16px', borderRadius: 20, background: '#1A1028', color: '#fff', fontSize: 13, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>{restaurantName} →</a>
                          })() : <span key={j}>{part}</span>
                        )
                      : msg.content}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#EFB84A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>🤖</div>
                  <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: '18px 18px 18px 4px', padding: '12px 16px' }}>
                    <div style={{ display: 'flex', gap: 5 }}>{[0,150,300].map(d => <div key={d} style={{ width: 7, height: 7, borderRadius: '50%', background: '#ccc', animation: 'bounce 1s infinite', animationDelay: `${d}ms` }} />)}</div>
                  </div>
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>
            {chatMessages.length <= 1 && (
              <div style={{ padding: '10px 14px 6px', background: '#fafafa', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {['Birthday party for 20 🎂', 'Office lunch for 50 💼', 'Vegetarian options 🥗', 'Last-minute catering ⚡'].map(chip => (
                  <button key={chip} onClick={() => setChatInput(chip)} style={{ fontSize: 13, padding: '7px 14px', borderRadius: 20, border: '1.5px solid #e8e8e8', background: '#fff', color: '#555', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>{chip}</button>
                ))}
              </div>
            )}
            <div style={{ padding: '12px 14px', background: '#fff', borderTop: '1px solid #f0f0f0', display: 'flex', gap: 10, paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendChat()} placeholder="Ask about catering…" style={{ flex: 1, padding: '12px 16px', borderRadius: 24, border: '1.5px solid #e8e8e8', fontSize: 16, fontFamily: "'DM Sans',sans-serif", outline: 'none', background: '#fafafa', color: '#111' }} />
              <button onClick={sendChat} disabled={chatLoading || !chatInput.trim()} style={{ width: 44, height: 44, borderRadius: '50%', border: 'none', background: '#5B6FE8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: (chatLoading || !chatInput.trim()) ? 0.4 : 1 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
              </button>
            </div>
          </div>
        )}

        <div style={{ fontFamily: "'DM Sans',sans-serif", height: '100svh', display: 'flex', flexDirection: 'column', background: '#fff', color: '#111', overflow: 'hidden' }}>

          {/* 1. Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, background: 'linear-gradient(180deg, rgba(107,110,249,0.08) 0%, rgba(240,70,138,0.04) 100%), #fff', paddingTop: 'max(10px, env(safe-area-inset-top))' }}>
            <Link href="/"><Image src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=200w" alt="Disco Cater" width={90} height={24} style={{ objectFit: 'contain', display: 'block' }} /></Link>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button onClick={() => setChatOpen(true)} style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: '#EFB84A', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, position: 'relative', boxShadow: '0 2px 10px rgba(239,184,74,0.4)' }}>
                🤖<div style={{ position: 'absolute', top: 0, right: 0, width: 9, height: 9, borderRadius: '50%', background: '#22c55e', border: '2px solid #fff' }} />
              </button>
              <Link href="/faq" style={{ fontSize: 13, color: '#555', textDecoration: 'none', fontWeight: 500, fontFamily: "'DM Sans',sans-serif" }}>FAQ</Link>
            </div>
          </div>

          {/* 2. Location search */}
          <div style={{ padding: '12px 16px 8px', background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
            <form onSubmit={doLocSearch} style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: '#f5f5f5', borderRadius: 12, padding: '0 14px', border: '1.5px solid #e8e8e8', gap: 8 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
                <input ref={locInputRef} value={locInput} onChange={e => { setLocInput(e.target.value); setLocError('') }} placeholder="Search by location…" style={{ flex: 1, padding: '13px 0', fontSize: 16, border: 'none', outline: 'none', background: 'transparent', color: '#111', fontFamily: "'DM Sans',sans-serif" }} />
                {locInput && <button type="button" onClick={() => { setLocInput(''); setProximityAnchor(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', fontSize: 18, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>}
              </div>
              <button type="submit" disabled={locLoading} style={{ padding: '0 18px', borderRadius: 12, border: 'none', background: '#5B6FE8', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", flexShrink: 0, minHeight: 48 }}>{locLoading ? '…' : 'Go'}</button>
            </form>
            {locError && <div style={{ marginTop: 6, fontSize: 12, color: '#F0468A', paddingLeft: 4 }}>{locError}</div>}
            {proximityAnchor && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, paddingLeft: 4 }}>
                <span style={{ fontSize: 12, background: '#f0f0ff', color: '#6B6EF9', padding: '3px 10px', borderRadius: 8, fontWeight: 600 }}>📍 Showing nearby</span>
                <button onClick={() => { setProximityAnchor(null); setLocInput('') }} style={{ fontSize: 12, color: '#bbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Clear</button>
              </div>
            )}
          </div>

          {/* 3. Cuisine filters */}
          <div className="mobile-filter-scroll" style={{ display: 'flex', gap: 8, padding: '10px 16px', overflowX: 'auto', flexShrink: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', alignItems: 'center' }}>
            <button style={mobilePillStyle(stageFilter === 'disco', true)} onClick={() => setStageFilter(s => s === 'disco' ? 'all' : 'disco')}>🪩 Premium</button>
            <div style={{ width: 1, height: 20, background: '#e0e0e0', flexShrink: 0 }} />
            <button style={mobilePillStyle(cuisineFilter === 'all')} onClick={() => setCuisineFilter('all')}>All</button>
            {topCuisines.map(c => <button key={c} style={mobilePillStyle(cuisineFilter === c)} onClick={() => setCuisineFilter(c)}>{c}</button>)}
          </div>

          {/* 4. Count + search + map toggles */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px 8px', flexShrink: 0, background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
            <span style={{ fontSize: 12, color: '#bbb', fontFamily: "'DM Sans',sans-serif" }}>{filtered.length} restaurant{filtered.length !== 1 ? 's' : ''}</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                onClick={() => setMobileMapOpen(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: '#555', background: '#f0f0f0', border: 'none', borderRadius: 20, padding: '5px 12px', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                Map
              </button>
              <button onClick={() => setMobileSearchOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: mobileSearchOpen ? '#6B6EF9' : '#bbb' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
            </div>
          </div>

          {/* Map full-screen modal */}
          {mobileMapOpen && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 400,
              display: 'flex', flexDirection: 'column',
              background: '#fff',
              animation: 'slideUp 0.28s cubic-bezier(0.32,0,0.67,0)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, background: '#fff', paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#111', fontFamily: "'DM Sans',sans-serif" }}>Map</span>
                <button onClick={() => setMobileMapOpen(false)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#555', background: '#f0f0f0', border: 'none', borderRadius: 20, padding: '6px 14px', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
                  ✕ Close
                </button>
              </div>
              <div style={{ padding: '10px 16px', background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
                <form onSubmit={doLocSearch} style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: '#f5f5f5', borderRadius: 10, padding: '0 12px', border: '1.5px solid #e8e8e8', gap: 8 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
                    <input value={locInput} onChange={e => { setLocInput(e.target.value); setLocError('') }} placeholder="Search by location…" style={{ flex: 1, padding: '11px 0', fontSize: 16, border: 'none', outline: 'none', background: 'transparent', color: '#111', fontFamily: "'DM Sans',sans-serif" }} />
                  </div>
                  <button type="submit" disabled={locLoading} style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: '#5B6FE8', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", flexShrink: 0 }}>{locLoading ? '…' : 'Go'}</button>
                </form>
              </div>
              <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                <div ref={mapContainer} style={{ position: 'absolute', inset: 0 }} />
                {proximityAnchor && (
                  <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
                    <button onClick={() => { setProximityAnchor(null); setLocInput('') }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 20, background: '#fff', border: '1px solid #e0e0e0', fontSize: 12, fontWeight: 600, color: '#555', cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', fontFamily: "'DM Sans',sans-serif" }}>
                      📍 Showing nearby · Clear
                    </button>
                  </div>
                )}
              </div>
              <div style={{ height: 'env(safe-area-inset-bottom, 0px)', background: '#fff', flexShrink: 0 }} />
            </div>
          )}

          {/* 5. Scrollable list */}
          <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' as any }}>
            {mobileSearchOpen && (
              <div style={{ padding: '10px 16px', background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ position: 'relative' }}>
                  <svg style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#bbb', pointerEvents: 'none' }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input autoFocus value={search} onChange={e => { setSearch(e.target.value); if (e.target.value.length > 2) trackEvent('search_performed', { search_term: e.target.value }) }} placeholder="Search restaurants…" style={{ width: '100%', padding: '11px 36px 11px 36px', borderRadius: 10, border: '1.5px solid #e8e8e8', background: '#fff', color: '#111', fontSize: 16, fontFamily: "'DM Sans',sans-serif", outline: 'none', boxSizing: 'border-box' }} />
                  <button onClick={() => { setMobileSearchOpen(false); setSearch('') }} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
                </div>
              </div>
            )}
            {restaurantsLoaded && filtered.length === 0 && <div style={{ padding: '48px 24px', textAlign: 'center', color: '#bbb', fontSize: 14 }}><div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>No restaurants match.</div>}
            {filtered.map((r, i) => (
              <div key={r._id} onClick={() => handleSidebarClick(r)} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', minHeight: 80, borderLeft: `3px solid ${activeId === r._id ? '#6B6EF9' : 'transparent'}`, background: activeId === r._id ? 'rgba(107,110,249,0.05)' : '#fff', borderBottom: '1px solid #f5f5f5', transition: 'all 0.12s' }}>
                {r.image ? <img src={r.image} alt={r.name} style={{ width: 80, height: 80, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 80, height: 80, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>✦</div>}
                <div style={{ flex: 1, padding: '12px 14px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, background: activeId === r._id ? GRADIENT : '#f0f0f0', color: activeId === r._id ? '#fff' : '#999', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}{r.isDisco ? ' 🪩' : ''}</div>
                  </div>
                  <div style={{ fontSize: 12, color: '#bbb', marginBottom: 5 }}>{r.location}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, background: '#f5f1eb', padding: '2px 8px', borderRadius: 10, color: '#888' }}>{r.cuisine}</span>
                    <span style={{ fontSize: 12, color: '#6B6EF9', fontWeight: 600 }}>Order →</span>
                  </div>
                </div>
              </div>
            ))}
            <div style={{ height: 'env(safe-area-inset-bottom, 16px)', minHeight: 16 }} />
          </div>
        </div>
      </>
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DESKTOP LAYOUT
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <>
      <Script src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`} strategy="afterInteractive" onLoad={initAutocomplete} />
      <style>{`
        .pac-container { z-index: 9999 !important; font-family: 'DM Sans', sans-serif !important; }
        @keyframes bounce { 0%,80%,100% { transform:translateY(0) } 40% { transform:translateY(-6px) } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
        input[type="datetime-local"]::-webkit-calendar-picker-indicator { opacity: 0.5; cursor: pointer; }
        .disco-popup .mapboxgl-popup-content { padding:0; border-radius:12px; overflow:hidden; box-shadow:none; }
        .disco-popup .mapboxgl-popup-tip { display:none; }
      `}</style>

      {locModal}

      <div style={{ fontFamily: "'DM Sans',sans-serif", height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff', color: '#111' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, overflowX: 'auto', background: 'linear-gradient(180deg, rgba(107,110,249,0.08) 0%, rgba(240,70,138,0.04) 100%), #fff' }}>
          <Link href="/" style={{ flexShrink: 0, marginRight: 4 }}><Image src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=200w" alt="Disco Cater" width={100} height={26} style={{ objectFit: 'contain', display: 'block' }} /></Link>
          <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />
          <button style={darkPillStyle(stageFilter === 'all')} onClick={() => setStageFilter('all')}>All</button>
          <button style={gradientPillStyle(stageFilter === 'disco')} onClick={() => setStageFilter('disco')}>🪩 Premium</button>
          <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />
          <button style={pillStyle(cuisineFilter === 'all')} onClick={() => setCuisineFilter('all')}>All Cuisines</button>
          {topCuisines.map(c => <button key={c} style={pillStyle(cuisineFilter === c)} onClick={() => setCuisineFilter(c)}>{c}</button>)}
          <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />
          <Link href="/faq" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 14, color: '#555', textDecoration: 'none', fontWeight: 500, fontFamily: "'DM Sans',sans-serif", paddingRight: 8 }}>FAQ</Link>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {chatOpen && (
            <div style={{ width: 320, minWidth: 320, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0', background: '#fff' }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid #f0f0f0', background: '#EFB84A', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 22 }}>🤖</div>
                <div><div style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>Disco AI</div><div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 }}>Catering Assistant</div></div>
                <button onClick={() => setChatOpen(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.8)', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 10px', background: '#fafafa', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {chatMessages.map((msg, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: 6 }}>
                    {msg.role === 'assistant' && <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#EFB84A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0, marginBottom: 2 }}>🤖</div>}
                    <div style={{ maxWidth: '82%', padding: '9px 12px', borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px', background: msg.role === 'user' ? '#5B6FE8' : '#fff', color: msg.role === 'user' ? '#fff' : '#111', fontSize: 12.5, lineHeight: 1.55, boxShadow: msg.role === 'assistant' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none', border: msg.role === 'assistant' ? '1px solid #f0f0f0' : 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {msg.role === 'assistant'
                        ? msg.content.split(/(https?:\/\/[^\s]+)/).map((part, j) =>
                            /^https?:\/\//.test(part) ? (() => {
                              const preceding = msg.content.substring(0, msg.content.indexOf(part))
                              const nameMatch = preceding.match(/\*\*([^*]+)\*\*[^*]*$/) || preceding.match(/[-•]\s*([^\n(]+?)\s*[\n(](?=[^\n]*$)/)
                              const restaurantName = nameMatch ? nameMatch[1].trim() : 'this restaurant'
                              return <a key={j} href={part} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '7px 14px', borderRadius: 20, background: '#1A1028', color: '#fff', fontSize: 11, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>{restaurantName} →</a>
                            })() : <span key={j}>{part}</span>
                          )
                        : msg.content}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#EFB84A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>🤖</div>
                    <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: '16px 16px 16px 4px', padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 4 }}>{[0,150,300].map(d => <div key={d} style={{ width: 6, height: 6, borderRadius: '50%', background: '#ccc', animation: 'bounce 1s infinite', animationDelay: `${d}ms` }} />)}</div>
                    </div>
                  </div>
                )}
                <div ref={chatBottomRef} />
              </div>
              {chatMessages.length <= 1 && (
                <div style={{ padding: '8px 10px 4px', background: '#fafafa', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {['Birthday party for 20 🎂', 'Office lunch for 50 💼', 'Vegetarian options 🥗', 'Last-minute catering ⚡'].map(chip => (
                    <button key={chip} onClick={() => setChatInput(chip)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 12, border: '1.5px solid #e8e8e8', background: '#fff', color: '#555', cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>{chip}</button>
                  ))}
                </div>
              )}
              <div style={{ padding: '10px', background: '#fff', borderTop: '1px solid #f0f0f0', display: 'flex', gap: 8 }}>
                <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendChat()} placeholder="Ask about catering…" style={{ flex: 1, padding: '9px 12px', borderRadius: 20, border: '1.5px solid #e8e8e8', fontSize: 12.5, fontFamily: "'DM Sans',sans-serif", outline: 'none', background: '#fafafa', color: '#111' }} />
                <button onClick={sendChat} disabled={chatLoading || !chatInput.trim()} style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: '#5B6FE8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: (chatLoading || !chatInput.trim()) ? 0.4 : 1 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
                </button>
              </div>
            </div>
          )}

          <div style={{ width: 320, minWidth: 320, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0', background: '#fff' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
              <div style={{ position: 'relative' }}>
                <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#bbb', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input value={search} onChange={e => { setSearch(e.target.value); if (e.target.value.length > 2) trackEvent('search_performed', { search_term: e.target.value }) }} placeholder="Search restaurants…" style={{ width: '100%', padding: '9px 10px 9px 32px', borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fafafa', color: '#111', fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: 'none', boxSizing: 'border-box' }} />
              </div>
            </div>
            <div style={{ padding: '6px 12px', fontSize: 11, color: '#bbb', borderBottom: '1px solid #f0f0f0', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              {filtered.length} restaurants
              {proximityAnchor && (<><span style={{ fontSize: 10, background: '#f0f0ff', color: '#6B6EF9', padding: '1px 7px', borderRadius: 8, fontWeight: 600, marginLeft: 6 }}>📍 Nearby</span><button onClick={() => setProximityAnchor(null)} style={{ fontSize: 10, color: '#bbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', marginLeft: 4 }}>clear</button></>)}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {restaurantsLoaded && filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#bbb', fontSize: 13 }}>No restaurants match.</div>}
              {filtered.map((r, i) => (
                <div key={r._id} onClick={() => handleSidebarClick(r)} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', minHeight: 74, borderLeft: `3px solid ${activeId === r._id ? '#6B6EF9' : 'transparent'}`, background: activeId === r._id ? 'rgba(107,110,249,0.05)' : '#fff', transition: 'all 0.12s' }}>
                  {r.image ? <img src={r.image} alt={r.name} style={{ width: 74, height: 74, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 74, height: 74, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>✦</div>}
                  <div style={{ flex: 1, padding: '10px 12px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <div style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, background: activeId === r._id ? GRADIENT : '#f0f0f0', color: activeId === r._id ? '#fff' : '#999', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}{r.isDisco ? ' 🪩' : ''}</div>
                    </div>
                    <div style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>{r.location}</div>
                    <span style={{ fontSize: 10, background: '#f5f1eb', padding: '2px 7px', borderRadius: 10, color: '#888' }}>{r.cuisine}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, position: 'relative' }}>
            <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <form onSubmit={doLocSearch} style={{ display: 'flex', alignItems: 'stretch', background: '#fff', borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 16px rgba(0,0,0,0.12)', border: '1.5px solid #e8e8e8' }}>
                <div style={{ padding: '0 10px', color: '#bbb', flexShrink: 0, display: 'flex', alignItems: 'center' }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg></div>
                <input ref={locInputRef} value={locInput} onChange={e => { setLocInput(e.target.value); setLocError('') }} placeholder="Search by location…" style={{ padding: '9px 4px', fontSize: 12.5, border: 'none', outline: 'none', background: 'transparent', color: '#111', width: 380, fontFamily: "'DM Sans',sans-serif" }} />
                <button type="submit" disabled={locLoading} style={{ padding: '0 14px', border: 'none', cursor: 'pointer', background: '#5B6FE8', color: '#fff', fontSize: 11, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", flexShrink: 0 }}>{locLoading ? '...' : 'Go'}</button>
              </form>
              <button onClick={() => setChatOpen(o => !o)} style={{ width: 38, height: 38, borderRadius: '50%', border: 'none', background: '#EFB84A', cursor: 'pointer', flexShrink: 0, boxShadow: '0 2px 12px rgba(239,184,74,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, position: 'relative', transition: 'transform 0.15s' }} onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.1)' }} onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)' }} title="Ask Disco AI">
                🤖{!chatOpen && <div style={{ position: 'absolute', top: 1, right: 1, width: 9, height: 9, borderRadius: '50%', background: '#22c55e', border: '2px solid #fff' }} />}
              </button>
            </div>
            {locError && <div style={{ position: 'absolute', top: 56, left: 12, zIndex: 10, background: '#fff', border: '1px solid #f0c0c8', borderRadius: 8, padding: '6px 12px', fontSize: 12, color: '#F0468A', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>{locError}</div>}
            <div ref={mapContainer} style={mapDivStyle} />
          </div>
        </div>
      </div>
    </>
  )
}

export default function FullMapPage() {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'DM Sans, sans-serif', color: '#999', fontSize: 14 }}>Loading…</div>}>
      <FullMapInner />
    </Suspense>
  )
}