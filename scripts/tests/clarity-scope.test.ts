// Microsoft Clarity runs only on public marketing and ordering pages (lib/clarity-scope.ts).
import { clarityAllowedOn } from '../../lib/clarity-scope'
let failures = 0
const expect = (path: string, allowed: boolean) => {
  const got = clarityAllowedOn(path)
  console.log(`${got === allowed ? 'PASS' : 'FAIL'}  ${allowed ? 'runs ' : 'never'}  ${path}`)
  if (got !== allowed) failures++
}
// Public marketing + ordering: runs.
for (const p of ['/', '/faq', '/new-york', '/for-restaurants', '/privacy', '/signup', '/restaurants', '/restaurants/', '/restaurants/two-hands-tribeca',
  '/restaurants/two-hands-tribeca?menu=x', '/order/benchmarkbreads', '/order/benchmarkbreads/catering', '/fullmap', '/compare/ezcater', '/become-a-partner'])
  expect(p, true)
// Restaurant portal, Super Admin, account, order confirmations: never.
for (const p of ['/restaurant', '/restaurant/', '/restaurant/login', '/restaurant/dashboard', '/restaurant/manage-v2/menus', '/restaurant/select-location',
  '/admin', '/admin/login', '/admin/dashboard', '/account', '/account/orders', '/account/payment', '/portal', '/reset-password',
  '/order-confirmation/abc', '/order-confirmation/abc?x=1'])
  expect(p, false)
// Controls: a whole path segment, so neither side catches the other.
expect('/restaurantsfoo', true); expect('/administer', true); expect('/accounting', true); expect('/order-confirmations-help', true)
console.log(failures ? `FAILED ${failures}` : 'ALL PASS'); if (failures) process.exit(1)
