// "Did you mean name@gmail.com?" for a DINER's email — checkout, sign-up.
// Client-safe (no server imports). The server half, which refuses a domain that
// cannot receive mail, is lib/diner-email-domain.ts.
//
// WHY THIS EXISTS (Peter, 27 Oct 2026). A diner signed up as …@gmail.vom on
// 25 Oct and ordered from The Speakeatery on 27 Oct (#900000693); every order
// email to them bounces. The earlier hint (lib/email-typo.ts) DID list ".vom",
// but it only ran at checkout and only after the email field was typed in — and
// a signed-in diner's email is filled in from the account, so it never showed,
// and sign-up had no hint at all.
//
// THE RULE. Only the six big providers (gmail, yahoo, hotmail, outlook, icloud,
// aol), and only a two-part domain (name.ending):
//   - right name, misspelled ending (gmail.con/.vom/.fom/.cmo/.co/.om …) → name.com
//     A real country ending (yahoo.fr, hotmail.de) is never touched.
//   - misspelled name (gmial, gmal, gnail, hotmial, outlok …) with a .com or
//     misspelled ending → the provider's .com — unless the name is about equally
//     close to two providers (hmail: gmail or hotmail?), or the domain is a real
//     mail service that happens to look similar (ymail.com, mail.com, email.com).
// A suggestion is only ever a hint; refusing is the server's job and is based on
// whether the domain can receive mail, never on this list.

const PROVIDERS = ['gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol'] as const

const BAD_ENDINGS = new Set([
  'con', 'vom', 'fom', 'cmo', 'co', 'om', 'cm', 'xom', 'ocm', 'cpm', 'comm', 'coom',
  'ccom', 'comn', 'cim', 'clm', 'cok', 'dom', 'vcom', 'xcom', 'c', 'cpom', 'coim',
])

// Real mail domains within a typo of a provider's name. Never "corrected".
const REAL_LOOKALIKES = new Set([
  'ymail.com', 'mail.com', 'email.com', 'gmx.com', 'cloud.com', 'me.com', 'mac.com',
  'live.com', 'msn.com', 'aim.com', 'aol.co.uk', 'gmail.de',
])

/** Damerau–Levenshtein (optimal string alignment) distance. */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

// How far a typed name may be from a provider's: one slip for the short names,
// two for the long ones; aol only by swapping two letters (alo, oal), since
// one-letter changes of a three-letter name hit too many real domains.
function within(name: string, provider: string): number | null {
  if (name === provider) return 0
  const dist = distance(name, provider)
  if (provider === 'aol') return dist === 1 && name.length === 3 && [...name].sort().join('') === 'alo' ? 1 : null
  const limit = provider.length >= 6 ? 2 : 1
  return dist <= limit ? dist : null
}

/** The corrected address, or null when there is nothing to suggest. */
export function suggestDinerEmail(raw: string | null | undefined): string | null {
  const email = String(raw ?? '').trim()
  const at = email.lastIndexOf('@')
  if (at <= 0) return null
  const local = email.slice(0, at)
  const domain = email.slice(at + 1).toLowerCase().replace(/\.$/, '')
  if (REAL_LOOKALIKES.has(domain)) return null
  const parts = domain.split('.')
  if (parts.length !== 2 || !parts[0]) return null
  const [name, ending] = parts
  if (ending !== 'com' && !BAD_ENDINGS.has(ending)) return null

  const close = PROVIDERS
    .map(p => ({ p, d: within(name, p) }))
    .filter((x): x is { p: typeof PROVIDERS[number]; d: number } => x.d != null)
    .sort((a, b) => a.d - b.d)
  if (!close.length) return null
  // Equally close to two providers → don't guess.
  if (close.length > 1 && close[1].d === close[0].d) return null
  // Close to one, but within reach of another too (hmail: gmail 1, hotmail 2) → don't guess.
  if (close.length > 1 && close[0].d > 0) return null
  const fixed = `${close[0].p}.com`
  return fixed === domain ? null : `${local}@${fixed}`
}
