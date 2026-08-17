-- Food app: order/delivery pack size on food_items (2026-08-17)
--
-- Purchases entry usually needs to be logged in "how many packs the slip
-- says" (e.g. Bidfood shows qty 2 meaning 2 six-packs of tinned beans, i.e.
-- 12 cans total) rather than "how many purchase_units arrived". This adds a
-- pack size per item so the Purchases tab can offer a Packs field that
-- auto-computes into the real Units field — Units (in purchase_unit) stays
-- the one number every downstream usage/variance calculation already
-- depends on, so nothing else in the app needs to change.

alter table food_items add column if not exists order_pack_size numeric not null default 1;
alter table food_items add column if not exists order_pack_label text;
