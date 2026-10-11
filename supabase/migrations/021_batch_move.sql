-- =====================================================================
--  Customer Lite WMS  —  Migration 021: batch moves
--   * wms_move_pallets(ids[], to, reason): move any number of pallets to one
--     location in a single call. Each move is a MOVE transaction carrying
--     the reason (e.g. 'Batch move', 'Load RCV-1001 moved'), so pallet
--     history shows why it moved. Pallets that can't move (shipped, void,
--     on an open load going to another warehouse) are skipped and reported;
--     the rest still move.
--   The dock's Batch Move (scan a bay once, then pallet after pallet) and
--   Move Whole Load (by receipt #, inbound BOL or PO) both use it.
-- =====================================================================
begin;

create or replace function public.wms_move_pallets(p_pallet_ids uuid[], p_to_location_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p        public.pallets;
  v_to     uuid;
  v_from   uuid;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  n_moved  int := 0;
  n_here   int := 0;
  v_skip   jsonb := '[]'::jsonb;
begin
  perform public.wms_require(2);
  if coalesce(array_length(p_pallet_ids, 1), 0) = 0 then raise exception 'No pallets to move.'; end if;
  if array_length(p_pallet_ids, 1) > 2000 then raise exception 'Move at most 2000 pallets at a time.'; end if;
  select warehouse_id into v_to from public.locations where id = p_to_location_id and active;
  if v_to is null then raise exception 'Location not found or inactive.'; end if;
  v_reason := left(coalesce(v_reason, 'Batch move'), 200);

  for p in select * from public.pallets where id = any(p_pallet_ids) order by lp_id for update loop
    if p.status not in ('on_hand', 'hold') or p.qty_on_hand <= 0 then
      v_skip := v_skip || jsonb_build_object('lp_id', p.lp_id, 'why', 'not in stock (' || p.status || ')');
      continue;
    end if;
    if p.location_id = p_to_location_id then n_here := n_here + 1; continue; end if;
    select warehouse_id into v_from from public.locations where id = p.location_id;
    if v_from is distinct from v_to and exists (
         select 1 from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id
          where sl.pallet_id = p.id and s.status = 'open') then
      v_skip := v_skip || jsonb_build_object('lp_id', p.lp_id, 'why', 'on an open load; can''t leave the warehouse');
      continue;
    end if;
    insert into public.inventory_transactions
      (txn_type, pallet_id, item_id, lot_number, qty_change, from_location_id, to_location_id, reason)
    values ('MOVE', p.id, p.item_id, p.lot_number, 0, p.location_id, p_to_location_id, v_reason);
    n_moved := n_moved + 1;
  end loop;

  return jsonb_build_object('moved', n_moved, 'already_there', n_here, 'skipped', v_skip,
                            'not_found', coalesce(array_length(p_pallet_ids, 1), 0)
                                         - (select count(*) from public.pallets where id = any(p_pallet_ids)));
end $$;

revoke execute on function public.wms_move_pallets(uuid[], uuid, text) from anon, public;
grant  execute on function public.wms_move_pallets(uuid[], uuid, text) to authenticated;

commit;
