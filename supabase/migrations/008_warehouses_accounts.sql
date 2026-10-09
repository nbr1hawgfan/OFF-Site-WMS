-- =====================================================================
--  Customer Lite WMS  —  Migration 008: warehouses + customer accounts
--
--  * warehouses: WHSE1, WHSE2, ... Locations belong to a warehouse
--    (codes are unique per warehouse; every warehouse gets DOCK/FLOOR/HOLD).
--    Receipts and shipments belong to a warehouse. Moving a pallet to a
--    location in another warehouse is a transfer (logged as MOVE).
--  * owners ("customer accounts"): whose product it is / who gets billed.
--    Items belong to one account; receipts and shipments are for one account.
--    SKUs are unique per account.
--  * Defaults keep older app versions working during the switchover.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- warehouses
-- ---------------------------------------------------------------------
create table public.warehouses (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  name           text not null,
  address_line1  text,
  address_line2  text,
  city           text,
  state          text,
  zip            text,
  phone          text,
  active         boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index ux_warehouses_code on public.warehouses (upper(code));
create trigger trg_warehouses_updated before update on public.warehouses
  for each row execute function public.set_updated_at();

insert into public.warehouses (code, name, address_line1, address_line2, city, state, zip, phone, sort_order)
select 'WHSE1', 'Main Warehouse', address_line1, address_line2, city, state, zip, phone, 1
from public.settings where id = 1;

-- every new warehouse gets the three built-in locations
create or replace function public.trg_warehouse_seed_locations()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.locations (code, zone, loc_type, sort_order, warehouse_id) values
    ('DOCK', 'DOCK', 'dock', 0, new.id), ('FLOOR', 'FLOOR', 'floor', 1, new.id), ('HOLD', 'HOLD', 'hold', 2, new.id);
  return new;
end $$;
-- (trigger is created after locations gets its warehouse column)

alter table public.app_users add column home_warehouse_id uuid references public.warehouses(id);

create or replace function public.wms_default_warehouse()
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select u.home_warehouse_id from public.app_users u
       join public.warehouses w on w.id = u.home_warehouse_id and w.active
      where u.id = auth.uid()),
    (select id from public.warehouses where active order by sort_order, code limit 1));
$$;

-- ---------------------------------------------------------------------
-- locations belong to a warehouse
-- ---------------------------------------------------------------------
alter table public.locations add column warehouse_id uuid references public.warehouses(id);
update public.locations set warehouse_id = (select id from public.warehouses where code = 'WHSE1');
alter table public.locations alter column warehouse_id set not null;
alter table public.locations alter column warehouse_id set default public.wms_default_warehouse();
alter table public.locations drop constraint locations_code_key;
create unique index ux_locations_wh_code on public.locations (warehouse_id, upper(code));

create trigger trg_warehouses_seed after insert on public.warehouses
  for each row execute function public.trg_warehouse_seed_locations();

-- ---------------------------------------------------------------------
-- customer accounts (owners)
-- ---------------------------------------------------------------------
create table public.owners (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  name           text not null,
  contact_name   text,
  email          text,
  phone          text,
  billing_address text,
  active         boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index ux_owners_code on public.owners (upper(code));
create trigger trg_owners_updated before update on public.owners
  for each row execute function public.set_updated_at();

insert into public.owners (code, name) values ('MAIN', 'Main Account');

create or replace function public.wms_default_owner()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.owners where active order by created_at, code limit 1;
$$;

-- items belong to an account; SKU unique per account
alter table public.items add column owner_id uuid references public.owners(id);
update public.items set owner_id = (select id from public.owners where code = 'MAIN');
alter table public.items alter column owner_id set not null;
alter table public.items alter column owner_id set default public.wms_default_owner();
alter table public.items drop constraint items_sku_key;
create unique index ux_items_owner_sku on public.items (owner_id, upper(sku));

-- receipts / shipments: warehouse + account
alter table public.receipts
  add column warehouse_id uuid references public.warehouses(id),
  add column owner_id     uuid references public.owners(id);
alter table public.shipments
  add column warehouse_id uuid references public.warehouses(id),
  add column owner_id     uuid references public.owners(id);
update public.receipts  set warehouse_id = (select id from public.warehouses where code = 'WHSE1'),
                            owner_id     = (select id from public.owners where code = 'MAIN');
update public.shipments set warehouse_id = (select id from public.warehouses where code = 'WHSE1'),
                            owner_id     = (select id from public.owners where code = 'MAIN');
alter table public.receipts  alter column warehouse_id set not null, alter column owner_id set not null,
  alter column warehouse_id set default public.wms_default_warehouse(),
  alter column owner_id     set default public.wms_default_owner();
alter table public.shipments alter column warehouse_id set not null, alter column owner_id set not null,
  alter column warehouse_id set default public.wms_default_warehouse(),
  alter column owner_id     set default public.wms_default_owner();
create index ix_receipts_wh  on public.receipts (warehouse_id, status);
create index ix_shipments_wh on public.shipments (warehouse_id, status);
create index ix_items_owner  on public.items (owner_id);

grant update (warehouse_id, owner_id) on public.receipts  to authenticated;
grant update (warehouse_id, owner_id) on public.shipments to authenticated;

-- warehouse/account can only change before anything is received / loaded
create or replace function public.trg_lock_header_scope()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.warehouse_id is distinct from old.warehouse_id or new.owner_id is distinct from old.owner_id then
    if tg_table_name = 'receipts' and exists (select 1 from public.pallets where receipt_id = new.id and status <> 'void') then
      raise exception 'Warehouse and account cannot change after pallets are received.';
    end if;
    if tg_table_name = 'shipments' and (exists (select 1 from public.shipment_lines where shipment_id = new.id)
                                     or exists (select 1 from public.shipment_order_lines where shipment_id = new.id)) then
      raise exception 'Warehouse and account cannot change once the shipment has order lines or pallets.';
    end if;
  end if;
  return new;
end $$;
create trigger trg_receipts_scope  before update on public.receipts  for each row execute function public.trg_lock_header_scope();
create trigger trg_shipments_scope before update on public.shipments for each row execute function public.trg_lock_header_scope();

-- order lines must be for the shipment's account
create or replace function public.trg_order_line_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select owner_id from public.items where id = new.item_id)
     is distinct from (select owner_id from public.shipments where id = new.shipment_id) then
    raise exception 'That item belongs to a different customer account than this shipment.';
  end if;
  return new;
end $$;
create trigger trg_sol_owner before insert or update on public.shipment_order_lines
  for each row execute function public.trg_order_line_owner();

-- ---------------------------------------------------------------------
-- RLS for the new tables
-- ---------------------------------------------------------------------
alter table public.warehouses enable row level security;
alter table public.owners     enable row level security;
create policy warehouses_read on public.warehouses for select to authenticated using (public.wms_role_rank() >= 1);
create policy owners_read     on public.owners     for select to authenticated using (public.wms_role_rank() >= 1);
create policy warehouses_mgr  on public.warehouses for all to authenticated
  using (public.wms_role_rank() >= 3 and not public.wms_is_lift()) with check (public.wms_role_rank() >= 3 and not public.wms_is_lift());
create policy owners_mgr      on public.owners     for all to authenticated
  using (public.wms_role_rank() >= 3 and not public.wms_is_lift()) with check (public.wms_role_rank() >= 3 and not public.wms_is_lift());
revoke all on public.warehouses, public.owners from anon;
grant select, insert, update on public.warehouses, public.owners to authenticated;

-- each user may set their own home warehouse (and nothing else on their row)
create or replace function public.wms_set_home_warehouse(p_warehouse_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.wms_require(1);
  if p_warehouse_id is not null and not exists (select 1 from public.warehouses where id = p_warehouse_id and active) then
    raise exception 'Warehouse not found.';
  end if;
  update public.app_users set home_warehouse_id = p_warehouse_id where id = auth.uid();
end $$;

-- ---------------------------------------------------------------------
-- views
-- ---------------------------------------------------------------------
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
  p.ref2,
  l.warehouse_id,
  w.code                                       as warehouse_code,
  i.owner_id,
  o.code                                       as owner_code,
  o.name                                       as owner_name
from public.pallets p
join public.items i          on i.id = p.item_id
left join public.locations l on l.id = p.location_id
left join public.warehouses w on w.id = l.warehouse_id
left join public.owners o    on o.id = i.owner_id
left join public.receipts r  on r.id = p.receipt_id
left join public.v_pallet_allocated a on a.pallet_id = p.id
where p.status in ('on_hand','hold') and p.qty_on_hand > 0;

create or replace view public.v_inventory_by_lot
with (security_invoker = true) as
select
  item_id, sku, description, uom, lot_number,
  count(*)            as pallets,
  sum(qty_on_hand)    as qty_on_hand,
  sum(qty_allocated)  as qty_allocated,
  sum(qty_available)  as qty_available,
  min(received_at)    as oldest_received,
  warehouse_id, warehouse_code, owner_id, owner_code, owner_name
from public.v_inventory
group by item_id, sku, description, uom, lot_number, warehouse_id, warehouse_code, owner_id, owner_code, owner_name;

create or replace view public.v_transactions
with (security_invoker = true) as
select
  t.id, t.created_at, t.txn_type,
  p.lp_id, p.customer_pallet_id,
  i.sku, t.lot_number,
  t.qty_change, t.qty_after,
  lf.code as from_location, lt.code as to_location,
  r.receipt_no, s.shipment_no,
  t.reason,
  u.full_name as user_name,
  wf.code as from_warehouse, wt.code as to_warehouse,
  o.code  as owner_code
from public.inventory_transactions t
join public.pallets p          on p.id = t.pallet_id
join public.items i            on i.id = t.item_id
left join public.owners o      on o.id = i.owner_id
left join public.locations lf  on lf.id = t.from_location_id
left join public.locations lt  on lt.id = t.to_location_id
left join public.warehouses wf on wf.id = lf.warehouse_id
left join public.warehouses wt on wt.id = lt.warehouse_id
left join public.receipts r    on r.id = t.receipt_id
left join public.shipments s   on s.id = t.shipment_id
left join public.app_users u   on u.id = t.created_by;

-- setof v_inventory changed shape: recreate the lookup
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

-- ---------------------------------------------------------------------
-- functions: account + warehouse rules
-- ---------------------------------------------------------------------
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

create or replace function public.wms_add_to_shipment(p_shipment_id uuid, p_pallet_id uuid, p_qty numeric default null)
returns public.shipment_lines
language plpgsql security definer set search_path = public as $$
declare
  v_set     public.settings;
  v_ship    public.shipments;
  v_pal     public.pallets;
  v_item    public.items;
  v_pal_wh  uuid;
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

  if v_item.owner_id <> v_ship.owner_id then
    raise exception 'WRONG PALLET: % belongs to a different customer account.', v_pal.lp_id;
  end if;
  select warehouse_id into v_pal_wh from public.locations where id = v_pal.location_id;
  if v_pal_wh is distinct from v_ship.warehouse_id then
    raise exception 'WRONG PALLET: % is in %, not this shipment''s warehouse.', v_pal.lp_id,
      coalesce((select code from public.warehouses where id = v_pal_wh), 'another warehouse');
  end if;

  select coalesce(sum(sl.qty), 0) into v_other
  from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id
  where sl.pallet_id = p_pallet_id and s.status = 'open' and s.id <> p_shipment_id;

  v_avail := v_pal.qty_on_hand - v_other;
  if v_avail <= 0 then
    raise exception 'Pallet % is fully allocated to another shipment.', v_pal.lp_id;
  end if;
  v_qty := coalesce(p_qty, v_avail);

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

-- moving a pallet that is on an open shipment to another building would strand the load
create or replace function public.wms_move_pallet(p_pallet_id uuid, p_to_location_id uuid)
returns public.pallets
language plpgsql security definer set search_path = public as $$
declare
  v       public.pallets;
  v_from  uuid;
  v_to    uuid;
begin
  perform public.wms_require(2);
  select * into v from public.pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found.'; end if;
  if v.status not in ('on_hand','hold') or v.qty_on_hand <= 0 then
    raise exception 'Pallet % is not in stock.', v.lp_id;
  end if;
  select warehouse_id into v_to from public.locations where id = p_to_location_id and active;
  if v_to is null then raise exception 'Location not found or inactive.'; end if;
  if v.location_id = p_to_location_id then return v; end if;
  select warehouse_id into v_from from public.locations where id = v.location_id;
  if v_from is distinct from v_to and exists (
       select 1 from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id
        where sl.pallet_id = p_pallet_id and s.status = 'open') then
    raise exception 'Pallet % is on an open shipment; take it off the load before moving it to another warehouse.', v.lp_id;
  end if;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, to_location_id)
  values ('MOVE', v.id, v.item_id, v.lot_number, 0, v.location_id, p_to_location_id);

  select * into v from public.pallets where id = p_pallet_id;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------
revoke execute on function public.wms_default_warehouse(), public.wms_default_owner(),
  public.trg_warehouse_seed_locations(), public.trg_lock_header_scope(), public.trg_order_line_owner(),
  public.wms_set_home_warehouse(uuid), public.wms_find_pallet(text) from anon, public;
revoke execute on function public.trg_warehouse_seed_locations(), public.trg_lock_header_scope(),
  public.trg_order_line_owner() from authenticated;
-- column defaults are evaluated as the inserting user
grant execute on function public.wms_default_warehouse(), public.wms_default_owner(),
  public.wms_set_home_warehouse(uuid), public.wms_find_pallet(text) to authenticated;

commit;
