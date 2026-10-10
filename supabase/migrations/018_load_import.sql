-- =====================================================================
--  Customer Lite WMS  —  Migration 018: load import (expected lines + templates)
--   * receipt_lines: what an inbound load is expected to carry (item, lot,
--     pallets, qty, and an identifier such as One Source's PGID). Imported
--     from the customer's schedule sheet; the receiving screens use them to
--     pre-fill the receive form so the dock only scans pallet labels.
--   * import_templates: saved column mappings per account and direction, so
--     tomorrow's sheet imports with one click.
--   Outbound imports reuse shipment_order_lines (already there).
-- =====================================================================
begin;

create table public.receipt_lines (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references public.receipts(id) on delete cascade,
  item_id     uuid not null references public.items(id),
  lot_number  text,
  pallets     int check (pallets is null or pallets > 0),
  qty         numeric(12,2) check (qty is null or qty > 0),
  ref_field   text check (ref_field is null or ref_field in ('customer_pallet_id','ref1','ref2','ref3','ref4','ref5','ref6','ref7')),
  ref_value   text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index ix_receipt_lines_receipt on public.receipt_lines (receipt_id);

-- the line's item must belong to the receipt's account; lot upper-cased like pallets
create or replace function public.trg_receipt_line_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.receipts r join public.items i on i.owner_id = r.owner_id
                 where r.id = new.receipt_id and i.id = new.item_id) then
    raise exception 'That item belongs to a different account than the receipt.';
  end if;
  new.lot_number := upper(nullif(trim(new.lot_number), ''));
  new.ref_value  := upper(nullif(trim(new.ref_value), ''));
  return new;
end $$;
revoke execute on function public.trg_receipt_line_check() from anon, public, authenticated;
create trigger trg_receipt_lines_check before insert or update on public.receipt_lines
  for each row execute function public.trg_receipt_line_check();

alter table public.receipt_lines enable row level security;
create policy rl_read on public.receipt_lines for select to authenticated
  using (public.wms_role_rank() >= 1
         or receipt_id in (select r.id from public.receipts r where r.owner_id in (select unnest(public.wms_customer_owners()))));
create policy rl_write on public.receipt_lines for all to authenticated
  using (public.wms_is_office() and exists (select 1 from public.receipts r where r.id = receipt_lines.receipt_id and r.status = 'open'))
  with check (public.wms_is_office() and exists (select 1 from public.receipts r where r.id = receipt_lines.receipt_id and r.status = 'open'));
grant select, insert, update, delete on public.receipt_lines to authenticated;

create table public.import_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  direction   text not null check (direction in ('inbound','outbound')),
  owner_id    uuid references public.owners(id),
  mapping     jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object'),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  unique (direction, name)
);
alter table public.import_templates enable row level security;
create policy it_read  on public.import_templates for select to authenticated using (public.wms_is_office());
create policy it_write on public.import_templates for all to authenticated
  using (public.wms_is_office()) with check (public.wms_is_office());
grant select, insert, update, delete on public.import_templates to authenticated;

commit;
