-- Run once in the Supabase SQL editor.
--
-- FOOD STOCK 3a of the multi-tenant rebuild — adds company_id to all 7
-- Food Stock tables, the same additive-first approach used for the Finance
-- Dashboard (Phase 2a): nullable column -> backfill -> NOT NULL -> index.
--
-- This is the SAME Supabase project the Finance Dashboard already migrated
-- (confirmed with Thijs, 2026-08-08), so `companies`, `user_companies`,
-- `platform_admins`, the has_company_access()/has_company_role() helper
-- functions, and default_crossing_lodges_company_id() ALL ALREADY EXIST —
-- nothing from Phase 1 needs to be recreated here. This file only touches
-- Food Stock's own 7 tables.
--
-- Unlike Phase 2a, the column default is set in the SAME step the column
-- is added (not as an emergency follow-up) — that's the exact lesson from
-- the Finance Dashboard's post-2a incident: a NOT NULL company_id with no
-- default breaks every insert from an app that doesn't set it yet, and
-- default_crossing_lodges_company_id() already exists and is already
-- security definer, so there's no reason not to use it from the start here.
--
-- Also drops the hardcoded `check (location_id in ('ZC','EC','SC'))`
-- constraint on every table that has one — confirmed with Thijs (2026-08-08)
-- to do this now rather than later, so a future company isn't blocked from
-- using its own property codes. This does NOT touch any existing Crossing
-- Lodges data or the app's own ZC/EC/SC values, it only removes the
-- database-level restriction to exactly those three codes.
--
-- food_access (the shared admin/staff password table) is deliberately left
-- untouched — it becomes unused once Food Stock 3b replaces it with real
-- Supabase Auth, but that's app code's job, not this migration's.
--
-- Safe to re-run: every alter uses "if not exists" / "if exists" and every
-- backfill only touches rows where company_id is still null.

-- 1. Add the column, defaulted, to every Food Stock table -----------------

alter table food_items
  add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table food_stock_periods
  add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table food_purchases
  add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table food_issues
  add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table food_suppliers
  add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table food_recipes
  add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table food_recipe_ingredients
  add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();

-- 2. Backfill every existing row to Crossing Lodges ------------------------

update food_items set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update food_stock_periods set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update food_purchases set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update food_issues set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update food_suppliers set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update food_recipes set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update food_recipe_ingredients set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;

-- 3. Lock it down: every row must belong to a company from here on --------

alter table food_items alter column company_id set not null;
alter table food_stock_periods alter column company_id set not null;
alter table food_purchases alter column company_id set not null;
alter table food_issues alter column company_id set not null;
alter table food_suppliers alter column company_id set not null;
alter table food_recipes alter column company_id set not null;
alter table food_recipe_ingredients alter column company_id set not null;

-- 4. Indexes ----------------------------------------------------------------

create index if not exists idx_food_items_company on food_items (company_id);
create index if not exists idx_food_stock_periods_company on food_stock_periods (company_id);
create index if not exists idx_food_purchases_company on food_purchases (company_id);
create index if not exists idx_food_issues_company on food_issues (company_id);
create index if not exists idx_food_suppliers_company on food_suppliers (company_id);
create index if not exists idx_food_recipes_company on food_recipes (company_id);
create index if not exists idx_food_recipe_ingredients_company on food_recipe_ingredients (company_id);

-- 5. Drop the hardcoded ZC/EC/SC location check on every table that has one
--    (food_recipe_ingredients has no location_id column, nothing to drop
--    there). Postgres's auto-generated name for an inline column check is
--    <table>_<column>_check, matching the pattern already confirmed working
--    in the Finance Dashboard's own migrations.

alter table food_items drop constraint if exists food_items_location_id_check;
alter table food_stock_periods drop constraint if exists food_stock_periods_location_id_check;
alter table food_purchases drop constraint if exists food_purchases_location_id_check;
alter table food_issues drop constraint if exists food_issues_location_id_check;
alter table food_suppliers drop constraint if exists food_suppliers_location_id_check;
alter table food_recipes drop constraint if exists food_recipes_location_id_check;

-- 6. Verification — run this and check "total" equals "with_company" on
--    every row, and that location_id is still intact (still ZC/EC/SC for
--    every existing row — dropping the check constraint doesn't change any
--    existing value, it only stops enforcing the list going forward).

select 'food_items' as table_name, count(*) as total, count(company_id) as with_company from food_items
union all select 'food_stock_periods', count(*), count(company_id) from food_stock_periods
union all select 'food_purchases', count(*), count(company_id) from food_purchases
union all select 'food_issues', count(*), count(company_id) from food_issues
union all select 'food_suppliers', count(*), count(company_id) from food_suppliers
union all select 'food_recipes', count(*), count(company_id) from food_recipes
union all select 'food_recipe_ingredients', count(*), count(company_id) from food_recipe_ingredients
order by table_name;

select location_id, count(*) from food_items group by location_id order by location_id;
