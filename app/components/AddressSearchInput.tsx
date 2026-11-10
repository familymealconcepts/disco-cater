'use client'
import { useEffect, useRef, useState } from 'react'
import { loadGooglePlaces, onGooglePlacesAuthFailure } from '../../lib/google-places-loader'
import { placeToAddressParts, type PickedPlace, type PlaceResultLike } from '../../lib/address-pick'

/**
 * A text input with Google Places address search (US street addresses).
 *
 * Typing works exactly like a plain input — `onChange` gets every keystroke, so
 * an address Google doesn't know can still be entered by hand. Choosing a
 * suggestion calls `onPick` with line 1 / city / state / zip and the pin.
 *
 * If the Maps script or the key fails, the field simply stays a plain input
 * (a rejected key remounts it so Google's disabled "Oops" state never shows).
 * Address line 2 is deliberately NOT this component: it stays free text.
 */

type Autocomplete = { addListener: (e: string, cb: () => void) => { remove: () => void }; getPlace: () => PlaceResultLike }
type GoogleNS = {
  maps: {
    places: { Autocomplete: new (el: HTMLInputElement, opts: Record<string, unknown>) => Autocomplete }
    event: { clearInstanceListeners: (o: unknown) => void }
  }
}

export default function AddressSearchInput({
  id, name, value, onChange, onPick, placeholder, style, disabled,
}: {
  id?: string
  name?: string
  value: string
  onChange: (text: string) => void
  onPick: (place: PickedPlace) => void
  placeholder?: string
  style?: React.CSSProperties
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [failed, setFailed] = useState(false)
  // Latest callbacks without re-binding the widget on every render.
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  useEffect(() => onGooglePlacesAuthFailure(() => setFailed(true)), [])

  useEffect(() => {
    if (failed || disabled) return
    let cancelled = false
    let ac: Autocomplete | null = null
    let listener: { remove: () => void } | null = null
    loadGooglePlaces().then(ok => {
      const el = inputRef.current
      const g = (window as unknown as { google?: GoogleNS }).google
      if (cancelled || !ok || !el || !g?.maps?.places) return
      try {
        ac = new g.maps.places.Autocomplete(el, {
          componentRestrictions: { country: 'us' },
          types: ['address'],
          fields: ['address_components', 'geometry'],
        })
        listener = ac.addListener('place_changed', () => {
          const parts = placeToAddressParts(ac?.getPlace())
          // No usable street + pin (Enter without choosing, or a non-street
          // result): leave whatever was typed — that is manual entry.
          if (parts) onPickRef.current(parts)
        })
      } catch { /* plain input */ }
    })
    return () => {
      cancelled = true
      listener?.remove()
      const g = (window as unknown as { google?: GoogleNS }).google
      if (ac && g?.maps?.event) { try { g.maps.event.clearInstanceListeners(ac) } catch { /* ignore */ } }
    }
  }, [failed, disabled])

  return (
    <>
      {/* Google's suggestion list is appended to <body>; keep it above dialogs. */}
      <style>{'.pac-container{z-index:100000 !important;font-family:\'DM Sans\',sans-serif}'}</style>
      <input
        key={failed ? 'plain' : 'search'}
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        // Google sets autocomplete=off itself; this keeps the browser's own
        // address autofill from stacking a second dropdown on top.
        autoComplete="off"
        value={value}
        onChange={e => onChange(e.target.value)}
        // Enter picks a suggestion instead of submitting a surrounding form.
        onKeyDown={e => { if (e.key === 'Enter' && document.querySelector('.pac-container .pac-item-selected')) e.preventDefault() }}
        placeholder={placeholder}
        disabled={disabled}
        style={style}
      />
    </>
  )
}
