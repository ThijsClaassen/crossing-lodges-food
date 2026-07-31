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

- **Dashboard** — stock value (expected vs. actual counted), usage this
  period (calculated automatically — see "Usage model" below), a
  By-supplier breakdown, and highest-usage / no-usage items this period.
- **Items** — the kitchen stock master list, one per lodge. Each item has
  a **purchase unit** (what you buy/count/order in, e.g. 'kg') and a
  **recipe unit** (what recipes measure in, e.g. 'g'), linked by a
  conversion factor — see "Units" below.
- **Suppliers** — one list per lodge, with contact details, linked to items.
- **Menu** — build recipes from ingredient items + quantities, and see the
  cost per recipe and per portion calculated live from current ingredient
  costs. See "Recipe costing" below. Optional — not needed for day-to-day
  stock tracking, only if you want to cost out a specific dish or event.
- **Opening** — set/correct opening stock and opening cost per unit for
  the current period.
- **Purchases** — log purchases as they come in, same as before.
- **Write-offs** (was "Issues") — log stock lost to breakage, spoilage,
  staff meals, or other waste **only**. Normal cooking usage is never
  logged here — see "Usage model" below.
- **Count** (with barcode Scan mode and a Submit-and-clear workflow) —
  enter the physical closing count; this is what usage gets calculated
  from.
- **Usage** (was "Variance") — the automatic usage figure per item:
  Expected (opening + purchases − write-offs) minus Counted.
- **Orders** — the automatic restock list (grouped by supplier, with a
  Copy list button per supplier), same as beverage, **plus a menu order
  planner** underneath it (optional — see "Menu order planner" below).
- **Admin / Staff login** — shared password per role, own `food_access`
  table (not shared with the beverage or ops apps' logins). Staff only
  sees Write-offs and Count (with Expected/Usage hidden on Count, same
  reasoning as beverage: a count shouldn't be anchored to what the books
  say).

## Usage model: opening + purchases − closing count

This app deliberately does **not** ask you to log every dish that goes out
the kitchen door. Since menus change constantly and chefs have full
creative freedom, a per-dish issue log isn't realistic to keep up. Instead:

1. Set **opening stock** for the period (carried forward automatically from
   last period's closing count, same as before).
2. Log **purchases** as they come in, same as before.
3. Optionally log **write-offs** — breakage, spoilage, staff meals, other
   waste — on the Write-offs tab, *only* for stock that didn't get used in
   the kitchen at all.
4. Do a **physical closing count** at the end of the period.

Usage is then calculated automatically, per item:

```
Expected = opening + purchases − write-offs logged
Usage    = Expected − physical count
```

You never enter a usage figure directly — it falls out of the count. This
is exactly the same arithmetic the app already used internally to compute
"variance" (count vs. theoretical) — nothing about the weighted-average
costing engine changed. What changed is the framing: instead of treating
a gap between the books and the shelf as a counting *error* to chase down,
it's now the expected, useful signal — how much was cooked and served.

**Trade-off worth knowing:** because usage isn't logged transaction by
transaction anymore, the Orders tab's automatic reorder alert (based on
each item's Expected stock vs. its min/max levels) only updates when you
log a write-off or do a fresh count — it won't reflect day-to-day cooking
usage in between. Count more often (e.g. weekly instead of monthly) if you
want the reorder list to stay closer to real-time. A negative usage figure
(count came in *higher* than Expected) is flagged red on the Count and
Usage tabs — it usually means either a purchase or write-off wasn't
logged, or the count itself is worth double-checking.

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

## Menu order planner

On the Orders tab, below the automatic restock list, there's a second
module: pick one or more menus from the Menu tab, enter how many guests
each one is for, and it works out exactly what you need to buy for the
event.

1. **Add a menu row** for each dish (or use the same one for a single
   course) — pick the recipe, type the guest count. Use "Default guests"
   + "Apply to all rows" if the whole event is one headcount, or set each
   row individually if courses have different numbers (e.g. a vegetarian
   option chosen by fewer guests).
2. For every ingredient across all the rows, it calculates: `qty per
   portion (recipe's total qty ÷ recipe's portions) × guests`, summed
   across every menu that uses that ingredient — so if two dishes both use
   onions, the total is combined before it's checked against stock.
3. That total is converted from the item's recipe unit into its purchase
   unit (same conversion factor used for recipe costing), then compared
   against current stock (the physical count if one exists this period,
   otherwise the theoretical running total) to work out what's short.
4. Anything short is grouped by supplier — same pattern, same Copy list
   button — as the restock list above it.

This is independent of the automatic restock list's min/max levels — it's
answering "do I have enough for this specific event," not "am I generally
running low." An item can show up in both lists for different reasons, or
in neither if you're already well stocked for both.

It's a **live calculator, not a saved plan** — the guest counts and menu
selections reset if you navigate away from the Orders tab. If you want to
come back to a plan later (e.g. finalize numbers a few days before an
event), keep a note of what you picked and re-enter it; ask if you'd
rather have named, saved event plans instead.

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

## Known limitations

- **Client-side role gate, not database-enforced** — Admin/Staff both use
  the same anon key; the split only controls what the app shows, not what
  the database allows.
- **RLS is fully open** (`allow_all`) on the data tables; `food_access` is
  read-only from the client.
- **Reorder alerts lag between counts** — see "Trade-off worth knowing"
  above. Count more frequently if this matters for a fast-moving item.
- **Usage is a lump sum, not a per-dish breakdown** — you'll know *how
  much* of an ingredient was used this period, not which dishes it went
  into. If you ever want per-dish cost tracking again, the Menu tab's
  recipe costing is still there, just not wired into the usage figure.
- The `reason` column on `food_issues` still has a database default of
  `'Service'` from before this change — harmless (the app always sends an
  explicit reason now) but cosmetic; safe to leave as-is or update via the
  Table Editor if you'd rather it default to `'Breakage'`.
