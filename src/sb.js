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

export const sb = {
  // select('food_items', { location_id: 'ZC' }, { select: '*', order: 'name.asc' })
  async select(table, filters = {}, opts = {}) {
    const params = { ...filters }
    if (opts.select) params.select = opts.select
    if (opts.order) params.order = opts.order
    const res = await fetch(`${REST}/${table}${qs(params)}`, {
      headers: await headers(),
    })
    return handle(res)
  },

  async insert(table, rows) {
    const res = await fetch(`${REST}/${table}`, {
      method: 'POST',
      headers: await headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    })
    return handle(res)
  },

  // upsert on a unique constraint, e.g. onConflict = 'item_id,period'
  async upsert(table, rows, onConflict) {
    const res = await fetch(
      `${REST}/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      {
        method: 'POST',
        headers: await headers({
          Prefer: 'resolution=merge-duplicates,return=representation',
        }),
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      }
    )
    return handle(res)
  },

  async update(table, filters, patch) {
    const res = await fetch(`${REST}/${table}${qs(filters)}`, {
      method: 'PATCH',
      headers: await headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    })
    return handle(res)
  },

  async remove(table, filters) {
    const res = await fetch(`${REST}/${table}${qs(filters)}`, {
      method: 'DELETE',
      headers: await headers({ Prefer: 'return=representation' }),
    })
    return handle(res)
  },
}

export const LOCATIONS = [
  { id: 'ZC', name: 'Zebras Crossing' },
  { id: 'EC', name: 'Elephants Crossing' },
  { id: 'SC', name: 'Schamach' },
]

export function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Standard unit dropdown — deliberately not derived from any messy source
// data. Both purchase_unit and recipe_unit pick from this same list, plus a
// conversion_factor field on each item (how many recipe_units per 1
// purchase_unit — e.g. purchase in 'kg', recipe in 'g', factor 1000).
export const UNITS = ['kg', 'g', 'L', 'ml', 'ea', 'pkt', 'box', 'can', 'tray', 'bunch', 'dozen']
