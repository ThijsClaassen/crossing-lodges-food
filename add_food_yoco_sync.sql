-- Run once in the Supabase SQL editor.
--
-- Yoco Phase 2 for Food Stock (2026-08-26) — auto-issue stock when the POS
-- sells food. Phase 1 (already live) syncs Yoco sales into the Finance
-- Dashboard's income categories; Curio then got the stock side of it. This
-- is the same idea for Food, with one important difference.
--
-- Curio and Beverage sell the thing they stock: a beer sold is a beer
-- issued, one Yoco line -> one issue row. Food doesn't. A Yoco line reads
-- "Beef Burger", which isn't a stock item at all — it's a DISH, made of
-- mince, a bun and cheese. So the Food sync matches a Yoco name to a
-- food_recipes row first and issues each of its food_recipe_ingredients
-- (scaled by the recipe's portions), falling back to a direct food_items
-- match for things sold as-is (bottled water, crisps, chocolate).
--
-- Consequence for the dedup key: one Yoco line item now produces MANY
-- food_issues rows, so unlike curio_issues the unique constraint can't be
-- (company_id, yoco_line_item_id) — it has to include item_id. Re-running
-- the sync over the same dates still never double-counts, it just upserts
-- each (line item, ingredient) pair.
--
-- Issue reason is 'Service' — the existing "normal use" reason in this app
-- (confirmed with Thijs 2026-08-26). Deliberately NOT a new 'Sale' reason:
-- Service is already excluded from write-off reporting, so the Usage and
-- variance maths keep working with no changes at all.
--
-- Safe to re-run.

-- 1. Link food_issues back to the Yoco line that caused it ----------------

alter table food_issues
  add column if not exists yoco_line_item_id uuid references pos_sales_line_items(id);

-- Include item_id: a single sold dish explodes into one row per ingredient.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'food_issues_company_yoco_line_item_item_key'
  ) then
    alter table food_issues
      add constraint food_issues_company_yoco_line_item_item_key
      unique (company_id, yoco_line_item_id, item_id);
  end if;
end $$;

create index if not exists idx_food_issues_yoco_line_item on food_issues (yoco_line_item_id);

-- 2. Taught matches: Yoco item name -> a recipe OR a plain item ----------
--
-- Same "teach it once, use it verbatim forever" idea as
-- curio_yoco_item_aliases, but a Food target can be either kind, so the
-- alias carries both nullable columns and a check that exactly one is set.
-- Yoco item names don't change, so a taught match never needs re-guessing
-- and the fuzzy matcher can't later drift onto a different item.

create table if not exists food_yoco_item_aliases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  yoco_item_name text not null,
  recipe_id uuid references food_recipes(id) on delete cascade,
  item_id uuid references food_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (company_id, yoco_item_name),
  constraint food_yoco_alias_one_target check (
    (recipe_id is not null and item_id is null)
    or (recipe_id is null and item_id is not null)
  )
);

create index if not exists idx_food_yoco_aliases_company on food_yoco_item_aliases (company_id);

alter table food_yoco_item_aliases enable row level security;

drop policy if exists "read_company_food_yoco_aliases" on food_yoco_item_aliases;
create policy "read_company_food_yoco_aliases" on food_yoco_item_aliases
  for select using (has_company_access(company_id));

-- Anyone who can run the sync can teach a match — same access level as
-- logging an issue by hand, which is what this ultimately automates.
drop policy if exists "write_company_food_yoco_aliases" on food_yoco_item_aliases;
create policy "write_company_food_yoco_aliases" on food_yoco_item_aliases
  for all using (has_company_access(company_id))
  with check (has_company_access(company_id));

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select column_name from information_schema.columns
where table_name = 'food_issues' and column_name = 'yoco_line_item_id';

select conname from pg_constraint
where conname = 'food_issues_company_yoco_line_item_item_key';

select count(*) as alias_rows from food_yoco_item_aliases;

-- REMINDER: food_yoco_item_aliases is a NEW table — switch it on under
-- Data API -> Exposed tables, or every read/write from the app 404s.
