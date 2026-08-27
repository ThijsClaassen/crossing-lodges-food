// Lightweight Supabase REST wrapper — same pattern as crossing-lodges-ops
// and crossing-lodges-beverage (small bundle, no SDK version dependency,
// plain fetch calls against PostgREST).
//
// URL/key now live in supabaseClient.js (2026-08-08 — Food Stock 3b of the
// multi-tenant rebuild), alongside the real Supabase Auth client that login
// uses. Every request here now carries the logged-in user's own session
// token (falling back to the anon key only if there's no session yet) —
// required so RLS's auth.uid() can actually identify who's asking, once 3c
// rewrites these tables' policies from allow_all to company-scoped. Every
// call site's own signature (sb.select/insert/upsert/update/remove) is
// unchanged; only how the request is authenticated changed.

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js'

const REST = `${SUPABASE_URL}/rest/v1`

async function headers(extra = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

function qs(filters = {}) {
  const parts = []
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue
    // pass through already-formed postgrest filters like { period: 'eq.2026-07' }
    parts.push(`${key}=${typeof value === 'string' && value.includes('.') ? value : `eq.${value}`}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

async function handle(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// Transient clock-skew retry (2026-08-26).
//
// Supabase sometimes rejects a perfectly valid token with PGRST303 ("JWT
// issued at future"): its Auth service mints the token using one node's
// clock, PostgREST validates it against another, and if Auth is a second or
// two ahead the token looks like it hasn't been issued yet. It's transient,
// server-side, and nothing to do with this app or the user's device — the
// same request succeeds moments later.
//
// So: retry once after a short pause, then let the error surface normally.
// Deliberately NOT "fixed" by adding clock leeway or skipping iat
// verification — that's a real signature check, and weakening it to paper
// over infrastructure drift would weaken auth for every user. If this starts
// happening a lot, the actual fix is a Supabase support ticket, not more
// retries here.
const CLOCK_SKEW_RETRY_MS = 1500

async function isClockSkewError(res) {
  if (res.ok) return false
  try {
    const body = await res.clone().text()
    return body.includes('PGRST303') || body.includes('JWT issued at future')
  } catch {
    return false
  }
}

// buildInit is a function, not an object, so the retry rebuilds its headers
// and picks up a refreshed access token if the client rotated one meanwhile.
async function sbFetch(url, buildInit) {
  let res = await fetch(url, await buildInit())
  if (await isClockSkewError(res)) {
    await new Promise((r) => setTimeout(r, CLOCK_SKEW_RETRY_MS))
    res = await fetch(url, await buildInit())
  }
  return res
}

export const sb = {
  // select('food_items', { location_id: 'ZC' }, { select: '*', order: 'name.asc' })
  async select(table, filters = {}, opts = {}) {
    const params = { ...filters }
    if (opts.select) params.select = opts.select
    if (opts.order) params.order = opts.order
    const res = await sbFetch(`${REST}/${table}${qs(params)}`, async () => ({
      headers: await headers(),
    }))
    return handle(res)
  },

  async insert(table, rows) {
    const res = await sbFetch(`${REST}/${table}`, async () => ({
      method: 'POST',
      headers: await headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    }))
    return handle(res)
  },

  // upsert on a unique constraint, e.g. onConflict = 'item_id,period'
  async upsert(table, rows, onConflict) {
    const res = await sbFetch(`${REST}/${table}?on_conflict=${encodeURIComponent(onConflict)}`, async () => ({
        method: 'POST',
        headers: await headers({
          Prefer: 'resolution=merge-duplicates,return=representation',
        }),
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      }))
    return handle(res)
  },

  async update(table, filters, patch) {
    const res = await sbFetch(`${REST}/${table}${qs(filters)}`, async () => ({
      method: 'PATCH',
      headers: await headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    }))
    return handle(res)
  },

  async remove(table, filters) {
    const res = await sbFetch(`${REST}/${table}${qs(filters)}`, async () => ({
      method: 'DELETE',
      headers: await headers({ Prefer: 'return=representation' }),
    }))
    return handle(res)
  },
}

// Lodges for the current company. Loaded from the shared `locations` table
// at login (see CompanyContext.jsx) instead of being hardcoded, so a second
// company's own lodges work without a code change (2026-08-26).
//
// Deliberately a MUTABLE module array rather than React state: this app
// already reads LOCATIONS synchronously in a number of places, some outside
// components, and converting every one to a hook would be a large change for
// no visible benefit today. CompanyContext fills this in BEFORE it renders
// any children, and refills it on company switch, so by the time anything
// reads it, it's correct. The array identity never changes — contents are
// replaced in place — so existing dependency arrays keep behaving as before.
export const LOCATIONS = []

// Only 'lodge' rows: the shared locations table also holds an 'overhead'
// (head office) row that the Finance Dashboard uses for non-lodge costs and
// that this app has never shown. Ordering is by created_at, not id, because
// the established display order is ZC, EC, SC — which alphabetical order
// would reshuffle to EC, SC, ZC.
export function setLocations(rows) {
  LOCATIONS.length = 0
  for (const r of rows || []) {
    if (r.type && r.type !== 'lodge') continue
    LOCATIONS.push({ id: r.id, name: r.name, type: r.type ?? null })
  }
}

export function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Standard unit dropdown — deliberately not derived from any messy source
// data. Both purchase_unit and recipe_unit pick from this same list, plus a
// conversion_factor field on each item (how many recipe_units per 1
// purchase_unit — e.g. purchase in 'kg', recipe in 'g', factor 1000).
export const UNITS = ['kg', 'g', 'L', 'ml', 'ea', 'pkt', 'box', 'can', 'tray', 'bunch', 'dozen']
