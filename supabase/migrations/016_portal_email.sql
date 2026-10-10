-- =====================================================================
--  Customer Lite WMS  —  Migration 016: customer portal + automatic emails
--
--  Customer portal
--   * New login role 'customer', tied to one account (app_users.owner_id).
--     A bill-to master's login also sees its sub-accounts.
--   * Customers can only READ their own accounts' items, pallets, history,
--     receipts and shipments. Every staff policy needs rank >= 1 and a
--     customer's rank is 0, so none of the staff policies apply to them; the
--     *_cust policies below are the only way in. No write access at all.
--   * Lot trace and inventory-as-of work for customers, limited to their accounts.
--
--  Automatic emails (sent by a Google Apps Script with the secret key)
--   * Per account: email_to (comma list) and switches for BOL on ship,
--     receipt on close, and a daily inventory email.
--   * email_outbox is the queue: triggers add a row when a load ships or a
--     receipt closes; the script sends queued rows and marks them sent.
-- =====================================================================
begin;

-- ---------- customer role ----------
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check
  check (role in ('admin','manager','operator','lift','viewer','customer'));
alter table public.app_users add column if not exists owner_id uuid references public.owners(id);
alter table public.app_users add constraint app_users_customer_owner
  check (role <> 'customer' or owner_id is not null);

create or replace function public.wms_is_customer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where id = auth.uid() and active and role = 'customer');
$$;

-- the accounts a customer login may see: its own, plus its subs when it is a bill-to master
create or replace function public.wms_customer_owners()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(o.id), '{}'::uuid[])
  from public.app_users u
  join public.owners o on o.id = u.owner_id or o.bill_to_id = u.owner_id
  where u.id = auth.uid() and u.active and u.role = 'customer';
$$;

revoke execute on function public.wms_is_customer(), public.wms_customer_owners() from anon, public;
grant execute on function public.wms_is_customer(), public.wms_customer_owners() to authenticated;

-- read-only policies for customer logins
create policy settings_cust   on public.settings   for select to authenticated using (public.wms_is_customer());
create policy warehouses_cust on public.warehouses for select to authenticated using (public.wms_is_customer());
create policy locations_cust  on public.locations  for select to authenticated using (public.wms_is_customer());
create policy owners_cust     on public.owners     for select to authenticated
  using (id in (select unnest(public.wms_customer_owners())));
create policy items_cust      on public.items      for select to authenticated
  using (owner_id in (select unnest(public.wms_customer_owners())));
create policy pallets_cust    on public.pallets    for select to authenticated
  using (item_id in (select i.id from public.items i where i.owner_id in (select unnest(public.wms_customer_owners()))));
create policy txn_cust        on public.inventory_transactions for select to authenticated
  using (item_id in (select i.id from public.items i where i.owner_id in (select unnest(public.wms_customer_owners()))));
create policy receipts_cust   on public.receipts   for select to authenticated
  using (owner_id in (select unnest(public.wms_customer_owners())));
create policy shipments_cust  on public.shipments  for select to authenticated
  using (owner_id in (select unnest(public.wms_customer_owners())));
create policy slines_cust     on public.shipment_lines for select to authenticated
  using (shipment_id in (select s.id from public.shipments s where s.owner_id in (select unnest(public.wms_customer_owners()))));
create policy sol_cust        on public.shipment_order_lines for select to authenticated
  using (shipment_id in (select s.id from public.shipments s where s.owner_id in (select unnest(public.wms_customer_owners()))));

-- lot trace / inventory as of: staff as before, customers limited to their accounts
create or replace function public.wms_inventory_as_of(p_date date, p_warehouse_id uuid default null)
returns table (lp_id text, customer_pallet_id text, ref1 text, ref2 text, sku text, description text,
               lot_number text, qty numeric, uom text, owner_code text, warehouse_code text, location text,
               received_at timestamptz, receipt_no text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_cut  timestamptz;
  v_cust boolean := public.wms_is_customer();
  v_mine uuid[]  := public.wms_customer_owners();
begin
  if (public.wms_role_rank() < 1 or public.wms_is_lift()) and not v_cust then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
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
  where (p_warehouse_id is null or l.warehouse_id = p_warehouse_id)
    and (not v_cust or i.owner_id = any (v_mine))
  order by w.code, o.code, i.sku, p.lot_number, p.lp_id;
end $$;

create or replace function public.wms_lot_trace(p_lot text, p_sku text default null)
returns table (event text, event_at timestamptz, lp_id text, customer_pallet_id text, sku text, description text,
               lot_number text, qty numeric, uom text, owner_code text, warehouse_code text,
               doc_no text, party text, party_city text, location_now text, status_now text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_lot  text := upper(nullif(trim(p_lot), ''));
  v_sku  text := upper(nullif(trim(p_sku), ''));
  v_cust boolean := public.wms_is_customer();
  v_mine uuid[]  := public.wms_customer_owners();
begin
  if (public.wms_role_rank() < 1 or public.wms_is_lift()) and not v_cust then
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
      and (not v_cust or i.owner_id = any (v_mine))
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

-- ---------- automatic emails ----------
alter table public.owners
  add column if not exists email_to      text,
  add column if not exists email_bol     boolean not null default false,
  add column if not exists email_receipt boolean not null default false,
  add column if not exists email_daily   boolean not null default false;

create table public.email_outbox (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('bol','receipt','daily','test')),
  owner_id    uuid references public.owners(id),
  ref_id      uuid,
  to_addr     text not null,
  subject     text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'queued' check (status in ('queued','sent','error')),
  attempts    int  not null default 0,
  error       text,
  dedupe_key  text unique,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index ix_outbox_queued on public.email_outbox (id) where status = 'queued';
create index ix_outbox_owner  on public.email_outbox (owner_id, id);
alter table public.email_outbox enable row level security;
create policy outbox_read on public.email_outbox for select to authenticated
  using (public.wms_role_rank() >= 3 and not public.wms_is_lift());
grant select on public.email_outbox to authenticated;

-- company block for an email (warehouse address when it has one) + the account's identifier names
create or replace function public.wms_email_company(p_owner uuid, p_wh uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', replace(s.company_name, '_', ' '),
    'phone', coalesce(w.phone, s.phone),
    'address', concat_ws(', ', coalesce(w.address_line1, s.address_line1),
                         nullif(concat_ws(' ', concat_ws(', ', coalesce(w.city, s.city), coalesce(w.state, s.state)), coalesce(w.zip, s.zip)), '')),
    'accent', coalesce(case when s.theme = 'modern' then s.accent_color end, '#C41230'),
    'lot_label', s.lot_label,
    'ids', (select jsonb_agg(x order by x->>'n') from (
             select jsonb_build_object('n', '0', 'field', 'customer_pallet_id',
                    'label', coalesce(nullif(r->>'cust_pallet_label', ''), s.cust_pallet_label, 'Customer Pallet ID')) x
             union all
             select jsonb_build_object('n', k::text, 'field', 'ref' || k, 'label', r->>('ref' || k || '_label'))
             from generate_series(1, 7) k where nullif(r->>('ref' || k || '_label'), '') is not null) q),
    'account', (select jsonb_build_object('code', o.code, 'name', o.name) from public.owners o where o.id = p_owner),
    'warehouse', (select w2.code from public.warehouses w2 where w2.id = p_wh)
  )
  from public.settings s
  cross join lateral (select public.wms_id_rules(p_owner) as r) rr
  left join public.warehouses w on w.id = p_wh
  where s.id = 1;
$$;

-- pallets for an email: identifiers as an object so the script can show the account's names
create or replace function public.wms_email_pallet(p public.pallets, i public.items, p_qty numeric, p_loc text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('lp_id', p.lp_id, 'sku', i.sku, 'description', i.description, 'lot', p.lot_number,
    'qty', p_qty, 'uom', i.uom, 'location', p_loc, 'received', p.created_at,
    'ids', jsonb_strip_nulls(jsonb_build_object('customer_pallet_id', p.customer_pallet_id, 'ref1', p.ref1, 'ref2', p.ref2,
           'ref3', p.ref3, 'ref4', p.ref4, 'ref5', p.ref5, 'ref6', p.ref6, 'ref7', p.ref7)));
$$;

-- build + queue one email. p_force: queue even when the account's switch is off (manual resend / test)
create or replace function public.wms_queue_email(p_kind text, p_ref uuid, p_force boolean default false)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_owner public.owners; v_wh uuid; v_subject text; v_payload jsonb; v_key text; v_id bigint;
  v_ship public.shipments; v_rcpt public.receipts;
begin
  if p_kind = 'bol' then
    select * into v_ship from public.shipments where id = p_ref;
    if not found then raise exception 'Shipment not found.'; end if;
    select * into v_owner from public.owners where id = v_ship.owner_id;
    if not p_force and not v_owner.email_bol then return null; end if;
    v_wh := v_ship.warehouse_id;
    v_subject := format('Shipped: BOL %s to %s', v_ship.shipment_no, coalesce(v_ship.ship_to_name, ''));
    v_payload := jsonb_build_object('doc', to_jsonb(v_ship) - 'void_reason',
      'pallets', coalesce((select jsonb_agg(public.wms_email_pallet(p, i, sl.qty, l.code) order by i.sku, p.lot_number, p.lp_id)
                           from public.shipment_lines sl join public.pallets p on p.id = sl.pallet_id
                           join public.items i on i.id = p.item_id left join public.locations l on l.id = p.location_id
                           where sl.shipment_id = p_ref), '[]'::jsonb));
  elsif p_kind = 'receipt' then
    select * into v_rcpt from public.receipts where id = p_ref;
    if not found then raise exception 'Receipt not found.'; end if;
    select * into v_owner from public.owners where id = v_rcpt.owner_id;
    if not p_force and not v_owner.email_receipt then return null; end if;
    v_wh := v_rcpt.warehouse_id;
    v_subject := format('Received: %s from %s', v_rcpt.receipt_no, coalesce(v_rcpt.vendor_name, 'inbound'));
    v_payload := jsonb_build_object('doc', to_jsonb(v_rcpt) - 'void_reason',
      'pallets', coalesce((select jsonb_agg(public.wms_email_pallet(p, i, p.qty_received, l.code) order by i.sku, p.lot_number, p.lp_id)
                           from public.pallets p join public.items i on i.id = p.item_id left join public.locations l on l.id = p.location_id
                           where p.receipt_id = p_ref and p.status <> 'void'), '[]'::jsonb));
  elsif p_kind in ('daily', 'test') then
    select * into v_owner from public.owners where id = p_ref;
    if not found then raise exception 'Account not found.'; end if;
    if p_kind = 'daily' and not p_force and not v_owner.email_daily then return null; end if;
    v_subject := case when p_kind = 'test' then format('Test email for %s', v_owner.code)
                      else format('Inventory for %s — %s', v_owner.code, to_char(public.wms_local_today(), 'Mon DD, YYYY')) end;
    v_key := case when p_kind = 'daily' then format('daily:%s:%s', v_owner.id, public.wms_local_today()) end;
    v_payload := jsonb_build_object('date', public.wms_local_today(),
      'pallets', case when p_kind = 'test' then '[]'::jsonb else coalesce((
        select jsonb_agg(public.wms_email_pallet(p, i, p.qty_on_hand, l.code) || jsonb_build_object('warehouse', w.code, 'status', p.status)
                         order by w.code, i.sku, p.lot_number, p.lp_id)
        from public.pallets p join public.items i on i.id = p.item_id
        left join public.locations l on l.id = p.location_id left join public.warehouses w on w.id = l.warehouse_id
        where i.owner_id = v_owner.id and p.status in ('on_hand', 'hold') and p.qty_on_hand > 0), '[]'::jsonb) end);
  else
    raise exception 'Unknown email kind %.', p_kind;
  end if;

  if nullif(trim(coalesce(v_owner.email_to, '')), '') is null then
    if p_force then raise exception 'Add an email address to account % first (Setup > Accounts).', v_owner.code; end if;
    return null;
  end if;

  insert into public.email_outbox (kind, owner_id, ref_id, to_addr, subject, payload, dedupe_key)
  values (p_kind, v_owner.id, p_ref, trim(v_owner.email_to), v_subject,
          v_payload || jsonb_build_object('company', public.wms_email_company(v_owner.id, v_wh)), v_key)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.wms_queue_email(text, uuid, boolean), public.wms_email_company(uuid, uuid),
  public.wms_email_pallet(public.pallets, public.items, numeric, text) from anon, public, authenticated;

-- queue automatically: load shipped, receipt closed (with pallets, not opening inventory)
create or replace function public.trg_email_on_ship()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'shipped' and old.status is distinct from 'shipped' then
    perform public.wms_queue_email('bol', new.id);
  end if;
  return new;
end $$;
create or replace function public.trg_email_on_close()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'closed' and old.status = 'open' and not new.is_opening
     and exists (select 1 from public.pallets where receipt_id = new.id and status <> 'void') then
    perform public.wms_queue_email('receipt', new.id);
  end if;
  return new;
end $$;
revoke execute on function public.trg_email_on_ship(), public.trg_email_on_close() from anon, public, authenticated;
create trigger trg_shipments_email after update of status on public.shipments
  for each row execute function public.trg_email_on_ship();
create trigger trg_receipts_email after update of status on public.receipts
  for each row execute function public.trg_email_on_close();

-- from the app: resend a BOL / receipt (office), send a test (manager)
create or replace function public.wms_email_document(p_kind text, p_ref uuid)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not public.wms_is_office() then raise exception 'You do not have permission to do this.' using errcode = '42501'; end if;
  if p_kind not in ('bol', 'receipt') then raise exception 'Unknown document.'; end if;
  return public.wms_queue_email(p_kind, p_ref, true);
end $$;
create or replace function public.wms_email_test(p_owner uuid)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  perform public.wms_require(3);
  return public.wms_queue_email('test', p_owner, true);
end $$;
-- daily inventory: run by the email script each morning (secret key), or by a manager
create or replace function public.wms_queue_daily_inventory()
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; o record;
begin
  if auth.uid() is not null then perform public.wms_require(3); end if;
  for o in select id from public.owners where active and email_daily and nullif(trim(coalesce(email_to, '')), '') is not null loop
    if public.wms_queue_email('daily', o.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke execute on function public.wms_email_document(text, uuid), public.wms_email_test(uuid), public.wms_queue_daily_inventory() from anon, public;
grant execute on function public.wms_email_document(text, uuid), public.wms_email_test(uuid), public.wms_queue_daily_inventory() to authenticated, service_role;

commit;
