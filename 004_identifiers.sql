-- =====================================================================
--  Customer Lite WMS  —  Migration 004: configurable pallet identifiers
--
--  * Lot and customer pallet ID keep their columns but get customer-facing
--    labels (e.g. Lot -> "BIN Class").
--  * Two optional extra identifiers per pallet (ref1, ref2), e.g. "PGID".
--    A field is shown only when its label is set; each can be required
--    and/or unique (unique = no two active pallets share the value).
--  * All identifiers are stored trimmed + uppercase and are searchable.
-- =====================================================================
begin;

-- ---------- settings: labels & rules ----------
alter table public.settings
  add column lot_label             text    not null default 'Lot / Production #',
  add column cust_pallet_label     text    not null default 'Customer Pallet ID',
  add column cust_pallet_required  boolean not null default false,
  add column ref1_label            text,
  add column ref1_required         boolean not null default false,
  add column ref1_unique           boolean not null default false,
  add column ref2_label            text,
  add column ref2_required         boolean not null default false,
  add column ref2_unique           boolean not null default false;

-- ---------- pallets: extra identifiers ----------
alter table public.pallets
  add column ref1 text,
  add column ref2 text;
create index ix_pallets_ref1 on public.pallets (upper(ref1)) where ref1 is not null;
create index ix_pallets_ref2 on public.pallets (upper(ref2)) where ref2 is not null;

-- ---------- views: append ref columns (appending keeps dependents valid) ----------
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
  r.received_at,
  p.item_id,
  p.location_id,
  p.receipt_id,
  p.ref1,
  p.ref2
from public.pallets p
join public.items i          on i.id = p.item_id
left join public.locations l on l.id = p.location_id
left join public.receipts r  on r.id = p.receipt_id
left join public.v_pallet_allocated a on a.pallet_id = p.id
where p.status in ('on_hand','hold') and p.qty_on_hand > 0;

-- ---------- scanner lookup: also match ref1 / ref2 ----------
drop function public.wms_find_pallet(text);
create function public.wms_find_pallet(p_code text)
returns setof public.v_inventory
language sql stable security invoker set search_path = public as $$
  select v.* from public.v_inventory v
  where upper(v.lp_id)              = upper(trim(p_code))
     or upper(v.customer_pallet_id) = upper(trim(p_code))
     or upper(v.ref1)               = upper(trim(p_code))
     or upper(v.ref2)               = upper(trim(p_code));
$$;

-- ---------- receive: new signature with p_ref1 / p_ref2 ----------
drop function public.wms_receive_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text);

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
  p_ref2                text    default null
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
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero.'; end if;

  v_lot  := upper(nullif(trim(p_lot_number), ''));
  v_cust := upper(nullif(trim(p_customer_pallet_id), ''));
  v_ref1 := case when v_set.ref1_label is not null then upper(nullif(trim(p_ref1), '')) end;
  v_ref2 := case when v_set.ref2_label is not null then upper(nullif(trim(p_ref2), '')) end;

  -- required fields
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

  -- uniqueness (customer pallet ID is always unique; refs when configured)
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

  v_loc := coalesce(p_location_id, (select id from public.locations where code = 'DOCK'));

  insert into public.pallets (customer_pallet_id, item_id, lot_number, production_date,
                              expiration_date, qty_received, qty_on_hand, location_id,
                              receipt_id, notes, ref1, ref2)
  values (v_cust, p_item_id, v_lot, p_production_date, p_expiration_date, p_qty, 0,
          v_loc, p_receipt_id, p_notes, v_ref1, v_ref2)
  returning * into v_pallet;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, to_location_id, receipt_id)
  values ('RECEIVE', v_pallet.id, p_item_id, v_pallet.lot_number, p_qty, v_loc, p_receipt_id);

  select * into v_pallet from public.pallets where id = v_pallet.id;
  return v_pallet;
end $$;

revoke execute on function public.wms_find_pallet(text) from anon, public;
revoke execute on function public.wms_receive_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, text) from anon, public;
grant  execute on function public.wms_find_pallet(text) to authenticated;
grant  execute on function public.wms_receive_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, text) to authenticated;

commit;
