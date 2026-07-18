-- Crossing Lodges Food Stock App — schema
-- Run this in the Supabase SQL editor of the SAME project used by
-- crossing-lodges-ops and crossing-lodges-beverage
-- (https://arrendpmuwdhrfwvokhv.supabase.co), so all three apps share one
-- database and can be queried together from a future company dashboard.
--
-- Naming follows the same department-prefix convention as the other two
-- apps: this one uses "food_".
--
-- Unlike the beverage app (which grew this schema across several rounds),
-- this is written as one clean install that already includes suppliers,
-- write-off reasons, barcode linking, and recipe costing from day one.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- food_suppliers — one supplier list per lodge (fully separate, same
-- pattern as bev_suppliers). Created first since food_items references it.
-- ---------------------------------------------------------------------------
create table if not exists food_suppliers (
  id            uuid primary key default gen_random_uuid(),
  location_id   text not null check (location_id in ('ZC', 'EC', 'SC')),
  name          text not null,
  contact_name  text,
  phone         text,
  email         text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists idx_food_suppliers_location on food_suppliers(location_id);

-- ---------------------------------------------------------------------------
-- food_items — master kitchen stock list. Item lists are FULLY SEPARATE per
-- lodge, same as the beverage app.
--
-- Two units per item, not one: purchase_unit is what you buy/count/order
-- in (e.g. 'kg', a 5kg bag), recipe_unit is what recipes measure in (e.g.
-- 'g'). conversion_factor is how many recipe_units make up 1 purchase_unit
-- (e.g. 1 kg = 1000 g → conversion_factor = 1000). Defaults to the same
-- unit on both sides with a factor of 1 — set the real conversion the
-- first time you use an item in a recipe, no need to do it for every item
-- upfront.
-- ---------------------------------------------------------------------------
create table if not exists food_items (
  id                uuid primary key default gen_random_uuid(),
  location_id       text not null check (location_id in ('ZC', 'EC', 'SC')),
  name              text not null,
  category          text not null default 'Other',   -- Meats / Fish, Fresh and Veg,
                                                        -- Dry- and other stock, Spices, Other
  purchase_unit     text not null default 'ea',       -- what you buy/count/order in
  recipe_unit       text not null default 'ea',       -- what recipes measure in
  conversion_factor numeric not null default 1,       -- recipe_units per 1 purchase_unit
  barcode           text,                              -- UPC/EAN, linked via Count tab's Scan mode
  supplier_id       uuid references food_suppliers(id) on delete set null,
  min_units         numeric not null default 0,        -- reorder trigger point (purchase_unit)
  max_units         numeric not null default 0,        -- reorder target level (purchase_unit)
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

create index if not exists idx_food_items_location on food_items(location_id);
create index if not exists idx_food_items_barcode on food_items(location_id, barcode);
create index if not exists idx_food_items_supplier on food_items(supplier_id);

-- ---------------------------------------------------------------------------
-- food_stock_periods — one row per item per location per period (e.g.
-- '2026-07'). Holds opening stock (carried forward from the prior period's
-- closing count) and the physical closing count once a stock take is done.
-- Units are in the item's purchase_unit.
-- ---------------------------------------------------------------------------
create table if not exists food_stock_periods (
  id                    uuid primary key default gen_random_uuid(),
  item_id               uuid not null references food_items(id) on delete cascade,
  location_id           text not null check (location_id in ('ZC', 'EC', 'SC')),
  period                text not null,                 -- 'YYYY-MM'
  opening_units         numeric not null default 0,
  opening_cost_per_unit numeric not null default 0,
  closing_count_units   numeric,                        -- null until the physical count is entered
  counted_by            text,
  count_date            date,
  closed                boolean not null default false, -- locks the period once counted & reviewed
  created_at            timestamptz not null default now(),
  unique (item_id, period)
);

create index if not exists idx_food_stock_periods_lookup on food_stock_periods(location_id, period);

-- ---------------------------------------------------------------------------
-- food_purchases — one row per purchase. Units are in the item's
-- purchase_unit.
-- ---------------------------------------------------------------------------
create table if not exists food_purchases (
  id                    uuid primary key default gen_random_uuid(),
  item_id               uuid not null references food_items(id) on delete cascade,
  location_id           text not null check (location_id in ('ZC', 'EC', 'SC')),
  period                text not null,                 -- 'YYYY-MM', derived from date at entry time
  date                  date not null,
  units                 numeric not null default 0,
  total_cost_excl_vat   numeric not null default 0,
  supplier              text,
  created_at            timestamptz not null default now()
);

create index if not exists idx_food_purchases_lookup on food_purchases(location_id, period, item_id);

-- ---------------------------------------------------------------------------
-- food_issues — simple daily total per item, in purchase_unit. "Service" is
-- normal kitchen consumption; anything else is a write-off (breakage,
-- expired, staff usage, other).
-- ---------------------------------------------------------------------------
create table if not exists food_issues (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references food_items(id) on delete cascade,
  location_id   text not null check (location_id in ('ZC', 'EC', 'SC')),
  period        text not null,                 -- 'YYYY-MM', derived from date at entry time
  date          date not null,
  qty           numeric not null default 0,
  reason        text not null default 'Service', -- 'Service', 'Breakage', 'Expired', 'Staff', 'Other'
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_food_issues_lookup on food_issues(location_id, period, item_id);

-- ---------------------------------------------------------------------------
-- food_access — Admin/Staff login, own table (not shared with the ops or
-- beverage apps' access tables — separate passwords per app).
-- ---------------------------------------------------------------------------
create table if not exists food_access (
  id          uuid primary key default gen_random_uuid(),
  role        text not null unique check (role in ('admin', 'staff')),
  password    text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- food_recipes / food_recipe_ingredients — the Menu tab's recipe costing.
-- A recipe is a list of ingredient items + quantities (in each item's
-- recipe_unit); cost is computed live in the app from current ingredient
-- costs, nothing is stored redundantly here.
-- ---------------------------------------------------------------------------
create table if not exists food_recipes (
  id            uuid primary key default gen_random_uuid(),
  location_id   text not null check (location_id in ('ZC', 'EC', 'SC')),
  name          text not null,
  category      text,               -- e.g. Starters, Mains, Desserts — free text
  portions      numeric not null default 1,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists idx_food_recipes_location on food_recipes(location_id);

create table if not exists food_recipe_ingredients (
  id              uuid primary key default gen_random_uuid(),
  recipe_id       uuid not null references food_recipes(id) on delete cascade,
  item_id         uuid not null references food_items(id) on delete cascade,
  qty_recipe_unit numeric not null default 0,   -- in the item's recipe_unit (e.g. grams)
  created_at      timestamptz not null default now()
);

create index if not exists idx_food_recipe_ingredients_recipe on food_recipe_ingredients(recipe_id);
create index if not exists idx_food_recipe_ingredients_item on food_recipe_ingredients(item_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — open allow_all policies via the anon key, same
-- approach as the ops and beverage apps. Same caveat: no per-user audit
-- trail, and Admin/Staff is a client-side gate, not database-enforced.
-- ---------------------------------------------------------------------------
alter table food_items                enable row level security;
alter table food_stock_periods        enable row level security;
alter table food_purchases            enable row level security;
alter table food_issues               enable row level security;
alter table food_suppliers            enable row level security;
alter table food_access               enable row level security;
alter table food_recipes              enable row level security;
alter table food_recipe_ingredients   enable row level security;

create policy allow_all_food_items on food_items
  for all using (true) with check (true);
create policy allow_all_food_stock_periods on food_stock_periods
  for all using (true) with check (true);
create policy allow_all_food_purchases on food_purchases
  for all using (true) with check (true);
create policy allow_all_food_issues on food_issues
  for all using (true) with check (true);
create policy allow_all_food_suppliers on food_suppliers
  for all using (true) with check (true);
create policy allow_all_food_recipes on food_recipes
  for all using (true) with check (true);
create policy allow_all_food_recipe_ingredients on food_recipe_ingredients
  for all using (true) with check (true);
-- food_access only ever needs to be READ by the app (to check a password);
-- it's never written to from the client. Change passwords via the Table
-- Editor, not through the app.
create policy allow_read_food_access on food_access
  for select using (true);

-- ---------------------------------------------------------------------------
-- Baseline table grants. RLS policies above control row-level access, but
-- Postgres separately requires grants for the anon/authenticated roles to
-- touch these tables at all.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.food_items                to anon, authenticated;
grant select, insert, update, delete on public.food_stock_periods        to anon, authenticated;
grant select, insert, update, delete on public.food_purchases            to anon, authenticated;
grant select, insert, update, delete on public.food_issues               to anon, authenticated;
grant select, insert, update, delete on public.food_suppliers            to anon, authenticated;
grant select, insert, update, delete on public.food_recipes              to anon, authenticated;
grant select, insert, update, delete on public.food_recipe_ingredients   to anon, authenticated;
grant select on public.food_access to anon, authenticated;

-- Default Admin/Staff passwords — CHANGE THESE immediately via the Table
-- Editor (food_access table) after setup.
insert into food_access (role, password) values
  ('admin', 'ChangeMe-Admin1'),
  ('staff', 'ChangeMe-Staff1')
on conflict (role) do nothing;
