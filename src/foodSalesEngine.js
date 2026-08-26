// Yoco live-sales -> food_issues sync engine (2026-08-26, "Yoco Phase 2").
//
// Reads already-synced Yoco POS data (pos_sales_orders / pos_sales_line_items
// — kept fresh by the Finance Dashboard's yoco-sync Edge Function; this app
// never talks to the Yoco API directly and never holds a Yoco secret) for a
// date range, keeps the lines that classify as F&B income, and turns each
// one into 'Service' issues so stock comes down on its own when the kitchen
// rings something up.
//
// THE FOOD-SPECIFIC BIT — recipe explosion.
// Curio and Beverage sell the thing they stock: one Yoco line -> one issue.
// Food doesn't. A Yoco line reads "Beef Burger", which is a DISH, not a
// stock item — what actually leaves the store room is mince, a bun and some
// cheese. So a Yoco name resolves in this order:
//
//   1. A taught alias (food_yoco_item_aliases), which can point at either a
//      recipe or a plain item — whatever a person picked in the unmatched
//      panel. Yoco item names never change, so a taught match is used
//      verbatim forever and the fuzzy matcher can't drift off it later.
//   2. A fuzzy match against food_recipes.name — the usual case for
//      anything cooked.
//   3. A fuzzy match against food_items.name — for things sold exactly as
//      bought (bottled water, crisps, a chocolate bar), where there's no
//      recipe and shouldn't be one.
//
// A resolved recipe expands into one issue per ingredient:
//     issued qty = ingredient.qty_recipe_unit / recipe.portions * sold qty
// The divide-by-portions matters: a lasagne recipe written for 8 portions
// consumes an eighth of its ingredients when one portion is sold. A recipe
// with no/zero portions is treated as 1 so a bad recipe under-issues rather
// than multiplying stock away.
//
// Because one Yoco line can now produce MANY food_issues rows, the dedup
// key is (company_id, yoco_line_item_id, item_id), not just the line item —
// see add_food_yoco_sync.sql. Re-running the sync over the same dates still
// never double-counts.
//
// Issue reason is 'Service', this app's existing "normal use" reason
// (already excluded from write-off reporting), so Usage and variance maths
// need no changes at all.
//
// Nothing is ever guessed into the wrong item: below the confidence
// threshold a line stays unmatched until a person teaches it. Yoco's own
// classification only reaches "premium food and beverages" — it can't tell
// a beer from a burger — so a beer sold simply won't match any recipe or
// food item here and lands in the unmatched panel, where the Beverage app
// picks it up instead.
import { supabase } from './supabaseClient.js'
import { sb } from './sb.js'

const FNB_CATEGORY_ID = 'income_premium_food_and_beverages'

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

function classifyLineItem(name, mappings) {
  const lower = String(name || '').toLowerCase()
  let best = null
  for (const m of mappings || []) {
    const needle = String(m.match_text || '').toLowerCase().trim()
    if (!needle) continue
    if (lower.includes(needle)) {
      if (!best || needle.length > best.match_text.toLowerCase().length) best = m
    }
  }
  if (best) return { categoryId: best.category_id, matched: true }
  return { categoryId: null, matched: false }
}

async function fetchPosSalesLineItems({ companyId, locationId, start, end }) {
  let orderQuery = supabase
    .from('pos_sales_orders')
    .select('id, location_id, closed_at')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .gte('closed_at', `${start}T00:00:00`)
    .lte('closed_at', `${end}T23:59:59`)
  if (locationId) orderQuery = orderQuery.eq('location_id', locationId)

  const { data: orders, error: ordersErr } = await orderQuery
  if (ordersErr) throw ordersErr
  if (!orders || orders.length === 0) return []

  const orderById = new Map(orders.map((o) => [o.id, o]))
  const { data: lineItems, error: liErr } = await supabase
    .from('pos_sales_line_items')
    .select('id, order_id, name, quantity, net_amount, tax_amount')
    .in(
      'order_id',
      orders.map((o) => o.id)
    )
  if (liErr) throw liErr

  return (lineItems || []).map((li) => ({
    ...li,
    location_id: orderById.get(li.order_id)?.location_id ?? null,
    closed_at: orderById.get(li.order_id)?.closed_at ?? null,
  }))
}

async function fetchCategoryMap(companyId) {
  const { data, error } = await supabase
    .from('yoco_item_category_map')
    .select('match_text, category_id')
    .eq('company_id', companyId)
  if (error) throw error
  return data || []
}

async function fetchAliasMap(companyId) {
  const { data, error } = await supabase
    .from('food_yoco_item_aliases')
    .select('yoco_item_name, recipe_id, item_id')
    .eq('company_id', companyId)
  if (error) throw error
  return new Map((data || []).map((row) => [row.yoco_item_name, row]))
}

// Teaches a permanent (company_id, yoco_item_name) -> recipe OR item match.
// Exactly one of recipeId/itemId must be set (the DB enforces this too).
export async function learnYocoItemMatch({ companyId, yocoItemName, recipeId = null, itemId = null }) {
  if ((recipeId && itemId) || (!recipeId && !itemId)) {
    throw new Error('Pick either a recipe or an item for this Yoco name, not both.')
  }
  const { error } = await supabase
    .from('food_yoco_item_aliases')
    .upsert(
      { company_id: companyId, yoco_item_name: yocoItemName, recipe_id: recipeId, item_id: itemId },
      { onConflict: 'company_id,yoco_item_name' }
    )
  if (error) throw error
}

// Expands a sold recipe into per-ingredient issue quantities.
// qty_recipe_unit is the amount for the WHOLE recipe, so one sold portion
// consumes qty_recipe_unit / portions of each ingredient.
function explodeRecipe({ recipe, ingredients, soldQty }) {
  const portions = Number(recipe.portions) > 0 ? Number(recipe.portions) : 1
  return ingredients
    .filter((ing) => ing.recipe_id === recipe.id)
    .map((ing) => ({
      item_id: ing.item_id,
      qty: (Number(ing.qty_recipe_unit) || 0) / portions * soldQty,
    }))
    .filter((r) => r.item_id && r.qty > 0)
}

// Runs the sync for [start, end] (YYYY-MM-DD, inclusive), optionally scoped
// to one location. `items`, `recipes` and `recipeIngredients` are the
// caller's already-loaded lists.
//
// Returns { totalFnbLines, matchedLines, issueRows, created, updated,
//           recipesUsed, unmatched }.
export async function syncYocoSales({ companyId, locationId, start, end, items, recipes, recipeIngredients }) {
  const [lineItems, mappings, aliasMap] = await Promise.all([
    fetchPosSalesLineItems({ companyId, locationId, start, end }),
    fetchCategoryMap(companyId),
    fetchAliasMap(companyId),
  ])

  const fnbLines = lineItems.filter((li) => classifyLineItem(li.name, mappings).categoryId === FNB_CATEGORY_ID)

  const activeItems = (items || []).filter((it) => it.active !== false)
  const activeRecipes = (recipes || []).filter((r) => r.active !== false)
  const itemsById = new Map(activeItems.map((it) => [it.id, it]))
  const recipesById = new Map(activeRecipes.map((r) => [r.id, r]))
  const ingredients = recipeIngredients || []

  // Keyed by `${yocoLineItemId}::${itemId}` so a dish sharing an ingredient
  // with itself (shouldn't happen, but cheap to be safe) accumulates rather
  // than producing two rows that violate the unique constraint.
  const upsertByKey = new Map()
  const unmatchedByName = new Map()
  let matchedLines = 0
  const recipesUsed = new Set()

  for (const li of fnbLines) {
    const soldQty = Number(li.quantity || 0)
    const closedDate = (li.closed_at || '').slice(0, 10)
    const alias = aliasMap.get(li.name)

    // Resolve: taught alias first, then recipes, then plain items.
    let recipe = alias?.recipe_id ? recipesById.get(alias.recipe_id) : null
    let item = alias?.item_id ? itemsById.get(alias.item_id) : null
    let recipeFuzzy = null
    let itemFuzzy = null

    if (!recipe && !item) {
      recipeFuzzy = findBestMatch(li.name, activeRecipes, 'name')
      if (recipeFuzzy?.confident) {
        recipe = recipeFuzzy.match
      } else {
        itemFuzzy = findBestMatch(li.name, activeItems, 'name')
        if (itemFuzzy?.confident) item = itemFuzzy.match
      }
    }

    const lines = recipe
      ? explodeRecipe({ recipe, ingredients, soldQty })
      : item
        ? [{ item_id: item.id, qty: soldQty }]
        : []

    if (lines.length > 0) {
      matchedLines += 1
      if (recipe) recipesUsed.add(recipe.id)
      for (const l of lines) {
        const key = `${li.id}::${l.item_id}`
        const existing = upsertByKey.get(key)
        if (existing) {
          existing.qty += l.qty
          continue
        }
        upsertByKey.set(key, {
          company_id: companyId,
          item_id: l.item_id,
          location_id: li.location_id || itemsById.get(l.item_id)?.location_id || locationId || null,
          period: closedDate.slice(0, 7),
          date: closedDate,
          qty: l.qty,
          reason: 'Service',
          note: recipe
            ? `Yoco sale — auto-synced ("${li.name}" → recipe ${recipe.name})`
            : `Yoco sale — auto-synced ("${li.name}")`,
          yoco_line_item_id: li.id,
        })
      }
      continue
    }

    // Unmatched — or matched to a recipe that has no ingredients yet, which
    // is functionally the same problem and worth surfacing the same way.
    const cur = unmatchedByName.get(li.name) || {
      name: li.name,
      orders: 0,
      quantity: 0,
      value: 0,
      lastSeen: null,
      reason: recipe ? 'recipe_has_no_ingredients' : 'no_match',
      recipeName: recipe?.name ?? null,
      suggestedRecipeId: recipe?.id ?? recipeFuzzy?.match?.id ?? null,
      suggestedRecipeName: recipe?.name ?? recipeFuzzy?.match?.name ?? null,
      suggestedItemId: itemFuzzy?.match?.id ?? null,
      suggestedItemName: itemFuzzy?.match?.name ?? null,
    }
    cur.orders += 1
    cur.quantity += soldQty
    cur.value += Number(li.net_amount || 0) - Number(li.tax_amount || 0)
    const seenDate = closedDate
    if (!cur.lastSeen || seenDate > cur.lastSeen) cur.lastSeen = seenDate
    unmatchedByName.set(li.name, cur)
  }

  const toUpsert = Array.from(upsertByKey.values()).map((r) => ({
    ...r,
    qty: Math.round(r.qty * 10000) / 10000,
  }))

  let created = 0
  let updated = 0
  if (toUpsert.length > 0) {
    const { data: existing } = await supabase
      .from('food_issues')
      .select('yoco_line_item_id, item_id')
      .eq('company_id', companyId)
      .in(
        'yoco_line_item_id',
        Array.from(new Set(toUpsert.map((r) => r.yoco_line_item_id)))
      )
    const existingKeys = new Set((existing || []).map((r) => `${r.yoco_line_item_id}::${r.item_id}`))
    created = toUpsert.filter((r) => !existingKeys.has(`${r.yoco_line_item_id}::${r.item_id}`)).length
    updated = toUpsert.length - created

    await sb.upsert('food_issues', toUpsert, 'company_id,yoco_line_item_id,item_id')
  }

  return {
    totalFnbLines: fnbLines.length,
    matchedLines,
    issueRows: toUpsert.length,
    created,
    updated,
    recipesUsed: recipesUsed.size,
    unmatched: Array.from(unmatchedByName.values()).sort((a, b) => b.value - a.value),
  }
}
