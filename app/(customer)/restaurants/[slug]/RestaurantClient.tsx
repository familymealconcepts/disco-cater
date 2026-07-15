'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import GlobalHeader from '../../../components/GlobalHeader'
import UserMenu from '../../../components/UserMenu'
import AuthModal from '../../../components/AuthModal'
import { useAuthContext } from '../../../context/AuthContext'
import CheckoutDrawer from './CheckoutDrawer'
import MenuAdvisor, { type DiscoIntake } from './MenuAdvisor'
import FavoriteHeart from '../../account/components/FavoriteHeart'
import { cartSubtotal } from '../../../../lib/pricing/cart'
import { formatTimeWindow } from '../../../../lib/utils/deliveryTimeWindow'
import { buildCheckoutPayload } from '../../../../lib/pricing/checkout'
import { computeServiceCharge, computeTip, computeGrandTotal } from '../../../../lib/pricing/totals'
import { buildAvailableDates, buildAvailableTimes, orderingClosed } from '../../../../lib/scheduling/cutoffs'
import { trackEvent } from '../../../../lib/analytics'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const DARK = '#1A1028'
const DAY_NAMES = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY']
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

// ── Types ──────────────────────────────────────────────────────────────────────

interface RepeatWeekDay { days: string; fromPickUpTime: string; toPickUpTime: string }
interface FmSchedule {
  prepTime?: number; startDate?: string; endDate?: string
  rollingAvailability?: number; cutOff?: string; cutOffDate?: string; cutOffType?: string
  repeatWeekDays?: RepeatWeekDay[]
  skippedDays?: (string | { fromDate?: string; toDate?: string })[]
  // Native path: true only when a lead time was actually set (vs the 24h default).
  // Undefined on the FM path (treated as explicit → shown, unchanged).
  prepTimeExplicit?: boolean
}
interface FmSettings {
  deliveryType?: string; pickupOrderMinimum?: number; deliveryOrderMinimum?: number
  menuAvailability?: string[]; serviceCharge?: number | null; serviceChargeName?: string | null
  // Native path: true only when pickup/delivery were actually configured (vs the
  // default). Undefined on the FM path (treated as explicit → shown, unchanged).
  menuAvailabilityExplicit?: boolean
  tipOption?: { tipsType: string; tipsPrice: number }
  // Restaurant's "Enable Menu Search" toggle (order-settings → FM feesAndTips).
  // When true the ordering page shows a search box that filters menu items.
  enableMenuSearch?: boolean
}
interface FmMenu { reference: string; name: string; scheduleOption?: FmSchedule; settings?: FmSettings }
interface FmAddOn { reference: string; name: string; price: number; visible?: boolean; position?: number }
interface FmExtraItemsGroup {
  reference: string; name: string
  externalName?: string; subExternalName?: string
  minSelectedItems: number; maxSelectedItems: number
  visible?: boolean; enabled?: boolean
  addOns: FmAddOn[]
}
interface FmPackage {
  reference: string; name: string; description?: string | null
  price: number; serves?: string | number | null
  // Free-text display price set in the restaurant admin (e.g. "$200.00+").
  // Shown on the ordering page IN PLACE OF the numeric base price when set;
  // the checkout total still uses the numeric `price` (+ modifiers).
  displayPrice?: string | number | null
  image?: { reference: string; availableResolutions?: number[] } | null
  available?: boolean; allowedSpecialInstructions?: boolean
  extraItemsGroups?: FmExtraItemsGroup[]
  inventoryBalanceCountperTime?: number | null
}
interface FmCategory { reference: string; name: string; description?: string | null; mealPackages: FmPackage[] }
interface MenuSection { menu: FmMenu; categories: FmCategory[] }
interface Restaurant {
  name: string; address?: string; cuisine?: string; cuisines?: string[]
  description?: string; image?: any; orderUrl?: string
  isDisco?: boolean; location?: string; tags?: string[]
}
// Mirrors FM's IMealPackageSimpleResponse extraItems[] shape so the
// checkout payload can pass straight through. `count` is the selection
// quantity within the meal-package configuration (FM scales it by the
// meal-package count server-side, exactly like add-to-cart.component
// refreshTotalPrice does).
interface CartAddOn {
  reference: string
  name: string
  price: number
  count: number
  extraItemsGroupReference: string
}
interface CartItem {
  // Stable per-line ID so two configurations of the same package
  // (e.g. Half Tray vs Full Tray of the same item) stay distinct.
  lineId: string
  pkg: FmPackage
  quantity: number
  note?: string
  addOns: CartAddOn[]
  // pkg.price + Σ(addOn.price × addOn.count). This is what the cart,
  // subtotal, and checkout must use — never pkg.price alone, because
  // many FM packages have a $0 base whose real price lives in a
  // mandatory modifier group.
  unitPrice: number
}
interface AddrDetails { addressLine1: string; city: string; state: string; zipcode: string; latitude: number; longitude: number }

// Reorder stash (sessionStorage 'disco_reorder', written by OrderDetailPanel).
// Items are name-only snapshots from FM's order response — references are
// recovered by matching against the live menu.
interface ReorderStashItem { name: string; count?: number; comment?: string; addOns?: { name: string; count?: number }[] }
interface ReorderStash { restaurantSlug?: string; items?: ReorderStashItem[] }

// ── Helpers ────────────────────────────────────────────────────────────────────

const formatPrice = (p: number) => `$${p.toFixed(2)}`

// What to SHOW for a package's price on the ordering page: the admin's
// free-text display price (e.g. "$200.00+") when set, else the base price as
// currency. Display only — never used for cart/checkout math.
function packagePriceLabel(p: { displayPrice?: string | number | null; price: number }): string {
  const dp = p.displayPrice
  if (dp != null && String(dp).trim() !== '') return String(dp).trim()
  return formatPrice(p.price)
}

// Scheduling now lives in lib/scheduling/cutoffs.ts (Lead Time + Daily Cutoff +
// Hard Cutoff, with self-tests). These return only ENABLED entries so the
// calendar greys everything else and the time <select> lists only bookable
// slots; orderingClosed() drives the "ordering closed" message.
function computeDates(sched: FmSchedule): string[] {
  return buildAvailableDates(sched).filter(d => !d.disabled).map(d => d.date)
}
function computeTimes(sched: FmSchedule, dateStr: string): string[] {
  return buildAvailableTimes(sched, dateStr).filter(t => !t.disabled).map(t => t.time)
}

function fmtDateShort(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) }
  catch { return d }
}
function fmtDateMD(d: string) {
  try { const dt = new Date(d + 'T12:00:00'); return `${dt.getMonth()+1}/${dt.getDate()}/${dt.getFullYear()}` }
  catch { return d }
}
function fmtTime(t: string) {
  try { const [h, m] = t.split(':').map(Number); const dt = new Date(); dt.setHours(h, m); return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) }
  catch { return t }
}
// Pull the server-computed money out of FM's /orders/init response. Mirrors
// CheckoutDrawer's extractFmMoney (kept local to avoid touching the drawer):
// FM nests the priced totals under data.checkoutPublicResponseDto, and tax is
// the sum of state+local+other sales tax. Display-only — see previewPricing().
function extractPreviewMoney(raw: any): { subtotal: number | null; tax: number; fee: number; deliveryFee: number | null; total: number | null } {
  const d = raw?.data?.checkoutPublicResponseDto ?? raw?.data ?? raw ?? {}
  const num = (v: any) => (typeof v === 'number' ? v : 0)
  const components = num(d.stateSalesTaxInPrice) + num(d.localSalesTaxInPrice) + num(d.otherSalesTaxInPrice)
  const tax = components > 0 ? components : num(d.tax ?? d.taxAmount)
  return {
    subtotal: d.subtotal ?? d.subTotal ?? null,
    tax,
    fee: num(d.fee ?? d.serviceFee ?? d.platformFee),
    deliveryFee: d.deliveryFee ?? d.delivery ?? null,
    total: d.total ?? d.totalAmount ?? d.totalCost ?? null,
  }
}

const FM_PUBLIC = process.env.NEXT_PUBLIC_FM_API_BASE_URL || 'https://api.familymeal.com'
function pkgImg(ref: string, size = 300) {
  return `${FM_PUBLIC}/public-api/images/${ref}/download?size=${size}`
}

// Google Places returns a NYC address's borough (Manhattan, Brooklyn, Queens,
// The Bronx, Staten Island) as the locality, but Expedite dispatch expects the
// city as "New York". Normalize boroughs → "New York" when state is NY; every
// other locality is kept as-is.
const NYC_BOROUGHS = new Set(['manhattan', 'brooklyn', 'queens', 'the bronx', 'bronx', 'staten island'])

function extractAddressComponents(place: any): AddrDetails {
  const c = place.address_components ?? []
  const find = (...types: string[]) => c.find((x: any) => types.some(t => x.types.includes(t)))
  const streetNum = find('street_number')?.long_name ?? ''
  const route = find('route')?.short_name ?? ''
  const state = find('administrative_area_level_1')?.short_name ?? ''
  const locality = find('locality', 'sublocality')?.long_name ?? ''
  const city = state === 'NY' && NYC_BOROUGHS.has(locality.trim().toLowerCase()) ? 'New York' : locality
  const zipcode = find('postal_code')?.long_name ?? ''
  const lat = place.geometry?.location?.lat() ?? 0
  const lng = place.geometry?.location?.lng() ?? 0
  return { addressLine1: [streetNum, route].filter(Boolean).join(' '), city, state, zipcode, latitude: lat, longitude: lng }
}

// ── Calendar ───────────────────────────────────────────────────────────────────

function MonthCalendar({ year, month, availSet, todayIso, selDate, onSelect }: {
  year: number; month: number; availSet: Set<string>; todayIso: string
  selDate: string; onSelect: (d: string) => void
}) {
  const firstDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (string | null)[] = Array(firstDow).fill(null)
  for (let d = 1; d <= daysInMonth; d++)
    cells.push(`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`)
  while (cells.length % 7 !== 0) cells.push(null)
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 4 }}>
        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(n => (
          <div key={n} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: '#bbb', padding: '4px 0' }}>{n}</div>
        ))}
        {cells.map((iso, i) => {
          if (!iso) return <div key={`e${i}`} />
          const avail = availSet.has(iso)
          const sel = iso === selDate
          const isToday = iso === todayIso
          return (
            <button key={iso} onClick={() => avail && onSelect(iso)} disabled={!avail}
              style={{
                width: '100%', aspectRatio: '1', border: sel ? 'none' : isToday ? `2px solid ${BLUE}` : 'none',
                borderRadius: '50%', cursor: avail ? 'pointer' : 'default', fontFamily: F,
                fontSize: 12, fontWeight: sel || isToday ? 700 : 400,
                background: sel ? BLUE : 'transparent',
                color: sel ? '#fff' : avail ? DARK : '#ddd',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              {parseInt(iso.slice(-2))}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function RestaurantClient({ restaurant, fmSlug, fmRef, menuData, slug, isFirstParty = false, restaurantSettings }: {
  restaurant: Restaurant; fmSlug: string | null; fmRef: string | null
  menuData: MenuSection[]; slug: string
  // True only on the 1st-party /order/[slug] route. Flows straight to
  // CheckoutDrawer, which uses it to pick the sourceoforder wire value
  // ("FAMILYMEAL" when true, "DISCO" when false). Defaults false so the
  // existing 3P /restaurants/[slug] behavior is unchanged.
  isFirstParty?: boolean
  // Restaurant-LEVEL FM settings (feesAndTips / RestaurantSimplePublicResponseDto).
  // FM exposes these on the restaurant, not the menu, so they're threaded in here
  // rather than read off menu.settings (which never carries them).
  // onlineOrderingAllowed=false → the restaurant has paused online ordering; the
  // checkout CTA is disabled and a notice is shown (the server also hard-gates it).
  restaurantSettings?: { enableMenuSearch?: boolean; deliveryOrderTimeWindows?: string; onlineOrderingAllowed?: boolean; announcement?: string }
}) {
  // ── UI state ──────────────────────────────────────────────────────────────
  // Auth — used to gate the checkout action behind login (browsing/cart-building
  // stay open). openAuthModal stores a pending action AuthModal resumes on a
  // successful sign-in, so checkout continues automatically.
  const { user, isLoading: authLoading, openAuthModal, authModalOpen, closeAuthModal, authModalDefaultTab } = useAuthContext()
  const [activeMenuIdx, setActiveMenuIdx] = useState(0)
  const [headerImgError, setHeaderImgError] = useState(false)
  const [mobileCartOpen, setMobileCartOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  // Disco promo surfaced back from CheckoutDrawer so the restaurant-page order
  // summary can show the discount line + discounted total (display-only).
  const [summaryPromo, setSummaryPromo] = useState<{ code: string; discountAmount: number } | null>(null)

  // Mode 2 (menu advisor) — pick up intake context handed off from the fullmap
  // discovery flow via sessionStorage, if present.
  const [discoIntake, setDiscoIntake] = useState<DiscoIntake | null>(null)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('disco_intake')
      if (raw) setDiscoIntake(JSON.parse(raw))
    } catch {}
  }, [])

  // Viewport-aware rendering for the order CTA: SSR has no window so we keep
  // BOTH bars in the initial HTML (existing CSS media-query hides the wrong
  // one — no FOUC on mobile). After hydration we drop the inactive one from
  // the DOM, so the CTA text doesn't show up twice in the rendered page.
  // null === hydration hasn't run yet, render both.
  const [isMobileViewport, setIsMobileViewport] = useState<boolean | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 900px)')
    const update = () => setIsMobileViewport(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Add-ons modal
  const [addOnsPkg, setAddOnsPkg] = useState<FmPackage | null>(null)
  const [selAddOns, setSelAddOns] = useState<Record<string, Record<string, number>>>({})
  const [addOnsNote, setAddOnsNote] = useState('')
  const [addOnsQty, setAddOnsQty] = useState(1)

  // Cart
  const [cart, setCart] = useState<CartItem[]>([])
  // Reorder: transient feedback toast + one-time guard so the stash is
  // reconstructed into the cart exactly once after mount.
  const [reorderToast, setReorderToast] = useState('')
  const reorderRef = useRef(false)
  const [tipPct, setTipPct] = useState<number | null>(null)
  // "Other" tip mode: a blank custom input means $0 (NOT the menu default).
  const [tipOther, setTipOther] = useState(false)
  const [tipCustomInput, setTipCustomInput] = useState('')
  const [addr, setAddr] = useState<{ line1: string; line2: string; city: string; state: string; zip: string; lat: number | null; lng: number | null; instructions: string }>({ line1: '', line2: '', city: '', state: '', zip: '', lat: null, lng: null, instructions: '' })

  // Order config
  const [selDate, setSelDate] = useState('')
  const [selTime, setSelTime] = useState('')
  const [orderType, setOrderType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP')
  const [hasSelection, setHasSelection] = useState(false)
  // Optional. Captured for AI training + sent to FM in the order comment
  // since FM has no dedicated headcount field on the order model.
  const [headcount, setHeadcount] = useState<number | null>(null)

  // Menus modal
  const [menusOpen, setMenusOpen] = useState(false)
  const [tempHeadcount, setTempHeadcount] = useState<string>('')
  const [tempMenuIdx, setTempMenuIdx] = useState(0)
  const [tempDate, setTempDate] = useState('')
  const [tempTime, setTempTime] = useState('')
  const [tempType, setTempType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP')

  // Calendar popover (fixed-position, outside modal)
  const dateButtonRef = useRef<HTMLButtonElement>(null)
  const [calOpen, setCalOpen] = useState(false)
  const [calPos, setCalPos] = useState<{ top: number; left: number } | null>(null)
  const now = new Date()
  const todayIso = now.toISOString().slice(0, 10)
  const [calYear, setCalYear] = useState(now.getFullYear())
  const [calMonth, setCalMonth] = useState(now.getMonth())

  // Delivery address
  const addrInputRef = useRef<HTMLInputElement>(null)
  const autocompleteRef = useRef<any>(null)
  const [placesLoaded, setPlacesLoaded] = useState(false)
  const [deliveryAddrLine, setDeliveryAddrLine] = useState('')
  const [deliveryAddrDetails, setDeliveryAddrDetails] = useState<AddrDetails | null>(null)
  const [deliveryAddr2, setDeliveryAddr2] = useState('')
  const [deliveryInstr, setDeliveryInstr] = useState('')
  const [addrValidating, setAddrValidating] = useState(false)
  const [addrValidated, setAddrValidated] = useState(false)
  const [addrError, setAddrError] = useState('')
  const [addrFee, setAddrFee] = useState<number | null>(null)

  // Legacy picker state (kept for backwards compat — openPicker still callable)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pendingItemRef = useRef<FmPackage | null>(null)

  // ── Data ──────────────────────────────────────────────────────────────────
  const activeSection = menuData[activeMenuIdx]
  const activeMenu = menuData[activeMenuIdx]?.menu
  const sched = activeMenu?.scheduleOption
  const settings = activeMenu?.settings
  // Menu search — only shown when the restaurant enabled it. This is a
  // RESTAURANT-level FM setting (restaurantSettings), NOT a menu-level one; FM
  // never populates it on menu.settings, so reading it there left the bar hidden.
  const [menuSearch, setMenuSearch] = useState('')
  const menuSearchEnabled = !!restaurantSettings?.enableMenuSearch
  const menuQuery = menuSearchEnabled ? menuSearch.trim().toLowerCase() : ''
  // Restaurant-level delivery time-window setting ('exact' | '30_min' | '1_hour').
  // Delivery orders show the pickup time as a range; pickup always shows exact.
  const deliveryWindow = restaurantSettings?.deliveryOrderTimeWindows || 'exact'
  // Per-menu Disco "Include Utensils" toggle (Neon disco_menu_settings). When on,
  // CheckoutDrawer offers an optional utensils checkbox that writes an order note.
  const [includeUtensils, setIncludeUtensils] = useState(false)
  const activeMenuRef = activeMenu?.reference
  useEffect(() => {
    if (!activeMenuRef) { setIncludeUtensils(false); return }
    let cancel = false
    fetch(`/api/menu-utensils?menuRef=${encodeURIComponent(activeMenuRef)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancel) setIncludeUtensils(d?.includeUtensils === true) })
      .catch(() => { if (!cancel) setIncludeUtensils(false) })
    return () => { cancel = true }
  }, [activeMenuRef])
  const menuAvail = settings?.menuAvailability ?? ['PICKUP', 'DELIVERY']
  const defaultTip = settings?.tipOption?.tipsPrice ?? 15
  // In "Other" mode a blank input means $0 (tipPct null → 0), never the menu
  // default. Otherwise fall back to the menu's default tip.
  const activeTip = tipOther ? (tipPct ?? 0) : (tipPct ?? defaultTip)
  const minOrder = orderType === 'DELIVERY'
    ? (settings?.deliveryOrderMinimum ?? settings?.pickupOrderMinimum ?? 0)
    : (settings?.pickupOrderMinimum ?? 0)

  const availDates = useMemo(() => sched ? computeDates(sched) : [], [sched])
  const availSet = useMemo(() => new Set(availDates), [availDates])

  // Menus modal: computed from selected temp menu
  const mMenuSched = menuData[tempMenuIdx]?.menu?.scheduleOption
  const mMenuSettings = menuData[tempMenuIdx]?.menu?.settings
  const mMenuAvail = mMenuSettings?.menuAvailability ?? ['PICKUP', 'DELIVERY']
  const mAvailDates = useMemo(() => mMenuSched ? computeDates(mMenuSched) : [], [mMenuSched])
  const mAvailSet = useMemo(() => new Set(mAvailDates), [mAvailDates])
  const mModalTimes = useMemo(() => mMenuSched && tempDate ? computeTimes(mMenuSched, tempDate) : [], [mMenuSched, tempDate])
  // Hard cutoff passed (or no bookable dates) → ordering closed for this menu.
  const mMenuClosed = useMemo(() => !!mMenuSched && (orderingClosed(mMenuSched) || mAvailDates.length === 0), [mMenuSched, mAvailDates])

  // ── Query-param prefill (?orderDate, ?embed) ───────────────────────────────
  // Used by /account/orders' "New order from calendar" flow which loads this
  // page in an iframe with the picked date prefilled and the global header
  // hidden so it tucks cleanly under the drawer chrome.
  const searchParams = useSearchParams()
  const embedded = searchParams?.get('embed') === '1'
  // Calendar deep-link date. The "New order from calendar" flow sends
  // ?orderDate=YYYY-MM-DD; also accept a plain ?date= for any other caller.
  const presetOrderDate = searchParams?.get('orderDate') || searchParams?.get('date') || ''
  // Direct Entry — restaurant staff placing an order on behalf of a customer.
  // Routed here from /restaurant/orders/create with ?mode=direct-entry. The flag
  // shows a banner and switches CheckoutDrawer to the restaurant-authed place
  // call (and, for method=invoice, the no-card "Send Invoice" flow).
  const isDirectEntry = searchParams?.get('mode') === 'direct-entry'
  const directEntryMethod: 'payment' | 'invoice' = searchParams?.get('method') === 'invoice' ? 'invoice' : 'payment'
  const prefilledRef = useRef(false)
  useEffect(() => {
    if (prefilledRef.current || !presetOrderDate) return
    prefilledRef.current = true
    // Open the menus modal with the date pre-selected — user still picks
    // a time + (delivery/pickup) before clicking Start Order.
    setTempMenuIdx(activeMenuIdx)
    setTempDate(presetOrderDate)
    setTempType(orderType)
    setTempTime('')
    try {
      const d = new Date(presetOrderDate + 'T12:00:00')
      setCalYear(d.getFullYear()); setCalMonth(d.getMonth())
    } catch {}
    setMenusOpen(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetOrderDate])

  // ── Google Places loading ─────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    if ((window as any).google?.maps?.places) { setPlacesLoaded(true); return }
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
    if (!key) return
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`
    script.async = true
    script.onload = () => setPlacesLoaded(true)
    document.head.appendChild(script)
  }, [])

  // ── Places Autocomplete init ───────────────────────────────────────────────
  useEffect(() => {
    if (!placesLoaded || !menusOpen || tempType !== 'DELIVERY') {
      autocompleteRef.current = null
      return
    }
    if (!addrInputRef.current) return
    const google = (window as any).google
    if (!google?.maps?.places) return
    const ac = new google.maps.places.Autocomplete(addrInputRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: ['address_components', 'geometry', 'formatted_address'],
    })
    autocompleteRef.current = ac
    const listener = ac.addListener('place_changed', () => {
      const place = ac.getPlace()
      if (!place?.address_components) return
      const details = extractAddressComponents(place)
      setDeliveryAddrLine(place.formatted_address ?? '')
      setDeliveryAddrDetails(details)
      validateDeliveryAddr(details)
    })
    return () => { google.maps.event.removeListener(listener); autocompleteRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesLoaded, menusOpen, tempType])

  // ── Auto-open menus modal on mount ────────────────────────────────────────
  useEffect(() => {
    if (!fmSlug || availDates.length === 0) return
    // When arriving from the calendar with a chosen date (?orderDate / ?date),
    // the query-param prefill effect above already opened the modal on that
    // date — don't clobber it with the next-available default.
    if (presetOrderDate) return
    const first = availDates[0]
    const d = new Date(first + 'T12:00:00')
    setCalYear(d.getFullYear()); setCalMonth(d.getMonth())
    setTempDate(first)
    const mSched = menuData[0]?.menu?.scheduleOption
    const firstTime = mSched ? (computeTimes(mSched, first)[0] ?? '') : ''
    setTempTime(firstTime)
    const defaultType = menuAvail.includes('PICKUP') ? 'PICKUP' : 'DELIVERY'
    setTempType(defaultType as 'PICKUP' | 'DELIVERY')
    setMenusOpen(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Prefill delivery from the customer's saved default address ─────────────
  // Runs once. Pulls the Disco address book and seeds the delivery fields with
  // the default (or first) address so it's pre-selected at checkout. Leaves the
  // fields blank for guests / customers with no saved address.
  const addrPrefilledRef = useRef(false)
  useEffect(() => {
    if (addrPrefilledRef.current) return
    if (deliveryAddrDetails || deliveryAddrLine) return
    addrPrefilledRef.current = true
    ;(async () => {
      try {
        const res = await fetch('/api/customer-addresses', { credentials: 'include' })
        if (!res.ok) return
        const d = await res.json()
        const list: any[] = Array.isArray(d.addresses) ? d.addresses : []
        const def = list.find(a => a.is_default) || list[0]
        if (!def) return
        setDeliveryAddrLine([def.address_line1, def.city, def.state, def.zipcode].filter(Boolean).join(', '))
        if (def.address_line2) setDeliveryAddr2(def.address_line2)
        if (def.delivery_instructions) setDeliveryInstr(def.delivery_instructions)
        const lat = def.latitude != null ? Number(def.latitude) : null
        const lng = def.longitude != null ? Number(def.longitude) : null
        if (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
          setDeliveryAddrDetails({ addressLine1: def.address_line1, city: def.city, state: def.state, zipcode: def.zipcode, latitude: lat, longitude: lng })
        }
      } catch { /* not logged in / no saved address — leave blank */ }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Once the delivery modal is open and we have a prefilled default with
  // coordinates, validate it for this restaurant so the fee + ✓ show without
  // the customer re-entering anything. Fires at most once.
  const autoValidatedRef = useRef(false)
  useEffect(() => {
    if (autoValidatedRef.current) return
    if (!menusOpen || tempType !== 'DELIVERY') return
    if (!deliveryAddrDetails || addrValidated || addrValidating || !fmRef) return
    autoValidatedRef.current = true
    validateDeliveryAddr(deliveryAddrDetails)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menusOpen, tempType, deliveryAddrDetails, fmRef])

  // ── Address validation ────────────────────────────────────────────────────
  async function validateDeliveryAddr(details: AddrDetails) {
    if (!fmRef) return
    setAddrValidating(true); setAddrError(''); setAddrValidated(false); setAddrFee(null)
    try {
      // FM contract (doordash.service.ts checkValidate): nested deliveryAddress
      // with lat/lng + deliveryInstructions, plus restaurantReference and the
      // selected menuReference. (Endpoint stays /public-api/delivery/validate —
      // FM's Expedite/Dlivrd dispatch path.)
      const res = await fetch('/api/order/validate-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deliveryAddress: {
            addressLine1: details.addressLine1,
            addressLine2: deliveryAddr2 || '',
            city: details.city,
            state: details.state,
            zipcode: details.zipcode,
            latitude: details.latitude,
            longitude: details.longitude,
            deliveryInstructions: deliveryInstr || '',
          },
          restaurantReference: fmRef,
          menuReference: menuData[tempMenuIdx]?.menu?.reference,
        }),
      })
      const data = await res.json()
      if (res.ok && data.error == null && data.valid !== false) {
        setAddrValidated(true)
        setAddrFee(data.deliveryFee ?? data.fee ?? null)
      } else {
        setAddrError('Delivery not available at this address')
      }
    } catch {
      setAddrError('Could not validate address')
    } finally {
      setAddrValidating(false)
    }
  }

  // ── Menus modal handlers ──────────────────────────────────────────────────
  function getMenuNextAvail(menu: FmMenu): string {
    if (!menu.scheduleOption) return ''
    const dates = computeDates(menu.scheduleOption)
    if (!dates[0]) return ''
    return `${fmtDateShort(dates[0])} (next available)`
  }

  function selectMenuInModal(idx: number) {
    setTempMenuIdx(idx)
    const sch = menuData[idx]?.menu?.scheduleOption
    const types = menuData[idx]?.menu?.settings?.menuAvailability ?? ['PICKUP', 'DELIVERY']
    const dates = sch ? computeDates(sch) : []
    const first = dates[0] ?? ''
    setTempDate(first)
    const firstTime = sch && first ? (computeTimes(sch, first)[0] ?? '') : ''
    setTempTime(firstTime)
    if (first) {
      const d = new Date(first + 'T12:00:00')
      setCalYear(d.getFullYear()); setCalMonth(d.getMonth())
    }
    setTempType(types.includes('PICKUP') ? 'PICKUP' : 'DELIVERY')
    setAddrValidated(false); setAddrError(''); setAddrFee(null)
    setCalOpen(false)
  }

  function openMenus() {
    setTempMenuIdx(activeMenuIdx)
    const sch = menuData[activeMenuIdx]?.menu?.scheduleOption
    const dates = sch ? computeDates(sch) : []
    const first = selDate || dates[0] || ''
    setTempDate(first)
    setTempTime(selTime)
    setTempType(orderType)
    setTempHeadcount(headcount != null ? String(headcount) : '')
    setDeliveryAddrLine('')
    setDeliveryAddrDetails(null)
    setDeliveryAddr2(''); setDeliveryInstr('')
    setAddrValidated(false); setAddrError(''); setAddrFee(null)
    if (first) {
      const d = new Date(first + 'T12:00:00')
      setCalYear(d.getFullYear()); setCalMonth(d.getMonth())
    }
    setCalOpen(false)
    setMenusOpen(true)
  }

  function closeMenus() { setMenusOpen(false); setCalOpen(false); pendingItemRef.current = null }

  function openCalendar() {
    if (!dateButtonRef.current) return
    const rect = dateButtonRef.current.getBoundingClientRect()
    const CAL_HEIGHT = 290
    const spaceBelow = window.innerHeight - rect.bottom - 6
    const top = spaceBelow >= CAL_HEIGHT ? rect.bottom + 6 : rect.top - CAL_HEIGHT - 6
    setCalPos({ top, left: rect.left })
    setCalOpen(true)
  }

  function handleDateSelect(d: string) {
    setTempDate(d)
    const firstTime = mMenuSched ? (computeTimes(mMenuSched, d)[0] ?? '') : ''
    setTempTime(firstTime)
    setCalOpen(false)
  }

  function prevMonth() {
    if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11) }
    else setCalMonth(m => m - 1)
  }
  function nextMonth() {
    if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0) }
    else setCalMonth(m => m + 1)
  }

  const canStartOrder = !!tempDate && !!tempTime && (tempType !== 'DELIVERY' || addrValidated)

  function startOrder() {
    if (!canStartOrder) return
    setActiveMenuIdx(tempMenuIdx)
    setSelDate(tempDate)
    setSelTime(tempTime)
    setOrderType(tempType)
    {
      const n = parseInt(tempHeadcount, 10)
      setHeadcount(!isNaN(n) && n > 0 ? n : null)
    }
    if (tempType === 'DELIVERY' && deliveryAddrDetails) {
      setAddr({
        line1: deliveryAddrDetails.addressLine1,
        line2: deliveryAddr2,
        city: deliveryAddrDetails.city,
        state: deliveryAddrDetails.state,
        zip: deliveryAddrDetails.zipcode,
        lat: deliveryAddrDetails.latitude,
        lng: deliveryAddrDetails.longitude,
        instructions: deliveryInstr,
      })
    }
    setHasSelection(true)
    const pending = pendingItemRef.current
    if (pending) {
      pendingItemRef.current = null
      handleAddClickInner(pending)
    }
    closeMenus()
  }

  // ── Legacy picker (kept) ──────────────────────────────────────────────────
  function openPicker() { openMenus() }
  function confirmPicker() {
    if (!tempDate || !tempTime) return
    setSelDate(tempDate); setSelTime(tempTime); setOrderType(tempType)
    setHasSelection(true); setPickerOpen(false)
  }
  function closePicker() { setPickerOpen(false) }

  // ── Pricing ───────────────────────────────────────────────────────────────
  // Routed through lib/pricing helpers so cart subtotal, service charge,
  // tip, and the FM checkout payload all use one source of truth. Math
  // is unchanged from the previous inline version — verified against
  // Pudding × 1 / Pudding × 2 test orders (FM scales addon.count by
  // meal.count server-side; our `unitPrice × quantity` was already
  // correct for that). See lib/pricing/cart.ts and docs/fm-cart-
  // checkout-reconciliation.md § 7.
  const subtotal = cartSubtotal(cart.map(i => ({
    price: i.pkg.price,
    count: i.quantity,
    addOns: i.addOns,
  })))
  // activeTip is already in PERCENTAGE POINTS (presets 10/15/20, custom
  // (dollars/subtotal)*100, default tipsPrice ?? 15). computeTip divides
  // by 100 internally, so pass activeTip directly — the prior `* 100`
  // double-scaled it (15 → 1500 → $15 tip on a $1 subtotal, the 100× bug).
  const tipAmt = computeTip({ base: subtotal, pct: activeTip })
  const svcPct = settings?.serviceCharge ?? 0
  const svcAmt = computeServiceCharge(subtotal, svcPct)
  const clientTotal = computeGrandTotal({ subtotal, serviceCharge: svcAmt, tip: tipAmt })
  const belowMin = minOrder > 0 && subtotal < minOrder && cart.length > 0

  // ── Pricing preview (taxes & fees before checkout) ─────────────────────────
  // FM has no client-side tax/fee math, so we POST /orders/init (the SAME public
  // endpoint + payload CheckoutDrawer uses) to get FM's server-computed
  // subtotal/tax/fee/delivery/total and show them in the Order Summary BEFORE the
  // user opens the drawer. Best-effort: any failure silently falls back to
  // "Calculated at checkout" (never a guessed amount). The orderRef FM returns
  // here is DISPLAY-ONLY and is intentionally never read/stored — CheckoutDrawer
  // always runs its own fresh init to mint the orderRef it actually places.
  const [pricingPreview, setPricingPreview] = useState<{ subtotal: number | null; tax: number; fee: number; deliveryFee: number | null; total: number | null } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewAbortRef = useRef<AbortController | null>(null)
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewSeqRef = useRef(0)

  // Stable fingerprint of the cart so the effect re-fires on any qty/add-on edit.
  const cartKey = useMemo(
    () => cart.map(i => `${i.pkg.reference}:${i.quantity}:${i.addOns.map(a => `${a.reference}x${a.count}`).join(',')}`).join('|'),
    [cart],
  )

  // Conditions to preview: ≥1 item, date + time chosen, and for DELIVERY a
  // validated, committed address (lat/lng present — that's what the payload
  // needs). Logged-out users are fine: /orders/init is public (no auth).
  const canPreview = !!fmRef && cart.length > 0 && !!selDate && !!selTime &&
    (orderType === 'PICKUP' || (addrValidated && !!addr.line1 && addr.lat != null && addr.lng != null))

  // Cancel any pending debounce + in-flight fetch and invalidate late responses.
  function cancelPreview() {
    previewSeqRef.current++ // any outstanding response is now ignored
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    if (previewDebounceRef.current) { clearTimeout(previewDebounceRef.current); previewDebounceRef.current = null }
    setPreviewLoading(false)
  }

  async function previewPricing() {
    const seq = ++previewSeqRef.current
    const controller = new AbortController()
    previewAbortRef.current = controller
    setPreviewLoading(true)

    // Build the EXACT DTO CheckoutDrawer's init sends (buildCheckoutDto's init
    // branch): base payload + tips + tipsType + taxExempt:false.
    const fmAddr = {
      addressLine1: addr.line1,
      addressLine2: addr.line2 || '',
      city: addr.city,
      state: addr.state,
      zipcode: addr.zip,
      latitude: addr.lat ?? undefined,
      longitude: addr.lng ?? undefined,
      deliveryInstructions: addr.instructions || '',
    }
    const dto = {
      ...buildCheckoutPayload({
        restaurantRef: fmRef!,
        cart: cart.map(i => ({ reference: i.pkg.reference, name: i.pkg.name, price: i.pkg.price, count: i.quantity, addOns: i.addOns, note: i.note })),
        orderType,
        orderDate: selDate,
        orderTime: selTime,
        deliveryAddress: orderType === 'DELIVERY' ? fmAddr : undefined,
        headcount,
      }),
      tips: tipAmt,
      // FM TipsType is CUSTOM (fixed $) | PERCENTAGE; a $ tip is CUSTOM, none is PERCENTAGE 0.
      tipsType: tipAmt > 0 ? 'CUSTOM' : 'PERCENTAGE',
      taxExempt: false,
    }

    try {
      const res = await fetch('/api/order/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
        signal: controller.signal,
      })
      const data = await res.json()
      // Stale (a newer change superseded this) or aborted → drop silently.
      if (controller.signal.aborted || seq !== previewSeqRef.current) return
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn('[pricingPreview] init failed', data?.error || res.status)
        setPricingPreview(null)
        return
      }
      // NOTE: data.data.orderReference is DELIBERATELY ignored — the preview
      // orderRef must never be reused for the real order. CheckoutDrawer inits
      // its own. We only read the priced money below.
      const money = extractPreviewMoney(data)
      const meaningful = money.total != null || money.subtotal != null || money.tax > 0 || money.fee > 0
      if (!meaningful) { setPricingPreview(null); return }
      setPricingPreview(money)
    } catch (err: any) {
      if (err?.name === 'AbortError') return // superseded by a fresh debounce
      // eslint-disable-next-line no-console
      console.warn('[pricingPreview] error', err)
      setPricingPreview(null)
    } finally {
      if (seq === previewSeqRef.current) setPreviewLoading(false)
      if (previewAbortRef.current === controller) previewAbortRef.current = null
    }
  }

  // Watch the inputs FM prices on. On ANY change: invalidate the old preview
  // immediately (no stale taxes), cancel in-flight work, then — if eligible —
  // show the loading state and debounce 800ms before firing one init.
  useEffect(() => {
    setPricingPreview(null)
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)

    if (!canPreview) { setPreviewLoading(false); return }

    setPreviewLoading(true)
    previewDebounceRef.current = setTimeout(() => { previewPricing() }, 800)
    return () => { if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current) }
    // tipAmt is intentionally NOT a dep: tax/fees don't depend on tip, and the
    // displayed Total folds in the live tip client-side (see previewTotal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey, selDate, selTime, orderType, addrValidated, addr.line1, addr.lat, addr.lng])

  // Derived display values. Taxes & Fees = FM fee + tax (mirrors the drawer's
  // combined line). Total is built from parts + the LIVE tip so changing the tip
  // updates it instantly without re-firing init.
  const previewTaxesFees = pricingPreview ? pricingPreview.fee + pricingPreview.tax : null
  const previewDelivery = pricingPreview ? pricingPreview.deliveryFee : null
  const previewTotal = pricingPreview
    ? (pricingPreview.subtotal ?? subtotal) + (previewTaxesFees ?? 0)
        + (orderType === 'DELIVERY' ? (previewDelivery ?? 0) : 0) + svcAmt + tipAmt
    : null

  const notices: string[] = []
  // Lead time: show only when actually configured. Native restaurants get a 24h
  // engine default that must NOT be advertised as if the restaurant chose it —
  // prepTimeExplicit is false in that case (undefined on the FM path → shown).
  if (sched?.prepTime && sched?.prepTimeExplicit !== false) notices.push(`${sched.prepTime}hr lead time`)
  if (minOrder) notices.push(`${formatPrice(minOrder)} minimum`)
  // Fulfillment: same rule. The order-flow fallback to [PICKUP, DELIVERY] is a
  // sensible cart default, but advertising it in the notices bar would falsely
  // claim delivery for a restaurant that never configured either. Native path
  // flags this via menuAvailabilityExplicit (undefined on the FM path → shown,
  // preserving the prior FM behavior of trusting an explicitly-returned array).
  const fmFulfillment = settings?.menuAvailability
  if (Array.isArray(fmFulfillment) && fmFulfillment.length && settings?.menuAvailabilityExplicit !== false) {
    notices.push(fmFulfillment.map(t => t === 'PICKUP' ? 'Pickup' : 'Delivery').join(' & '))
  }

  // ── Cart helpers ──────────────────────────────────────────────────────────
  // cartQty sums across all configurations of the same package, since the
  // menu badge just wants "is this package in the cart".
  const cartQty = (ref: string) => cart
    .filter(i => i.pkg.reference === ref)
    .reduce((s, i) => s + i.quantity, 0)
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0)
  // Mirrors CheckoutDrawer's canProceed (now that the drawer has no in-drawer
  // review step, the trigger has to gate on date + time + delivery address
  // upstream instead of the drawer rendering a "complete your selections"
  // fallback).
  // Online ordering paused → no checkout, regardless of cart/date/etc.
  const orderingPaused = restaurantSettings?.onlineOrderingAllowed === false
  const announcement = (restaurantSettings?.announcement || '').trim()
  const canCheckout = !orderingPaused && cart.length > 0 && !belowMin && !!selDate && !!selTime &&
    (orderType === 'PICKUP' || (!!addr.line1 && addr.lat != null && addr.lng != null))

  // GA funnel: checkout drawer opened. Fires once per open (covers both the
  // desktop and mobile "Continue to Checkout" buttons). Skips Direct Entry —
  // those are internal restaurant orders, not customer funnel data.
  useEffect(() => {
    if (!checkoutOpen || isDirectEntry) return
    trackEvent('checkout_opened', {
      restaurant_name: restaurant.name,
      restaurant_slug: slug,
      item_count: cartCount,
      subtotal,
    })
    // Intentionally only re-runs on open/close toggle, not on cart edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutOpen])
  // Subtotal/total are already shown in the order summary above the button, so
  // the label is just the action.
  const ctaLabel = orderingPaused ? 'Not accepting online orders' : cartCount > 0 ? 'Continue to Checkout' : 'Browse Menu → Start Order'

  // Login gate: only the checkout action requires auth. Direct Entry (restaurant
  // admin placing on behalf of a customer) is never gated. When logged out, open
  // the auth modal with a pending action that resumes checkout after sign-in.
  function proceedToCheckout(closeMobileCart: boolean) {
    if (!canCheckout) return
    cancelPreview()
    if (closeMobileCart) setMobileCartOpen(false)
    setCheckoutOpen(true)
  }
  function startCheckout(closeMobileCart: boolean) {
    if (!canCheckout) return
    if (!user && !isDirectEntry) {
      openAuthModal(() => proceedToCheckout(closeMobileCart), 'login')
      return
    }
    proceedToCheckout(closeMobileCart)
  }

  function genLineId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }

  // Config signature so the same package with the same modifier + note
  // selection merges into one line, but Half Tray vs Full Tray of the
  // same package stay separate.
  function configSig(addOns: CartAddOn[], note?: string): string {
    const sig = [...addOns].sort((a, b) => a.reference.localeCompare(b.reference))
      .map(a => `${a.reference}:${a.count}`).join('|')
    return `${sig}::${note || ''}`
  }

  function addItemWithConfig(pkg: FmPackage, addQty: number, addOns: CartAddOn[], note: string | undefined, unitPrice: number) {
    setCart(prev => {
      const sig = configSig(addOns, note)
      const i = prev.findIndex(x => x.pkg.reference === pkg.reference && configSig(x.addOns, x.note) === sig)
      if (i >= 0) {
        const n = [...prev]
        n[i] = { ...n[i], quantity: n[i].quantity + addQty }
        return n
      }
      return [...prev, { lineId: genLineId(), pkg, quantity: addQty, note, addOns, unitPrice }]
    })
  }

  function incrementLine(lineId: string, delta: number) {
    setCart(prev => prev
      .map(i => i.lineId === lineId ? { ...i, quantity: i.quantity + delta } : i)
      .filter(i => i.quantity > 0))
  }

  // ── Reorder reconstruction ──────────────────────────────────────────────────
  // After the (server-loaded) menu is available, rebuild the cart from a
  // 'disco_reorder' stash by name-matching against the live menu — references
  // aren't in FM's order response. Date/time are intentionally NOT pre-set; the
  // diner picks them as normal and the reordered cart reveals once they do.
  useEffect(() => {
    if (reorderRef.current) return
    reorderRef.current = true
    let raw: string | null = null
    try { raw = sessionStorage.getItem('disco_reorder') } catch {}
    if (!raw) return
    try { sessionStorage.removeItem('disco_reorder') } catch {} // one-time use
    let stash: ReorderStash
    try { stash = JSON.parse(raw) } catch { return }

    // Guard against stale data from a different restaurant.
    const stashedSlug = (stash.restaurantSlug || '').toLowerCase().trim()
    const curSlugs = [slug, fmSlug].filter(Boolean).map(s => String(s).toLowerCase().trim())
    if (!stashedSlug || !curSlugs.includes(stashedSlug)) return

    const items = Array.isArray(stash.items) ? stash.items : []
    if (items.length === 0) return

    const norm = (x: string) => (x || '').toLowerCase().trim()
    const allPkgs = menuData.flatMap(s => s.categories.flatMap(c => c.mealPackages))

    let matched = 0
    for (const item of items) {
      const pkg = allPkgs.find(p => norm(p.name) === norm(item.name))
      if (!pkg) continue // renamed/removed package → miss
      matched++
      const addOns: CartAddOn[] = []
      let extra = 0
      for (const sa of item.addOns ?? []) {
        let hit: { a: FmAddOn; groupRef: string } | null = null
        for (const g of pkg.extraItemsGroups ?? []) {
          const a = g.addOns.find(x => norm(x.name) === norm(sa.name))
          if (a) { hit = { a, groupRef: g.reference }; break }
        }
        if (!hit) continue // add-on gone → add the package without it
        const count = sa.count && sa.count > 0 ? sa.count : 1
        addOns.push({ reference: hit.a.reference, name: hit.a.name, price: hit.a.price, count, extraItemsGroupReference: hit.groupRef })
        extra += hit.a.price * count
      }
      const qty = item.count && item.count > 0 ? item.count : 1
      addItemWithConfig(pkg, qty, addOns, item.comment || undefined, pkg.price + extra)
    }

    const total = items.length
    const msg = matched === 0
      ? "We couldn't match your previous order to the current menu."
      : matched < total
        ? `${matched} of ${total} items added — some items may no longer be available.`
        : 'Your previous order has been added to your cart.'
    setReorderToast(msg)
    setTimeout(() => setReorderToast(''), 6000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Add-ons modal helpers ─────────────────────────────────────────────────
  function handleAddClickInner(pkg: FmPackage) {
    setAddOnsPkg(pkg)
    const groups = pkg.extraItemsGroups ?? []
    const init: Record<string, Record<string, number>> = {}
    groups.forEach(g => { const m: Record<string, number> = {}; g.addOns.forEach(a => { m[a.reference] = 0 }); init[g.reference] = m })
    setSelAddOns(init); setAddOnsNote(''); setAddOnsQty(1)
  }
  function handleAddClick(pkg: FmPackage) {
    if (!hasSelection) {
      pendingItemRef.current = pkg
      openMenus()
      return
    }
    handleAddClickInner(pkg)
  }
  function groupTotal(g: FmExtraItemsGroup) { return Object.values(selAddOns[g.reference] ?? {}).reduce((s, q) => s + q, 0) }
  function isGroupValid(g: FmExtraItemsGroup) { const t = groupTotal(g); return t >= g.minSelectedItems && t <= g.maxSelectedItems }
  function canConfirmAddOns() {
    if (!addOnsPkg) return false
    // A group is REQUIRED iff minSelectedItems > 0. Optional groups
    // (minSelectedItems === 0) never block "Add to Order", regardless of
    // selection.
    return (addOnsPkg.extraItemsGroups ?? []).filter(g => g.minSelectedItems > 0).every(g => isGroupValid(g))
  }
  function addOnsRunningPrice() {
    if (!addOnsPkg) return 0
    let extra = 0
    for (const g of addOnsPkg.extraItemsGroups ?? []) {
      const m = selAddOns[g.reference] ?? {}
      for (const a of g.addOns) extra += a.price * (m[a.reference] ?? 0)
    }
    return (addOnsPkg.price + extra) * addOnsQty
  }
  function confirmAddOns() {
    if (!addOnsPkg || !canConfirmAddOns()) return
    // Capture the selected modifiers + computed unit price so the cart
    // line, subtotal, and FM checkout payload all use the right price
    // for this configuration.
    const picked: CartAddOn[] = []
    let extra = 0
    for (const g of addOnsPkg.extraItemsGroups ?? []) {
      const m = selAddOns[g.reference] ?? {}
      for (const a of g.addOns) {
        const c = m[a.reference] ?? 0
        if (c > 0) {
          picked.push({
            reference: a.reference, name: a.name, price: a.price,
            count: c, extraItemsGroupReference: g.reference,
          })
          extra += a.price * c
        }
      }
    }
    const unitPrice = addOnsPkg.price + extra
    addItemWithConfig(addOnsPkg, addOnsQty, picked, addOnsNote || undefined, unitPrice)
    setAddOnsPkg(null)
  }
  function setAddOnQty(groupRef: string, addOnRef: string, delta: number, max: number) {
    setSelAddOns(prev => {
      const gm = { ...(prev[groupRef] ?? {}) }
      const cur = gm[addOnRef] ?? 0
      const total = Object.values(gm).reduce((s, q) => s + q, 0)
      if (delta > 0 && total >= max) return prev
      gm[addOnRef] = Math.max(0, cur + delta)
      return { ...prev, [groupRef]: gm }
    })
  }

  // ── Header image ──────────────────────────────────────────────────────────
  const headerImg = restaurant.image?.asset?._ref
    ? `https://cdn.sanity.io/images/0j4eqnmw/production/${restaurant.image.asset._ref.replace(/^image-/, '').replace(/-([a-z]+)$/, '.$1')}`
    : null
  const tags = restaurant.cuisines?.length ? restaurant.cuisines : restaurant.cuisine ? [restaurant.cuisine] : []

  const [taxTooltip, setTaxTooltip] = useState(false)

  // Pulsing placeholder shown on the amount while a pricing preview is fetching.
  const priceSkeleton = (
    <span aria-label="Calculating" style={{ display: 'inline-block', width: 52, height: 12, borderRadius: 4, background: '#ececf2', animation: 'pricingPulse 1.1s ease-in-out infinite' }} />
  )

  // ── Cart panel ────────────────────────────────────────────────────────────
  const cartPanel = (
    <div>
      {hasSelection ? (
        // In embed mode the NewOrderDialog header already shows the date
        // and the menus modal "Edit" button is reachable via the menu
        // tabs / openMenus button on screen, so this redundant row goes
        // away. Headcount stays visible inline below.
        !embedded ? (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4', background: '#fafafa' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 12, color: '#555' }}>
                <span style={{ fontWeight: 700 }}>{fmtDateShort(selDate)}</span>
                {selTime && <span style={{ color: '#888' }}> · {formatTimeWindow(selTime, deliveryWindow, orderType === 'DELIVERY')}</span>}
                <span style={{ color: '#888' }}> · {orderType === 'PICKUP' ? 'Pickup' : 'Delivery'}</span>
              </div>
              <button onClick={openMenus} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: BLUE, fontWeight: 700, fontFamily: F, padding: '2px 6px' }}>Edit</button>
            </div>
            {headcount != null && (
              <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                👥 {headcount} {headcount === 1 ? 'person' : 'people'}
              </div>
            )}
          </div>
        ) : headcount != null ? (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #f4f4f4', background: '#fafafa', fontSize: 12, color: '#555' }}>
            👥 {headcount} {headcount === 1 ? 'person' : 'people'}
          </div>
        ) : null
      ) : fmSlug ? (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4' }}>
          <button onClick={openMenus} style={{ width: '100%', padding: '10px', background: '#f0f0f8', border: `1.5px dashed ${INDIGO}30`, borderRadius: 10, cursor: 'pointer', fontFamily: F, fontSize: 13, fontWeight: 600, color: INDIGO }}>
            📅 Select Date & Time
          </button>
        </div>
      ) : null}

      {hasSelection && orderType === 'DELIVERY' && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>Delivery Address</div>
          {/* Read-only — the validated, geocoded address from the order-setup
              modal. Editing here is via "Change address" (reopens the modal with
              Places autocomplete + re-validation) so we never lose lat/lng. */}
          {addr.line1 ? (
            <div style={{ fontSize: 13, color: DARK, lineHeight: 1.5 }}>
              {addr.line1}{addr.line2 ? `, ${addr.line2}` : ''}<br />
              {[addr.city, addr.state].filter(Boolean).join(', ')} {addr.zip}
              {addr.instructions && <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>📝 {addr.instructions}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: '#bbb' }}>No address selected</div>
          )}
          <button onClick={openMenus} style={{ marginTop: 7, background: 'none', border: 'none', color: BLUE, fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: F }}>
            Change address
          </button>
        </div>
      )}

      <div style={{ padding: '0 16px' }}>
        {cart.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0 8px', color: '#bbb', fontSize: 13, lineHeight: 1.7 }}>
            Browse the menu and click<br /><strong style={{ color: '#aaa' }}>any item</strong> to get started
          </div>
        ) : (
          <>
            <div style={{ paddingTop: 8 }}>
              {cart.map(item => (
                <div key={item.lineId} style={{ padding: '10px 0', borderBottom: '1px solid #f4f4f4', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: DARK, lineHeight: 1.3, marginBottom: 1 }}>{item.pkg.name}</div>
                    {item.pkg.serves && <div style={{ fontSize: 11, color: '#bbb' }}>Serves {item.pkg.serves}</div>}
                    {item.addOns.length > 0 && (
                      <div style={{ marginTop: 3 }}>
                        {item.addOns.map(a => (
                          <div key={a.reference} style={{ fontSize: 11, color: '#888' }}>
                            + ({a.count}) {a.name}{a.price > 0 ? ` (+${formatPrice(a.price)} each)` : ''}
                          </div>
                        ))}
                      </div>
                    )}
                    {item.note && <div style={{ fontSize: 11, color: '#aaa', fontStyle: 'italic', marginTop: 2 }}>{item.note}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginTop: 1 }}>
                    <button onClick={() => incrementLine(item.lineId, -1)} style={{ width: 24, height: 24, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 14, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 700, color: DARK, minWidth: 18, textAlign: 'center' }}>{item.quantity}</span>
                    <button onClick={() => incrementLine(item.lineId, +1)} style={{ width: 24, height: 24, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 14, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK, minWidth: 52, textAlign: 'right', marginTop: 1 }}>{formatPrice(item.unitPrice * item.quantity)}</div>
                </div>
              ))}
            </div>
            <div style={{ paddingTop: 12 }}>
              {/* Subtotal — prefers FM's priced value once the preview lands. */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                <span style={{ color: '#555' }}>Subtotal</span>
                <span style={{ color: DARK, fontWeight: 600 }}>{formatPrice(pricingPreview?.subtotal ?? subtotal)}</span>
              </div>
              {/* Disco promo — display only. The FM payload + Stripe charge are
                  unchanged; the discount is refunded via Stripe after the order. */}
              {summaryPromo && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: '#16A34A' }}>Promo ({summaryPromo.code})</span>
                  <span style={{ color: '#16A34A', fontWeight: 600 }}>−{formatPrice(summaryPromo.discountAmount)}</span>
                </div>
              )}
              {/* Service Charge */}
              {svcAmt > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: '#555' }}>{settings?.serviceChargeName || 'Service Charge'}</span>
                  <span style={{ color: DARK, fontWeight: 600 }}>{formatPrice(svcAmt)}</span>
                </div>
              )}
              {/* Taxes & Fees with tooltip */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, marginBottom: previewDelivery != null && orderType === 'DELIVERY' ? 6 : 14 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#555' }}>
                  Taxes &amp; Fees
                  <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                    <span
                      onMouseEnter={() => setTaxTooltip(true)}
                      onMouseLeave={() => setTaxTooltip(false)}
                      style={{ width: 14, height: 14, borderRadius: '50%', background: '#ddd', color: '#666', fontSize: 9, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', userSelect: 'none' as const }}>
                      ℹ
                    </span>
                    {taxTooltip && (
                      <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: '#fff', border: '1px solid #e8e8e8', borderRadius: 8, padding: '10px 13px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', whiteSpace: 'nowrap', zIndex: 20, pointerEvents: 'none' as const, minWidth: 200 }}>
                        {pricingPreview ? (
                          <>
                            <div style={{ fontSize: 12, color: DARK, marginBottom: 3 }}>Tax: {formatPrice(pricingPreview.tax)}</div>
                            <div style={{ fontSize: 12, color: DARK, marginBottom: 8 }}>Platform fee: {formatPrice(pricingPreview.fee)}</div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: 12, color: DARK, marginBottom: 3 }}>Tax: Calculated at checkout</div>
                            <div style={{ fontSize: 12, color: DARK, marginBottom: 8 }}>Platform fee included at checkout</div>
                          </>
                        )}
                        <div style={{ fontSize: 11, color: '#888', fontStyle: 'italic', lineHeight: 1.4 }}>This allows us to be free for restaurants.</div>
                      </div>
                    )}
                  </span>
                </span>
                {previewLoading
                  ? priceSkeleton
                  : previewTaxesFees != null
                    ? <span style={{ color: DARK, fontWeight: 600 }}>{formatPrice(previewTaxesFees)}</span>
                    : <span style={{ color: '#bbb', fontSize: 12, fontStyle: 'italic' }}>Calculated at checkout</span>}
              </div>
              {/* Delivery fee — only for delivery, once FM has priced it. */}
              {orderType === 'DELIVERY' && (previewLoading || previewDelivery != null) && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, marginBottom: 14 }}>
                  <span style={{ color: '#555' }}>Delivery fee</span>
                  {previewLoading
                    ? priceSkeleton
                    : previewDelivery === 0
                      ? <span style={{ color: '#22C55E', fontWeight: 600 }}>Free</span>
                      : <span style={{ color: DARK, fontWeight: 600 }}>{formatPrice(previewDelivery as number)}</span>}
                </div>
              )}
              {/* Tips */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>Tips</div>
                <div style={{ display: 'flex', gap: 5 }}>
                  {[10, 15, 20].map(pct => (
                    <button key={pct} onClick={() => { setTipPct(pct); setTipOther(false); setTipCustomInput('') }} style={{
                      flex: 1, padding: '6px 4px', borderRadius: 7, cursor: 'pointer', fontFamily: F, fontSize: 12,
                      border: `1.5px solid ${!tipOther && activeTip === pct ? BLUE : '#e8e8e8'}`,
                      background: !tipOther && activeTip === pct ? '#EEF0FD' : '#fff',
                      color: !tipOther && activeTip === pct ? BLUE : '#666',
                      fontWeight: !tipOther && activeTip === pct ? 700 : 500,
                    }}>{pct}%</button>
                  ))}
                  <button onClick={() => { setTipOther(true); setTipPct(null) }} style={{
                    flex: 1, padding: '6px 4px', borderRadius: 7, cursor: 'pointer', fontFamily: F, fontSize: 12,
                    border: `1.5px solid ${tipOther ? BLUE : '#e8e8e8'}`,
                    background: tipOther ? '#EEF0FD' : '#fff',
                    color: tipOther ? BLUE : '#666',
                    fontWeight: tipOther ? 700 : 500,
                  }}>Other</button>
                </div>
                {tipOther && (
                  <div style={{ position: 'relative', marginTop: 8 }}>
                    <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: '#888', pointerEvents: 'none' as const }}>$</span>
                    <input
                      type="number" min="0" step="0.01"
                      value={tipCustomInput}
                      onChange={e => {
                        const val = e.target.value
                        setTipCustomInput(val)
                        const dollars = parseFloat(val) || 0
                        setTipPct(subtotal > 0 ? (dollars / subtotal) * 100 : 0)
                      }}
                      placeholder="0.00"
                      style={{ width: '100%', padding: '9px 10px 9px 24px', border: `1.5px solid ${BLUE}`, borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' as const }}
                    />
                  </div>
                )}
                {tipAmt > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 8 }}>
                    <span style={{ color: '#888' }}>Tip amount</span>
                    <span style={{ color: DARK, fontWeight: 600 }}>{formatPrice(tipAmt)}</span>
                  </div>
                )}
              </div>
              {/* Total — shown once FM has priced the order (or while it's loading).
                  Built from FM's parts + the live tip, so it tracks tip changes. */}
              {(previewLoading || previewTotal != null) && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1.5px solid #ebebeb', paddingTop: 12, marginBottom: 14, fontSize: 15, fontWeight: 800, color: DARK }}>
                  <span>Total</span>
                  {previewLoading
                    ? priceSkeleton
                    : <span>{formatPrice(Math.max(0, (previewTotal as number) - (summaryPromo?.discountAmount ?? 0)))}</span>}
                </div>
              )}
              {/* Below-min warning */}
              {belowMin && (
                <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '8px 12px', marginBottom: 4, fontSize: 12, color: '#92400E' }}>
                  {formatPrice(minOrder - subtotal)} more to meet the {formatPrice(minOrder)} minimum
                </div>
              )}
              {/* Order fallback (no fmRef): ordering can't be resolved for this
                  restaurant, so show a friendly message + a browse link rather than
                  a dead-end order button. Never hand off to familymeal.com. */}
              {!fmRef && (
                <div style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: 13, color: '#666', margin: '0 0 10px', lineHeight: 1.5 }}>
                    This restaurant&apos;s ordering isn&apos;t available right now.
                  </p>
                  <a href="/fullmap"
                    style={{ display: 'block', textAlign: 'center', padding: '13px', background: BLUE, color: '#fff', borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none', fontFamily: F }}>
                    Browse other restaurants →
                  </a>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      {/* Direct Entry banner — full-width, dark, above everything. Makes it
          unmistakable that staff are placing on behalf of a customer. */}
      {isDirectEntry && (
        <div style={{ background: DARK, color: '#fff', padding: '10px 20px', textAlign: 'center', fontFamily: F, fontSize: 13.5, fontWeight: 600, letterSpacing: '0.02em' }}>
          <span style={{ fontWeight: 800, marginRight: 8 }}>DIRECT ENTRY</span>
          <span style={{ opacity: 0.85, fontWeight: 500 }}>
            Placing order on behalf of customer{directEntryMethod === 'invoice' ? ' — Invoice (payment link by email)' : ' — Card payment'}
          </span>
        </div>
      )}
      {!embedded && (isFirstParty ? (
        <>
          {/* 1P direct-order header: a clean bar with NO logo and NO
              marketplace/discovery navigation (restaurants embed this link on
              their own site). Auth is kept so the checkout login flow works —
              CheckoutDrawer calls openAuthModal, which needs this AuthModal
              rendered. */}
          <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '9px 18px', minHeight: 34, boxSizing: 'border-box', borderBottom: '1px solid #f0f0f0', background: 'linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff', position: 'sticky', top: 0, zIndex: 200 }}>
            {!authLoading && (user
              ? <UserMenu />
              : <button onClick={() => openAuthModal(undefined, 'login')} style={{ padding: '7px 16px', borderRadius: 999, border: '1.5px solid #1A1028', background: 'transparent', color: '#1A1028', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Log In</button>
            )}
          </header>
          <AuthModal isOpen={authModalOpen} onClose={closeAuthModal} defaultTab={authModalDefaultTab} />
          {/* Subtle attribution badge — 1P pages only. No link, no hover. */}
          <div style={{ position: 'fixed', bottom: 16, left: 16, zIndex: 300, background: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.12)', borderRadius: 20, padding: '6px 12px', fontSize: 11, color: '#999', fontFamily: F }}>
            Powered by Disco Cater
          </div>
        </>
      ) : <GlobalHeader />)}

      {/* Date/time/pickup sticky bar — hidden in embed mode because the
          enclosing NewOrderDialog already shows the date in its top bar
          and the Order Summary right rail shows full context. */}
      {!embedded && hasSelection && (
        <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 52, zIndex: 150, boxShadow: '0 1px 0 #f0f0f0' }}>
          <div style={{ maxWidth: 1140, margin: '0 auto', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 12, height: 46 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtDateShort(selDate)}</span>
              {selTime && <><span style={{ color: '#ddd' }}>·</span><span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{formatTimeWindow(selTime, deliveryWindow, orderType === 'DELIVERY')}</span></>}
              <span style={{ color: '#ddd' }}>·</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: orderType === 'PICKUP' ? '#EEF0FD' : '#F0FDF4', color: orderType === 'PICKUP' ? INDIGO : '#166534' }}>
                {orderType === 'PICKUP' ? '🏃 Pickup' : '🚚 Delivery'}
              </span>
            </div>
            <button onClick={openMenus} style={{ padding: '6px 14px', background: 'none', border: '1.5px solid #e8e8e8', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#555', fontFamily: F }}>
              ✏️ Edit
            </button>
          </div>
        </div>
      )}

      {notices.length > 0 && (
        <div style={{ background: DARK, color: 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: 500, textAlign: 'center', padding: '8px 16px', letterSpacing: '0.03em' }}>
          {notices.join('  ·  ')}
        </div>
      )}

      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ maxWidth: 1140, margin: '0 auto', padding: '20px 24px 0' }}>
          {/* Discovery back-link — 3P marketplace only; hidden on the 1P direct page. */}
          {!isFirstParty && (
            <Link href="/fullmap" style={{ fontSize: 12, color: '#888', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 16 }}>
              ← Back to Catering Map
            </Link>
          )}
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18, position: 'relative' }}>
            <FavoriteHeart
              authGate
              size={22}
              background="rgba(255,255,255,0.92)"
              style={{ position: 'absolute', top: 0, right: 0, zIndex: 2, boxShadow: '0 1px 4px rgba(0,0,0,0.1)' }}
              restaurant={{
                key: slug || fmRef || restaurant.name,
                reference: fmRef ?? undefined,
                slug,
                name: restaurant.name,
                image: headerImg ?? undefined,
                cuisine: restaurant.cuisines?.[0] || restaurant.cuisine,
                location: restaurant.location || restaurant.address,
              }}
            />
            <div style={{ width: 80, height: 80, borderRadius: 14, overflow: 'hidden', flexShrink: 0, background: (headerImg && !headerImgError) ? '#f0f0f0' : DARK, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {headerImg && !headerImgError
                ? <img src={headerImg} alt={restaurant.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setHeaderImgError(true)} />
                : <span style={{ fontSize: 32, color: '#fff', fontWeight: 700, fontFamily: F }}>{(restaurant.name?.[0] || '·').toUpperCase()}</span>}
            </div>
            <div style={{ flex: 1 }}>
              {restaurant.isDisco && (
                <div style={{ display: 'inline-block', background: GRAD, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 20, marginBottom: 6, letterSpacing: '0.06em' }}>🪩 PREMIUM</div>
              )}
              <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>{restaurant.name}</h1>
              <div style={{ fontSize: 13, color: '#585786', marginBottom: 6 }}>📍 {restaurant.address || restaurant.location}</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {tags.map(t => <span key={t} style={{ background: '#f0f0f0', color: '#555', fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 500 }}>{t}</span>)}
                {restaurant.tags?.map(t => <span key={t} style={{ background: '#EEEDFE', color: '#3C3489', fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 500 }}>{t}</span>)}
              </div>
              {orderingPaused && (
                <div style={{ marginTop: 10, background: '#FFF4E5', border: '1px solid #FFD8A8', color: '#8A5A00', fontSize: 12.5, fontWeight: 600, padding: '9px 13px', borderRadius: 10 }}>
                  ⏸ This restaurant is not currently accepting online orders.
                </div>
              )}
              {announcement && (
                <div style={{ marginTop: 10, background: '#EEF2FF', border: '1px solid #C7D2FE', color: '#3730A3', fontSize: 12.5, padding: '9px 13px', borderRadius: 10, whiteSpace: 'pre-wrap' }}>
                  {announcement}
                </div>
              )}
              {/* 1P-only cue: confirms the restaurant is on the commission-free
                  direct link (sourceoforder FAMILYMEAL). Hidden on the 3P page. */}
              {isFirstParty && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#999', fontWeight: 500 }}>
                  Direct order — no marketplace fees
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', overflowX: 'auto', borderTop: '1px solid #f0f0f0' }}>
            {menuData.length > 0 ? menuData.map((s, i) => (
              <button key={s.menu.reference} onClick={() => setActiveMenuIdx(i)} style={{
                padding: '11px 18px', background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: activeMenuIdx === i ? 700 : 500,
                color: activeMenuIdx === i ? INDIGO : '#666',
                borderBottom: `2px solid ${activeMenuIdx === i ? INDIGO : 'transparent'}`,
                fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0, transition: 'all 0.12s',
              }}>{s.menu.name}</button>
            )) : <div style={{ padding: '11px 0', fontSize: 13, color: '#aaa' }}>Menu</div>}
          </div>
        </div>
      </div>

      {/* Two-panel body */}
      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '28px 24px 120px', display: 'flex', gap: 24, alignItems: 'flex-start' }}>

        {/* LEFT: packages — horizontal cards. overflow:hidden prevents
            any nested card or grid cell from bleeding past the column
            into the Order Summary panel on narrow widths. */}
        <div style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden' }}>
          {menuData.length === 0 ? (
            // No valid menu → informational empty state only. No "Order Catering"
            // button and no Order Summary panel (gated below) — there's nothing
            // orderable.
            <div style={{ textAlign: 'center', padding: '72px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🍽️</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#666', marginBottom: 8 }}>Menu details coming soon</div>
              <div style={{ fontSize: 14, color: '#aaa' }}>Contact the restaurant to discuss catering options</div>
            </div>
          ) : (
            <>
            {menuSearchEnabled && (
              <div style={{ position: 'relative', marginBottom: 24 }}>
                <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 14, pointerEvents: 'none' }}>🔍</span>
                <input
                  type="text"
                  value={menuSearch}
                  onChange={e => setMenuSearch(e.target.value)}
                  placeholder="Search menu items…"
                  style={{ width: '100%', height: 44, paddingLeft: 38, paddingRight: 14, border: '1.5px solid #e8e8e8', borderRadius: 10, fontSize: 14, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            )}
            {(activeSection?.categories || []).map(cat => {
              const visiblePkgs = cat.mealPackages
                .filter(p => p.available !== false)
                .filter(p => !menuQuery || `${p.name || ''} ${p.description || ''}`.toLowerCase().includes(menuQuery))
              // Hide categories with no matching items while searching.
              if (menuQuery && visiblePkgs.length === 0) return null
              return (
              <div key={cat.reference} style={{ marginBottom: 40 }}>
                {!embedded && (activeSection.categories.length > 1 || cat.name !== activeSection.menu.name) && (
                  // Plain block, not sticky. The parent column at line ~892
                  // has overflow:hidden, which breaks position:sticky —
                  // browsers apply the `top` offset without the scroll-stick
                  // behavior, shifting the header upward over the first
                  // menu card (the "Entrees over Chicken Parm" bug).
                  // Dropping sticky has no functional regression because
                  // it was never sticking anyway.
                  <div style={{ padding: '4px 0 14px', marginBottom: 4 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 800, color: DARK, margin: 0, letterSpacing: '-0.01em' }}>{cat.name}</h2>
                    {cat.description && <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>{cat.description}</p>}
                  </div>
                )}
                <div className="pkg-grid">
                  {visiblePkgs.map(pkg => {
                    const qty = cartQty(pkg.reference)
                    const imgUrl = pkg.image?.reference ? pkgImg(pkg.image.reference, 300) : null
                    const inventory = pkg.inventoryBalanceCountperTime
                    const hasModifiers = (pkg.extraItemsGroups?.length ?? 0) > 0
                    return (
                      <div key={pkg.reference} className="pkg-card" onClick={() => handleAddClick(pkg)} style={{
                        background: '#fff', borderRadius: 12,
                        border: `1px solid ${qty > 0 ? BLUE : '#f0f0f0'}`,
                        display: 'flex', flexDirection: 'row', padding: 12, gap: 12,
                        boxShadow: qty > 0 ? '0 4px 20px rgba(91,111,232,0.12)' : '0 1px 4px rgba(0,0,0,0.04)',
                        transition: 'box-shadow 0.15s, border-color 0.15s',
                        cursor: 'pointer',
                      }}>
                        {/* LEFT: text */}
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#111', marginBottom: 4, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pkg.name}</div>
                          {pkg.description && (
                            <p style={{ fontSize: 12, color: '#585786', lineHeight: 1.5, margin: '0 0 8px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
                              {pkg.description}
                            </p>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto' }}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: BLUE }}>{packagePriceLabel(pkg)}</span>
                            {pkg.serves && <><span style={{ color: '#ddd', fontSize: 14 }}>|</span><span style={{ fontSize: 12, color: '#999' }}>Serves {pkg.serves}</span></>}
                          </div>
                          {qty > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6 }}>
                              <div style={{ width: 18, height: 18, borderRadius: '50%', background: BLUE, color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{qty}</div>
                              <span style={{ fontSize: 11, color: BLUE, fontWeight: 600 }}>in order</span>
                            </div>
                          )}
                        </div>
                        {/* RIGHT: image — only rendered if image exists */}
                        {imgUrl && (
                          <div style={{ width: 100, height: 100, borderRadius: 8, overflow: 'hidden', flexShrink: 0, position: 'relative', alignSelf: 'flex-start' }}>
                            <img src={imgUrl} alt={pkg.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                            {inventory != null && inventory > 0 && (
                              <div style={{ position: 'absolute', top: 6, left: 6, background: '#EF4444', color: '#fff', borderRadius: 20, fontSize: 9, fontWeight: 700, padding: '2px 6px' }}>{inventory} left</div>
                            )}
                            {qty > 0 && (
                              <div style={{ position: 'absolute', top: 6, right: 6, background: BLUE, color: '#fff', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800 }}>{qty}</div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
              )
            })}
            </>
          )}
        </div>

        {/* RIGHT: sticky cart — explicit flex basis so it can't expand
            and push the left column out from under it. Hidden after
            hydration on mobile viewports (see isMobileViewport). */}
        {isMobileViewport !== true && menuData.length > 0 && (
        <div className="order-sidebar" style={{ flex: '0 0 340px', width: 340 }}>
          <div style={{ position: 'sticky', top: hasSelection ? 106 : 68 }}>
            <div style={{ background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', boxShadow: '0 4px 24px rgba(0,0,0,0.06)', maxHeight: 'calc(100vh - 160px)', overflowY: 'auto', marginBottom: cart.length > 0 && fmRef ? 10 : 0 }}>
              <div style={{ padding: '16px 16px 14px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div>
                <div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div>
              </div>
              {cartPanel}
            </div>
            {/* CHECKOUT button — outside the card */}
            {fmRef && (
              <button
                onClick={() => startCheckout(false)}
                disabled={!canCheckout}
                onMouseOver={e => { if (canCheckout) e.currentTarget.style.background = '#4A5FD4' }}
                onMouseOut={e => { if (canCheckout) e.currentTarget.style.background = '#5B6FE8' }}
                style={{ width: '100%', padding: '15px 18px', border: 'none', borderRadius: 12, background: canCheckout ? '#5B6FE8' : '#e0e0e0', color: canCheckout ? '#fff' : '#bbb', fontSize: 14, fontWeight: 700, fontFamily: F, cursor: canCheckout ? 'pointer' : 'default', textAlign: 'center', boxShadow: canCheckout ? '0 4px 16px rgba(91,111,232,0.28)' : 'none', transition: 'all 0.15s' }}>
                {ctaLabel}
              </button>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Mobile bottom bar — hidden after hydration on desktop viewports, and
          hidden entirely when there's no valid menu (nothing to order). */}
      {isMobileViewport !== false && menuData.length > 0 && (
      <div className="mobile-order-bar" style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, padding: '12px 16px', background: '#fff', borderTop: '1px solid #f0f0f0', boxShadow: '0 -4px 16px rgba(0,0,0,0.06)', zIndex: 100 }}>
        <button onClick={() => setMobileCartOpen(true)}
          onMouseOver={e => { if (cartCount > 0) e.currentTarget.style.background = '#4A5FD4' }}
          onMouseOut={e => { if (cartCount > 0) e.currentTarget.style.background = '#5B6FE8' }}
          style={{ width: '100%', padding: '14px', background: cartCount > 0 ? '#5B6FE8' : '#e8e8e8', color: cartCount > 0 ? '#fff' : '#bbb', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: cartCount > 0 ? '0 4px 14px rgba(91,111,232,0.28)' : 'none' }}>
          {ctaLabel}
        </button>
      </div>
      )}

      {mobileCartOpen && (
        <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 600, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1, flexShrink: 0 }}>
            <div><div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div><div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div></div>
            <button onClick={() => setMobileCartOpen(false)} style={{ background: '#f0f0f0', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {cartPanel}
          </div>
          {fmRef && (
            <div style={{ padding: '12px 16px', borderTop: '1px solid #f0f0f0', background: '#fff', flexShrink: 0 }}>
              <button
                onClick={() => startCheckout(true)}
                disabled={!canCheckout}
                onMouseOver={e => { if (canCheckout) e.currentTarget.style.background = '#4A5FD4' }}
                onMouseOut={e => { if (canCheckout) e.currentTarget.style.background = '#5B6FE8' }}
                style={{ width: '100%', padding: '15px 18px', border: 'none', borderRadius: 12, background: canCheckout ? '#5B6FE8' : '#e0e0e0', color: canCheckout ? '#fff' : '#bbb', fontSize: 14, fontWeight: 700, fontFamily: F, cursor: canCheckout ? 'pointer' : 'default', textAlign: 'center', boxShadow: canCheckout ? '0 4px 16px rgba(91,111,232,0.28)' : 'none', transition: 'all 0.15s' }}>
                {ctaLabel}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Menus Modal ────────────────────────────────────────────────────── */}
      {menusOpen && (
        <div onClick={closeMenus}
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,0,20,0.55)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 500, maxHeight: 'min(90vh, 600px)', overflowY: 'auto' }}>

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 16px', borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: DARK, letterSpacing: '-0.02em' }}>Menus</div>
              <button onClick={closeMenus} style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>×</button>
            </div>

            {/* Menu list — scrollable, capped height */}
            <div style={{ overflowY: 'auto', maxHeight: 270, borderBottom: '1px solid #f0f0f0' }}>
              {menuData.map((s, i) => {
                const nextAvail = getMenuNextAvail(s.menu)
                const types = s.menu.settings?.menuAvailability ?? ['PICKUP', 'DELIVERY']
                const typesLabel = types.map(t => t === 'PICKUP' ? 'Pickup' : 'Delivery').join(' & ')
                const isSel = tempMenuIdx === i
                return (
                  <div key={s.menu.reference}>
                    <div onClick={() => selectMenuInModal(i)}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 20px', cursor: 'pointer', background: isSel ? '#fafafa' : '#fff', transition: 'background 0.1s' }}>
                      {menuData.length > 1 && (
                        <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${isSel ? DARK : '#ccc'}`, background: isSel ? DARK : '#fff', flexShrink: 0, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.12s' }}>
                          {isSel && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />}
                        </div>
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 2 }}>
                          {s.menu.name}
                          {typesLabel && <span style={{ fontSize: 12, color: '#888', fontWeight: 400, marginLeft: 6 }}>({typesLabel})</span>}
                        </div>
                        {nextAvail && <div style={{ fontSize: 12, color: '#999' }}>{nextAvail}</div>}
                      </div>
                    </div>
                    {i < menuData.length - 1 && <div style={{ height: 1, background: '#f0f0f0', margin: '0 20px' }} />}
                  </div>
                )
              })}
            </div>

            {/* Pickup / Delivery toggle */}
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ display: 'flex', border: '1.5px solid #e0e0e0', borderRadius: 10, overflow: 'hidden' }}>
                {(['PICKUP', 'DELIVERY'] as const).map(type => {
                  const enabled = mMenuAvail.includes(type)
                  const active = tempType === type
                  return (
                    <button key={type} onClick={() => { if (enabled) setTempType(type) }}
                      style={{ flex: 1, height: 40, background: active ? DARK : '#fff', color: active ? '#fff' : enabled ? '#444' : '#ccc', border: 'none', cursor: enabled ? 'pointer' : 'default', fontFamily: F, fontSize: 14, fontWeight: active ? 700 : 500, transition: 'all 0.12s' }}>
                      {type === 'PICKUP' ? 'Pickup' : 'Delivery'}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Delivery address — only when Delivery selected */}
            {tempType === 'DELIVERY' && (
              <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <span style={{ position: 'absolute', left: 10, fontSize: 15, pointerEvents: 'none' }}>🔍</span>
                  <input
                    ref={addrInputRef}
                    type="text"
                    value={deliveryAddrLine}
                    onChange={e => { setDeliveryAddrLine(e.target.value); setAddrValidated(false); setAddrError('') }}
                    placeholder="Enter delivery address..."
                    style={{ width: '100%', height: 40, paddingLeft: 34, paddingRight: addrValidated ? 32 : addrValidating ? 32 : 10, border: `1.5px solid ${addrValidated ? '#22C55E' : addrError ? '#EF4444' : '#e8e8e8'}`, borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }}
                  />
                  {addrValidating && <span style={{ position: 'absolute', right: 10, fontSize: 12, color: '#888' }}>…</span>}
                  {addrValidated && !addrValidating && <span style={{ position: 'absolute', right: 10, color: '#22C55E', fontSize: 16, fontWeight: 700 }}>✓</span>}
                </div>
                {addrError && <div style={{ fontSize: 12, color: '#EF4444', marginTop: 5 }}>{addrError}</div>}
                {addrValidated && (addrFee != null
                  ? <div style={{ fontSize: 12, color: '#22C55E', marginTop: 5 }}>Delivery fee: {formatPrice(addrFee)}</div>
                  : <div style={{ fontSize: 12, color: '#888', marginTop: 5 }}>Delivery fee calculated at checkout</div>
                )}
                {/* Apt/suite (line 2) + delivery instructions — optional, no re-validation needed. */}
                <input
                  value={deliveryAddr2}
                  onChange={e => setDeliveryAddr2(e.target.value)}
                  placeholder="Apt, suite, floor (optional)"
                  style={{ width: '100%', height: 38, marginTop: 8, padding: '0 10px', border: '1.5px solid #e8e8e8', borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }}
                />
                <input
                  value={deliveryInstr}
                  onChange={e => setDeliveryInstr(e.target.value)}
                  placeholder="Delivery instructions (optional)"
                  style={{ width: '100%', height: 38, marginTop: 6, padding: '0 10px', border: '1.5px solid #e8e8e8', borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            )}

            {/* Hard cutoff passed (or nothing bookable) → ordering closed */}
            {mMenuClosed && (
              <div style={{ margin: '14px 20px 0', padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 13, color: '#B91C1C', fontWeight: 600 }}>
                Ordering for this menu has closed.
              </div>
            )}

            {/* Date + Time row */}
            <div style={{ padding: '14px 20px 10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, opacity: mMenuClosed ? 0.5 : 1, pointerEvents: mMenuClosed ? 'none' : 'auto' }}>
              <div>
                <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Date</div>
                <button ref={dateButtonRef} onClick={openCalendar}
                  style={{ width: '100%', height: 40, border: `1.5px solid ${calOpen ? BLUE : '#e8e8e8'}`, borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: F, fontSize: 13, textAlign: 'left', padding: '0 10px', color: tempDate ? DARK : '#bbb', display: 'flex', alignItems: 'center', gap: 6, transition: 'border-color 0.12s' }}>
                  <span style={{ flexShrink: 0 }}>📅</span>
                  <span>{tempDate ? fmtDateMD(tempDate) : 'Select date'}</span>
                </button>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Time</div>
                <select value={tempTime} onChange={e => setTempTime(e.target.value)}
                  style={{ width: '100%', height: 40, border: '1.5px solid #e8e8e8', borderRadius: 8, padding: '0 10px', fontSize: 13, color: tempTime ? DARK : '#aaa', fontFamily: F, background: '#fff', cursor: 'pointer', outline: 'none' }}>
                  <option value="">Select time</option>
                  {mModalTimes.map(t => <option key={t} value={t}>{formatTimeWindow(t, deliveryWindow, tempType === 'DELIVERY')}</option>)}
                </select>
              </div>
            </div>

            {/* Headcount — optional */}
            <div style={{ padding: '6px 20px 14px', borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
                Headcount <span style={{ color: '#bbb', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· optional</span>
              </div>
              <input
                type="number" inputMode="numeric" min={1}
                value={tempHeadcount}
                onChange={e => setTempHeadcount(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="e.g. 40"
                style={{ width: '100%', height: 40, border: '1.5px solid #e8e8e8', borderRadius: 8, padding: '0 10px', fontSize: 13, color: DARK, fontFamily: F, background: '#fff', outline: 'none' }}
              />
            </div>

            {/* Start Order CTA */}
            <div style={{ padding: '14px 20px 20px' }}>
              <button onClick={startOrder} disabled={!canStartOrder}
                style={{ width: '100%', height: 48, background: canStartOrder ? DARK : '#e0e0e0', color: canStartOrder ? '#fff' : '#bbb', border: 'none', borderRadius: 24, fontSize: 15, fontWeight: 700, cursor: canStartOrder ? 'pointer' : 'default', fontFamily: F, transition: 'all 0.15s', boxShadow: canStartOrder ? '0 4px 14px rgba(26,16,40,0.22)' : 'none' }}>
                Start Order
              </button>
              {hasSelection && (
                <button onClick={() => {
                  const pending = pendingItemRef.current
                  if (pending) { pendingItemRef.current = null; handleAddClickInner(pending) }
                  closeMenus()
                }} style={{ display: 'block', width: '100%', textAlign: 'center', marginTop: 10, padding: '8px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#aaa', fontFamily: F }}>
                  Keep current selection
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Calendar popover — fixed position, outside modal DOM ──────────── */}
      {calOpen && calPos && (
        <>
          <div onClick={() => setCalOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 800 }} />
          <div onClick={e => e.stopPropagation()}
            style={{ position: 'fixed', top: calPos.top, left: calPos.left, width: 288, background: '#fff', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', border: '1px solid #e8e8e8', padding: '12px 14px', zIndex: 900 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <button onClick={prevMonth} style={{ width: 28, height: 28, borderRadius: 7, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: DARK, fontFamily: F }}>‹</button>
              <span style={{ fontSize: 13, fontWeight: 700, color: DARK, fontFamily: F }}>{MONTH_NAMES[calMonth]} {calYear}</span>
              <button onClick={nextMonth} style={{ width: 28, height: 28, borderRadius: 7, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: DARK, fontFamily: F }}>›</button>
            </div>
            <MonthCalendar year={calYear} month={calMonth} availSet={mAvailSet} todayIso={todayIso} selDate={tempDate} onSelect={handleDateSelect} />
          </div>
        </>
      )}

      {/* ── Checkout Drawer ────────────────────────────────────────────────── */}
      {checkoutOpen && fmRef && (
        <CheckoutDrawer
          fmRef={fmRef} fmSlug={fmSlug} restaurantName={restaurant.name}
          cart={cart} selDate={selDate} selTime={selTime} orderType={orderType}
          deliveryOrderTimeWindows={deliveryWindow}
          includeUtensils={includeUtensils}
          addr={addr} subtotal={subtotal} tipAmt={tipAmt} svcAmt={svcAmt} serviceChargePct={svcPct} minOrder={minOrder}
          headcount={headcount} onHeadcount={setHeadcount}
          menuReference={menuData[activeMenuIdx]?.menu?.reference ?? null}
          isFirstParty={isFirstParty}
          isDirectEntry={isDirectEntry}
          directEntryMethod={directEntryMethod}
          onChangeAddress={() => { setCheckoutOpen(false); openMenus() }}
          onPromoChange={setSummaryPromo}
          onClose={() => setCheckoutOpen(false)}
        />
      )}

      {/* ── Add-ons / Modifiers Modal ──────────────────────────────────────── */}
      {addOnsPkg && (
        <div onClick={() => setAddOnsPkg(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,0,20,0.55)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 32px 80px rgba(0,0,0,0.22)' }}>
            {addOnsPkg.image?.reference && (
              <div style={{ height: 140, background: 'linear-gradient(135deg,#f4f4fb,#eaeaf6)', overflow: 'hidden', borderRadius: '20px 20px 0 0', flexShrink: 0 }}>
                <img src={pkgImg(addOnsPkg.image.reference, 550)} alt={addOnsPkg.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
              </div>
            )}
            <div style={{ padding: '18px 22px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: DARK, letterSpacing: '-0.02em', marginBottom: 4 }}>{addOnsPkg.name}</div>
                {addOnsPkg.description && (
                  <p style={{ fontSize: 13, color: '#585786', lineHeight: 1.55, margin: '0 0 4px' }}>{addOnsPkg.description}</p>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: BLUE }}>{packagePriceLabel(addOnsPkg)}</span>
                  {addOnsPkg.serves && <><span style={{ color: '#ddd' }}>|</span><span style={{ fontSize: 12, color: '#999' }}>Serves {addOnsPkg.serves}</span></>}
                </div>
              </div>
              <button onClick={() => setAddOnsPkg(null)} style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginLeft: 12 }}>×</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '16px 22px', flex: 1 }}>
              {(addOnsPkg.extraItemsGroups ?? []).map(group => {
                const total = groupTotal(group)
                const isRequired = group.minSelectedItems > 0
                const isFull = total >= group.maxSelectedItems
                const isValid = isGroupValid(group)
                return (
                  <div key={group.reference} style={{ marginBottom: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div>
                        <span style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{group.externalName || group.name}</span>
                        {isRequired
                          ? <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#E76F51', letterSpacing: '0.04em' }}>REQUIRED</span>
                          : <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#22C55E', letterSpacing: '0.04em' }}>OPTIONAL</span>}
                      </div>
                      <span style={{ fontSize: 12, color: isValid ? '#22C55E' : '#aaa', fontWeight: 600 }}>{total} of {group.maxSelectedItems} selected</span>
                    </div>
                    {group.minSelectedItems > 0 && (
                      <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
                        Select {group.minSelectedItems === group.maxSelectedItems ? `exactly ${group.minSelectedItems}` : `${group.minSelectedItems}–${group.maxSelectedItems}`}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {group.addOns.map(addOn => {
                        const qty = selAddOns[group.reference]?.[addOn.reference] ?? 0
                        return (
                          <div key={addOn.reference} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${qty > 0 ? BLUE : '#e8e8e8'}`, background: qty > 0 ? '#EEF0FD' : '#fff', transition: 'all 0.12s' }}>
                            <div>
                              <span style={{ fontSize: 14, color: DARK, fontWeight: qty > 0 ? 600 : 400 }}>{addOn.name}</span>
                              {addOn.price > 0 && <span style={{ fontSize: 12, color: BLUE, fontWeight: 700, marginLeft: 8 }}>+{formatPrice(addOn.price)}</span>}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                              {qty > 0 && <button onClick={() => setAddOnQty(group.reference, addOn.reference, -1, group.maxSelectedItems)} style={{ width: 26, height: 26, borderRadius: 7, border: `1.5px solid ${BLUE}`, background: '#fff', cursor: 'pointer', fontSize: 14, color: BLUE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>}
                              {qty > 0 && <span style={{ fontSize: 14, fontWeight: 800, color: BLUE, minWidth: 18, textAlign: 'center' }}>{qty}</span>}
                              <button onClick={() => { if (!isFull) setAddOnQty(group.reference, addOn.reference, 1, group.maxSelectedItems) }} disabled={isFull}
                                style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: isFull ? '#f0f0f0' : BLUE, cursor: isFull ? 'default' : 'pointer', fontSize: 14, color: isFull ? '#bbb' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {addOnsPkg.allowedSpecialInstructions && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 6 }}>Special Instructions</div>
                  <textarea value={addOnsNote} onChange={e => setAddOnsNote(e.target.value)} placeholder="Allergies, dietary restrictions, requests…" rows={3}
                    style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e8e8e8', borderRadius: 10, fontSize: 13, fontFamily: F, color: DARK, resize: 'vertical', outline: 'none', boxSizing: 'border-box' }} />
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: DARK }}>Quantity</span>
                <button onClick={() => setAddOnsQty(q => Math.max(1, q - 1))} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 16, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                <span style={{ fontSize: 15, fontWeight: 700, color: DARK, minWidth: 24, textAlign: 'center' }}>{addOnsQty}</span>
                <button onClick={() => setAddOnsQty(q => q + 1)} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 16, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
              </div>
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #f0f0f0', flexShrink: 0 }}>
              <button onClick={confirmAddOns} disabled={!canConfirmAddOns()}
                style={{ width: '100%', padding: '13px', background: canConfirmAddOns() ? BLUE : '#e8e8e8', color: canConfirmAddOns() ? '#fff' : '#bbb', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: canConfirmAddOns() ? 'pointer' : 'default', fontFamily: F, boxShadow: canConfirmAddOns() ? '0 4px 14px rgba(91,111,232,0.25)' : 'none', transition: 'all 0.15s' }}>
                Add to Order — {formatPrice(addOnsRunningPrice())}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        @keyframes pricingPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .pkg-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .pkg-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.09) !important; }
        input:focus, textarea:focus, select:focus { border-color: ${BLUE} !important; box-shadow: 0 0 0 3px rgba(91,111,232,0.1) !important; }
        .pac-container { z-index: 999 !important; font-family: 'DM Sans', sans-serif !important; }
        @media (max-width: 900px) {
          .order-sidebar { display: none !important; }
          .mobile-order-bar { display: block !important; }
        }
        @media (max-width: 768px) {
          .pkg-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* Reorder feedback toast */}
      {reorderToast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: DARK, color: '#fff', padding: '12px 20px', borderRadius: 12, fontSize: 13, fontWeight: 600, fontFamily: F, zIndex: 900, boxShadow: '0 8px 24px rgba(0,0,0,0.2)', maxWidth: 'calc(100vw - 32px)', textAlign: 'center' }}>
          {reorderToast}
        </div>
      )}

      {/* Mode 2 — menu advisor (collapsed gold pill, bottom-right) */}
      <MenuAdvisor
        restaurant={{
          name: restaurant.name,
          cuisine: restaurant.cuisines?.[0] || restaurant.cuisine,
          location: restaurant.location || restaurant.address,
        }}
        intake={discoIntake}
      />
    </div>
  )
}
