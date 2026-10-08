-- =====================================================================
--  Customer Lite WMS  —  Migration 002: security hardening
--  From Supabase security advisor review after 001.
-- =====================================================================
begin;

-- Pin search_path on trigger helpers (advisor lint 0011)
alter function public.set_updated_at()          set search_path = public;
alter function public.trg_block_ledger_change() set search_path = public;

-- Internal helpers: only ever called from inside the wms_* functions,
-- column defaults, or triggers — never directly from the app.
revoke execute on function public.next_lp_id()               from authenticated, anon, public;
revoke execute on function public.wms_require(int)           from authenticated, anon, public;
revoke execute on function public.trg_apply_inventory_txn()  from authenticated, anon, public;
revoke execute on function public.trg_block_ledger_change()  from authenticated, anon, public;
revoke execute on function public.set_updated_at()           from authenticated, anon, public;

-- Default privileges in Supabase grant EXECUTE on new functions to
-- authenticated automatically; this keeps future helper functions
-- private unless we grant them on purpose.
alter default privileges in schema public revoke execute on functions from anon;

commit;
