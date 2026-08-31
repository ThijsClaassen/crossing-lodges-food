-- ==========================================================================
-- STEP 3 — retire the old unsized meat/fish items in EC and ZC.
-- Generated 2026-08-31 from the exact output of review_existing_meat_items.sql.
--
-- READ THIS FIRST — THE "SAFE TO DELETE" TRAP
-- The review was run AFTER the new items had been inserted, so all 90 new
-- sized items reported "no history - safe to DELETE". They have no history
-- because they are new. Acting on that verdict would have deleted the entire
-- import. So this file DELETES NOTHING. It only sets active = false.
--
-- Deactivating is the right tool regardless: every item below has purchases,
-- issues or stock counts behind it, and those records still underpin past
-- COGS and cost-per-guest-per-night figures. active = false removes the item
-- from the pickers while leaving its history intact — and is reversible.
--
-- 60 items, each with an unambiguous sized replacement already in place. The
-- replacement is named beside each one so the decision is auditable later.
--
-- DELIBERATELY NOT TOUCHED:
--   * 19 items with no clear or no unambiguous replacement — listed at the
--     bottom. They stay active until you decide.
--   * Stock cubes, spices and non-meat items that the review query caught by
--     name: "Beef stock", "Chicken stock granules", "Chicken spice",
--     "Fish Spice", "Portugese chicken", "Steak & Chop", "Bread crumps",
--     "Mixed Nuts", and "Baby Marrows" — which matched only because it
--     contains the letters "marrow". All real, current items. Left alone.
--
-- To undo: change false to true and re-run.
-- ==========================================================================

update food_items fi
set active = false
from companies c
where c.id = fi.company_id
  and c.name = 'Crossing Lodges'
  and fi.active
  and (fi.location_id, fi.name) in (
    ('EC', 'Bacon'),                      -- -> Bacon 1kg
    ('EC', 'Beef fillet'),                -- -> Beef fillet 250g/500g
    ('EC', 'Beef Rump'),                  -- -> Rump steak 250g
    ('EC', 'Beef Sirloin'),               -- -> Sirloin 1kg per pkt
    ('EC', 'Buffalo fillet'),             -- -> Buffalo fillets 250g
    ('EC', 'Chicken fillet'),             -- -> Chicken fillets 1kg
    ('EC', 'Chicken wings'),              -- -> Chicken wings 1kg
    ('EC', 'Duck Breat'),                 -- -> Duck breast 200g
    ('EC', 'Hake fillet'),                -- -> Hake 250g
    ('EC', 'hake'),                       -- -> Hake 250g
    ('EC', 'Kingklip'),                   -- -> Kingklip 250g
    ('EC', 'Lamb Chops'),                 -- -> Lamb chop 200g
    ('EC', 'Lamb Racks'),                 -- -> Lamb racks 200g
    ('EC', 'Lamb Shanks'),                -- -> Lamb shanks 300g
    ('EC', 'Lamb shank'),                 -- -> Lamb shanks 300g
    ('EC', 'Lamb riblets'),               -- -> Lamb riblets 1kg per pkt
    ('EC', 'Ostrich'),                    -- -> Ostrich fillets 250g
    ('EC', 'Ox tail'),                    -- -> Oxtail 1kg per pkt
    ('EC', 'Pork bellly'),                -- -> Pork belly 200g
    ('EC', 'Pork Chops'),                 -- -> Pork chops 250g
    ('EC', 'Pork Fillet'),                -- -> Pork fillets 250g/500g
    ('EC', 'Prawns'),                     -- -> Prawns 1kg
    ('EC', 'Salmon'),                     -- -> Salmon fillet 250g
    ('EC', 'Smoked Salmon'),              -- -> Smoked salmon 80g
    ('EC', 'Sole fish'),                  -- -> Sole fish 250g
    ('EC', 'Springbok Carpaccio'),        -- -> Carpaccio 80g
    ('EC', 'Whole chicken'),              -- -> Whole chicken 2kg
    ('EC', 'Impala Shank'),               -- -> Impala shanks 300g
    ('ZC', 'Bacon'),                      -- -> Bacon 1kg
    ('ZC', 'Beef fillet'),                -- -> Beef fillet 250g/500g
    ('ZC', 'Beef Rump'),                  -- -> Rump steak 250g
    ('ZC', 'Sirloin'),                    -- -> Sirloin 1kg per pkt
    ('ZC', 'Bone marrow'),                -- -> Bone marrow 150g
    ('ZC', 'Eland fillets'),              -- -> Eland fillets 250g/500g
    ('ZC', 'Impala shanks'),              -- -> Impala shanks 300g
    ('ZC', 'Lamb shanks'),                -- -> Lamb shanks 300g
    ('ZC', 'BWB'),                        -- -> Blue Wildebeest fillets 250g/500g
    ('ZC', 'Game mince meat'),            -- -> Game mince 1kg
    ('ZC', 'Game wors'),                  -- -> Game wors 1kg
    ('ZC', 'Buffalo fillet'),             -- -> Buffalo fillets 250g
    ('ZC', 'Chicken fillet'),             -- -> Chicken fillets 1kg
    ('ZC', 'Chicken wings'),              -- -> Chicken wings 1kg
    ('ZC', 'Duck Breat'),                 -- -> Duck breast 200g
    ('ZC', 'Hake fillet'),                -- -> Hake 250g
    ('ZC', 'Hake'),                       -- -> Hake 250g
    ('ZC', 'Kingklip'),                   -- -> Kingklip 250g
    ('ZC', 'Lamb Chops'),                 -- -> Lamb chop 200g
    ('ZC', 'Lamb racks'),                 -- -> Lamb racks 200g
    ('ZC', 'Lamb liblets'),               -- -> Lamb riblets 1kg per pkt
    ('ZC', 'Ostrich'),                    -- -> Ostrich fillets 250g
    ('ZC', 'Ox tail'),                    -- -> Oxtail 1kg per pkt
    ('ZC', 'Pork bellly'),                -- -> Pork belly 200g
    ('ZC', 'Pork Chops'),                 -- -> Pork chops 250g
    ('ZC', 'Pork Fillet'),                -- -> Pork fillets 250g/500g
    ('ZC', 'Prawns'),                     -- -> Prawns 1kg
    ('ZC', 'Salmon'),                     -- -> Salmon fillet 250g
    ('ZC', 'Smoked Salmon'),              -- -> Smoked salmon 80g
    ('ZC', 'Sole fish'),                  -- -> Sole fish 250g
    ('ZC', 'Springbok Carpaccio'),        -- -> Carpaccio 80g
    ('ZC', 'Whole chicken')               -- -> Whole chicken 2kg
  );

-- =========================================================================
-- VERIFICATION — expect 60 deactivated, and the new sized items all active.
-- =========================================================================

select
  fi.location_id as lodge,
  case when fi.category in ('LAMB','PORK','BEEF','CHICKEN','FISH','GAME')
       then 'NEW sized items' else 'OLD items' end as generation,
  fi.active,
  count(*) as items
from food_items fi
join companies c on c.id = fi.company_id
where c.name = 'Crossing Lodges'
  and fi.location_id in ('EC','ZC')
group by 1,2,3
order by 1,2,3;

-- =========================================================================
-- STILL ACTIVE, AWAITING YOUR CALL — 19 items
--
-- Left alone on purpose. Either nothing in the new list replaces them, or
-- more than one thing might and guessing would silently move cost onto the
-- wrong item. Tell me which way each should go and I will extend this file.
-- =========================================================================
--   EC  Biltong              no sized equivalent in the new list
--   EC  Turkey               no sized equivalent
--   EC  Ham                  no sized equivalent (and the only old row with zero history)
--   EC  Beef short ribs      no sized equivalent (filed under Spices)
--   EC  Lamb roast           closest is "Leg of lamb 2kg" — not obviously the same cut
--   EC  Boere Wors           "Beef wors 1kg" or "Game wors 1kg"?
--   EC  Sausages             "Beef sausage 1kg" or "Pork sausage 1kg"?
--   EC  Mince meat           "Beef mince 1kg" or "Game mince 1kg"?
--   EC  Game                 too vague to map to one game cut
--   EC  Chicken breast       "Chicken fillets 1kg"? breast and fillet may differ for you
--   ZC  Biltong              no sized equivalent in the new list
--   ZC  Turkey               no sized equivalent
--   ZC  Fish fingers         no sized equivalent
--   ZC  Lamb roast           closest is "Leg of lamb 2kg" — not obviously the same cut
--   ZC  Boere Wors           "Beef wors 1kg" or "Game wors 1kg"?
--   ZC  Sausages             "Beef sausage 1kg" or "Pork sausage 1kg"?
--   ZC  Mince meat           "Beef mince 1kg" or "Game mince 1kg"?
--   ZC  Game                 too vague to map to one game cut
--   ZC  1/2 beef fillets     "Beef fillet 500g"? depends what half a fillet weighs for you
