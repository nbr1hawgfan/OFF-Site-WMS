-- =====================================================================
--  Customer Lite WMS  —  Migration 005: shipping support
--  * Pickup appointment time on shipments (feeds the future load calendar).
--  * Pallet tare weight in settings, used for BOL gross weight.
--  * v_shipment_detail: shipment lines with pallet / item / weight info,
--    used by the shipment screen and the BOL.
-- =====================================================================
begin;

alter table public.shipments add column appt_time time;
grant update (appt_time) on public.shipments to authenticated;

alter table public.settings
  add column pallet_tare_lbs numeric(8,2) not null default 0 check (pallet_tare_lbs >= 0);

create or replace view public.v_shipment_detail
with (security_invoker = true) as
select
  sl.id                                   as line_id,
  sl.shipment_id,
  sl.qty,
  sl.created_at,
  p.id                                    as pallet_id,
  p.lp_id,
  p.customer_pallet_id,
  p.ref1,
  p.ref2,
  p.lot_number,
  p.production_date,
  p.expiration_date,
  p.qty_on_hand,
  p.status                                as pallet_status,
  l.code                                  as location,
  i.id                                    as item_id,
  i.sku,
  i.description,
  i.uom,
  i.unit_weight_lbs,
  i.freight_class,
  i.nmfc,
  round(sl.qty * coalesce(i.unit_weight_lbs, 0), 2) as product_weight_lbs
from public.shipment_lines sl
join public.pallets p        on p.id = sl.pallet_id
join public.items i          on i.id = p.item_id
left join public.locations l on l.id = p.location_id;

grant select on public.v_shipment_detail to authenticated;
revoke all on public.v_shipment_detail from anon;

commit;
