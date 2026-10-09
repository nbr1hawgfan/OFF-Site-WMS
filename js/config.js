// Supabase project: Offsite WMS
// The publishable key is safe to ship in the browser — row-level security
// and the wms_* functions decide what each signed-in user can do.
window.WMS_CONFIG = {
  SUPABASE_URL: 'https://ulclsqwgyvrqjalrmfhr.supabase.co',
  SUPABASE_KEY: 'sb_publishable_Q5VUijpPZXyQNWJdokDXVQ_PAKKcXcy',
  APP_VERSION: '1.3.0',
  // usernames sign in as <username>@LOGIN_DOMAIN (must match the admin-users function)
  LOGIN_DOMAIN: 'wms.logistics-warehouse.com',
  // header / app-name branding (printed documents use Setup > Company)
  BRAND_SHORT: 'LWH',
  BRAND_NAME: 'Warehouse'
};
