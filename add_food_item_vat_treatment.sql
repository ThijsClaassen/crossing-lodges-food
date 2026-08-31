-- Run once in the Supabase SQL editor.
--
-- Per-item VAT treatment (2026-08-31) — Thijs: "Some food is VAT included,
-- other not... on our slips from Pick n Pay there is a # behind every item
-- that has no VAT as a rule. Can we learn the system that so it will pick it
-- up and allocate correctly?"
--
-- THE PROBLEM THIS FIXES
-- The Food app had a single slip-level toggle ("Slip prices include VAT")
-- which divided EVERY line by 1.15. On a retail till slip that is wrong for
-- zero-rated basic foodstuffs — brown bread, maize meal, rice, lentils, milk,
-- eggs, fresh fruit and veg — which carry no VAT at all. Their printed price
-- IS the cost. Stripping 15% off them recorded those items about 13% cheaper
-- than they really were, and that understatement flowed straight into COGS,
-- cost per guest per night, and the Finance Dashboard.
--
-- WHY ON THE ITEM RATHER THAN THE SLIP
-- Zero-rating is a property of the product, not of the seller: brown bread is
-- zero-rated whoever sells it. Storing it on the item means it stays correct
-- for suppliers whose slips print no marker at all, and for purchases typed in
-- by hand where there is no slip to read. The scanner's marker just seeds it
-- the first time.
--
-- NULL IS MEANINGFUL HERE — it means "nobody has said yet", which is different
-- from "somebody confirmed this is standard-rated". A null item defers to what
-- the slip says; an item with a value overrides the slip, because a human
-- decision should outrank an OCR guess. If this column defaulted to
-- 'standard_15' instead, that distinction would be lost and the app could
-- never tell an unreviewed item from a reviewed one.
--
-- Vocabulary deliberately matches the Finance Dashboard's bank_transactions
-- .vat_treatment ('standard_15' / 'zero_rated') rather than inventing a second
-- set of names for the same idea.
--
-- Safe to re-run.

alter table food_items
  add column if not exists vat_treatment text
    check (vat_treatment in ('standard_15', 'zero_rated'));

comment on column food_items.vat_treatment is
  'VAT treatment of this product. NULL = not yet established, in which case the slip scanner''s reading is used and then saved back here. standard_15 = normal 15% VAT. zero_rated = SARS zero-rated basic foodstuff, so the printed retail price is already the full cost and no VAT may be stripped from it.';

-- Audit trail on the purchase itself: what treatment was actually applied at
-- capture time. Without this, a past row's total_cost_excl_vat cannot be
-- explained later if the item's status is subsequently corrected — you would
-- see a figure and have no way to tell whether VAT had been removed from it.
alter table food_purchases
  add column if not exists vat_treatment text
    check (vat_treatment in ('standard_15', 'zero_rated'));

comment on column food_purchases.vat_treatment is
  'The VAT treatment applied to this line when it was captured. Historical rows are NULL, meaning the old slip-wide behaviour applied. Recorded for audit only — nothing recalculates from it.';

-- =========================================================================
-- OPTIONAL HEAD START
-- =========================================================================
-- Uncomment to pre-flag the obvious SARS zero-rated staples by name, so the
-- common ones are right from the first scan instead of after it.
--
-- Left commented ON PURPOSE. It matches on item NAME, and a name like
-- "Milk Tart" or "Bread Crumbs" would be caught wrongly by a naive LIKE on
-- 'milk' or 'bread'. Read the SELECT below first, satisfy yourself the list
-- is right for your items, and only then run the UPDATE.
--
-- The legally zero-rated list is specific: brown bread, maize meal, samp,
-- mealie rice, dried mealies, dried beans, lentils, pilchards in tins, milk
-- powder, dairy powder blend, rice, vegetables, fruit, vegetable oil, milk,
-- cultured milk, brown wheaten meal, eggs, edible legumes. White bread, cake
-- flour and fruit juice are NOT zero-rated.

-- select id, name, category, vat_treatment
-- from food_items
-- where vat_treatment is null
--   and (
--     name ~* '(brown bread|maize|samp|mealie|lentil|dried bean|pilchard|rice|egg|milk)'
--     or category ~* 'fresh and veg'
--   )
-- order by category, name;

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select column_name, data_type, is_nullable
from information_schema.columns
where table_name in ('food_items', 'food_purchases')
  and column_name = 'vat_treatment'
order by table_name;

-- Everything starts NULL — expected. The app fills these in as slips are
-- scanned and approved.
select
  coalesce(vat_treatment, 'not set yet') as vat_treatment,
  count(*) as items
from food_items
group by 1
order by 2 desc;
