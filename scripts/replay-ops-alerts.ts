// Replays every #ops-alerts message kind, plus one resolved reply of each kind,
// into a TEST channel — so the wording and threading can be seen in Slack before
// anything changes in #ops-alerts.
//
// Runs on a Neon BRANCH only (it writes disco_alert_dedup), with the bot token,
// and with SLACK_OPS_ALERTS_CHANNEL_ID pointing at the test channel. It refuses
// to post to #ops-alerts itself.
//
// Run: OPS_ALERT_VERIFY=branch DATABASE_URL=<branch> SLACK_OPS_ALERTS_BOT_TOKEN=<token> \
//      SLACK_OPS_ALERTS_CHANNEL_ID=<test channel id> npx tsx scripts/replay-ops-alerts.ts
//
// Where a message is built inside a cron route rather than an exported function,
// this file builds the same alert and says so (REPLICA), so a reader knows which
// lines prove the real code path and which only show the wording.
import { sql } from '../lib/db'
import { alertOps, alertOnce, alertGroup, replyToAlert, resolveAlert, noteJobFailure, noteJobSuccess } from '../lib/ops-alert'
import { SUGGESTIONS, haltReasonInWords, JOBS } from '../lib/ops-alert-format'
import { openCourierAlert, escalateCourier, courierBookedByRetry, courierKey } from '../lib/order/courier-alert'
import * as money from '../lib/order/money-alerts'
import { alertPaidOrderMissing } from '../lib/order/missing-order-alert'
import { emailFailureAlert } from '../lib/email-failures'

if (process.env.OPS_ALERT_VERIFY !== 'branch' || !process.env.SLACK_OPS_ALERTS_BOT_TOKEN) {
  console.error('Refusing: needs OPS_ALERT_VERIFY=branch, a branch DATABASE_URL and the bot token.'); process.exit(2)
}
if (!process.env.SLACK_OPS_ALERTS_CHANNEL_ID || process.env.SLACK_OPS_ALERTS_CHANNEL_ID === 'C0C21FDU8KT') {
  console.error('Refusing: SLACK_OPS_ALERTS_CHANNEL_ID must be the TEST channel, never #ops-alerts.'); process.exit(2)
}
// Never fall through to the production webhook.
delete process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL

const ref = async (n: number) => ((await sql`SELECT reference::text AS r FROM disco_orders WHERE order_number = ${n} LIMIT 1`) as Array<{ r: string }>)[0]?.r
const pause = () => new Promise(r => setTimeout(r, 1200)) // stay under Slack's 1 msg/s per channel

async function main() {
  // Start clean on the branch so every key opens fresh.
  await sql`DELETE FROM disco_alert_dedup WHERE resolved_at IS NULL OR resolved_at IS NOT NULL`
  const r463 = await ref(900000463), r303 = await ref(900000303), r228 = await ref(900000228), r195 = await ref(900000195)

  // ── Orders ──────────────────────────────────────────────────────────────────
  await openCourierAlert(r463, 'Expedite turned the booking down: "Not operational in this region."'); await pause()
  await escalateCourier(r463, 'at-risk', { minutesToPickup: 7 }); await pause()
  await escalateCourier(r463, 'missed', { pickupAt: '2026-10-20T11:15:00Z' }); await pause()
  await escalateCourier(r463, 'refused', { refusal: 'Not operational in this region.' }); await pause()
  await courierBookedByRetry(r463, '9.50'); await pause()
  await openCourierAlert(r303, "Disco couldn't build the delivery request for this order, so no courier was asked for."); await pause()
  await resolveAlert(courierKey(r303), 'Resolved: the order was cancelled.'); await pause()

  // REPLICA of lib/order/native-status-change.ts (courier not stood down).
  await alertOnce(`courier-cancel:${r195}`, {
    severity: 'urgent', headline: 'Courier still booked on a cancelled order — #900000195',
    lines: ['Apollo Bagels - Hoboken · delivery Fri Oct 24, 11:30 AM EDT', 'The order was cancelled but Expedite rejected the cancellation (error 400), so a driver may still turn up and Disco may still be charged the fee.'],
    action: 'cancel the delivery with Expedite directly.',
  }); await pause()
  await resolveAlert(`courier-cancel:${r195}`, 'Resolved: Expedite confirmed the cancellation.'); await pause()

  const ef = (await sql`
    SELECT event_id AS "eventId", event_time AS "eventTime", recipient, subject, reason, sending_ip AS "sendingIp",
           order_number AS "orderNumber", order_reference AS "orderReference", restaurant_reference AS "restaurantReference", restaurant_name AS "restaurantName"
      FROM disco_email_failures WHERE order_number::text IN ('900000599', '900000499') ORDER BY event_time`) as never[]
  for (const e of ef) {
    const a = await emailFailureAlert(e)
    const key = `email:${(e as { orderReference: string }).orderReference}:${a.context?.side}`
    await alertOnce(key, a); await pause()
    await resolveAlert(key, 'The order date has passed, so this is closed.'); await pause()
  }

  await alertPaidOrderMissing('00000000-0000-4000-8000-000000000640', { orderNumber: '900000640', restaurantReference: null, total: 212.4 }); await pause()
  await resolveAlert('order-missing:00000000-0000-4000-8000-000000000640', 'Resolved: the sync recorded it and sent the confirmations.'); await pause()

  // REPLICA of lib/fm-orders-sync.ts.
  await alertOnce('fm-copy:replay', {
    severity: 'warn', headline: "FamilyMeal order couldn't be copied to Disco — FM #23186878",
    lines: ['Local Smoke BBQ - Red Bank · for Fri Oct 17', 'The sync skipped it: duplicate key value violates unique constraint "disco_orders_restaurant_order_number_uq". It tries again every hour.'],
    action: 'nothing unless this is still open tomorrow; then it needs a code fix.',
  }); await pause()
  await resolveAlert('fm-copy:replay', 'Resolved: the sync copied it.'); await pause()
  await alertOps({
    severity: 'warn', headline: 'Confirmation not sent — order #900000588',
    lines: ["Pete's Bagels - St. Pete · for Wed Oct 22", 'Disco recovered this order from FamilyMeal, but sending its confirmation failed: Mailgun 503.'],
    action: 'resend the confirmation from Admin › Manage Customers.',
  }); await pause()

  // ── Money (real builders) ───────────────────────────────────────────────────
  await money.alertRestaurantNotPaid(r303, { paid: 385.9, error: new Error('Transfers using this transaction as a source must not exceed the source amount of $385.90.'), invoiceId: 'in_replay' }); await pause()
  await resolveAlert(`unpaid:${r303}`, 'Resolved: a payout to the restaurant is now recorded.'); await pause()
  await money.alertPaidOnClosedOrder(r195, 'in_replay'); await pause()
  await money.alertRefundRefused(r303, { refund: 96, needed: 81.6, holds: 42.1 }); await pause()
  await money.alertRestaurantKeptPayout(r228, { refund: 922.94, transferId: 'tr_replay', error: new Error('does not have sufficient funds') }); await pause()
  await money.alertRefundFromDiscoFunds(r195, { refund: 89.13, invoiceId: 'in_replay' }); await pause()
  await money.alertEditVoidFailed(r303, 'in_replay', 'void failed'); await pause()
  await money.alertEditReissueFailed(r303, 213.61, new Error('reissue failed')); await pause()
  await money.alertEditRefundImpossible(r303, 172.29); await pause()
  await money.alertSoldOutRefundFailed(r195, 'Breakfast Burrito Box', 'pi_replay'); await pause()
  await money.alertPaymentMismatch('payment-reconciliation:stripe_succeeded_not_paid:pi_replay', r195, { amount: 41.2, what: 'Stripe shows the payment succeeded, but the order is still RESERVED in Disco.', detail: 'replay' }); await pause()
  await resolveAlert('payment-reconciliation:stripe_succeeded_not_paid:pi_replay', 'Resolved: Stripe and Disco agree now.'); await pause()

  // ── Restaurants (REPLICAS of the cron routes' wording) ──────────────────────
  await alertOnce('stripe-restricted:replay', {
    severity: 'warn', headline: "Stripe restricted Volo's restaurant",
    lines: ["It can't take orders and is hidden from its locations page until Stripe lifts the restriction."],
    action: 'ask the restaurant to finish what Stripe is asking for in their Stripe dashboard.', link: SUGGESTIONS.accountManagement,
  }); await pause()
  await resolveAlert('stripe-restricted:replay', 'Resolved: Stripe lifted the restriction; it can take orders again.'); await pause()
  await alertGroup([{ key: 'stripe-link:a', name: "Zucker's Bagels", on: true }, { key: 'stripe-link:b', name: 'Ospi Venice', on: false }], f => ({
    severity: 'warn', headline: `${f.length} converted restaurants can't take card payments`,
    lines: ["Disco couldn't link a usable Stripe account for them:", ...f.map(r => `• ${r.name}${r.on ? ' (online ordering is on)' : ''}: FamilyMeal's account can't be used, so the restaurant must reconnect Stripe through Disco`)],
    action: 'ask each restaurant to reconnect Stripe through Disco.', link: SUGGESTIONS.accountManagement,
  })); await pause()
  await resolveAlert('stripe-link:a', "Zucker's Bagels is linked now."); await pause()
  await alertOnce('stripe-link-conflict:replay', {
    severity: 'urgent', headline: 'Stripe link conflict — Woo Woo Burgers - Kyle',
    lines: ["Disco's link and Stripe's own records name different accounts for this restaurant, so Disco changed nothing. A wrong link would send its payouts to another business."],
    action: 'confirm the right account with the restaurant and link it by hand.', link: SUGGESTIONS.accountManagement,
  }); await pause()
  await alertOnce('report:replay', {
    severity: 'warn', headline: 'Scheduled report not sent — "Weekly payouts", Atlanta Bread - Smyrna',
    lines: ["The payout figures didn't add up, so the email to 3 recipients was held back. First mismatch: order #900000412 pays out $180.20 against $182.40 expected."],
    action: "check the report's figures before the next run (weekly).", link: SUGGESTIONS.accountManagement,
  }); await pause()
  await resolveAlert('report:replay', 'Resolved: the next run sent normally.'); await pause()
  await alertOnce('report-columns:replay', {
    severity: 'warn', headline: 'Scheduled report sent without some columns — "Weekly payouts", Atlanta Bread - Smyrna',
    lines: ['It was set up with Payout and Fees, which no longer exist, so they were left out of the email.'],
    action: "edit the report's columns.", link: SUGGESTIONS.accountManagement,
  }); await pause()
  await resolveAlert('report-columns:replay', 'Resolved: the report ran with all its columns.'); await pause()
  await alertOnce('bare-order:replay', {
    severity: 'warn', headline: '1 upcoming order has no line items — Eggstasy - Norterra Ctr.',
    lines: ['#900000412, for Wed Oct 7. Edit Order, the PDF and emails show "Unavailable", so the restaurant can\'t see what to cook.'],
    action: "re-sync the order's items from FamilyMeal.",
  }); await pause()
  await resolveAlert('bare-order:replay', 'Resolved: #900000412 has its items now.'); await pause()
  await alertOnce('map-missing', {
    severity: 'warn', headline: '3 restaurants missing from the marketplace map',
    lines: ["They qualify to be listed but aren't in the map cache, so diners can't find them: Firenze: Italian Street Food, Kalamaki Greek La, HappyBoards Lower Manhattan."],
    action: "run Refresh Map Cache in Admin; if they're still missing, check the cron log for why they were rejected.",
  }); await pause()
  await resolveAlert('map-missing', 'Resolved: all 3 are on the map.'); await pause()
  await alertOnce('promo:replay', {
    severity: 'warn', headline: 'Promo codes differ from FamilyMeal at 3 restaurants',
    lines: ['Local Smoke BBQ - Red Bank, Surf Taco - Manasquan, FANTZYE (FM-backed, restaurant-funded codes).'],
    action: 'see the reconcile-promo-codes log for each difference.',
  }); await pause()
  await resolveAlert('promo:replay', 'Resolved: Local Smoke BBQ - Red Bank matches FamilyMeal again.'); await pause()
  await alertOnce('money-flow:replay', {
    severity: 'warn', headline: 'Westwoods BBQ & Spice Co. has no money flow set',
    lines: ["It's converted, so Disco owns this setting and nothing will fill it automatically. Restaurant-funded promos can't be validated without it."],
    action: 'set Money Flow on its Ordering page.', link: SUGGESTIONS.accountManagement,
  }); await pause()
  await resolveAlert('money-flow:replay', 'Resolved: money flow is set.'); await pause()
  await alertOps({
    severity: 'urgent', headline: 'A FamilyMeal admin may be left on the wrong restaurant',
    lines: ["After a batch read, Disco couldn't confirm kjp@atlantabread.com was switched back to Atlanta Bread - Asheville in FamilyMeal. They may still be pointed at Atlanta Bread - Smyrna."],
    action: 'check their selected restaurant in FamilyMeal and switch it back.',
  }); await pause()

  // ── Marketing ───────────────────────────────────────────────────────────────
  await alertOnce('campaign-halt:fall-diner-announce', {
    severity: 'urgent', headline: 'Campaign paused automatically — fall-diner-announce',
    lines: [haltReasonInWords('hard bounces 3.10% over the last 1204 sends (37 of 1204, limit 2%)')],
    action: "check the list and the sending domain's health, then resume it in Admin › Marketing.",
  }); await pause()
  await resolveAlert('campaign-halt:fall-diner-announce', 'Resolved: the campaign was resumed.'); await pause()
  await alertOnce('campaign-unreachable:Mailgun', {
    severity: 'warn', headline: "Campaign can't reach Mailgun — fall-diner-announce",
    lines: ['Sending is paused while Disco retries for up to 10 minutes. Nothing to do yet.'],
  }); await pause()
  await replyToAlert('campaign-unreachable:Mailgun', 'stopped', 'Gave up after 10 minutes, so the campaign has stopped.', { broadcast: true, severity: 'urgent', action: "relaunch it once it's reachable; recipients already sent to are skipped." }); await pause()
  await resolveAlert('campaign-unreachable:Mailgun', 'Mailgun is back after 3 minutes; the campaign carried on.'); await pause()
  await alertOps({
    severity: 'urgent', headline: 'Diner campaign stopped unexpectedly',
    lines: ["It sent 412 emails this run, then stopped: uncaught exception (fetch failed). That isn't a halt rule or the end of the list."],
    action: 'relaunch it; recipients already sent to are skipped.',
  }); await pause()

  // ── FamilyMeal mirror (REPLICAS) ────────────────────────────────────────────
  await alertGroup([{ key: 'fm-gap:a:17158423' }, { key: 'fm-gap:b:89286569' }], () => ({
    severity: 'warn', headline: '2 FamilyMeal orders missing from Disco',
    lines: ["Older than 2 hours and still not in Disco, so these restaurants' Disco portals don't show them:",
      '• Almost Home Red General – Navesink · FM #17158423 · $149.55 · for Sat Oct 31',
      '• Beach Buns Bakery · FM #89286569 · $57.42 · for Mon Oct 19'],
    action: 'nothing if they arrive within the hour; otherwise run the FM order sync.',
  })); await pause()
  await resolveAlert('fm-gap:a:17158423', 'FM #17158423 is in Disco now.'); await pause()
  await alertOnce('fm-mirror:stalled', {
    severity: 'urgent', headline: "FamilyMeal orders aren't reaching Disco",
    lines: ["The order sync hasn't moved in 4.8 hours, so new FamilyMeal orders for converted restaurants aren't showing up in their Disco portals."],
    action: 'check the sync-fm-orders cron in Vercel.',
  }); await pause()
  await resolveAlert('fm-mirror:stalled', 'Resolved: the sync is moving again (it was stuck about 6.1 hours).'); await pause()
  await alertGroup([{ key: 'fm-sync-fail:a' }, { key: 'fm-sync-fail:b' }], () => ({
    severity: 'warn', headline: 'FamilyMeal order sync failing for 2 restaurants',
    lines: ['Skipped 2 runs in a row: Colonial Ranch Market (FM 502), FANTZYE (FM 502). Their new orders may not reach Disco.'],
    action: 'nothing if it clears next run; otherwise check the restaurant in FamilyMeal.',
  })); await pause()
  await resolveAlert('fm-sync-fail:a', 'Colonial Ranch Market is syncing again.'); await pause()

  // ── Job failures (real path) and config ─────────────────────────────────────
  void JOBS
  for (let i = 0; i < 3; i++) await noteJobFailure('mailgun-failures', 'Mailgun events 500: {\n  "message": "Internal server error"\n}')
  await pause()
  await noteJobSuccess('mailgun-failures'); await pause()
  await alertOnce('config:stripe-capability-key', {
    severity: 'urgent', headline: "Stripe status refresh can't run: no Stripe key is set",
    lines: ["New Stripe restrictions won't be picked up until it is."], action: 'set STRIPE_READONLY_KEY in Vercel (Production).',
  }); await pause()
  await resolveAlert('config:stripe-capability-key', 'Resolved: the key is set and the refresh ran.'); await pause()

  // ── Production behind main: the GitHub Action's own text (.github/scripts/prod-drift-check.mjs) ─
  const raw = async (text: string, thread_ts?: string) => {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${process.env.SLACK_OPS_ALERTS_BOT_TOKEN}` },
      body: JSON.stringify({ channel: process.env.SLACK_OPS_ALERTS_CHANNEL_ID, text, unfurl_links: false, ...(thread_ts ? { thread_ts } : {}) }),
    })
    return ((await res.json()) as { ts?: string }).ts
  }
  const driftTs = await raw(':warning: *Production is behind main* (12 min). Production is running `ffedee1`; main is at `1ac205c`. *3 commits not live:*\n' +
    '• `1ac205c` Alert #ops-alerts when production falls behind main\n• `16bfe25` Link pages: apply the FM-session identity fix to edit too\n' +
    '• `d4c01cd` Link pages: a Super Admin on a FamilyMeal sign-in can edit and delete any link page\n' +
    'Nothing was deployed automatically. Usually GitHub did not hand the push to Vercel: redeploy main from Vercel, or push an empty commit.')
  await pause()
  await raw(':white_check_mark: Production is back in sync (`1ac205c`).', driftTs)

  await sql`DELETE FROM disco_alert_dedup WHERE resolved_at IS NULL OR resolved_at IS NOT NULL`
  console.log('Replay done.')
}
main().catch(e => { console.error('Replay failed:', e instanceof Error ? e.message : e); process.exit(1) })
