'use client'
import { useFavorites, type FavoriteRestaurant } from '../../../../hooks/useFavorites'
import { useAuthContext } from '../../../context/AuthContext'

interface Props {
  restaurant: FavoriteRestaurant
  // Visual size — defaults to 18px which fits inline in card corners
  size?: number
  // Wrapper bg (e.g. translucent white over a photo). Defaults transparent.
  background?: string
  // Hide when no user is signed in. Reads from AuthContext (cookie-based),
  // with a localStorage fallback for code paths that don't go through it.
  authGate?: boolean
  // Optional className for layout (positioning) overrides
  className?: string
  style?: React.CSSProperties
  // Stop click bubbling into a parent card click handler
  stopPropagation?: boolean
}

export default function FavoriteHeart({
  restaurant, size = 18, background = 'transparent', authGate = false,
  className, style, stopPropagation = true,
}: Props) {
  const { isFavorited, toggleFavorite } = useFavorites()
  const { user } = useAuthContext()

  // Auth gate: hide for guests. Prefer the AuthContext user (cookie auth,
  // the live source) and only fall back to legacy localStorage if the
  // context hasn't resolved yet — otherwise cookie-only logged-in users
  // would lose the heart entirely.
  if (authGate && !user) {
    if (typeof window === 'undefined') return null
    try {
      if (!window.localStorage.getItem('disco_user') && !window.localStorage.getItem('disco_favorites_scope')) return null
    } catch { return null }
  }

  const fav = isFavorited(restaurant.key)
  const label = fav ? 'Remove from favorites' : 'Add to favorites'

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={e => {
        if (stopPropagation) { e.stopPropagation(); e.preventDefault() }
        toggleFavorite(restaurant)
      }}
      className={className}
      style={{
        background, border: 'none', cursor: 'pointer', padding: 6,
        borderRadius: '50%', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', lineHeight: 0,
        transition: 'transform 0.12s, background 0.12s',
        ...style,
      }}
      onMouseOver={e => (e.currentTarget as HTMLElement).style.transform = 'scale(1.08)'}
      onMouseOut={e => (e.currentTarget as HTMLElement).style.transform = 'scale(1)'}
    >
      <svg width={size} height={size} viewBox="0 0 24 24"
        fill={fav ? '#E24B4A' : 'none'}
        stroke={fav ? '#E24B4A' : '#1A1028'}
        strokeWidth={fav ? 1.5 : 2}
        strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>
  )
}
