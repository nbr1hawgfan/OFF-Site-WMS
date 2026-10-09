-- =====================================================================
--  Customer Lite WMS  —  Migration 014: 8 pallet identifiers + LWH transfer
--   Lines up with LWH's WMS so pallets can move between the two:
--     Customer Pallet ID = Comments (unique 1)
--     ref1..ref7         = Unique2..Unique8 (each named in Setup; hidden until named)
--     origin_ref         = ControlNumber from the system the pallet came from
-- =====================================================================
begin;

alter table public.pallets
  add column ref3 text, add column ref4 text, add column ref5 text, add column ref6 text, add column ref7 text,
  add column origin_ref text;
create index ix_pallets_ref3 on public.pallets (upper(ref3)) where ref3 is not null;
create index ix_pallets_ref4 on public.pallets (upper(ref4)) where ref4 is not null;
create index ix_pallets_ref5 on public.pallets (upper(ref5)) where ref5 is not null;
create index ix_pallets_ref6 on public.pallets (upper(ref6)) where ref6 is not null;
create index ix_pallets_ref7 on public.pallets (upper(ref7)) where ref7 is not null;
create index ix_pallets_origin on public.pallets (origin_ref) where origin_ref is not null;

alter table public.settings
  add column ref3_label text, add column ref3_required boolean not null default false, add column ref3_unique boolean not null default false, add column ref3_barcode boolean not null default false,
  add column ref4_label text, add column ref4_required boolean not null default false, add column ref4_unique boolean not null default false, add column ref4_barcode boolean not null default false,
  add column ref5_label text, add column ref5_required boolean not null default false, add column ref5_unique boolean not null default false, add column ref5_barcode boolean not null default false,
  add column ref6_label text, add column ref6_required boolean not null default false, add column ref6_unique boolean not null default false, add column ref6_barcode boolean not null default false,
  add column ref7_label text, add column ref7_required boolean not null default false, add column ref7_unique boolean not null default false, add column ref7_barcode boolean not null default false;

-- inventory view: append the new identifiers (lookup returns this shape)
create or replace view public.v_inventory
with (security_invoker = true) as
select
  p.id                                         as pallet_id,
  p.lp_id,
  p.customer_pallet_id,
  i.sku,
  i.description,
  i.uom,
  p.lot_number,
  p.production_date,
  p.expiration_date,
  p.qty_on_hand,
  coalesce(a.qty_allocated, 0)                 as qty_allocated,
  p.qty_on_hand - coalesce(a.qty_allocated, 0) as qty_available,
  l.code                                       as location,
  p.status,
  r.receipt_no,
  p.created_at                                 as received_at,   -- per pallet (opening inventory keeps its original date)
  p.item_id,
  p.location_id,
  p.receipt_id,
  p.ref1,
  p.ref2,
  l.warehouse_id,
  w.code                                       as warehouse_code,
  i.owner_id,
  o.code                                       as owner_code,
  o.name                                       as owner_name,
  p.ref3, p.ref4, p.ref5, p.ref6, p.ref7,
  p.origin_ref
from public.pallets p
join public.items i          on i.id = p.item_id
left join public.locations l on l.id = p.location_id
left join public.warehouses w on w.id = l.warehouse_id
left join public.owners o    on o.id = i.owner_id
left join public.receipts r  on r.id = p.receipt_id
left join public.v_pallet_allocated a on a.pallet_id = p.id
where p.status in ('on_hand','hold') and p.qty_on_hand > 0;



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
  round(sl.qty * coalesce(i.unit_weight_lbs, 0), 2) as product_weight_lbs,
  sl.order_line_id,
  p.ref3, p.ref4, p.ref5, p.ref6, p.ref7,
  p.origin_ref
from public.shipment_lines sl
join public.pallets p        on p.id = sl.pallet_id
join public.items i          on i.id = p.item_id
left join public.locations l on l.id = p.location_id;

drop function public.wms_find_pallet(text);
create function public.wms_find_pallet(p_code text)
returns setof public.v_inventory
language sql stable security invoker set search_path = public as $$
  select v.* from public.v_inventory v
  where upper(trim(p_code)) in (upper(v.lp_id), upper(v.customer_pallet_id), upper(v.ref1), upper(v.ref2), upper(v.ref3),
                                upper(v.ref4), upper(v.ref5), upper(v.ref6), upper(v.ref7), upper(v.origin_ref));
$$;

-- receive: identifiers 4-8 and the origin control number
drop function public.wms_receive_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, text);
create function public.wms_receive_pallet(
  p_receipt_id          uuid,
  p_item_id             uuid,
  p_qty                 numeric,
  p_lot_number          text    default null,
  p_location_id         uuid    default null,
  p_customer_pallet_id  text    default null,
  p_production_date     date    default null,
  p_expiration_date     date    default null,
  p_notes               text    default null,
  p_ref1                text    default null,
  p_ref2                text    default null,
  p_ref3 text default null, p_ref4 text default null, p_ref5 text default null, p_ref6 text default null, p_ref7 text default null,
  p_origin_ref          text    default null
) returns public.pallets
language plpgsql security definer set search_path = public as $$
declare
  v_set      public.settings;
  v_receipt  public.receipts;
  v_item     public.items;
  v_loc      uuid;
  v_lot      text;
  v_cust     text;
  v_ref1     text;
  v_ref2     text;
  v_pallet   public.pallets;
  v_extra    text[];
  v_lbl      text; v_req boolean; v_uni boolean; v_dup boolean;
begin
  perform public.wms_require(2);
  select * into v_set from public.settings where id = 1;

  select * into v_receipt from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'Receipt not found.'; end if;
  if v_receipt.status <> 'open' then
    raise exception 'Receipt % is %; it must be open to receive.', v_receipt.receipt_no, v_receipt.status;
  end if;

  select * into v_item from public.items where id = p_item_id;
  if not found or not v_item.active then raise exception 'Item not found or inactive.'; end if;
  if v_item.owner_id <> v_receipt.owner_id then
    raise exception 'Item % belongs to a different customer account than receipt %.', v_item.sku, v_receipt.receipt_no;
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero.'; end if;

  v_lot  := upper(nullif(trim(p_lot_number), ''));
  v_cust := upper(nullif(trim(p_customer_pallet_id), ''));
  v_ref1 := case when v_set.ref1_label is not null then upper(nullif(trim(p_ref1), '')) end;
  v_ref2 := case when v_set.ref2_label is not null then upper(nullif(trim(p_ref2), '')) end;

  if v_item.lot_required and v_lot is null then
    raise exception '% is required for %.', v_set.lot_label, v_item.sku;
  end if;
  if v_set.cust_pallet_required and v_cust is null then
    raise exception '% is required.', v_set.cust_pallet_label;
  end if;
  if v_set.ref1_label is not null and v_set.ref1_required and v_ref1 is null then
    raise exception '% is required.', v_set.ref1_label;
  end if;
  if v_set.ref2_label is not null and v_set.ref2_required and v_ref2 is null then
    raise exception '% is required.', v_set.ref2_label;
  end if;

  if v_cust is not null and exists (
       select 1 from public.pallets where upper(customer_pallet_id) = v_cust) then
    raise exception '% % is already in use.', v_set.cust_pallet_label, v_cust;
  end if;
  if v_cust is not null and exists (
       select 1 from public.pallets where upper(lp_id) = v_cust) then
    raise exception '% % matches one of our pallet IDs; use a different ID.', v_set.cust_pallet_label, v_cust;
  end if;
  if v_ref1 is not null and v_set.ref1_unique and exists (
       select 1 from public.pallets where upper(ref1) = v_ref1 and status <> 'void') then
    raise exception '% % is already in use.', v_set.ref1_label, v_ref1;
  end if;
  if v_ref2 is not null and v_set.ref2_unique and exists (
       select 1 from public.pallets where upper(ref2) = v_ref2 and status <> 'void') then
    raise exception '% % is already in use.', v_set.ref2_label, v_ref2;
  end if;

  -- identifiers 4-8 (ref3..ref7): same rules, named in Setup
  v_extra := array[p_ref3, p_ref4, p_ref5, p_ref6, p_ref7];
  for k in 1..5 loop
    v_lbl := case k when 1 then v_set.ref3_label when 2 then v_set.ref4_label when 3 then v_set.ref5_label when 4 then v_set.ref6_label else v_set.ref7_label end;
    v_req := case k when 1 then v_set.ref3_required when 2 then v_set.ref4_required when 3 then v_set.ref5_required when 4 then v_set.ref6_required else v_set.ref7_required end;
    v_uni := case k when 1 then v_set.ref3_unique when 2 then v_set.ref4_unique when 3 then v_set.ref5_unique when 4 then v_set.ref6_unique else v_set.ref7_unique end;
    if v_lbl is null then v_extra[k] := null; continue; end if;
    v_extra[k] := upper(nullif(trim(v_extra[k]), ''));
    if v_req and v_extra[k] is null then raise exception '% is required.', v_lbl; end if;
    if v_extra[k] is not null and v_uni then
      execute format('select exists (select 1 from public.pallets where upper(ref%s) = $1 and status <> ''void'')', k + 2) into v_dup using v_extra[k];
      if v_dup then raise exception '% % is already in use.', v_lbl, v_extra[k]; end if;
    end if;
  end loop;

  -- put-to location must be in this receipt's warehouse (default: its DOCK)
  if p_location_id is not null then
    if not exists (select 1 from public.locations where id = p_location_id and warehouse_id = v_receipt.warehouse_id) then
      raise exception 'That location is in a different warehouse than receipt %.', v_receipt.receipt_no;
    end if;
    v_loc := p_location_id;
  else
    select id into v_loc from public.locations
     where warehouse_id = v_receipt.warehouse_id and upper(code) = 'DOCK' limit 1;
  end if;

  if v_receipt.expected_at is not null
     and not exists (select 1 from public.pallets where receipt_id = p_receipt_id) then
    update public.receipts set received_at = now() where id = p_receipt_id;
  end if;

  insert into public.pallets (customer_pallet_id, item_id, lot_number, production_date,
                              expiration_date, qty_received, qty_on_hand, location_id,
                              receipt_id, notes, ref1, ref2, ref3, ref4, ref5, ref6, ref7, origin_ref)
  values (v_cust, p_item_id, v_lot, p_production_date, p_expiration_date, p_qty, 0,
          v_loc, p_receipt_id, p_notes, v_ref1, v_ref2, v_extra[1], v_extra[2], v_extra[3], v_extra[4], v_extra[5],
          nullif(trim(p_origin_ref), ''))
  returning * into v_pallet;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, to_location_id, receipt_id)
  values ('RECEIVE', v_pallet.id, p_item_id, v_pallet.lot_number, p_qty, v_loc, p_receipt_id);

  update public.receipts set unloaded_at = null, unloaded_by = null
   where id = p_receipt_id and unloaded_at is not null;

  select * into v_pallet from public.pallets where id = v_pallet.id;
  return v_pallet;
end $$;

drop function public.wms_import_opening_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, date);
create function public.wms_import_opening_pallet(
  p_receipt_id uuid, p_item_id uuid, p_qty numeric, p_lot_number text default null, p_location_id uuid default null,
  p_customer_pallet_id text default null, p_production_date date default null, p_expiration_date date default null,
  p_ref1 text default null, p_ref2 text default null, p_received_on date default null,
  p_ref3 text default null, p_ref4 text default null, p_ref5 text default null, p_ref6 text default null, p_ref7 text default null,
  p_origin_ref text default null, p_notes text default null)
returns public.pallets
language plpgsql security definer set search_path = public as $$
declare
  v public.pallets;
begin
  if public.wms_role_rank() < 3 or public.wms_is_lift() then
    raise exception 'Only managers can load opening inventory.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.receipts where id = p_receipt_id and is_opening) then
    raise exception 'That receipt is not an opening-inventory receipt.';
  end if;
  if p_received_on is not null and p_received_on > public.wms_local_today() then
    raise exception 'Received date % is in the future.', p_received_on;
  end if;
  v := public.wms_receive_pallet(p_receipt_id, p_item_id, p_qty, p_lot_number, p_location_id, p_customer_pallet_id,
                                 p_production_date, p_expiration_date, coalesce(p_notes, 'Opening inventory'), p_ref1, p_ref2,
                                 p_ref3, p_ref4, p_ref5, p_ref6, p_ref7, p_origin_ref);
  if p_received_on is not null then
    update public.pallets
       set created_at = (p_received_on::timestamp + interval '12 hours')
                        at time zone coalesce((select timezone from public.settings where id = 1), 'America/Chicago')
     where id = v.id
    returning * into v;
  end if;
  return v;
end $$;

revoke execute on function public.wms_find_pallet(text) from anon, public;
grant execute on function public.wms_find_pallet(text) to authenticated;
revoke execute on function public.wms_receive_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, text, text, text, text, text, text, text) from anon, public;
grant execute on function public.wms_receive_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, text, text, text, text, text, text, text) to authenticated;
revoke execute on function public.wms_import_opening_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, date, text, text, text, text, text, text, text) from anon, public;
grant execute on function public.wms_import_opening_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, date, text, text, text, text, text, text, text) to authenticated;

commit;
