-- =====================================================================
--  Customer Lite WMS  —  Migration 006: office vs. dock split
--
--  * New role 'lift' (forklift / dock). Can receive, load, move, look up.
--    Cannot create or edit receipt/shipment details, close receipts, or ship.
--  * Shipment order lines: the office says what goes on the load
--    (item, optional lot, pallets and/or qty). Once a load has order
--    lines, a pallet that doesn't match is refused at the trailer.
--  * Dock status: lift marks a load "loaded" / a receipt "unloaded";
--    the office reviews, then ships / closes.
--  * Scheduled receipts (expected_at) and dock doors, for load sheets
--    and the coming load calendar.
-- =====================================================================
begin;

-- ---------- roles ----------
alter table public.app_users drop constraint app_users_role_check;
alter table public.app_users add constraint app_users_role_check
  check (role in ('admin','manager','operator','lift','viewer'));

-- lift has operator rank for the dock functions; office-only actions check wms_is_office()
create or replace function public.wms_role_rank()
returns int language sql stable security definer set search_path = public as $$
  select coalesce((
    select case role when 'admin' then 4 when 'manager' then 3
                     when 'operator' then 2 when 'lift' then 2 when 'viewer' then 1 end
    from public.app_users
    where id = auth.uid() and active
  ), 0);
$$;

create or replace function public.wms_is_lift()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where id = auth.uid() and active and role = 'lift');
$$;

create or replace function public.wms_is_office()
returns boolean language sql stable security definer set search_path = public as $$
  select public.wms_role_rank() >= 2 and not public.wms_is_lift();
$$;

-- receipt / shipment details: office only
drop policy receipts_ins  on public.receipts;
drop policy receipts_upd  on public.receipts;
drop policy shipments_ins on public.shipments;
drop policy shipments_upd on public.shipments;
create policy receipts_ins on public.receipts for insert to authenticated
  with check (public.wms_is_office() and status = 'open');
create policy receipts_upd on public.receipts for update to authenticated
  using (public.wms_is_office() and status = 'open')
  with check (public.wms_is_office() and status = 'open');
create policy shipments_ins on public.shipments for insert to authenticated
  with check (public.wms_is_office() and status = 'open');
create policy shipments_upd on public.shipments for update to authenticated
  using (public.wms_is_office() and status = 'open')
  with check (public.wms_is_office() and status = 'open');

-- ---------- scheduling & dock status columns ----------
alter table public.receipts
  add column expected_at  timestamptz,
  add column dock_door    text,
  add column unloaded_at  timestamptz,
  add column unloaded_by  uuid references public.app_users(id);
grant update (expected_at, dock_door) on public.receipts to authenticated;
create index ix_receipts_expected_at on public.receipts (expected_at) where expected_at is not null;

alter table public.shipments
  add column dock_door  text,
  add column loaded_at  timestamptz,
  add column loaded_by  uuid references public.app_users(id);
grant update (dock_door) on public.shipments to authenticated;

-- ---------- order lines ----------
create table public.shipment_order_lines (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references public.shipments(id) on delete cascade,
  item_id          uuid not null references public.items(id),
  lot_number       text,                                -- null = any lot
  pallets_ordered  int           check (pallets_ordered > 0),
  qty_ordered      numeric(12,2) check (qty_ordered > 0),
  notes            text,
  created_by       uuid references public.app_users(id) default auth.uid(),
  created_at       timestamptz not null default now(),
  check (pallets_ordered is not null or qty_ordered is not null)
);
create index ix_sol_shipment on public.shipment_order_lines (shipment_id);

create or replace function public.trg_norm_order_line()
returns trigger language plpgsql set search_path = public as $$
begin
  new.lot_number := upper(nullif(trim(new.lot_number), ''));
  return new;
end $$;
create trigger trg_sol_norm before insert or update on public.shipment_order_lines
  for each row execute function public.trg_norm_order_line();

alter table public.shipment_lines
  add column order_line_id uuid references public.shipment_order_lines(id) on delete set null;

alter table public.shipment_order_lines enable row level security;
create policy sol_read on public.shipment_order_lines for select to authenticated
  using (public.wms_role_rank() >= 1);
create policy sol_write on public.shipment_order_lines for all to authenticated
  using (public.wms_is_office() and exists (select 1 from public.shipments s where s.id = shipment_id and s.status = 'open'))
  with check (public.wms_is_office() and exists (select 1 from public.shipments s where s.id = shipment_id and s.status = 'open'));
revoke all on public.shipment_order_lines from anon;
grant select, insert, update, delete on public.shipment_order_lines to authenticated;

-- progress per order line (what the dock screen shows)
create or replace view public.v_order_progress
with (security_invoker = true) as
select
  ol.id                                  as order_line_id,
  ol.shipment_id,
  ol.item_id,
  i.sku,
  i.description,
  i.uom,
  ol.lot_number,
  ol.pallets_ordered,
  ol.qty_ordered,
  ol.notes,
  ol.created_at,
  count(sl.id)::int                      as pallets_loaded,
  coalesce(sum(sl.qty), 0)               as qty_loaded
from public.shipment_order_lines ol
join public.items i on i.id = ol.item_id
left join public.shipment_lines sl on sl.order_line_id = ol.id
group by ol.id, i.id;
revoke all on public.v_order_progress from anon;
grant select on public.v_order_progress to authenticated;

-- shipment detail view: expose the order line link
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
  sl.order_line_id
from public.shipment_lines sl
join public.pallets p        on p.id = sl.pallet_id
join public.items i          on i.id = p.item_id
left join public.locations l on l.id = p.location_id;

-- ---------- add to shipment: order-line matching ----------
create or replace function public.wms_add_to_shipment(p_shipment_id uuid, p_pallet_id uuid, p_qty numeric default null)
returns public.shipment_lines
language plpgsql security definer set search_path = public as $$
declare
  v_set     public.settings;
  v_ship    public.shipments;
  v_pal     public.pallets;
  v_item    public.items;
  v_other   numeric;
  v_avail   numeric;
  v_qty     numeric;
  v_line    public.shipment_lines;
  v_has_ol  boolean;
  v_ol      record;
  v_pick    uuid;
  v_rem     numeric;
  v_matched boolean := false;
begin
  perform public.wms_require(2);
  select * into v_set from public.settings where id = 1;

  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment not found.'; end if;
  if v_ship.status <> 'open' then raise exception 'Shipment % is %.', v_ship.shipment_no, v_ship.status; end if;

  select * into v_pal from public.pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found.'; end if;
  if v_pal.status = 'hold' then raise exception 'Pallet % is on hold.', v_pal.lp_id; end if;
  if v_pal.status <> 'on_hand' or v_pal.qty_on_hand <= 0 then
    raise exception 'Pallet % is not in stock.', v_pal.lp_id;
  end if;
  select * into v_item from public.items where id = v_pal.item_id;

  -- allocated on OTHER open shipments
  select coalesce(sum(sl.qty), 0) into v_other
  from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id
  where sl.pallet_id = p_pallet_id and s.status = 'open' and s.id <> p_shipment_id;

  v_avail := v_pal.qty_on_hand - v_other;
  if v_avail <= 0 then
    raise exception 'Pallet % is fully allocated to another shipment.', v_pal.lp_id;
  end if;
  v_qty := coalesce(p_qty, v_avail);

  -- order lines: the pallet must match one that still needs product
  select exists (select 1 from public.shipment_order_lines where shipment_id = p_shipment_id) into v_has_ol;
  if v_has_ol then
    for v_ol in
      select ol.*,
             (select count(*) from public.shipment_lines x where x.order_line_id = ol.id and x.pallet_id <> p_pallet_id) as pl_loaded,
             (select coalesce(sum(x.qty), 0) from public.shipment_lines x where x.order_line_id = ol.id and x.pallet_id <> p_pallet_id) as q_loaded
      from public.shipment_order_lines ol
      where ol.shipment_id = p_shipment_id
        and ol.item_id = v_pal.item_id
        and (ol.lot_number is null or ol.lot_number = upper(coalesce(v_pal.lot_number, '')))
      order by (ol.lot_number is null), ol.created_at
    loop
      v_matched := true;
      if (v_ol.pallets_ordered is null or v_ol.pl_loaded < v_ol.pallets_ordered)
         and (v_ol.qty_ordered is null or v_ol.q_loaded < v_ol.qty_ordered) then
        v_pick := v_ol.id;
        if v_ol.qty_ordered is not null then
          v_rem := v_ol.qty_ordered - v_ol.q_loaded;
          if p_qty is null then
            v_qty := least(v_avail, v_rem);
          elsif p_qty > v_rem then
            raise exception 'Only % more % % needed on this load.', v_rem, v_item.uom, v_item.sku;
          end if;
        end if;
        exit;
      end if;
    end loop;

    if not v_matched then
      raise exception 'WRONG PALLET: % (% %) is not on this load.', v_pal.lp_id, v_item.sku,
        coalesce(v_set.lot_label || ' ' || v_pal.lot_number, 'no lot');
    end if;
    if v_pick is null then
      raise exception 'This load already has all the % (% %) it needs.', v_item.sku, v_set.lot_label,
        coalesce(v_pal.lot_number, '-');
    end if;
  end if;

  if v_qty <= 0 or v_qty > v_avail then
    raise exception 'Only % available on pallet %.', v_avail, v_pal.lp_id;
  end if;

  insert into public.shipment_lines (shipment_id, pallet_id, qty, order_line_id)
  values (p_shipment_id, p_pallet_id, v_qty, v_pick)
  on conflict (shipment_id, pallet_id) do update set qty = excluded.qty, order_line_id = excluded.order_line_id
  returning * into v_line;

  update public.shipments set loaded_at = null, loaded_by = null where id = p_shipment_id and loaded_at is not null;
  return v_line;
end $$;

create or replace function public.wms_remove_from_shipment(p_shipment_id uuid, p_pallet_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.wms_require(2);
  if not exists (select 1 from public.shipments where id = p_shipment_id and status = 'open') then
    raise exception 'Shipment not found or not open.';
  end if;
  delete from public.shipment_lines where shipment_id = p_shipment_id and pallet_id = p_pallet_id;
  update public.shipments set loaded_at = null, loaded_by = null where id = p_shipment_id and loaded_at is not null;
end $$;

-- ---------- dock: mark loaded / unloaded ----------
create or replace function public.wms_mark_loaded(p_shipment_id uuid)
returns public.shipments
language plpgsql security definer set search_path = public as $$
declare v public.shipments;
begin
  perform public.wms_require(2);
  select * into v from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment not found.'; end if;
  if v.status <> 'open' then raise exception 'Shipment % is %.', v.shipment_no, v.status; end if;
  if not exists (select 1 from public.shipment_lines where shipment_id = p_shipment_id) then
    raise exception 'Nothing is loaded on % yet.', v.shipment_no;
  end if;
  update public.shipments set loaded_at = now(), loaded_by = auth.uid()
   where id = p_shipment_id returning * into v;
  return v;
end $$;

create or replace function public.wms_mark_unloaded(p_receipt_id uuid)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare v public.receipts;
begin
  perform public.wms_require(2);
  select * into v from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'Receipt not found.'; end if;
  if v.status <> 'open' then raise exception 'Receipt % is %.', v.receipt_no, v.status; end if;
  if not exists (select 1 from public.pallets where receipt_id = p_receipt_id and status <> 'void') then
    raise exception 'Nothing has been received on % yet.', v.receipt_no;
  end if;
  update public.receipts set unloaded_at = now(), unloaded_by = auth.uid()
   where id = p_receipt_id returning * into v;
  return v;
end $$;

-- ---------- office-only: close receipt, ship ----------
create or replace function public.wms_close_receipt(p_receipt_id uuid)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare v public.receipts;
begin
  perform public.wms_require(2);
  if public.wms_is_lift() then
    raise exception 'The office closes receipts. Tap Done Unloading instead.' using errcode = '42501';
  end if;
  update public.receipts
     set status = 'closed', closed_at = now(), closed_by = auth.uid()
   where id = p_receipt_id and status = 'open'
  returning * into v;
  if not found then raise exception 'Receipt not found or not open.'; end if;
  return v;
end $$;

create or replace function public.wms_ship_shipment(p_shipment_id uuid)
returns public.shipments
language plpgsql security definer set search_path = public as $$
declare
  v_ship public.shipments;
  ln     record;
begin
  perform public.wms_require(2);
  if public.wms_is_lift() then
    raise exception 'The office ships loads. Tap Done Loading instead.' using errcode = '42501';
  end if;

  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment not found.'; end if;
  if v_ship.status <> 'open' then raise exception 'Shipment % is %.', v_ship.shipment_no, v_ship.status; end if;
  if not exists (select 1 from public.shipment_lines where shipment_id = p_shipment_id) then
    raise exception 'Shipment % has no pallets.', v_ship.shipment_no;
  end if;
  if nullif(trim(coalesce(v_ship.ship_to_name, '')), '') is null then
    raise exception 'Ship-to name is required before shipping.';
  end if;

  for ln in
    select sl.*, p.item_id, p.lot_number, p.location_id, p.qty_on_hand, p.status as pstatus, p.lp_id
    from public.shipment_lines sl
    join public.pallets p on p.id = sl.pallet_id
    where sl.shipment_id = p_shipment_id
    order by p.id
    for update of p
  loop
    if ln.pstatus <> 'on_hand' or ln.qty > ln.qty_on_hand then
      raise exception 'Pallet % no longer has % available.', ln.lp_id, ln.qty;
    end if;
    insert into public.inventory_transactions
      (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, shipment_id)
    values ('SHIP', ln.pallet_id, ln.item_id, ln.lot_number, -ln.qty, ln.location_id, p_shipment_id);
  end loop;

  update public.shipments
     set status = 'shipped', shipped_at = now(), shipped_by = auth.uid()
   where id = p_shipment_id
  returning * into v_ship;
  return v_ship;
end $$;

-- ---------- receive: stamp actual arrival on scheduled receipts ----------
create or replace function public.wms_receive_pallet(
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

  -- scheduled receipt: the first pallet marks when the truck actually arrived
  if v_receipt.expected_at is not null
     and not exists (select 1 from public.pallets where receipt_id = p_receipt_id) then
    update public.receipts set received_at = now() where id = p_receipt_id;
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

  update public.receipts set unloaded_at = null, unloaded_by = null
   where id = p_receipt_id and unloaded_at is not null;

  select * into v_pallet from public.pallets where id = v_pallet.id;
  return v_pallet;
end $$;

-- ---------- grants ----------
revoke execute on function public.wms_is_lift(), public.wms_is_office(), public.wms_mark_loaded(uuid),
  public.wms_mark_unloaded(uuid), public.trg_norm_order_line() from anon, public;
revoke execute on function public.trg_norm_order_line() from authenticated;
grant execute on function public.wms_is_lift(), public.wms_is_office(),
  public.wms_mark_loaded(uuid), public.wms_mark_unloaded(uuid) to authenticated;

commit;
