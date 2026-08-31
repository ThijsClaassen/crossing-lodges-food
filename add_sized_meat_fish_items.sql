-- ==========================================================================
-- STEP 2 of 2 — adds the 45 sized meat/fish items to EC and ZC.
--
-- Thijs, 2026-08-31: "We first uploaded meat/fish items just as items, but we
-- actually buy and store them in different sizes, so also want them listed
-- like that. Please already mark all items as 15% items."
--
-- 45 items x 2 lodges = 90 rows.
--
-- HOW THEY ARE MODELLED (this drives recipe costing, so it is worth reading)
--   purchase_unit     = 'ea'  — one unit is ONE pack/piece of the size named,
--                              so a stock count is "how many 300g shanks are
--                              on the shelf", not a weigh-in.
--   recipe_unit       = 'g'
--   conversion_factor = the gram weight in the name (300, 250, 1000, 2000…)
--
-- That pairing is what lets a recipe draw 150g from a 300g shank and be
-- charged exactly half its cost. The app divides the weighted average cost
-- per pack by conversion_factor to get cost per gram.
--
-- IF A SIZE IS WRONG, FIX conversion_factor, NOT JUST THE NAME. The name is
-- only a label; the number is what costs the recipe. Renaming an item to
-- "500g" while conversion_factor still says 250 would silently double every
-- recipe cost that uses it.
--
-- vat_treatment = 'standard_15' on all of them, as asked. Meat and fish are
-- standard-rated in South Africa, so this is also correct on the merits — it
-- is only the basics (brown bread, maize, milk, eggs, fruit and veg) that are
-- zero-rated. See add_food_item_vat_treatment.sql.
--
-- Categories are LAMB / PORK / BEEF / CHICKEN / FISH / GAME rather than one
-- flat 'Meats / Fish', so the Issues tab's category-then-item picker gives
-- the kitchen a short second list instead of scrolling 45 names.
--
-- SAFE TO RE-RUN. The insert skips any item whose name already exists for
-- that company and lodge, so running it twice adds nothing and running it
-- after you have hand-edited an item will not overwrite your edit.
--
-- Two names corrected on Thijs's instruction (2026-08-31): "Elland" -> "Eland",
-- and "BWB" spelled out as "Blue Wildebeest".
-- ==========================================================================


-- -------------------------------------------------------------------------
-- Rename first, in case an earlier draft of this file was already run.
--
-- These are no-ops if you have not run the insert yet, which is the likely
-- case. They exist so this file is correct either way rather than depending
-- on which version you happened to run — and renaming beats deleting and
-- re-inserting, because a delete would orphan any stock count or recipe line
-- already attached to those items.
-- -------------------------------------------------------------------------

update food_items fi
set name = 'Eland' || substring(fi.name from 7)
from companies c
where c.id = fi.company_id
  and c.name = 'Crossing Lodges'
  and fi.location_id in ('EC', 'ZC')
  and fi.name like 'Elland %';

update food_items fi
set name = 'Blue Wildebeest' || substring(fi.name from 4)
from companies c
where c.id = fi.company_id
  and c.name = 'Crossing Lodges'
  and fi.location_id in ('EC', 'ZC')
  and fi.name like 'BWB %';


with company as (
  select id from companies where name = 'Crossing Lodges'
),
lodges(location_id) as (values ('EC'), ('ZC')),
new_items(category, name, grams) as (values
  ('LAMB', 'Lamb shanks 300g', 300),
  ('LAMB', 'Lamb racks 200g', 200),
  ('LAMB', 'Lamb chop 200g', 200),
  ('LAMB', 'Lamb riblets 1kg per pkt', 1000),
  ('LAMB', 'Lamb stew 1kg', 1000),
  ('LAMB', 'Leg of lamb 2kg', 2000),
  ('PORK', 'Pork fillets 250g', 250),
  ('PORK', 'Pork fillets 500g', 500),
  ('PORK', 'Pork belly 200g', 200),
  ('PORK', 'Pork chops 250g', 250),
  ('PORK', 'Pork sausage 1kg', 1000),
  ('PORK', 'Bacon 1kg', 1000),
  ('BEEF', 'Beef fillet 250g', 250),
  ('BEEF', 'Beef fillet 500g', 500),
  ('BEEF', 'Sirloin 1kg per pkt', 1000),
  ('BEEF', 'Rump steak 250g', 250),
  ('BEEF', 'Oxtail 1kg per pkt', 1000),
  ('BEEF', 'Beef wors 1kg', 1000),
  ('BEEF', 'Beef mince 1kg', 1000),
  ('BEEF', 'Beef sausage 1kg', 1000),
  ('BEEF', 'Bone marrow 150g', 150),
  ('CHICKEN', 'Whole chicken 2kg', 2000),
  ('CHICKEN', 'Chicken fillets 1kg', 1000),
  ('CHICKEN', 'Chicken wings 1kg', 1000),
  ('FISH', 'Salmon fillet 250g', 250),
  ('FISH', 'Kingklip 250g', 250),
  ('FISH', 'Sole fish 250g', 250),
  ('FISH', 'Smoked salmon 80g', 80),
  ('FISH', 'Prawns 1kg', 1000),
  ('FISH', 'Hake 250g', 250),
  ('GAME', 'Buffalo fillets 250g', 250),
  ('GAME', 'Impala fillets 250g', 250),
  ('GAME', 'Impala shanks 300g', 300),
  ('GAME', 'Blue Wildebeest fillets 250g', 250),
  ('GAME', 'Blue Wildebeest fillets 500g', 500),
  ('GAME', 'Eland fillets 250g', 250),
  ('GAME', 'Eland fillets 500g', 500),
  ('GAME', 'Kudu fillets 250g', 250),
  ('GAME', 'Kudu fillets 500g', 500),
  ('GAME', 'Nyala fillets 250g', 250),
  ('GAME', 'Ostrich fillets 250g', 250),
  ('GAME', 'Duck breast 200g', 200),
  ('GAME', 'Carpaccio 80g', 80),
  ('GAME', 'Game wors 1kg', 1000),
  ('GAME', 'Game mince 1kg', 1000)
)
insert into food_items (
  company_id, location_id, name, category,
  purchase_unit, recipe_unit, conversion_factor,
  min_units, max_units, order_pack_size,
  active, vat_treatment
)
select
  c.id, l.location_id, n.name, n.category,
  'ea', 'g', n.grams,
  0, 0, 1,
  true, 'standard_15'
from new_items n
cross join lodges l
cross join company c
where not exists (
  select 1 from food_items fi
  where fi.company_id  = c.id
    and fi.location_id = l.location_id
    and fi.name        = n.name
);

-- =========================================================================
-- VERIFICATION — expect 45 per lodge, 90 total, all 'standard_15'.
-- =========================================================================

select
  fi.location_id as lodge,
  fi.category,
  count(*)                                            as items,
  count(*) filter (where fi.vat_treatment = 'standard_15') as marked_15pct,
  min(fi.conversion_factor)                           as smallest_grams,
  max(fi.conversion_factor)                           as largest_grams
from food_items fi
join companies c on c.id = fi.company_id
where c.name = 'Crossing Lodges'
  and fi.location_id in ('EC','ZC')
  and fi.category in ('LAMB','PORK','BEEF','CHICKEN','FISH','GAME')
group by rollup (fi.location_id, fi.category)
order by fi.location_id nulls last, fi.category nulls last;
