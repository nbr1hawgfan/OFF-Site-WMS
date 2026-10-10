-- =====================================================================
--  Customer Lite WMS  —  Migration 017: load photos, cycle counts, bay map
--
--  Load photos
--   * Phone photos (damage, seal, loaded trailer, product) attached to a
--     receipt or shipment. Files live in the private storage bucket
--     'load-photos' at <account id>/<r|s>/<receipt or shipment id>/<file>.
--   * Staff see all; customer logins see their own accounts' photos.
--     Dock, office and up can add; managers (or the person who took it,
--     within an hour) can remove.
--
--  Cycle counts
--   * A manager starts a count for some bays (optionally one account).
--     The dock scans every pallet it finds bay by bay, then a manager
--     reviews: match / missing / in a different bay / qty differs / unknown
--     label, and approves the fixes (moves and adjustments are posted with
--     the count number as the reason).
--
--  Bay map
--   * Optional pallet capacity per location (and a default per warehouse) so the
--     map can show how full each bay is.
-- =====================================================================
begin;

-- ---------- bay capacity ----------
alter table public.locations add column if not exists capacity int check (capacity is null or capacity > 0);
alter table public.warehouses add column if not exists default_capacity int check (default_capacity is null or default_capacity > 0);

-- ---------- load photos ----------
create table public.load_photos (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.owners(id),
  receipt_id  uuid references public.receipts(id),
  shipment_id uuid references public.shipments(id),
  path        text not null unique,
  kind        text not null default 'other' check (kind in ('damage','seal','loaded','product','other')),
  caption     text check (caption is null or length(caption) <= 200),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  check (num_nonnulls(receipt_id, shipment_id) = 1)
);
create index ix_photos_receipt  on public.load_photos (receipt_id)  where receipt_id is not null;
create index ix_photos_shipment on public.load_photos (shipment_id) where shipment_id is not null;

-- the account always comes from the load, never from the client
create or replace function public.trg_photo_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.owner_id := coalesce((select owner_id from public.receipts where id = new.receipt_id),
                           (select owner_id from public.shipments where id = new.shipment_id));
  if new.owner_id is null then raise exception 'Receipt or shipment not found.'; end if;
  if split_part(new.path, '/', 1) <> new.owner_id::text then
    raise exception 'Photo path does not match the load''s account.';
  end if;
  new.created_by := auth.uid();
  new.created_at := now();
  return new;
end $$;
revoke execute on function public.trg_photo_owner() from anon, public, authenticated;
create trigger trg_load_photos_owner before insert on public.load_photos
  for each row execute function public.trg_photo_owner();

alter table public.load_photos enable row level security;
create policy photos_read on public.load_photos for select to authenticated
  using (public.wms_role_rank() >= 1 or owner_id in (select unnest(public.wms_customer_owners())));
create policy photos_ins on public.load_photos for insert to authenticated
  with check (public.wms_role_rank() >= 2);
create policy photos_upd on public.load_photos for update to authenticated
  using (public.wms_role_rank() >= 2) with check (public.wms_role_rank() >= 2);
create policy photos_del on public.load_photos for delete to authenticated
  using (public.wms_role_rank() >= 3 or (created_by = auth.uid() and created_at > now() - interval '1 hour'));
grant select, insert, delete on public.load_photos to authenticated;
grant update (caption, kind) on public.load_photos to authenticated;

-- private bucket, 5 MB per photo (the app shrinks photos to ~300 KB first)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('load-photos', 'load-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy load_photos_obj_read on storage.objects for select to authenticated
  using (bucket_id = 'load-photos' and (public.wms_role_rank() >= 1
         or (storage.foldername(name))[1] in (select unnest(public.wms_customer_owners())::text)));
create policy load_photos_obj_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'load-photos' and public.wms_role_rank() >= 2);
create policy load_photos_obj_del on storage.objects for delete to authenticated
  using (bucket_id = 'load-photos' and (public.wms_role_rank() >= 3 or owner = auth.uid()));

-- ---------- cycle counts ----------
create sequence public.count_no_seq start 1001;

create table public.count_sessions (
  id           uuid primary key default gen_random_uuid(),
  count_no     text not null unique default ('CC-' || nextval('public.count_no_seq')),
  warehouse_id uuid not null references public.warehouses(id),
  owner_id     uuid references public.owners(id),
  status       text not null default 'open' check (status in ('open','closed','void')),
  blind        boolean not null default true,
  notes        text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  closed_by    uuid,
  closed_at    timestamptz,
  result       jsonb
);
create table public.count_bays (
  session_id  uuid not null references public.count_sessions(id) on delete cascade,
  location_id uuid not null references public.locations(id),
  done_by     uuid,
  done_at     timestamptz,
  primary key (session_id, location_id)
);
create table public.count_scans (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.count_sessions(id) on delete cascade,
  location_id uuid not null references public.locations(id),
  pallet_id   uuid references public.pallets(id),
  code        text not null,
  qty         numeric(12,2),
  scanned_by  uuid default auth.uid(),
  scanned_at  timestamptz not null default now()
);
create unique index ux_count_scan_pallet on public.count_scans (session_id, pallet_id) where pallet_id is not null;
create unique index ux_count_scan_code   on public.count_scans (session_id, location_id, upper(code)) where pallet_id is null;

alter table public.count_sessions enable row level security;
alter table public.count_bays     enable row level security;
alter table public.count_scans    enable row level security;
create policy cs_read on public.count_sessions for select to authenticated using (public.wms_role_rank() >= 1);
create policy cb_read on public.count_bays     for select to authenticated using (public.wms_role_rank() >= 1);
create policy cx_read on public.count_scans    for select to authenticated using (public.wms_role_rank() >= 1);
grant select on public.count_sessions, public.count_bays, public.count_scans to authenticated;

-- start a count (manager): the bays to count, optionally one account
create or replace function public.wms_count_create(p_warehouse_id uuid, p_location_ids uuid[], p_owner_id uuid default null,
                                                   p_blind boolean default true, p_notes text default null)
returns public.count_sessions language plpgsql security definer set search_path = public as $$
declare v public.count_sessions; n int;
begin
  perform public.wms_require(3);
  if public.wms_is_lift() then raise exception 'You do not have permission to do this.' using errcode = '42501'; end if;
  select count(*) into n from public.locations where id = any (p_location_ids) and warehouse_id = p_warehouse_id;
  if n = 0 then raise exception 'Pick at least one location in this warehouse.'; end if;
  if exists (select 1 from public.count_bays b join public.count_sessions s on s.id = b.session_id
             where s.status = 'open' and b.location_id = any (p_location_ids)) then
    raise exception 'Some of those locations are already in an open count. Finish or void it first.';
  end if;
  insert into public.count_sessions (warehouse_id, owner_id, blind, notes)
  values (p_warehouse_id, p_owner_id, coalesce(p_blind, true), nullif(trim(p_notes), ''))
  returning * into v;
  insert into public.count_bays (session_id, location_id)
  select v.id, id from public.locations where id = any (p_location_ids) and warehouse_id = p_warehouse_id;
  return v;
end $$;

-- scan a pallet found in a bay (dock and up). Scanning a pallet again moves its count to the new bay.
create or replace function public.wms_count_scan(p_session_id uuid, p_location_id uuid, p_code text, p_qty numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.count_sessions; p public.pallets; v_code text := upper(nullif(trim(p_code), '')); v_qty numeric; i public.items; l text;
begin
  perform public.wms_require(2);
  select * into s from public.count_sessions where id = p_session_id;
  if not found or s.status <> 'open' then raise exception 'This count is not open.'; end if;
  if not exists (select 1 from public.count_bays where session_id = p_session_id and location_id = p_location_id) then
    raise exception 'That location is not part of count %.', s.count_no;
  end if;
  if v_code is null then raise exception 'Scan a pallet label.'; end if;
  if p_qty is not null and p_qty < 0 then raise exception 'Quantity cannot be negative.'; end if;

  select * into p from public.pallets x
  where v_code in (upper(x.lp_id), upper(x.customer_pallet_id), upper(x.ref1), upper(x.ref2), upper(x.ref3),
                   upper(x.ref4), upper(x.ref5), upper(x.ref6), upper(x.ref7), upper(x.origin_ref))
  order by (x.status in ('on_hand', 'hold')) desc, x.created_at desc limit 1;

  if not found then
    insert into public.count_scans (session_id, location_id, code, qty)
    values (p_session_id, p_location_id, v_code, p_qty)
    on conflict (session_id, location_id, upper(code)) where pallet_id is null do update set qty = excluded.qty, scanned_at = now();
    return jsonb_build_object('result', 'unknown', 'code', v_code);
  end if;

  select * into i from public.items where id = p.item_id;
  select code into l from public.locations where id = p.location_id;
  v_qty := coalesce(p_qty, p.qty_on_hand);
  insert into public.count_scans (session_id, location_id, pallet_id, code, qty)
  values (p_session_id, p_location_id, p.id, v_code, v_qty)
  on conflict (session_id, pallet_id) where pallet_id is not null
  do update set location_id = excluded.location_id, qty = excluded.qty, code = excluded.code, scanned_at = now(), scanned_by = auth.uid();
  return jsonb_build_object('result', case when p.status not in ('on_hand', 'hold') then 'not_in_stock'
                                           when p.location_id = p_location_id then 'here' else 'other_bay' end,
    'lp_id', p.lp_id, 'sku', i.sku, 'lot', p.lot_number, 'qty', v_qty, 'system_qty', p.qty_on_hand, 'uom', i.uom,
    'system_location', l, 'status', p.status);
end $$;

create or replace function public.wms_count_unscan(p_scan_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.wms_require(2);
  delete from public.count_scans c using public.count_sessions s
   where c.id = p_scan_id and s.id = c.session_id and s.status = 'open';
end $$;

create or replace function public.wms_count_bay_done(p_session_id uuid, p_location_id uuid, p_done boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.wms_require(2);
  update public.count_bays b set done_at = case when p_done then now() end, done_by = case when p_done then auth.uid() end
  from public.count_sessions s
  where b.session_id = p_session_id and b.location_id = p_location_id and s.id = b.session_id and s.status = 'open';
end $$;

-- review: system (right now) vs what was scanned
create or replace function public.wms_count_review(p_session_id uuid)
returns table (result text, pallet_id uuid, lp_id text, code text, sku text, description text, lot_number text, uom text,
               system_location_id uuid, system_location text, system_qty numeric,
               counted_location_id uuid, counted_location text, counted_qty numeric, bay_done boolean, owner_code text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare s public.count_sessions;
begin
  if public.wms_role_rank() < 1 then raise exception 'You do not have permission to do this.' using errcode = '42501'; end if;
  select * into s from public.count_sessions where id = p_session_id;
  if not found then raise exception 'Count not found.'; end if;
  return query
  with bays as (select b.location_id, b.done_at is not null as done from public.count_bays b where b.session_id = p_session_id),
  expected as (
    select p.* from public.pallets p join public.items i on i.id = p.item_id
    where p.location_id in (select location_id from bays) and p.status in ('on_hand', 'hold') and p.qty_on_hand > 0
      and (s.owner_id is null or i.owner_id = s.owner_id)
  ),
  scans as (select * from public.count_scans c where c.session_id = p_session_id),
  joined as (
    select coalesce(e.id, sc.pallet_id) as pid, sc.code as scode, sc.location_id as cloc, sc.qty as cqty,
           sc.pallet_id is null and sc.id is not null as unknown
    from expected e full join scans sc on sc.pallet_id = e.id
  )
  select case
           when j.unknown then 'unknown'
           when j.cloc is null then 'missing'
           when p.status not in ('on_hand', 'hold') or p.qty_on_hand <= 0 then 'not_in_stock'
           when j.cloc <> p.location_id and j.cqty <> p.qty_on_hand then 'moved_qty'
           when j.cloc <> p.location_id then 'moved'
           when j.cqty <> p.qty_on_hand then 'qty'
           else 'match' end,
         p.id, p.lp_id, j.scode, i.sku, i.description, p.lot_number, i.uom,
         p.location_id, ls.code, p.qty_on_hand,
         j.cloc, lc.code, j.cqty,
         coalesce((select done from bays where location_id = coalesce(j.cloc, p.location_id)), false),
         o.code
  from joined j
  left join public.pallets p   on p.id = j.pid
  left join public.items i     on i.id = p.item_id
  left join public.owners o    on o.id = i.owner_id
  left join public.locations ls on ls.id = p.location_id
  left join public.locations lc on lc.id = j.cloc
  order by coalesce(lc.code, ls.code), p.lp_id, j.scode;
end $$;

-- approve (manager): post the chosen fixes, then close the count
--   p_actions: [{ "pallet_id": "...", "action": "move" | "adjust" | "zero", "to_location_id": "...", "qty": 12 }]
create or replace function public.wms_count_apply(p_session_id uuid, p_actions jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.count_sessions; a jsonb; p public.pallets; v_reason text; n_move int := 0; n_adj int := 0; v_to uuid; v_lines jsonb;
begin
  perform public.wms_require(3);
  if public.wms_is_lift() then raise exception 'You do not have permission to do this.' using errcode = '42501'; end if;
  select * into s from public.count_sessions where id = p_session_id for update;
  if not found or s.status <> 'open' then raise exception 'This count is not open.'; end if;
  v_reason := 'Cycle count ' || s.count_no;
  -- keep the review as it stood when approved (the record of what was found)
  select jsonb_agg(to_jsonb(r)) into v_lines from public.wms_count_review(p_session_id) r;

  for a in select * from jsonb_array_elements(coalesce(p_actions, '[]'::jsonb)) loop
    select * into p from public.pallets where id = (a->>'pallet_id')::uuid for update;
    if not found or p.status not in ('on_hand', 'hold') then continue; end if;
    if a->>'action' in ('move', 'move_adjust') then
      v_to := (a->>'to_location_id')::uuid;
      if v_to is not null and v_to <> p.location_id then
        if not exists (select 1 from public.locations where id = v_to and active) then raise exception 'Location not found.'; end if;
        insert into public.inventory_transactions (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, to_location_id, reason)
        values ('MOVE', p.id, p.item_id, p.lot_number, 0, p.location_id, v_to, v_reason);
        n_move := n_move + 1;
      end if;
    end if;
    if a->>'action' in ('adjust', 'move_adjust', 'zero') then
      perform public.wms_adjust_pallet(p.id, case when a->>'action' = 'zero' then 0 else (a->>'qty')::numeric end, v_reason);
      n_adj := n_adj + 1;
    end if;
  end loop;

  update public.count_sessions
     set status = 'closed', closed_by = auth.uid(), closed_at = now(),
         result = jsonb_build_object('moves', n_move, 'adjustments', n_adj,
                                     'lines', coalesce(v_lines, '[]'::jsonb), 'approved', p_actions)
   where id = p_session_id;
  return jsonb_build_object('moves', n_move, 'adjustments', n_adj);
end $$;

create or replace function public.wms_count_void(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.wms_require(3);
  update public.count_sessions set status = 'void', closed_by = auth.uid(), closed_at = now()
   where id = p_session_id and status = 'open';
end $$;

revoke execute on function public.wms_count_create(uuid, uuid[], uuid, boolean, text), public.wms_count_scan(uuid, uuid, text, numeric),
  public.wms_count_unscan(bigint), public.wms_count_bay_done(uuid, uuid, boolean), public.wms_count_review(uuid),
  public.wms_count_apply(uuid, jsonb), public.wms_count_void(uuid) from anon, public;
grant execute on function public.wms_count_create(uuid, uuid[], uuid, boolean, text), public.wms_count_scan(uuid, uuid, text, numeric),
  public.wms_count_unscan(bigint), public.wms_count_bay_done(uuid, uuid, boolean), public.wms_count_review(uuid),
  public.wms_count_apply(uuid, jsonb), public.wms_count_void(uuid) to authenticated;

commit;
