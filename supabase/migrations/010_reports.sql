-- =====================================================================
--  Customer Lite WMS  —  Migration 010: reports
--   * wms_inventory_as_of(date): what was on hand at the end of a day
--     (rebuilt from the ledger, Central time by default)
--   * wms_lot_trace(lot, sku): where every pallet of a lot came from and went
--  Read-only. Anyone signed in except lift drivers can run them.
-- =====================================================================
begin;

create or replace function public.wms_inventory_as_of(p_date date, p_warehouse_id uuid default null)
returns table (lp_id text, customer_pallet_id text, ref1 text, ref2 text, sku text, description text,
               lot_number text, qty numeric, uom text, owner_code text, warehouse_code text, location text,
               received_at timestamptz, receipt_no text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_cut timestamptz;
begin
  if public.wms_role_rank() < 1 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  -- end of the day = midnight starting the next day, local time
  v_cut := ((p_date + 1)::timestamp) at time zone coalesce((select timezone from public.settings where id = 1), 'America/Chicago');
  return query
  with bal as (
    select t.pallet_id, sum(t.qty_change) as qty
    from public.inventory_transactions t
    where t.created_at < v_cut
    group by t.pallet_id
    having sum(t.qty_change) > 0
  ),
  loc as (
    select distinct on (t.pallet_id) t.pallet_id, coalesce(t.to_location_id, t.from_location_id) as location_id
    from public.inventory_transactions t
    join bal b on b.pallet_id = t.pallet_id
    where t.created_at < v_cut and coalesce(t.to_location_id, t.from_location_id) is not null
    order by t.pallet_id, t.id desc
  )
  select p.lp_id, p.customer_pallet_id, p.ref1, p.ref2, i.sku, i.description, p.lot_number, b.qty, i.uom,
         o.code, w.code, l.code, p.created_at, r.receipt_no
  from bal b
  join public.pallets p   on p.id = b.pallet_id and p.status <> 'void'
  join public.items i     on i.id = p.item_id
  left join public.owners o     on o.id = i.owner_id
  left join loc lc              on lc.pallet_id = b.pallet_id
  left join public.locations l  on l.id = lc.location_id
  left join public.warehouses w on w.id = l.warehouse_id
  left join public.receipts r   on r.id = p.receipt_id
  where p_warehouse_id is null or l.warehouse_id = p_warehouse_id
  order by w.code, o.code, i.sku, p.lot_number, p.lp_id;
end $$;

create or replace function public.wms_lot_trace(p_lot text, p_sku text default null)
returns table (event text, event_at timestamptz, lp_id text, customer_pallet_id text, sku text, description text,
               lot_number text, qty numeric, uom text, owner_code text, warehouse_code text,
               doc_no text, party text, party_city text, location_now text, status_now text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_lot text := upper(nullif(trim(p_lot), ''));
  v_sku text := upper(nullif(trim(p_sku), ''));
begin
  if public.wms_role_rank() < 1 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  if v_lot is null then raise exception 'Enter a lot to trace.'; end if;
  return query
  with pals as (
    select p.*, i.sku as i_sku, i.description as i_desc, i.uom as i_uom, o.code as o_code
    from public.pallets p
    join public.items i on i.id = p.item_id
    left join public.owners o on o.id = i.owner_id
    where upper(p.lot_number) = v_lot and p.status <> 'void'
      and (v_sku is null or upper(i.sku) = v_sku)
  )
  select 'RECEIVED'::text, x.created_at, x.lp_id, x.customer_pallet_id, x.i_sku, x.i_desc, x.lot_number, x.qty_received, x.i_uom,
         x.o_code, w.code, r.receipt_no, r.vendor_name, null::text, l.code, x.status
  from pals x
  left join public.receipts r on r.id = x.receipt_id
  left join public.warehouses w on w.id = r.warehouse_id
  left join public.locations l on l.id = x.location_id
  union all
  select 'SHIPPED', s.shipped_at, x.lp_id, x.customer_pallet_id, x.i_sku, x.i_desc, x.lot_number, sl.qty, x.i_uom,
         x.o_code, w.code, s.shipment_no, s.ship_to_name,
         nullif(concat_ws(', ', s.ship_to_city, s.ship_to_state), ''), l.code, x.status
  from pals x
  join public.shipment_lines sl on sl.pallet_id = x.id
  join public.shipments s on s.id = sl.shipment_id and s.status = 'shipped'
  left join public.warehouses w on w.id = s.warehouse_id
  left join public.locations l on l.id = x.location_id
  union all
  select 'ON HAND', now(), x.lp_id, x.customer_pallet_id, x.i_sku, x.i_desc, x.lot_number, x.qty_on_hand, x.i_uom,
         x.o_code, w.code, null, null, null, l.code, x.status
  from pals x
  left join public.locations l on l.id = x.location_id
  left join public.warehouses w on w.id = l.warehouse_id
  where x.status in ('on_hand', 'hold') and x.qty_on_hand > 0
  order by 2, 3;
end $$;

revoke execute on function public.wms_inventory_as_of(date, uuid), public.wms_lot_trace(text, text) from anon, public;
grant execute on function public.wms_inventory_as_of(date, uuid), public.wms_lot_trace(text, text) to authenticated;

commit;
