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
  const { isAuthenticated, isLoading, openAuthModal } = useAuthContext()

  // Logged-in = AuthContext cookie user (live source) OR the legacy
  // localStorage 'disco_user' (fullmap header / restaurant / admin paths).
  // We deliberately do NOT treat the cached 'disco_favorites_scope' as
  // logged-in — it lingers after a cookie expires and was making the heart
  // appear (and silently guest-save) for users who are no longer signed in.
  let isAuthed = isAuthenticated
  if (!isAuthed && typeof window !== 'undefined') {
    try { isAuthed = !!window.localStorage.getItem('disco_user') } catch { isAuthed = false }
  }

  // Auth gate: hide for guests once auth has resolved. While the context is
  // still loading we keep the heart rendered so a logged-in cookie user
  // (no localStorage shadow) doesn't see it flash out.
  if (authGate && !isAuthed && !isLoading) return null

  const fav = isFavorited(restaurant.key)
  const label = fav ? 'Remove from favorites' : 'Add to favorites'

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={e => {
        if (stopPropagation) { e.stopPropagation(); e.preventDefault() }
        // Guests must sign in — never silently persist to the guest bucket.
        if (!isAuthed) { openAuthModal(undefined, 'login'); return }
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
