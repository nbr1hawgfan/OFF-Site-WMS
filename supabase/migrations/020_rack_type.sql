-- =====================================================================
--  Customer Lite WMS  —  Migration 020: "rack" location type
--   Racking is now a location type of its own, so any bay name works
--   (customers name racks their own way). A rack location carries its
--   tiers (counting the floor) and pallets per tier.
-- =====================================================================
begin;

alter table public.locations drop constraint if exists locations_loc_type_check;
alter table public.locations add constraint locations_loc_type_check
  check (loc_type in ('storage', 'rack', 'dock', 'staging', 'floor', 'hold'));

-- bays already given tiers become rack locations
update public.locations set loc_type = 'rack'
 where rack_tiers is not null and rack_per_tier is not null and loc_type not in ('dock', 'hold');
update public.locations set rack_tiers = null, rack_per_tier = null
 where loc_type <> 'rack' and (rack_tiers is not null or rack_per_tier is not null);

-- a rack needs its size; other types drop it
alter table public.locations add constraint locations_rack_size
  check ((loc_type = 'rack') = (rack_tiers is not null and rack_per_tier is not null));

commit;
