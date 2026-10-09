-- =====================================================================
--  Customer Lite WMS  —  Migration 013: subcustomers, master bill-to, load parties
--   * owners.bill_to_id: a subcustomer (plant/location) bills to a master
--     account. Each keeps its own items and inventory. A master bills itself.
--   * statements, month close and billing totals are per bill-to master, with
--     a section per subcustomer. Subcustomers use the master's rates unless
--     they have their own (monthly space / flat fees never inherit).
--   * loads: carrier_by ('customer' = customer pickup / their own carrier,
--     'lwh' = Logistics hauls and bills freight). New charge type FREIGHT.
-- =====================================================================
begin;

alter table public.owners add column bill_to_id uuid references public.owners(id);
create index ix_owners_bill_to on public.owners (bill_to_id) where bill_to_id is not null;

create or replace function public.trg_owner_bill_to()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.bill_to_id is not null then
    if new.bill_to_id = new.id then raise exception 'An account cannot bill to itself.'; end if;
    if exists (select 1 from public.owners where id = new.bill_to_id and bill_to_id is not null) then
      raise exception 'Bill-to must be a master account (one that bills itself).';
    end if;
    if exists (select 1 from public.owners where bill_to_id = new.id) then
      raise exception '% is the bill-to for other accounts, so it cannot bill to another account.', new.code;
    end if;
  end if;
  return new;
end $$;
create trigger trg_owners_bill_to before insert or update of bill_to_id on public.owners
  for each row execute function public.trg_owner_bill_to();

create or replace function public.wms_bill_to(p_owner_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(bill_to_id, id) from public.owners where id = p_owner_id;
$$;

-- loads: who arranges the carrier, and the inbound shipper from the address book
alter table public.receipts
  add column carrier_by text not null default 'customer' check (carrier_by in ('customer', 'lwh'));
alter table public.shipments
  add column carrier_by text not null default 'customer' check (carrier_by in ('customer', 'lwh'));
grant update (carrier_by) on public.receipts to authenticated;
grant update (carrier_by) on public.shipments to authenticated;

insert into public.charge_types (code, name, unit, sort_order)
select 'FREIGHT', 'Freight', 'load', 5
where not exists (select 1 from public.charge_types where upper(code) = 'FREIGHT');

-- charges lock with the bill-to master's month
create or replace function public.trg_manual_charge_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; v_wh uuid;
begin
  if tg_op in ('UPDATE','DELETE') and exists (
       select 1 from public.billing_periods
        where owner_id = public.wms_bill_to(old.owner_id) and period_month = date_trunc('month', old.charge_date)::date) then
    raise exception 'Billing for % is closed; reopen the month to change its charges.', to_char(old.charge_date, 'FMMonth YYYY');
  end if;
  if tg_op = 'DELETE' then return old; end if;

  if new.receipt_id is not null then
    select owner_id, warehouse_id into v_owner, v_wh from public.receipts where id = new.receipt_id;
    new.owner_id := v_owner; new.warehouse_id := v_wh; new.shipment_id := null;
  elsif new.shipment_id is not null then
    select owner_id, warehouse_id into v_owner, v_wh from public.shipments where id = new.shipment_id;
    new.owner_id := v_owner; new.warehouse_id := v_wh;
  end if;
  if exists (select 1 from public.billing_periods
              where owner_id = public.wms_bill_to(new.owner_id) and period_month = date_trunc('month', new.charge_date)::date) then
    raise exception 'Billing for % is closed; reopen the month to add charges.', to_char(new.charge_date, 'FMMonth YYYY');
  end if;
  return new;
end $$;

-- per-account lines with rate inheritance
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
  -- a subcustomer uses its own rate for a basis, else its bill-to master's;
  -- fixed monthly charges (space, flat fee) never inherit
  rate_of as (
    select basis, rate, qty as rqty, label from r where basis <> 'manual'
    union all
    select m.basis, m.rate, m.qty, m.label from public.account_rates m
    where m.owner_id = (select o.bill_to_id from public.owners o where o.id = p_owner_id)
      and m.basis not in ('manual', 'monthly_sqft', 'monthly_flat')
      and not exists (select 1 from r where r.basis = m.basis)
  ),
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

-- the statement for a bill-to master: its own lines plus each subcustomer's
create or replace function public.wms_billing_statement(p_owner_id uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_bt    uuid;
  v_bp    public.billing_periods;
  v_lines jsonb;
  v_code  text;
begin
  if public.wms_role_rank() < 3 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  v_bt := public.wms_bill_to(p_owner_id);
  select code into v_code from public.owners where id = v_bt;
  if v_code is null then raise exception 'Account not found.'; end if;

  select * into v_bp from public.billing_periods where owner_id = v_bt and period_month = v_month;
  if found then
    return jsonb_build_object('status', 'closed', 'bill_to_id', v_bt, 'statement_no', v_bp.statement_no, 'month', v_month,
      'closed_at', v_bp.closed_at, 'closed_by', (select full_name from public.app_users where id = v_bp.closed_by),
      'lines', v_bp.lines, 'total', v_bp.total);
  end if;

  select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('account_code', o.code, 'account_name', o.name)
           order by (o.id <> v_bt), o.code, c.sort, c.warehouse_code nulls first, c.ref nulls first, c.description), '[]'::jsonb)
    into v_lines
    from public.owners o
    cross join lateral public.wms_billing_compute(o.id, v_month) c
   where o.id = v_bt or o.bill_to_id = v_bt;
  return jsonb_build_object('status', 'open', 'bill_to_id', v_bt, 'statement_no', upper(v_code) || '-' || to_char(v_month, 'YYYY-MM'),
    'month', v_month, 'lines', v_lines,
    'total', coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(v_lines) x), 0),
    'month_ended', v_month < date_trunc('month', public.wms_local_today())::date);
end $$;

-- every bill-to master's total for a month (Billing home)
create or replace function public.wms_billing_summary(p_month date)
returns table (owner_id uuid, status text, total numeric, line_count int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_month date := date_trunc('month', p_month)::date;
begin
  if public.wms_role_rank() < 3 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  return query
  select o.id,
         case when bp.id is not null then 'closed' else 'open' end,
         coalesce(bp.total, (select sum(c.amount) from public.owners m cross join lateral public.wms_billing_compute(m.id, v_month) c
                              where m.id = o.id or m.bill_to_id = o.id), 0),
         coalesce(jsonb_array_length(bp.lines), (select count(*)::int from public.owners m cross join lateral public.wms_billing_compute(m.id, v_month) c
                              where m.id = o.id or m.bill_to_id = o.id))
  from public.owners o
  left join public.billing_periods bp on bp.owner_id = o.id and bp.period_month = v_month
  where o.bill_to_id is null and (o.active or bp.id is not null);
end $$;

drop function public.wms_billing_detail(uuid, date);
create function public.wms_billing_detail(p_owner_id uuid, p_month date)
returns table (account_code text, event text, event_at timestamptz, warehouse_code text, ref text, lp_id text,
               customer_pallet_id text, sku text, lot_number text, qty numeric, uom text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_start timestamptz; v_end timestamptz; v_bt uuid;
  v_month date := date_trunc('month', p_month)::date;
begin
  if public.wms_role_rank() < 3 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  select w.p_start, w.p_end into v_start, v_end from public.wms_month_window(v_month) w;
  v_bt := public.wms_bill_to(p_owner_id);
  return query
  select o.code, 'ON HAND ' || to_char(v_month, 'FMMon FMDD'), v_start, w.code, null::text, p.lp_id, p.customer_pallet_id,
         i.sku, p.lot_number, x.qty, i.uom
  from (select t.pallet_id, sum(t.qty_change) as qty from public.inventory_transactions t
         where t.created_at < v_start group by t.pallet_id having sum(t.qty_change) > 0) x
  join public.pallets p on p.id = x.pallet_id and p.status <> 'void'
  join public.items i on i.id = p.item_id
  join public.owners o on o.id = i.owner_id and (o.id = v_bt or o.bill_to_id = v_bt)
  left join lateral (select l.warehouse_id from public.inventory_transactions t2
                       join public.locations l on l.id = coalesce(t2.to_location_id, t2.from_location_id)
                      where t2.pallet_id = p.id and t2.created_at < v_start
                        and coalesce(t2.to_location_id, t2.from_location_id) is not null
                      order by t2.id desc limit 1) lw on true
  left join public.warehouses w on w.id = lw.warehouse_id
  union all
  select o.code, 'IN', p.created_at, w.code, rc.receipt_no, p.lp_id, p.customer_pallet_id, i.sku, p.lot_number, p.qty_received, i.uom
  from public.pallets p
  join public.items i on i.id = p.item_id
  join public.owners o on o.id = i.owner_id and (o.id = v_bt or o.bill_to_id = v_bt)
  join public.receipts rc on rc.id = p.receipt_id and not rc.is_opening
  left join public.warehouses w on w.id = rc.warehouse_id
  where p.status <> 'void' and p.created_at >= v_start and p.created_at < v_end
  union all
  select o.code, 'OUT', s.shipped_at, w.code, s.shipment_no, p.lp_id, p.customer_pallet_id, i.sku, p.lot_number, sl.qty, i.uom
  from public.shipments s
  join public.shipment_lines sl on sl.shipment_id = s.id
  join public.pallets p on p.id = sl.pallet_id
  join public.items i on i.id = p.item_id
  left join public.warehouses w on w.id = s.warehouse_id
  join public.owners o on o.id = s.owner_id and (o.id = v_bt or o.bill_to_id = v_bt)
  where s.status = 'shipped' and s.shipped_at >= v_start and s.shipped_at < v_end
  order by 1, 3, 5, 6;
end $$;

create or replace function public.wms_close_billing_period(p_owner_id uuid, p_month date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_bt    uuid := public.wms_bill_to(p_owner_id);
  v_st    jsonb;
begin
  if public.wms_role_rank() < 3 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  if v_month >= date_trunc('month', public.wms_local_today())::date then
    raise exception 'A month can be closed once it is over.';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_bt::text || v_month::text));
  if exists (select 1 from public.billing_periods where owner_id = v_bt and period_month = v_month) then
    raise exception 'That month is already closed.';
  end if;
  v_st := public.wms_billing_statement(v_bt, v_month);
  insert into public.billing_periods (owner_id, period_month, statement_no, lines, total)
  values (v_bt, v_month, v_st->>'statement_no', v_st->'lines', (v_st->>'total')::numeric);
  return public.wms_billing_statement(v_bt, v_month);
end $$;

create or replace function public.wms_reopen_billing_period(p_owner_id uuid, p_month date)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.wms_require(4);
  delete from public.billing_periods where owner_id = public.wms_bill_to(p_owner_id) and period_month = date_trunc('month', p_month)::date;
  if not found then raise exception 'That month is not closed.'; end if;
end $$;

revoke execute on function public.trg_owner_bill_to(), public.wms_billing_compute(uuid, date) from anon, public, authenticated;
revoke execute on function public.wms_bill_to(uuid), public.wms_billing_detail(uuid, date) from anon, public;
grant execute on function public.wms_bill_to(uuid), public.wms_billing_detail(uuid, date) to authenticated;

commit;
