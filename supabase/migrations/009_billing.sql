-- =====================================================================
--  Customer Lite WMS  —  Migration 009: billing
--
--  * account_rates: each customer account's contract rates
--      in_pallet / in_unit           handling in (most contracts: in+out paid here)
--      out_pallet / out_unit         handling out (contracts that bill it separately)
--      receipt_fee / shipment_fee    per inbound load / per outbound load
--      storage_init_pallet / _unit   storage charged when a pallet arrives
--      storage_recur_pallet / _unit  storage charged again on the 1st for what's on hand
--      monthly_sqft                  fixed contract space: sq ft x rate per month
--      monthly_flat                  any other fixed monthly fee
--      manual                        this account's price for a charge type
--  * charge_types: accessorials (admin, special handling, after hours, ...)
--  * manual_charges: accessorials entered on a receipt, shipment, or the account
--  * billing_periods: a closed month keeps a frozen copy of its statement
--  Months follow settings.timezone (default America/Chicago).
-- =====================================================================
begin;

alter table public.settings add column timezone text not null default 'America/Chicago';

-- ---------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------
create table public.charge_types (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,
  name          text not null,
  unit          text not null default 'each',
  default_rate  numeric(12,4) not null default 0 check (default_rate >= 0),
  active        boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index ux_charge_types_code on public.charge_types (upper(code));
create trigger trg_charge_types_updated before update on public.charge_types
  for each row execute function public.set_updated_at();
insert into public.charge_types (code, name, unit, sort_order) values
  ('ADMIN',    'Admin fee',          'each', 1),
  ('SPECIAL',  'Special handling',   'hour', 2),
  ('AFTERHRS', 'After-hours service', 'each', 3),
  ('LABOR',    'Labor',              'hour', 4),
  ('OTHER',    'Other',              'each', 9);

create table public.account_rates (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.owners(id) on delete cascade,
  basis           text not null check (basis in (
                    'in_pallet','in_unit','out_pallet','out_unit','receipt_fee','shipment_fee',
                    'storage_init_pallet','storage_init_unit','storage_recur_pallet','storage_recur_unit',
                    'monthly_sqft','monthly_flat','manual')),
  charge_type_id  uuid references public.charge_types(id) on delete cascade,
  rate            numeric(12,4) not null check (rate >= 0),
  qty             numeric(12,2) check (qty is null or qty > 0),   -- sq ft for monthly_sqft
  label           text,                                           -- optional wording on the statement
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((basis = 'manual') = (charge_type_id is not null)),
  check (basis <> 'monthly_sqft' or qty is not null)
);
create unique index ux_account_rates on public.account_rates
  (owner_id, basis, coalesce(charge_type_id, '00000000-0000-0000-0000-000000000000'::uuid));
create trigger trg_account_rates_updated before update on public.account_rates
  for each row execute function public.set_updated_at();

create or replace function public.wms_local_today()
returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select timezone from public.settings where id = 1), 'America/Chicago'))::date;
$$;

create table public.manual_charges (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.owners(id),
  warehouse_id    uuid references public.warehouses(id),
  charge_date     date not null default public.wms_local_today(),
  charge_type_id  uuid not null references public.charge_types(id),
  description     text,
  qty             numeric(12,2) not null default 1 check (qty > 0),
  rate            numeric(12,4) not null check (rate >= 0),
  amount          numeric(12,2) generated always as (round(qty * rate, 2)) stored,
  receipt_id      uuid references public.receipts(id),
  shipment_id     uuid references public.shipments(id),
  created_by      uuid references public.app_users(id) default auth.uid(),
  created_at      timestamptz not null default now()
);
create index ix_manual_charges_owner_date on public.manual_charges (owner_id, charge_date);
create index ix_manual_charges_receipt  on public.manual_charges (receipt_id)  where receipt_id  is not null;
create index ix_manual_charges_shipment on public.manual_charges (shipment_id) where shipment_id is not null;

create table public.billing_periods (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.owners(id),
  period_month   date not null check (extract(day from period_month) = 1),
  statement_no   text not null,
  lines          jsonb not null,
  total          numeric(12,2) not null,
  closed_at      timestamptz not null default now(),
  closed_by      uuid references public.app_users(id) default auth.uid(),
  unique (owner_id, period_month)
);

-- ---------------------------------------------------------------------
-- manual charges: account/warehouse follow the receipt or shipment,
-- and nothing changes in a closed month
-- ---------------------------------------------------------------------
create or replace function public.trg_manual_charge_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; v_wh uuid;
begin
  if tg_op in ('UPDATE','DELETE') and exists (
       select 1 from public.billing_periods
        where owner_id = old.owner_id and period_month = date_trunc('month', old.charge_date)::date) then
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
              where owner_id = new.owner_id and period_month = date_trunc('month', new.charge_date)::date) then
    raise exception 'Billing for % is closed; reopen the month to add charges.', to_char(new.charge_date, 'FMMonth YYYY');
  end if;
  return new;
end $$;
create trigger trg_manual_charges_guard before insert or update or delete on public.manual_charges
  for each row execute function public.trg_manual_charge_guard();

-- ---------------------------------------------------------------------
-- RLS
--   rates, charge types, statements: managers (office)
--   manual charges: office staff add; managers change/delete
-- ---------------------------------------------------------------------
alter table public.charge_types    enable row level security;
alter table public.account_rates   enable row level security;
alter table public.manual_charges  enable row level security;
alter table public.billing_periods enable row level security;

create policy charge_types_read on public.charge_types for select to authenticated using (public.wms_is_office());
create policy charge_types_mgr  on public.charge_types for all to authenticated
  using (public.wms_role_rank() >= 3 and not public.wms_is_lift())
  with check (public.wms_role_rank() >= 3 and not public.wms_is_lift());

-- office staff need the account's price to fill in a charge
create policy account_rates_read on public.account_rates for select to authenticated using (public.wms_is_office());
create policy account_rates_mgr  on public.account_rates for all to authenticated
  using (public.wms_role_rank() >= 3 and not public.wms_is_lift())
  with check (public.wms_role_rank() >= 3 and not public.wms_is_lift());

create policy manual_charges_read on public.manual_charges for select to authenticated using (public.wms_is_office());
create policy manual_charges_ins  on public.manual_charges for insert to authenticated with check (public.wms_is_office());
create policy manual_charges_upd  on public.manual_charges for update to authenticated
  using (public.wms_role_rank() >= 3 and not public.wms_is_lift())
  with check (public.wms_role_rank() >= 3 and not public.wms_is_lift());
create policy manual_charges_del  on public.manual_charges for delete to authenticated
  using (public.wms_role_rank() >= 3 and not public.wms_is_lift());

create policy billing_periods_read on public.billing_periods for select to authenticated
  using (public.wms_role_rank() >= 3 and not public.wms_is_lift());
-- writes only through wms_close_billing_period / wms_reopen_billing_period

revoke all on public.charge_types, public.account_rates, public.manual_charges, public.billing_periods from anon;
grant select, insert, update, delete on public.charge_types, public.account_rates, public.manual_charges to authenticated;
grant select on public.billing_periods to authenticated;

-- ---------------------------------------------------------------------
-- statement math
-- ---------------------------------------------------------------------
-- month window [start, end) in the warehouse's time zone
create or replace function public.wms_month_window(p_month date, out p_start timestamptz, out p_end timestamptz)
language sql stable security definer set search_path = public as $$
  select (date_trunc('month', p_month)::timestamp)                       at time zone s.tz,
         (date_trunc('month', p_month)::timestamp + interval '1 month')  at time zone s.tz
  from (select coalesce((select timezone from public.settings where id = 1), 'America/Chicago') as tz) s;
$$;

-- one row per statement line (live calculation)
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
    join public.receipts rc on rc.id = p.receipt_id
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
    where rc.owner_id = p_owner_id
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

-- the statement: frozen copy if the month is closed, live numbers if not
create or replace function public.wms_billing_statement(p_owner_id uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_bp    public.billing_periods;
  v_lines jsonb;
  v_code  text;
begin
  if public.wms_role_rank() < 3 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  select code into v_code from public.owners where id = p_owner_id;
  if v_code is null then raise exception 'Account not found.'; end if;

  select * into v_bp from public.billing_periods where owner_id = p_owner_id and period_month = v_month;
  if found then
    return jsonb_build_object('status', 'closed', 'statement_no', v_bp.statement_no, 'month', v_month,
      'closed_at', v_bp.closed_at, 'closed_by', (select full_name from public.app_users where id = v_bp.closed_by),
      'lines', v_bp.lines, 'total', v_bp.total);
  end if;

  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_lines from public.wms_billing_compute(p_owner_id, v_month) c;
  return jsonb_build_object('status', 'open', 'statement_no', upper(v_code) || '-' || to_char(v_month, 'YYYY-MM'),
    'month', v_month, 'lines', v_lines,
    'total', coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(v_lines) x), 0),
    'month_ended', v_month < date_trunc('month', public.wms_local_today())::date);
end $$;

-- every account's total for a month (Billing home)
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
         coalesce(bp.total, (select sum(c.amount) from public.wms_billing_compute(o.id, v_month) c), 0),
         coalesce(jsonb_array_length(bp.lines), (select count(*)::int from public.wms_billing_compute(o.id, v_month)))
  from public.owners o
  left join public.billing_periods bp on bp.owner_id = o.id and bp.period_month = v_month
  where o.active or bp.id is not null;
end $$;

-- pallet-level backup for a statement (CSV)
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
  join public.receipts rc on rc.id = p.receipt_id
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

-- close a finished month: freezes the statement and locks its charges
create or replace function public.wms_close_billing_period(p_owner_id uuid, p_month date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_st    jsonb;
begin
  if public.wms_role_rank() < 3 or public.wms_is_lift() then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  if v_month >= date_trunc('month', public.wms_local_today())::date then
    raise exception 'A month can be closed once it is over.';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_owner_id::text || v_month::text));
  if exists (select 1 from public.billing_periods where owner_id = p_owner_id and period_month = v_month) then
    raise exception 'That month is already closed.';
  end if;
  v_st := public.wms_billing_statement(p_owner_id, v_month);
  insert into public.billing_periods (owner_id, period_month, statement_no, lines, total)
  values (p_owner_id, v_month, v_st->>'statement_no', v_st->'lines', (v_st->>'total')::numeric);
  return public.wms_billing_statement(p_owner_id, v_month);
end $$;

-- admin: reopen a closed month (the next close recalculates it)
create or replace function public.wms_reopen_billing_period(p_owner_id uuid, p_month date)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.wms_require(4);
  delete from public.billing_periods where owner_id = p_owner_id and period_month = date_trunc('month', p_month)::date;
  if not found then raise exception 'That month is not closed.'; end if;
end $$;

-- ---------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------
revoke execute on function public.trg_manual_charge_guard(), public.wms_month_window(date),
  public.wms_billing_compute(uuid, date) from anon, public, authenticated;
revoke execute on function public.wms_local_today(), public.wms_billing_statement(uuid, date),
  public.wms_billing_summary(date), public.wms_billing_detail(uuid, date),
  public.wms_close_billing_period(uuid, date), public.wms_reopen_billing_period(uuid, date) from anon, public;
grant execute on function public.wms_local_today(), public.wms_billing_statement(uuid, date),
  public.wms_billing_summary(date), public.wms_billing_detail(uuid, date),
  public.wms_close_billing_period(uuid, date), public.wms_reopen_billing_period(uuid, date) to authenticated;

commit;
