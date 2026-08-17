import { useEffect, useMemo, useRef, useState } from 'react'
import { sb, LOCATIONS, currentPeriod, UNITS } from './sb.js'
import { colors, fonts, css } from './theme.js'
import BarcodeScanner from './BarcodeScanner.jsx'
import { supabase } from './supabaseClient.js'
import Login from './Login.jsx'
import SetPassword from './SetPassword.jsx'
import { CompanyProvider, useCompany } from './CompanyContext.jsx'
import { uploadPurchaseSlip, getSlipUrl } from './slipUpload.js'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function prevPeriod(period) {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function toPeriod(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : currentPeriod()
}

function fmt(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return Number(n).toLocaleString('en-ZA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// ---------------------------------------------------------------------------
// Scan-a-slip helpers — used by the Purchases tab's "Scan slip" flow. A
// photo is resized client-side, sent to /api/parse-slip (a Vercel
// serverless function that calls Anthropic's vision API — see that file
// for why this can't happen directly in the browser), and the returned
// line items are fuzzy-matched against the current item/supplier lists so
// confident matches can be pre-filled on the review screen.
// ---------------------------------------------------------------------------

// Shrinks a photo before upload — keeps the request well under Vercel's
// serverless body-size limit and speeds up the AI call, without losing the
// legibility a slip actually needs (long edge capped at 1800px is plenty
// for printed or handwritten text).
async function resizeImageFile(file, maxDim = 1800, quality = 0.82) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality))
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Simple, dependency-free fuzzy matcher: normalizes both strings, scores by
// token overlap plus a bonus if one fully contains the other. Good enough
// to tell "Chicken Breast 5kg" apart from "Chicken Thigh 5kg" while still
// matching "CHICKEN BREAST FILLET 5KG BAG" to "Chicken Breast 5kg".
function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function matchScore(a, b) {
  const na = normalizeForMatch(a)
  const nb = normalizeForMatch(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const tokensA = na.split(' ').filter(Boolean)
  const tokensB = nb.split(' ').filter(Boolean)
  const setB = new Set(tokensB)
  let overlap = 0
  for (const t of tokensA) if (setB.has(t)) overlap++
  const overlapScore = overlap / Math.max(tokensA.length, tokensB.length)
  const substrBonus = na.includes(nb) || nb.includes(na) ? 0.2 : 0
  return Math.min(1, overlapScore + substrBonus)
}

// Confident-match threshold for pre-filling a dropdown vs. leaving it for
// a person to decide. Tuned loose-but-safe: below this, the row is always
// flagged for manual review rather than silently guessing wrong.
const MATCH_CONFIDENT = 0.55

function findBestMatch(text, candidates, nameKey = 'name') {
  let best = null
  let bestScore = 0
  for (const c of candidates) {
    const score = matchScore(text, c[nameKey])
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return { match: best, score: bestScore, confident: bestScore >= MATCH_CONFIDENT }
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// Slips get read exactly as printed (see the prompt in api/parse-slip.js) —
// VAT is only added/removed here, client-side, so it's transparent and
// re-adjustable if the toggle or rate turns out wrong. Each row keeps its
// original raw_total (as printed) untouched; total_cost is always
// re-derived from that whenever the VAT settings change.
function applyVatToRows(rows, pricesIncludeVat, vatRate) {
  const divisor = pricesIncludeVat ? 1 + (Number(vatRate) || 0) / 100 : 1
  return rows.map((r) => ({ ...r, total_cost: round2(r.raw_total / divisor) }))
}

// Reasons an issue can be logged under. 'Service' is normal kitchen use —
// dishes cooked and served — logged the same way a write-off is, just
// under a different reason. Everything else (Breakage/Expired/Staff/Other)
// is a write-off, tracked separately on the Dashboard. Same model as the
// beverage app's Issues tab. (Historical rows with reason 'Service' or no
// reason at all, from before this change, are treated the same way by the
// fallback in computeMetrics below — they always counted as normal use.)
const ISSUE_REASONS = ['Service', 'Breakage', 'Expired', 'Staff', 'Other']

function computeMetrics(item, stockPeriod, itemPurchases, itemIssues) {
  const opening = stockPeriod?.opening_units ?? 0
  const openingCost = stockPeriod?.opening_cost_per_unit ?? 0
  const purchaseUnits = itemPurchases.reduce((s, p) => s + Number(p.units || 0), 0)
  const purchaseCost = itemPurchases.reduce((s, p) => s + Number(p.total_cost_excl_vat || 0), 0)
  const issuedTotal = itemIssues.reduce((s, i) => s + Number(i.qty || 0), 0)

  // 'Service' (or no reason at all, for old rows logged before this reason
  // existed) is normal use, not a write-off — everything else counts as a
  // write-off below.
  const serviceUnits = itemIssues
    .filter((i) => !i.reason || i.reason === 'Service')
    .reduce((s, i) => s + Number(i.qty || 0), 0)
  const writeOffUnits = issuedTotal - serviceUnits

  const weightedAvgCost =
    opening + purchaseUnits > 0
      ? (opening * openingCost + purchaseCost) / (opening + purchaseUnits)
      : openingCost

  const serviceValue = serviceUnits * weightedAvgCost
  const writeOffValue = writeOffUnits * weightedAvgCost

  // "Expected" stock = opening + purchases − ALL logged issues (service +
  // write-offs). Usage is now an input (what staff log on the Issues tab),
  // not something inferred from the count — the count exists to check the
  // log, not to define usage. Variance = counted − expected: the genuine
  // discrepancy once normal use is properly logged (positive = more on
  // the shelf than the log predicts, negative = shrinkage/unlogged use).
  const theoreticalClosing = opening + purchaseUnits - issuedTotal
  const closingCount = stockPeriod?.closing_count_units
  const hasCount = closingCount !== null && closingCount !== undefined
  const varianceUnits = hasCount ? closingCount - theoreticalClosing : null
  const varianceValue = hasCount ? varianceUnits * weightedAvgCost : null

  const reorderQty =
    theoreticalClosing <= Number(item.min_units || 0)
      ? Math.max(Number(item.max_units || 0) - theoreticalClosing, 0)
      : 0

  return {
    opening,
    openingCost,
    purchaseUnits,
    purchaseCost,
    weightedAvgCost,
    issuedTotal,
    serviceUnits,
    writeOffUnits,
    serviceValue,
    writeOffValue,
    theoreticalClosing,
    closingCount,
    hasCount,
    varianceUnits,
    varianceValue,
    reorderQty,
  }
}

// Rolls per-item metrics up into totals, for the Dashboard. "Actual" value
// uses the physical count where one exists this period, and falls back to
// the theoretical estimate for items that haven't been counted yet.
function aggregateValues(items, metricsByItem) {
  const totals = {
    theoreticalValue: 0,
    actualValue: 0,
    varianceValue: 0,
    issuedValue: 0,
    serviceValue: 0,
    serviceUnits: 0,
    writeOffValue: 0,
    writeOffUnits: 0,
    countedItems: 0,
  }
  for (const it of items) {
    const m = metricsByItem[it.id]
    if (!m) continue
    totals.theoreticalValue += m.theoreticalClosing * m.weightedAvgCost
    totals.actualValue += (m.hasCount ? m.closingCount : m.theoreticalClosing) * m.weightedAvgCost
    totals.varianceValue += m.hasCount ? m.varianceValue : 0
    totals.issuedValue += m.issuedTotal * m.weightedAvgCost
    totals.serviceValue += m.serviceValue
    totals.serviceUnits += m.serviceUnits
    totals.writeOffValue += m.writeOffValue
    totals.writeOffUnits += m.writeOffUnits
    if (m.hasCount) totals.countedItems += 1
  }
  return totals
}

// Rolls per-item metrics up by supplier, for the Dashboard's "By supplier"
// section and the Orders tab. Items with no supplier assigned land in a
// single "Unassigned" bucket rather than being dropped.
const UNASSIGNED_SUPPLIER = '__unassigned__'

function aggregateBySupplier(items, metricsByItem) {
  const blank = () => ({
    theoreticalValue: 0,
    actualValue: 0,
    serviceUnits: 0,
    serviceValue: 0,
    writeOffUnits: 0,
    writeOffValue: 0,
    countedItems: 0,
    itemCount: 0,
  })
  const bySupplier = {}

  for (const it of items) {
    const m = metricsByItem[it.id]
    if (!m) continue
    const key = it.supplier_id || UNASSIGNED_SUPPLIER
    if (!bySupplier[key]) bySupplier[key] = blank()
    const bucket = bySupplier[key]
    bucket.theoreticalValue += m.theoreticalClosing * m.weightedAvgCost
    bucket.actualValue += (m.hasCount ? m.closingCount : m.theoreticalClosing) * m.weightedAvgCost
    bucket.serviceUnits += m.serviceUnits
    bucket.serviceValue += m.serviceValue
    bucket.writeOffUnits += m.writeOffUnits
    bucket.writeOffValue += m.writeOffValue
    if (m.hasCount) bucket.countedItems += 1
    bucket.itemCount += 1
  }

  return bySupplier
}

// Cost of one recipe_unit of an item — e.g. if purchase_unit is 'kg' at
// R80/kg, recipe_unit is 'g', conversion_factor is 1000, this returns
// R0.08/g. Used by the Menu tab's live recipe costing.
function costPerRecipeUnit(item, metricsByItem) {
  if (!item || !item.conversion_factor || item.conversion_factor <= 0) return 0
  const m = metricsByItem[item.id]
  return (m?.weightedAvgCost || 0) / item.conversion_factor
}

// ---------------------------------------------------------------------------
// Shared styles (inline CSS-in-JS, mirrors the beverage/ops apps' approach)
// ---------------------------------------------------------------------------

const styles = {
  app: {
    fontFamily: fonts.body,
    background: colors.bg,
    minHeight: '100vh',
    color: colors.cream,
    paddingBottom: 72,
  },
  header: {
    background: colors.panel,
    borderBottom: `1px solid ${colors.border}`,
    color: colors.cream,
    padding: '14px 16px 10px',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  headerTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    fontWeight: 600,
    marginBottom: 10,
    color: colors.cream,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  logo: { height: 28, width: 'auto', display: 'block' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  pillGroup: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  pill: (active, locId) => ({
    padding: '6px 12px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    border: `1px solid ${locId ? colors.loc[locId] : colors.border}`,
    background: active ? (locId ? colors.loc[locId] : colors.navy) : 'transparent',
    color: active ? colors.bg : locId ? colors.loc[locId] : colors.cream,
    cursor: 'pointer',
  }),
  monthInput: {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  // Desktop-only tab row (see the .desktop-tab-row / .mobile-nav-bar media
  // query injected in the render below) — replaces the always-visible
  // bottom "Menu" button on screens wide enough that a normal row of tabs
  // fits without wrapping or clipping.
  desktopTabRow: {
    display: 'flex',
    gap: 4,
    padding: '0 20px',
    background: colors.panel,
    borderBottom: `1px solid ${colors.border}`,
    overflowX: 'auto',
  },
  desktopTab: (active) => ({
    padding: '12px 16px',
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    color: active ? colors.goldLt : colors.muted,
    background: 'none',
    border: 'none',
    borderBottom: active ? `2px solid ${colors.gold}` : '2px solid transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }),
  content: { padding: 14, maxWidth: 1100, margin: '0 auto', boxSizing: 'border-box' },
  card: {
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  tableWrap: {
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    marginLeft: -14,
    marginRight: -14,
    paddingLeft: 14,
    paddingRight: 14,
  },
  cardTitle: {
    fontFamily: fonts.heading,
    fontSize: 19,
    fontWeight: 600,
    marginBottom: 10,
    color: colors.goldLt,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: `2px solid ${colors.border}`,
    color: colors.muted,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  td: { padding: '6px 8px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' },
  tdNum: {
    padding: '6px 8px',
    borderBottom: `1px solid ${colors.border}`,
    whiteSpace: 'nowrap',
    fontFamily: fonts.mono,
  },
  num: { fontFamily: fonts.mono },
  input: {
    width: '100%',
    padding: '7px 9px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontSize: 13,
    boxSizing: 'border-box',
  },
  smallInput: {
    width: 80,
    padding: '5px 7px',
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  button: {
    padding: '9px 14px',
    borderRadius: 8,
    border: 'none',
    background: colors.navy,
    color: colors.cream,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  buttonGhost: {
    padding: '9px 14px',
    borderRadius: 8,
    border: `1px solid ${colors.gold}`,
    background: 'transparent',
    color: colors.goldLt,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  buttonDanger: {
    padding: '5px 9px',
    borderRadius: 6,
    border: 'none',
    background: 'rgba(192,88,88,0.16)',
    color: colors.danger,
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
  },
  banner: {
    background: 'rgba(184,147,90,0.12)',
    border: `1px solid ${colors.gold}`,
    color: colors.goldLt,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    fontSize: 13,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 8,
    marginBottom: 10,
  },
  label: { fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' },
  // Bottom nav is a single "Menu" button (see navMenuButton) rather than a
  // row of tabs — with 9-10 tabs on some roles, a horizontal-scroll bar
  // either clips tabs off-screen or needs a swipe gesture nobody discovers
  // on their own. Tapping the button opens navSheet, a bottom-anchored
  // list of every tab, so every tab is always one predictable tap away
  // regardless of how many exist.
  navBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: colors.panel,
    borderTop: `1px solid ${colors.border}`,
    padding: 8,
    zIndex: 10,
    boxSizing: 'border-box',
  },
  navMenuButton: {
    width: '100%',
    maxWidth: 1100,
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '11px 14px',
    borderRadius: 10,
    border: `1px solid ${colors.gold}`,
    background: 'rgba(184,147,90,0.12)',
    color: colors.goldLt,
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
  },
  navOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 20,
  },
  navSheet: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '75vh',
    overflowY: 'auto',
    background: colors.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    border: `1px solid ${colors.border}`,
    borderBottom: 'none',
    boxSizing: 'border-box',
  },
  navSheetHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 16px',
    borderBottom: `1px solid ${colors.border}`,
    position: 'sticky',
    top: 0,
    background: colors.panel,
  },
  navSheetTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    fontWeight: 600,
    color: colors.goldLt,
  },
  navSheetClose: {
    padding: '4px 10px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: 'transparent',
    color: colors.cream,
    fontSize: 14,
    cursor: 'pointer',
  },
  navSheetItem: (active) => ({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '14px 16px',
    borderBottom: `1px solid ${colors.border}`,
    background: active ? 'rgba(184,147,90,0.12)' : 'none',
    color: active ? colors.goldLt : colors.cream,
    fontWeight: active ? 700 : 500,
    fontSize: 15,
    cursor: 'pointer',
  }),
  badge: (tone) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: fonts.mono,
    background:
      tone === 'bad' ? 'rgba(192,88,88,0.16)' : tone === 'good' ? 'rgba(90,155,114,0.16)' : 'rgba(138,136,153,0.16)',
    color: tone === 'bad' ? colors.danger : tone === 'good' ? colors.ok : colors.muted,
  }),
}

const ADMIN_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'items', label: 'Items' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'menu', label: 'Menu' },
  { id: 'opening', label: 'Opening' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'issues', label: 'Issues' },
  { id: 'count', label: 'Count' },
  { id: 'variance', label: 'Usage' },
  { id: 'orders', label: 'Orders' },
]

const STAFF_TABS = [
  { id: 'issues', label: 'Issues' },
  { id: 'count', label: 'Count' },
]

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
//
// Real Supabase Auth session handling (2026-08-08 — Food Stock 3b of the
// multi-tenant rebuild), replacing the old shared admin/staff password
// checked against food_access + a localStorage 'food_role' flag. Once a
// session exists, company/role is resolved by CompanyProvider/useCompany()
// instead — see CompanyContext.jsx. Same pattern as the Finance Dashboard's
// App.jsx (same Supabase project, same auth users).

// Supabase puts the link's type ('invite' | 'recovery' | ...) in the URL
// hash fragment when someone lands back in the app from an email link —
// read once, synchronously, on first render, before supabase-js has a
// chance to process and clear it.
function getAuthHashType() {
  if (typeof window === 'undefined' || !window.location.hash) return null
  return new URLSearchParams(window.location.hash.slice(1)).get('type')
}

const authScreenStyle = {
  fontFamily: fonts.body,
  background: colors.bg,
  minHeight: '100vh',
  color: colors.cream,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

function AuthMessageScreen({ children }) {
  return (
    <div style={authScreenStyle}>
      <div style={{ textAlign: 'center', maxWidth: 320 }}>{children}</div>
    </div>
  )
}

export default function App() {
  // undefined = still checking for an existing session, null = signed out
  const [session, setSession] = useState(undefined)
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(() => {
    const type = getAuthHashType()
    return type === 'invite' || type === 'recovery'
  })

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return (
      <AuthMessageScreen>
        <p>Loading…</p>
      </AuthMessageScreen>
    )
  }

  if (!session) {
    return <Login />
  }

  if (needsPasswordSetup) {
    return <SetPassword onDone={() => setNeedsPasswordSetup(false)} />
  }

  // key forces CompanyProvider to reload from scratch if a different user
  // signs in without a full page refresh.
  return (
    <CompanyProvider key={session.user.id}>
      <AuthenticatedApp />
    </CompanyProvider>
  )
}

function AuthenticatedApp() {
  const {
    loading: companyLoading,
    error: companyError,
    availableCompanies,
    companyId,
    companyName,
    role,
    switchCompany,
  } = useCompany()

  async function logout() {
    await supabase.auth.signOut()
  }

  const [location, setLocation] = useState('ZC')
  const [period, setPeriod] = useState(currentPeriod())
  const [tab, setTab] = useState('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState([])
  const [stockPeriods, setStockPeriods] = useState([])
  const [purchases, setPurchases] = useState([])
  const [issues, setIssues] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [recipes, setRecipes] = useState([])
  const [recipeIngredients, setRecipeIngredients] = useState([])
  const [error, setError] = useState(null)
  // Purchase slip photos (2026-08-12) — keyed by purchase_slips.id, loaded
  // company-wide (not period-filtered, since a slip photo isn't tied to a
  // reporting period the way purchases are) for the "View slip" links and
  // the manual Attach flow.
  const [slips, setSlips] = useState({})
  const onSlipAttached = (slip) => { if (slip) setSlips((s) => ({ ...s, [slip.id]: slip })) }

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [itemsRes, spRes, purRes, issRes, supRes, recRes, ingRes, slipRes] = await Promise.all([
        sb.select('food_items', { company_id: companyId, location_id: location, active: true }, { order: 'category.asc,name.asc' }),
        sb.select('food_stock_periods', { company_id: companyId, location_id: location, period }, {}),
        sb.select('food_purchases', { company_id: companyId, location_id: location, period }, { order: 'date.asc' }),
        sb.select('food_issues', { company_id: companyId, location_id: location, period }, { order: 'date.asc' }),
        sb.select('food_suppliers', { company_id: companyId, location_id: location, active: true }, { order: 'name.asc' }),
        sb.select('food_recipes', { company_id: companyId, location_id: location, active: true }, { order: 'name.asc' }),
        sb.select('food_recipe_ingredients', { company_id: companyId }, { order: 'created_at.asc' }),
        sb.select('purchase_slips', { company_id: companyId, app: 'food' }, {}),
      ])
      setItems(itemsRes || [])
      setStockPeriods(spRes || [])
      setPurchases(purRes || [])
      setIssues(issRes || [])
      setSuppliers(supRes || [])
      setRecipes(recRes || [])
      setRecipeIngredients(ingRes || [])
      const slipMap = {}
      ;(slipRes || []).forEach((s) => { slipMap[s.id] = s })
      setSlips(slipMap)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, period, companyId])

  // ---------------------------------------------------------------------------
  // Local (optimistic) state updates — patch just the affected row(s) from
  // what the server handed back instead of re-fetching everything, so the
  // screen never blanks out behind a "Loading…" placeholder. Same approach
  // the beverage and ops apps use.
  // ---------------------------------------------------------------------------
  function upsertLocalStockPeriods(rows) {
    const list = Array.isArray(rows) ? rows : [rows]
    setStockPeriods((prev) => {
      const map = new Map(prev.map((sp) => [`${sp.item_id}|${sp.period}`, sp]))
      for (const row of list) map.set(`${row.item_id}|${row.period}`, row)
      return Array.from(map.values())
    })
  }

  function addLocalItem(row) {
    setItems((prev) => [...prev, row])
  }
  function updateLocalItem(row) {
    setItems((prev) => prev.map((it) => (it.id === row.id ? row : it)))
  }
  function removeLocalItem(id) {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }

  function addLocalSupplier(row) {
    setSuppliers((prev) => [...prev, row])
  }
  function updateLocalSupplier(row) {
    setSuppliers((prev) => prev.map((s) => (s.id === row.id ? row : s)))
  }
  function removeLocalSupplier(id) {
    setSuppliers((prev) => prev.filter((s) => s.id !== id))
  }

  function addLocalPurchase(row) {
    setPurchases((prev) => [...prev, row])
  }
  function updateLocalPurchase(row) {
    setPurchases((prev) => prev.map((p) => (p.id === row.id ? row : p)))
  }
  function removeLocalPurchase(id) {
    setPurchases((prev) => prev.filter((p) => p.id !== id))
  }

  function addLocalIssue(row) {
    setIssues((prev) => [...prev, row])
  }
  function removeLocalIssue(id) {
    setIssues((prev) => prev.filter((i) => i.id !== id))
  }

  function addLocalRecipe(row) {
    setRecipes((prev) => [...prev, row])
  }
  function removeLocalRecipe(id) {
    setRecipes((prev) => prev.filter((r) => r.id !== id))
    setRecipeIngredients((prev) => prev.filter((i) => i.recipe_id !== id))
  }
  function addLocalIngredient(row) {
    setRecipeIngredients((prev) => [...prev, row])
  }
  function removeLocalIngredient(id) {
    setRecipeIngredients((prev) => prev.filter((i) => i.id !== id))
  }

  const stockByItem = useMemo(() => {
    const map = {}
    for (const sp of stockPeriods) map[sp.item_id] = sp
    return map
  }, [stockPeriods])

  const purchasesByItem = useMemo(() => {
    const map = {}
    for (const p of purchases) (map[p.item_id] ||= []).push(p)
    return map
  }, [purchases])

  const issuesByItem = useMemo(() => {
    const map = {}
    for (const i of issues) (map[i.item_id] ||= []).push(i)
    return map
  }, [issues])

  const supplierById = useMemo(() => {
    const map = {}
    for (const s of suppliers) map[s.id] = s
    return map
  }, [suppliers])

  const ingredientsByRecipe = useMemo(() => {
    const map = {}
    for (const ing of recipeIngredients) (map[ing.recipe_id] ||= []).push(ing)
    return map
  }, [recipeIngredients])

  const metricsByItem = useMemo(() => {
    const map = {}
    for (const item of items) {
      map[item.id] = computeMetrics(
        item,
        stockByItem[item.id],
        purchasesByItem[item.id] || [],
        issuesByItem[item.id] || []
      )
    }
    return map
  }, [items, stockByItem, purchasesByItem, issuesByItem])

  const periodStarted = items.length > 0 && items.every((it) => stockByItem[it.id])
  const periodPartiallyStarted =
    items.length > 0 && items.some((it) => stockByItem[it.id]) && !periodStarted

  async function startPeriod() {
    const prior = prevPeriod(period)
    const [priorSP, priorPur, priorIss] = await Promise.all([
      sb.select('food_stock_periods', { company_id: companyId, location_id: location, period: prior }, {}),
      sb.select('food_purchases', { company_id: companyId, location_id: location, period: prior }, {}),
      sb.select('food_issues', { company_id: companyId, location_id: location, period: prior }, {}),
    ])
    const priorSPByItem = {}
    for (const sp of priorSP || []) priorSPByItem[sp.item_id] = sp
    const priorPurByItem = {}
    for (const p of priorPur || []) (priorPurByItem[p.item_id] ||= []).push(p)
    const priorIssByItem = {}
    for (const i of priorIss || []) (priorIssByItem[i.item_id] ||= []).push(i)

    const rows = items
      .filter((it) => !stockByItem[it.id])
      .map((it) => {
        const priorMetrics = computeMetrics(
          it,
          priorSPByItem[it.id],
          priorPurByItem[it.id] || [],
          priorIssByItem[it.id] || []
        )
        const openingUnits = priorMetrics.hasCount ? priorMetrics.closingCount : priorMetrics.theoreticalClosing
        return {
          company_id: companyId,
          item_id: it.id,
          location_id: location,
          period,
          opening_units: priorSPByItem[it.id] ? openingUnits : 0,
          opening_cost_per_unit: priorSPByItem[it.id] ? priorMetrics.weightedAvgCost : 0,
        }
      })
    if (rows.length) {
      const saved = await sb.upsert('food_stock_periods', rows, 'item_id,period')
      upsertLocalStockPeriods(saved || rows)
    }
  }

  async function closePeriod() {
    const rows = stockPeriods.map((sp) => ({ ...sp, closed: true }))
    if (rows.length) {
      const saved = await sb.upsert('food_stock_periods', rows, 'item_id,period')
      upsertLocalStockPeriods(saved || rows)
    }
  }

  const allClosed = stockPeriods.length > 0 && stockPeriods.every((sp) => sp.closed)

  // Company-access guards — placed here, after every hook above, rather
  // than before them: React requires the same hooks to run on every render
  // in the same order, so an early return can't come before a useState.
  if (companyLoading) {
    return (
      <AuthMessageScreen>
        <p>Loading your account…</p>
      </AuthMessageScreen>
    )
  }

  if (companyError) {
    return (
      <AuthMessageScreen>
        <p style={{ color: colors.danger, marginBottom: 12 }}>Could not load your company access: {companyError}</p>
        <button style={styles.button} onClick={logout}>
          Log out
        </button>
      </AuthMessageScreen>
    )
  }

  if (!companyId) {
    return (
      <AuthMessageScreen>
        <p style={{ marginBottom: 12 }}>
          Your account isn't linked to any company yet. Contact your administrator to get access.
        </p>
        <button style={styles.button} onClick={logout}>
          Log out
        </button>
      </AuthMessageScreen>
    )
  }

  const TABS = role === 'admin' ? ADMIN_TABS : STAFF_TABS
  const activeTab = TABS.some((t) => t.id === tab) ? tab : TABS[0].id

  return (
    <div className="shell">
      <style>{css}</style>

      {/* ── DESKTOP SIDEBAR — same shell/sidebar/nav pattern as Ops/Maintenance,
          tabs listed top-to-bottom on the left (2026-08-17). Hidden <=768px;
          the topbar + mobile-loc-bar + bottom-nav sheet below cover mobile. */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <img src="/logo.png" alt="" onError={(e) => (e.target.style.display = 'none')} />
          <div className="sidebar-sub">Food Stock</div>
          <div className="sidebar-company">{companyName}</div>
        </div>

        {availableCompanies.length > 1 && (
          <div className="sidebar-select-wrap">
            <select className="sidebar-select" value={companyId} onChange={(e) => switchCompany(e.target.value)}>
              {availableCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="loc-switcher">
          <div className="loc-label">Location</div>
          {LOCATIONS.map((l) => (
            <button
              key={l.id}
              className={`loc-btn${location === l.id ? ` active-${l.id}` : ''}`}
              onClick={() => setLocation(l.id)}
            >
              <span className="loc-dot" style={{ background: colors.loc[l.id] }} />
              {l.name}
            </button>
          ))}
        </div>

        <div className="period-wrap">
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{ ...styles.monthInput, width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-item${activeTab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span style={styles.badge('neutral')}>{role === 'admin' ? 'Admin' : 'Staff'}</span>
          <div className="sidebar-footer-row">
            <button className="sidebar-footer-btn" onClick={loadAll}>
              Refresh
            </button>
            <button className="sidebar-footer-btn" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="main">
        {/* Topbar — always visible, carries the account-level controls
            (company switcher, role, sign out) redundantly with the sidebar
            so they're still reachable once the sidebar hides on mobile. */}
        <div className="topbar">
          <div className="page-title">{companyName} — {TABS.find((t) => t.id === activeTab)?.label}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {availableCompanies.length > 1 && (
              <select className="topbar-select" value={companyId} onChange={(e) => switchCompany(e.target.value)}>
                {availableCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <span style={styles.badge('neutral')}>{role === 'admin' ? 'Admin' : 'Staff'}</span>
            <button className="topbar-signout" onClick={logout}>
              Log out
            </button>
          </div>
        </div>

        {/* Mobile-only location + period strip — sidebar already covers this
            on desktop. */}
        <div className="mobile-loc-bar">
          {LOCATIONS.map((l) => (
            <button
              key={l.id}
              className={`mobile-loc-btn${location === l.id ? ` active-${l.id}` : ''}`}
              onClick={() => setLocation(l.id)}
            >
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: colors.loc[l.id] }} />
              {l.id}
            </button>
          ))}
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="mobile-period-input"
            style={styles.monthInput}
          />
        </div>

      <div style={styles.content}>
        {error && (
          <div
            style={{
              ...styles.banner,
              background: 'rgba(192,88,88,0.12)',
              borderColor: colors.danger,
              color: colors.danger,
            }}
          >
            {error}
          </div>
        )}

        {!loading && !periodStarted && (
          <div style={styles.banner}>
            <span>
              {periodPartiallyStarted
                ? `${period} is only partly set up for ${location} — some items are missing opening stock.`
                : `${period} hasn't been started yet for ${location}. Opening stock will be carried forward from ${prevPeriod(
                    period
                  )}'s closing count (or 0 if that period has no data).`}
            </span>
            <button style={styles.button} onClick={startPeriod}>
              Start {period}
            </button>
          </div>
        )}

        {loading ? (
          <div style={{ padding: 20, color: colors.muted }}>Loading…</div>
        ) : (
          <>
            {activeTab === 'dashboard' && role === 'admin' && (
              <DashboardTab
                items={items}
                metricsByItem={metricsByItem}
                period={period}
                suppliers={suppliers}
                supplierById={supplierById}
              />
            )}
            {activeTab === 'items' && role === 'admin' && (
              <ItemsTab
                items={items}
                metricsByItem={metricsByItem}
                location={location}
                companyId={companyId}
                suppliers={suppliers}
                onAdd={addLocalItem}
                onUpdate={updateLocalItem}
                onRemove={removeLocalItem}
              />
            )}
            {activeTab === 'suppliers' && role === 'admin' && (
              <SuppliersTab
                suppliers={suppliers}
                location={location}
                companyId={companyId}
                onAdd={addLocalSupplier}
                onUpdate={updateLocalSupplier}
                onRemove={removeLocalSupplier}
              />
            )}
            {activeTab === 'menu' && role === 'admin' && (
              <MenuTab
                items={items}
                metricsByItem={metricsByItem}
                location={location}
                companyId={companyId}
                recipes={recipes}
                ingredientsByRecipe={ingredientsByRecipe}
                onAddRecipe={addLocalRecipe}
                onRemoveRecipe={removeLocalRecipe}
                onAddIngredient={addLocalIngredient}
                onRemoveIngredient={removeLocalIngredient}
              />
            )}
            {activeTab === 'opening' && role === 'admin' && (
              <OpeningTab
                items={items}
                stockByItem={stockByItem}
                metricsByItem={metricsByItem}
                location={location}
                period={period}
                onSave={upsertLocalStockPeriods}
              />
            )}
            {activeTab === 'purchases' && role === 'admin' && (
              <PurchasesTab
                items={items}
                purchases={purchases}
                suppliers={suppliers}
                location={location}
                companyId={companyId}
                period={period}
                onAdd={addLocalPurchase}
                onUpdate={updateLocalPurchase}
                onRemove={removeLocalPurchase}
                slips={slips}
                onSlipAttached={onSlipAttached}
              />
            )}
            {activeTab === 'issues' && (
              <IssuesTab
                items={items}
                issues={issues}
                location={location}
                companyId={companyId}
                period={period}
                onAdd={addLocalIssue}
                onRemove={removeLocalIssue}
              />
            )}
            {activeTab === 'count' && (
              <CountTab
                items={items}
                stockByItem={stockByItem}
                metricsByItem={metricsByItem}
                location={location}
                companyId={companyId}
                period={period}
                role={role}
                onSave={upsertLocalStockPeriods}
                onLinkItem={updateLocalItem}
              />
            )}
            {activeTab === 'variance' && role === 'admin' && (
              <VarianceTab
                items={items}
                metricsByItem={metricsByItem}
                allClosed={allClosed}
                onClosePeriod={closePeriod}
              />
            )}
            {activeTab === 'orders' && role === 'admin' && (
              <OrdersTab
                items={items}
                metricsByItem={metricsByItem}
                suppliers={suppliers}
                supplierById={supplierById}
                recipes={recipes}
                ingredientsByRecipe={ingredientsByRecipe}
              />
            )}
          </>
        )}
      </div>

        <div className="bottom-nav">
          <button style={styles.navMenuButton} onClick={() => setMenuOpen(true)}>
            <span>☰</span>
            <span>{TABS.find((t) => t.id === activeTab)?.label || 'Menu'}</span>
          </button>
        </div>

        {menuOpen && (
          <div style={styles.navOverlay} onClick={() => setMenuOpen(false)}>
            <div style={styles.navSheet} onClick={(e) => e.stopPropagation()}>
              <div style={styles.navSheetHeader}>
                <span style={styles.navSheetTitle}>Menu</span>
                <button style={styles.navSheetClose} onClick={() => setMenuOpen(false)}>
                  Close
                </button>
              </div>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  style={styles.navSheetItem(activeTab === t.id)}
                  onClick={() => {
                    setTab(t.id)
                    setMenuOpen(false)
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard tab — Admin only: stock value, supplier breakdown, and which
// items are moving fastest / not at all this period.
// ---------------------------------------------------------------------------

function DashboardTab({ items, metricsByItem, period, suppliers, supplierById }) {
  const totals = useMemo(() => aggregateValues(items, metricsByItem), [items, metricsByItem])
  const bySupplier = useMemo(() => aggregateBySupplier(items, metricsByItem), [items, metricsByItem])
  const supplierRows = useMemo(() => {
    const rows = Object.entries(bySupplier).map(([key, vals]) => ({
      key,
      name: key === UNASSIGNED_SUPPLIER ? 'Unassigned' : supplierById[key]?.name || 'Unknown supplier',
      ...vals,
    }))
    rows.sort((a, b) => {
      if (a.key === UNASSIGNED_SUPPLIER) return 1
      if (b.key === UNASSIGNED_SUPPLIER) return -1
      return b.actualValue - a.actualValue
    })
    return rows
  }, [bySupplier, supplierById])

  const ranked = useMemo(
    () =>
      items
        .map((it) => ({ item: it, m: metricsByItem[it.id] }))
        .filter((x) => x.m)
        .sort((a, b) => b.m.serviceUnits - a.m.serviceUnits),
    [items, metricsByItem]
  )
  const fastest = ranked.filter((x) => x.m.serviceUnits > 0).slice(0, 10)
  const notMoving = ranked.filter((x) => x.m.serviceUnits <= 0)

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Stock value — {period}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}></th>
              <th style={styles.th}>Expected value</th>
              <th style={styles.th}>Actual (counted) value</th>
              <th style={styles.th}>Usage this period</th>
              <th style={styles.th}>Write-offs logged</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={styles.td}>
                <strong>Total</strong>
              </td>
              <td style={styles.tdNum}>
                <strong>R {fmt(totals.theoreticalValue)}</strong>
              </td>
              <td style={styles.tdNum}>
                <strong>R {fmt(totals.actualValue)}</strong>
              </td>
              <td style={styles.tdNum}>
                <strong>R {fmt(totals.serviceValue)}</strong>
              </td>
              <td style={styles.tdNum}>
                <span style={styles.badge(totals.writeOffValue > 0 ? 'bad' : 'neutral')}>
                  R {fmt(totals.writeOffValue)}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
          "Usage this period" is 'Service' issues logged on the Issues tab — usage is now an input,
          not something worked out after the fact. "Write-offs logged" is everything else logged
          there (breakage, expired stock, staff usage, other). The physical count checks the log via
          the Usage tab's Variance column, rather than defining usage itself —{' '}
          {totals.countedItems} of {items.length} items have a count this period.
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>By supplier — {period}</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          "Usage" is 'Service' issues logged on the Issues tab, rolled up by the supplier of each
          item. "Write-offs" is everything else logged there — breakage, expired stock, staff usage,
          other.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Items</th>
              <th style={styles.th}>Stock value</th>
              <th style={styles.th}>Usage (qty)</th>
              <th style={styles.th}>Usage (value)</th>
              <th style={styles.th}>Write-offs (qty)</th>
              <th style={styles.th}>Write-offs (value)</th>
            </tr>
          </thead>
          <tbody>
            {supplierRows.map((row) => (
              <tr key={row.key}>
                <td style={styles.td}>{row.name}</td>
                <td style={styles.tdNum}>{row.itemCount}</td>
                <td style={styles.tdNum}>R {fmt(row.actualValue)}</td>
                <td style={styles.tdNum}>{fmt(row.serviceUnits, 1)}</td>
                <td style={styles.tdNum}>R {fmt(row.serviceValue)}</td>
                <td style={styles.tdNum}>{fmt(row.writeOffUnits, 1)}</td>
                <td style={styles.tdNum}>
                  {row.writeOffValue > 0 ? (
                    <span style={styles.badge('bad')}>R {fmt(row.writeOffValue)}</span>
                  ) : (
                    `R ${fmt(row.writeOffValue)}`
                  )}
                </td>
              </tr>
            ))}
            {supplierRows.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={7}>
                  No suppliers linked yet — add suppliers and link items to them on the Suppliers and
                  Items tabs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Highest usage this period</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
          Ranked by 'Service' issues logged on the Issues tab.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Qty used</th>
              <th style={styles.th}>Value used</th>
            </tr>
          </thead>
          <tbody>
            {fastest.map(({ item, m }) => (
              <tr key={item.id}>
                <td style={styles.td}>{item.name}</td>
                <td style={styles.td}>{item.category}</td>
                <td style={styles.tdNum}>{fmt(m.serviceUnits, 1)}</td>
                <td style={styles.tdNum}>R {fmt(m.serviceValue)}</td>
              </tr>
            ))}
            {fastest.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={4}>
                  No usage logged yet this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>No usage logged this period ({notMoving.length})</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
          No 'Service' issues logged yet — candidates to reconsider on the menu, or worth a check on
          the Issues tab if they should have moved.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Category</th>
            </tr>
          </thead>
          <tbody>
            {notMoving.map(({ item }) => (
              <tr key={item.id}>
                <td style={styles.td}>{item.name}</td>
                <td style={styles.td}>{item.category}</td>
              </tr>
            ))}
            {notMoving.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={2}>
                  Nothing yet this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Items tab — manage the food master list for the selected lodge.
//
// Two units per item: purchase_unit (what you buy/count/order in) and
// recipe_unit (what recipes measure in), linked by conversion_factor
// (recipe_units per 1 purchase_unit). Defaults to the same unit both sides
// with factor 1 — set the real conversion when you first use an item in a
// recipe on the Menu tab.
// ---------------------------------------------------------------------------

function ItemsTab({ items, metricsByItem, location, companyId, suppliers, onAdd, onUpdate, onRemove }) {
  const [form, setForm] = useState({
    name: '',
    category: 'Dry- and other stock',
    purchase_unit: 'kg',
    recipe_unit: 'kg',
    conversion_factor: 1,
    supplier_id: '',
    min_units: 0,
    max_units: 0,
    order_pack_size: 1,
    order_pack_label: '',
  })
  const [saving, setSaving] = useState(false)

  async function addItem() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('food_items', {
      ...form,
      company_id: companyId,
      supplier_id: form.supplier_id || null,
      location_id: location,
      order_pack_size: Number(form.order_pack_size) || 1,
      order_pack_label: form.order_pack_label || null,
    })
    setForm({
      name: '',
      category: 'Dry- and other stock',
      purchase_unit: 'kg',
      recipe_unit: 'kg',
      conversion_factor: 1,
      supplier_id: '',
      min_units: 0,
      max_units: 0,
      order_pack_size: 1,
      order_pack_label: '',
    })
    setSaving(false)
    onAdd(row)
  }

  async function updateItem(id, patch) {
    const [row] = await sb.update('food_items', { id }, patch)
    onUpdate(row)
  }

  async function deactivate(id) {
    await sb.update('food_items', { id }, { active: false })
    onRemove(id)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Add item</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Name</label>
            <input style={styles.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Category</label>
            <input style={styles.input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Purchase unit</label>
            <select
              style={styles.input}
              value={form.purchase_unit}
              onChange={(e) => setForm({ ...form, purchase_unit: e.target.value })}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Recipe unit</label>
            <select
              style={styles.input}
              value={form.recipe_unit}
              onChange={(e) => setForm({ ...form, recipe_unit: e.target.value })}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Recipe units per purchase unit</label>
            <input
              type="number"
              style={styles.input}
              value={form.conversion_factor}
              onChange={(e) => setForm({ ...form, conversion_factor: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Supplier</label>
            <select
              style={styles.input}
              value={form.supplier_id}
              onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
            >
              <option value="">No supplier</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Min units</label>
            <input
              type="number"
              style={styles.input}
              value={form.min_units}
              onChange={(e) => setForm({ ...form, min_units: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Max units</label>
            <input
              type="number"
              style={styles.input}
              value={form.max_units}
              onChange={(e) => setForm({ ...form, max_units: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Order pack size (purchase units per pack)</label>
            <input
              type="number"
              style={styles.input}
              value={form.order_pack_size}
              onChange={(e) => setForm({ ...form, order_pack_size: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Pack label (optional, e.g. "6-pack")</label>
            <input
              style={styles.input}
              value={form.order_pack_label}
              onChange={(e) => setForm({ ...form, order_pack_label: e.target.value })}
            />
          </div>
        </div>
        <button style={styles.button} onClick={addItem} disabled={saving}>
          {saving ? 'Adding…' : 'Add item'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>{items.length} active items</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Min/Max reorder levels default to 0 (no alert) since food items vary hugely in scale — set
          real thresholds per item as you go.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Purchase unit</th>
              <th style={styles.th}>Recipe unit</th>
              <th style={styles.th}>Recipe units/purchase</th>
              <th style={styles.th}>Order pack size</th>
              <th style={styles.th}>Pack label</th>
              <th style={styles.th}>Barcode</th>
              <th style={styles.th}>Min</th>
              <th style={styles.th}>Max</th>
              <th style={styles.th}>W/Avg cost</th>
              <th style={styles.th}>Stock value</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const m = metricsByItem?.[it.id]
              const currentUnits = m ? (m.hasCount ? m.closingCount : m.theoreticalClosing) : null
              const currentValue = m ? currentUnits * m.weightedAvgCost : null
              return (
                <tr key={it.id}>
                  <td style={styles.td}>{it.name}</td>
                  <td style={styles.td}>{it.category}</td>
                  <td style={styles.td}>
                    <select
                      style={styles.smallInput}
                      defaultValue={it.supplier_id || ''}
                      onChange={(e) => updateItem(it.id, { supplier_id: e.target.value || null })}
                    >
                      <option value="">No supplier</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={styles.td}>
                    <select
                      style={styles.smallInput}
                      defaultValue={it.purchase_unit || 'ea'}
                      onChange={(e) => updateItem(it.id, { purchase_unit: e.target.value })}
                    >
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={styles.td}>
                    <select
                      style={styles.smallInput}
                      defaultValue={it.recipe_unit || 'ea'}
                      onChange={(e) => updateItem(it.id, { recipe_unit: e.target.value })}
                    >
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={styles.td}>
                    <input
                      type="number"
                      style={styles.smallInput}
                      defaultValue={it.conversion_factor ?? 1}
                      onBlur={(e) => updateItem(it.id, { conversion_factor: Number(e.target.value) || 1 })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="number"
                      style={styles.smallInput}
                      defaultValue={it.order_pack_size ?? 1}
                      onBlur={(e) => updateItem(it.id, { order_pack_size: Number(e.target.value) || 1 })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="text"
                      style={styles.smallInput}
                      defaultValue={it.order_pack_label || ''}
                      placeholder="e.g. 6-pack"
                      onBlur={(e) => updateItem(it.id, { order_pack_label: e.target.value.trim() || null })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="text"
                      style={{ ...styles.smallInput, width: 130, fontFamily: fonts.mono }}
                      defaultValue={it.barcode || ''}
                      placeholder="unlinked"
                      onBlur={(e) => updateItem(it.id, { barcode: e.target.value.trim() || null })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="number"
                      style={styles.smallInput}
                      defaultValue={it.min_units}
                      onBlur={(e) => updateItem(it.id, { min_units: Number(e.target.value) })}
                    />
                  </td>
                  <td style={styles.td}>
                    <input
                      type="number"
                      style={styles.smallInput}
                      defaultValue={it.max_units}
                      onBlur={(e) => updateItem(it.id, { max_units: Number(e.target.value) })}
                    />
                  </td>
                  <td style={styles.tdNum}>{m ? `R ${fmt(m.weightedAvgCost)}` : '—'}</td>
                  <td style={styles.tdNum}>{m ? `R ${fmt(currentValue)}` : '—'}</td>
                  <td style={styles.td}>
                    <button style={styles.buttonDanger} onClick={() => deactivate(it.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Suppliers tab — manage the supplier list for the selected lodge, linked
// to items via food_items.supplier_id.
// ---------------------------------------------------------------------------

function SuppliersTab({ suppliers, location, companyId, onAdd, onUpdate, onRemove }) {
  const [form, setForm] = useState({ name: '', contact_name: '', phone: '', email: '', notes: '' })
  const [saving, setSaving] = useState(false)

  async function addSupplier() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('food_suppliers', { ...form, company_id: companyId, location_id: location })
    setForm({ name: '', contact_name: '', phone: '', email: '', notes: '' })
    setSaving(false)
    onAdd(row)
  }

  async function updateSupplier(id, patch) {
    const [row] = await sb.update('food_suppliers', { id }, patch)
    onUpdate(row)
  }

  async function deactivate(id) {
    await sb.update('food_suppliers', { id }, { active: false })
    onRemove(id)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Add supplier</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Name</label>
            <input style={styles.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Contact name</label>
            <input
              style={styles.input}
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Phone</label>
            <input style={styles.input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Email</label>
            <input style={styles.input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Notes</label>
            <input style={styles.input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={addSupplier} disabled={saving}>
          {saving ? 'Adding…' : 'Add supplier'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>{suppliers.length} suppliers</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Contact</th>
              <th style={styles.th}>Phone</th>
              <th style={styles.th}>Email</th>
              <th style={styles.th}>Notes</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td style={styles.td}>{s.name}</td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 130 }}
                    defaultValue={s.contact_name || ''}
                    onBlur={(e) => updateSupplier(s.id, { contact_name: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 110 }}
                    defaultValue={s.phone || ''}
                    onBlur={(e) => updateSupplier(s.id, { phone: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 160 }}
                    defaultValue={s.email || ''}
                    onBlur={(e) => updateSupplier(s.id, { email: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 160 }}
                    defaultValue={s.notes || ''}
                    onBlur={(e) => updateSupplier(s.id, { notes: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => deactivate(s.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={6}>
                  No suppliers yet — add one above, then link items to it from the Items tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Opening tab — set/correct opening stock units and opening cost per unit
// for the current period.
// ---------------------------------------------------------------------------

function OpeningTab({ items, stockByItem, metricsByItem, location, period, onSave }) {
  async function saveOpening(item, field, value) {
    const sp = stockByItem[item.id]
    if (!sp) return
    const saved = await sb.upsert(
      'food_stock_periods',
      {
        item_id: item.id,
        location_id: location,
        period,
        opening_units: field === 'opening_units' ? Number(value || 0) : sp.opening_units,
        opening_cost_per_unit:
          field === 'opening_cost_per_unit' ? Number(value || 0) : sp.opening_cost_per_unit,
        closing_count_units: sp.closing_count_units,
        counted_by: sp.counted_by,
        count_date: sp.count_date,
        closed: sp.closed,
      },
      'item_id,period'
    )
    onSave(saved?.[0] || { ...sp, [field]: Number(value || 0) })
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Opening stock — {period}</div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        These values feed the weighted-average cost and theoretical closing stock for this period
        (in each item's purchase unit). "Start {period}" has to be run first (see the banner above)
        before an item shows up here as editable.
      </div>
      <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Item</th>
            <th style={styles.th}>Opening units</th>
            <th style={styles.th}>Opening cost/unit</th>
            <th style={styles.th}>Current W/Avg cost</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const sp = stockByItem[it.id]
            const m = metricsByItem[it.id]
            return (
              <tr key={it.id}>
                <td style={styles.td}>{it.name}</td>
                <td style={styles.td}>
                  <input
                    type="number"
                    style={styles.smallInput}
                    defaultValue={sp?.opening_units ?? ''}
                    disabled={!sp || sp.closed}
                    onBlur={(e) => saveOpening(it, 'opening_units', e.target.value)}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    type="number"
                    style={styles.smallInput}
                    defaultValue={sp?.opening_cost_per_unit ?? ''}
                    disabled={!sp || sp.closed}
                    onBlur={(e) => saveOpening(it, 'opening_cost_per_unit', e.target.value)}
                  />
                </td>
                <td style={styles.tdNum}>{m ? `R ${fmt(m.weightedAvgCost)}` : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scan a slip — photograph or upload a purchase slip, let /api/parse-slip
// (Anthropic vision, server-side) read the line items, then a person
// reviews/corrects the list before anything is saved. Nothing here writes
// to the database until "Approve & save" is pressed — the AI only ever
// proposes a draft. Quantities are read in whatever unit the slip shows
// them in — check each row against the item's purchase unit (shown in the
// Items tab) before approving, since the AI can't know your unit
// conventions from the photo alone.
// ---------------------------------------------------------------------------

function SlipScanCard({ items, location, companyId, onApproved, onSlipAttached }) {
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const [review, setReview] = useState(null) // { date, supplier, rows: [...] }
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const fileInputRef = useRef(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file again next time
    if (!file) return
    setScanError('')
    setSaveStatus('')
    setScanning(true)
    try {
      const resized = await resizeImageFile(file)
      const base64 = await blobToBase64(resized)
      const res = await fetch('/api/parse-slip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, media_type: 'image/jpeg' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not read that slip.')

      const pricesIncludeVat =
        typeof data.amounts_include_vat_guess === 'boolean' ? data.amounts_include_vat_guess : true
      const vatRate = data.vat_rate_guess ?? 15

      const rowsRaw = (data.line_items || []).map((li, idx) => {
        const itemMatch = findBestMatch(li.raw_text, items, 'name')
        const rawTotal = li.total_price ?? (li.unit_price && li.qty ? li.unit_price * li.qty : 0)
        return {
          key: idx,
          raw_text: li.raw_text,
          item_id: itemMatch.confident ? itemMatch.match.id : '',
          confident: itemMatch.confident,
          guessName: itemMatch.match?.name || '',
          qty: li.qty ?? 1,
          raw_total: rawTotal,
          total_cost: rawTotal,
          skip: false,
        }
      })

      setReview({
        date: data.date_guess || new Date().toISOString().slice(0, 10),
        supplier: data.supplier_guess || '',
        slipTotal: data.slip_total ?? null,
        pricesIncludeVat,
        vatRate,
        rows: applyVatToRows(rowsRaw, pricesIncludeVat, vatRate),
        photoBlob: resized,
      })
    } catch (err) {
      setScanError(err.message || 'Something went wrong reading that slip.')
    } finally {
      setScanning(false)
    }
  }

  function updateRow(key, patch) {
    setReview((r) => ({ ...r, rows: r.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) }))
  }

  function setPricesIncludeVat(val) {
    setReview((r) => ({ ...r, pricesIncludeVat: val, rows: applyVatToRows(r.rows, val, r.vatRate) }))
  }

  function setVatRate(val) {
    setReview((r) => ({ ...r, vatRate: val, rows: applyVatToRows(r.rows, r.pricesIncludeVat, val) }))
  }

  function cancelReview() {
    setReview(null)
    setScanError('')
    setSaveStatus('')
  }

  async function approve() {
    const toSave = review.rows.filter((r) => !r.skip && r.item_id && Number(r.qty) > 0)
    if (toSave.length === 0) {
      setSaveStatus('Nothing to save — pick an item for at least one line, or cancel.')
      return
    }
    setSaving(true)
    setSaveStatus('')
    try {
      // Upload the photo first — that's the actual compliance record, and
      // it's independent of whichever items got matched below.
      const slip = await uploadPurchaseSlip({
        companyId,
        locationId: location,
        blob: review.photoBlob,
        supplierGuess: review.supplier,
        dateGuess: review.date,
        slipTotalGuess: review.slipTotal,
      })
      const payload = toSave.map((r) => ({
        company_id: companyId,
        item_id: r.item_id,
        location_id: location,
        period: toPeriod(review.date),
        date: review.date,
        units: Number(r.qty),
        total_cost_excl_vat: Number(r.total_cost) || 0,
        supplier: review.supplier || '',
        slip_id: slip.id,
      }))
      const saved = await sb.insert('food_purchases', payload)
      onApproved(saved || [])
      onSlipAttached(slip)
      setSaveStatus(`Saved ${saved?.length || toSave.length} purchase${(saved?.length || toSave.length) === 1 ? '' : 's'} and attached the slip photo.`)
      setReview(null)
    } catch (err) {
      setSaveStatus(`Could not save: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const itemUnit = (id) => items.find((i) => i.id === id)?.purchase_unit || ''

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between' }}>
        <div style={styles.cardTitle}>Scan a purchase slip</div>
        {!review && (
          <button style={styles.buttonGhost} onClick={() => fileInputRef.current?.click()} disabled={scanning}>
            {scanning ? 'Reading slip…' : 'Scan / photograph slip'}
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      {!review && (
        <div style={{ fontSize: 12, color: colors.muted }}>
          Take a photo (or upload one) of a supplier delivery slip or invoice — the item list, quantities, and
          prices below are read automatically. Nothing is saved until you check the list and press Approve.
        </div>
      )}
      {scanError && <div style={{ color: colors.danger, fontSize: 12, marginTop: 8 }}>{scanError}</div>}

      {review && (
        <div style={{ marginTop: 10 }}>
          <div style={styles.formGrid}>
            <div>
              <label style={styles.label}>Date</label>
              <input
                type="date"
                style={styles.input}
                value={review.date}
                onChange={(e) => setReview({ ...review, date: e.target.value })}
              />
            </div>
            <div>
              <label style={styles.label}>Supplier</label>
              <input
                style={styles.input}
                value={review.supplier}
                onChange={(e) => setReview({ ...review, supplier: e.target.value })}
              />
            </div>
            <div>
              <label style={styles.label}>Slip prices</label>
              <select
                style={styles.input}
                value={review.pricesIncludeVat ? 'incl' : 'excl'}
                onChange={(e) => setPricesIncludeVat(e.target.value === 'incl')}
              >
                <option value="incl">Include VAT</option>
                <option value="excl">Already exclude VAT</option>
              </select>
            </div>
            {review.pricesIncludeVat && (
              <div>
                <label style={styles.label}>VAT rate %</label>
                <input
                  type="number"
                  style={styles.input}
                  value={review.vatRate}
                  onChange={(e) => setVatRate(e.target.value)}
                />
              </div>
            )}
          </div>

          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
            {review.rows.length} line{review.rows.length === 1 ? '' : 's'} read from the slip. Green = matched
            automatically — check it's right. Amber = needs a person to pick the item, or tick Skip to leave it
            out. Double-check quantities are in each item's purchase unit before approving. This app stores
            purchase costs <strong>excl. VAT</strong> — "Total cost" below is already the VAT-stripped figure
            that gets saved; change "Slip prices" or the VAT rate above if it doesn't look right, and every row
            recalculates. Editing a row's total cost by hand overrides that row only, until the VAT settings
            change again.
            {review.slipTotal != null && (
              <>
                {' '}Slip total as printed: R {fmt(review.slipTotal)}.
              </>
            )}
          </div>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>On slip</th>
                  <th style={styles.th}>Item</th>
                  <th style={styles.th}>Qty</th>
                  <th style={styles.th}>Unit</th>
                  <th style={styles.th}>Total cost (excl. VAT)</th>
                  <th style={styles.th}>Skip</th>
                </tr>
              </thead>
              <tbody>
                {review.rows.map((row) => (
                  <tr key={row.key} style={row.skip ? { opacity: 0.45 } : undefined}>
                    <td style={styles.td}>
                      {row.raw_text}
                      <div>
                        <span style={styles.badge(row.confident ? 'good' : 'bad')}>
                          {row.confident ? 'Matched' : 'Check this'}
                        </span>
                      </div>
                    </td>
                    <td style={styles.td}>
                      <select
                        style={{ ...styles.smallInput, width: 170 }}
                        value={row.item_id}
                        onChange={(e) => updateRow(row.key, { item_id: e.target.value })}
                      >
                        <option value="">
                          {row.guessName ? `Select item… (AI guess: ${row.guessName})` : 'Select item…'}
                        </option>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={{ ...styles.smallInput, width: 70 }}
                        value={row.qty}
                        onChange={(e) => updateRow(row.key, { qty: e.target.value })}
                      />
                    </td>
                    <td style={styles.td}>{itemUnit(row.item_id) || '—'}</td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={{ ...styles.smallInput, width: 90 }}
                        value={row.total_cost}
                        onChange={(e) => updateRow(row.key, { total_cost: e.target.value })}
                      />
                      {review.pricesIncludeVat && (
                        <div style={{ fontSize: 10, color: colors.muted, marginTop: 2 }}>
                          as printed: R {fmt(row.raw_total)}
                        </div>
                      )}
                    </td>
                    <td style={styles.td}>
                      <input
                        type="checkbox"
                        checked={row.skip}
                        onChange={(e) => updateRow(row.key, { skip: e.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
                {review.rows.length === 0 && (
                  <tr>
                    <td style={styles.td} colSpan={6}>
                      Nothing readable was found on that photo — try again with better lighting, or log purchases
                      manually below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>
            Sum of approved lines (excl. VAT): R{' '}
            {fmt(review.rows.filter((r) => !r.skip && r.item_id).reduce((s, r) => s + Number(r.total_cost || 0), 0))}
          </div>

          <div style={{ ...styles.row, justifyContent: 'space-between', marginTop: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: colors.muted }}>{saveStatus}</div>
            <div style={styles.row}>
              <button style={styles.buttonGhost} onClick={cancelReview} disabled={saving}>
                Cancel
              </button>
              <button style={styles.button} onClick={approve} disabled={saving}>
                {saving ? 'Saving…' : 'Approve & save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Manual fallback for when the scanner can't read a slip (or wasn't used) —
// just uploads the photo and links it, no OCR. Used both for a brand-new
// hand-entered purchase (attaches while saving) and for an already-saved
// purchase row that didn't get a slip at the time (attaches after the fact).
function AttachSlipButton({ companyId, locationId, purchaseId, onAttached, label = 'Attach slip' }) {
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)
  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const resized = await resizeImageFile(file)
      const slip = await uploadPurchaseSlip({ companyId, locationId, blob: resized })
      if (purchaseId) await sb.update('food_purchases', { id: purchaseId }, { slip_id: slip.id })
      onAttached(slip, purchaseId)
    } catch (err) {
      alert('Could not attach the slip: ' + err.message)
    } finally {
      setUploading(false)
    }
  }
  return (
    <>
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFile} />
      <button style={styles.buttonGhost} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
        {uploading ? 'Uploading…' : label}
      </button>
    </>
  )
}

function ViewSlipLink({ storagePath }) {
  const [loading, setLoading] = useState(false)
  async function open() {
    setLoading(true)
    try {
      const url = await getSlipUrl(storagePath)
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      alert('Could not open the slip: ' + err.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button style={styles.buttonGhost} onClick={open} disabled={loading}>
      {loading ? '…' : 'View slip'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Purchases tab
// ---------------------------------------------------------------------------

function PurchasesTab({ items, purchases, suppliers, location, companyId, period, onAdd, onUpdate, onRemove, slips, onSlipAttached }) {
  const [form, setForm] = useState({
    item_id: items[0]?.id || '',
    date: new Date().toISOString().slice(0, 10),
    units: '',
    packs: '',
    total_cost_excl_vat: '',
    supplier: '',
    pendingSlipBlob: null,
    pendingSlipName: '',
  })
  const [saving, setSaving] = useState(false)

  // Order/delivery packs (2026-08-17) — a supplier slip usually lists "qty
  // 2" meaning 2 six-packs, not 2 cans. order_pack_size on the item (set on
  // the Items tab) is how many purchase_units are in one delivered pack;
  // typing a Packs count here just multiplies into the real Units field
  // that's actually stored — Units stays the source of truth so nothing
  // downstream (usage/variance) needs to know packs exist. Direct edits to
  // Units still work as before for items with no pack size set.
  const selectedItem = items.find((i) => i.id === form.item_id)
  const packSize = Number(selectedItem?.order_pack_size || 1)

  async function pickSlipFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const resized = await resizeImageFile(file)
    setForm((f) => ({ ...f, pendingSlipBlob: resized, pendingSlipName: file.name }))
  }

  async function addPurchase() {
    if (!form.item_id || !form.units) return
    setSaving(true)
    try {
      let slipId = null
      if (form.pendingSlipBlob) {
        const slip = await uploadPurchaseSlip({ companyId, locationId: location, blob: form.pendingSlipBlob })
        slipId = slip.id
        onSlipAttached(slip)
      }
      const [row] = await sb.insert('food_purchases', {
        company_id: companyId,
        item_id: form.item_id,
        location_id: location,
        period: toPeriod(form.date),
        date: form.date,
        units: Number(form.units),
        total_cost_excl_vat: Number(form.total_cost_excl_vat || 0),
        supplier: form.supplier,
        slip_id: slipId,
      })
      setForm({ ...form, units: '', packs: '', total_cost_excl_vat: '', supplier: '', pendingSlipBlob: null, pendingSlipName: '' })
      onAdd(row)
    } finally {
      setSaving(false)
    }
  }

  async function removePurchase(id) {
    await sb.remove('food_purchases', { id })
    onRemove(id)
  }

  const itemName = (id) => items.find((i) => i.id === id)?.name || '—'
  const itemUnit = (id) => items.find((i) => i.id === id)?.purchase_unit || ''

  return (
    <>
      <SlipScanCard
        items={items}
        location={location}
        companyId={companyId}
        onApproved={(rows) => rows.forEach(onAdd)}
        onSlipAttached={onSlipAttached}
      />

      <div style={styles.card}>
        <div style={styles.cardTitle}>Log a purchase manually</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Units are in the item's purchase unit (shown in the Items tab).
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Item</label>
            <select style={styles.input} value={form.item_id} onChange={(e) => setForm({ ...form, item_id: e.target.value })}>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name} ({it.purchase_unit})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Date</label>
            <input type="date" style={styles.input} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          {packSize > 1 && (
            <div>
              <label style={styles.label}>
                Packs ({selectedItem.order_pack_label || `${packSize}-pack`})
              </label>
              <input
                type="number"
                style={styles.input}
                value={form.packs}
                onChange={(e) => {
                  const packs = e.target.value
                  setForm((f) => ({
                    ...f,
                    packs,
                    units: packs === '' ? f.units : String(Number(packs) * packSize),
                  }))
                }}
              />
            </div>
          )}
          <div>
            <label style={styles.label}>Units ({itemUnit(form.item_id) || '—'})</label>
            <input
              type="number"
              style={styles.input}
              value={form.units}
              onChange={(e) => setForm({ ...form, units: e.target.value, packs: '' })}
            />
          </div>
          <div>
            <label style={styles.label}>Total cost (excl. VAT)</label>
            <input
              type="number"
              style={styles.input}
              value={form.total_cost_excl_vat}
              onChange={(e) => setForm({ ...form, total_cost_excl_vat: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Supplier</label>
            <select style={styles.input} value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })}>
              <option value="">Select supplier…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={styles.label}>Slip photo (optional — use if you didn't use Scan above)</label>
          <input type="file" accept="image/*" capture="environment" onChange={pickSlipFile} />
          {form.pendingSlipName && (
            <div style={{ fontSize: 11, color: colors.ok, marginTop: 4 }}>Attached: {form.pendingSlipName}</div>
          )}
        </div>
        <button style={styles.button} onClick={addPurchase} disabled={saving}>
          {saving ? 'Saving…' : 'Add purchase'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Purchases in {period}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Units</th>
              <th style={styles.th}>Cost</th>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Slip</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id}>
                <td style={styles.td}>{p.date}</td>
                <td style={styles.td}>{itemName(p.item_id)}</td>
                <td style={styles.tdNum}>{fmt(p.units, 1)}</td>
                <td style={styles.tdNum}>{fmt(p.total_cost_excl_vat)}</td>
                <td style={styles.td}>{p.supplier || '—'}</td>
                <td style={styles.td}>
                  {p.slip_id && slips[p.slip_id] ? (
                    <ViewSlipLink storagePath={slips[p.slip_id].storage_path} />
                  ) : (
                    <AttachSlipButton
                      companyId={companyId}
                      locationId={location}
                      purchaseId={p.id}
                      onAttached={(slip) => { onSlipAttached(slip); onUpdate({ ...p, slip_id: slip.id }) }}
                    />
                  )}
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => removePurchase(p.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {purchases.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={7}>
                  No purchases logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Issues tab — log everything stock leaves for: normal kitchen use
// ('Service') as well as write-offs (Breakage/Expired/Staff/Other). This
// log is now the input the Usage tab uses to work out expected stock —
// same model as the beverage app's Issues tab.
// ---------------------------------------------------------------------------

function IssuesTab({ items, issues, location, companyId, period, onAdd, onRemove }) {
  const [form, setForm] = useState({
    item_id: '',
    date: new Date().toISOString().slice(0, 10),
    qty: '',
    reason: ISSUE_REASONS[0],
    note: '',
  })
  const [saving, setSaving] = useState(false)

  // Category-then-item picker (2026-08-17) — the item list got too long to
  // scroll through directly, so pick a category first (same two-step
  // pattern used for materials in the Maintenance app) and only then choose
  // from items within it.
  const [category, setCategory] = useState('')
  const categories = useMemo(() => [...new Set(items.map((it) => it.category).filter(Boolean))].sort(), [items])
  const uncategorisedCount = items.filter((it) => !it.category).length
  const itemsInCat = category ? items.filter((it) => (category === '__none__' ? !it.category : it.category === category)) : []

  async function addIssue() {
    if (!form.item_id || !form.qty) return
    setSaving(true)
    const [row] = await sb.insert('food_issues', {
      company_id: companyId,
      item_id: form.item_id,
      location_id: location,
      period: toPeriod(form.date),
      date: form.date,
      qty: Number(form.qty),
      reason: form.reason,
      note: form.note,
    })
    setForm({ ...form, item_id: '', qty: '', note: '' })
    setCategory('')
    setSaving(false)
    onAdd(row)
  }

  async function removeIssue(id) {
    await sb.remove('food_issues', { id })
    onRemove(id)
  }

  const itemName = (id) => items.find((i) => i.id === id)?.name || '—'
  const itemUnit = (id) => items.find((i) => i.id === id)?.purchase_unit || ''

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Log issued stock</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          'Service' is normal kitchen use — dishes cooked and served. Everything else (Breakage,
          Expired, Staff, Other) is a write-off, tracked separately on the Dashboard. Both feed the
          Usage tab's expected-stock calculation. Quantities are in each item's purchase unit (same
          as Purchases and Count), not its recipe unit.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Category</label>
            <select
              style={styles.input}
              value={category}
              onChange={(e) => { setCategory(e.target.value); setForm({ ...form, item_id: '' }) }}
            >
              <option value="">Select category…</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              {uncategorisedCount > 0 && <option value="__none__">Uncategorised</option>}
            </select>
          </div>
          <div>
            <label style={styles.label}>Item</label>
            <select
              style={styles.input}
              value={form.item_id}
              onChange={(e) => setForm({ ...form, item_id: e.target.value })}
              disabled={!category}
            >
              <option value="">{category ? 'Select item…' : 'Pick a category first'}</option>
              {itemsInCat.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name} ({it.purchase_unit})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Date</label>
            <input type="date" style={styles.input} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Qty issued ({itemUnit(form.item_id) || '—'})</label>
            <input type="number" style={styles.input} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Reason</label>
            <select style={styles.input} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {ISSUE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Note (optional)</label>
            <input style={styles.input} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={addIssue} disabled={saving}>
          {saving ? 'Saving…' : 'Add issue'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Issues in {period}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Qty</th>
              <th style={styles.th}>Reason</th>
              <th style={styles.th}>Note</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td style={styles.td}>{i.date}</td>
                <td style={styles.td}>{itemName(i.item_id)}</td>
                <td style={styles.tdNum}>
                  {fmt(i.qty, 1)} {itemUnit(i.item_id)}
                </td>
                <td style={styles.td}>
                  {!i.reason || i.reason === 'Service' ? (
                    i.reason || 'Service'
                  ) : (
                    <span style={styles.badge('bad')}>{i.reason}</span>
                  )}
                </td>
                <td style={styles.td}>{i.note || '—'}</td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => removeIssue(i.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {issues.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={6}>
                  No issues logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Count tab — enter the physical closing stock count (in purchase_unit)
// ---------------------------------------------------------------------------

function CountTab({ items, stockByItem, metricsByItem, location, companyId, period, role, onSave, onLinkItem }) {
  const [countedBy, setCountedBy] = useState('')
  const [resetKey, setResetKey] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState('')
  const [scanning, setScanning] = useState(false)
  const [activeScanItemId, setActiveScanItemId] = useState(null)
  const [linkingBarcode, setLinkingBarcode] = useState(null)
  const [linkItemId, setLinkItemId] = useState('')
  const [linking, setLinking] = useState(false)
  const inputRefs = useRef({})
  const showTheoretical = role === 'admin'

  function focusItem(id) {
    setActiveScanItemId(id)
    setTimeout(() => {
      const el = inputRefs.current[id]
      if (el) {
        el.focus()
        el.select?.()
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 50)
  }

  function handleScan(code) {
    const match = items.find((it) => it.barcode === code)
    setScanning(false)
    if (match) {
      setLinkingBarcode(null)
      setStatus(`Scanned: ${match.name} — type the count and press Enter to scan the next item.`)
      focusItem(match.id)
    } else {
      setStatus('')
      setLinkingBarcode(code)
      setLinkItemId('')
    }
  }

  async function linkBarcode() {
    if (!linkItemId || !linkingBarcode) return
    setLinking(true)
    const [row] = await sb.update('food_items', { id: linkItemId }, { barcode: linkingBarcode })
    onLinkItem(row)
    setLinking(false)
    setLinkingBarcode(null)
    setStatus(`Linked to ${row?.name || 'item'} — scan it again next time to jump straight there.`)
    focusItem(linkItemId)
    setLinkItemId('')
  }

  function handleCountKeyDown(e, itemId) {
    if (e.key === 'Enter' && activeScanItemId === itemId) {
      e.preventDefault()
      e.target.blur()
      setScanning(true)
    }
  }

  async function submitCounts() {
    setSubmitting(true)
    setStatus('')
    const rows = []
    for (const it of items) {
      const sp = stockByItem[it.id]
      if (!sp) continue
      const el = inputRefs.current[it.id]
      const raw = el ? el.value.trim() : ''
      if (raw === '') continue
      rows.push({
        company_id: companyId,
        item_id: it.id,
        location_id: location,
        period,
        opening_units: sp.opening_units ?? 0,
        opening_cost_per_unit: sp.opening_cost_per_unit ?? 0,
        closing_count_units: Number(raw),
        counted_by: countedBy || sp.counted_by || null,
        count_date: new Date().toISOString().slice(0, 10),
      })
    }

    if (rows.length) {
      const saved = await sb.upsert('food_stock_periods', rows, 'item_id,period')
      onSave(saved || rows)
      setStatus(`Saved ${rows.length} count${rows.length === 1 ? '' : 's'} — sheet cleared for the next count.`)
    } else {
      setStatus('Nothing to save — every field was empty.')
    }
    setSubmitting(false)
    setResetKey((k) => k + 1)
  }

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between' }}>
        <div style={styles.cardTitle}>Physical stock count — {period}</div>
        <button style={styles.buttonGhost} onClick={() => setScanning(true)}>
          Scan barcode
        </button>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Fields start empty each time — the grey number is just a reminder of the last count, not a
        live value. Counts are in each item's purchase unit. Fill in what you're counting today,
        then hit Submit; anything left blank is skipped and keeps its last saved count. Scanning a
        packet jumps straight to its row — type the count and press Enter to scan the next one.
      </div>
      <div style={styles.formGrid}>
        <div>
          <label style={styles.label}>Counted by</label>
          <input style={styles.input} value={countedBy} onChange={(e) => setCountedBy(e.target.value)} placeholder="Name" />
        </div>
      </div>

      {linkingBarcode && (
        <div style={styles.banner}>
          <span>Unknown barcode ({linkingBarcode}) — link it to an item:</span>
          <div style={{ ...styles.row, flexWrap: 'wrap' }}>
            <select style={styles.input} value={linkItemId} onChange={(e) => setLinkItemId(e.target.value)}>
              <option value="">Choose item…</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>
            <button style={styles.button} onClick={linkBarcode} disabled={!linkItemId || linking}>
              {linking ? 'Linking…' : 'Link'}
            </button>
            <button style={styles.buttonGhost} onClick={() => setLinkingBarcode(null)}>
              Skip
            </button>
          </div>
        </div>
      )}

      <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Item</th>
            {showTheoretical && <th style={styles.th}>Expected</th>}
            <th style={styles.th}>Counted</th>
            {showTheoretical && <th style={styles.th}>Variance</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const m = metricsByItem[it.id]
            const sp = stockByItem[it.id]
            const active = activeScanItemId === it.id
            return (
              <tr key={it.id} style={active ? { background: 'rgba(184,147,90,0.14)' } : undefined}>
                <td style={styles.td}>
                  {it.name}
                  {it.barcode && (
                    <span style={{ ...styles.badge('neutral'), marginLeft: 6, fontSize: 9 }}>linked</span>
                  )}
                </td>
                {showTheoretical && <td style={styles.tdNum}>{fmt(m?.theoreticalClosing, 1)}</td>}
                <td style={styles.td}>
                  <input
                    key={`${it.id}-${resetKey}`}
                    ref={(el) => {
                      inputRefs.current[it.id] = el
                    }}
                    type="number"
                    style={styles.smallInput}
                    defaultValue=""
                    placeholder={sp?.closing_count_units ?? ''}
                    disabled={!sp}
                    onKeyDown={(e) => handleCountKeyDown(e, it.id)}
                  />
                </td>
                {showTheoretical && (
                  <td style={styles.td}>
                    {m?.hasCount ? (
                      <span style={styles.badge(m.varianceUnits < 0 ? 'bad' : 'good')}>{fmt(m.varianceUnits, 1)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginTop: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: colors.muted }}>{status}</div>
        <button style={styles.button} onClick={submitCounts} disabled={submitting}>
          {submitting ? 'Saving…' : 'Submit count'}
        </button>
      </div>

      {scanning && <BarcodeScanner onScan={handleScan} onClose={() => setScanning(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Usage tab (internally VarianceTab — id/label stay "Usage", not renamed
// to match the beverage app's "Variance") — expected stock is now driven
// by what's logged on the Issues tab: Expected = opening + purchased −
// issued (service + write-offs combined). Variance = Counted − Expected,
// the genuine discrepancy once normal use is properly logged, surfaced
// here for the first time (previously dead code, since "usage" used to be
// an unlogged residual computed only after a count).
// ---------------------------------------------------------------------------

function VarianceTab({ items, metricsByItem, allClosed, onClosePeriod }) {
  const totals = items.reduce(
    (acc, it) => {
      const m = metricsByItem[it.id]
      acc.purchaseCost += m?.purchaseCost || 0
      acc.issuedValue += m ? m.issuedTotal * m.weightedAvgCost : 0
      acc.varianceValue += m?.hasCount ? m.varianceValue : 0
      return acc
    },
    { purchaseCost: 0, issuedValue: 0, varianceValue: 0 }
  )

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={styles.cardTitle}>Usage & weighted-average cost</div>
        <button style={styles.buttonGhost} onClick={onClosePeriod} disabled={allClosed}>
          {allClosed ? 'Period closed' : 'Close period'}
        </button>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Total purchases this period: R {fmt(totals.purchaseCost)} · Total issued value: R{' '}
        {fmt(totals.issuedValue)} · Total variance value: R {fmt(totals.varianceValue)}
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Expected = Opening + Purchased − Issued (Service + write-offs logged on the Issues tab).
        Variance = Counted − Expected — a discrepancy worth a second look, not something to expect
        every period.
      </div>
      <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Item</th>
            <th style={styles.th}>Opening</th>
            <th style={styles.th}>Purchased</th>
            <th style={styles.th}>Issued</th>
            <th style={styles.th}>W/Avg cost</th>
            <th style={styles.th}>Expected</th>
            <th style={styles.th}>Counted</th>
            <th style={styles.th}>Variance (units)</th>
            <th style={styles.th}>Variance (value)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const m = metricsByItem[it.id]
            if (!m) return null
            return (
              <tr key={it.id}>
                <td style={styles.td}>{it.name}</td>
                <td style={styles.tdNum}>{fmt(m.opening, 1)}</td>
                <td style={styles.tdNum}>{fmt(m.purchaseUnits, 1)}</td>
                <td style={styles.tdNum}>{fmt(m.issuedTotal, 1)}</td>
                <td style={styles.tdNum}>R {fmt(m.weightedAvgCost)}</td>
                <td style={styles.tdNum}>{fmt(m.theoreticalClosing, 1)}</td>
                <td style={styles.td}>{m.hasCount ? fmt(m.closingCount, 1) : '—'}</td>
                <td style={styles.td}>
                  {m.hasCount ? (
                    <span style={styles.badge(m.varianceUnits < 0 ? 'bad' : 'good')}>{fmt(m.varianceUnits, 1)}</span>
                  ) : (
                    'Pending count'
                  )}
                </td>
                <td style={styles.tdNum}>{m.hasCount ? `R ${fmt(m.varianceValue)}` : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Orders tab — items at/below their reorder point, grouped by supplier
// ---------------------------------------------------------------------------

// Groups any list of rows by the supplier of whichever item each row is
// about — shared between the automatic restock list and the menu-planner
// shortfall list below, so both group and sort the same way.
function groupBySupplier(rows, getItem, supplierById) {
  const map = {}
  for (const row of rows) {
    const key = getItem(row).supplier_id || UNASSIGNED_SUPPLIER
    ;(map[key] ||= []).push(row)
  }
  const groups = Object.entries(map).map(([key, groupRows]) => ({
    key,
    supplier: key === UNASSIGNED_SUPPLIER ? null : supplierById[key],
    rows: groupRows,
  }))
  groups.sort((a, b) => {
    if (a.key === UNASSIGNED_SUPPLIER) return 1
    if (b.key === UNASSIGNED_SUPPLIER) return -1
    return (a.supplier?.name || '').localeCompare(b.supplier?.name || '')
  })
  return groups
}

async function copyToClipboard(text, onDone) {
  try {
    await navigator.clipboard.writeText(text)
    onDone()
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    try {
      document.execCommand('copy')
      onDone()
    } catch {
      // Nothing more we can do — leave it uncopied silently.
    }
    document.body.removeChild(textarea)
  }
}

function OrdersTab({ items, metricsByItem, suppliers, supplierById, recipes, ingredientsByRecipe }) {
  const [copiedKey, setCopiedKey] = useState(null)
  const toOrder = items.filter((it) => (metricsByItem[it.id]?.reorderQty || 0) > 0)
  const restockGroups = useMemo(() => groupBySupplier(toOrder, (it) => it, supplierById), [toOrder, supplierById])

  function flash(key) {
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000)
  }

  function copyRestockGroup(group) {
    const text = group.rows.map((it) => `${it.name}\t${fmt(metricsByItem[it.id]?.reorderQty, 0)}`).join('\n')
    copyToClipboard(text, () => flash(group.key))
  }

  return (
    <>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4, padding: '0 2px' }}>
        The restock list below is automatic, from each item's min/max levels. The menu order planner
        further down works out extra ingredients needed for a specific event, on top of that.
      </div>

      {toOrder.length === 0 ? (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Restock — low on stock</div>
          <div style={{ fontSize: 13 }}>Nothing is below its reorder point right now.</div>
        </div>
      ) : (
        restockGroups.map((group) => (
          <div style={styles.card} key={`restock-${group.key}`}>
            <div style={{ ...styles.row, justifyContent: 'space-between' }}>
              <div style={styles.cardTitle}>
                {group.supplier ? group.supplier.name : 'Unassigned'} ({group.rows.length})
              </div>
              <button style={styles.buttonGhost} onClick={() => copyRestockGroup(group)}>
                {copiedKey === group.key ? 'Copied!' : 'Copy list'}
              </button>
            </div>
            {group.supplier && (group.supplier.contact_name || group.supplier.phone || group.supplier.email) && (
              <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
                {[group.supplier.contact_name, group.supplier.phone, group.supplier.email]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
            {!group.supplier && (
              <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
                These items have no supplier linked — set one on the Items tab so they group into an
                order next time.
              </div>
            )}
            <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Item</th>
                  <th style={styles.th}>Theoretical stock</th>
                  <th style={styles.th}>Min</th>
                  <th style={styles.th}>Max</th>
                  <th style={styles.th}>Order qty</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((it) => {
                  const m = metricsByItem[it.id]
                  return (
                    <tr key={it.id}>
                      <td style={styles.td}>{it.name}</td>
                      <td style={styles.tdNum}>{fmt(m.theoreticalClosing, 1)}</td>
                      <td style={styles.tdNum}>{fmt(it.min_units, 0)}</td>
                      <td style={styles.tdNum}>{fmt(it.max_units, 0)}</td>
                      <td style={styles.td}>
                        <strong>{fmt(m.reorderQty, 0)}</strong>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </div>
        ))
      )}

      <MenuOrderPlanner
        items={items}
        metricsByItem={metricsByItem}
        recipes={recipes}
        ingredientsByRecipe={ingredientsByRecipe}
        supplierById={supplierById}
        copiedKey={copiedKey}
        onCopied={flash}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Menu order planner — pick one or more menus off the Menu tab, say how
// many guests each is for, and it works out the total of every ingredient
// needed across the whole plan (recipe qty ÷ portions × guests, per
// recipe), converts that from each item's recipe_unit into its
// purchase_unit, and checks it against what's currently in stock. Anything
// short gets grouped by supplier just like the restock list above.
//
// This is a live calculator, not a saved plan — it resets if you leave the
// Orders tab, by design, since it's meant for "what do I need for Saturday's
// wedding" rather than a standing order.
// ---------------------------------------------------------------------------

function MenuOrderPlanner({ items, metricsByItem, recipes, ingredientsByRecipe, supplierById, copiedKey, onCopied }) {
  const [defaultGuests, setDefaultGuests] = useState('')
  const [planRows, setPlanRows] = useState([{ recipe_id: '', guests: '' }])

  function addPlanRow() {
    setPlanRows((prev) => [...prev, { recipe_id: '', guests: defaultGuests }])
  }
  function updatePlanRow(i, patch) {
    setPlanRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function removePlanRow(i) {
    setPlanRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))
  }
  function applyDefaultToAll() {
    setPlanRows((prev) => prev.map((r) => ({ ...r, guests: defaultGuests })))
  }

  const itemById = useMemo(() => {
    const map = {}
    for (const it of items) map[it.id] = it
    return map
  }, [items])

  const activeRows = useMemo(() => planRows.filter((r) => r.recipe_id && Number(r.guests) > 0), [planRows])

  // recipe_unit total needed per item, summed across every active row —
  // e.g. flour needed for both the starter and the dessert lands in one
  // combined total before it's ever compared to stock.
  const menuRows = useMemo(() => {
    const need = {}
    for (const row of activeRows) {
      const recipe = recipes.find((r) => r.id === row.recipe_id)
      if (!recipe) continue
      const portions = Number(recipe.portions) || 1
      const guests = Number(row.guests)
      for (const ing of ingredientsByRecipe[row.recipe_id] || []) {
        const perPortion = Number(ing.qty_recipe_unit || 0) / portions
        need[ing.item_id] = (need[ing.item_id] || 0) + perPortion * guests
      }
    }
    const rows = []
    for (const [itemId, recipeUnitQty] of Object.entries(need)) {
      const item = itemById[itemId]
      if (!item) continue
      const factor = Number(item.conversion_factor) > 0 ? Number(item.conversion_factor) : 1
      const neededPurchaseUnits = recipeUnitQty / factor
      const m = metricsByItem[itemId]
      const available = m ? (m.hasCount ? m.closingCount : m.theoreticalClosing) : 0
      const shortfall = Math.max(neededPurchaseUnits - available, 0)
      rows.push({ item, neededPurchaseUnits, available, shortfall })
    }
    return rows.sort((a, b) => a.item.name.localeCompare(b.item.name))
  }, [activeRows, recipes, ingredientsByRecipe, itemById, metricsByItem])

  const shortRows = useMemo(() => menuRows.filter((r) => r.shortfall > 0), [menuRows])
  const shortGroups = useMemo(() => groupBySupplier(shortRows, (r) => r.item, supplierById), [shortRows, supplierById])

  function copyMenuGroup(group) {
    const text = group.rows.map((r) => `${r.item.name}\t${fmt(r.shortfall, 2)} ${r.item.purchase_unit}`).join('\n')
    copyToClipboard(text, () => onCopied(`menu-${group.key}`))
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Order for a menu plan</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Pick one or more menus and how many guests each is for. This adds up every ingredient
          needed across the whole plan, checks it against what's currently in stock, and tells you
          what's short.
        </div>
        <div style={{ ...styles.row, gap: 8, marginBottom: 12, alignItems: 'flex-end' }}>
          <div>
            <label style={styles.label}>Default guests</label>
            <input
              type="number"
              style={{ ...styles.input, width: 100 }}
              value={defaultGuests}
              onChange={(e) => setDefaultGuests(e.target.value)}
            />
          </div>
          <button style={styles.buttonGhost} onClick={applyDefaultToAll}>
            Apply to all rows
          </button>
        </div>
        {planRows.map((row, i) => (
          <div key={i} style={{ ...styles.row, gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <select
              style={{ ...styles.input, flex: '2 1 200px' }}
              value={row.recipe_id}
              onChange={(e) => updatePlanRow(i, { recipe_id: e.target.value })}
            >
              <option value="">Choose menu…</option>
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              placeholder="Guests"
              style={{ ...styles.input, width: 90 }}
              value={row.guests}
              onChange={(e) => updatePlanRow(i, { guests: e.target.value })}
            />
            <button style={styles.buttonDanger} onClick={() => removePlanRow(i)}>
              Remove
            </button>
          </div>
        ))}
        <button style={styles.buttonGhost} onClick={addPlanRow}>
          + Add another menu
        </button>
      </div>

      {menuRows.length > 0 && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Ingredients needed for this plan</div>
          <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>Needed</th>
                <th style={styles.th}>In stock</th>
                <th style={styles.th}>Short by</th>
              </tr>
            </thead>
            <tbody>
              {menuRows.map((r) => (
                <tr key={r.item.id}>
                  <td style={styles.td}>{r.item.name}</td>
                  <td style={styles.tdNum}>
                    {fmt(r.neededPurchaseUnits, 2)} {r.item.purchase_unit}
                  </td>
                  <td style={styles.tdNum}>
                    {fmt(r.available, 2)} {r.item.purchase_unit}
                  </td>
                  <td style={styles.td}>
                    {r.shortfall > 0 ? (
                      <strong style={{ color: colors.danger }}>
                        {fmt(r.shortfall, 2)} {r.item.purchase_unit}
                      </strong>
                    ) : (
                      <span style={{ color: colors.ok }}>Covered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {shortRows.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: colors.muted, margin: '4px 2px' }}>
            {shortRows.length} item{shortRows.length === 1 ? '' : 's'} short for this plan, grouped by
            supplier and ready to order.
          </div>
          {shortGroups.map((group) => (
            <div style={styles.card} key={`menu-${group.key}`}>
              <div style={{ ...styles.row, justifyContent: 'space-between' }}>
                <div style={styles.cardTitle}>
                  {group.supplier ? group.supplier.name : 'Unassigned'} ({group.rows.length})
                </div>
                <button style={styles.buttonGhost} onClick={() => copyMenuGroup(group)}>
                  {copiedKey === `menu-${group.key}` ? 'Copied!' : 'Copy list'}
                </button>
              </div>
              {group.supplier && (group.supplier.contact_name || group.supplier.phone || group.supplier.email) && (
                <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
                  {[group.supplier.contact_name, group.supplier.phone, group.supplier.email]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
              <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Item</th>
                    <th style={styles.th}>Order qty</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((r) => (
                    <tr key={r.item.id}>
                      <td style={styles.td}>{r.item.name}</td>
                      <td style={styles.td}>
                        <strong>
                          {fmt(r.shortfall, 2)} {r.item.purchase_unit}
                        </strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Menu tab — recipe builder + live cost calculator. Build a recipe from
// ingredient items + quantities (in each item's recipe_unit); cost is
// computed live from current ingredient costs (this period's weighted
// average, from the header's month picker) — nothing about cost is stored,
// so it always reflects up-to-date ingredient pricing. Used to work out
// cost price per dish so a sell price/margin can be set outside the app.
// ---------------------------------------------------------------------------

function MenuTab({
  items,
  metricsByItem,
  location,
  companyId,
  recipes,
  ingredientsByRecipe,
  onAddRecipe,
  onRemoveRecipe,
  onAddIngredient,
  onRemoveIngredient,
}) {
  const [form, setForm] = useState({ name: '', category: '', portions: 1, notes: '' })
  const [saving, setSaving] = useState(false)

  async function addRecipe() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('food_recipes', {
      company_id: companyId,
      name: form.name,
      category: form.category,
      portions: Number(form.portions) || 1,
      notes: form.notes,
      location_id: location,
    })
    setForm({ name: '', category: '', portions: 1, notes: '' })
    setSaving(false)
    onAddRecipe(row)
  }

  async function removeRecipe(id) {
    await sb.remove('food_recipes', { id })
    onRemoveRecipe(id)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Add recipe</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Name</label>
            <input style={styles.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Category</label>
            <input
              style={styles.input}
              placeholder="Starters, Mains, Desserts…"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Portions (yield)</label>
            <input
              type="number"
              style={styles.input}
              value={form.portions}
              onChange={(e) => setForm({ ...form, portions: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Notes</label>
            <input style={styles.input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={addRecipe} disabled={saving}>
          {saving ? 'Adding…' : 'Add recipe'}
        </button>
      </div>

      {recipes.map((r) => (
        <RecipeCard
          key={r.id}
          recipe={r}
          items={items}
          metricsByItem={metricsByItem}
          ingredients={ingredientsByRecipe[r.id] || []}
          companyId={companyId}
          onRemoveRecipe={removeRecipe}
          onAddIngredient={onAddIngredient}
          onRemoveIngredient={onRemoveIngredient}
        />
      ))}
      {recipes.length === 0 && (
        <div style={styles.card}>
          <div style={{ fontSize: 13 }}>No recipes yet — add one above, then add ingredients to it.</div>
        </div>
      )}
    </>
  )
}

function RecipeCard({ recipe, items, metricsByItem, ingredients, companyId, onRemoveRecipe, onAddIngredient, onRemoveIngredient }) {
  const [addItemId, setAddItemId] = useState(items[0]?.id || '')
  const [addQty, setAddQty] = useState('')
  const [saving, setSaving] = useState(false)

  const rows = ingredients.map((ing) => {
    const item = items.find((it) => it.id === ing.item_id)
    const perUnit = costPerRecipeUnit(item, metricsByItem)
    const cost = perUnit * Number(ing.qty_recipe_unit || 0)
    return { ing, item, perUnit, cost }
  })
  const totalCost = rows.reduce((s, r) => s + r.cost, 0)
  const portions = Number(recipe.portions) || 1
  const perPortion = totalCost / portions

  async function addIngredient() {
    if (!addItemId || !addQty) return
    setSaving(true)
    const [row] = await sb.insert('food_recipe_ingredients', {
      company_id: companyId,
      recipe_id: recipe.id,
      item_id: addItemId,
      qty_recipe_unit: Number(addQty),
    })
    setAddQty('')
    setSaving(false)
    onAddIngredient(row)
  }

  async function removeIngredient(id) {
    await sb.remove('food_recipe_ingredients', { id })
    onRemoveIngredient(id)
  }

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between' }}>
        <div style={styles.cardTitle}>
          {recipe.name}
          {recipe.category ? ` · ${recipe.category}` : ''}
        </div>
        <button style={styles.buttonDanger} onClick={() => onRemoveRecipe(recipe.id)}>
          Delete recipe
        </button>
      </div>
      {recipe.notes && <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>{recipe.notes}</div>}

      <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Ingredient</th>
            <th style={styles.th}>Qty</th>
            <th style={styles.th}>Unit</th>
            <th style={styles.th}>Cost/unit</th>
            <th style={styles.th}>Cost</th>
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ ing, item, perUnit, cost }) => (
            <tr key={ing.id}>
              <td style={styles.td}>{item ? item.name : 'Unknown item'}</td>
              <td style={styles.tdNum}>{fmt(ing.qty_recipe_unit, 2)}</td>
              <td style={styles.td}>{item?.recipe_unit || '—'}</td>
              <td style={styles.tdNum}>R {fmt(perUnit, 4)}</td>
              <td style={styles.tdNum}>R {fmt(cost)}</td>
              <td style={styles.td}>
                <button style={styles.buttonDanger} onClick={() => removeIngredient(ing.id)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td style={styles.td} colSpan={6}>
                No ingredients yet — add some below.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>

      <div style={{ ...styles.formGrid, marginTop: 10 }}>
        <div>
          <label style={styles.label}>Add ingredient</label>
          <select style={styles.input} value={addItemId} onChange={(e) => setAddItemId(e.target.value)}>
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name} ({it.recipe_unit})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={styles.label}>Qty ({items.find((it) => it.id === addItemId)?.recipe_unit || '—'})</label>
          <input type="number" style={styles.input} value={addQty} onChange={(e) => setAddQty(e.target.value)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button style={styles.button} onClick={addIngredient} disabled={saving}>
            {saving ? 'Adding…' : 'Add ingredient'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${colors.border}`, fontSize: 13 }}>
        <strong>Total cost: R {fmt(totalCost)}</strong>
        {'  ·  '}
        Cost per portion ({fmt(portions, portions % 1 === 0 ? 0 : 2)}): <strong>R {fmt(perPortion)}</strong>
      </div>
    </div>
  )
}
