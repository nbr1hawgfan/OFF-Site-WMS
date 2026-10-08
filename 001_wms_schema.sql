-- =====================================================================
--  Customer Lite WMS  —  Migration 001: core schema
--  Target: Supabase (Postgres 15+)
--
--  Design notes
--  ------------
--  * inventory_transactions is the source of truth (append-only ledger).
--    pallets.qty_on_hand / location are a cached projection kept in sync
--    by a trigger on the ledger — never written directly by the app.
--  * All inventory-changing actions go through the wms_* RPC functions
--    below. Each runs in a single transaction and locks the pallet rows
--    it touches, so two devices can't ship / adjust the same pallet.
--  * Every pallet gets a generated LP ID (lp_id). The customer's own
--    pallet ID (customer_pallet_id) is optional and unique when present.
--    Lookup functions search both.
--  * A receipt's pallets ARE its lines (pallets.receipt_id).
--    A shipment's lines are shipment_lines (pallet + qty), so partial
--    pallets can ship and the remainder stays on hand.
--  * Roles: admin > manager > operator > viewer (app_users.role).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 1. Users & settings
-- ---------------------------------------------------------------------
create table public.app_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  role        text not null default 'operator'
              check (role in ('admin','manager','operator','viewer')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_app_users_updated before update on public.app_users
  for each row execute function public.set_updated_at();

-- Role rank for the signed-in user (0 = not an active app user)
create or replace function public.wms_role_rank()
returns int language sql stable security definer set search_path = public as $$
  select coalesce((
    select case role when 'admin' then 4 when 'manager' then 3
                     when 'operator' then 2 when 'viewer' then 1 end
    from public.app_users
    where id = auth.uid() and active
  ), 0);
$$;

create or replace function public.wms_require(min_rank int)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.wms_role_rank() < min_rank then
    raise exception 'You do not have permission to do this.'
      using errcode = '42501';
  end if;
end $$;

-- Single-row settings: printed on receipts / BOLs
create table public.settings (
  id               int primary key default 1 check (id = 1),
  company_name     text not null default 'Company Name',
  address_line1    text,
  address_line2    text,
  city             text,
  state            text,
  zip              text,
  phone            text,
  lp_prefix        text not null default 'LP',
  default_uom      text not null default 'EA',
  updated_at       timestamptz not null default now()
);
insert into public.settings (id) values (1);
create trigger trg_settings_updated before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 2. Numbering
-- ---------------------------------------------------------------------
create sequence public.seq_lp_id       start 1;
create sequence public.seq_receipt_no  start 1001;
create sequence public.seq_shipment_no start 1001;

create or replace function public.next_lp_id()
returns text language sql volatile security definer set search_path = public as $$
  select (select lp_prefix from public.settings where id = 1)
         || lpad(nextval('public.seq_lp_id')::text, 6, '0');
$$;

-- ---------------------------------------------------------------------
-- 3. Master data
-- ---------------------------------------------------------------------
create table public.items (
  id                 uuid primary key default gen_random_uuid(),
  sku                text not null unique,
  description        text not null,
  uom                text not null default 'EA',
  units_per_pallet   numeric(12,2),
  unit_weight_lbs    numeric(12,3),
  freight_class      text,                 -- for BOL (e.g. '70')
  nmfc               text,                 -- for BOL
  lot_required       boolean not null default true,
  active             boolean not null default true,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger trg_items_updated before update on public.items
  for each row execute function public.set_updated_at();

create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,          -- e.g. 'A-01-1', 'DOCK', 'FLOOR'
  zone        text,
  loc_type    text not null default 'storage'
              check (loc_type in ('storage','dock','staging','floor','hold')),
  active      boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_locations_updated before update on public.locations
  for each row execute function public.set_updated_at();

insert into public.locations (code, zone, loc_type, sort_order) values
  ('DOCK',  'DOCK',  'dock',    0),
  ('FLOOR', 'FLOOR', 'floor',   1),
  ('HOLD',  'HOLD',  'hold',    2);

-- Ship-to / ship-from parties (BOL consignees, receipt vendors)
create table public.parties (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  party_type     text not null default 'consignee'
                 check (party_type in ('consignee','vendor','both')),
  address_line1  text,
  address_line2  text,
  city           text,
  state          text,
  zip            text,
  contact_name   text,
  phone          text,
  email          text,
  active         boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger trg_parties_updated before update on public.parties
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 4. Inbound
-- ---------------------------------------------------------------------
create table public.receipts (
  id             uuid primary key default gen_random_uuid(),
  receipt_no     text not null unique
                 default ('RCV-' || nextval('public.seq_receipt_no')),
  status         text not null default 'open'
                 check (status in ('open','closed','void')),
  received_at    timestamptz not null default now(),
  vendor_id      uuid references public.parties(id),
  vendor_name    text,                       -- free text if not in parties
  carrier        text,
  trailer_no     text,
  seal_no        text,
  po_number      text,
  inbound_bol    text,                       -- carrier's BOL / PRO
  notes          text,
  created_by     uuid references public.app_users(id) default auth.uid(),
  closed_at      timestamptz,
  closed_by      uuid references public.app_users(id),
  voided_at      timestamptz,
  voided_by      uuid references public.app_users(id),
  void_reason    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index ix_receipts_received_at on public.receipts (received_at desc);
create trigger trg_receipts_updated before update on public.receipts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. Pallets (license plates) — projection maintained by the ledger
-- ---------------------------------------------------------------------
create table public.pallets (
  id                  uuid primary key default gen_random_uuid(),
  lp_id               text not null unique default public.next_lp_id(),
  customer_pallet_id  text,
  item_id             uuid not null references public.items(id),
  lot_number          text,
  production_date     date,
  expiration_date     date,
  qty_received        numeric(12,2) not null check (qty_received > 0),
  qty_on_hand         numeric(12,2) not null default 0 check (qty_on_hand >= 0),
  location_id         uuid references public.locations(id),
  status              text not null default 'on_hand'
                      check (status in ('on_hand','hold','shipped','void')),
  receipt_id          uuid references public.receipts(id),
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- customer pallet IDs are stored trimmed + uppercase; unique when present
create unique index ux_pallets_customer_pallet_id
  on public.pallets (upper(customer_pallet_id)) where customer_pallet_id is not null;
create index ix_pallets_lp_upper    on public.pallets (upper(lp_id));
create index ix_pallets_item_lot   on public.pallets (item_id, lot_number);
create index ix_pallets_location   on public.pallets (location_id);
create index ix_pallets_receipt    on public.pallets (receipt_id);
create index ix_pallets_status     on public.pallets (status) where status <> 'shipped';
create trigger trg_pallets_updated before update on public.pallets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 6. Outbound
-- ---------------------------------------------------------------------
create table public.shipments (
  id                    uuid primary key default gen_random_uuid(),
  shipment_no           text not null unique
                        default ('SHP-' || nextval('public.seq_shipment_no')),
  status                text not null default 'open'
                        check (status in ('open','shipped','void')),
  ship_date             date not null default current_date,
  -- consignee snapshot (copied so the BOL never changes if the party is edited)
  consignee_id          uuid references public.parties(id),
  ship_to_name          text,
  ship_to_address1      text,
  ship_to_address2      text,
  ship_to_city          text,
  ship_to_state         text,
  ship_to_zip           text,
  ship_to_contact       text,
  ship_to_phone         text,
  customer_order_no     text,
  po_number             text,
  carrier               text,
  carrier_scac          text,
  trailer_no            text,
  seal_no               text,
  pro_number            text,
  freight_terms         text not null default 'prepaid'
                        check (freight_terms in ('prepaid','collect','third_party')),
  third_party_bill_to   text,
  special_instructions  text,
  notes                 text,
  created_by            uuid references public.app_users(id) default auth.uid(),
  shipped_at            timestamptz,
  shipped_by            uuid references public.app_users(id),
  voided_at             timestamptz,
  voided_by             uuid references public.app_users(id),
  void_reason           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index ix_shipments_ship_date on public.shipments (ship_date desc);
create trigger trg_shipments_updated before update on public.shipments
  for each row execute function public.set_updated_at();

create table public.shipment_lines (
  id           uuid primary key default gen_random_uuid(),
  shipment_id  uuid not null references public.shipments(id) on delete cascade,
  pallet_id    uuid not null references public.pallets(id),
  qty          numeric(12,2) not null check (qty > 0),
  created_by   uuid references public.app_users(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (shipment_id, pallet_id)
);
create index ix_shipment_lines_pallet on public.shipment_lines (pallet_id);

-- ---------------------------------------------------------------------
-- 7. Inventory ledger (append-only)
-- ---------------------------------------------------------------------
create table public.inventory_transactions (
  id                bigint generated always as identity primary key,
  txn_type          text not null check (txn_type in
                    ('RECEIVE','SHIP','ADJUST','MOVE','HOLD','RELEASE',
                     'VOID_RECEIVE','VOID_SHIP')),
  pallet_id         uuid not null references public.pallets(id),
  item_id           uuid not null references public.items(id),
  lot_number        text,
  qty_change        numeric(12,2) not null default 0,
  qty_after         numeric(12,2),           -- filled by trigger
  from_location_id  uuid references public.locations(id),
  to_location_id    uuid references public.locations(id),
  receipt_id        uuid references public.receipts(id),
  shipment_id       uuid references public.shipments(id),
  reason            text,
  created_by        uuid references public.app_users(id) default auth.uid(),
  created_at        timestamptz not null default now()
);
create index ix_txn_pallet     on public.inventory_transactions (pallet_id, id);
create index ix_txn_item_date  on public.inventory_transactions (item_id, created_at);
create index ix_txn_created_at on public.inventory_transactions (created_at);

-- Apply each ledger row to the pallet projection
create or replace function public.trg_apply_inventory_txn()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_new_qty numeric(12,2);
begin
  update public.pallets p
     set qty_on_hand = p.qty_on_hand + new.qty_change,
         location_id = coalesce(new.to_location_id, p.location_id),
         status = case
                    when new.txn_type = 'VOID_RECEIVE'            then 'void'
                    when new.txn_type = 'HOLD'                    then 'hold'
                    when new.txn_type = 'RELEASE'                 then 'on_hand'
                    when p.qty_on_hand + new.qty_change = 0
                         and new.txn_type = 'SHIP'                then 'shipped'
                    when p.qty_on_hand + new.qty_change > 0
                         and p.status = 'shipped'                 then 'on_hand'
                    else p.status
                  end
   where p.id = new.pallet_id
   returning p.qty_on_hand into v_new_qty;

  if v_new_qty is null then
    raise exception 'Pallet % not found', new.pallet_id;
  end if;
  if v_new_qty < 0 then
    raise exception 'Quantity cannot go below zero on this pallet.';
  end if;

  new.qty_after := v_new_qty;
  return new;
end $$;

create trigger trg_inventory_txn_apply
  before insert on public.inventory_transactions
  for each row execute function public.trg_apply_inventory_txn();

-- Ledger is append-only
create or replace function public.trg_block_ledger_change()
returns trigger language plpgsql as $$
begin
  raise exception 'Inventory transactions cannot be edited or deleted. Post a correcting transaction instead.';
end $$;

create trigger trg_inventory_txn_no_update
  before update or delete on public.inventory_transactions
  for each row execute function public.trg_block_ledger_change();

-- ---------------------------------------------------------------------
-- 8. Generated documents (receipt PDFs, BOLs, labels) in Storage
-- ---------------------------------------------------------------------
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  doc_type      text not null check (doc_type in ('RECEIPT','BOL','PACKING_LIST','LABELS','OTHER')),
  receipt_id    uuid references public.receipts(id),
  shipment_id   uuid references public.shipments(id),
  storage_path  text not null,               -- path in the 'documents' bucket
  file_name     text,
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  check (receipt_id is not null or shipment_id is not null)
);
create index ix_documents_receipt  on public.documents (receipt_id);
create index ix_documents_shipment on public.documents (shipment_id);

-- =====================================================================
-- 9. Views
-- =====================================================================

-- Qty already allocated to open (not yet shipped) shipments, per pallet
create or replace view public.v_pallet_allocated
with (security_invoker = true) as
select sl.pallet_id, sum(sl.qty) as qty_allocated
from public.shipment_lines sl
join public.shipments s on s.id = sl.shipment_id
where s.status = 'open'
group by sl.pallet_id;

-- Pallet-level on-hand (main lookup screen)
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
  p.receipt_id
from public.pallets p
join public.items i          on i.id = p.item_id
left join public.locations l on l.id = p.location_id
left join public.receipts r  on r.id = p.receipt_id
left join public.v_pallet_allocated a on a.pallet_id = p.id
where p.status in ('on_hand','hold') and p.qty_on_hand > 0;

-- Summary by item + lot (the old monthly spreadsheet view)
create or replace view public.v_inventory_by_lot
with (security_invoker = true) as
select
  item_id, sku, description, uom, lot_number,
  count(*)            as pallets,
  sum(qty_on_hand)    as qty_on_hand,
  sum(qty_allocated)  as qty_allocated,
  sum(qty_available)  as qty_available,
  min(received_at)    as oldest_received
from public.v_inventory
group by item_id, sku, description, uom, lot_number;

-- Ledger with readable names (activity history / audit)
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
  u.full_name as user_name
from public.inventory_transactions t
join public.pallets p         on p.id = t.pallet_id
join public.items i           on i.id = t.item_id
left join public.locations lf on lf.id = t.from_location_id
left join public.locations lt on lt.id = t.to_location_id
left join public.receipts r   on r.id = t.receipt_id
left join public.shipments s  on s.id = t.shipment_id
left join public.app_users u  on u.id = t.created_by;

-- =====================================================================
-- 10. RPC functions (the only way inventory changes)
-- =====================================================================

-- Find a pallet by LP ID or customer pallet ID (scanner lookup)
create or replace function public.wms_find_pallet(p_code text)
returns setof public.v_inventory
language sql stable security invoker set search_path = public as $$
  select v.* from public.v_inventory v
  where upper(v.lp_id) = upper(trim(p_code))
     or upper(v.customer_pallet_id) = upper(trim(p_code));
$$;

-- Receive one pallet onto an open receipt
create or replace function public.wms_receive_pallet(
  p_receipt_id          uuid,
  p_item_id             uuid,
  p_qty                 numeric,
  p_lot_number          text    default null,
  p_location_id         uuid    default null,
  p_customer_pallet_id  text    default null,
  p_production_date     date    default null,
  p_expiration_date     date    default null,
  p_notes               text    default null
) returns public.pallets
language plpgsql security definer set search_path = public as $$
declare
  v_receipt  public.receipts;
  v_item     public.items;
  v_loc      uuid;
  v_cust     text;
  v_pallet   public.pallets;
begin
  perform public.wms_require(2);

  select * into v_receipt from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'Receipt not found.'; end if;
  if v_receipt.status <> 'open' then
    raise exception 'Receipt % is %; it must be open to receive.', v_receipt.receipt_no, v_receipt.status;
  end if;

  select * into v_item from public.items where id = p_item_id;
  if not found or not v_item.active then raise exception 'Item not found or inactive.'; end if;
  if v_item.lot_required and nullif(trim(p_lot_number), '') is null then
    raise exception 'Lot / production number is required for %.', v_item.sku;
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero.'; end if;

  v_cust := upper(nullif(trim(p_customer_pallet_id), ''));
  if v_cust is not null and exists (
       select 1 from public.pallets where upper(customer_pallet_id) = v_cust) then
    raise exception 'Customer pallet ID % is already in use.', v_cust;
  end if;
  if v_cust is not null and exists (
       select 1 from public.pallets where upper(lp_id) = v_cust) then
    raise exception 'Customer pallet ID % matches one of our LP IDs; use a different ID.', v_cust;
  end if;

  v_loc := coalesce(p_location_id, (select id from public.locations where code = 'DOCK'));

  insert into public.pallets (customer_pallet_id, item_id, lot_number, production_date,
                              expiration_date, qty_received, qty_on_hand, location_id,
                              receipt_id, notes)
  values (v_cust, p_item_id, nullif(trim(p_lot_number), ''),
          p_production_date, p_expiration_date, p_qty, 0, v_loc, p_receipt_id, p_notes)
  returning * into v_pallet;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, to_location_id, receipt_id)
  values ('RECEIVE', v_pallet.id, p_item_id, v_pallet.lot_number, p_qty, v_loc, p_receipt_id);

  select * into v_pallet from public.pallets where id = v_pallet.id;
  return v_pallet;
end $$;

-- Close a receipt (no more pallets can be added)
create or replace function public.wms_close_receipt(p_receipt_id uuid)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare v public.receipts;
begin
  perform public.wms_require(2);
  update public.receipts
     set status = 'closed', closed_at = now(), closed_by = auth.uid()
   where id = p_receipt_id and status = 'open'
  returning * into v;
  if not found then raise exception 'Receipt not found or not open.'; end if;
  return v;
end $$;

-- Reopen a closed receipt (manager+)
create or replace function public.wms_reopen_receipt(p_receipt_id uuid)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare v public.receipts;
begin
  perform public.wms_require(3);
  update public.receipts
     set status = 'open', closed_at = null, closed_by = null
   where id = p_receipt_id and status = 'closed'
  returning * into v;
  if not found then raise exception 'Receipt not found or not closed.'; end if;
  return v;
end $$;

-- Void a whole receipt (manager+). Only allowed if nothing from it has
-- shipped or been allocated; reverses every pallet's remaining qty.
create or replace function public.wms_void_receipt(p_receipt_id uuid, p_reason text)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare
  v_receipt public.receipts;
  p         record;
begin
  perform public.wms_require(3);
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required to void.'; end if;

  select * into v_receipt from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'Receipt not found.'; end if;
  if v_receipt.status = 'void' then raise exception 'Receipt is already void.'; end if;

  perform 1 from public.pallets where receipt_id = p_receipt_id for update;

  if exists (select 1 from public.inventory_transactions t
             join public.pallets pl on pl.id = t.pallet_id
             where pl.receipt_id = p_receipt_id and t.txn_type = 'SHIP') then
    raise exception 'Cannot void: pallets from this receipt have already shipped.';
  end if;
  if exists (select 1 from public.shipment_lines sl
             join public.shipments s on s.id = sl.shipment_id and s.status = 'open'
             join public.pallets pl on pl.id = sl.pallet_id
             where pl.receipt_id = p_receipt_id) then
    raise exception 'Cannot void: pallets from this receipt are on an open shipment.';
  end if;

  for p in select * from public.pallets where receipt_id = p_receipt_id and status <> 'void' loop
    insert into public.inventory_transactions
      (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, receipt_id, reason)
    values ('VOID_RECEIVE', p.id, p.item_id, p.lot_number, -p.qty_on_hand, p.location_id,
            p_receipt_id, p_reason);
  end loop;

  update public.receipts
     set status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   where id = p_receipt_id
  returning * into v_receipt;
  return v_receipt;
end $$;

-- Move a pallet to another location
create or replace function public.wms_move_pallet(p_pallet_id uuid, p_to_location_id uuid)
returns public.pallets
language plpgsql security definer set search_path = public as $$
declare v public.pallets;
begin
  perform public.wms_require(2);
  select * into v from public.pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found.'; end if;
  if v.status not in ('on_hand','hold') or v.qty_on_hand <= 0 then
    raise exception 'Pallet % is not in stock.', v.lp_id;
  end if;
  if not exists (select 1 from public.locations where id = p_to_location_id and active) then
    raise exception 'Location not found or inactive.';
  end if;
  if v.location_id = p_to_location_id then return v; end if;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, to_location_id)
  values ('MOVE', v.id, v.item_id, v.lot_number, 0, v.location_id, p_to_location_id);

  select * into v from public.pallets where id = p_pallet_id;
  return v;
end $$;

-- Set a pallet's counted quantity (cycle count / damage). Manager+.
create or replace function public.wms_adjust_pallet(p_pallet_id uuid, p_new_qty numeric, p_reason text)
returns public.pallets
language plpgsql security definer set search_path = public as $$
declare
  v       public.pallets;
  v_alloc numeric;
begin
  perform public.wms_require(3);
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required for adjustments.'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'Quantity cannot be negative.'; end if;

  select * into v from public.pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found.'; end if;
  if v.status = 'void' then raise exception 'Pallet % is void.', v.lp_id; end if;

  select coalesce(sum(sl.qty), 0) into v_alloc
  from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id
  where sl.pallet_id = p_pallet_id and s.status = 'open';
  if p_new_qty < v_alloc then
    raise exception 'Pallet % has % allocated to an open shipment; remove it from the shipment first.', v.lp_id, v_alloc;
  end if;
  if p_new_qty = v.qty_on_hand then return v; end if;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, reason)
  values ('ADJUST', v.id, v.item_id, v.lot_number, p_new_qty - v.qty_on_hand, v.location_id, p_reason);

  select * into v from public.pallets where id = p_pallet_id;
  return v;
end $$;

-- Put a pallet on hold / release it (manager+)
create or replace function public.wms_set_hold(p_pallet_id uuid, p_hold boolean, p_reason text default null)
returns public.pallets
language plpgsql security definer set search_path = public as $$
declare v public.pallets;
begin
  perform public.wms_require(3);
  select * into v from public.pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found.'; end if;
  if p_hold and v.status <> 'on_hand' then raise exception 'Only in-stock pallets can be put on hold.'; end if;
  if not p_hold and v.status <> 'hold' then raise exception 'Pallet % is not on hold.', v.lp_id; end if;
  if p_hold and exists (select 1 from public.shipment_lines sl
                        join public.shipments s on s.id = sl.shipment_id
                        where sl.pallet_id = p_pallet_id and s.status = 'open') then
    raise exception 'Pallet % is on an open shipment; remove it first.', v.lp_id;
  end if;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, reason)
  values (case when p_hold then 'HOLD' else 'RELEASE' end,
          v.id, v.item_id, v.lot_number, 0, v.location_id, p_reason);

  select * into v from public.pallets where id = p_pallet_id;
  return v;
end $$;

-- Add (or update) a pallet on an open shipment. p_qty null = whole available qty.
create or replace function public.wms_add_to_shipment(p_shipment_id uuid, p_pallet_id uuid, p_qty numeric default null)
returns public.shipment_lines
language plpgsql security definer set search_path = public as $$
declare
  v_ship   public.shipments;
  v_pal    public.pallets;
  v_other  numeric;
  v_avail  numeric;
  v_qty    numeric;
  v_line   public.shipment_lines;
begin
  perform public.wms_require(2);

  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment not found.'; end if;
  if v_ship.status <> 'open' then raise exception 'Shipment % is %.', v_ship.shipment_no, v_ship.status; end if;

  select * into v_pal from public.pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found.'; end if;
  if v_pal.status = 'hold' then raise exception 'Pallet % is on hold.', v_pal.lp_id; end if;
  if v_pal.status <> 'on_hand' or v_pal.qty_on_hand <= 0 then
    raise exception 'Pallet % is not in stock.', v_pal.lp_id;
  end if;

  -- allocated on OTHER open shipments
  select coalesce(sum(sl.qty), 0) into v_other
  from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id
  where sl.pallet_id = p_pallet_id and s.status = 'open' and s.id <> p_shipment_id;

  v_avail := v_pal.qty_on_hand - v_other;
  v_qty   := coalesce(p_qty, v_avail);

  if v_avail <= 0 then
    raise exception 'Pallet % is fully allocated to another shipment.', v_pal.lp_id;
  end if;
  if v_qty <= 0 or v_qty > v_avail then
    raise exception 'Only % available on pallet %.', v_avail, v_pal.lp_id;
  end if;

  insert into public.shipment_lines (shipment_id, pallet_id, qty)
  values (p_shipment_id, p_pallet_id, v_qty)
  on conflict (shipment_id, pallet_id) do update set qty = excluded.qty
  returning * into v_line;
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
end $$;

-- Ship it: posts SHIP transactions for every line, locks the shipment.
create or replace function public.wms_ship_shipment(p_shipment_id uuid)
returns public.shipments
language plpgsql security definer set search_path = public as $$
declare
  v_ship public.shipments;
  ln     record;
begin
  perform public.wms_require(2);

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

-- Void a shipment (manager+). Open: just releases lines.
-- Shipped: reverses the SHIP transactions and puts pallets back.
create or replace function public.wms_void_shipment(p_shipment_id uuid, p_reason text)
returns public.shipments
language plpgsql security definer set search_path = public as $$
declare
  v_ship public.shipments;
  t      record;
begin
  perform public.wms_require(3);
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required to void.'; end if;

  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment not found.'; end if;
  if v_ship.status = 'void' then raise exception 'Shipment is already void.'; end if;

  if v_ship.status = 'shipped' then
    for t in
      select it.* from public.inventory_transactions it
      where it.shipment_id = p_shipment_id and it.txn_type = 'SHIP'
      order by it.pallet_id
    loop
      perform 1 from public.pallets where id = t.pallet_id for update;
      insert into public.inventory_transactions
        (txn_type, pallet_id, item_id, lot_number, qty_change, to_location_id, shipment_id, reason)
      values ('VOID_SHIP', t.pallet_id, t.item_id, t.lot_number, -t.qty_change,
              t.from_location_id, p_shipment_id, p_reason);
    end loop;
  end if;

  update public.shipments
     set status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   where id = p_shipment_id
  returning * into v_ship;
  return v_ship;
end $$;

-- =====================================================================
-- 11. Row Level Security & grants
--     Reads: any active app user.
--     Master data & headers: write by role.
--     Pallets, ledger, shipment lines: NO direct writes — RPC only.
-- =====================================================================
alter table public.app_users              enable row level security;
alter table public.settings               enable row level security;
alter table public.items                  enable row level security;
alter table public.locations              enable row level security;
alter table public.parties                enable row level security;
alter table public.receipts               enable row level security;
alter table public.pallets                enable row level security;
alter table public.shipments              enable row level security;
alter table public.shipment_lines         enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.documents              enable row level security;

-- read policies
create policy app_users_read on public.app_users for select to authenticated
  using (public.wms_role_rank() >= 1 or id = auth.uid());
create policy settings_read  on public.settings  for select to authenticated using (public.wms_role_rank() >= 1);
create policy items_read     on public.items     for select to authenticated using (public.wms_role_rank() >= 1);
create policy locations_read on public.locations for select to authenticated using (public.wms_role_rank() >= 1);
create policy parties_read   on public.parties   for select to authenticated using (public.wms_role_rank() >= 1);
create policy receipts_read  on public.receipts  for select to authenticated using (public.wms_role_rank() >= 1);
create policy pallets_read   on public.pallets   for select to authenticated using (public.wms_role_rank() >= 1);
create policy shipments_read on public.shipments for select to authenticated using (public.wms_role_rank() >= 1);
create policy slines_read    on public.shipment_lines for select to authenticated using (public.wms_role_rank() >= 1);
create policy txn_read       on public.inventory_transactions for select to authenticated using (public.wms_role_rank() >= 1);
create policy docs_read      on public.documents for select to authenticated using (public.wms_role_rank() >= 1);

-- admin: users & settings
create policy app_users_admin on public.app_users for all to authenticated
  using (public.wms_role_rank() >= 4) with check (public.wms_role_rank() >= 4);
create policy settings_admin on public.settings for update to authenticated
  using (public.wms_role_rank() >= 4) with check (public.wms_role_rank() >= 4);

-- manager: master data
create policy items_mgr     on public.items     for all to authenticated
  using (public.wms_role_rank() >= 3) with check (public.wms_role_rank() >= 3);
create policy locations_mgr on public.locations for all to authenticated
  using (public.wms_role_rank() >= 3) with check (public.wms_role_rank() >= 3);
create policy parties_mgr   on public.parties   for all to authenticated
  using (public.wms_role_rank() >= 3) with check (public.wms_role_rank() >= 3);

-- operator: create / edit OPEN receipt & shipment headers (status changes go through RPCs)
create policy receipts_ins on public.receipts for insert to authenticated
  with check (public.wms_role_rank() >= 2 and status = 'open');
create policy receipts_upd on public.receipts for update to authenticated
  using (public.wms_role_rank() >= 2 and status = 'open')
  with check (public.wms_role_rank() >= 2 and status = 'open');
create policy shipments_ins on public.shipments for insert to authenticated
  with check (public.wms_role_rank() >= 2 and status = 'open');
create policy shipments_upd on public.shipments for update to authenticated
  using (public.wms_role_rank() >= 2 and status = 'open')
  with check (public.wms_role_rank() >= 2 and status = 'open');
create policy docs_ins on public.documents for insert to authenticated
  with check (public.wms_role_rank() >= 2);

-- Column-level guard: header status/audit columns only change via RPCs
revoke update on public.receipts  from authenticated, anon;
grant  update (received_at, vendor_id, vendor_name, carrier, trailer_no, seal_no,
               po_number, inbound_bol, notes)
  on public.receipts to authenticated;
revoke update on public.shipments from authenticated, anon;
grant  update (ship_date, consignee_id, ship_to_name, ship_to_address1, ship_to_address2,
               ship_to_city, ship_to_state, ship_to_zip, ship_to_contact, ship_to_phone,
               customer_order_no, po_number, carrier, carrier_scac, trailer_no, seal_no,
               pro_number, freight_terms, third_party_bill_to, special_instructions, notes)
  on public.shipments to authenticated;

-- No direct writes to inventory tables
revoke insert, update, delete on public.pallets                from authenticated, anon;
revoke insert, update, delete on public.inventory_transactions from authenticated, anon;
revoke insert, update, delete on public.shipment_lines         from authenticated, anon;
revoke delete on public.receipts, public.shipments, public.documents from authenticated, anon;

-- Nothing for anonymous users
revoke all on all tables    in schema public from anon;
revoke execute on all functions in schema public from anon, public;
grant  execute on function
  public.wms_role_rank(),
  public.wms_find_pallet(text),
  public.wms_receive_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text),
  public.wms_close_receipt(uuid),
  public.wms_reopen_receipt(uuid),
  public.wms_void_receipt(uuid, text),
  public.wms_move_pallet(uuid, uuid),
  public.wms_adjust_pallet(uuid, numeric, text),
  public.wms_set_hold(uuid, boolean, text),
  public.wms_add_to_shipment(uuid, uuid, numeric),
  public.wms_remove_from_shipment(uuid, uuid),
  public.wms_ship_shipment(uuid),
  public.wms_void_shipment(uuid, text)
to authenticated;
-- needed by column defaults / triggers when called through RPCs
grant execute on function public.next_lp_id(), public.set_updated_at(),
                          public.wms_require(int) to authenticated;
grant usage on sequence public.seq_receipt_no, public.seq_shipment_no to authenticated;

commit;

-- =====================================================================
-- After running:
--  1. Storage: create a PRIVATE bucket named 'documents'.
--  2. Auth: create the first user, then:
--       insert into public.app_users (id, full_name, role)
--       values ('<auth user uuid>', 'Tim', 'admin');
--  3. Settings: update public.settings set company_name = '...', lp_prefix = '...';
-- =====================================================================
