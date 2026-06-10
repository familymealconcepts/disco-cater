// Dinova-branded demo reskin of the Disco Cater fullmap (app/(customer)/fullmap).
// Same map, same restaurant data (/api/restaurants), same sidebar, cuisine
// pills, proximity search, and AI chat — only the colors, logo, AI button, a
// fake logged-in user, and a fake orders panel differ. Self-contained on
// purpose so it never touches the live fullmap component. Hidden + noindex.
'use client'
import React from 'react'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Script from 'next/script'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import FavoriteHeart from '../account/components/FavoriteHeart'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

// ── Dinova brand tokens (the only real difference from the live fullmap) ──────
const ORANGE = '#F5A623'        // Dinova primary (replaces #6B6EF9 / #5B6FE8)
const ORANGE_DARK = '#D98410'   // active/highlight (replaces the disco gradient)
const GRADIENT = ORANGE_DARK    // kept name; used for active markers/badges
const LOGO_GREY = '#777'
const TINT = 'rgba(245,166,35,0.07)'
const TINT_SOFT = 'rgba(245,166,35,0.05)'
const TINT_CHIP = '#FFF3E0'

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

function nearestNeighborOrder(list: Restaurant[], start: { lat: number; lng: number }): Restaurant[] {
  if (list.length === 0) return []
  const remaining = [...list]
  const result: Restaurant[] = []
  let cur = start
  while (remaining.length > 0) {
    let minIdx = 0, minDist = Infinity
    remaining.forEach((r, i) => {
      const d = getDistanceMiles(cur.lat, cur.lng, r.lat, r.lng)
      if (d < minDist) { minDist = d; minIdx = i }
    })
    result.push(remaining[minIdx])
    cur = { lat: remaining[minIdx].lat, lng: remaining[minIdx].lng }
    remaining.splice(minIdx, 1)
  }
  return result
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
  cuisines?: string[]
  lat: number
  lng: number
  isDisco: boolean
  orderUrl: string
  image?: string
  description?: string
  availableDays?: string[]
  slug?: { current: string }
}

const OCCASIONS = ['Work', 'Social', 'Holiday', 'Special Event']
const HEADCOUNTS = ['Under 20', '20–50', '50–100', '100+']
const CUISINES = ['Italian', 'Mexican', 'Japanese', 'Mediterranean', 'Indian', 'Korean', 'BBQ', 'Vegan', 'Surprise me']

type IntakeStep = 'location' | 'occasion' | 'headcount' | 'cuisine' | 'finding'

// ── Fake account data for the demo (no real auth) ────────────────────────────
const FAKE_USER = { firstName: 'Sarah', lastName: 'Mitchell', initials: 'SM', company: 'The Home Depot · Corporate' }
const FAKE_ORDERS = [
  { name: 'Son del Norte', detail: 'LES · May 14', price: '$2,100', people: '60 people' },
  { name: 'Taim', detail: 'Nolita · Recurring Tue', price: '$650', people: '25 people' },
  { name: 'Pecking House', detail: 'May 20', price: '$1,240', people: '40 people' },
]

export default function DinovaDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<{ [id: string]: mapboxgl.Marker }>({})
  const popupsRef = useRef<{ [id: string]: mapboxgl.Popup }>({})
  const searchParams = useSearchParams()
  const locInputRef = useRef<HTMLInputElement>(null)
  const chatBottomRef = useRef<HTMLDivElement>(null)
  const treeBottomRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [filtered, setFiltered] = useState<Restaurant[]>([])
  const [restaurantsLoaded, setRestaurantsLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<'all' | 'disco'>('all')
  const [cuisineFilter, setCuisineFilter] = useState('all')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [locInput, setLocInput] = useState('')
  const [locLoading, setLocLoading] = useState(false)
  const [locError, setLocError] = useState('')
  const [showLocModal, setShowLocModal] = useState(false)
  const [proximityAnchor, setProximityAnchor] = useState<{ lat: number; lng: number } | null>(null)
  const [sortAnchor, setSortAnchor] = useState<{ lat: number; lng: number } | null>(null)
  const PROXIMITY_MILES = 25
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)

  const [phase, setPhase] = useState<'intake' | 'results'>('intake')
  const [intakeStep, setIntakeStep] = useState<IntakeStep>('location')
  const [occasion, setOccasion] = useState('')
  const [headcount, setHeadcount] = useState('')
  const [cuisines, setCuisines] = useState<string[]>([])
  const [locationStr, setLocationStr] = useState('')
  const intakeLocRef = useRef<HTMLInputElement>(null)
  const [treeResults, setTreeResults] = useState<Restaurant[]>([])
  const [treeAiText, setTreeAiText] = useState('')
  const [treeLoading, setTreeLoading] = useState(false)

  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [mobileMapOpen, setMobileMapOpen] = useState(false)
  const filteredRef = useRef<Restaurant[]>([])
  const lastTapTimes = useRef<{ [id: string]: number }>({})
  const isMobileRef = useRef(false)
  const mobileSliderRef = useRef<HTMLDivElement>(null)
  const sliderScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tapResortPendingRef = useRef(false)

  useEffect(() => { isMobileRef.current = isMobile }, [isMobile])

  useEffect(() => {
    Object.entries(markersRef.current).forEach(([id, marker]) => {
      const mkDiv = marker.getElement().firstChild as HTMLElement
      if (!mkDiv) return
      const r = restaurants.find(rest => rest._id === id)
      if (id === activeId) {
        mkDiv.style.background = GRADIENT
        mkDiv.style.transform = 'scale(1.2)'
      } else {
        mkDiv.style.background = ORANGE
        if (r) mkDiv.style.border = r.isDisco ? '2.5px solid #EFB84A' : '2.5px solid #fff'
        mkDiv.style.transform = 'scale(1)'
      }
    })
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleSliderScroll(e: React.UIEvent<HTMLDivElement>) {
    if (sliderScrollTimerRef.current) clearTimeout(sliderScrollTimerRef.current)
    sliderScrollTimerRef.current = setTimeout(() => {
      if (!mobileSliderRef.current) return
      const slider = mobileSliderRef.current
      const stride = (slider.children[0] as HTMLElement)?.offsetWidth + 12 || slider.offsetWidth
      const idx = Math.round(slider.scrollLeft / stride)
      const r = filteredRef.current[idx]
      if (r && r._id !== activeId) {
        setActiveId(r._id)
        map.current?.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.current.getZoom(), 11), speed: 2, essential: true })
      }
    }, 150)
  }

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
      .then(data => {
        const rows: Restaurant[] = (Array.isArray(data) ? data : []).map((r: {
          reference: string; name: string; slug?: string; cuisine?: string
          description?: string; image?: string | null; lat: number; lng: number
          location?: string; orderUrl?: string; isPremium?: boolean
        }) => ({
          _id: r.reference,
          name: r.name,
          location: r.location || '',
          cuisine: r.cuisine || 'Other',
          cuisines: r.cuisine ? [r.cuisine] : [],
          lat: r.lat,
          lng: r.lng,
          isDisco: !!r.isPremium,
          orderUrl: r.orderUrl || '',
          image: r.image || undefined,
          description: r.description || undefined,
          slug: r.slug ? { current: r.slug } : undefined,
        }))
        setRestaurants(rows); setFiltered(rows); setRestaurantsLoaded(true)
      })
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
    map.current.scrollZoom.disable()
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

  const initIntakeAutocomplete = useCallback(() => {
    if (!intakeLocRef.current || !(window as any).google?.maps?.places) return
    const ac = new (window as any).google.maps.places.Autocomplete(intakeLocRef.current, {
      types: ['geocode', 'establishment'],
      componentRestrictions: { country: 'us' },
    })
    ac.addListener('place_changed', () => {
      const place = ac.getPlace()
      if (!place.geometry?.location) return
      const lat = place.geometry.location.lat()
      const lng = place.geometry.location.lng()
      const label = place.formatted_address || place.name || ''
      setLocInput(label)
      setLocationStr(label)
      map.current?.flyTo({ center: [lng, lat], zoom: 11, speed: 3, essential: true })
      setProximityAnchor({ lat, lng })
      setIntakeStep('occasion')
    })
  }, [])

  useEffect(() => {
    if (!chatOpen || phase !== 'intake' || intakeStep !== 'location') return
    initIntakeAutocomplete()
    const t = setTimeout(initIntakeAutocomplete, 600)
    return () => clearTimeout(t)
  }, [chatOpen, phase, intakeStep, initIntakeAutocomplete])

  useEffect(() => {
    if (phase === 'intake' && intakeStep === 'location' && proximityAnchor) {
      setIntakeStep('occasion')
    }
  }, [phase, intakeStep, proximityAnchor])

  useEffect(() => {
    let out = restaurants
    if (stageFilter === 'disco') out = out.filter(r => r.isDisco)
    if (cuisineFilter !== 'all') out = out.filter(r =>
      (r.cuisines && r.cuisines.includes(cuisineFilter)) || r.cuisine === cuisineFilter
    )
    if (search.trim()) {
      const q = search.toLowerCase()
      out = out.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.location.toLowerCase().includes(q) ||
        r.cuisine.toLowerCase().includes(q) ||
        (r.cuisines || []).some(c => c.toLowerCase().includes(q))
      )
    }
    if (proximityAnchor) {
      const nearby = (out as any[])
        .map(r => ({ ...r, _dist: getDistanceMiles(proximityAnchor.lat, proximityAnchor.lng, r.lat, r.lng) }))
        .filter(r => r._dist <= PROXIMITY_MILES)
      out = nearestNeighborOrder(nearby, proximityAnchor)
    } else if (sortAnchor) {
      // Mobile tap re-sort — nearest-neighbor from the tapped restaurant.
      out = nearestNeighborOrder(out, sortAnchor)
    } else {
      // Default (no location search): Premium restaurants first, then the rest,
      // alphabetical by name within each group. (isDisco is the mapped isPremium.)
      out = [...out].sort((a, b) =>
        a.isDisco === b.isDisco ? a.name.localeCompare(b.name) : (a.isDisco ? -1 : 1)
      )
    }
    setFiltered(out)
    filteredRef.current = out

    if (tapResortPendingRef.current && isMobileRef.current && mobileSliderRef.current) {
      tapResortPendingRef.current = false
      const currentActiveId = activeId
      const idx = out.findIndex(r => r._id === currentActiveId)
      if (idx >= 0) {
        const slider = mobileSliderRef.current
        setTimeout(() => {
          const stride = (slider.children[0] as HTMLElement)?.offsetWidth + 12 || slider.offsetWidth
          slider.scrollTo({ left: idx * stride, behavior: 'smooth' })
        }, 0)
      }
    }
  }, [search, stageFilter, cuisineFilter, restaurants, proximityAnchor, sortAnchor]) // eslint-disable-line react-hooks/exhaustive-deps

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
        background: ORANGE, color: '#fff', fontSize: '10px', fontWeight: '700',
        position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: r.isDisco ? '2.5px solid #EFB84A' : '2.5px solid #fff',
        boxShadow: r.isDisco ? '0 2px 10px rgba(239,184,74,0.4)' : '0 2px 10px rgba(0,0,0,0.15)',
        fontFamily: "'DM Sans',sans-serif", cursor: 'pointer', transition: 'all 0.15s',
      })
      mkDiv.textContent = String(i + 1)
      el.appendChild(mkDiv)

      const marker = new mapboxgl.Marker(el).setLngLat([r.lng, r.lat])

      if (isMobileRef.current) {
        el.addEventListener('click', () => {
          tapResortPendingRef.current = true
          setActiveId(r._id)
          setSortAnchor({ lat: r.lat, lng: r.lng })
          trackEvent('restaurant_click', { restaurant_name: r.name, cuisine: r.cuisine })
          map.current?.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.current.getZoom(), 13), speed: 3, essential: true })
        })
      } else {
        const popup = new mapboxgl.Popup({
          offset: [0, -44], closeButton: false, closeOnClick: false, maxWidth: '290px', className: 'disco-popup',
        }).setHTML(`
          <div style="font-family:'DM Sans',sans-serif;width:270px;border-radius:12px;overflow:hidden;position:relative;box-shadow:0 4px 24px rgba(0,0,0,0.13)">
            <button onclick="this.closest('.mapboxgl-popup').remove()" style="position:absolute;top:8px;right:8px;z-index:10;width:26px;height:26px;border-radius:50%;background:rgba(0,0,0,0.55);color:#fff;border:none;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;backdrop-filter:blur(4px);">×</button>
            ${r.image ? `<div style="height:140px;overflow:hidden"><img src="${r.image}" style="width:100%;height:100%;object-fit:cover"/></div>` : ''}
            <div style="padding:14px 16px 16px">
              <div style="font-size:14px;font-weight:700;margin-bottom:2px;color:#111">✦ ${r.name}${r.isDisco ? ' ★' : ''}</div>
              <div style="font-size:11px;color:#999;margin-bottom:8px">${r.location}</div>
              ${r.description ? `<div style="font-size:11.5px;color:#555;line-height:1.55;margin-bottom:10px">${r.description}</div>` : ''}
              <div style="display:flex;gap:5px;margin-bottom:12px">
                ${((r.cuisines && r.cuisines.length > 0) ? r.cuisines : [r.cuisine]).map(tag => `<span style="font-size:10px;background:#f5f1eb;border:1px solid #e8e0d8;padding:2px 8px;border-radius:10px;color:#888">${tag}</span>`).join('')}
              </div>
              <a href="${r.slug?.current ? '/restaurants/' + r.slug.current : r.orderUrl || '#'}" style="display:block;width:100%;padding:10px 0;background:${ORANGE};color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;text-align:center;text-decoration:none;box-sizing:border-box">Order Catering →</a>
            </div>
          </div>
        `)
        popupsRef.current[r._id] = popup
        popup.on('close', () => {
          mkDiv.style.background = ORANGE
          mkDiv.style.border = r.isDisco ? '2.5px solid #EFB84A' : '2.5px solid #fff'
          mkDiv.style.transform = 'scale(1)'
          setActiveId(null)
        })
        el.addEventListener('click', () => {
          closeAllPopups()
          setActiveId(r._id)
          trackEvent('restaurant_click', { restaurant_name: r.name, cuisine: r.cuisine })
          mkDiv.style.background = GRADIENT
          mkDiv.style.transform = 'scale(1.2)'
          const mapH = mapContainer.current?.clientHeight ?? 600
          const popupH = r.image ? 340 : 220
          const verticalOffset = Math.round((mapH / 2) - (popupH / 2) - 44)
          map.current?.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.current.getZoom(), 11), speed: 3, essential: true, offset: [0, -verticalOffset] })
        })
        marker.setPopup(popup)
      }

      marker.addTo(map.current!)
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

  function extractRecommendedRestaurants(aiText: string, allRestaurants: Restaurant[]): Restaurant[] {
    const boldNames = [...aiText.matchAll(/\*\*([^*]+)\*\*/g)].map(m => m[1].trim())
    const results: Restaurant[] = []
    for (const name of boldNames) {
      const match = allRestaurants.find(r =>
        r.name.toLowerCase() === name.toLowerCase() ||
        r.name.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(r.name.toLowerCase())
      )
      if (match && !results.find(r => r._id === match._id)) results.push(match)
      if (results.length >= 3) break
    }
    if (results.length === 0) {
      const numbered = [...aiText.matchAll(/\d+\.\s+\*?\*?([^*\n(,]+)/g)].map(m => m[1].trim())
      for (const name of numbered) {
        const key = name.toLowerCase().slice(0, 12)
        const match = allRestaurants.find(r =>
          r.name.toLowerCase().includes(key) || key.includes(r.name.toLowerCase().slice(0, 12))
        )
        if (match && !results.find(r => r._id === match._id)) results.push(match)
        if (results.length >= 3) break
      }
    }
    return results
  }

  function candidateRestaurants() {
    return filtered.map(r => ({
      name: r.name, cuisine: r.cuisine, location: r.location,
      isDisco: r.isDisco, orderUrl: r.orderUrl, description: r.description,
    }))
  }

  function buildIntake(finalCuisines = cuisines) {
    return {
      occasion,
      headcount,
      cuisines: finalCuisines,
      location: locationStr || locInput || '',
    }
  }

  async function runDiscoIntake(finalCuisines: string[]) {
    setIntakeStep('finding')
    setTreeLoading(true)
    const intake = buildIntake(finalCuisines)
    trackEvent('ai_intake_submitted', { occasion, headcount, cuisines: finalCuisines.join(',') })
    try {
      const res = await fetch('/api/disco-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Recommend catering options for my event.' }],
          restaurants: candidateRestaurants(),
          intake,
        }),
      })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const data = await res.json()
      const reply: string = data.reply || ''
      setTreeAiText(reply)
      setTreeResults(extractRecommendedRestaurants(reply, restaurants))
    } catch {
      setTreeAiText("Sorry, I couldn't get recommendations. Please try again.")
      setTreeResults([])
    } finally {
      setTreeLoading(false)
      setPhase('results')
      setTimeout(() => treeBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 150)
    }
  }

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
          restaurants: candidateRestaurants(),
          intake: buildIntake(),
        }),
      })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const data = await res.json()
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.reply || 'Sorry, try again.' }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }])
    } finally {
      setChatLoading(false)
    }
  }

  function toggleCuisine(c: string) {
    if (c === 'Surprise me') { setCuisines(prev => prev.includes(c) ? [] : ['Surprise me']); return }
    setCuisines(prev =>
      prev.includes(c) ? prev.filter(x => x !== c) : [...prev.filter(x => x !== 'Surprise me'), c]
    )
  }

  function stashIntakeForHandoff() {
    try { sessionStorage.setItem('disco_intake', JSON.stringify(buildIntake())) } catch {}
  }

  function resetIntake() {
    setPhase('intake')
    setIntakeStep(proximityAnchor ? 'occasion' : 'location')
    setOccasion('')
    setHeadcount('')
    setCuisines([])
    setLocationStr('')
    setTreeResults([])
    setTreeAiText('')
    setTreeLoading(false)
    setChatMessages([])
    setChatInput('')
  }

  function handleSidebarClick(r: Restaurant) {
    trackEvent('restaurant_click', { restaurant_name: r.name, cuisine: r.cuisine })
    closeAllPopups()
    setActiveId(r._id)
    if (!map.current) return
    if (isMobileRef.current) {
      tapResortPendingRef.current = true
      setSortAnchor({ lat: r.lat, lng: r.lng })
      map.current.flyTo({ center: [r.lng, r.lat], zoom: 14, speed: 3, essential: true })
    } else {
      const mapH = mapContainer.current?.clientHeight ?? 600
      const popupH = r.image ? 340 : 220
      const verticalOffset = Math.round((mapH / 2) - (popupH / 2) - 44)
      map.current.flyTo({ center: [r.lng, r.lat], zoom: 14, speed: 3, essential: true, offset: [0, -verticalOffset] })
      map.current.once('moveend', () => {
        const marker = markersRef.current[r._id]
        const popup = popupsRef.current[r._id]
        if (marker && popup && !popup.isOpen()) marker.togglePopup()
      })
    }
  }

  const [showMoreCuisines, setShowMoreCuisines] = useState(false)
  const MAX_VISIBLE_CUISINES = 7

  const cuisineCounts: Record<string, number> = {}
  restaurants.forEach(r => {
    const tags = (r.cuisines && r.cuisines.length > 0) ? r.cuisines : [r.cuisine]
    tags.forEach(t => { if (t) cuisineCounts[t] = (cuisineCounts[t] || 0) + 1 })
  })
  const PREFERRED_CUISINES = ['Sandwiches', 'Bagels', 'Deli', 'Chicken', 'Breakfast', 'Mexican', 'Pizza']
  const EXCLUDED_CUISINES = ['American', 'Cafe']
  const preferredAvailable = PREFERRED_CUISINES.filter(c => cuisineCounts[c] > 0)
  const otherCuisines = Object.entries(cuisineCounts)
    .filter(([c]) => !PREFERRED_CUISINES.includes(c) && !EXCLUDED_CUISINES.includes(c))
    .sort((a, b) => b[1] - a[1]).map(e => e[0])
  const topCuisines = [...preferredAvailable, ...otherCuisines].slice(0, 12)

  const pillStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 20, overflow: 'hidden', border: 'none',
    background: active ? '#1A1028' : '#efefef', color: active ? '#fff' : '#555',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: "'DM Sans',sans-serif", flexShrink: 0,
  })
  const gradientPillStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 20, overflow: 'hidden', border: 'none',
    background: active ? ORANGE : '#efefef',
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
    background: gradient && active ? ORANGE
      : active ? '#1A1028' : '#f0f0f0',
    color: active ? '#fff' : '#555',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const,
    fontFamily: "'DM Sans',sans-serif", flexShrink: 0, minHeight: 36,
    display: 'flex', alignItems: 'center',
  })

  const mapDivStyle: React.CSSProperties = { width: '100%', height: '100%' }

  // "Powered by Disco Cater" badge — bottom corner of the map.
  const poweredByBadge = (
    <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(255,255,255,0.94)', border: '1px solid #ececec', borderRadius: 8, padding: '5px 10px', fontSize: 10.5, color: '#999', fontFamily: "'DM Sans',sans-serif", fontWeight: 600, boxShadow: '0 2px 8px rgba(0,0,0,0.08)', whiteSpace: 'nowrap' }}>
      Powered by <span style={{ background: 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', fontWeight: 700 }}>disco</span><span style={{ color: '#aaa' }}> cater</span>
    </div>
  )

  const dinovaLogo = (
    <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.3px', fontFamily: "'DM Sans',sans-serif" }}>
      <span style={{ color: ORANGE }}>dino</span><span style={{ color: LOGO_GREY }}>va</span>
    </span>
  )

  const locModal = showLocModal && (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 20, padding: '32px 28px', maxWidth: 360, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', animation: 'fadeUp 0.25s ease', textAlign: 'center', fontFamily: "'DM Sans',sans-serif" }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>📍</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 8 }}>Find catering near you</div>
        <div style={{ fontSize: 13, color: '#888', lineHeight: 1.6, marginBottom: 24 }}>Share your location to instantly see restaurants that can cater near you.</div>
        <button onClick={requestLocation} style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: ORANGE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10, fontFamily: "'DM Sans',sans-serif" }}>Share my location</button>
        <button onClick={() => setShowLocModal(false)} style={{ width: '100%', padding: '11px', borderRadius: 12, border: '1.5px solid #e8e8e8', background: '#fff', color: '#888', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Maybe later</button>
      </div>
    </div>
  )

  function renderTreeContent(compact: boolean) {
    const p = compact ? '14px 12px' : '20px 18px'
    const titleSz = compact ? 15 : 17
    const bodySz = compact ? 12 : 13
    const pillPadding = compact ? '8px 13px' : '9px 16px'
    const pillFontSz = compact ? 12 : 13
    const cardImgH = compact ? 110 : 130
    const DK = '#1A1028'

    const chip = (label: string, selected: boolean, onClick: () => void) => (
      <button
        key={label}
        onClick={onClick}
        onMouseOver={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = TINT_CHIP }}
        onMouseOut={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = '#fff' }}
        style={{
          padding: pillPadding, borderRadius: 999, border: `1.5px solid ${DK}`,
          background: selected ? DK : '#fff', color: selected ? '#fff' : DK,
          fontSize: pillFontSz, fontWeight: 600, cursor: 'pointer',
          fontFamily: "'DM Sans',sans-serif", transition: 'background 0.12s, color 0.12s', lineHeight: 1.3,
        }}
      >
        {label}
      </button>
    )

    const order: IntakeStep[] = (proximityAnchor || locationStr)
      ? ['occasion', 'headcount', 'cuisine']
      : ['location', 'occasion', 'headcount', 'cuisine']
    const backTo: Partial<Record<IntakeStep, IntakeStep>> = { headcount: 'occasion', cuisine: 'headcount' }

    const stepHeader = (question: string, current: IntakeStep) => {
      const idx = order.indexOf(current)
      return (
        <div style={{ marginBottom: compact ? 14 : 18 }}>
          <div style={{ fontSize: 11, color: '#aaa', marginBottom: 8, fontFamily: "'DM Sans',sans-serif", display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Step {idx + 1} of {order.length}</span>
            {backTo[current] && (
              <button onClick={() => setIntakeStep(backTo[current] as IntakeStep)} style={{ fontSize: 11, color: DK, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>← Back</button>
            )}
          </div>
          <div style={{ fontSize: titleSz, fontWeight: 700, color: '#111', fontFamily: "'DM Sans',sans-serif" }}>{question}</div>
        </div>
      )
    }

    if (phase === 'intake') {
      if (intakeStep === 'finding' || treeLoading) {
        return (
          <div key="loading" style={{ padding: p }}>
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <div style={{ fontSize: bodySz, color: '#585786', marginBottom: 20, fontFamily: "'DM Sans',sans-serif" }}>Finding your options…</div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                {[0, 150, 300].map(d => (
                  <div key={d} style={{ width: 8, height: 8, borderRadius: '50%', background: DK, animation: 'bounce 1s infinite', animationDelay: `${d}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )
      }

      if (intakeStep === 'location') {
        return (
          <div key="step-location" style={{ padding: p, animation: 'treeSlide 0.22s ease' }}>
            {stepHeader('Where are you ordering?', 'location')}
            <input
              ref={intakeLocRef}
              value={locInput}
              onChange={e => setLocInput(e.target.value)}
              onKeyDown={async e => {
                if (e.key !== 'Enter' || !locInput.trim()) return
                try {
                  const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locInput)}&format=json&limit=1&countrycodes=us`, { headers: { 'Accept-Language': 'en' } })
                  const data = await res.json()
                  if (data?.[0]) {
                    const { lat, lon } = data[0]
                    map.current?.flyTo({ center: [parseFloat(lon), parseFloat(lat)], zoom: 11, speed: 3, essential: true })
                    setLocationStr(locInput)
                    setProximityAnchor({ lat: parseFloat(lat), lng: parseFloat(lon) })
                    setIntakeStep('occasion')
                  }
                } catch {}
              }}
              placeholder="City or address…"
              style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${DK}`, fontSize: 14, fontFamily: "'DM Sans',sans-serif", outline: 'none', background: '#fff', color: '#111' }}
            />
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 8, fontFamily: "'DM Sans',sans-serif" }}>Start typing and pick a suggestion.</div>
          </div>
        )
      }

      if (intakeStep === 'occasion') {
        return (
          <div key="step-occasion" style={{ padding: p, animation: 'treeSlide 0.22s ease' }}>
            {stepHeader("What's the occasion?", 'occasion')}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {OCCASIONS.map(o => chip(o, occasion === o, () => { setOccasion(o); setIntakeStep('headcount') }))}
            </div>
          </div>
        )
      }

      if (intakeStep === 'headcount') {
        return (
          <div key="step-headcount" style={{ padding: p, animation: 'treeSlide 0.22s ease' }}>
            {stepHeader('How many people?', 'headcount')}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {HEADCOUNTS.map(h => chip(h, headcount === h, () => { setHeadcount(h); setIntakeStep('cuisine') }))}
            </div>
          </div>
        )
      }

      return (
        <div key="step-cuisine" style={{ padding: p, animation: 'treeSlide 0.22s ease' }}>
          {stepHeader('Any cuisine preferences?', 'cuisine')}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {CUISINES.map(c => chip(c, cuisines.includes(c), () => toggleCuisine(c)))}
          </div>
          <button
            onClick={() => runDiscoIntake(cuisines)}
            style={{ width: '100%', padding: compact ? '11px' : '12px', borderRadius: 10, border: 'none', background: DK, color: '#fff', fontSize: compact ? 13 : 14, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", marginBottom: 10 }}
          >
            See options →
          </button>
          <button
            onClick={() => runDiscoIntake([])}
            style={{ display: 'block', margin: '0 auto', background: 'none', border: 'none', color: '#999', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", textDecoration: 'underline' }}
          >
            Skip
          </button>
        </div>
      )
    }

    return (
      <div key="results" style={{ padding: p }}>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
          {[occasion, headcount, ...cuisines, locationStr].filter(Boolean).map(s => (
            <span key={s} style={{ fontSize: 10, background: TINT_CHIP, color: ORANGE_DARK, padding: '3px 9px', borderRadius: 20, fontWeight: 600, fontFamily: "'DM Sans',sans-serif" }}>
              {s}
            </span>
          ))}
        </div>

        <div style={{ fontSize: compact ? 13 : 14, fontWeight: 700, color: '#111', marginBottom: 14, fontFamily: "'DM Sans',sans-serif" }}>
          {treeResults.length > 0 ? 'Your options' : 'What we found'}
        </div>

        {treeResults.length === 0 && treeAiText && (
          <div style={{ fontSize: bodySz, color: '#555', lineHeight: 1.65, marginBottom: 16, fontFamily: "'DM Sans',sans-serif", whiteSpace: 'pre-wrap', background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12, padding: compact ? '12px 14px' : '14px 16px' }}>
            {treeAiText}
          </div>
        )}

        {treeResults.map(r => {
          const internalHref = r.slug?.current ? `/restaurants/${r.slug.current}` : ''
          const href = internalHref || r.orderUrl || ''
          return (
          <div key={r._id} style={{ background: '#fff', borderRadius: 12, border: '1.5px solid #e8e8e8', overflow: 'hidden', marginBottom: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.06)' }}>
            {r.image && (
              <img src={r.image} alt={r.name} style={{ width: '100%', height: cardImgH, objectFit: 'cover', display: 'block' }} />
            )}
            <div style={{ padding: compact ? '10px 12px 13px' : '13px 14px 15px' }}>
              <div style={{ fontSize: compact ? 13 : 14, fontWeight: 700, color: '#111', marginBottom: 6, fontFamily: "'DM Sans',sans-serif" }}>
                {r.name}{r.isDisco ? ' ★' : ''}
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                {((r.cuisines && r.cuisines.length > 0) ? r.cuisines : [r.cuisine]).map(tag => (
                  <span key={tag} style={{ fontSize: 10, background: '#f5f1eb', padding: '2px 7px', borderRadius: 10, color: '#888', fontFamily: "'DM Sans',sans-serif" }}>{tag}</span>
                ))}
              </div>
              {href ? (
                <a
                  href={href}
                  onClick={stashIntakeForHandoff}
                  {...(internalHref ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
                  style={{ display: 'block', textAlign: 'center', padding: compact ? '9px 0' : '10px 0', background: DK, color: '#fff', borderRadius: 8, textDecoration: 'none', fontSize: compact ? 12 : 13, fontWeight: 700, fontFamily: "'DM Sans',sans-serif" }}
                >
                  View &amp; Order →
                </a>
              ) : (
                <div style={{ textAlign: 'center', padding: compact ? '9px 0' : '10px 0', background: '#f5f5f5', color: '#bbb', borderRadius: 8, fontSize: compact ? 12 : 13, fontWeight: 600, fontFamily: "'DM Sans',sans-serif" }}>
                  No order link available
                </div>
              )}
            </div>
          </div>
          )
        })}

        {chatMessages.length > 0 && (
          <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {chatMessages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '88%', padding: '8px 12px',
                  borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                  background: m.role === 'user' ? ORANGE : '#fff',
                  color: m.role === 'user' ? '#fff' : '#111',
                  fontSize: compact ? 12 : 13, lineHeight: 1.55,
                  fontFamily: "'DM Sans',sans-serif",
                  border: m.role === 'assistant' ? '1px solid #f0f0f0' : 'none',
                  boxShadow: m.role === 'assistant' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {m.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div style={{ display: 'flex' }}>
                <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: '14px 14px 14px 4px', padding: '10px 14px' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[0, 150, 300].map(d => <div key={d} style={{ width: 6, height: 6, borderRadius: '50%', background: '#ccc', animation: 'bounce 1s infinite', animationDelay: `${d}ms` }} />)}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: '#aaa', marginBottom: 7, fontFamily: "'DM Sans',sans-serif" }}>Have a follow-up question?</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendChat()}
              placeholder="Ask something…"
              style={{ flex: 1, padding: compact ? '8px 11px' : '9px 13px', borderRadius: 20, border: '1.5px solid #e8e8e8', fontSize: compact ? 12 : 12.5, fontFamily: "'DM Sans',sans-serif", outline: 'none', background: '#fff', color: '#111' }}
            />
            <button
              onClick={sendChat}
              disabled={chatLoading || !chatInput.trim()}
              style={{ width: compact ? 34 : 38, height: compact ? 34 : 38, borderRadius: '50%', border: 'none', background: ORANGE, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: (chatLoading || !chatInput.trim()) ? 0.4 : 1, alignSelf: 'center' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
            </button>
          </div>
        </div>

        <button
          onClick={resetIntake}
          style={{ width: '100%', padding: compact ? '9px' : '10px', borderRadius: 8, border: 'none', background: 'none', color: '#999', fontSize: compact ? 12 : 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", textDecoration: 'underline' }}
        >
          Start over
        </button>

        <div ref={treeBottomRef} />
      </div>
    )
  }

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
          @keyframes treeSlide { from { opacity:0; transform:translateX(10px) } to { opacity:1; transform:translateX(0) } }
          .disco-popup .mapboxgl-popup-content { padding:0; border-radius:12px; overflow:hidden; box-shadow:none; }
          .disco-popup .mapboxgl-popup-tip { display:none; }
          .mobile-filter-scroll::-webkit-scrollbar { display:none; }
          .mobile-filter-scroll { -ms-overflow-style:none; scrollbar-width:none; }
          @keyframes skeletonPulse { 0%,100% { opacity:0.6 } 50% { opacity:1 } }
        `}</style>

        {locModal}

        {chatOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: '#fafafa', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans',sans-serif" }}>
            <div style={{ padding: '12px 16px', background: ORANGE, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
              <div style={{ fontSize: 22 }}>🤖</div>
              <div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Dinova AI</div>
                <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>Catering Assistant</div>
              </div>
              <button onClick={() => setChatOpen(false)} style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.2)', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 20, lineHeight: 1, padding: '6px 10px', borderRadius: 8 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' as any }}>
              {renderTreeContent(false)}
            </div>
            <div style={{ height: 'env(safe-area-inset-bottom, 0px)', background: '#fafafa', flexShrink: 0 }} />
          </div>
        )}

        <div style={{ fontFamily: "'DM Sans',sans-serif", height: '100svh', display: 'flex', flexDirection: 'column', background: '#fff', color: '#111', overflow: 'hidden' }}>

          <div style={{ display: 'flex', alignItems: 'center', padding: '9px 14px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, background: `linear-gradient(180deg,${TINT} 0%,${TINT_SOFT} 100%),#fff` }}>
            <Link href="/dinova-demo" style={{ textDecoration: 'none', flexShrink: 0 }}>{dinovaLogo}</Link>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => setChatOpen(o => !o)} style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: ORANGE, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, position: 'relative', flexShrink: 0 }}>🤖{!chatOpen && <div style={{ position: 'absolute', top: 1, right: 1, width: 8, height: 8, borderRadius: '50%', background: '#22c55e', border: '1.5px solid #fff' }} />}</button>
              <DinovaUserMenu />
            </div>
          </div>

          <div style={{ padding: '12px 16px 8px', background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
            <form onSubmit={doLocSearch} style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: '#f5f5f5', borderRadius: 12, padding: '0 14px', border: '1.5px solid #e8e8e8', gap: 8 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
                <input ref={locInputRef} value={locInput} onChange={e => { setLocInput(e.target.value); setLocError('') }} placeholder="Search by location…" style={{ flex: 1, padding: '13px 0', fontSize: 16, border: 'none', outline: 'none', background: 'transparent', color: '#111', fontFamily: "'DM Sans',sans-serif" }} />
                {locInput && <button type="button" onClick={() => { setLocInput(''); setProximityAnchor(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', fontSize: 18, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>}
              </div>
              <button type="submit" disabled={locLoading} style={{ padding: '0 18px', borderRadius: 12, border: 'none', background: ORANGE, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", flexShrink: 0, minHeight: 48 }}>{locLoading ? '…' : 'Go'}</button>
            </form>
            {locError && <div style={{ marginTop: 6, fontSize: 12, color: '#F0468A', paddingLeft: 4 }}>{locError}</div>}
            {proximityAnchor && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, paddingLeft: 4 }}>
                <span style={{ fontSize: 12, background: TINT_CHIP, color: ORANGE_DARK, padding: '3px 10px', borderRadius: 8, fontWeight: 600 }}>📍 Showing nearby</span>
                <button onClick={() => { setProximityAnchor(null); setLocInput('') }} style={{ fontSize: 12, color: '#bbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Clear</button>
              </div>
            )}
          </div>

          <div className="mobile-filter-scroll" style={{ display: 'flex', gap: 8, padding: '10px 16px', overflowX: 'auto', flexShrink: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', alignItems: 'center' }}>
            <button style={mobilePillStyle(stageFilter === 'disco', true)} onClick={() => setStageFilter(s => s === 'disco' ? 'all' : 'disco')}>★ Premium</button>
            <div style={{ width: 1, height: 20, background: '#e0e0e0', flexShrink: 0 }} />
            <button style={mobilePillStyle(cuisineFilter === 'all')} onClick={() => setCuisineFilter('all')}>All</button>
            {topCuisines.map(c => <button key={c} style={mobilePillStyle(cuisineFilter === c)} onClick={() => setCuisineFilter(c)}>{c}</button>)}
          </div>

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
              <button onClick={() => setMobileSearchOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: mobileSearchOpen ? ORANGE : '#bbb' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
            </div>
          </div>

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
                  <button type="submit" disabled={locLoading} style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: ORANGE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", flexShrink: 0 }}>{locLoading ? '…' : 'Go'}</button>
                </form>
              </div>
              <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                <div ref={mapContainer} style={{ position: 'absolute', inset: 0 }} />
                {poweredByBadge}
                {proximityAnchor && (
                  <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
                    <button onClick={() => { setProximityAnchor(null); setLocInput('') }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 20, background: '#fff', border: '1px solid #e0e0e0', fontSize: 12, fontWeight: 600, color: '#555', cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', fontFamily: "'DM Sans',sans-serif" }}>
                      📍 Showing nearby · Clear
                    </button>
                  </div>
                )}
                {filtered.length > 0 && (
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10, background: 'linear-gradient(to top, rgba(0,0,0,0.32) 0%, transparent 100%)', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
                    <div
                      ref={mobileSliderRef}
                      className="mobile-filter-scroll"
                      onScroll={handleSliderScroll}
                      style={{ display: 'flex', gap: '12px', overflowX: 'auto', scrollSnapType: 'x mandatory', scrollPaddingLeft: '16px', WebkitOverflowScrolling: 'touch' as any, paddingBottom: '10px' }}
                    >
                      {filtered.map((r, i) => (
                        <div key={r._id} style={{ flexShrink: 0, width: 'calc(100% - 64px)', scrollSnapAlign: 'start', marginLeft: i === 0 ? 16 : 0, paddingTop: 12 }}>
                          <div
                            onClick={() => handleSidebarClick(r)}
                            style={{ background: '#fff', borderRadius: 14, overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.18)', cursor: 'pointer', border: `2.5px solid ${activeId === r._id ? ORANGE : 'transparent'}`, transition: 'border-color 0.15s' }}
                          >
                            {r.image
                              ? <img src={r.image} alt={r.name} style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }} />
                              : <div style={{ height: 96, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>✦</div>
                            }
                            <div style={{ padding: '8px 12px 10px' }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: "'DM Sans',sans-serif" }}>
                                {i + 1}. {r.name}{r.isDisco ? ' ★' : ''}
                              </div>
                              <div style={{ fontSize: 11, color: '#bbb', marginBottom: 6, fontFamily: "'DM Sans',sans-serif" }}>{r.location}</div>
                              <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                                {((r.cuisines && r.cuisines.length > 0) ? r.cuisines.slice(0, 3) : [r.cuisine]).map(tag => (
                                  <span key={tag} style={{ fontSize: 10, background: '#f5f1eb', padding: '2px 7px', borderRadius: 10, color: '#888', whiteSpace: 'nowrap' }}>{tag}</span>
                                ))}
                              </div>
                              {r.orderUrl ? (
                                <a href={r.slug?.current ? `/restaurants/${r.slug.current}` : r.orderUrl} onClick={e => e.stopPropagation()}
                                  style={{ display: 'block', textAlign: 'center', padding: '8px 0', background: ORANGE, color: '#fff', borderRadius: 8, textDecoration: 'none', fontSize: 12, fontWeight: 700, fontFamily: "'DM Sans',sans-serif" }}>
                                  Order Catering →
                                </a>
                              ) : (
                                <div style={{ textAlign: 'center', padding: '8px 0', background: '#f5f5f5', color: '#bbb', borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
                                  No order link
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      <div style={{ flexShrink: 0, width: 16 }} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

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
            {!restaurantsLoaded && <SkeletonCards count={6} mobile />}
            {restaurantsLoaded && filtered.length === 0 && (
              <div style={{ padding: '48px 24px', textAlign: 'center', color: '#777', fontSize: 14 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
                {proximityAnchor ? (
                  <>
                    <div style={{ marginBottom: 14, lineHeight: 1.5 }}>
                      No restaurants found near <strong style={{ color: '#1A1028' }}>{locInput || 'this area'}</strong>.<br />
                      Try expanding your search or browsing all restaurants.
                    </div>
                    <button onClick={() => { setProximityAnchor(null); setLocInput('') }} style={{ padding: '9px 18px', borderRadius: 20, background: '#1A1028', color: '#fff', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
                      Clear location filter
                    </button>
                  </>
                ) : 'No restaurants match.'}
              </div>
            )}
            {filtered.map((r, i) => (
                <div
                  key={r._id}
                  onClick={() => {
                    const now = Date.now()
                    const last = (lastTapTimes.current[r._id] ?? 0)
                    if (now - last < 350) {
                      if (r.orderUrl) window.open(r.slug?.current ? `/restaurants/${r.slug.current}` : r.orderUrl, '_blank', 'noopener,noreferrer')
                      lastTapTimes.current[r._id] = 0
                    } else {
                      lastTapTimes.current[r._id] = now
                      handleSidebarClick(r)
                    }
                  }}
                  style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', minHeight: 80, borderLeft: `3px solid ${activeId === r._id ? ORANGE : 'transparent'}`, background: activeId === r._id ? TINT_SOFT : '#fff', borderBottom: '1px solid #f5f5f5', transition: 'all 0.12s', position: 'relative' }}
                >
                  <FavoriteHeart
                    authGate
                    size={16}
                    background="rgba(255,255,255,0.92)"
                    style={{ position: 'absolute', top: 6, right: 8, zIndex: 2, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
                    restaurant={{
                      key: r.slug?.current || r._id,
                      slug: r.slug?.current,
                      name: r.name,
                      image: r.image,
                      cuisine: r.cuisine,
                      location: r.location,
                    }}
                  />
                  {r.image ? <img src={r.image} alt={r.name} style={{ width: 80, height: 80, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 80, height: 80, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>✦</div>}
                  <div style={{ flex: 1, padding: '12px 14px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, background: activeId === r._id ? GRADIENT : '#f0f0f0', color: activeId === r._id ? '#fff' : '#999', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}{r.isDisco ? ' ★' : ''}</div>
                    </div>
                    <div style={{ fontSize: 12, color: '#bbb', marginBottom: 5 }}>{r.location}</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1, marginRight: 8 }}>
                        {((r.cuisines && r.cuisines.length > 0) ? r.cuisines : [r.cuisine]).map(tag => (
                          <span key={tag} style={{ fontSize: 11, background: '#f5f1eb', padding: '2px 8px', borderRadius: 10, color: '#888' }}>{tag}</span>
                        ))}
                      </div>
                      {r.orderUrl ? (
                        <a
                          href={r.slug?.current ? `/restaurants/${r.slug.current}` : r.orderUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize: 12, color: '#fff', fontWeight: 700, background: ORANGE, padding: '4px 12px', borderRadius: 20, textDecoration: 'none' }}
                        >
                          Order →
                        </a>
                      ) : (
                        <span style={{ fontSize: 12, color: '#bbb', fontWeight: 600 }}>No order link</span>
                      )}
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
        @keyframes treeSlide { from { opacity:0; transform:translateX(10px) } to { opacity:1; transform:translateX(0) } }
        input[type="datetime-local"]::-webkit-calendar-picker-indicator { opacity: 0.5; cursor: pointer; }
        .disco-popup .mapboxgl-popup-content { padding:0; border-radius:12px; overflow:hidden; box-shadow:none; }
        .disco-popup .mapboxgl-popup-tip { display:none; }
        @keyframes skeletonPulse { 0%,100% { opacity:0.6 } 50% { opacity:1 } }
        @keyframes dinovaPulse {
          0% { box-shadow: 0 2px 10px rgba(245,166,35,0.4), 0 0 0 0 rgba(245,166,35,0.3); }
          70% { box-shadow: 0 2px 10px rgba(245,166,35,0.4), 0 0 0 10px rgba(245,166,35,0); }
          100% { box-shadow: 0 2px 10px rgba(245,166,35,0.4), 0 0 0 0 rgba(245,166,35,0); }
        }
      `}</style>

      {locModal}

      <div style={{ fontFamily: "'DM Sans',sans-serif", height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff', color: '#111' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, background: `linear-gradient(180deg, ${TINT} 0%, ${TINT_SOFT} 100%), #fff`, overflow: 'visible' }}>
          <Link href="/dinova-demo" style={{ flexShrink: 0, marginRight: 4, textDecoration: 'none' }}>{dinovaLogo}</Link>
          <div style={{ fontSize: 12, color: '#999', fontWeight: 600, flexShrink: 0, marginRight: 4 }}>Restaurant Network</div>
          <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />
          <button style={darkPillStyle(stageFilter === 'all')} onClick={() => setStageFilter('all')}>All</button>
          <button style={gradientPillStyle(stageFilter === 'disco')} onClick={() => setStageFilter('disco')}>★ Premium</button>
          <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />
          <button style={pillStyle(cuisineFilter === 'all')} onClick={() => setCuisineFilter('all')}>All Cuisines</button>
          {topCuisines.slice(0, MAX_VISIBLE_CUISINES).map(c => (
            <button key={c} style={pillStyle(cuisineFilter === c)} onClick={() => setCuisineFilter(c)}>{c}</button>
          ))}
          {topCuisines.length > MAX_VISIBLE_CUISINES && (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={() => setShowMoreCuisines(o => !o)}
                style={pillStyle(showMoreCuisines || topCuisines.slice(MAX_VISIBLE_CUISINES).includes(cuisineFilter))}
              >
                {topCuisines.slice(MAX_VISIBLE_CUISINES).includes(cuisineFilter) ? cuisineFilter : 'More ▾'}
              </button>
              {showMoreCuisines && (
                <>
                  <div onClick={() => setShowMoreCuisines(false)} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 100, background: '#fff', border: '1.5px solid #e8e8e8', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 6, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {topCuisines.slice(MAX_VISIBLE_CUISINES).map(c => (
                      <button key={c} onClick={() => { setCuisineFilter(c); setShowMoreCuisines(false) }} style={{ padding: '7px 12px', borderRadius: 8, border: 'none', background: cuisineFilter === c ? '#1A1028' : 'transparent', color: cuisineFilter === c ? '#fff' : '#555', fontSize: 12, fontWeight: 600, cursor: 'pointer', textAlign: 'left', fontFamily: "'DM Sans',sans-serif" }}>
                        {c}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />
          <Link href="/faq" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 13, color: '#555', textDecoration: 'none', fontWeight: 500, fontFamily: "'DM Sans',sans-serif", paddingRight: 8 }}>FAQ</Link>
          <DinovaUserMenu />
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {chatOpen && (
            <div style={{ width: 380, minWidth: 380, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0', background: '#fafafa' }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid #f0f0f0', background: ORANGE, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <div style={{ fontSize: 22 }}>🤖</div>
                <div>
                  <div style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>Dinova AI</div>
                  <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11 }}>Catering Assistant</div>
                </div>
                <button onClick={() => setChatOpen(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.9)', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                {renderTreeContent(true)}
              </div>
            </div>
          )}

          <div style={{ width: 416, minWidth: 416, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0', background: '#fff' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
              <div style={{ position: 'relative' }}>
                <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#bbb', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input value={search} onChange={e => { setSearch(e.target.value); if (e.target.value.length > 2) trackEvent('search_performed', { search_term: e.target.value }) }} placeholder="Search restaurants…" style={{ width: '100%', padding: '9px 10px 9px 32px', borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fafafa', color: '#111', fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: 'none', boxSizing: 'border-box' }} />
              </div>
            </div>
            <div style={{ padding: '6px 12px', fontSize: 11, color: '#bbb', borderBottom: '1px solid #f0f0f0', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              {filtered.length} restaurants
              {proximityAnchor && (<><span style={{ fontSize: 10, background: TINT_CHIP, color: ORANGE_DARK, padding: '1px 7px', borderRadius: 8, fontWeight: 600, marginLeft: 6 }}>📍 Nearby</span><button onClick={() => setProximityAnchor(null)} style={{ fontSize: 10, color: '#bbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', marginLeft: 4 }}>clear</button></>)}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {!restaurantsLoaded && <SkeletonCards count={8} />}
              {restaurantsLoaded && filtered.length === 0 && (
                <div style={{ padding: '32px 22px', textAlign: 'center', color: '#777', fontSize: 13 }}>
                  {proximityAnchor ? (
                    <>
                      <div style={{ marginBottom: 12, lineHeight: 1.5 }}>
                        No restaurants found near <strong style={{ color: '#1A1028' }}>{locInput || 'this area'}</strong>.<br />
                        Try expanding your search or browsing all restaurants.
                      </div>
                      <button onClick={() => { setProximityAnchor(null); setLocInput('') }} style={{ padding: '8px 16px', borderRadius: 20, background: '#1A1028', color: '#fff', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
                        Clear location filter
                      </button>
                    </>
                  ) : 'No restaurants match.'}
                </div>
              )}
              {filtered.map((r, i) => (
                <div key={r._id} onClick={() => handleSidebarClick(r)} onDoubleClick={() => { if (r.orderUrl) window.open(r.slug?.current ? `/restaurants/${r.slug.current}` : r.orderUrl, '_blank', 'noopener,noreferrer') }} onMouseEnter={() => setHoveredId(r._id)} onMouseLeave={() => setHoveredId(null)} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', minHeight: 74, borderLeft: `3px solid ${activeId === r._id || hoveredId === r._id ? ORANGE : 'transparent'}`, borderBottom: i < filtered.length - 1 ? '1px solid #f0f0f0' : 'none', background: activeId === r._id ? TINT : hoveredId === r._id ? TINT_SOFT : '#fff', transition: 'background 0.18s, border-color 0.18s', position: 'relative' }}>
                  <FavoriteHeart
                    authGate
                    size={16}
                    background="rgba(255,255,255,0.92)"
                    style={{ position: 'absolute', top: 6, right: 8, zIndex: 2, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
                    restaurant={{
                      key: r.slug?.current || r._id,
                      slug: r.slug?.current,
                      name: r.name,
                      image: r.image,
                      cuisine: r.cuisine,
                      location: r.location,
                    }}
                  />
                  {r.image ? <img src={r.image} alt={r.name} style={{ width: 74, height: 74, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 74, height: 74, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>✦</div>}
                  <div style={{ flex: 1, padding: '10px 12px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <div style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, background: activeId === r._id ? GRADIENT : '#f0f0f0', color: activeId === r._id ? '#fff' : '#999', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}{r.isDisco ? ' ★' : ''}</div>
                    </div>
                    <div style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>{r.location}</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                        {((r.cuisines && r.cuisines.length > 0) ? r.cuisines : [r.cuisine]).map(tag => (
                          <span key={tag} style={{ fontSize: 10, background: '#f5f1eb', padding: '2px 7px', borderRadius: 10, color: '#888' }}>{tag}</span>
                        ))}
                      </div>
                      {r.orderUrl && (
                        <a
                          href={r.slug?.current ? `/restaurants/${r.slug.current}` : r.orderUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize: 11, color: ORANGE_DARK, fontWeight: 600, textDecoration: 'none', flexShrink: 0, fontFamily: "'DM Sans',sans-serif" }}
                        >
                          Order →
                        </a>
                      )}
                    </div>
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
                <button type="submit" disabled={locLoading} style={{ padding: '0 14px', border: 'none', cursor: 'pointer', background: ORANGE, color: '#fff', fontSize: 11, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", flexShrink: 0 }}>{locLoading ? '...' : 'Go'}</button>
              </form>
              {/* Ask Dinova — orange pill (was the gold "Disco AI" button). */}
              <button
                onClick={() => setChatOpen(o => !o)}
                title="Ask Dinova AI"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, boxSizing: 'border-box',
                  background: ORANGE, color: '#fff', border: 'none', borderRadius: 999,
                  padding: '0 16px', fontSize: 13, fontWeight: 700, fontFamily: "'DM Sans',sans-serif",
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  animation: 'dinovaPulse 2.5s ease-out infinite',
                }}
              >
                🤖 Ask Dinova
              </button>
              {/* Concierge — unchanged. */}
              <button
                onClick={() => window.open('mailto:concierge@discocater.com?subject=Catering%20Inquiry%20via%20Dinova&body=Hi%2C%20I%27d%20like%20to%20speak%20with%20someone%20about%20catering.', '_blank')}
                title="Talk to a Human"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, boxSizing: 'border-box',
                  background: '#fff', color: '#1A1028', border: '1.5px solid #1A1028', borderRadius: 999,
                  padding: '0 16px', fontSize: 13, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                </svg>
                Concierge
              </button>
            </div>
            {locError && <div style={{ position: 'absolute', top: 56, left: 12, zIndex: 10, background: '#fff', border: '1px solid #f0c0c8', borderRadius: 8, padding: '6px 12px', fontSize: 12, color: '#F0468A', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>{locError}</div>}
            <div ref={mapContainer} style={mapDivStyle} />
            {poweredByBadge}
          </div>

          {/* Right: fake "Your orders" panel (demo only, desktop only). */}
          <div style={{ width: 260, minWidth: 260, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #f0f0f0', background: '#fafafa', overflowY: 'auto' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#111', fontFamily: "'DM Sans',sans-serif" }}>Your orders</div>
              <div style={{ fontSize: 11, color: ORANGE_DARK, fontWeight: 700, marginTop: 2, fontFamily: "'DM Sans',sans-serif" }}>The Home Depot Account</div>
            </div>
            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11, color: '#999', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: "'DM Sans',sans-serif" }}>Upcoming</div>
              {FAKE_ORDERS.map(o => (
                <div key={o.name} style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '11px 12px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginBottom: 2, fontFamily: "'DM Sans',sans-serif" }}>{o.name}</div>
                  <div style={{ fontSize: 11, color: '#999', marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }}>{o.detail}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: '#111', fontFamily: "'DM Sans',sans-serif" }}>{o.price}</span>
                    <span style={{ fontSize: 11, color: '#999', fontFamily: "'DM Sans',sans-serif" }}>{o.people}</span>
                  </div>
                  <button style={{ width: '100%', padding: '7px 0', borderRadius: 8, border: 'none', background: ORANGE, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
                    Order again
                  </button>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 'auto', padding: '14px 16px', borderTop: '1px solid #f0f0f0', fontSize: 11.5, color: '#888', lineHeight: 1.6, fontFamily: "'DM Sans',sans-serif" }}>
              <strong style={{ color: '#111' }}>47 orders</strong> placed since Jan 2025 · <strong style={{ color: ORANGE_DARK }}>2,840 Dinova Rewards pts</strong>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// Sidebar loading skeleton — grey placeholder cards matching real-card
// dimensions, with a subtle opacity pulse (keyframe `skeletonPulse`). Shown
// while /api/restaurants loads in the background so the sidebar never sits blank.
function SkeletonCards({ count, mobile = false }: { count: number; mobile?: boolean }) {
  const sz = mobile ? 80 : 74
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', minHeight: sz, borderBottom: '1px solid #f5f5f5', animation: 'skeletonPulse 1.5s ease-in-out infinite' }}>
          <div style={{ width: sz, height: sz, background: '#e8e8e8', flexShrink: 0 }} />
          <div style={{ flex: 1, padding: mobile ? '12px 14px' : '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ height: 12, width: '70%', borderRadius: 6, background: '#e8e8e8' }} />
            <div style={{ height: 10, width: '45%', borderRadius: 6, background: '#ececec' }} />
            <div style={{ height: 10, width: '30%', borderRadius: 6, background: '#ececec' }} />
          </div>
        </div>
      ))}
    </>
  )
}

// ── Fake logged-in user dropdown for the demo (no real auth) ──────────────────
const F = "'DM Sans',sans-serif"

function DinovaUserMenu() {
  const [open, setOpen] = useState(false)
  const MENU = ['My Orders', 'Subscriptions', 'Favorites', 'Account', 'Payment methods']
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={e => { e.stopPropagation(); setOpen(v => !v) }} style={{ display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', fontSize: 11, fontWeight: 700, color: '#fff', background: ORANGE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F, flexShrink: 0 }}>
          {FAKE_USER.initials}
        </div>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 399 }} />
          <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, background: '#fff', border: '1px solid #e8e8e8', borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,0.12)', minWidth: 220, zIndex: 400, overflow: 'hidden' }}>
            <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#111', fontFamily: F }}>{FAKE_USER.firstName} {FAKE_USER.lastName}</div>
              <div style={{ fontSize: 10, color: '#999', marginTop: 1, fontFamily: F }}>{FAKE_USER.company}</div>
            </div>
            <div style={{ padding: '5px 0' }}>
              {MENU.map(label => (
                <div key={label} onClick={() => setOpen(false)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', fontSize: 12, color: '#444', fontWeight: 500, cursor: 'pointer', fontFamily: F, transition: 'background 0.1s' }}
                  onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#f5f5f5'}
                  onMouseOut={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                >
                  {label}
                </div>
              ))}
            </div>
            <div style={{ height: 1, background: '#f0f0f0', margin: '3px 0' }} />
            <div style={{ padding: '5px 0' }}>
              <div onClick={() => setOpen(false)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 12, color: '#E24B4A', fontWeight: 500, fontFamily: F }}
                onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#f5f5f5'}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
              >
                Sign out
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
