import { sql, withDiscoTables, runCheckoutFunnelMigrations } from './db'
import { type FunnelStage, FUNNEL_STAGE_RANK, FUNNEL_STAGE_TIMESTAMP_COLUMN } from './checkout-funnel-shared'

export type { FunnelStage } from './checkout-funnel-shared'

// The only two stages /api/order/init is allowed to record — it's a public
// route reachable with an attacker-controlled body, so the stage value it
// accepts is a narrow whitelist rather than the full FunnelStage union (no
// route should be able to phone in a fake ORDER_PLACED).
const INIT_ROUTE_STAGES = new Set<FunnelStage>(['CHECKOUT_READY', 'CHECKOUT_OPENED'])
export function isTrackableInitStage(v: unknown): v is FunnelStage {
  return typeof v === 'string' && INIT_ROUTE_STAGES.has(v as FunnelStage)
}

export interface RecordFunnelStageInput {
  sessionId: string
  restaurantReference: string
  stage: FunnelStage
  fulfillmentType?: 'PICKUP' | 'DELIVERY' | null
  cartValueCents?: number | null
  itemCount?: number | null
  orderReference?: string | null
}

// Upserts disco_checkout_funnel_sessions, keyed by session_id. Never an event
// log: a session that bounces between stages, or re-fires the same stage many
// times (cart qty +/-, promo re-price), still produces exactly one row.
//
// This function itself can throw (a real DB error) — swallowing lives at the
// call site: every caller wraps this in waitUntil(...).catch(...) (server
// routes already mid-response) so a capture failure can NEVER affect a
// customer's ability to order. There is intentionally no internal try/catch
// here so a test can still observe a genuine failure.
export async function recordFunnelStage(input: RecordFunnelStageInput): Promise<void> {
  const { sessionId, restaurantReference } = input
  if (!sessionId || !restaurantReference) return // nothing to key the row on — silently skip
  await withDiscoTables(() => writeStage(input), runCheckoutFunnelMigrations)
}

async function writeStage(input: RecordFunnelStageInput): Promise<void> {
  const stageColumn = FUNNEL_STAGE_TIMESTAMP_COLUMN[input.stage] // fixed whitelist — safe to interpolate
  const rank = FUNNEL_STAGE_RANK[input.stage]
  const contactEntered = input.stage === 'CONTACT_ENTERED'

  await sql.query(
    `INSERT INTO disco_checkout_funnel_sessions (
       session_id, restaurant_reference, fulfillment_type, furthest_stage, furthest_stage_rank,
       cart_value_cents, item_count, order_reference, contact_entered, ${stageColumn}, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       -- Monotonic: only advance furthest_stage, never regress it.
       furthest_stage = CASE WHEN EXCLUDED.furthest_stage_rank > disco_checkout_funnel_sessions.furthest_stage_rank
                              THEN EXCLUDED.furthest_stage ELSE disco_checkout_funnel_sessions.furthest_stage END,
       furthest_stage_rank = GREATEST(EXCLUDED.furthest_stage_rank, disco_checkout_funnel_sessions.furthest_stage_rank),
       -- Snapshot fields always refresh to the latest known value.
       fulfillment_type = COALESCE(EXCLUDED.fulfillment_type, disco_checkout_funnel_sessions.fulfillment_type),
       cart_value_cents = COALESCE(EXCLUDED.cart_value_cents, disco_checkout_funnel_sessions.cart_value_cents),
       item_count = COALESCE(EXCLUDED.item_count, disco_checkout_funnel_sessions.item_count),
       order_reference = COALESCE(EXCLUDED.order_reference, disco_checkout_funnel_sessions.order_reference),
       contact_entered = disco_checkout_funnel_sessions.contact_entered OR EXCLUDED.contact_entered,
       -- This stage's timestamp is set once (first reach) and never overwritten.
       ${stageColumn} = COALESCE(disco_checkout_funnel_sessions.${stageColumn}, EXCLUDED.${stageColumn}),
       updated_at = NOW()`,
    [
      input.sessionId,
      input.restaurantReference,
      input.fulfillmentType ?? null,
      input.stage,
      rank,
      input.cartValueCents ?? null,
      input.itemCount ?? null,
      input.orderReference ?? null,
      contactEntered,
    ],
  )
}
