-- =====================================================================
--  Customer Lite WMS  —  Migration 022: item activity report
--   wms_item_activity(from, to, warehouse, account): for each warehouse /
--   account / item / lot, the classic 3PL roll-forward for a date range:
--     opening balance  (pallets, qty at the start of the first day)
--   + received         (normal receipts; opening-inventory imports separate)
--   - shipped
--   + adjusted         (count adjustments, voided pallets / shipments)
--   + transfers in / - transfers out between warehouses
--   = closing balance  (pallets, qty at the end of the last day)
--   Built from the append-only pallet ledger, so any past range works.
--   Staff see every account; customer logins only their own accounts.
-- =====================================================================
begin;

create or replace function public.wms_item_activity(p_from date, p_to date,
  p_warehouse_id uuid default null, p_owner_id uuid default null)
returns table (warehouse_code text, owner_code text, sku text, description text, uom text, lot_number text,
               open_pallets int, open_qty numeric, recv_pallets int, recv_qty numeric, import_qty numeric,
               ship_pallets int, ship_qty numeric, adjust_qty numeric, xfer_in_qty numeric, xfer_out_qty numeric,
               close_pallets int, close_qty numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tz   text := coalesce((select timezone from public.settings where id = 1), 'America/Chicago');
  v_a    timestamptz;
  v_b    timestamptz;
  v_cust boolean := public.wms_is_customer();
  v_mine uuid[]  := public.wms_customer_owners();
begin
  if (public.wms_role_rank() < 1 or public.wms_is_lift()) and not v_cust then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pick a valid date range.'; end if;
  if p_to - p_from > 1100 then raise exception 'Pick a range of 3 years or less.'; end if;
  v_a := (p_from::timestamp) at time zone v_tz;
  v_b := ((p_to + 1)::timestamp) at time zone v_tz;

  return query
  with tx as (
    select t.id, t.pallet_id, t.txn_type, t.qty_change, t.qty_after, t.created_at,
           p.item_id, p.lot_number, coalesce(r.is_opening, false) as opening,
           lf.warehouse_id as from_wh, lt.warehouse_id as to_wh
    from public.inventory_transactions t
    join public.pallets p        on p.id = t.pallet_id
    join public.items i          on i.id = p.item_id
    left join public.receipts r  on r.id = t.receipt_id
    left join public.locations lf on lf.id = t.from_location_id
    left join public.locations lt on lt.id = t.to_location_id
    where t.created_at < v_b
      and (not v_cust or i.owner_id = any (v_mine))
      and (p_owner_id is null or i.owner_id = p_owner_id)
  ),
  -- each pallet's balance, and the warehouse it sat in, at the start and at the end
  snap as (
    select k.which, k.cut, x.pallet_id, min(x.item_id::text)::uuid as item_id, min(x.lot_number) as lot_number,
           sum(x.qty_change) as qty
    from (values (1, v_a), (2, v_b)) k(which, cut)
    join tx x on x.created_at < k.cut
    group by k.which, k.cut, x.pallet_id
    having sum(x.qty_change) > 0
  ),
  snapwh as (
    select s.*, (select coalesce(x.to_wh, x.from_wh) from tx x
                  where x.pallet_id = s.pallet_id and x.created_at < s.cut and coalesce(x.to_wh, x.from_wh) is not null
                  order by x.id desc limit 1) as wh
    from snap s
  ),
  ev as (select * from tx where created_at >= v_a),
  lines as (
    -- opening / closing balances
    select wh, item_id, lot_number,
           case when which = 1 then 1 else 0 end as op_p, case when which = 1 then qty else 0 end as op_q,
           0 as rc_p, 0::numeric as rc_q, 0::numeric as im_q, 0 as sh_p, 0::numeric as sh_q, 0::numeric as ad_q,
           0::numeric as xi_q, 0::numeric as xo_q,
           case when which = 2 then 1 else 0 end as cl_p, case when which = 2 then qty else 0 end as cl_q
    from snapwh
    union all
    -- receipts, shipments, adjustments and voids in the range
    select coalesce(to_wh, from_wh), item_id, lot_number, 0, 0,
           case when txn_type = 'RECEIVE' and not opening then 1 when txn_type = 'VOID_RECEIVE' and not opening then -1 else 0 end,
           case when txn_type in ('RECEIVE', 'VOID_RECEIVE') and not opening then qty_change else 0 end,
           case when txn_type in ('RECEIVE', 'VOID_RECEIVE') and opening then qty_change else 0 end,
           case when txn_type = 'SHIP' then 1 when txn_type = 'VOID_SHIP' then -1 else 0 end,
           case when txn_type in ('SHIP', 'VOID_SHIP') then -qty_change else 0 end,
           case when txn_type = 'ADJUST' then qty_change else 0 end,
           0, 0, 0, 0
    from ev where txn_type in ('RECEIVE', 'VOID_RECEIVE', 'SHIP', 'VOID_SHIP', 'ADJUST')
    union all
    -- moves between warehouses: out of one, into the other
    select from_wh, item_id, lot_number, 0, 0, 0, 0, 0, 0, 0, 0, 0, coalesce(qty_after, 0), 0, 0
    from ev where txn_type = 'MOVE' and from_wh is distinct from to_wh and from_wh is not null
    union all
    select to_wh, item_id, lot_number, 0, 0, 0, 0, 0, 0, 0, 0, coalesce(qty_after, 0), 0, 0, 0
    from ev where txn_type = 'MOVE' and from_wh is distinct from to_wh and to_wh is not null
  )
  select w.code, o.code, i.sku, i.description, i.uom, l.lot_number,
         sum(op_p)::int, sum(op_q), sum(rc_p)::int, sum(rc_q), sum(im_q),
         sum(sh_p)::int, sum(sh_q), sum(ad_q), sum(xi_q), sum(xo_q),
         sum(cl_p)::int, sum(cl_q)
  from lines l
  join public.items i            on i.id = l.item_id
  left join public.owners o      on o.id = i.owner_id
  left join public.warehouses w  on w.id = l.wh
  where p_warehouse_id is null or l.wh = p_warehouse_id
  group by w.code, o.code, i.sku, i.description, i.uom, l.lot_number
  order by w.code, o.code, i.sku, l.lot_number nulls first;
end $$;

revoke execute on function public.wms_item_activity(date, date, uuid, uuid) from anon, public;
grant  execute on function public.wms_item_activity(date, date, uuid, uuid) to authenticated;

commit;
