// WHAT A RESTAURANT CAN ACTUALLY GIVE BACK — the one place that answers it.
//
// PETER'S STANDING RULE (2 Nov 2026): every refund comes from the restaurant. Disco's
// code never funds a refund, or any part of one; if Disco is to cover a refund, Peter
// does it by hand in Stripe. So before a refund moves the customer's money, every cent
// the restaurant owes for it — the payout reversal, the refunded share of Stripe's fee,
// any shortfall — is PLANNED against a specific payout here, and the refund is refused
// whole if any of it cannot be placed. See CLAUDE.md, "EVERY REFUND COMES FROM THE
// RESTAURANT".
//
// ── WHAT STRIPE WILL REVERSE (measured live, 2 Nov 2026) ─────────────────────────────
// A transfer reversal is funded by the restaurant's AVAILABLE balance, or by that
// transfer's OWN money while it is still pending. It is NOT funded by other orders'
// pending money:
//
//   - #900000448 (The Speakeatery, 20 Oct): available $0.00, pending $1,967.25. The
//     $22.76 reversal SUCCEEDED — the reversed payout's own money was still pending
//     (available on 21 Oct).
//   - #900000748 (Gracious Bakery – Garden District, 2 Nov): available $0.00, pending
//     $109.48, all of it another order's. The $70.91 reversal FAILED with "does not
//     have sufficient funds" — this order's $635.05 payout had become available on
//     30 Oct and gone to the bank in that day's $858.58 payout. Both are Standard
//     accounts with Stripe bearing losses.
//
// The old check counted available + ALL pending, so it passed #900000748 and the
// customer was refunded before the reversal failed. Disco covered $73.11.
//
// AND STRIPE DOES NOT ALWAYS REFUSE: on an account where the platform bears losses
// (Express / Custom, controller.losses.payments = 'application') a reversal Stripe
// cannot fund still succeeds and drives the account negative — at Disco's cost. So the
// check has to refuse on its own; it cannot rely on Stripe failing.
import type Stripe from 'stripe'

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null)
const usd = (l: Array<{ amount: number; currency: string }> | undefined) =>
  (l ?? []).filter(x => x.currency === 'usd').reduce((t, x) => t + x.amount, 0)

/** This transfer's own money on the restaurant's account, while still pending (0 once available). */
async function ownPendingCents(stripe: Stripe, t: Stripe.Transfer, acct: string): Promise<number> {
  const py = idOf(t.destination_payment)
  if (!py) return 0
  const payment = await stripe.charges.retrieve(py, { expand: ['balance_transaction'] }, { stripeAccount: acct })
  const bt = payment.balance_transaction as Stripe.BalanceTransaction | string | null
  const tx = bt && typeof bt === 'object' ? bt : bt ? await stripe.balanceTransactions.retrieve(bt, {}, { stripeAccount: acct }) : null
  if (!tx || tx.available_on * 1000 <= Date.now()) return 0
  return Math.max(0, t.amount - (t.amount_reversed ?? 0))
}

/**
 * One restaurant account's reversible money, as a running ledger: what is left to
 * reverse on each payout, funded by the available balance or that payout's own
 * pending money. Plan with room()/take(); take() records what was planned, so a
 * second reversal on the same account sees what the first used.
 */
export class RestaurantFunds {
  private availLeft: number
  private pendingLeft: number
  private own = new Map<string, number>()
  private used = new Map<string, number>()
  ownPendingUsed = 0

  private constructor(private stripe: Stripe, readonly acct: string, readonly available: number, readonly pending: number) {
    this.availLeft = available
    this.pendingLeft = Math.max(0, pending)
  }

  static async read(stripe: Stripe, acct: string): Promise<RestaurantFunds> {
    const b = await stripe.balance.retrieve({}, { stripeAccount: acct })
    return new RestaurantFunds(stripe, acct, usd(b.available), usd(b.pending))
  }

  private async ownLeft(t: Stripe.Transfer): Promise<number> {
    if (!this.own.has(t.id)) this.own.set(t.id, await ownPendingCents(this.stripe, t, this.acct).catch(() => 0))
    return this.own.get(t.id) ?? 0
  }

  /** The most that can be reversed from this transfer right now, in cents. */
  async room(t: Stripe.Transfer): Promise<number> {
    const left = t.amount - (t.amount_reversed ?? 0) - (this.used.get(t.id) ?? 0)
    if (left <= 0) return 0
    const fromPending = Math.min(this.pendingLeft, await this.ownLeft(t))
    return Math.max(0, Math.min(left, this.availLeft + fromPending))
  }

  /** Record a reversal of up to `cents` from this transfer; returns what fits. Own pending money is used first. */
  async take(t: Stripe.Transfer, cents: number): Promise<number> {
    const n = Math.min(cents, await this.room(t))
    if (n <= 0) return 0
    const p = Math.min(n, this.pendingLeft, await this.ownLeft(t))
    this.pendingLeft -= p
    this.own.set(t.id, (this.own.get(t.id) ?? 0) - p)
    this.ownPendingUsed += p
    this.availLeft -= n - p
    this.used.set(t.id, (this.used.get(t.id) ?? 0) + n)
    return n
  }

  /** Take up to `cents` from the given payout first, then the restaurant's other payouts, newest first. */
  async takeAnywhere(own: Stripe.Transfer | null, cents: number, visit?: (t: Stripe.Transfer, n: number) => Promise<void>): Promise<number> {
    let left = cents
    const step = async (t: Stripe.Transfer) => {
      const n = Math.min(left, await this.room(t))
      if (n <= 0) return
      if (visit) await visit(t, n)   // a real reversal: made before it is recorded
      left -= await this.take(t, n)
    }
    if (own && left > 0) await step(own)
    if (left > 0) {
      const recent = await this.stripe.transfers.list({ destination: this.acct, limit: 100 })
      for (const t of recent.data) {
        if (left <= 0) break
        if (t.id === own?.id || t.reversed) continue
        await step(t)
      }
    }
    return cents - left
  }
}

/** What one refund needs from each restaurant account, planned before any money moves. */
export class RefundFundingPlan {
  private accounts = new Map<string, RestaurantFunds>()
  neededCents = 0
  unplacedCents = 0
  readonly lines: string[] = []

  constructor(private stripe: Stripe) {}

  async funds(acct: string): Promise<RestaurantFunds> {
    if (!this.accounts.has(acct)) this.accounts.set(acct, await RestaurantFunds.read(this.stripe, acct))
    return this.accounts.get(acct)!
  }

  /** Exactly `cents` from this payout — an explicit reversal, or what Stripe's reverse_transfer will take. */
  async reverse(t: Stripe.Transfer, cents: number, what: string): Promise<void> {
    if (cents <= 0) return
    const acct = idOf(t.destination)
    if (!acct) { this.neededCents += cents; this.unplacedCents += cents; this.lines.push(`${what}: payout ${t.id} has no restaurant account`); return }
    const got = await (await this.funds(acct)).take(t, cents)
    this.neededCents += cents
    this.unplacedCents += cents - got
    this.lines.push(`${what}: ${money(cents)} from payout ${t.id}${got < cents ? ` — only ${money(got)} can be taken` : ''}`)
  }

  /** `cents` owed after the refund (Stripe fee, shortfall): this payout first, then the restaurant's others. */
  async owe(acct: string, own: Stripe.Transfer | null, cents: number, what: string): Promise<void> {
    if (cents <= 0) return
    const got = acct ? await (await this.funds(acct)).takeAnywhere(own, cents) : 0
    this.neededCents += cents
    this.unplacedCents += cents - got
    this.lines.push(`${what}: ${money(cents)}${got < cents ? ` — only ${money(got)} can be taken` : ''}`)
  }

  get ok(): boolean { return this.unplacedCents <= 0 }

  /** What the check saw, per account — recorded on the order whether it passed or refused. */
  view(): Array<{ account: string; available: number; pending: number; ownPendingUsed: number }> {
    return [...this.accounts.values()].map(f => ({ account: f.acct, available: f.available / 100, pending: f.pending / 100, ownPendingUsed: f.ownPendingUsed / 100 }))
  }
}

export const money = (c: number) => `$${(c / 100).toFixed(2)}`
