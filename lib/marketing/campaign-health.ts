// Automatic halt conditions for a bulk campaign, evaluated DURING the run.
//
// The point is that the run stops itself. Every check below is applied between
// messages, not at the end of a day — a rule that only fires in the morning
// report has already spent the thing it was protecting.
//
// Two of the five are observable from our own send results (consecutive
// failures, auth errors). The other three are DELIVERY facts that only Mailgun
// knows, so they are polled from its events API for this campaign's tag. That
// is why the tag is load-bearing rather than cosmetic.

// No import from campaign-send: that module imports THIS one, and a cycle
// between them is how a safety check ends up undefined at call time. The halt
// itself is performed by the caller, which already holds haltCampaign.

export interface HealthThresholds {
  maxHardBouncePct: number      // once minSendsForBounce have gone out
  minSendsForBounce: number
  /** Hard bounces are measured over the LAST N sends, not cumulatively from the
   *  run start. Recipients go oldest-registration-first, which deliberately
   *  front-loads the staleest addresses: day one measured 5.00% on 100 sends,
   *  all dead 2021-era domains and mailboxes, against 96% delivery and zero
   *  complaints. Cumulatively that cohort stays in the denominator forever and
   *  can trip a halt days later on a known artifact rather than a live problem.
   *  Rolling keeps the rule measuring what is happening NOW. */
  bounceWindowSize: number
  maxConsecutiveFailures: number
  minDeliveryPct: number        // once minMaturedForDelivery have matured
  minMaturedForDelivery: number
  /** A message younger than this has not had time to resolve, so counting it
   *  against the delivery rate measures our own pacing, not deliverability. */
  maturityMs: number
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  maxHardBouncePct: 5,
  minSendsForBounce: 100,
  bounceWindowSize: 200,
  maxConsecutiveFailures: 5,
  minDeliveryPct: 90,
  minMaturedForDelivery: 200,
  maturityMs: 10 * 60_000,
}

export interface HealthSnapshot {
  accepted: number
  acceptedMatured: number
  delivered: number
  hardBounces: number
  complaints: number
  consecutiveFailures: number
  /** Cumulative, for REPORTING only — the halt rule reads the rolling figures. */
  hardBouncePct: number | null
  deliveryPct: number | null
  /** How many sends the rolling bounce window actually covers (<= bounceWindowSize). */
  rollingWindow: number
  rollingHardBounces: number
  rollingBouncePct: number | null
}

export interface HaltDecision { halt: boolean; reason?: string }

export class CampaignHealth {
  private consecutiveFailures = 0
  private authError: string | null = null
  private snap: HealthSnapshot = {
    accepted: 0, acceptedMatured: 0, delivered: 0, hardBounces: 0,
    complaints: 0, consecutiveFailures: 0, hardBouncePct: null, deliveryPct: null,
    rollingWindow: 0, rollingHardBounces: 0, rollingBouncePct: null,
  }

  constructor(
    private readonly tag: string,
    private readonly domain: string,
    private readonly sinceSec: number,
    private readonly thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
  ) {}

  /** Record one send result. Any auth failure is terminal on its own. */
  recordSend(ok: boolean, error?: string | null): void {
    if (ok) { this.consecutiveFailures = 0; return }
    this.consecutiveFailures++
    if (error && /\b401\b|unauthor|forbidden|invalid api key/i.test(error)) {
      this.authError = error
    }
  }

  /**
   * Pull this campaign's events and recompute. Returns false ONLY when Mailgun
   * itself rejected the read with an auth error — a transport blip is not a
   * reason to stop a campaign, so anything else leaves the previous snapshot in
   * place and the run continues.
   */
  async poll(apiKey: string): Promise<void> {
    const auth = 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64')
    let page: string | null =
      `https://api.mailgun.net/v3/${this.domain}/events?begin=${this.sinceSec}&ascending=yes&limit=300&tags=${encodeURIComponent(this.tag)}`
    let accepted = 0, acceptedMatured = 0, delivered = 0, hardBounces = 0, complaints = 0
    const cutoff = (Date.now() - this.thresholds.maturityMs) / 1000
    // Accepted recipients IN SEND ORDER, and the set that hard-bounced, so the
    // rolling window can be taken off the tail. Events are requested
    // ascending=yes, so push order IS send order.
    const acceptedOrder: string[] = []
    const bouncedSet = new Set<string>()

    while (page) {
      const res: Response = await fetch(page, { headers: { Authorization: auth } })
      if (res.status === 401 || res.status === 403) {
        this.authError = `Mailgun events API returned ${res.status}`
        return
      }
      if (!res.ok) return // transient; keep the previous snapshot
      const j = await res.json() as { items?: Record<string, unknown>[]; paging?: { next?: string } }
      const items = j.items ?? []
      if (!items.length) break
      for (const e of items) {
        const ev = String(e.event)
        const ts = Number(e.timestamp)
        const who = String(e.recipient ?? '').toLowerCase()
        if (ev === 'accepted') { accepted++; acceptedOrder.push(who); if (ts < cutoff) acceptedMatured++ }
        else if (ev === 'delivered') delivered++
        else if (ev === 'complained') complaints++
        else if (ev === 'failed' && String(e.severity) === 'permanent') { hardBounces++; bouncedSet.add(who) }
      }
      page = j.paging?.next ?? null
    }

    // THE ROLLING WINDOW: the last N accepted recipients, and how many of those
    // bounced. Counted per RECIPIENT rather than per event so a retried address
    // cannot be counted twice and inflate the rate.
    const windowRecipients = acceptedOrder.slice(-this.thresholds.bounceWindowSize)
    const rollingHardBounces = windowRecipients.filter(r => bouncedSet.has(r)).length

    this.snap = {
      accepted, acceptedMatured, delivered, hardBounces, complaints,
      consecutiveFailures: this.consecutiveFailures,
      hardBouncePct: accepted > 0 ? (hardBounces / accepted) * 100 : null,
      deliveryPct: acceptedMatured > 0 ? (delivered / acceptedMatured) * 100 : null,
      rollingWindow: windowRecipients.length,
      rollingHardBounces,
      rollingBouncePct: windowRecipients.length > 0 ? (rollingHardBounces / windowRecipients.length) * 100 : null,
    }
  }

  snapshot(): HealthSnapshot {
    return { ...this.snap, consecutiveFailures: this.consecutiveFailures }
  }

  /** Evaluate every halt condition. Order is by how decisive each one is. */
  evaluate(): HaltDecision {
    const t = this.thresholds
    const s = this.snap

    if (this.authError) return { halt: true, reason: `Mailgun auth error: ${this.authError}` }

    if (this.consecutiveFailures >= t.maxConsecutiveFailures) {
      return { halt: true, reason: `${this.consecutiveFailures} consecutive send failures (limit ${t.maxConsecutiveFailures})` }
    }

    if (s.complaints > 0) {
      return { halt: true, reason: `${s.complaints} spam complaint(s) — any complaint halts the run` }
    }

    // ROLLING, not cumulative. The floor is unchanged: at least
    // minSendsForBounce must sit inside the window before the rule can fire.
    if (s.rollingWindow >= t.minSendsForBounce && s.rollingBouncePct !== null && s.rollingBouncePct > t.maxHardBouncePct) {
      return {
        halt: true,
        reason: `hard bounces ${s.rollingBouncePct.toFixed(2)}% over the last ${s.rollingWindow} sends ` +
                `(${s.rollingHardBounces} of ${s.rollingWindow}, limit ${t.maxHardBouncePct}%)`,
      }
    }

    if (s.acceptedMatured >= t.minMaturedForDelivery && s.deliveryPct !== null && s.deliveryPct < t.minDeliveryPct) {
      return { halt: true, reason: `delivery ${s.deliveryPct.toFixed(2)}% of ${s.acceptedMatured} matured sends (floor ${t.minDeliveryPct}%)` }
    }

    return { halt: false }
  }

}
