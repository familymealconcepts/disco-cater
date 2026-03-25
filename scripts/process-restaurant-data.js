// Run with: node scripts/process-restaurant-data.js
const fs = require('fs')
const path = require('path')
const { parse } = require('csv-parse/sync')

const DATA_DIR = path.join(__dirname, 'data')
const OUT_DIR = path.join(__dirname, 'output')
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

function readCsv(filename) {
  const filePath = path.join(DATA_DIR, filename)
  const content = fs.readFileSync(filePath, 'utf8')
  return parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_quotes: true })
}

function isTruthy(val) {
  return val === true || val === 'true' || val === 'TRUE' || val === 'True' || val === '1' || val === 1
}

function parseJsonField(val) {
  if (!val || val.trim() === '') return []
  try {
    const parsed = JSON.parse(val)
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    const matches = val.match(/"([^"]+)"/g)
    return matches ? matches.map(m => m.replace(/"/g, '')) : []
  }
}

function inferEventTypes(menus, packages) {
  const allText = [
    ...menus.map(m => m.name + ' ' + (m.type || '')),
    ...packages.map(p => p.name + ' ' + (p.description || ''))
  ].join(' ').toLowerCase()

  const types = new Set()
  if (/corporate|office|business|meeting|conference|work\s*lunch|team/.test(allText)) types.add('corporate/office')
  if (/holiday|christmas|thanksgiving|new\s*year|hanukkah|festive|seasonal/.test(allText)) types.add('holiday parties')
  if (/wedding|birthday|party|celebration|social|graduation|baby\s*shower|bridal/.test(allText)) types.add('social events')
  if (/meal\s*prep|weekly|subscription|daily/.test(allText)) types.add('meal prep')
  if (/private\s*chef|exclusive|vip/.test(allText)) types.add('private/exclusive events')
  if (types.size === 0) { types.add('corporate/office'); types.add('social events') }
  return [...types]
}

console.log('Reading CSVs...')
const restaurants = readCsv('tbl_restaurants.csv')
let menus = []
try { menus = readCsv('tbl_menus.csv') } catch(e) { console.log('tbl_menus.csv not found, skipping') }
const packages = readCsv('tbl_meal_package_2.csv')
console.log('Loaded ' + restaurants.length + ' restaurants, ' + menus.length + ' menus, ' + packages.length + ' packages')

const menusByRestaurant = {}
for (const menu of menus) {
  const rid = String(menu.restaurant_id)
  if (!menusByRestaurant[rid]) menusByRestaurant[rid] = []
  menusByRestaurant[rid].push(menu)
}

const packagesByRestaurant = {}
for (const pkg of packages) {
  const rid = String(pkg.restaurant_id)
  if (!packagesByRestaurant[rid]) packagesByRestaurant[rid] = []
  packagesByRestaurant[rid].push(pkg)
}

const summary = []

for (const r of restaurants) {
  const status = (r.status || '').toUpperCase()
  if (status !== 'ACTIVE' && status !== 'ACCEPTED') continue
  if (isTruthy(r.blocked)) continue

  const rid = String(r.id)
  const pkgs = (packagesByRestaurant[rid] || []).filter(p =>
    !isTruthy(p.archived) && p.blocked !== 'True' && p.blocked !== 'TRUE'
  )
  if (pkgs.length === 0) continue

  const prices = pkgs.map(p => {
    const price = parseFloat(p.price)
    const serves = parseFloat(p.serves) || parseFloat(p.display_serves) || 1
    if (isNaN(price) || price <= 0 || serves <= 0) return null
    return Math.round((price / serves) * 100) / 100
  }).filter(Boolean)

  const minPPP = prices.length ? Math.min(...prices) : null
  const maxPPP = prices.length ? Math.max(...prices) : null

  const hasVegetarian = pkgs.some(p => isTruthy(p.vegetarian))
  const hasVegan = pkgs.some(p => isTruthy(p.vegan))
  const hasGlutenFree = pkgs.some(p => isTruthy(p.gluten_free))

  const fulfillment = parseJsonField(r.fulfillment_options).map(f => f.toUpperCase())
  const offersPickup = fulfillment.includes('PICKUP') || fulfillment.length === 0
  const offersDelivery = fulfillment.includes('DELIVERY') || isTruthy(r.delivery_allowed)
  const nashDelivery = isTruthy(r.nash_allowed)

  const restaurantMenus = (menusByRestaurant[rid] || [])
    .filter(m => isTruthy(m.visible) && !isTruthy(m.archived))
    .map(m => ({ name: m.name, type: m.type || '' }))
    .slice(0, 10)

  const eventTypes = inferEventTypes(restaurantMenus, pkgs)

  const topPackages = pkgs
    .sort((a, b) => (parseFloat(b.serves) || 0) - (parseFloat(a.serves) || 0))
    .slice(0, 3)
    .map(p => {
      const price = parseFloat(p.price)
      const serves = parseFloat(p.serves) || parseFloat(p.display_serves) || null
      const ppp = (price > 0 && serves > 0) ? '$' + (price / serves).toFixed(2) + '/person' : ''
      const pkgText = (p.name + ' ' + (p.description || '')).toLowerCase()
      return {
        name: p.name,
        description: (p.description || '').slice(0, 80),
        serves: p.display_serves || p.serves || '',
        pricePerPerson: ppp,
        vegetarian: /vegetarian|veggie|meatless|plant.based/.test(pkgText),
        glutenFree: /gluten.free|gluten free/.test(pkgText),
      }
    })

  summary.push({
    id: rid,
    name: r.business_name,
    website: r.website_url || '',
    offersPickup,
    offersDelivery,
    nashDelivery,
    serviceRadiusMiles: (offersDelivery || nashDelivery) ? 20 : 0,
    eventTypes,

    pricePerPerson: { min: minPPP, max: maxPPP },
    totalPackages: pkgs.length,
    menus: restaurantMenus,
    topPackages,
  })
}

summary.sort((a, b) => b.totalPackages - a.totalPackages)

fs.writeFileSync(path.join(OUT_DIR, 'restaurant-summary.json'), JSON.stringify(summary, null, 2))
console.log('Full summary: ' + summary.length + ' restaurants')

const compact = summary
  .filter(r => r.website || r.totalPackages >= 3)
  .map(r => ({
    name: r.name,
    website: r.website,
    offersDelivery: r.offersDelivery,
    eventTypes: r.eventTypes,

    pricePerPerson: r.pricePerPerson,
    topPackages: r.topPackages.slice(0, 2).map(p => ({
      name: p.name,
      serves: p.serves,
      pricePerPerson: p.pricePerPerson,
    })),
  }))

const compactPath = path.join(OUT_DIR, 'restaurant-compact.json')
fs.writeFileSync(compactPath, JSON.stringify(compact))
const sizeKB = Math.round(Buffer.byteLength(JSON.stringify(compact)) / 1024)
console.log('Compact version: ' + sizeKB + 'KB')
console.log('Delivery: ' + summary.filter(r => r.offersDelivery).length)

