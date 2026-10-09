-- =====================================================================
--  Customer Lite WMS  —  Migration 011: spreadsheet import / opening inventory / theme
--   * receipts.is_opening: the go-live load of pallets already in the building
--   * wms_import_opening_pallet(): receive one pallet onto an opening receipt,
--     keeping its original received date (managers only)
--   * opening pallets are NOT billed as inbound (no handling-in, arrival
--     storage or receiving fee); they bill storage on the 1st like any pallet
--   * v_inventory.received_at is now each pallet's own received time
-- =====================================================================
begin;

alter table public.receipts add column is_opening boolean not null default false;

-- look of the app: 'lwh' (red) or 'modern' (white + one accent color)
alter table public.settings
  add column theme text not null default 'lwh' check (theme in ('lwh', 'modern')),
  add column accent_color text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$');

-- only managers can mark a receipt as opening inventory (it isn't billed as inbound)
create or replace function public.trg_receipt_opening_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_opening and (tg_op = 'INSERT' or not old.is_opening)
     and (public.wms_role_rank() < 3 or public.wms_is_lift()) and auth.uid() is not null then
    raise exception 'Only managers can create opening-inventory receipts.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.is_opening and not new.is_opening and exists (select 1 from public.pallets where receipt_id = new.id) then
    raise exception 'An opening-inventory receipt with pallets cannot be changed to a normal receipt.';
  end if;
  return new;
end $$;
create trigger trg_receipts_opening before insert or update of is_opening on public.receipts
  for each row execute function public.trg_receipt_opening_guard();
revoke execute on function public.trg_receipt_opening_guard() from anon, public, authenticated;

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
  o.name                                       as owner_name
from public.pallets p
join public.items i          on i.id = p.item_id
left join public.locations l on l.id = p.location_id
left join public.warehouses w on w.id = l.warehouse_id
left join public.owners o    on o.id = i.owner_id
left join public.receipts r  on r.id = p.receipt_id
left join public.v_pallet_allocated a on a.pallet_id = p.id
where p.status in ('on_hand','hold') and p.qty_on_hand > 0;


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
  o.code  as owner_code,
  coalesce(r.is_opening, false) as opening
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


create or replace function public.wms_import_opening_pallet(
  p_receipt_id uuid, p_item_id uuid, p_qty numeric, p_lot_number text default null, p_location_id uuid default null,
  p_customer_pallet_id text default null, p_production_date date default null, p_expiration_date date default null,
  p_ref1 text default null, p_ref2 text default null, p_received_on date default null)
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
                                 p_production_date, p_expiration_date, 'Opening inventory', p_ref1, p_ref2);
  if p_received_on is not null then
    update public.pallets
       set created_at = (p_received_on::timestamp + interval '12 hours')
                        at time zone coalesce((select timezone from public.settings where id = 1), 'America/Chicago')
     where id = v.id
    returning * into v;
  end if;
  return v;
end $$;

-- billing: opening inventory is not an inbound load
create or replace function public.wms_billing_compute(p_owner_id uuid, p_month date)
returns table (sort int, category text, description text, warehouse_code text, ref text,
               qty numeric, uom text, rate numeric, amount numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_start timestamptz; v_end timestamptz;
  v_month date := date_trunc('month', p_month)::date;
begin
  select w.p_start, w.p_end into v_start, v_end from public.wms_month_window(v_month) w;

  return query
  with r as (select * from public.account_rates where owner_id = p_owner_id),
  rate_of as (select basis, rate, qty as rqty, label from r where basis <> 'manual'),
  -- pallets of this account received this month (not voided)
  pin as (
    select p.id, p.qty_received, i.uom, rc.id as receipt_id, rc.receipt_no, w.code as wh, p.created_at
    from public.pallets p
    join public.items i on i.id = p.item_id and i.owner_id = p_owner_id
    join public.receipts rc on rc.id = p.receipt_id and not rc.is_opening
    left join public.warehouses w on w.id = rc.warehouse_id
    where p.status <> 'void' and p.created_at >= v_start and p.created_at < v_end
  ),
  in_by_rcpt as (
    select receipt_id, receipt_no, wh, uom, count(*)::numeric as pallets, sum(qty_received) as units, min(created_at) as first_at
    from pin group by receipt_id, receipt_no, wh, uom
  ),
  -- a receipt's fee lands in the month its first pallet arrived
  rcpts as (
    select rc.id as receipt_id, rc.receipt_no, w.code as wh
    from public.receipts rc
    left join public.warehouses w on w.id = rc.warehouse_id
    where rc.owner_id = p_owner_id and not rc.is_opening
      and (select min(p.created_at) from public.pallets p where p.receipt_id = rc.id and p.status <> 'void') >= v_start
      and (select min(p.created_at) from public.pallets p where p.receipt_id = rc.id and p.status <> 'void') <  v_end
  ),
  -- shipments of this account shipped this month
  sout as (
    select s.id as shipment_id, s.shipment_no, w.code as wh, i.uom, count(*)::numeric as pallets, sum(sl.qty) as units, s.shipped_at
    from public.shipments s
    join public.shipment_lines sl on sl.shipment_id = s.id
    join public.pallets p on p.id = sl.pallet_id
    join public.items i on i.id = p.item_id
    left join public.warehouses w on w.id = s.warehouse_id
    where s.owner_id = p_owner_id and s.status = 'shipped' and s.shipped_at >= v_start and s.shipped_at < v_end
    group by s.id, s.shipment_no, w.code, i.uom, s.shipped_at
  ),
  ships as (select shipment_id, shipment_no, wh, min(shipped_at) as shipped_at from sout group by shipment_id, shipment_no, wh),
  -- on hand at 12:00 AM on the 1st (from the ledger), by warehouse at that moment
  onhand as (
    select p.id, i.uom, sum(t.qty_change) as qty,
           (select l.warehouse_id from public.inventory_transactions t2
              join public.locations l on l.id = coalesce(t2.to_location_id, t2.from_location_id)
             where t2.pallet_id = p.id and t2.created_at < v_start and coalesce(t2.to_location_id, t2.from_location_id) is not null
             order by t2.id desc limit 1) as wh_id
    from public.pallets p
    join public.items i on i.id = p.item_id and i.owner_id = p_owner_id
    join public.inventory_transactions t on t.pallet_id = p.id and t.created_at < v_start
    where p.status <> 'void' and p.created_at < v_start
    group by p.id, i.uom
    having sum(t.qty_change) > 0
  ),
  onhand_wh as (
    select w.code as wh, o.uom, count(*)::numeric as pallets, sum(o.qty) as units
    from onhand o left join public.warehouses w on w.id = o.wh_id
    group by w.code, o.uom
  ),
  lines as (
    -- fixed monthly contract charges
    select 10 as sort, 'Storage'::text as category,
           coalesce(ro.label, 'Contract space ' || to_char(ro.rqty, 'FM999,999,990') || ' sq ft') as description,
           null::text as wh, null::text as ref, ro.rqty as qty, 'sq ft'::text as uom, ro.rate
    from rate_of ro where ro.basis = 'monthly_sqft'
    union all
    select 11, 'Storage', coalesce(ro.label, 'Monthly fee'), null, null, 1, 'month', ro.rate
    from rate_of ro where ro.basis = 'monthly_flat'
    -- recurring storage on the 1st
    union all
    select 12, 'Storage', coalesce(ro.label, 'Storage, pallets on hand ' || to_char(v_month, 'FMMon FMDD')),
           oh.wh, null, sum(oh.pallets), 'pallets', ro.rate
    from onhand_wh oh, rate_of ro where ro.basis = 'storage_recur_pallet'
    group by oh.wh, ro.label, ro.rate
    union all
    select 13, 'Storage', coalesce(ro.label, 'Storage, units on hand ' || to_char(v_month, 'FMMon FMDD')),
           oh.wh, null, oh.units, oh.uom, ro.rate
    from onhand_wh oh, rate_of ro where ro.basis = 'storage_recur_unit'
    -- inbound, per receipt
    union all
    select 20, 'Inbound', coalesce(ro.label, 'Handling in, per pallet'), b.wh, b.receipt_no, sum(b.pallets), 'pallets', ro.rate
    from in_by_rcpt b, rate_of ro where ro.basis = 'in_pallet' group by b.wh, b.receipt_no, ro.label, ro.rate
    union all
    select 21, 'Inbound', coalesce(ro.label, 'Handling in, per unit'), b.wh, b.receipt_no, b.units, b.uom, ro.rate
    from in_by_rcpt b, rate_of ro where ro.basis = 'in_unit'
    union all
    select 22, 'Inbound', coalesce(ro.label, 'Initial storage, per pallet'), b.wh, b.receipt_no, sum(b.pallets), 'pallets', ro.rate
    from in_by_rcpt b, rate_of ro where ro.basis = 'storage_init_pallet' group by b.wh, b.receipt_no, ro.label, ro.rate
    union all
    select 23, 'Inbound', coalesce(ro.label, 'Initial storage, per unit'), b.wh, b.receipt_no, b.units, b.uom, ro.rate
    from in_by_rcpt b, rate_of ro where ro.basis = 'storage_init_unit'
    union all
    select 24, 'Inbound', coalesce(ro.label, 'Receiving fee'), c.wh, c.receipt_no, 1, 'load', ro.rate
    from rcpts c, rate_of ro where ro.basis = 'receipt_fee'
    -- outbound, per shipment
    union all
    select 30, 'Outbound', coalesce(ro.label, 'Handling out, per pallet'), o.wh, o.shipment_no, sum(o.pallets), 'pallets', ro.rate
    from sout o, rate_of ro where ro.basis = 'out_pallet' group by o.wh, o.shipment_no, ro.label, ro.rate
    union all
    select 31, 'Outbound', coalesce(ro.label, 'Handling out, per unit'), o.wh, o.shipment_no, o.units, o.uom, ro.rate
    from sout o, rate_of ro where ro.basis = 'out_unit'
    union all
    select 32, 'Outbound', coalesce(ro.label, 'Shipping fee'), sh.wh, sh.shipment_no, 1, 'load', ro.rate
    from ships sh, rate_of ro where ro.basis = 'shipment_fee'
    -- accessorials
    union all
    select 40, 'Other charges',
           ct.name || coalesce(' - ' || nullif(mc.description, ''), '') || ' (' || to_char(mc.charge_date, 'FMMM/FMDD') || ')',
           w.code, coalesce(rc.receipt_no, sh.shipment_no), mc.qty, ct.unit, mc.rate
    from public.manual_charges mc
    join public.charge_types ct on ct.id = mc.charge_type_id
    left join public.warehouses w on w.id = mc.warehouse_id
    left join public.receipts rc on rc.id = mc.receipt_id
    left join public.shipments sh on sh.id = mc.shipment_id
    where mc.owner_id = p_owner_id and mc.charge_date >= v_month and mc.charge_date < (v_month + interval '1 month')::date
  )
  select l.sort, l.category, l.description, l.wh, l.ref, l.qty, l.uom, l.rate, round(l.qty * l.rate, 2)
  from lines l
  where l.qty > 0
  order by l.sort, l.wh nulls first, l.ref nulls first, l.description;
end $$;

create or replace function public.wms_billing_detail(p_owner_id uuid, p_month date)
returns table (event text, event_at timestamptz, warehouse_code text, ref text, lp_id text,
               customer_pallet_id text, sku text, lot_number text, qty numeric, uom text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_start timestamptz; v_end timestamptz;
  v_month date := date_trunc('month', p_month)::date;
begin
  if public.wms_role_rank() < 3 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  select w.p_start, w.p_end into v_start, v_end from public.wms_month_window(v_month) w;
  return query
  select 'ON HAND ' || to_char(v_month, 'FMMon FMDD'), v_start, w.code, null::text, p.lp_id, p.customer_pallet_id,
         i.sku, p.lot_number, x.qty, i.uom
  from (select t.pallet_id, sum(t.qty_change) as qty from public.inventory_transactions t
         where t.created_at < v_start group by t.pallet_id having sum(t.qty_change) > 0) x
  join public.pallets p on p.id = x.pallet_id and p.status <> 'void'
  join public.items i on i.id = p.item_id and i.owner_id = p_owner_id
  left join lateral (select l.warehouse_id from public.inventory_transactions t2
                       join public.locations l on l.id = coalesce(t2.to_location_id, t2.from_location_id)
                      where t2.pallet_id = p.id and t2.created_at < v_start
                        and coalesce(t2.to_location_id, t2.from_location_id) is not null
                      order by t2.id desc limit 1) lw on true
  left join public.warehouses w on w.id = lw.warehouse_id
  union all
  select 'IN', p.created_at, w.code, rc.receipt_no, p.lp_id, p.customer_pallet_id, i.sku, p.lot_number, p.qty_received, i.uom
  from public.pallets p
  join public.items i on i.id = p.item_id and i.owner_id = p_owner_id
  join public.receipts rc on rc.id = p.receipt_id and not rc.is_opening
  left join public.warehouses w on w.id = rc.warehouse_id
  where p.status <> 'void' and p.created_at >= v_start and p.created_at < v_end
  union all
  select 'OUT', s.shipped_at, w.code, s.shipment_no, p.lp_id, p.customer_pallet_id, i.sku, p.lot_number, sl.qty, i.uom
  from public.shipments s
  join public.shipment_lines sl on sl.shipment_id = s.id
  join public.pallets p on p.id = sl.pallet_id
  join public.items i on i.id = p.item_id
  left join public.warehouses w on w.id = s.warehouse_id
  where s.owner_id = p_owner_id and s.status = 'shipped' and s.shipped_at >= v_start and s.shipped_at < v_end
  order by 2, 4, 5;
end $$;

revoke execute on function public.wms_import_opening_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, date) from anon, public;
grant execute on function public.wms_import_opening_pallet(uuid, uuid, numeric, text, uuid, text, date, date, text, text, date) to authenticated;
revoke execute on function public.wms_billing_compute(uuid, date) from anon, public, authenticated;

commit;
