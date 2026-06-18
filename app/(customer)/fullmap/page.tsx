// v5 — guided decision tree chat panel
'use client'
import React from 'react'
import { useEffect, useRef, useState, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import Script from 'next/script'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import FavoriteHeart from '../account/components/FavoriteHeart'
import { useAuthContext } from '../../context/AuthContext'
import UserMenu from '../../components/UserMenu'
import AuthModal from '../../components/AuthModal'

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
  // Lazy init: SSR gets false (safe), but the client's first paint already has
  // the correct value — avoids the false→true flip (e.g. the fullmap Sign Up
  // button appearing then disappearing on mobile).
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)
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
  featuredOrder?: number | null
  orderUrl: string
  image?: string
  description?: string
  availableDays?: string[]
  slug?: { current: string }
}

// Mode 1 guided-intake chip sets
const OCCASIONS = ['Work', 'Social', 'Holiday', 'Special Event']
const HEADCOUNTS = ['Under 20', '20–50', '50–100', '100+']
const CUISINES = ['Italian', 'Mexican', 'Japanese', 'Mediterranean', 'Indian', 'Korean', 'BBQ', 'Vegan', 'Surprise me']

type IntakeStep = 'location' | 'occasion' | 'headcount' | 'cuisine' | 'finding'

function FullMapInner() {
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
  // True only once the data has loaded AND the sort effect has produced the
  // final order — gates the sidebar so it never paints the raw (unsorted) list
  // and then visibly reorders into the featured/alphabetical order.
  const [listReady, setListReady] = useState(false)
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

  // Guided intake state (Mode 1)
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
  // True when a tap (not a swipe) just set sortAnchor — tells the filtering effect to scroll after re-sort
  const tapResortPendingRef = useRef(false)

  useEffect(() => { isMobileRef.current = isMobile }, [isMobile])

  // Sync marker visual state when activeId changes
  // (slider scroll is handled inside the filtering effect for tap-triggered re-sorts,
  //  and skipped for swipe-triggered activeId changes via the currentIdx guard)

  // When activeId changes, sync marker visual state
  useEffect(() => {
    Object.entries(markersRef.current).forEach(([id, marker]) => {
      const mkDiv = marker.getElement().firstChild as HTMLElement
      if (!mkDiv) return
      const r = restaurants.find(rest => rest._id === id)
      if (id === activeId) {
        mkDiv.style.background = GRADIENT
        mkDiv.style.transform = 'scale(1.2)'
      } else {
        mkDiv.style.background = '#5B6FE8'
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
        // Swipe does NOT set tapResortPendingRef — no re-sort, no programmatic scroll needed
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
        // /api/restaurants now returns FM-direct rows (Sanity bypassed):
        // { reference, name, slug (string), cuisine, description, image, lat, lng,
        //   location, address, orderUrl, isPremium }. Map onto the shape the rest
        // of this page already expects (_id, slug.current, isDisco ← isPremium) so
        // proximity, cuisine pills, and the Premium filter stay exactly as-is.
        const rows: Restaurant[] = (Array.isArray(data) ? data : []).map((r: {
          reference: string; name: string; slug?: string; cuisine?: string
          description?: string; image?: string | null; lat: number; lng: number
          location?: string; orderUrl?: string; isPremium?: boolean; featuredOrder?: number | null
        }) => ({
          _id: r.reference,
          name: r.name,
          location: r.location || '',
          cuisine: r.cuisine || 'Other',
          cuisines: r.cuisine ? [r.cuisine] : [],
          lat: r.lat,
          lng: r.lng,
          isDisco: !!r.isPremium,
          featuredOrder: typeof r.featuredOrder === 'number' ? r.featuredOrder : null,
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
    // Disable scroll-wheel zoom so the page scrolls past the map instead of
    // trapping the wheel. Zoom via the +/− NavigationControl (desktop) or
    // pinch (mobile, still enabled); drag to pan.
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

  // Google Places Autocomplete for the in-intake "Where are you ordering?" step.
  // Same pattern as initAutocomplete; on select it sets the map's proximity
  // anchor AND advances the guided flow to the occasion step.
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

  // Attach the intake autocomplete whenever the location step mounts. Retry once
  // shortly after in case the Maps script hasn't finished loading yet.
  useEffect(() => {
    if (!chatOpen || phase !== 'intake' || intakeStep !== 'location') return
    initIntakeAutocomplete()
    const t = setTimeout(initIntakeAutocomplete, 600)
    return () => clearTimeout(t)
  }, [chatOpen, phase, intakeStep, initIntakeAutocomplete])

  // If a location is already known (map search / geolocation / URL), skip the
  // location step silently and start the guided flow at occasion.
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
      // Default (no location search): featured (pinned 1..N) first by
      // featured_order, then Premium alphabetical, then non-Premium alphabetical.
      // (isDisco is the mapped isPremium.)
      const tier = (r: Restaurant) => (r.featuredOrder != null ? 0 : r.isDisco ? 1 : 2)
      out = [...out].sort((a, b) => {
        const ta = tier(a), tb = tier(b)
        if (ta !== tb) return ta - tb
        if (ta === 0) return (a.featuredOrder as number) - (b.featuredOrder as number)
        return a.name.localeCompare(b.name)
      })
    }
    setFiltered(out)
    filteredRef.current = out
    // The final sorted order is now applied. Once the data has actually loaded,
    // reveal the real list (this and setFiltered batch into one render, so the
    // first list paint is already in featured/alphabetical order — no flash).
    if (restaurantsLoaded) setListReady(true)

    // After a tap-triggered re-sort, scroll slider to the active card using fresh data
    if (tapResortPendingRef.current && isMobileRef.current && mobileSliderRef.current) {
      tapResortPendingRef.current = false
      const currentActiveId = activeId  // capture from closure
      const idx = out.findIndex(r => r._id === currentActiveId)
      if (idx >= 0) {
        const slider = mobileSliderRef.current
        setTimeout(() => {
          const stride = (slider.children[0] as HTMLElement)?.offsetWidth + 12 || slider.offsetWidth
          slider.scrollTo({ left: idx * stride, behavior: 'smooth' })
        }, 0)
      }
    }
  }, [search, stageFilter, cuisineFilter, restaurants, proximityAnchor, sortAnchor, restaurantsLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

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
        background: '#5B6FE8', color: '#fff', fontSize: '10px', fontWeight: '700',
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
        // Mobile: no popup — tap activates the card and re-sorts by proximity to this restaurant
        el.addEventListener('click', () => {
          tapResortPendingRef.current = true
          setActiveId(r._id)
          setSortAnchor({ lat: r.lat, lng: r.lng })
          trackEvent('restaurant_click', { restaurant_name: r.name, cuisine: r.cuisine })
          map.current?.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.current.getZoom(), 13), speed: 3, essential: true })
        })
      } else {
        // Desktop: full popup
        const popup = new mapboxgl.Popup({
          offset: [0, -44], closeButton: false, closeOnClick: false, maxWidth: '290px', className: 'disco-popup',
        }).setHTML(`
          <div style="font-family:'DM Sans',sans-serif;width:270px;border-radius:12px;overflow:hidden;position:relative;box-shadow:0 4px 24px rgba(0,0,0,0.13)">
            <button onclick="this.closest('.mapboxgl-popup').remove()" style="position:absolute;top:8px;right:8px;z-index:10;width:26px;height:26px;border-radius:50%;background:rgba(0,0,0,0.55);color:#fff;border:none;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;backdrop-filter:blur(4px);">×</button>
            ${r.image ? `<div style="height:140px;overflow:hidden"><img src="${r.image}" style="width:100%;height:100%;object-fit:cover"/></div>` : ''}
            <div style="padding:14px 16px 16px">
              <div style="font-size:14px;font-weight:700;margin-bottom:2px;color:#111">✦ ${r.name}${r.isDisco ? ' 🪩' : ''}</div>
              <div style="font-size:11px;color:#999;margin-bottom:8px">${r.location}</div>
              ${r.description ? `<div style="font-size:11.5px;color:#555;line-height:1.55;margin-bottom:10px">${r.description}</div>` : ''}
              <div style="display:flex;gap:5px;margin-bottom:12px">
                ${((r.cuisines && r.cuisines.length > 0) ? r.cuisines : [r.cuisine]).map(tag => `<span style="font-size:10px;background:#f5f1eb;border:1px solid #e8e0d8;padding:2px 8px;border-radius:10px;color:#888">${tag}</span>`).join('')}
              </div>
              <a href="${r.slug?.current ? '/restaurants/' + r.slug.current : r.orderUrl || '#'}" style="display:block;width:100%;padding:10px 0;background:#5B6FE8;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;text-align:center;text-decoration:none;box-sizing:border-box">Order Catering →</a>
            </div>
          </div>
        `)
        popupsRef.current[r._id] = popup
        popup.on('close', () => {
          mkDiv.style.background = '#5B6FE8'
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

  // ── Decision tree helpers ──────────────────────────────────────────────────

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

  // Candidate list sent to the API — the CURRENT filtered map list, so
  // recommendations respect the active proximity/cuisine filters.
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

  // Hand the intake context to Mode 2 (restaurant page) before navigating.
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
      // Mobile: fly to restaurant, re-sort by proximity, scroll slider via filtering effect
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

  // ── Decision tree panel renderer ───────────────────────────────────────────

  function renderTreeContent(compact: boolean) {
    const p = compact ? '14px 12px' : '20px 18px'
    const titleSz = compact ? 15 : 17
    const bodySz = compact ? 12 : 13
    const pillPadding = compact ? '8px 13px' : '9px 16px'
    const pillFontSz = compact ? 12 : 13
    const cardImgH = compact ? 110 : 130
    const DK = '#1A1028'

    // Chip per spec: white/dark-outline by default, solid dark when selected,
    // #E8E8FF hover on unselected.
    const chip = (label: string, selected: boolean, onClick: () => void) => (
      <button
        key={label}
        onClick={onClick}
        onMouseOver={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = '#E8E8FF' }}
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

    // Visible step order (location step is skipped when a location is known).
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

    // ── STATE A — guided intake ──────────────────────────────────────────────
    if (phase === 'intake') {
      // Loading / "Finding your options…"
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

      // Step: location (only when no location is known)
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

      // Step: occasion
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

      // Step: headcount
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

      // Step: cuisine (multi-select, optional)
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

    // ── STATE B — results + conversation ─────────────────────────────────────
    return (
      <div key="results" style={{ padding: p }}>
        {/* Selection summary */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
          {[occasion, headcount, ...cuisines, locationStr].filter(Boolean).map(s => (
            <span key={s} style={{ fontSize: 10, background: '#ede9fe', color: '#6B6EF9', padding: '3px 9px', borderRadius: 20, fontWeight: 600, fontFamily: "'DM Sans',sans-serif" }}>
              {s}
            </span>
          ))}
        </div>

        <div style={{ fontSize: compact ? 13 : 14, fontWeight: 700, color: '#111', marginBottom: 14, fontFamily: "'DM Sans',sans-serif" }}>
          {treeResults.length > 0 ? 'Your options' : 'What we found'}
        </div>

        {/* Fallback text when no restaurant cards matched */}
        {treeResults.length === 0 && treeAiText && (
          <div style={{ fontSize: bodySz, color: '#555', lineHeight: 1.65, marginBottom: 16, fontFamily: "'DM Sans',sans-serif", whiteSpace: 'pre-wrap', background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12, padding: compact ? '12px 14px' : '14px 16px' }}>
            {treeAiText}
          </div>
        )}

        {/* Restaurant cards — clicking hands intake to Mode 2 and opens the
            restaurant page (/restaurants/[slug]); external orderUrl is the
            fallback when there's no slug. */}
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
                {r.name}{r.isDisco ? ' 🪩' : ''}
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

        {/* Follow-up bubbles */}
        {chatMessages.length > 0 && (
          <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {chatMessages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '88%', padding: '8px 12px',
                  borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                  background: m.role === 'user' ? '#5B6FE8' : '#fff',
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

        {/* Follow-up input */}
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
              style={{ width: compact ? 34 : 38, height: compact ? 34 : 38, borderRadius: '50%', border: 'none', background: '#5B6FE8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: (chatLoading || !chatInput.trim()) ? 0.4 : 1, alignSelf: 'center' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
            </button>
          </div>
        </div>

        {/* Start over */}
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

        {/* AI Chat full-screen overlay */}
        {chatOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: '#fafafa', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans',sans-serif" }}>
            <div style={{ padding: '12px 16px', background: '#EFB84A', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
              <div style={{ fontSize: 22 }}>🤖</div>
              <div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Disco AI</div>
                <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>Catering Assistant</div>
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

          {/* 1. Header */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '9px 14px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, background: 'linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff' }}>
            <Link href="/" style={{ textDecoration: 'none', flexShrink: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px', fontFamily: "'DM Sans',sans-serif" }}><span style={{ background: 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span><span style={{ color: '#999' }}> cater</span></span>
            </Link>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => setChatOpen(o => !o)} style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: '#EFB84A', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, position: 'relative', flexShrink: 0 }}>🤖{!chatOpen && <div style={{ position: 'absolute', top: 1, right: 1, width: 8, height: 8, borderRadius: '50%', background: '#22c55e', border: '1.5px solid #fff' }} />}</button>
              <FullmapAuthBtn />
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
                  <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
                    <button onClick={() => { setProximityAnchor(null); setLocInput('') }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 20, background: '#fff', border: '1px solid #e0e0e0', fontSize: 12, fontWeight: 600, color: '#555', cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', fontFamily: "'DM Sans',sans-serif" }}>
                      📍 Showing nearby · Clear
                    </button>
                  </div>
                )}
                {/* Restaurant card slider — 1 card at a time, full width */}
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
                            style={{ position: 'relative', background: '#fff', borderRadius: 14, overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.18)', cursor: 'pointer', border: `2.5px solid ${activeId === r._id ? '#6B6EF9' : 'transparent'}`, transition: 'border-color 0.15s' }}
                          >
                            <FavoriteHeart
                              authGate
                              size={16}
                              background="rgba(255,255,255,0.92)"
                              style={{ position: 'absolute', top: 8, right: 8, zIndex: 2, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
                              restaurant={{
                                key: r.slug?.current || r._id,
                                slug: r.slug?.current,
                                name: r.name,
                                image: r.image,
                                cuisine: r.cuisine,
                                location: r.location,
                              }}
                            />
                            {r.image
                              ? <img src={r.image} alt={r.name} style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }} />
                              : <div style={{ height: 96, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>✦</div>
                            }
                            <div style={{ padding: '8px 12px 10px' }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: "'DM Sans',sans-serif" }}>
                                {i + 1}. {r.name}{r.isDisco ? ' 🪩' : ''}
                              </div>
                              <div style={{ fontSize: 11, color: '#bbb', marginBottom: 6, fontFamily: "'DM Sans',sans-serif" }}>{r.location}</div>
                              <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                                {((r.cuisines && r.cuisines.length > 0) ? r.cuisines.slice(0, 3) : [r.cuisine]).map(tag => (
                                  <span key={tag} style={{ fontSize: 10, background: '#f5f1eb', padding: '2px 7px', borderRadius: 10, color: '#888', whiteSpace: 'nowrap' }}>{tag}</span>
                                ))}
                              </div>
                              {r.orderUrl ? (
                                <a href={r.slug?.current ? `/restaurants/${r.slug.current}` : r.orderUrl} onClick={e => e.stopPropagation()}
                                  style={{ display: 'block', textAlign: 'center', padding: '8px 0', background: '#5B6FE8', color: '#fff', borderRadius: 8, textDecoration: 'none', fontSize: 12, fontWeight: 700, fontFamily: "'DM Sans',sans-serif" }}>
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
            {!listReady && <SkeletonCards count={6} mobile />}
            {listReady && filtered.length === 0 && (
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
            {listReady && filtered.map((r, i) => (
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
                  style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', minHeight: 80, borderLeft: `3px solid ${activeId === r._id ? '#6B6EF9' : 'transparent'}`, background: activeId === r._id ? 'rgba(107,110,249,0.05)' : '#fff', borderBottom: '1px solid #f5f5f5', transition: 'all 0.12s', position: 'relative' }}
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
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}{r.isDisco ? ' 🪩' : ''}</div>
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
                          style={{ fontSize: 12, color: '#fff', fontWeight: 700, background: '#5B6FE8', padding: '4px 12px', borderRadius: 20, textDecoration: 'none' }}
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
        @keyframes discoPulse {
          0% { box-shadow: 0 2px 10px rgba(239,184,74,0.4), 0 0 0 0 rgba(239,184,74,0.3); }
          70% { box-shadow: 0 2px 10px rgba(239,184,74,0.4), 0 0 0 10px rgba(239,184,74,0); }
          100% { box-shadow: 0 2px 10px rgba(239,184,74,0.4), 0 0 0 0 rgba(239,184,74,0); }
        }
        /* Mobile (<768px): Disco AI button shows the icon only (no text label). */
        @media (max-width: 767px) {
          .disco-ai-label { display: none; }
        }
      `}</style>

      {locModal}

      <div style={{ fontFamily: "'DM Sans',sans-serif", height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff', color: '#111' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, background: 'linear-gradient(180deg, rgba(107,110,249,0.08) 0%, rgba(240,70,138,0.04) 100%), #fff', overflow: 'visible' }}>
          <Link href="/" style={{ flexShrink: 0, marginRight: 4 }}><span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px', fontFamily: "'DM Sans',sans-serif" }}><span style={{ background: 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span><span style={{ color: '#999' }}> cater</span></span></Link>
          <div style={{ width: 1, height: 20, background: '#e8e8e8', flexShrink: 0 }} />
          <button style={darkPillStyle(stageFilter === 'all')} onClick={() => setStageFilter('all')}>All</button>
          <button style={gradientPillStyle(stageFilter === 'disco')} onClick={() => setStageFilter('disco')}>🪩 Premium</button>
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
          <FullmapAuthBtn />
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* AI decision tree panel */}
          {chatOpen && (
            <div style={{ width: 380, minWidth: 380, display: 'flex', flexDirection: 'column', borderRight: '1px solid #f0f0f0', background: '#fafafa' }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid #f0f0f0', background: '#EFB84A', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <div style={{ fontSize: 22 }}>🤖</div>
                <div>
                  <div style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>Disco AI</div>
                  <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 }}>Catering Assistant</div>
                </div>
                <button onClick={() => setChatOpen(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.8)', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
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
              {proximityAnchor && (<><span style={{ fontSize: 10, background: '#f0f0ff', color: '#6B6EF9', padding: '1px 7px', borderRadius: 8, fontWeight: 600, marginLeft: 6 }}>📍 Nearby</span><button onClick={() => setProximityAnchor(null)} style={{ fontSize: 10, color: '#bbb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', marginLeft: 4 }}>clear</button></>)}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {!listReady && <SkeletonCards count={8} />}
              {listReady && filtered.length === 0 && (
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
              {listReady && filtered.map((r, i) => (
                <div key={r._id} onClick={() => handleSidebarClick(r)} onDoubleClick={() => { if (r.orderUrl) window.open(r.slug?.current ? `/restaurants/${r.slug.current}` : r.orderUrl, '_blank', 'noopener,noreferrer') }} onMouseEnter={() => setHoveredId(r._id)} onMouseLeave={() => setHoveredId(null)} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', minHeight: 74, borderLeft: `3px solid ${activeId === r._id || hoveredId === r._id ? '#6B6EF9' : 'transparent'}`, borderBottom: i < filtered.length - 1 ? '1px solid #f0f0f0' : 'none', background: activeId === r._id ? 'rgba(107,110,249,0.07)' : hoveredId === r._id ? 'rgba(107,110,249,0.05)' : '#fff', transition: 'background 0.18s, border-color 0.18s', position: 'relative' }}>
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
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}{r.isDisco ? ' 🪩' : ''}</div>
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
                          style={{ fontSize: 11, color: '#5B6FE8', fontWeight: 600, textDecoration: 'none', flexShrink: 0, fontFamily: "'DM Sans',sans-serif" }}
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
                <button type="submit" disabled={locLoading} style={{ padding: '0 14px', border: 'none', cursor: 'pointer', background: '#5B6FE8', color: '#fff', fontSize: 11, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", flexShrink: 0 }}>{locLoading ? '...' : 'Go'}</button>
              </form>
              {/* Disco AI — gold pill. Matches the search bar height (container
                  alignItems:stretch). Keeps the box-shadow pulse (discoPulse). */}
              <button
                onClick={() => setChatOpen(o => !o)}
                title="Ask Disco AI"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, boxSizing: 'border-box',
                  background: '#EFB84A', color: '#1A1028', border: 'none', borderRadius: 999,
                  padding: '0 16px', fontSize: 13, fontWeight: 600, fontFamily: "'DM Sans',sans-serif",
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  animation: 'discoPulse 2.5s ease-out infinite',
                }}
              >
                🤖<span className="disco-ai-label">&nbsp;Disco AI</span>
              </button>
              {/* Concierge — white pill, same height (mailto to concierge). */}
              <button
                onClick={() => window.open('mailto:concierge@discocater.com?subject=Catering%20Inquiry%20via%20Disco%20Cater&body=Hi%2C%20I%27d%20like%20to%20speak%20with%20someone%20about%20catering.', '_blank')}
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
          </div>
        </div>
      </div>
    </>
  )
}

const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const F = "'DM Sans',sans-serif"

// Sidebar loading skeleton — grey placeholder cards matching real-card
// dimensions, with a subtle opacity pulse (keyframe `skeletonPulse`). Shown
// while /api/restaurants loads in the background so the sidebar never sits
// blank. `mobile` bumps the thumbnail/padding to match the mobile card size.
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

function FullmapAuthBtn() {
  // Use the shared cookie-based auth (same source as GlobalHeader). The old
  // localStorage 'disco_user' read never reflected a cookie-based modal login,
  // so the map header stayed on "Log in" after signing in elsewhere. The
  // logged-in dropdown is the shared <UserMenu /> so every header matches.
  const { user, isLoading, openAuthModal, authModalOpen, closeAuthModal, authModalDefaultTab } = useAuthContext()
  const router = useRouter()
  const isMobile = useIsMobile()

  // While auth resolves, reserve the buttons' footprint so the header doesn't
  // shift when Log In/Sign Up later swaps to the UserMenu (matches GlobalHeader's
  // isLoading gate).
  if (isLoading) return <div aria-hidden style={{ width: 120, height: 34, flexShrink: 0 }} />

  if (!user) return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {/* Login button kept identical to GlobalHeader (the canonical header used on
            the homepage, FAQ, compare, and restaurant pages) — outlined dark pill. */}
        <button onClick={() => openAuthModal(undefined, 'login')} style={{ padding: '7px 16px', borderRadius: 999, border: '1.5px solid #1A1028', background: 'transparent', color: '#1A1028', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, flexShrink: 0 }}>Log In</button>
        {/* Desktop-only filled Sign Up CTA next to Log In (matches GlobalHeader,
            incl. router.push navigation). */}
        {!isMobile && (
          <button onClick={() => router.push('/signup')} style={{ padding: '7px 18px', borderRadius: 999, border: 'none', background: '#5B6FE8', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0 }}>Sign Up</button>
        )}
      </div>
      {/* The fullmap doesn't use GlobalHeader, so it must render its own AuthModal
          for the Log In button to actually open something (mirrors GlobalHeader). */}
      <AuthModal
        isOpen={authModalOpen}
        onClose={closeAuthModal}
        defaultTab={authModalDefaultTab}
      />
    </>
  )

  return <UserMenu />
}


export default function FullMapPage() {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'DM Sans, sans-serif', color: '#999', fontSize: 14 }}>Loading…</div>}>
      <FullMapInner />
    </Suspense>
  )
}
