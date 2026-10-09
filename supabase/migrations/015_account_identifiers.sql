-- =====================================================================
--  Customer Lite WMS  —  Migration 015: identifiers per account
--   An account can have its own identifier setup (names, required,
--   unique, barcode) instead of the company one. Lookup order:
--     the account's own  ->  its bill-to master's  ->  Setup > Company
--   owners.id_rules holds the same keys as settings
--   (cust_pallet_label, cust_pallet_required, cust_pallet_barcode,
--    ref1_label, ref1_required, ref1_unique, ref1_barcode, ... ref7_*).
--   NULL = use the company setup.
--   "Unique" identifiers are now checked within the account.
-- =====================================================================
begin;

alter table public.owners add column if not exists id_rules jsonb
  check (id_rules is null or jsonb_typeof(id_rules) = 'object');

-- effective identifier rules for an account (settings-shaped jsonb)
create or replace function public.wms_id_rules(p_owner uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(o.id_rules, m.id_rules, to_jsonb(s))
  from public.settings s
  left join public.owners o on o.id = p_owner
  left join public.owners m on m.id = o.bill_to_id
  where s.id = 1;
$$;
revoke execute on function public.wms_id_rules(uuid) from anon, public;
grant execute on function public.wms_id_rules(uuid) to authenticated;

-- receive: same signature as 014; identifier rules come from the account
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
  p_ref2                text    default null,
  p_ref3 text default null, p_ref4 text default null, p_ref5 text default null, p_ref6 text default null, p_ref7 text default null,
  p_origin_ref          text    default null
) returns public.pallets
language plpgsql security definer set search_path = public as $$
declare
  v_set      public.settings;
  v_rules    jsonb;
  v_receipt  public.receipts;
  v_item     public.items;
  v_loc      uuid;
  v_lot      text;
  v_cust     text;
  v_cust_lbl text;
  v_pallet   public.pallets;
  v_refs     text[];
  v_lbl      text; v_dup boolean;
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

  v_rules    := public.wms_id_rules(v_receipt.owner_id);
  v_cust_lbl := coalesce(nullif(trim(v_rules->>'cust_pallet_label'), ''), v_set.cust_pallet_label, 'Customer Pallet ID');

  v_lot  := upper(nullif(trim(p_lot_number), ''));
  v_cust := upper(nullif(trim(p_customer_pallet_id), ''));

  if v_item.lot_required and v_lot is null then
    raise exception '% is required for %.', v_set.lot_label, v_item.sku;
  end if;
  if coalesce((v_rules->>'cust_pallet_required')::boolean, false) and v_cust is null then
    raise exception '% is required.', v_cust_lbl;
  end if;
  if v_cust is not null and exists (
       select 1 from public.pallets where upper(customer_pallet_id) = v_cust) then
    raise exception '% % is already in use.', v_cust_lbl, v_cust;
  end if;
  if v_cust is not null and exists (
       select 1 from public.pallets where upper(lp_id) = v_cust) then
    raise exception '% % matches one of our pallet IDs; use a different ID.', v_cust_lbl, v_cust;
  end if;

  -- identifiers 2-8 (ref1..ref7): only kept when named for this account
  v_refs := array[p_ref1, p_ref2, p_ref3, p_ref4, p_ref5, p_ref6, p_ref7];
  for k in 1..7 loop
    v_lbl := nullif(trim(v_rules->>('ref' || k || '_label')), '');
    if v_lbl is null then v_refs[k] := null; continue; end if;
    v_refs[k] := upper(nullif(trim(v_refs[k]), ''));
    if coalesce((v_rules->>('ref' || k || '_required'))::boolean, false) and v_refs[k] is null then
      raise exception '% is required.', v_lbl;
    end if;
    if v_refs[k] is not null and coalesce((v_rules->>('ref' || k || '_unique'))::boolean, false) then
      execute format('select exists (select 1 from public.pallets p join public.items i on i.id = p.item_id
                       where upper(p.ref%s) = $1 and p.status <> ''void'' and i.owner_id = $2)', k)
        into v_dup using v_refs[k], v_receipt.owner_id;
      if v_dup then raise exception '% % is already in use.', v_lbl, v_refs[k]; end if;
    end if;
  end loop;

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
                              receipt_id, notes, ref1, ref2, ref3, ref4, ref5, ref6, ref7, origin_ref)
  values (v_cust, p_item_id, v_lot, p_production_date, p_expiration_date, p_qty, 0,
          v_loc, p_receipt_id, p_notes, v_refs[1], v_refs[2], v_refs[3], v_refs[4], v_refs[5], v_refs[6], v_refs[7],
          nullif(trim(p_origin_ref), ''))
  returning * into v_pallet;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, to_location_id, receipt_id)
  values ('RECEIVE', v_pallet.id, p_item_id, v_pallet.lot_number, p_qty, v_loc, p_receipt_id);

  update public.receipts set unloaded_at = null, unloaded_by = null
   where id = p_receipt_id and unloaded_at is not null;

  select * into v_pallet from public.pallets where id = v_pallet.id;
  return v_pallet;
end $$;

commit;
