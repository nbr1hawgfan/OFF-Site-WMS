-- =====================================================================
--  Customer Lite WMS  —  Migration 012: app theme
--   'lwh' (red header) or 'modern' (white + one accent color)
-- =====================================================================
alter table public.settings
  add column if not exists theme text not null default 'lwh' check (theme in ('lwh', 'modern')),
  add column if not exists accent_color text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$');
