-- ==========================================================================
-- STEP 1 of 2 — RUN THIS FIRST. Read-only, changes nothing.
--
-- Before adding the 45 sized meat/fish items, this shows what is already
-- there in EC and ZC, and — crucially — whether each existing item has any
-- history behind it.
--
-- Why it matters: an item with purchases or issues against it is load-bearing.
-- Deactivating one hides it from the pickers but its history still underpins
-- past COGS and cost-per-guest figures, so it must be deactivated, never
-- deleted. An item with no history at all is safe to delete outright.
--
-- The last column tells you which is which.
-- ==========================================================================

select
  fi.location_id                                as lodge,
  fi.category,
  fi.name,
  fi.purchase_unit,
  fi.recipe_unit,
  fi.conversion_factor,
  fi.active,
  coalesce(p.purchases, 0)                      as purchase_lines,
  coalesce(i.issues, 0)                         as issue_lines,
  coalesce(s.stock_periods, 0)                  as stock_periods,
  coalesce(r.recipe_uses, 0)                    as used_in_recipes,
  case
    when coalesce(r.recipe_uses,0) > 0
      then 'IN A RECIPE — deactivating breaks that recipe''s costing'
    when coalesce(p.purchases,0) + coalesce(i.issues,0) + coalesce(s.stock_periods,0) = 0
      then 'no history — safe to DELETE'
    else 'has history — DEACTIVATE only, never delete'
  end                                           as verdict
from food_items fi
join companies c on c.id = fi.company_id
left join (
  select item_id, count(*) as purchases from food_purchases group by item_id
) p on p.item_id = fi.id
left join (
  select item_id, count(*) as issues from food_issues group by item_id
) i on i.item_id = fi.id
left join (
  select item_id, count(*) as stock_periods from food_stock_periods group by item_id
) s on s.item_id = fi.id
left join (
  select item_id, count(*) as recipe_uses from food_recipe_ingredients group by item_id
) r on r.item_id = fi.id
where c.name = 'Crossing Lodges'
  and fi.location_id in ('EC', 'ZC')
  -- Cast the net wider than just the 'Meats / Fish' category, in case some
  -- were filed elsewhere when they were first uploaded.
  and (
    fi.category ilike '%meat%' or fi.category ilike '%fish%'
    or fi.name ~* '(lamb|pork|beef|chicken|fish|game|bacon|sirloin|rump|oxtail|wors|mince|sausage|fillet|salmon|kingklip|sole|hake|prawn|buffalo|impala|kudu|nyala|ostrich|duck|eland|elland|bwb|carpaccio|marrow|shank|riblet|brisket|steak)'
  )
order by fi.location_id, fi.category, fi.name;
