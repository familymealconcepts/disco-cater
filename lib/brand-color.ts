// Derives a restaurant "brand" header gradient from an uploaded image (logo first,
// marketplace photo second). Server-only: uses sharp (already installed via Next)
// to read pixels — no new heavy dependency. The heuristic ignores background and
// greyscale pixels (near-white/near-black/low-saturation) so a logo on a white
// card still yields its real brand color, then synthesizes a 2-stop gradient from
// that single color. Returns null when no usable color is found (e.g. a pure
// black/white/greyscale logo) so callers can fall back to the generic gradient.

import sharp from 'sharp'

export interface Rgb { r: number; g: number; b: number }
export interface GradientSpec { from: Rgb; to: Rgb; angle: number }

export function hex({ r, g, b }: Rgb): string {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h *= 60
  }
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  h = ((h % 360) + 360) % 360 / 360
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let r: number, g: number, b: number
  if (s === 0) { r = g = b = l } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3)
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }
}

/**
 * Extract a single representative saturated brand color from an image URL.
 * Buckets surviving pixels by hue, weighted toward vivid mid-tones, and returns
 * the dominant bucket's weighted-average color. null → nothing usable.
 */
export async function extractBrandColor(imageUrl: string): Promise<Rgb | null> {
  let buf: Buffer
  try {
    const res = await fetch(imageUrl)
    if (!res.ok) return null
    buf = Buffer.from(await res.arrayBuffer())
  } catch { return null }

  let data: Buffer, channels: number
  try {
    const out = await sharp(buf).resize(96, 96, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    data = out.data; channels = out.info.channels
  } catch { return null }

  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>()
  for (let i = 0; i < data.length; i += channels) {
    const a = channels === 4 ? data[i + 3] : 255
    if (a < 128) continue                              // skip transparent
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const [h, s, l] = rgbToHsl({ r, g, b })
    if (l > 0.92 || l < 0.08) continue                 // skip near-white / near-black
    if (s < 0.25) continue                             // skip greyscale/desaturated
    const key = Math.round(h / 24)                     // ~15 hue buckets
    const w = s * (1 - Math.abs(l - 0.5))              // favor saturated mid-tones
    const cur = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 }
    cur.w += w; cur.r += r * w; cur.g += g * w; cur.b += b * w
    buckets.set(key, cur)
  }
  if (!buckets.size) return null
  let best: { w: number; r: number; g: number; b: number } | null = null
  for (const v of buckets.values()) if (!best || v.w > best.w) best = v
  return { r: best!.r / best!.w, g: best!.g / best!.w, b: best!.b / best!.w }
}

/**
 * Synthesize a readable 2-stop header gradient from one brand color.
 * `hueShift` degrees for the far stop: a small shift adds depth but pushes warm
 * tones toward olive; 0 = monochromatic (same hue, just darker) which stays clean
 * on earthy photo-derived colors.
 */
export function gradientSpecFromColor(primary: Rgb, hueShift = 0): GradientSpec {
  let [h, s, l] = rgbToHsl(primary)
  s = Math.min(0.85, Math.max(0.5, s))               // keep vivid but not neon
  const l1 = Math.min(0.55, Math.max(0.42, l))       // primary stop, mid-dark for white text
  const l2 = Math.max(0.26, l1 - 0.17)               // darker far stop
  return {
    from: hslToRgb(h, s, l1),
    to: hslToRgb(h + hueShift, Math.min(0.9, s + 0.06), l2),
    angle: 120,
  }
}

export function gradientCss(g: GradientSpec): string {
  return `linear-gradient(${g.angle}deg, ${hex(g.from)} 0%, ${hex(g.to)} 100%)`
}

/** logo → marketplace photo → null. Returns the gradient CSS + the spec/primary. */
export async function brandGradient(
  sources: { iconUrl?: string | null; imageUrl?: string | null },
): Promise<{ css: string; spec: GradientSpec; primary: Rgb } | null> {
  for (const url of [sources.iconUrl, sources.imageUrl]) {
    if (!url) continue
    const primary = await extractBrandColor(url)
    if (primary) {
      const spec = gradientSpecFromColor(primary)
      return { css: gradientCss(spec), spec, primary }
    }
  }
  return null
}
