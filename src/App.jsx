import { useEffect, useMemo, useRef, useState } from 'react'
import { sb, LOCATIONS, currentPeriod, UNITS } from './sb.js'
import { colors, fonts } from './theme.js'
import BarcodeScanner from './BarcodeScanner.jsx'

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

// Reasons an issue can be logged under. "Service" is normal kitchen
// consumption (what "issues" always meant); everything else is a write-off.
const ISSUE_REASONS = ['Service', 'Breakage', 'Expired', 'Staff', 'Other']

function computeMetrics(item, stockPeriod, itemPurchases, itemIssues) {
  const opening = stockPeriod?.opening_units ?? 0
  const openingCost = stockPeriod?.opening_cost_per_unit ?? 0
  const purchaseUnits = itemPurchases.reduce((s, p) => s + Number(p.units || 0), 0)
  const purchaseCost = itemPurchases.reduce((s, p) => s + Number(p.total_cost_excl_vat || 0), 0)
  const issuedTotal = itemIssues.reduce((s, i) => s + Number(i.qty || 0), 0)

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
  const totals = { theoreticalValue: 0, actualValue: 0, varianceValue: 0, issuedValue: 0 }
  for (const it of items) {
    const m = metricsByItem[it.id]
    if (!m) continue
    totals.theoreticalValue += m.theoreticalClosing * m.weightedAvgCost
    totals.actualValue += (m.hasCount ? m.closingCount : m.theoreticalClosing) * m.weightedAvgCost
    totals.varianceValue += m.hasCount ? m.varianceValue : 0
    totals.issuedValue += m.issuedTotal * m.weightedAvgCost
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
  nav: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: colors.panel,
    borderTop: `1px solid ${colors.border}`,
    display: 'flex',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    zIndex: 10,
  },
  navItem: (active) => ({
    flex: '0 0 auto',
    minWidth: 72,
    padding: '10px 12px 8px',
    textAlign: 'center',
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    color: active ? colors.goldLt : colors.muted,
    cursor: 'pointer',
    background: 'none',
    border: 'none',
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
  { id: 'variance', label: 'Variance' },
  { id: 'orders', label: 'Orders' },
]

const STAFF_TABS = [
  { id: 'issues', label: 'Issues' },
  { id: 'count', label: 'Count' },
]

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function useAuth() {
  const [role, setRole] = useState(() => {
    try {
      return localStorage.getItem('food_role') || null
    } catch {
      return null
    }
  })

  function login(r) {
    try {
      localStorage.setItem('food_role', r)
    } catch {
      /* ignore storage errors */
    }
    setRole(r)
  }

  function logout() {
    try {
      localStorage.removeItem('food_role')
    } catch {
      /* ignore storage errors */
    }
    setRole(null)
  }

  return { role, login, logout }
}

function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!password) return
    setChecking(true)
    setError('')
    try {
      const rows = await sb.select('food_access', { password })
      if (rows && rows.length) {
        onLogin(rows[0].role)
      } else {
        setError('Incorrect password.')
      }
    } catch (err) {
      setError(`Could not reach the database: ${err.message}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={{ ...styles.app, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} style={{ ...styles.card, width: 280 }}>
        <img
          src="/logo.png"
          alt=""
          style={{ height: 56, width: 'auto', display: 'block', margin: '0 auto 12px' }}
          onError={(e) => (e.target.style.display = 'none')}
        />
        <div style={{ ...styles.cardTitle, textAlign: 'center' }}>Crossing Lodges — Food Stock</div>
        <label style={styles.label}>Password</label>
        <input
          type="password"
          autoFocus
          style={styles.input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div style={{ color: colors.danger, fontSize: 12, marginTop: 8 }}>{error}</div>}
        <button type="submit" style={{ ...styles.button, width: '100%', marginTop: 12 }} disabled={checking}>
          {checking ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { role, login, logout } = useAuth()
  const [location, setLocation] = useState('ZC')
  const [period, setPeriod] = useState(currentPeriod())
  const [tab, setTab] = useState('dashboard')
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState([])
  const [stockPeriods, setStockPeriods] = useState([])
  const [purchases, setPurchases] = useState([])
  const [issues, setIssues] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [recipes, setRecipes] = useState([])
  const [recipeIngredients, setRecipeIngredients] = useState([])
  const [error, setError] = useState(null)

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [itemsRes, spRes, purRes, issRes, supRes, recRes, ingRes] = await Promise.all([
        sb.select('food_items', { location_id: location, active: true }, { order: 'category.asc,name.asc' }),
        sb.select('food_stock_periods', { location_id: location, period }, {}),
        sb.select('food_purchases', { location_id: location, period }, { order: 'date.asc' }),
        sb.select('food_issues', { location_id: location, period }, { order: 'date.asc' }),
        sb.select('food_suppliers', { location_id: location, active: true }, { order: 'name.asc' }),
        sb.select('food_recipes', { location_id: location, active: true }, { order: 'name.asc' }),
        sb.select('food_recipe_ingredients', {}, { order: 'created_at.asc' }),
      ])
      setItems(itemsRes || [])
      setStockPeriods(spRes || [])
      setPurchases(purRes || [])
      setIssues(issRes || [])
      setSuppliers(supRes || [])
      setRecipes(recRes || [])
      setRecipeIngredients(ingRes || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, period])

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
      sb.select('food_stock_periods', { location_id: location, period: prior }, {}),
      sb.select('food_purchases', { location_id: location, period: prior }, {}),
      sb.select('food_issues', { location_id: location, period: prior }, {}),
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

  if (!role) {
    return <LoginScreen onLogin={login} />
  }

  const TABS = role === 'admin' ? ADMIN_TABS : STAFF_TABS
  const activeTab = TABS.some((t) => t.id === tab) ? tab : TABS[0].id

  return (
    <div style={styles.app}>
      <div style={styles.header}>
        <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ ...styles.headerTitle, minWidth: 0, flexShrink: 1 }}>
            <img
              src="/logo.png"
              alt=""
              style={{ ...styles.logo, flexShrink: 0 }}
              onError={(e) => (e.target.style.display = 'none')}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Crossing Lodges — Food Stock</span>
          </div>
          <div style={{ ...styles.row, flexShrink: 0 }}>
            <span style={styles.badge('neutral')}>{role === 'admin' ? 'Admin' : 'Staff'}</span>
            <button style={{ ...styles.pill(false), padding: '4px 10px' }} onClick={logout}>
              Log out
            </button>
          </div>
        </div>
        <div style={styles.row}>
          <div style={styles.pillGroup}>
            {LOCATIONS.map((l) => (
              <button key={l.id} style={styles.pill(location === l.id, l.id)} onClick={() => setLocation(l.id)}>
                {l.id}
              </button>
            ))}
          </div>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={styles.monthInput}
          />
        </div>
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
                location={location}
                period={period}
                onAdd={addLocalPurchase}
                onRemove={removeLocalPurchase}
              />
            )}
            {activeTab === 'issues' && (
              <IssuesTab
                items={items}
                issues={issues}
                location={location}
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

      <div style={styles.nav}>
        {TABS.map((t) => (
          <button key={t.id} style={styles.navItem(activeTab === t.id)} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
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
        .sort((a, b) => b.m.issuedTotal - a.m.issuedTotal),
    [items, metricsByItem]
  )
  const fastest = ranked.filter((x) => x.m.issuedTotal > 0).slice(0, 10)
  const notMoving = ranked.filter((x) => x.m.issuedTotal === 0)

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Stock value — {period}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}></th>
              <th style={styles.th}>Theoretical value</th>
              <th style={styles.th}>Actual (counted) value</th>
              <th style={styles.th}>Value variance</th>
              <th style={styles.th}>Used this month</th>
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
                <span style={styles.badge(totals.varianceValue < 0 ? 'bad' : 'good')}>
                  R {fmt(totals.varianceValue)}
                </span>
              </td>
              <td style={styles.tdNum}>
                <strong>R {fmt(totals.issuedValue)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
          "Value variance" only reflects items that have had a physical count this period — it's the
          Rand value gap between what the books say should be on the shelf and what was actually
          counted (negative means stock is missing). Items not yet counted fall back to the
          theoretical estimate in both columns, so the totals stay complete.
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>By supplier — {period}</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          "Movement" is Service issues (normal kitchen consumption). "Write-offs" is everything else
          logged on the Issues tab — breakage, expired stock, staff usage, other.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Supplier</th>
              <th style={styles.th}>Items</th>
              <th style={styles.th}>Stock value</th>
              <th style={styles.th}>Movement (qty)</th>
              <th style={styles.th}>Movement (value)</th>
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
        <div style={styles.cardTitle}>Fastest moving this period</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Qty issued</th>
              <th style={styles.th}>Value issued</th>
            </tr>
          </thead>
          <tbody>
            {fastest.map(({ item, m }) => (
              <tr key={item.id}>
                <td style={styles.td}>{item.name}</td>
                <td style={styles.td}>{item.category}</td>
                <td style={styles.tdNum}>{fmt(m.issuedTotal, 1)}</td>
                <td style={styles.tdNum}>R {fmt(m.issuedTotal * m.weightedAvgCost)}</td>
              </tr>
            ))}
            {fastest.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={4}>
                  No issues logged this period yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Not moving this period ({notMoving.length})</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
          Zero issues logged so far this period — candidates to reconsider on the menu.
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
                  Everything moved at least once this period.
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

function ItemsTab({ items, metricsByItem, location, suppliers, onAdd, onUpdate, onRemove }) {
  const [form, setForm] = useState({
    name: '',
    category: 'Dry- and other stock',
    purchase_unit: 'kg',
    recipe_unit: 'kg',
    conversion_factor: 1,
    supplier_id: '',
    min_units: 0,
    max_units: 0,
  })
  const [saving, setSaving] = useState(false)

  async function addItem() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('food_items', { ...form, supplier_id: form.supplier_id || null, location_id: location })
    setForm({
      name: '',
      category: 'Dry- and other stock',
      purchase_unit: 'kg',
      recipe_unit: 'kg',
      conversion_factor: 1,
      supplier_id: '',
      min_units: 0,
      max_units: 0,
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

function SuppliersTab({ suppliers, location, onAdd, onUpdate, onRemove }) {
  const [form, setForm] = useState({ name: '', contact_name: '', phone: '', email: '', notes: '' })
  const [saving, setSaving] = useState(false)

  async function addSupplier() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('food_suppliers', { ...form, location_id: location })
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
// Purchases tab
// ---------------------------------------------------------------------------

function PurchasesTab({ items, purchases, location, period, onAdd, onRemove }) {
  const [form, setForm] = useState({
    item_id: items[0]?.id || '',
    date: new Date().toISOString().slice(0, 10),
    units: '',
    total_cost_excl_vat: '',
    supplier: '',
  })
  const [saving, setSaving] = useState(false)

  async function addPurchase() {
    if (!form.item_id || !form.units) return
    setSaving(true)
    const [row] = await sb.insert('food_purchases', {
      item_id: form.item_id,
      location_id: location,
      period: toPeriod(form.date),
      date: form.date,
      units: Number(form.units),
      total_cost_excl_vat: Number(form.total_cost_excl_vat || 0),
      supplier: form.supplier,
    })
    setForm({ ...form, units: '', total_cost_excl_vat: '', supplier: '' })
    setSaving(false)
    onAdd(row)
  }

  async function removePurchase(id) {
    await sb.remove('food_purchases', { id })
    onRemove(id)
  }

  const itemName = (id) => items.find((i) => i.id === id)?.name || '—'
  const itemUnit = (id) => items.find((i) => i.id === id)?.purchase_unit || ''

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Log a purchase</div>
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
          <div>
            <label style={styles.label}>Units ({itemUnit(form.item_id) || '—'})</label>
            <input
              type="number"
              style={styles.input}
              value={form.units}
              onChange={(e) => setForm({ ...form, units: e.target.value })}
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
            <input style={styles.input} value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} />
          </div>
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
                  <button style={styles.buttonDanger} onClick={() => removePurchase(p.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {purchases.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={6}>
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
// Issues tab — simple daily total per item (in purchase_unit)
// ---------------------------------------------------------------------------

function IssuesTab({ items, issues, location, period, onAdd, onRemove }) {
  const [form, setForm] = useState({
    item_id: items[0]?.id || '',
    date: new Date().toISOString().slice(0, 10),
    qty: '',
    reason: 'Service',
    note: '',
  })
  const [saving, setSaving] = useState(false)

  async function addIssue() {
    if (!form.item_id || !form.qty) return
    setSaving(true)
    const [row] = await sb.insert('food_issues', {
      item_id: form.item_id,
      location_id: location,
      period: toPeriod(form.date),
      date: form.date,
      qty: Number(form.qty),
      reason: form.reason,
      note: form.note,
    })
    setForm({ ...form, qty: '', note: '' })
    setSaving(false)
    onAdd(row)
  }

  async function removeIssue(id) {
    await sb.remove('food_issues', { id })
    onRemove(id)
  }

  const itemName = (id) => items.find((i) => i.id === id)?.name || '—'

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Log issued stock</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Tracks a simple daily total per item, in the item's purchase unit. "Service" is normal
          kitchen consumption — everything else (Breakage, Expired, Staff, Other) is a write-off,
          tracked separately on the Dashboard.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Item</label>
            <select style={styles.input} value={form.item_id} onChange={(e) => setForm({ ...form, item_id: e.target.value })}>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Date</label>
            <input type="date" style={styles.input} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Qty issued</label>
            <input type="number" style={styles.input} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Reason</label>
            <select style={styles.input} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {ISSUE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r === 'Service' ? 'Service (normal consumption)' : r}
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
                <td style={styles.tdNum}>{fmt(i.qty, 1)}</td>
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

function CountTab({ items, stockByItem, metricsByItem, location, period, role, onSave, onLinkItem }) {
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
            {showTheoretical && <th style={styles.th}>Theoretical</th>}
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
// Variance tab — the core costing/variance engine output
// ---------------------------------------------------------------------------

function VarianceTab({ items, metricsByItem, allClosed, onClosePeriod }) {
  const totals = items.reduce(
    (acc, it) => {
      const m = metricsByItem[it.id]
      acc.purchaseCost += m?.purchaseCost || 0
      acc.varianceValue += m?.varianceValue || 0
      return acc
    },
    { purchaseCost: 0, varianceValue: 0 }
  )

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={styles.cardTitle}>Variance & weighted-average cost</div>
        <button style={styles.buttonGhost} onClick={onClosePeriod} disabled={allClosed}>
          {allClosed ? 'Period closed' : 'Close period'}
        </button>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Total purchases this period: R {fmt(totals.purchaseCost)} · Total variance value: R {fmt(totals.varianceValue)}
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
            <th style={styles.th}>Theoretical</th>
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
                    '—'
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

function RecipeCard({ recipe, items, metricsByItem, ingredients, onRemoveRecipe, onAddIngredient, onRemoveIngredient }) {
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
