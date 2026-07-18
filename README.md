# Crossing Lodges — Food Stock App

A standalone React + Vite app for kitchen stock counts, purchases, issues,
variance/costing, and recipe costing — the second department app after
`crossing-lodges-beverage`, sharing the same Supabase project (department-
prefixed tables, this one uses `food_`) so a future company dashboard can
query across fleet, beverage, and food from one database.

Built in the same style as the beverage app, but as a single clean install
rather than something that grew across several rounds — it already
includes suppliers, write-off reasons, barcode linking, and recipe costing
from day one, no incremental migrations needed.

## What's here

- **Dashboard** — total stock value (theoretical vs. actual counted, plus
  the Rand-value gap between them), a By-supplier breakdown (stock value,
  movement, write-offs), and fastest-moving / not-moving items this period.
- **Items** — the kitchen stock master list, one per lodge. Each item has
  a **purchase unit** (what you buy/count/order in, e.g. 'kg') and a
  **recipe unit** (what recipes measure in, e.g. 'g'), linked by a
  conversion factor — see "Units" below.
- **Suppliers** — one list per lodge, with contact details, linked to items.
- **Menu** — build recipes from ingredient items + quantities, and see the
  cost per recipe and per portion calculated live from current ingredient
  costs. See "Recipe costing" below.
- **Opening** — set/correct opening stock and opening cost per unit for
  the current period.
- **Purchases**, **Issues** (with write-off reasons: Service, Breakage,
  Expired, Staff, Other), **Count** (with barcode Scan mode and a
  Submit-and-clear workflow), **Variance**, **Orders** (grouped by
  supplier, with a Copy list button per supplier) — all work exactly like
  the beverage app's equivalents.
- **Admin / Staff login** — shared password per role, own `food_access`
  table (not shared with the beverage or ops apps' logins). Staff only
  sees Issues and Count (with Theoretical/Variance hidden on Count, same
  reasoning as beverage: a count shouldn't be anchored to what the books
  say).

## 1. Database setup

This app is designed to live in the **same Supabase project** as
`crossing-lodges-ops` and `crossing-lodges-beverage`
(`https://arrendpmuwdhrfwvokhv.supabase.co`) — `src/sb.js` already has
that project's URL and anon key baked in as the default.

1. Open the Supabase SQL editor for that project.
2. Run `supabase/schema.sql` — creates `food_items`, `food_stock_periods`,
   `food_purchases`, `food_issues`, `food_suppliers`, `food_access`,
   `food_recipes`, `food_recipe_ingredients`, with the same open
   `allow_all` RLS policy style the other two apps use.
3. Run `supabase/seed_items.sql` — loads ~430 items (both EC and ZC
   combined) extracted from your kitchen stocklists, with opening stock
   for **2026-07** seeded from the most recent counted figure in each
   file. See "About the seed data" below for what was cleaned up/assumed.
4. **Change the default passwords** immediately: Table Editor →
   `food_access` → edit the `password` cell for `admin` and `staff` (they
   start as `ChangeMe-Admin1` / `ChangeMe-Staff1`).

## 2. Run locally / deploy

Same as the beverage app:

```
npm install
npm run dev
```

For deployment: push this folder to a new GitHub repo (e.g.
`crossing-lodges-food`), import it into Vercel, done — no environment
variables needed since credentials are baked into `sb.js`.

## Units: purchase unit vs. recipe unit

Food is bought in bulk (a 5kg bag, a case) but used in small amounts per
dish (200g). Each item has two units:

- **Purchase unit** — what you buy, count, and order in (Opening,
  Purchases, Count, Orders tabs all work in this unit).
- **Recipe unit** — what the Menu tab measures ingredients in.
- **Conversion factor** — how many recipe units make up 1 purchase unit
  (e.g. purchase unit 'kg', recipe unit 'g', factor 1000).

The dropdown for both is the same fixed list (`kg`, `g`, `L`, `ml`, `ea`,
`pkt`, `box`, `can`, `tray`, `bunch`, `dozen` — edit the `UNITS` array in
`src/sb.js` to add more). Every seeded item defaults to the same unit on
both sides with a factor of 1 — **set the real conversion the first time
you use that item in a recipe**, not for all 430 items upfront.

## Recipe costing

On the Menu tab, add ingredients to a recipe by picking an item and a
quantity in that item's recipe unit. Cost is computed live:

```
cost per recipe unit = weighted-average cost per purchase unit ÷ conversion factor
ingredient cost      = qty × cost per recipe unit
recipe total cost     = sum of ingredient costs
cost per portion      = total cost ÷ portions
```

Nothing about cost is stored on the recipe — it's recalculated every time
from the currently selected period's ingredient costs (same weighted-
average engine as the rest of the app), so recipe costs update
automatically as ingredient prices change. This app doesn't store a sell
price or margin — it's a cost calculator, you set pricing outside the app
using the cost-per-portion figure.

## About the seed data

The source files (`EC Food stocklist NEW.xlsx`, `ZC Food stocklist NEW.xlsx`)
were monthly physical stock counts across ~19 months, not purchase or
issue records — so only the item list and each item's **most recent**
counted stock figure were imported, as opening stock for 2026-07. No
purchase or issue history was imported; both apps start fresh from here.

A few things worth checking:

- **61 (EC+ZC combined) items had no price** in the source files —
  seeded at R0 opening cost. Check these in the Opening tab.
- **Units were deliberately not inferred from the messy source data**
  ("pkt", "PKt", "600gr", etc.). Only unambiguous ones (KG, L, ml, g and
  clear variants) were mapped automatically; everything else defaulted to
  `ea` on both purchase and recipe unit. Review units per item, especially
  before using it in a recipe.
- A few names repeat within the same lodge under different categories —
  e.g. "Dates" (fresh produce vs. dried pantry item) and "Beef stock"
  (liquid stock vs. a stock cube in Spices). These are genuinely different
  products and were kept as separate item rows.

## Known limitations (same as beverage, by design)

- **Client-side role gate, not database-enforced** — Admin/Staff both use
  the same anon key; the split only controls what the app shows, not what
  the database allows.
- **RLS is fully open** (`allow_all`) on the data tables; `food_access` is
  read-only from the client.
- **No per-cost-centre issue breakdown** — issues are a simple daily total
  per item, same as beverage's current state.
