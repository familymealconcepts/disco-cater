// THE SINGLE PLACE THAT DECIDES HOW A FULFILLMENT DATE AND TIME RELATE VISUALLY.
//
// The date is dominant; the time is secondary. That is a product decision, and it
// only holds if it lives in one place — before this, five React surfaces each
// expressed the pairing independently and they had drifted to four different
// answers, including one that was fully inverted (the portal Orders list rendered
// the TIME at 16px/700 above the DATE at 12px/600). Consolidating is as much the fix
// as the restyle.
//
// TAKES PRE-FORMATTED STRINGS, deliberately. Each surface formats differently and
// correctly — the customer page uses a short weekday form, the portal a longer one,
// and the TIME is frequently a window range produced by formatTimeWindow (a delivery
// order shows "12:00 PM - 12:30 PM", not an instant). Owning the formatting here
// would either flatten those differences or re-implement them. This component owns
// HIERARCHY, not formatting — that is the seam.
//
// NOT used by the order confirmation email or the order PDF: those render HTML
// strings and pdf-lib primitives respectively and cannot mount React. They carry the
// same hierarchy applied by hand, and the intent is documented at each.
import React from 'react'

const DARK = '#1A1028'
const MUTED = '#6E6684'

/**
 * `inline`  — date · time on one line. The default, and what most surfaces do.
 * `stacked` — date above time. Used where vertical space is the constraint
 *             (a table cell), never as a restyle of a surface that is inline today.
 * `cells`   — two labelled grid cells, each with its own uppercase caption. The
 *             confirmation page's shape; renders a fragment of two <div>s so the
 *             caller's own grid keeps ownership of columns and borders.
 */
export type FulfillmentDateTimeVariant = 'inline' | 'stacked' | 'cells'
export type FulfillmentDateTimeScale = 'sm' | 'md' | 'lg'

// Date size/weight always exceeds the time's. The gap is what carries the meaning,
// so the pairs move together and neither is set independently at a call site.
const SCALE: Record<FulfillmentDateTimeScale, { d: number; t: number; dw: number; tw: number }> = {
  sm: { d: 13, t: 11.5, dw: 800, tw: 600 },
  md: { d: 15, t: 12.5, dw: 800, tw: 600 },
  lg: { d: 16.5, t: 13, dw: 700, tw: 600 },
}

export interface FulfillmentDateTimeProps {
  /** Pre-formatted date, e.g. "Wed, Sep 2". Nothing renders when empty. */
  date?: string | null
  /** Pre-formatted time or window, e.g. "12:00 PM" / "12:00 PM - 12:30 PM". */
  time?: string | null
  variant?: FulfillmentDateTimeVariant
  scale?: FulfillmentDateTimeScale
  /**
   * Overrides BOTH colours. Exists for the portal Orders list, where statusColor()
   * returns green when an order is due within the hour and red once its time has
   * passed — that cell doubles as the urgency signal, so the colour is load-bearing
   * and must survive any type change here.
   */
  color?: string | null
  /** Inline variant only. */
  separator?: string
  /** Cells variant only — the uppercase captions. */
  dateLabel?: string
  timeLabel?: string
  style?: React.CSSProperties
}

const capStyle: React.CSSProperties = {
  fontSize: 11, color: '#aaa', fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4,
}

export function FulfillmentDateTime({
  date,
  time,
  variant = 'inline',
  scale = 'md',
  color,
  separator = '·',
  dateLabel = 'Date',
  timeLabel = 'Time',
  style,
}: FulfillmentDateTimeProps) {
  const s = SCALE[scale]
  const hasDate = !!(date && String(date).trim())
  const hasTime = !!(time && String(time).trim())
  if (!hasDate && !hasTime) return null

  const dateStyle: React.CSSProperties = { fontSize: s.d, fontWeight: s.dw, color: color || DARK, letterSpacing: '-0.01em' }
  const timeStyle: React.CSSProperties = { fontSize: s.t, fontWeight: s.tw, color: color || MUTED }

  if (variant === 'cells') {
    return (
      <>
        {hasDate && (
          <div style={{ padding: '16px 20px', borderRight: '1px solid #f8f8f8', ...style }}>
            <div style={capStyle}>{dateLabel}</div>
            <div style={dateStyle}>{date}</div>
          </div>
        )}
        {hasTime && (
          <div style={{ padding: '16px 20px', ...style }}>
            <div style={capStyle}>{timeLabel}</div>
            <div style={timeStyle}>{time}</div>
          </div>
        )}
      </>
    )
  }

  if (variant === 'stacked') {
    return (
      <div style={style}>
        {hasDate && <div style={{ ...dateStyle, lineHeight: 1.25 }}>{date}</div>}
        {hasTime && <div style={{ ...timeStyle, marginTop: 1 }}>{time}</div>}
      </div>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, ...style }}>
      {hasDate && <span style={dateStyle}>{date}</span>}
      {hasDate && hasTime && <span aria-hidden style={{ color: '#ddd', fontSize: s.t }}>{separator}</span>}
      {hasTime && <span style={timeStyle}>{time}</span>}
    </span>
  )
}
