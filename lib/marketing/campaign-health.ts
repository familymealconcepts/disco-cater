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
  /** Complaints are a RATE, not an event. See DEFAULT_THRESHOLDS for why this
   *  window is five times the bounce window. */
  maxComplaintPct: number
  complaintWindowSize: number
  minSendsForComplaint: number
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
  // ── COMPLAINTS: A RATE, MEASURED OVER A THOUSAND ─────────────────────────
  // This replaced a zero-tolerance rule that stopped the run on ANY complaint.
  // Two complaints in 1,445 sends (0.138%) halted an eleven-day campaign twice,
  // each time needing a person to review and clear it by hand.
  //
  // 0.3% is where mailbox providers actually penalise. They begin reacting
  // around 0.1%, so a threshold below that would stop the run while delivery is
  // still healthy; well above 0.3% and the protection is theatre.
  //
  // THE WINDOW IS 1,000, NOT THE BOUNCE RULE'S 200, AND THAT IS THE WHOLE
  // POINT. A rate is only as fine as its denominator: over 200 sends a single
  // complaint is 0.5%, so a 0.3% threshold on a 200-window fires on the FIRST
  // complaint and is precisely the rule being removed, just delayed. Over 1,000
  // one complaint is 0.1% and the rule needs FOUR to trip — a genuine rate,
  // which is what was asked for.
  //
  // Measured against the observed rate of roughly one complaint per 720 sends:
  // a 200-window would halt on ~24% of windows, a 1,000-window on ~5%. The
  // first is the status quo wearing a percentage; the second tolerates a normal
  // rate and still catches a real deterioration.
  maxComplaintPct: 0.3,
  complaintWindowSize: 1000,
  // The full window before it can fire. A smaller minimum re-introduces the
  // same arithmetic: at 300 sends one complaint is 0.33% and halts on its own.
  minSendsForComplaint: 1000,
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
  /** The complaint rule's own window — wider than the bounce window. */
  rollingComplaintWindow: number
  rollingComplaints: number
  rollingComplaintPct: number | null
}

export interface HaltDecision { halt: boolean; reason?: string }

export class CampaignHealth {
  private consecutiveFailures = 0
  private authError: string | null = null
  private snap: HealthSnapshot = {
    accepted: 0, acceptedMatured: 0, delivered: 0, hardBounces: 0,
    complaints: 0, consecutiveFailures: 0, hardBouncePct: null, deliveryPct: null,
    rollingWindow: 0, rollingHardBounces: 0, rollingBouncePct: null,
    rollingComplaintWindow: 0, rollingComplaints: 0, rollingComplaintPct: null,
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
    // Per RECIPIENT, exactly as bounces are, so one address complaining twice
    // cannot inflate the rate.
    const complainedSet = new Set<string>()

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
        else if (ev === 'complained') { complaints++; complainedSet.add(who) }
        else if (ev === 'failed' && String(e.severity) === 'permanent') { hardBounces++; bouncedSet.add(who) }
      }
      page = j.paging?.next ?? null
    }

    // THE ROLLING WINDOW: the last N accepted recipients, and how many of those
    // bounced. Counted per RECIPIENT rather than per event so a retried address
    // cannot be counted twice and inflate the rate.
    const windowRecipients = acceptedOrder.slice(-this.thresholds.bounceWindowSize)
    const rollingHardBounces = windowRecipients.filter(r => bouncedSet.has(r)).length
    // The complaint window is its own, and wider — see DEFAULT_THRESHOLDS.
    const complaintWindow = acceptedOrder.slice(-this.thresholds.complaintWindowSize)
    const rollingComplaints = complaintWindow.filter(r => complainedSet.has(r)).length

    this.snap = {
      accepted, acceptedMatured, delivered, hardBounces, complaints,
      consecutiveFailures: this.consecutiveFailures,
      hardBouncePct: accepted > 0 ? (hardBounces / accepted) * 100 : null,
      deliveryPct: acceptedMatured > 0 ? (delivered / acceptedMatured) * 100 : null,
      rollingWindow: windowRecipients.length,
      rollingHardBounces,
      rollingBouncePct: windowRecipients.length > 0 ? (rollingHardBounces / windowRecipients.length) * 100 : null,
      rollingComplaintWindow: complaintWindow.length,
      rollingComplaints,
      rollingComplaintPct: complaintWindow.length > 0 ? (rollingComplaints / complaintWindow.length) * 100 : null,
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

    // ROLLING, like the bounce rule below it, and for the same reason: a rate
    // measured from the run's start keeps every old complaint in the denominator
    // forever and stops reflecting what is happening now.
    //
    // This replaced "any complaint halts the run", which stopped an eleven-day
    // send twice at a cumulative 0.138% — a rate mailbox providers are entirely
    // relaxed about. The floor matters as much as the percentage: below
    // minSendsForComplaint the rule is disarmed, because over a short window a
    // single complaint is a large percentage and would halt on its own.
    if (
      s.rollingComplaintWindow >= t.minSendsForComplaint &&
      s.rollingComplaintPct !== null &&
      s.rollingComplaintPct > t.maxComplaintPct
    ) {
      return {
        halt: true,
        reason: `spam complaints ${s.rollingComplaintPct.toFixed(3)}% over the last ${s.rollingComplaintWindow} sends ` +
                `(${s.rollingComplaints} of ${s.rollingComplaintWindow}, limit ${t.maxComplaintPct}%)`,
      }
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
