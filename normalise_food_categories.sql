-- ==========================================================================
-- Tidy up food_items.category spellings — Crossing Lodges, all lodges.
-- 2026-08-31.
--
-- The review turned up SIX spellings of one category: 'Meats / Fish',
-- 'Meats / fish', 'Meat / fish', 'Meat/Fish', 'Meat-Fish' and plain 'Meat' —
-- plus 'Fresh and Veg' alongside 'Fruits/Veg'. category is free text with no
-- constraint, so every typo became a new group in the pickers and reports.
--
-- WHY THIS IS NOT JUST A LIST OF FIND-AND-REPLACES
-- I cannot query your database from here, so a hand-written list would only
-- fix the spellings that happened to appear in the meat/fish review — and
-- would silently miss the same drift in categories I never saw. So step 1
-- below is generic: it finds ANY set of categories that differ only by case,
-- spacing or punctuation and collapses them onto whichever spelling is most
-- used. That fixes drift I have no way of knowing about.
--
-- Step 2 then handles the two merges that need actual judgement, because the
-- words themselves differ rather than just the punctuation.
--
-- Safe to re-run — it converges, and a second run changes nothing.
-- Nothing is deleted; only the category label on existing rows changes.
-- Inactive items are included on purpose so old reports group tidily too.
-- ==========================================================================


-- -------------------------------------------------------------------------
-- STEP 1 — collapse spellings that differ only by case/spacing/punctuation.
--
-- The key strips everything but letters and digits, so 'Meats / Fish' and
-- 'Meats / fish' share the key 'meatsfish' and get unified. The winner is
-- the spelling used on the most items, with alphabetical order as a
-- deterministic tie-break so re-running can never flip-flop between two
-- equally-common spellings.
-- -------------------------------------------------------------------------

with scoped as (
  select fi.id, fi.category
  from food_items fi
  join companies c on c.id = fi.company_id
  where c.name = 'Crossing Lodges'
    and fi.category is not null
),
keyed as (
  select id, category,
         regexp_replace(lower(trim(category)), '[^a-z0-9]', '', 'g') as k
  from scoped
),
ranked as (
  select k, category, count(*) as n,
         row_number() over (partition by k order by count(*) desc, category asc) as rn
  from keyed
  group by k, category
),
winner as (
  select k, category as canonical from ranked where rn = 1
)
update food_items fi
set category = w.canonical
from keyed kd
join winner w on w.k = kd.k
where fi.id = kd.id
  and fi.category is distinct from w.canonical;


-- -------------------------------------------------------------------------
-- STEP 2 — the merges that need judgement, not just normalisation.
--
--   'Meat', 'Meat / fish', 'Meat-Fish', 'Meat/Fish'  ->  'Meats / Fish'
--       Different words, so step 1 leaves them apart. 'Meats / Fish' is the
--       canonical name in the schema and by far the most used.
--
--   'Fruits/Veg'  ->  'Fresh and Veg'
--       Same thing under two names. 'Fresh and Veg' is the schema's name.
--
-- Matching is done on the stripped key rather than the literal string, so a
-- variant like 'meat / FISH' is caught without needing to be listed.
-- -------------------------------------------------------------------------

update food_items fi
set category = 'Meats / Fish'
from companies c
where c.id = fi.company_id
  and c.name = 'Crossing Lodges'
  and regexp_replace(lower(trim(fi.category)), '[^a-z0-9]', '', 'g')
        in ('meat', 'meatfish', 'meatsfish')
  and fi.category <> 'Meats / Fish';

update food_items fi
set category = 'Fresh and Veg'
from companies c
where c.id = fi.company_id
  and c.name = 'Crossing Lodges'
  and regexp_replace(lower(trim(fi.category)), '[^a-z0-9]', '', 'g')
        in ('fruitsveg', 'fruitveg', 'freshandveg', 'freshveg')
  and fi.category <> 'Fresh and Veg';


-- =========================================================================
-- VERIFICATION — every distinct category left standing, with counts.
--
-- What you should see: one row per real category, no near-duplicates. The
-- six new meat categories (LAMB, PORK, BEEF, CHICKEN, FISH, GAME) are
-- untouched and should show their full counts.
--
-- If two rows still look like the same thing under different words — the
-- key column will differ, which is why step 1 could not merge them — send
-- this output back and I will add them to step 2.
-- =========================================================================

select
  fi.category,
  regexp_replace(lower(trim(fi.category)), '[^a-z0-9]', '', 'g') as normalised_key,
  count(*)                                    as items,
  count(*) filter (where fi.active)           as active_items,
  string_agg(distinct fi.location_id, ', ' order by fi.location_id) as lodges
from food_items fi
join companies c on c.id = fi.company_id
where c.name = 'Crossing Lodges'
group by 1, 2
order by 1;
