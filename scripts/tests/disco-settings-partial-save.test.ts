// disco-settings PUT never blanks online ordering or notification recipients by omission (Peter,
// 2026-11-10). A save must name the restaurant and state all three fields; the older order-settings
// page sends neither and is refused. Deliberate clears from the full Settings form still work.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
let n = 0
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++ }
const route = readFileSync('app/api/restaurant/disco-settings/route.ts', 'utf8')
const put = route.slice(route.indexOf('export async function PUT'))
ok(/requireWritableRestaurantRef\(body\?\.restaurant_reference\)/.test(put), 'a save must name its restaurant')
ok(/\['onlineOrderingEnabled', 'notificationEmails', 'notificationSmsNumbers'\]\.filter\(k => !\(k in body\)\)/.test(put), 'the three fields must be present')
ok(put.indexOf('missing.length') < put.indexOf('INSERT INTO disco_restaurant_overrides') && put.indexOf('missing.length') < put.indexOf('logSettingsChange'), 'refused before any write or audit')
const full = readFileSync('app/(restaurant)/restaurant/(portal)/menu-manager/settings/page.tsx', 'utf8')
ok(/restaurant_reference: restaurantRef,\s*onlineOrderingEnabled: onlineOrdering,\s*notificationEmails, textNotificationsEnabled: textNotifications, notificationSmsNumbers: notificationSms,/.test(full), 'the full Settings form sends all three')
console.log(`disco-settings-partial-save: ALL PASS ${n} assertions`)
