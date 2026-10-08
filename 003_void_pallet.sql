-- =====================================================================
--  Customer Lite WMS  —  Migration 003: void a single pallet
--  For receiving mistakes (wrong item / lot / qty). Posts a VOID_RECEIVE
--  ledger row, so the history keeps both the original and the void.
--   * Operators: only while the pallet's receipt is still open.
--   * Managers+: any time, as long as the pallet never shipped and is
--     not on an open shipment.
-- =====================================================================
begin;

create or replace function public.wms_void_pallet(p_pallet_id uuid, p_reason text)
returns public.pallets
language plpgsql security definer set search_path = public as $$
declare
  v        public.pallets;
  v_rstat  text;
begin
  perform public.wms_require(2);
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required to void a pallet.'; end if;

  select * into v from public.pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found.'; end if;
  if v.status = 'void' then raise exception 'Pallet % is already void.', v.lp_id; end if;

  select status into v_rstat from public.receipts where id = v.receipt_id;
  if public.wms_role_rank() < 3 and coalesce(v_rstat, '') <> 'open' then
    raise exception 'Receipt is closed. Ask a manager to void pallet %.', v.lp_id;
  end if;

  if exists (select 1 from public.inventory_transactions
             where pallet_id = p_pallet_id and txn_type = 'SHIP') then
    raise exception 'Pallet % has shipped and cannot be voided.', v.lp_id;
  end if;
  if exists (select 1 from public.shipment_lines sl
             join public.shipments s on s.id = sl.shipment_id and s.status = 'open'
             where sl.pallet_id = p_pallet_id) then
    raise exception 'Pallet % is on an open shipment; remove it first.', v.lp_id;
  end if;

  insert into public.inventory_transactions
    (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, receipt_id, reason)
  values ('VOID_RECEIVE', v.id, v.item_id, v.lot_number, -v.qty_on_hand, v.location_id,
          v.receipt_id, p_reason);

  select * into v from public.pallets where id = p_pallet_id;
  return v;
end $$;

revoke execute on function public.wms_void_pallet(uuid, text) from anon, public;
grant  execute on function public.wms_void_pallet(uuid, text) to authenticated;

commit;
