-- Run once in the Supabase SQL editor.
--
-- FOOD STOCK 3c of the multi-tenant rebuild — replaces the `allow_all`
-- policies on all 7 Food Stock tables (using (true) with check (true)) with
-- has_company_access(company_id), so a user can only ever read or write
-- rows belonging to a company they actually have access to. Same helper
-- function already used for the Finance Dashboard's Phase 2c and confirmed
-- to exist in this shared project.
--
-- Each table originally had ONE combined `for all` policy rather than
-- separate select/insert/update/delete policies (unlike the Finance
-- Dashboard's tables) — kept that same single-policy-per-table shape here
-- rather than introducing a new convention partway through the project.
--
-- food_access (the now-unused shared admin/staff password table) is
-- deliberately left untouched — 3b already replaced the app's login screen
-- entirely, so nothing reads this table anymore; its cleanup (or removal)
-- is a separate, later decision, not part of this migration.
--
-- Access model, same as the Finance Dashboard's Phase 2c: any company
-- member (admin or staff) can read and write — no new admin-only DB-level
-- restriction, matching this app's existing UI-only role gating.
--
-- Confirmed safe to run: Thijs is currently the only real Food Stock user,
-- so there's no risk of locking out an unprovisioned teammate.
--
-- Safe to re-run: every policy is dropped and recreated.

drop policy if exists allow_all_food_items on food_items;
create policy company_scoped_food_items on food_items
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists allow_all_food_stock_periods on food_stock_periods;
create policy company_scoped_food_stock_periods on food_stock_periods
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists allow_all_food_purchases on food_purchases;
create policy company_scoped_food_purchases on food_purchases
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists allow_all_food_issues on food_issues;
create policy company_scoped_food_issues on food_issues
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists allow_all_food_suppliers on food_suppliers;
create policy company_scoped_food_suppliers on food_suppliers
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists allow_all_food_recipes on food_recipes;
create policy company_scoped_food_recipes on food_recipes
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists allow_all_food_recipe_ingredients on food_recipe_ingredients;
create policy company_scoped_food_recipe_ingredients on food_recipe_ingredients
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

-- =========================================================================
-- VERIFICATION — run after the above, as a sanity check that nothing
-- errored. This runs as the SQL editor's own elevated role, which bypasses
-- RLS entirely, so it can't itself prove the policy works — only testing
-- the live app (logged in normally, and logged in as the Demo test user in
-- 3d) actually proves that.
-- =========================================================================

select 'food_items' as table_name, count(*) from food_items
union all select 'food_stock_periods', count(*) from food_stock_periods
union all select 'food_purchases', count(*) from food_purchases
union all select 'food_issues', count(*) from food_issues
union all select 'food_suppliers', count(*) from food_suppliers
union all select 'food_recipes', count(*) from food_recipes
union all select 'food_recipe_ingredients', count(*) from food_recipe_ingredients
order by table_name;

-- =========================================================================
-- ROLLBACK — only if something breaks and you need the app working again
-- immediately while we investigate. Restores the exact permissive policies
-- that were in place before this file ran. Not run as part of this
-- migration — copy/paste by hand only if needed.
-- =========================================================================

-- drop policy if exists company_scoped_food_items on food_items;
-- create policy allow_all_food_items on food_items for all using (true) with check (true);
--
-- drop policy if exists company_scoped_food_stock_periods on food_stock_periods;
-- create policy allow_all_food_stock_periods on food_stock_periods for all using (true) with check (true);
--
-- drop policy if exists company_scoped_food_purchases on food_purchases;
-- create policy allow_all_food_purchases on food_purchases for all using (true) with check (true);
--
-- drop policy if exists company_scoped_food_issues on food_issues;
-- create policy allow_all_food_issues on food_issues for all using (true) with check (true);
--
-- drop policy if exists company_scoped_food_suppliers on food_suppliers;
-- create policy allow_all_food_suppliers on food_suppliers for all using (true) with check (true);
--
-- drop policy if exists company_scoped_food_recipes on food_recipes;
-- create policy allow_all_food_recipes on food_recipes for all using (true) with check (true);
--
-- drop policy if exists company_scoped_food_recipe_ingredients on food_recipe_ingredients;
-- create policy allow_all_food_recipe_ingredients on food_recipe_ingredients for all using (true) with check (true);
