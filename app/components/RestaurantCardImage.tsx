'use client'
import { sizedImage } from '../../lib/sanity-image'

// A restaurant list/card image slot that degrades cleanly. Renders a plain neutral
// box sized by `style`; the image overlays it and, if the image is absent OR fails
// to load (e.g. an expired Google Places `place-photos` URL), the neutral box shows
// through — no icon, no text, no browser broken-image glyph. It reads as
// intentionally empty, not broken. No React state needed: onError simply hides the
// <img> so the background box remains. `style` should carry the slot's dimensions
// (width/height/borderRadius/flexShrink) so the placeholder matches the card.
export function RestaurantCardImage({
  src, w, h, alt, style,
}: {
  src?: string | null
  w: number
  h: number
  alt?: string
  style?: React.CSSProperties
}) {
  return (
    <div aria-hidden style={{ background: '#efece6', overflow: 'hidden', ...style }}>
      {src ? (
        <img
          src={sizedImage(src, w, h)}
          alt={alt || ''}
          loading="lazy"
          decoding="async"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : null}
    </div>
  )
}
