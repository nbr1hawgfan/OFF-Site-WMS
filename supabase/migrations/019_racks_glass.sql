-- =====================================================================
--  Customer Lite WMS  —  Migration 019: rack bays + glass buttons
--   * A bay can be marked as racking: how many tiers (counting the floor
--     position) and how many pallets fit side by side on each tier.
--     Its capacity is tiers x pallets per tier; the Bay Map draws it as a
--     little rack elevation.
--   * settings.button_style: 'flat' (default) or 'glass'.
-- =====================================================================
begin;

alter table public.locations
  add column if not exists rack_tiers    int check (rack_tiers is null or rack_tiers between 1 and 12),
  add column if not exists rack_per_tier int check (rack_per_tier is null or rack_per_tier between 1 and 8);

alter table public.settings
  add column if not exists button_style text not null default 'flat' check (button_style in ('flat', 'glass'));

commit;
