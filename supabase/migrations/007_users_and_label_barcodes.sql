-- =====================================================================
--  Customer Lite WMS  —  Migration 007
--  * app_users.login: the name people sign in with (username or email),
--    shown on the Users screen. Accounts are created by the admin-users
--    Edge Function, which uses the secret key server-side.
--  * Label barcode switches for the customer-named identifiers.
-- =====================================================================
begin;

alter table public.app_users add column login text;
create unique index ux_app_users_login on public.app_users (lower(login)) where login is not null;

-- backfill existing users with their email
update public.app_users a set login = u.email from auth.users u where u.id = a.id and a.login is null;

alter table public.settings
  add column cust_pallet_barcode boolean not null default false,
  add column ref1_barcode        boolean not null default false,
  add column ref2_barcode        boolean not null default false;

commit;
