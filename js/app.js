/* LWH Warehouse — lite WMS front end
   Vanilla JS + Supabase. All inventory changes go through the wms_* database
   functions; this file only collects input, calls them, and shows results. */
(() => {
  'use strict';

  const cfg = window.WMS_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  // lift (dock) sits between viewer and operator: it can scan, receive, load and
  // move, but never edits receipt/shipment details. The database enforces the same.
  const RANK = { viewer: 1, lift: 1.5, operator: 2, manager: 3, admin: 4 };
  const S = {
    session: null, profile: null, settings: null,
    items: [], locations: [], parties: [],
    lastReceive: loadPref('lastReceive', {})
  };
  const can = role => !!S.profile && S.profile.active && RANK[S.profile.role] >= RANK[role];
  const isLift = () => !!S.profile && S.profile.active && S.profile.role === 'lift';
  const canDock = () => isLift() || can('operator');

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function loadPref(key, fallback) {
    try { const v = localStorage.getItem('rmbwms.' + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  }
  function savePref(key, value) {
    try { localStorage.setItem('rmbwms.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }

  // "mike.dock" -> "mike.dock@wms.logistics-warehouse.com" (usernames are created by Setup > Users)
  function loginToEmail(v) {
    const s = String(v || '').trim().toLowerCase();
    return s.includes('@') ? s : `${s}@${cfg.LOGIN_DOMAIN || 'wms.logistics-warehouse.com'}`;
  }
  function friendly(err) {
    const m = (err && (err.message || err.error_description)) || String(err);
    if (/row-level security|permission denied|42501/i.test(m)) return 'You do not have permission to do this.';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'No connection. Check Wi-Fi and try again.';
    if (/items_sku_key|ux_items_owner_sku/i.test(m)) return 'That SKU already exists for this account.';
    if (/locations_code_key|ux_locations_wh_code/i.test(m)) return 'That location code already exists in this warehouse.';
    if (/ux_owners_code/i.test(m)) return 'That account code is already used.';
    if (/ux_warehouses_code/i.test(m)) return 'That warehouse code is already used.';
    if (/ux_charge_types_code/i.test(m)) return 'That charge code is already used.';
    if (/ux_pallets_customer_pallet_id/i.test(m)) return `That ${lbl.cust()} is already in use.`;
    if (/Invalid login credentials/i.test(m)) return 'Username/email or password is incorrect.';
    if (/banned/i.test(m)) return 'This login has been turned off. Ask your manager.';
    if (/JWT expired|invalid JWT/i.test(m)) return 'Your session expired. Please sign in again.';
    return m;
  }

  async function q(promise) {
    const { data, error } = await promise;
    if (error) throw error;
    return data;
  }

  let toastTimer;
  function toast(msg, kind = 'ok') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'bad' ? 7000 : 3500);
  }

  async function busy(btn, fn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Working...'; }
    try { await fn(); }
    catch (e) { console.error(e); toast(friendly(e), 'bad'); }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
  }

  function render(html) {
    $('#view').innerHTML = html;
  }

  function badge(status) {
    return `<span class="badge ${esc(status)}">${esc(String(status).replace('_', ' '))}</span>`;
  }

  function userName(id) { return (S.users || []).find(u => u.id === id)?.full_name || ''; }
  function itemById(id) { return S.items.find(i => i.id === id) || {}; }
  function locById(id) { return S.locations.find(l => l.id === id) || {}; }
  /* warehouses & customer accounts */
  function whById(id) { return (S.warehouses || []).find(w => w.id === id) || {}; }
  function ownerById(id) { return (S.owners || []).find(o => o.id === id) || {}; }
  const activeWhs = () => (S.warehouses || []).filter(w => w.active);
  const activeOwners = () => (S.owners || []).filter(o => o.active);
  const multiWh = () => activeWhs().length > 1;
  const multiOwner = () => activeOwners().length > 1;
  function whLocations(whId = S.whId) { return S.locations.filter(l => l.active && l.warehouse_id === whId); }
  // "A-01" in the current warehouse, "WHSE2 A-01" in another one
  function locLabel(id) {
    const l = locById(id);
    if (!l.code) return '';
    return multiWh() && l.warehouse_id !== S.whId ? `${whById(l.warehouse_id).code} ${l.code}` : l.code;
  }
  function itemsFor(ownerId) { return S.items.filter(i => i.active && (!ownerId || i.owner_id === ownerId)); }
  function ownerOptions(selectedId) {
    const list = activeOwners();
    const sel = selectedId || (list.length === 1 ? list[0].id : '');
    return (list.length > 1 ? '<option value="">Select account...</option>' : '')
      + list.map(o => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.code)} — ${esc(o.name)}</option>`).join('');
  }
  // printed documents: ship-from address comes from the warehouse when it has one
  function docSettings(whId) {
    const w = whById(whId), base = { ...(S.settings || {}) };
    if (w.address_line1) Object.assign(base, { address_line1: w.address_line1, address_line2: w.address_line2, city: w.city, state: w.state, zip: w.zip, phone: w.phone || base.phone });
    base.warehouse_code = multiWh() ? w.code : '';
    return base;
  }
  function companyName() { return (S.settings?.company_name || 'Warehouse').replace(/_/g, ' '); }

  /* customer-configurable identifier labels (Company setup) */
  const lbl = {
    lot: () => S.settings?.lot_label || 'Lot / Production #',
    lotShort: () => (S.settings?.lot_label || 'Lot').split(' /')[0].trim(),
    cust: () => S.settings?.cust_pallet_label || 'Customer Pallet ID',
    ref1: () => S.settings?.ref1_label || null,
    ref2: () => S.settings?.ref2_label || null
  };
  // extra identifiers that are switched on: [{ key, field, label, required, unique }]
  function idFields() {
    const st = S.settings || {};
    const out = [{ key: 'cust_id', field: 'customer_pallet_id', label: lbl.cust(), required: !!st.cust_pallet_required, unique: true }];
    if (st.ref1_label) out.push({ key: 'ref1', field: 'ref1', label: st.ref1_label, required: !!st.ref1_required, unique: !!st.ref1_unique });
    if (st.ref2_label) out.push({ key: 'ref2', field: 'ref2', label: st.ref2_label, required: !!st.ref2_required, unique: !!st.ref2_unique });
    return out;
  }
  // "Pallet ID P-1 · PGID PG-7" for list rows
  function idText(p) {
    return idFields().filter(f => p[f.field]).map(f => `${esc(f.label)} ${esc(p[f.field])}`).join(' &middot; ');
  }
  function lotText(p) {
    return p.lot_number ? `${esc(lbl.lotShort())} ${esc(p.lot_number)}` : `No ${esc(lbl.lotShort().toLowerCase())}`;
  }

  function toLocalInput(d) {
    const dt = d ? new Date(d) : new Date();
    const off = dt.getTimezoneOffset();
    return new Date(dt.getTime() - off * 60000).toISOString().slice(0, 16);
  }
  function numOrNull(v) { const s = String(v ?? '').trim(); return s === '' ? null : Number(s); }
  function strOrNull(v) { const s = String(v ?? '').trim(); return s === '' ? null : s; }

  /* ------------------------------------------------------------------ */
  /* modal, confirm, reason prompt, scanner                              */
  /* ------------------------------------------------------------------ */
  let modalOnClose = null;
  function openModal(title, html, onClose) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
    modalOnClose = onClose || null;
    return $('#modal-body');
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('#modal-body').innerHTML = '';
    const cb = modalOnClose; modalOnClose = null;
    if (cb) cb();
  }
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

  function askConfirm(title, message, okLabel = 'Confirm', danger = false) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const body = openModal(title, `
        <p>${message}</p>
        <div class="btn-row">
          <button class="btn ghost" data-act="no">Cancel</button>
          <button class="btn ${danger ? 'danger' : ''}" data-act="yes">${esc(okLabel)}</button>
        </div>`, () => finish(false));
      $('[data-act=no]', body).onclick = () => closeModal();
      $('[data-act=yes]', body).onclick = () => { finish(true); closeModal(); };
    });
  }

  function askReason(title, message, okLabel = 'Void') {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const body = openModal(title, `
        <p>${message}</p>
        <div class="field"><label for="reason">Reason (required)</label>
          <input id="reason" maxlength="200" autocomplete="off"></div>
        <div class="btn-row">
          <button class="btn ghost" data-act="no">Cancel</button>
          <button class="btn danger" data-act="yes">${esc(okLabel)}</button>
        </div>`, () => finish(null));
      const input = $('#reason', body);
      setTimeout(() => input.focus(), 50);
      $('[data-act=no]', body).onclick = () => closeModal();
      $('[data-act=yes]', body).onclick = () => {
        const r = input.value.trim();
        if (!r) { input.focus(); toast('Enter a reason.', 'bad'); return; }
        finish(r); closeModal();
      };
    });
  }

  let scanner = null;
  async function stopScanner() {
    const s = scanner; scanner = null;
    if (!s) return;
    try { if (s.isScanning) await s.stop(); s.clear(); } catch { /* already stopped */ }
  }
  async function openScanner(onCode) {
    if (!window.Html5Qrcode) { toast('Camera scanner did not load. Type the code instead.', 'bad'); return; }
    openModal('Scan Barcode', `
      <div id="scan-region"></div>
      <p class="hint">Point the camera at the barcode. A handheld scanner can also scan straight into the field.</p>`,
      () => { stopScanner(); });
    let handled = false;
    const F = window.Html5QrcodeSupportedFormats;
    scanner = new window.Html5Qrcode('scan-region', {
      verbose: false,
      formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.QR_CODE, F.DATA_MATRIX]
    });
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(w, h) * 0.45) }) },
        text => {
          if (handled) return;
          handled = true;
          closeModal();
          onCode(String(text).trim());
        },
        () => {}
      );
    } catch (e) {
      closeModal();
      toast('Camera unavailable. Allow camera access or type the code.', 'bad');
    }
  }
  function wireScanButtons(root) {
    $$('[data-scan]', root).forEach(btn => {
      btn.onclick = () => {
        const input = $('#' + btn.dataset.scan, root);
        openScanner(code => {
          input.value = code;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (btn.dataset.submit) $('#' + btn.dataset.submit, root)?.requestSubmit();
        });
      };
    });
  }
  const scanBtn = (inputId, submitFormId) =>
    `<button type="button" class="btn secondary" data-scan="${inputId}" ${submitFormId ? `data-submit="${submitFormId}"` : ''} aria-label="Scan with camera">Scan</button>`;

  /* ------------------------------------------------------------------ */
  /* auth & reference data                                               */
  /* ------------------------------------------------------------------ */
  async function loadUser() {
    const uid = S.session?.user?.id;
    S.profile = uid ? await q(sb.from('app_users').select('*').eq('id', uid).maybeSingle()) : null;
    if (S.profile?.active) await loadRef();
    renderHeader();
  }

  async function loadRef() {
    const [settings, items, locations, parties, warehouses, owners, chargeTypes] = await Promise.all([
      q(sb.from('settings').select('*').eq('id', 1).single()),
      q(sb.from('items').select('*').order('sku')),
      q(sb.from('locations').select('*').order('sort_order').order('code')),
      q(sb.from('parties').select('*').order('name')),
      q(sb.from('warehouses').select('*').order('sort_order').order('code')),
      q(sb.from('owners').select('*').order('code')),
      can('operator') ? q(sb.from('charge_types').select('*').order('sort_order').order('name')).catch(() => []) : []
    ]);
    S.settings = settings; S.items = items; S.locations = locations; S.parties = parties;
    S.warehouses = warehouses; S.owners = owners; S.chargeTypes = chargeTypes;
    // current warehouse: this device's last choice, else the user's home, else the first
    const ok = id => warehouses.some(w => w.id === id && w.active);
    const pref = loadPref('wh', null);
    S.whId = ok(S.whId) ? S.whId : ok(pref) ? pref : ok(S.profile?.home_warehouse_id) ? S.profile.home_warehouse_id
      : (warehouses.find(w => w.active) || {}).id;
    S.users = await q(sb.from('app_users').select('id, full_name')).catch(() => []);
    document.title = (cfg.BRAND_SHORT || '') + ' WMS';
  }

  /* ---- header clock + local weather (desktop) ---- */
  const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
    FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
    NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
    OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
  // WMO weather codes -> a short word
  function wxWord(c) {
    if (c === 0) return 'Clear'; if (c <= 2) return 'Partly cloudy'; if (c === 3) return 'Cloudy'; if (c <= 48) return 'Fog';
    if (c <= 57) return 'Drizzle'; if (c <= 67) return 'Rain'; if (c <= 77) return 'Snow'; if (c <= 82) return 'Showers';
    if (c <= 86) return 'Snow showers'; return 'Storms';
  }
  function tickClock() {
    const el = document.getElementById('hdr-clock');
    if (el) el.textContent = new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  setInterval(tickClock, 15000);
  async function updateWeather() {
    const el = document.getElementById('hdr-wx');
    if (!el) return;
    const w = whById(S.whId), st = S.settings || {};
    const city = (w.city || st.city || '').trim(), state = (w.state || st.state || '').trim().toUpperCase();
    if (!city) { el.textContent = ''; return; }
    const key = `${city},${state}`.toUpperCase();
    try {
      let wx = loadPref('wx:' + key, null);
      if (!wx || Date.now() - wx.t > 20 * 60000) {
        let geo = loadPref('geo:' + key, null);
        if (!geo) {
          const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&language=en&format=json&countryCode=US`).then(x => x.json());
          const hit = (r.results || []).find(x => !state || x.admin1 === STATE_NAMES[state]) || (r.results || [])[0];
          if (!hit) { el.textContent = ''; return; }
          geo = { lat: hit.latitude, lon: hit.longitude };
          savePref('geo:' + key, geo);
        }
        const f = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1`).then(x => x.json());
        wx = { t: Date.now(), temp: f.current.temperature_2m, code: f.current.weather_code, wind: f.current.wind_speed_10m,
               hi: f.daily?.temperature_2m_max?.[0], lo: f.daily?.temperature_2m_min?.[0] };
        savePref('wx:' + key, wx);
      }
      if (!el.isConnected) return;
      el.textContent = `${city} ${Math.round(wx.temp)}°F ${wxWord(wx.code)}`;
      el.title = `High ${Math.round(wx.hi)}° / Low ${Math.round(wx.lo)}° · Wind ${Math.round(wx.wind)} mph · Open-Meteo`;
    } catch (e) { el.textContent = ''; }   // weather is a nice-to-have; never block the app
  }
  setInterval(() => updateWeather(), 20 * 60000);

  function renderHeader() {
    const el = $('#header-right');
    if (!S.session) { el.innerHTML = ''; return; }
    const name = S.profile?.full_name || S.session.user.email;
    const whSwitch = S.profile?.active && multiWh()
      ? `<select id="wh-switch" class="wh-switch" aria-label="Warehouse">${activeWhs().map(w =>
          `<option value="${w.id}" ${w.id === S.whId ? 'selected' : ''}>${esc(w.code)}</option>`).join('')}</select>` : '';
    el.innerHTML = `${S.profile?.active && !isLift() ? '<span class="hdr-info"><span id="hdr-wx"></span><span id="hdr-clock"></span></span>' : ''}${whSwitch}<span class="who">${esc(name)}</span><button id="signout" type="button">Sign out</button>`;
    tickClock(); updateWeather();
    $('#wh-switch')?.addEventListener('change', e => {
      S.whId = e.target.value;
      savePref('wh', S.whId);
      sb.rpc('wms_set_home_warehouse', { p_warehouse_id: S.whId }).then(() => {}, () => {});
      toast(`Now working in ${whById(S.whId).code}: ${whById(S.whId).name}.`);
      updateWeather();
      route();
    });
    $('#signout').onclick = async () => {
      await sb.auth.signOut();
      S.session = null; S.profile = null;
      renderHeader();
      location.hash = '#/';
      route();
    };
  }

  /* ------------------------------------------------------------------ */
  /* router                                                              */
  /* ------------------------------------------------------------------ */
  let recoveryMode = false;
  // bumps on every navigation; screens that finish loading after the user
  // has moved on check this and quietly stop instead of drawing over the new page
  let navSeq = 0;

  /* desktop: left menu for office users (phones and Dock Mode keep the simple layout) */
  function setShell(a = '') {
    const office = !!(S.session && S.profile?.active && !isLift() && !recoveryMode && a !== 'dock');
    document.body.classList.toggle('office', office);
    document.documentElement.style.setProperty('--hdr', ($('.app-header')?.offsetHeight || 62) + 'px');
    const nav = $('#sidenav');
    if (!office) { nav.innerHTML = ''; return; }
    const items = [
      ['', 'Dashboard', true, []], ['schedule', 'Schedule', true, []], ['receipts', 'Receiving', true, ['receipt']],
      ['shipments', 'Shipping', true, ['shipment']], ['inventory', 'Inventory', true, []], ['lookup', 'Lookup', true, []], ['reports', 'Reports', true, []],
      ['billing', 'Billing', can('manager'), []], ['setup', 'Setup', can('manager'), []], ['dock', 'Dock Mode', can('operator'), []]
    ];
    nav.innerHTML = items.filter(n => n[2]).map(([k, label, , alias]) =>
      `<a href="#/${k}" class="${a === k || alias.includes(a) ? 'active' : ''}">${label}</a>`).join('')
      + `<div class="nav-foot">${esc(S.profile.full_name)}<br>${esc(S.profile.role)} &middot; v${esc(cfg.APP_VERSION)}</div>`;
  }
  // table rows that open a record when clicked anywhere
  function wireRowLinks(root = document) {
    $$('tr[data-href]', root).forEach(tr => tr.addEventListener('click', e => { if (!e.target.closest('a,button')) location.hash = tr.dataset.href; }));
  }
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (document.getElementById('dash') && S.dashResize) S.dashResize(); }, 150); });

  async function route() {
    const path = location.hash.replace(/^#\/?/, '');
    const [a, b, c] = path.split('/');
    navSeq++;
    setShell(a);
    if (!$('#modal').hidden) closeModal();
    window.scrollTo(0, 0);
    try {
      if (recoveryMode) return viewSetPassword();
      if (!S.session) return viewLogin();
      if (!S.profile || !S.profile.active) return viewNoAccess();
      if (!a) return isLift() ? viewDockHome() : viewHome();
      if (a === 'dock') {
        if (!canDock()) { location.hash = '#/'; return; }
        if (b === 'load' && c) return viewDockLoad(c);
        if (b === 'load') return viewDockLoads();
        if (b === 'unload' && c) return viewReceipt(c, null, true);
        if (b === 'unload') return viewDockReceipts();
        if (b === 'move') return viewDockMove();
        return viewDockHome();
      }
      if (a === 'receipts') return viewReceipts();
      if (a === 'receipt' && b === 'new') return viewNewReceipt();
      if (a === 'receipt' && b) return viewReceipt(b);
      if (a === 'lookup') return viewLookup(decodeURIComponent(b || ''));
      if (a === 'inventory') return viewInventory();
      if (a === 'schedule') return viewSchedule(b, c);
      if (a === 'reports') return viewReports();
      if (a === 'shipments') return viewShipments();
      if (a === 'shipment' && b === 'new') return viewNewShipment();
      if (a === 'shipment' && b) return viewShipment(b);
      if (a === 'setup') return viewSetup(b || 'items');
      if (a === 'billing') return b ? viewStatement(b, c) : viewBilling();
      render(`<div class="card"><h2>Page not found</h2><a class="btn" href="#/">Home</a></div>`);
    } catch (e) {
      console.error(e);
      render(`<div class="notice bad">${esc(friendly(e))}</div>
        <button class="btn" onclick="location.reload()">Try again</button>`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* login / access                                                      */
  /* ------------------------------------------------------------------ */
  function viewLogin() {
    render(`
      <div class="login card accent">
        <h1>Sign in</h1>
        <form id="login-form">
          <div class="field"><label for="email">Username or email</label>
            <input id="email" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
          <div class="field"><label for="password">Password</label>
            <input id="password" type="password" autocomplete="current-password" required></div>
          <button class="btn block" id="login-btn">Sign in</button>
        </form>
        <p class="small"><a href="#" id="forgot">Forgot password?</a></p>
      </div>`);
    $('#login-form').onsubmit = e => {
      e.preventDefault();
      busy($('#login-btn'), async () => {
        const { data, error } = await sb.auth.signInWithPassword({
          email: loginToEmail($('#email').value), password: $('#password').value
        });
        if (error) throw error;
        S.session = data.session;
        await loadUser();
        location.hash = '#/';
        route();
      });
    };
    $('#forgot').onclick = e => {
      e.preventDefault();
      const email = $('#email').value.trim();
      if (!email) { toast('Enter your email first.', 'bad'); $('#email').focus(); return; }
      if (!email.includes('@')) { toast('Username logins are reset by your manager (Setup > Users).', 'bad'); return; }
      busy(null, async () => {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + location.pathname
        });
        if (error) throw error;
        toast('Check your email for a reset link.');
      });
    };
  }

  function viewSetPassword() {
    render(`
      <div class="login card accent">
        <h1>Set a new password</h1>
        <form id="pw-form">
          <div class="field"><label for="pw1">New password</label>
            <input id="pw1" type="password" minlength="8" autocomplete="new-password" required></div>
          <div class="field"><label for="pw2">Confirm password</label>
            <input id="pw2" type="password" minlength="8" autocomplete="new-password" required></div>
          <button class="btn block" id="pw-btn">Save password</button>
        </form>
      </div>`);
    $('#pw-form').onsubmit = e => {
      e.preventDefault();
      if ($('#pw1').value !== $('#pw2').value) { toast('Passwords do not match.', 'bad'); return; }
      busy($('#pw-btn'), async () => {
        const { error } = await sb.auth.updateUser({ password: $('#pw1').value });
        if (error) throw error;
        recoveryMode = false;
        toast('Password saved.');
        await loadUser();
        location.hash = '#/';
        route();
      });
    };
  }

  function viewNoAccess() {
    render(`
      <div class="login card accent">
        <h1>No access yet</h1>
        <p>You are signed in as <strong>${esc(S.session.user.email)}</strong>, but this account has not been given access to the warehouse system.</p>
        <p class="muted">Ask the administrator to add you.</p>
      </div>`);
  }

  /* ------------------------------------------------------------------ */
  /* home                                                                */
  /* ------------------------------------------------------------------ */
  // Supabase returns at most 1,000 rows per request; page through bigger sets
  async function fetchAll(build, pageSize = 1000) {
    const out = [];
    for (let from = 0; from < 50000; from += pageSize) {
      const rows = await q(build().range(from, from + pageSize - 1));
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }
  // .in() over many ids, 100 at a time (keeps request URLs short), each chunk paged
  async function fetchIn(ids, buildFor) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) out.push(...await fetchAll(buildFor(ids.slice(i, i + 100))));
    return out;
  }
  const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; };
  const daysOld = d => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));

  async function loadDashboard(allWh) {
    const wh = q => allWh ? q : q.eq('warehouse_id', S.whId);
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 29);
    const [inv, rcv, shipped, openR, openS, bill] = await Promise.all([
      fetchAll(() => wh(sb.from('v_inventory').select('pallet_id, lp_id, item_id, sku, description, uom, qty_on_hand, status, received_at, warehouse_id, owner_id')).order('pallet_id')),
      fetchAll(() => sb.from('v_transactions').select('id, created_at, txn_type, lp_id, to_warehouse, owner_code')
        .in('txn_type', ['RECEIVE', 'VOID_RECEIVE']).gte('created_at', since.toISOString()).order('id')),
      fetchAll(() => wh(sb.from('shipments').select('id, shipped_at, owner_id, warehouse_id, shipment_lines(count)'))
        .eq('status', 'shipped').gte('shipped_at', since.toISOString()).order('shipped_at')),
      q(wh(sb.from('receipts').select('id, owner_id, expected_at, received_at, unloaded_at, pallets(count)')).eq('status', 'open')),
      q(wh(sb.from('shipments').select('id, owner_id, ship_date, loaded_at')).eq('status', 'open')),
      can('manager') && !isLift() ? q(sb.rpc('wms_billing_summary', { p_month: ymOf(new Date()) + '-01' })).catch(() => null) : Promise.resolve(null)
    ]);
    // received pallets, minus any later voided
    const voided = new Set(rcv.filter(t => t.txn_type === 'VOID_RECEIVE').map(t => t.lp_id));
    const whCode = whById(S.whId).code;
    const ownerByCode = Object.fromEntries((S.owners || []).map(o => [o.code, o.id]));
    const received = rcv.filter(t => t.txn_type === 'RECEIVE' && !voided.has(t.lp_id) && (allWh || t.to_warehouse === whCode))
      .map(t => ({ at: t.created_at, owner_id: ownerByCode[t.owner_code] }));
    return { inv, received, shipped, openR, openS, bill, since };
  }

  async function viewHome() {
    const mySeq = navSeq;
    const allWh = multiWh() && loadPref('dashAllWh', false);
    let acct = loadPref('dashOwner', '');
    if (acct && !ownerById(acct).id) acct = '';
    const frame = $('#dash');
    if (frame) frame.classList.add('refreshing'); else render(`<div class="loading">Loading...</div>`);
    const D = await loadDashboard(allWh);
    if (mySeq !== navSeq) return;

    const mine = r => !acct || r.owner_id === acct;
    const inv = D.inv.filter(mine), received = D.received.filter(mine), shipped = D.shipped.filter(mine);
    const openR = D.openR.filter(mine), openS = D.openS.filter(mine);
    const today = todayIso(), monthStart = ymOf(new Date()) + '-01';
    const shipPallets = s => s.shipment_lines?.[0]?.count ?? 0;
    const inToday = openR.filter(r => r.expected_at && dayKey(r.expected_at) === today).length;
    const outToday = openS.filter(s => s.ship_date === today).length;
    const recvMonth = received.filter(r => dayKey(r.at) >= monthStart).length;
    const shipMonth = shipped.filter(s => dayKey(s.shipped_at) >= monthStart).reduce((a, s) => a + shipPallets(s), 0);
    const ship30 = shipped.reduce((a, s) => a + shipPallets(s), 0);
    const onHold = inv.filter(p => p.status === 'hold').length;
    const skus = new Set(inv.map(p => p.item_id)).size;
    const billRows = (D.bill || []).filter(mine);
    const billMtd = billRows.reduce((a, r) => a + Number(r.total), 0);
    const avgAge = inv.length ? Math.round(inv.reduce((a, p) => a + daysOld(p.received_at), 0) / inv.length) : 0;

    // per-account roll-up (table)
    const accts = activeOwners().filter(o => !acct || o.id === acct).map(o => {
      const p = inv.filter(x => x.owner_id === o.id);
      const uoms = [...new Set(p.map(x => x.uom))];
      return {
        o, pallets: p.length, hold: p.filter(x => x.status === 'hold').length, skus: new Set(p.map(x => x.item_id)).size,
        qty: uoms.length === 1 ? `${fmtQty(p.reduce((a, x) => a + Number(x.qty_on_hand), 0))} ${uoms[0]}` : (p.length ? 'mixed units' : '-'),
        oldest: p.length ? Math.max(...p.map(x => daysOld(x.received_at))) : null,
        in30: received.filter(r => r.owner_id === o.id).length,
        out30: shipped.filter(s => s.owner_id === o.id).reduce((a, s) => a + shipPallets(s), 0),
        bill: D.bill ? Number((D.bill.find(r => r.owner_id === o.id) || {}).total || 0) : null
      };
    }).sort((a, b) => b.pallets - a.pallets || a.o.code.localeCompare(b.o.code));

    // top items
    const byItem = {};
    for (const p of inv) {
      const k = p.item_id;
      byItem[k] = byItem[k] || { sku: p.sku, description: p.description, uom: p.uom, owner_id: p.owner_id, pallets: 0, qty: 0, oldest: 0 };
      byItem[k].pallets++; byItem[k].qty += Number(p.qty_on_hand); byItem[k].oldest = Math.max(byItem[k].oldest, daysOld(p.received_at));
    }
    const topItems = Object.values(byItem).sort((a, b) => b.pallets - a.pallets || b.qty - a.qty).slice(0, 10);

    // 30-day series
    const days = [];
    for (let i = 0; i < 30; i++) { const d = new Date(D.since); d.setDate(d.getDate() + i); days.push(dayKey(d)); }
    const inByDay = Object.fromEntries(days.map(d => [d, 0])), outByDay = Object.fromEntries(days.map(d => [d, 0]));
    received.forEach(r => { const k = dayKey(r.at); if (k in inByDay) inByDay[k]++; });
    shipped.forEach(s => { const k = dayKey(s.shipped_at); if (k in outByDay) outByDay[k] += shipPallets(s); });

    // aging buckets
    const buckets = [['0-30 days', 0, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['91-180', 91, 180], ['181+', 181, Infinity]]
      .map(([label, lo, hi]) => ({ label, value: inv.filter(p => { const a = daysOld(p.received_at); return a >= lo && a <= hi; }).length }));

    const scopeTxt = `${allWh ? 'All warehouses' : esc(whById(S.whId).code || '')}${acct ? ' &middot; ' + esc(ownerById(acct).code) : ''}`;
    const kpi = (label, value, sub, href) => `
      <${href ? `a href="${href}"` : 'div'} class="kpi">
        <div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
      </${href ? 'a' : 'div'}>`;
    const showBill = D.bill !== null;

    render(`
      <div id="dash">
        <div class="dash-head">
          <div><h1 style="margin-bottom:2px">${esc(companyName())}</h1>
            <div class="muted small">${scopeTxt} &middot; ${esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</div></div>
          <div class="dash-filters">
            ${multiOwner() ? `<select id="dash-acct" aria-label="Account"><option value="">All accounts</option>${activeOwners().map(o => `<option value="${o.id}" ${o.id === acct ? 'selected' : ''}>${esc(o.code)} — ${esc(o.name)}</option>`).join('')}</select>` : ''}
            ${multiWh() ? `<label class="check"><input type="checkbox" id="dash-allwh" ${allWh ? 'checked' : ''}> All warehouses</label>` : ''}
          </div>
        </div>

        <div class="tiles home-tiles">
          <a class="tile" href="#/schedule"><strong>Schedule</strong><span>${inToday} in &middot; ${outToday} out today</span></a>
          <a class="tile" href="#/receipts"><strong>Receiving</strong><span>${D.openR.length ? `${D.openR.length} open receipt${D.openR.length === 1 ? '' : 's'}` : 'Receive pallets, print labels'}</span></a>
          <a class="tile" href="#/inventory"><strong>Inventory</strong><span>Filter by item, ${esc(lbl.lotShort().toLowerCase())}, location; print and export</span></a>
          <a class="tile" href="#/lookup"><strong>Inventory Lookup</strong><span>Scan or search pallets</span></a>
          <a class="tile" href="#/shipments"><strong>Shipping</strong><span>${D.openS.length ? `${D.openS.length} open shipment${D.openS.length === 1 ? '' : 's'}` : 'Load pallets, print BOLs'}</span></a>
          <a class="tile" href="#/reports"><strong>Reports</strong><span>Export inventory and activity to Excel</span></a>
          ${can('operator') ? `<a class="tile" href="#/dock"><strong>Dock Mode</strong><span>The forklift screens: load, unload, move</span></a>` : ''}
          ${can('manager') ? `<a class="tile" href="#/billing"><strong>Billing</strong><span>Rates, extra charges, monthly statements</span></a>` : ''}
          ${can('manager') ? `<a class="tile" href="#/setup"><strong>Setup</strong><span>Items, locations, customers, users, company info</span></a>` : ''}
        </div>

        <div class="kpis">
          ${kpi('Pallets on hand', inv.length.toLocaleString(), onHold ? `${onHold} on hold` : 'none on hold', '#/inventory')}
          ${kpi('SKUs in stock', skus.toLocaleString(), inv.length ? `avg ${avgAge} days on hand` : '&nbsp;')}
          ${kpi('Received, 30 days', received.length.toLocaleString(), `${recvMonth} this month`, '#/receipts')}
          ${kpi('Shipped, 30 days', ship30.toLocaleString(), `${shipMonth} this month`, '#/shipments')}
          ${kpi('Open loads', (openR.length + openS.length).toLocaleString(), `${openR.length} in &middot; ${openS.length} out`, '#/schedule')}
          ${kpi('Trucks today', (inToday + outToday).toLocaleString(), `${inToday} in &middot; ${outToday} out`, '#/schedule')}
          ${showBill ? kpi('Billing, month to date', money(billMtd), `${esc(monthLabel(ymOf(new Date())))}${acct ? '' : (n => ` &middot; ${n} account${n === 1 ? '' : 's'}`)(billRows.filter(r => Number(r.total) > 0).length)}`, '#/billing') : ''}
        </div>

        <div class="dash-grid">
          <section class="card chart-card wide">
            <div class="row spread"><h2 style="margin:0">Pallets in and out, last 30 days</h2>
              <div class="legend"><span><i style="background:${VIZ.s1}"></i>Received</span><span><i style="background:${VIZ.s2}"></i>Shipped</span></div></div>
            <div id="ch-activity" class="chart"></div>
          </section>
          <section class="card chart-card">
            <h2 style="margin-top:0">${acct ? 'Top items on hand' : 'Pallets on hand by account'}</h2>
            <div id="ch-accounts"></div>
          </section>
          <section class="card chart-card">
            <h2 style="margin-top:0">Inventory age</h2>
            <div id="ch-aging"></div>
            <p class="muted small" style="margin:8px 0 0">Days since each pallet was received.</p>
          </section>
          <section class="card wide">
            <h2 style="margin-top:0">By account</h2>
            <div class="table-wrap"><table class="data" id="acct-table">
              <thead><tr><th>Account</th><th class="num">Pallets</th><th class="num">On hold</th><th class="num">SKUs</th><th class="num">Qty on hand</th><th class="num">Oldest</th><th class="num">In 30d</th><th class="num">Out 30d</th>${showBill ? '<th class="num">Billing MTD</th>' : ''}</tr></thead>
              <tbody>${accts.map(r => `<tr data-dash-acct="${r.o.id}" tabindex="0">
                <td><strong>${esc(r.o.code)}</strong> <span class="muted">${esc(r.o.name)}</span></td>
                <td class="num">${r.pallets.toLocaleString()}</td><td class="num">${r.hold || '-'}</td><td class="num">${r.skus}</td>
                <td class="num">${esc(r.qty)}</td><td class="num">${r.oldest === null ? '-' : r.oldest + ' days'}</td>
                <td class="num">${r.in30}</td><td class="num">${r.out30}</td>${showBill ? `<td class="num">${money(r.bill)}</td>` : ''}</tr>`).join('')
                || `<tr><td colspan="9" class="muted">No accounts yet.</td></tr>`}</tbody>
            </table></div>
            ${multiOwner() && !acct ? '<p class="muted small" style="margin:8px 0 0">Click an account to focus the dashboard on it.</p>' : ''}
          </section>
          <section class="card wide">
            <h2 style="margin-top:0">Top items on hand</h2>
            <div class="table-wrap"><table class="data">
              <thead><tr><th>SKU</th><th>Description</th>${multiOwner() ? '<th>Account</th>' : ''}<th class="num">Pallets</th><th class="num">Qty</th><th class="num">Oldest</th></tr></thead>
              <tbody>${topItems.map(t => `<tr><td><a href="#/lookup/${encodeURIComponent(t.sku)}">${esc(t.sku)}</a></td><td>${esc(t.description || '')}</td>
                ${multiOwner() ? `<td>${esc(ownerById(t.owner_id).code || '')}</td>` : ''}<td class="num">${t.pallets}</td>
                <td class="num">${esc(fmtQty(t.qty))} ${esc(t.uom || '')}</td><td class="num">${t.oldest} days</td></tr>`).join('')
                || `<tr><td colspan="6" class="muted">Nothing on hand.</td></tr>`}</tbody>
            </table></div>
          </section>
        </div>
        <p class="muted small" style="margin-top:4px">Signed in as ${esc(S.profile.full_name)} (${esc(S.profile.role)}) &middot; v${esc(cfg.APP_VERSION)}</p>
      </div>`);

    const draw = () => {
      if (!document.getElementById('ch-activity')) return;
      lineChart($('#ch-activity'), days, [
        { name: 'Received', color: VIZ.s1, values: days.map(d => inByDay[d]) },
        { name: 'Shipped', color: VIZ.s2, values: days.map(d => outByDay[d]) }
      ]);
    };
    requestAnimationFrame(draw);   // after layout, so the chart gets its real width
    S.dashResize = draw;
    hBars($('#ch-accounts'), acct
      ? topItems.slice(0, 8).map(t => ({ label: t.sku, value: t.pallets, tip: `${t.description || ''}` }))
      : accts.filter(r => r.pallets).slice(0, 8).map(r => ({ label: r.o.code, value: r.pallets, tip: r.o.name })), 'pallets');
    vBars($('#ch-aging'), buckets, 'pallets');

    const refresh = () => viewHome().catch(e => { console.error(e); toast(friendly(e), 'bad'); });
    $('#dash-acct')?.addEventListener('change', e => { savePref('dashOwner', e.target.value); refresh(); });
    $('#dash-allwh')?.addEventListener('change', e => { savePref('dashAllWh', e.target.checked); refresh(); });
    $$('[data-dash-acct]').forEach(tr => {
      const go = () => { if (!multiOwner()) return; savePref('dashOwner', acct === tr.dataset.dashAcct ? '' : tr.dataset.dashAcct); refresh(); };
      tr.onclick = go; tr.onkeydown = e => { if (e.key === 'Enter') go(); };
    });
  }

  /* ---- small hand-built charts (no library) ---- */
  const VIZ = { s1: '#2a78d6', s2: '#eb6834', grid: '#e6e6ea', axis: '#5f6068' };
  function vizTip() {
    let t = document.getElementById('viz-tip');
    if (!t) { t = document.createElement('div'); t.id = 'viz-tip'; t.className = 'viz-tip'; t.hidden = true; document.body.appendChild(t); }
    return t;
  }
  // rows: [{ value, label, color? }] - built with textContent (labels are data)
  function showTip(x, y, title, rows) {
    const t = vizTip();
    t.textContent = '';
    const h = document.createElement('div'); h.className = 'viz-tip-title'; h.textContent = title; t.appendChild(h);
    rows.forEach(r => {
      const line = document.createElement('div'); line.className = 'viz-tip-row';
      if (r.color) { const k = document.createElement('i'); k.style.background = r.color; line.appendChild(k); }
      const v = document.createElement('strong'); v.textContent = r.value; line.appendChild(v);
      const l = document.createElement('span'); l.textContent = ' ' + r.label; line.appendChild(l);
      t.appendChild(line);
    });
    t.hidden = false;
    const w = t.offsetWidth, hgt = t.offsetHeight;
    t.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14)) + 'px';
    t.style.top = Math.max(8, y - hgt - 10) + 'px';
  }
  function hideTip() { const t = document.getElementById('viz-tip'); if (t) t.hidden = true; }
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  const shortDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

  function lineChart(el, labels, series) {
    const W = Math.max(280, el.clientWidth || 600), H = 230, L = 34, R = 70, T = 12, B = 26;
    const max = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
    const x = i => L + (labels.length < 2 ? 0 : i * (W - L - R) / (labels.length - 1));
    const y = v => T + (H - T - B) * (1 - v / max);
    const ticks = [0, .25, .5, .75, 1].map(f => Math.round(max * f * 100) / 100);
    const every = Math.ceil(labels.length / Math.max(2, Math.floor((W - L - R) / 80)));
    const svg = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Pallets received and shipped per day, last 30 days" tabindex="0">
        ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${VIZ.grid}" stroke-width="1"/>
          <text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="${VIZ.axis}">${t}</text>`).join('')}
        ${labels.map((d, i) => i % every === 0 || i === labels.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${VIZ.axis}">${esc(shortDay(d))}</text>` : '').join('')}
        ${series.map(s => `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
            points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`).join('')}
        ${(() => { // direct end labels, nudged apart if they collide
          const ends = series.map(s => ({ s, yy: y(s.values[s.values.length - 1]) })).sort((a, b) => a.yy - b.yy);
          for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 14) ends[i].yy = ends[i - 1].yy + 14;
          return ends.map(e => `<text x="${W - R + 6}" y="${e.yy + 4}" font-size="12" fill="#1b1b1f">${esc(e.s.name)} ${e.s.values[e.s.values.length - 1]}</text>`).join('');
        })()}
        <line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#1b1b1f" stroke-width="1" opacity="0"/>
        ${series.map((s, k) => `<circle class="dot dot${k}" r="4" fill="${s.color}" stroke="#fff" stroke-width="2" opacity="0"/>`).join('')}
        <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
      </svg>`;
    el.innerHTML = svg;
    const root = el.querySelector('svg'), hair = root.querySelector('.xhair'), hit = root.querySelector('.hit');
    const at = (i, cx, cy) => {
      hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('opacity', '.35');
      series.forEach((s, k) => { const c = root.querySelector('.dot' + k); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(s.values[i])); c.setAttribute('opacity', '1'); });
      showTip(cx, cy, shortDay(labels[i]), series.map(s => ({ value: String(s.values[i]), label: s.name.toLowerCase() + ' pallets', color: s.color })));
    };
    const clear = () => { hair.setAttribute('opacity', '0'); root.querySelectorAll('.dot').forEach(c => c.setAttribute('opacity', '0')); hideTip(); };
    let idx = labels.length - 1;
    hit.addEventListener('pointermove', e => {
      const r = root.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
      idx = Math.max(0, Math.min(labels.length - 1, Math.round((px - L) / ((W - L - R) / Math.max(1, labels.length - 1)))));
      at(idx, e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', clear);
    root.addEventListener('blur', clear);
    root.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      idx = Math.max(0, Math.min(labels.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)));
      const r = root.getBoundingClientRect();
      at(idx, r.left + x(idx) * r.width / W, r.top + 20);
    });
  }

  // horizontal bars: rows [{label, value, tip}]
  function hBars(el, rows, unit) {
    if (!rows.length) { el.innerHTML = '<p class="muted">Nothing on hand.</p>'; return; }
    const max = Math.max(...rows.map(r => r.value), 1);
    el.innerHTML = `<div class="hbars">${rows.map((r, i) => `
      <div class="hbar" data-i="${i}" tabindex="0">
        <span class="hbar-label">${esc(r.label)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(1.5, 100 * r.value / max)}%"></span></span>
        <span class="hbar-val">${r.value.toLocaleString()}</span>
      </div>`).join('')}</div>`;
    $$('.hbar', el).forEach(b => {
      const r = rows[Number(b.dataset.i)];
      const show = e => { const bb = b.getBoundingClientRect(); showTip(e?.clientX ?? bb.left + 60, e?.clientY ?? bb.top, r.label + (r.tip ? ' — ' + r.tip : ''), [{ value: r.value.toLocaleString(), label: unit, color: VIZ.s1 }]); };
      b.addEventListener('pointermove', show); b.addEventListener('focus', () => show());
      b.addEventListener('pointerleave', hideTip); b.addEventListener('blur', hideTip);
    });
  }

  // vertical bars: rows [{label, value}]
  function vBars(el, rows, unit) {
    const max = Math.max(...rows.map(r => r.value), 1);
    el.innerHTML = `<div class="vbars">${rows.map((r, i) => `
      <div class="vbar" data-i="${i}" tabindex="0">
        <span class="vbar-val">${r.value.toLocaleString()}</span>
        <span class="vbar-col"><span class="vbar-fill" style="height:${r.value ? Math.max(2, 100 * r.value / max) : 0}%"></span></span>
        <span class="vbar-label">${esc(r.label)}</span>
      </div>`).join('')}</div>`;
    $$('.vbar', el).forEach(b => {
      const r = rows[Number(b.dataset.i)];
      const show = e => { const bb = b.getBoundingClientRect(); showTip(e?.clientX ?? bb.left, e?.clientY ?? bb.top, r.label + (r.label.includes('days') ? '' : ' days'), [{ value: r.value.toLocaleString(), label: unit, color: VIZ.s1 }]); };
      b.addEventListener('pointermove', show); b.addEventListener('focus', () => show());
      b.addEventListener('pointerleave', hideTip); b.addEventListener('blur', hideTip);
    });
  }


  /* ------------------------------------------------------------------ */
  /* receiving: list                                                     */
  /* ------------------------------------------------------------------ */
  async function viewReceipts() {
    const mySeq = navSeq;
    render(`<div class="loading">Loading...</div>`);
    const rows = await q(sb.from('receipts')
      .select('id, receipt_no, status, received_at, expected_at, unloaded_at, dock_door, vendor_name, carrier, trailer_no, po_number, owner_id, pallets(count)')
      .eq('warehouse_id', S.whId)
      .order('received_at', { ascending: false }).limit(60));
    if (mySeq !== navSeq) return;
    const open = rows.filter(r => r.status === 'open');
    const rest = rows.filter(r => r.status !== 'open');
    const item = r => `
      <a class="list-item" href="#/receipt/${r.id}">
        <div class="row spread"><span class="title">${esc(r.receipt_no)}</span>
          <span>${r.status === 'open' && r.unloaded_at ? '<span class="badge open">Unloaded</span> ' : ''}${badge(r.status)}</span></div>
        <div class="meta">${r.expected_at && !(r.pallets?.[0]?.count) ? 'Expected ' + esc(fmtDateTime(r.expected_at)) : esc(fmtDateTime(r.received_at))}${r.dock_door ? ' &middot; Door ' + esc(r.dock_door) : ''} &middot; ${r.pallets?.[0]?.count ?? 0} pallets</div>
        <div class="meta">${esc([multiOwner() && ownerById(r.owner_id).code, r.vendor_name, r.carrier, r.trailer_no && 'Trailer ' + r.trailer_no, r.po_number && 'PO ' + r.po_number].filter(Boolean).join(' · '))}</div>
      </a>`;
    // desktop: the same rows as a table
    const table = list => `
      <div class="card table-card dwrap"><table class="data">
        <thead><tr><th>Receipt</th><th>Status</th>${multiOwner() ? '<th>Account</th>' : ''}<th>Expected / received</th><th>Door</th><th>Vendor</th><th>Carrier</th><th>Trailer</th><th>PO</th><th class="num">Pallets</th></tr></thead>
        <tbody>${list.map(r => `<tr data-href="#/receipt/${r.id}">
          <td><a href="#/receipt/${r.id}"><strong>${esc(r.receipt_no)}</strong></a></td>
          <td>${r.status === 'open' && r.unloaded_at ? '<span class="badge open">Unloaded</span> ' : ''}${badge(r.status)}</td>
          ${multiOwner() ? `<td>${esc(ownerById(r.owner_id).code || '')}</td>` : ''}
          <td>${r.expected_at && !(r.pallets?.[0]?.count) ? 'Expected ' + esc(fmtDateTime(r.expected_at)) : esc(fmtDateTime(r.received_at))}</td>
          <td>${esc(r.dock_door || '')}</td><td>${esc(r.vendor_name || '')}</td><td>${esc(r.carrier || '')}</td>
          <td>${esc(r.trailer_no || '')}</td><td>${esc(r.po_number || '')}</td><td class="num">${r.pallets?.[0]?.count ?? 0}</td></tr>`).join('')}</tbody>
      </table></div>`;
    render(`
      <a class="back" href="#/">&larr; Home</a>
      <div class="row spread"><h1>Receiving${multiWh() ? ' <span class="wh-tag">' + esc(whById(S.whId).code) + '</span>' : ''}</h1>
        ${can('operator') ? `<a class="btn" href="#/receipt/new">New Receipt</a>` : ''}</div>
      <h2>Open</h2>
      ${open.length ? `<div class="list mlist">${open.map(item).join('')}</div>${table(open)}` : `<p class="muted">No open receipts.</p>`}
      <h2 style="margin-top:20px">Recent</h2>
      ${rest.length ? `<div class="list mlist">${rest.map(item).join('')}</div>${table(rest)}` : `<p class="muted">Nothing yet.</p>`}`);
    wireRowLinks();
  }

  /* ------------------------------------------------------------------ */
  /* receiving: new receipt                                              */
  /* ------------------------------------------------------------------ */
  function receiptHeaderFields(r = {}, isNew = false, lockScope = false) {
    return `
      <div class="grid2">
        <div class="field"><label for="owner_id">Customer account</label>
          <select id="owner_id" required ${lockScope ? 'disabled' : ''}>${ownerOptions(r.owner_id)}</select>
          ${lockScope ? '<div class="hint">Locked: pallets have been received.</div>' : ''}</div>
        <div class="field"><label>Warehouse</label>
          <input value="${esc(whById(r.warehouse_id || S.whId).code || '')} — ${esc(whById(r.warehouse_id || S.whId).name || '')}" readonly></div>
        ${isNew ? '' : `<div class="field"><label for="received_at">Received</label>
          <input id="received_at" type="datetime-local" value="${esc(toLocalInput(r.received_at))}" required></div>`}
        <div class="field"><label for="expected_at">Expected arrival ${isNew ? '<span class="muted small">(leave blank if the truck is here now)</span>' : ''}</label>
          <input id="expected_at" type="datetime-local" value="${r.expected_at ? esc(toLocalInput(r.expected_at)) : ''}"></div>
        <div class="field"><label for="dock_door">Dock door</label>
          <input id="dock_door" value="${esc(r.dock_door || '')}" maxlength="20"></div>
        <div class="field"><label for="vendor_name">From / Vendor</label>
          <input id="vendor_name" value="${esc(r.vendor_name || '')}" maxlength="120" list="vendor-list" autocomplete="off">
          <datalist id="vendor-list">${vendorSuggestions.map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist></div>
        <div class="field"><label for="carrier">Carrier</label>
          <input id="carrier" value="${esc(r.carrier || '')}" maxlength="120"></div>
        <div class="field"><label for="trailer_no">Trailer #</label>
          <input id="trailer_no" value="${esc(r.trailer_no || '')}" maxlength="40"></div>
        <div class="field"><label for="seal_no">Seal #</label>
          <input id="seal_no" value="${esc(r.seal_no || '')}" maxlength="40"></div>
        <div class="field"><label for="po_number">PO #</label>
          <input id="po_number" value="${esc(r.po_number || '')}" maxlength="60"></div>
        <div class="field"><label for="inbound_bol">Inbound BOL / PRO</label>
          <input id="inbound_bol" value="${esc(r.inbound_bol || '')}" maxlength="60"></div>
      </div>
      <div class="field"><label for="notes">Notes</label>
        <textarea id="notes" maxlength="1000">${esc(r.notes || '')}</textarea></div>`;
  }
  // saved vendors first, then names typed on recent receipts
  let vendorSuggestions = [];
  async function loadVendorSuggestions() {
    const recent = await q(sb.from('receipts').select('vendor_name').not('vendor_name', 'is', null)
      .order('received_at', { ascending: false }).limit(300));
    const saved = S.parties.filter(p => p.active && p.party_type !== 'consignee').map(p => p.name);
    const seen = new Set(); vendorSuggestions = [];
    for (const n of [...saved, ...recent.map(r => r.vendor_name)]) {
      const k = n.trim().toUpperCase();
      if (k && !seen.has(k)) { seen.add(k); vendorSuggestions.push(n.trim()); }
    }
  }
  // typed "one source plant" -> stored as the saved vendor's spelling
  function savedVendorName(name) {
    if (!name) return null;
    const m = S.parties.find(p => p.party_type !== 'consignee' && p.name.trim().toUpperCase() === name.trim().toUpperCase());
    return m ? m.name : name;
  }
  function vendorIdFor(name) {
    if (!name) return null;
    const m = S.parties.find(p => p.party_type !== 'consignee' && p.name.trim().toUpperCase() === name.trim().toUpperCase());
    return m ? m.id : null;
  }

  function readReceiptHeader(root) {
    const v = id => $('#' + id, root).value;
    const row = {
      ...(!$('#owner_id', root).disabled ? { owner_id: v('owner_id') || null } : {}),
      expected_at: v('expected_at') ? new Date(v('expected_at')).toISOString() : null,
      dock_door: strOrNull(v('dock_door')),
      vendor_name: savedVendorName(strOrNull(v('vendor_name'))),
      vendor_id: vendorIdFor(strOrNull(v('vendor_name'))),
      carrier: strOrNull(v('carrier')),
      trailer_no: strOrNull(v('trailer_no')),
      seal_no: strOrNull(v('seal_no')),
      po_number: strOrNull(v('po_number')),
      inbound_bol: strOrNull(v('inbound_bol')),
      notes: strOrNull(v('notes'))
    };
    if ($('#received_at', root)) row.received_at = new Date(v('received_at')).toISOString();
    return row;
  }

  async function viewNewReceipt() {
    if (!can('operator')) { location.hash = '#/receipts'; return; }
    const mySeq = navSeq;
    await loadVendorSuggestions().catch(() => {});
    if (mySeq !== navSeq) return;
    render(`
      <a class="back" href="#/receipts">&larr; Receiving</a>
      <h1>New Receipt</h1>
      <form id="new-rcpt" class="card accent">
        ${receiptHeaderFields({}, true)}
        <button class="btn block" id="create-btn">Create Receipt</button>
      </form>`);
    $('#new-rcpt').onsubmit = e => {
      e.preventDefault();
      busy($('#create-btn'), async () => {
        const hdr = readReceiptHeader($('#new-rcpt'));
        if (!hdr.owner_id) throw new Error('Pick the customer account.');
        const row = await q(sb.from('receipts').insert({ ...hdr, warehouse_id: S.whId }).select('id, receipt_no').single());
        toast(`${row.receipt_no} created.`);
        location.hash = '#/receipt/' + row.id;
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* receiving: receipt detail + add pallets                             */
  /* ------------------------------------------------------------------ */
  function palletForPrint(p, rcpt) {
    const it = itemById(p.item_id);
    return {
      ...p,
      sku: it.sku, description: it.description, uom: it.uom,
      qty: p.status === 'on_hand' || p.status === 'hold' ? p.qty_on_hand : p.qty_received,
      location: locById(p.location_id).code,
      received_at: rcpt.received_at, receipt_no: rcpt.receipt_no,
      warehouse_code: whById(locById(p.location_id).warehouse_id || rcpt.warehouse_id).code,
      owner_code: ownerById(rcpt.owner_id).code
    };
  }

  async function viewReceipt(id, focusId, dockMode = isLift()) {
    const mySeq = navSeq;
    if (!document.querySelector('#rcpt-page')) render(`<div class="loading">Loading...</div>`);
    const [rcpt, pallets] = await Promise.all([
      q(sb.from('receipts').select('*').eq('id', id).single()),
      q(sb.from('pallets')
        .select('id, lp_id, customer_pallet_id, ref1, ref2, item_id, lot_number, production_date, expiration_date, qty_received, qty_on_hand, location_id, status, notes')
        .eq('receipt_id', id).order('lp_id'))
    ]);
    if (rcpt.status === 'open' && can('operator') && !dockMode) await loadVendorSuggestions().catch(() => {});
    if (mySeq !== navSeq) return;
    const active = pallets.filter(p => p.status !== 'void');
    const totalQty = active.reduce((a, p) => a + Number(p.qty_received), 0);
    const activeUoms = [...new Set(active.map(p => itemById(p.item_id).uom))];
    const totalText = active.length && activeUoms.length === 1 ? ` &middot; ${esc(fmtQty(totalQty))} ${esc(activeUoms[0])}` : '';
    const isOpen = rcpt.status === 'open';
    const editable = isOpen && can('operator') && !dockMode;   // receipt details: office only
    const canReceive = isOpen && canDock();
    const activeItems = itemsFor(rcpt.owner_id);
    // remembered entries carry over within a receipt; a lot/bin never carries to a different truck
    const last = { ...(S.lastReceive || {}) };
    if (last.receipt_id !== rcpt.id) delete last.lot;
    const lastItem = activeItems.find(i => i.id === last.item_id);
    const rcptLocs = whLocations(rcpt.warehouse_id);
    const dock = rcptLocs.find(l => l.code.toUpperCase() === 'DOCK');
    const lastLocOk = rcptLocs.some(l => l.id === last.location_id);
    const printPref = loadPref('printLabels', true);
    const copiesPref = loadPref('labelCopies', 1);

    const headerView = `
      <dl class="kv">
        <dt>Account</dt><dd>${esc(ownerById(rcpt.owner_id).code || '')} — ${esc(ownerById(rcpt.owner_id).name || '')}</dd>
        ${multiWh() ? `<dt>Warehouse</dt><dd>${esc(whById(rcpt.warehouse_id).code)}</dd>` : ''}
        ${rcpt.expected_at ? `<dt>Expected</dt><dd>${esc(fmtDateTime(rcpt.expected_at))}</dd>` : ''}
        ${active.length || !rcpt.expected_at ? `<dt>Received</dt><dd>${esc(fmtDateTime(rcpt.received_at))}</dd>` : ''}
        ${rcpt.dock_door ? `<dt>Door</dt><dd>${esc(rcpt.dock_door)}</dd>` : ''}
        <dt>From / Vendor</dt><dd>${esc(rcpt.vendor_name || '-')}</dd>
        <dt>Carrier</dt><dd>${esc(rcpt.carrier || '-')}</dd>
        <dt>Trailer #</dt><dd>${esc(rcpt.trailer_no || '-')}</dd>
        <dt>Seal #</dt><dd>${esc(rcpt.seal_no || '-')}</dd>
        <dt>PO #</dt><dd>${esc(rcpt.po_number || '-')}</dd>
        <dt>Inbound BOL</dt><dd>${esc(rcpt.inbound_bol || '-')}</dd>
        ${rcpt.notes ? `<dt>Notes</dt><dd>${esc(rcpt.notes)}</dd>` : ''}
        ${rcpt.status === 'void' ? `<dt>Void reason</dt><dd>${esc(rcpt.void_reason || '')}</dd>` : ''}
      </dl>`;

    const addForm = !canReceive ? '' : activeItems.length === 0 ? `
      <div class="card"><div class="notice warn">No items set up yet for account ${esc(ownerById(rcpt.owner_id).code || '')}.
        ${can('manager') ? 'Add items in <a href="#/setup/items">Setup</a> first.' : 'Ask a manager to add items.'}</div></div>` : `
      <form id="add-form" class="card accent" autocomplete="off">
        <h2>Receive Pallets</h2>
        <div class="field"><label for="item_id">Item</label>
          <select id="item_id" required>
            <option value="">Select item...</option>
            ${activeItems.map(i => `<option value="${i.id}" ${lastItem && lastItem.id === i.id ? 'selected' : ''}>${esc(i.sku)} — ${esc(i.description)}</option>`).join('')}
          </select></div>
        <div class="grid2">
          <div class="field"><label for="lot">${esc(lbl.lot())} <span id="lot-req" class="muted small"></span></label>
            <div class="input-scan"><input id="lot" value="${esc(last.lot || '')}" maxlength="60">${scanBtn('lot')}</div></div>
          <div class="field"><label for="qty">Qty per pallet <span id="uom" class="muted small"></span></label>
            <input id="qty" type="number" inputmode="decimal" min="0.01" step="any" value="${esc(last.qty ?? '')}" required></div>
          <div class="field"><label for="count">Number of pallets</label>
            <input id="count" type="number" inputmode="numeric" min="1" max="50" step="1" value="1" required>
            <div class="hint">Same item, ${esc(lbl.lotShort().toLowerCase())} and qty on each.</div></div>
          <div class="field"><label for="location_id">Put to location</label>
            <select id="location_id">
              ${rcptLocs.map(l => `<option value="${l.id}" ${(lastLocOk ? last.location_id === l.id : dock && dock.id === l.id) ? 'selected' : ''}>${esc(l.code)}</option>`).join('')}
            </select></div>
        </div>
        ${idFields().map(f => `
        <div class="field"><label for="${f.key}">${esc(f.label)} <span class="muted small">${f.required ? '(required)' : '(optional)'}</span></label>
          <div class="input-scan"><input id="${f.key}" maxlength="60" ${f.required ? 'required' : ''}
            ${f.key === 'cust_id' && !f.required ? 'placeholder="Leave blank to use ours"' : ''}>${scanBtn(f.key)}</div>
          ${f.unique ? '<div class="hint">Unique per pallet: receive one pallet at a time when filled in.</div>' : ''}</div>`).join('')}
        <details class="more"><summary>More: dates and notes</summary>
          <div class="grid2">
            <div class="field"><label for="prod_date">Production date</label><input id="prod_date" type="date"></div>
            <div class="field"><label for="exp_date">Expiration date</label><input id="exp_date" type="date"></div>
          </div>
          <div class="field"><label for="p_notes">Pallet notes</label><input id="p_notes" maxlength="200"></div>
        </details>
        <div class="row" style="margin:6px 0 12px">
          <label class="check"><input type="checkbox" id="print_labels" ${printPref ? 'checked' : ''}> Print labels</label>
          <label class="check">Copies
            <select id="copies" style="width:auto;min-height:40px">
              ${[1, 2, 3, 4].map(n => `<option ${n === copiesPref ? 'selected' : ''}>${n}</option>`).join('')}
            </select></label>
        </div>
        <button class="btn block" id="receive-btn">Receive</button>
      </form>`;

    const palletRow = p => {
      const it = itemById(p.item_id);
      const canVoid = p.status !== 'void' && p.status !== 'shipped' && (can('manager') || (isOpen && canDock()));
      return `
        <div class="list-item pallet ${p.status === 'void' ? 'void' : ''}" ${focusId === p.id ? 'style="border-color:var(--red)"' : ''}>
          <div>
            <div class="lp">${esc(p.lp_id)} ${p.status !== 'on_hand' ? badge(p.status) : ''}</div>
            <div><strong>${esc(it.sku)}</strong> &middot; ${lotText(p)}</div>
            <div class="meta">${esc(locLabel(p.location_id))}${p.expiration_date ? ' &middot; Exp ' + esc(fmtDate(p.expiration_date)) : ''}</div>
            ${idText(p) ? `<div class="meta">${idText(p)}</div>` : ''}
          </div>
          <div class="qty">${esc(fmtQty(p.qty_received))}<div class="meta">${esc(it.uom || '')}</div></div>
          ${p.status !== 'void' ? `<div class="row" style="grid-column:1/-1">
            <button class="btn sm secondary" data-label="${p.id}">Label</button>
            ${canVoid ? `<button class="btn sm danger" data-void="${p.id}">Void</button>` : ''}
          </div>` : ''}
        </div>`;
    };

    render(`
      <div id="rcpt-page">
        ${dockMode ? `<a class="back" href="#/dock/unload">&larr; Unload</a>` : `<a class="back" href="#/receipts">&larr; Receiving</a>`}
        <div class="row spread"><h1>${esc(rcpt.receipt_no)}</h1>${badge(rcpt.status)}</div>
        ${isOpen && rcpt.unloaded_at ? `<div class="notice ok">Unloaded ${esc(fmtDateTime(rcpt.unloaded_at))}${userName(rcpt.unloaded_by) ? ' by ' + esc(userName(rcpt.unloaded_by)) : ''}.${dockMode ? ' The office will close it.' : ' Review and close when ready.'}</div>` : ''}

        <div class="card">
          ${editable ? `
            <details id="hdr-details" ${active.length === 0 ? 'open' : ''}><summary class="row spread" style="cursor:pointer">
              <h2 style="margin:0">Load Details</h2><span class="muted small">${esc([rcpt.carrier, rcpt.trailer_no && 'Trailer ' + rcpt.trailer_no].filter(Boolean).join(' · ') || 'tap to edit')}</span></summary>
              <form id="hdr-form" style="margin-top:12px">${receiptHeaderFields(rcpt, !!rcpt.expected_at && pallets.length === 0, pallets.some(p => p.status !== 'void'))}
                <button class="btn secondary block" id="hdr-save">Save Load Details</button></form>
            </details>` : `<h2>Load Details</h2>${headerView}`}
        </div>

        ${addForm}

        <div class="card">
          <div class="row spread"><h2 style="margin:0">Pallets</h2>
            <span class="muted">${active.length} pallet${active.length === 1 ? '' : 's'}${totalText}</span></div>
          <div style="margin-top:12px">${pallets.length ? pallets.map(palletRow).join('') : '<p class="muted">No pallets yet.</p>'}</div>
        </div>

        ${!dockMode && can('operator') && rcpt.status !== 'void' ? '<div class="card" id="charges-card"></div>' : ''}

        ${dockMode ? `
        <div class="btn-row">
          <button class="btn secondary" id="print-all" ${active.length ? '' : 'disabled'}>Print All Labels</button>
          ${isOpen && !rcpt.unloaded_at ? `<button class="btn" id="done-unload" ${active.length ? '' : 'disabled'}>Done Unloading</button>` : ''}
        </div>` : `
        <div class="btn-row">
          <button class="btn dark" id="print-rcpt" ${active.length ? '' : 'disabled'}>Print Receipt</button>
          <button class="btn secondary" id="print-all" ${active.length ? '' : 'disabled'}>Print All Labels</button>
          ${isOpen && can('operator') ? `<button class="btn secondary" id="print-unload">Print Unload Sheet</button>` : ''}
          ${isOpen && can('operator') ? `<button class="btn" id="close-rcpt">Close Receipt</button>` : ''}
          ${rcpt.status === 'closed' && can('manager') ? `<button class="btn secondary" id="reopen-rcpt">Reopen</button>` : ''}
          ${rcpt.status !== 'void' && can('manager') ? `<button class="btn danger" id="void-rcpt">Void Receipt</button>` : ''}
        </div>`}
      </div>`);

    const page = $('#rcpt-page');
    wireScanButtons(page);
    const reload = fid => viewReceipt(id, fid, dockMode);
    wireCharges($('#charges-card', page), { receipt_id: id, owner_id: rcpt.owner_id, warehouse_id: rcpt.warehouse_id });

    /* header save */
    $('#hdr-form', page)?.addEventListener('submit', e => {
      e.preventDefault();
      busy($('#hdr-save'), async () => {
        await q(sb.from('receipts').update(readReceiptHeader($('#hdr-form'))).eq('id', id));
        await reload();
        toast('Load details saved.');
      });
    });

    /* add pallets */
    const form = $('#add-form', page);
    if (form) {
      const itemSel = $('#item_id', form);
      const syncItem = (fromChange) => {
        const it = itemById(itemSel.value);
        $('#lot-req', form).textContent = it.id ? (it.lot_required ? '(required)' : '(optional)') : '';
        $('#uom', form).textContent = it.uom ? `(${it.uom})` : '';
        $('#lot', form).required = !!it.lot_required;
        if (fromChange && it.units_per_pallet) $('#qty', form).value = Number(it.units_per_pallet);
      };
      itemSel.addEventListener('change', () => syncItem(true));
      syncItem(false);
      if (!$('#qty', form).value) { const it = itemById(itemSel.value); if (it.units_per_pallet) $('#qty', form).value = Number(it.units_per_pallet); }

      // a handheld scanner sends Enter after each scan: step through the
      // identifier fields, then Receive, instead of submitting early
      const ids = idFields();
      $('#lot', form).addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); $('#qty', form).focus(); }
      });
      ids.forEach((f, i) => $('#' + f.key, form).addEventListener('keydown', ev => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        const next = ids[i + 1];
        if (next) $('#' + next.key, form).focus();
        else form.requestSubmit();
      }));

      form.onsubmit = e => {
        e.preventDefault();
        busy($('#receive-btn', form), async () => {
          const it = itemById(itemSel.value);
          const qty = numOrNull($('#qty', form).value);
          const count = Math.floor(Number($('#count', form).value || 1));
          const lot = strOrNull($('#lot', form).value);
          const vals = Object.fromEntries(ids.map(f => [f.key, strOrNull($('#' + f.key, form).value)]));
          const locId = $('#location_id', form).value || null;
          if (!it.id) throw new Error('Select an item.');
          if (!qty || qty <= 0) throw new Error('Enter a quantity greater than zero.');
          if (count < 1 || count > 50) throw new Error('Number of pallets must be 1 to 50.');
          if (it.lot_required && !lot) throw new Error(`${lbl.lot()} is required for ${it.sku}.`);
          for (const f of ids) {
            if (f.required && !vals[f.key]) throw new Error(`${f.label} is required.`);
            if (f.unique && vals[f.key] && count > 1) throw new Error(`${f.label} is unique per pallet. Receive one pallet at a time.`);
          }

          const doPrint = $('#print_labels', form).checked;
          const copies = Number($('#copies', form).value) || 1;
          savePref('printLabels', doPrint); savePref('labelCopies', copies);
          S.lastReceive = { receipt_id: rcpt.id, item_id: it.id, lot, qty, location_id: locId };
          savePref('lastReceive', S.lastReceive);

          const received = [];
          try {
            for (let i = 0; i < count; i++) {
              received.push(await q(sb.rpc('wms_receive_pallet', {
                p_receipt_id: id,
                p_item_id: it.id,
                p_qty: qty,
                p_lot_number: lot,
                p_location_id: locId,
                p_customer_pallet_id: vals.cust_id,
                p_production_date: $('#prod_date', form).value || null,
                p_expiration_date: $('#exp_date', form).value || null,
                p_notes: strOrNull($('#p_notes', form).value),
                ...(lbl.ref1() ? { p_ref1: vals.ref1 } : {}),
                ...(lbl.ref2() ? { p_ref2: vals.ref2 } : {})
              })));
            }
          } catch (err) {
            if (received.length) {
              toast(`Received ${received.length} of ${count}, then stopped: ${friendly(err)}`, 'bad');
            } else throw err;
          }
          if (!received.length) return;

          await reload(received[received.length - 1].id);   // form ready before confirming
          if (received.length === count) {
            toast(received.length === 1 ? `Received ${received[0].lp_id}.`
              : `Received ${received.length} pallets: ${received[0].lp_id} to ${received[received.length - 1].lp_id}.`);
          }
          // ready for the next pallet: back to the first identifier that was used
          const firstUsed = ids.find(f => vals[f.key] || f.required);
          (firstUsed ? $('#' + firstUsed.key) : $('#qty'))?.focus();
          if (doPrint) WmsPrint.labels(received.map(p => palletForPrint(p, rcpt)), docSettings(rcpt.warehouse_id), copies);
        });
      };
    }

    /* pallet buttons */
    $$('[data-label]', page).forEach(b => b.onclick = () => {
      const p = pallets.find(x => x.id === b.dataset.label);
      WmsPrint.labels([palletForPrint(p, rcpt)], docSettings(rcpt.warehouse_id), loadPref('labelCopies', 1));
    });
    $$('[data-void]', page).forEach(b => b.onclick = async () => {
      const p = pallets.find(x => x.id === b.dataset.void);
      const reason = await askReason(`Void ${p.lp_id}?`,
        `This removes the pallet from inventory. The label for ${esc(p.lp_id)} should be thrown away.`, 'Void Pallet');
      if (!reason) return;
      busy(null, async () => {
        await q(sb.rpc('wms_void_pallet', { p_pallet_id: p.id, p_reason: reason }));
        await reload();
        toast(`${p.lp_id} voided.`);
      });
    });

    /* receipt actions */
    $('#print-rcpt', page)?.addEventListener('click', () =>
      WmsPrint.receipt(rcpt, active.map(p => palletForPrint(p, rcpt)), docSettings(rcpt.warehouse_id), ownerById(rcpt.owner_id)));
    $('#print-unload', page)?.addEventListener('click', () => WmsPrint.unloadSheet(rcpt, docSettings(rcpt.warehouse_id), ownerById(rcpt.owner_id)));
    $('#done-unload', page)?.addEventListener('click', async () => {
      const ok = await askConfirm('Done unloading?',
        `${active.length} pallet${active.length === 1 ? '' : 's'} received on ${esc(rcpt.receipt_no)}. The office will review and close it.`, 'Done Unloading');
      if (!ok) return;
      busy($('#done-unload'), async () => {
        await q(sb.rpc('wms_mark_unloaded', { p_receipt_id: id }));
        toast(`${rcpt.receipt_no} marked unloaded.`);
        location.hash = '#/dock/unload';
      });
    });
    $('#print-all', page).onclick = () =>
      WmsPrint.labels(active.filter(p => p.status !== 'shipped').map(p => palletForPrint(p, rcpt)), docSettings(rcpt.warehouse_id), loadPref('labelCopies', 1));

    $('#close-rcpt', page)?.addEventListener('click', async () => {
      const msg = active.length
        ? `Close ${esc(rcpt.receipt_no)} with ${active.length} pallet${active.length === 1 ? '' : 's'}? No more pallets can be added after closing.`
        : `${esc(rcpt.receipt_no)} has no pallets. Close it anyway?`;
      if (!await askConfirm('Close receipt?', msg, 'Close Receipt')) return;
      busy($('#close-rcpt'), async () => {
        await q(sb.rpc('wms_close_receipt', { p_receipt_id: id }));
        await reload();
        toast(`${rcpt.receipt_no} closed.`);
      });
    });
    $('#reopen-rcpt', page)?.addEventListener('click', () => busy($('#reopen-rcpt'), async () => {
      await q(sb.rpc('wms_reopen_receipt', { p_receipt_id: id }));
      await reload();
      toast(`${rcpt.receipt_no} reopened.`);
    }));
    $('#void-rcpt', page)?.addEventListener('click', async () => {
      const reason = await askReason(`Void ${rcpt.receipt_no}?`,
        'Every pallet on this receipt will be removed from inventory. This only works if nothing from it has shipped.', 'Void Receipt');
      if (!reason) return;
      busy(null, async () => {
        await q(sb.rpc('wms_void_receipt', { p_receipt_id: id, p_reason: reason }));
        await reload();
        toast(`${rcpt.receipt_no} voided.`);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* inventory lookup                                                    */
  /* ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ */
  /* inventory: filterable table, print, location (count) report         */
  /* ------------------------------------------------------------------ */
  const INV_DEFAULT = { acct: '', loc: '', q: '', status: '', view: 'pallets', allWh: false, sort: 'location', dir: 1 };

  async function viewInventory() {
    if (isLift()) { location.hash = '#/dock'; return; }
    const mySeq = navSeq;
    const f = { ...INV_DEFAULT, ...loadPref('invFilter', {}) };
    if (f.acct && !ownerById(f.acct).id) f.acct = '';
    if (!multiWh()) f.allWh = false;
    if (!document.querySelector('#inv-page')) render(`<div class="loading">Loading...</div>`);
    const all = await fetchAll(() => {
      const qb = sb.from('v_inventory').select('*');
      return (f.allWh ? qb : qb.eq('warehouse_id', S.whId)).order('pallet_id');
    });
    if (mySeq !== navSeq) return;
    const ids = idFields();
    render(`
      <div id="inv-page">
        <a class="back" href="#/">&larr; Home</a>
        <div class="row spread"><h1>Inventory${multiWh() ? ` <span class="wh-tag">${esc(f.allWh ? 'ALL' : whById(S.whId).code)}</span>` : ''}</h1>
          <a class="btn ghost sm" href="#/lookup">Scan Lookup</a></div>
        <div class="card filters">
          <div class="filter-row">
            <div class="field grow"><label for="inv-q">Search</label>
              <input id="inv-q" value="${esc(f.q)}" placeholder="e.g. 1234 10-08/26" autocomplete="off" enterkeyhint="search"></div>
            <div class="field"><label for="inv-loc">Location / bay</label>
              <input id="inv-loc" value="${esc(f.loc)}" placeholder="e.g. A01" autocomplete="off" autocapitalize="characters" list="inv-locs"></div>
            <datalist id="inv-locs">${(f.allWh ? S.locations : whLocations()).filter(l => l.active).map(l => `<option value="${esc(l.code)}"></option>`).join('')}</datalist>
            ${multiOwner() ? `<div class="field"><label for="inv-acct">Account</label>
              <select id="inv-acct"><option value="">All accounts</option>${activeOwners().map(o => `<option value="${o.id}" ${o.id === f.acct ? 'selected' : ''}>${esc(o.code)} — ${esc(o.name)}</option>`).join('')}</select></div>` : ''}
            <div class="field"><label for="inv-status">Status</label>
              <select id="inv-status"><option value="">On hand + hold</option><option value="on_hand" ${f.status === 'on_hand' ? 'selected' : ''}>On hand only</option><option value="hold" ${f.status === 'hold' ? 'selected' : ''}>On hold only</option></select></div>
            <div class="field"><label for="inv-view">Show</label>
              <select id="inv-view"><option value="pallets">Each pallet</option><option value="lots" ${f.view === 'lots' ? 'selected' : ''}>Item &amp; ${esc(lbl.lotShort().toLowerCase())} totals</option></select></div>
          </div>
          <div class="row spread" style="margin-top:4px">
            <div class="row">
              ${multiWh() ? `<label class="check"><input type="checkbox" id="inv-allwh" ${f.allWh ? 'checked' : ''}> All warehouses</label>` : ''}
              <span class="muted small">Every word must match: SKU, description, ${esc(lbl.lotShort().toLowerCase())}, pallet IDs or location.</span>
            </div>
            <div class="row">
              <button class="btn ghost sm" id="inv-clear" type="button">Clear</button>
              <button class="btn secondary sm" id="inv-csv" type="button">Export CSV</button>
              <button class="btn secondary sm" id="inv-print" type="button">Print List</button>
              <button class="btn dark sm" id="inv-count" type="button">Location Report (QR)</button>
            </div>
          </div>
        </div>
        <div id="inv-out"></div>
      </div>`);

    const save = () => savePref('invFilter', f);
    const words = () => f.q.toUpperCase().split(/\s+/).filter(Boolean);
    const matchRows = () => {
      const w = words(), loc = f.loc.trim().toUpperCase();
      return all.filter(p => {
        if (f.acct && p.owner_id !== f.acct) return false;
        if (f.status && p.status !== f.status) return false;
        if (loc && !String(p.location || '').toUpperCase().startsWith(loc)) return false;
        if (w.length) {
          const hay = [p.lp_id, p.customer_pallet_id, p.ref1, p.ref2, p.sku, p.description, p.lot_number, p.location, p.owner_code].join(' ').toUpperCase();
          if (!w.every(x => hay.includes(x))) return false;
        }
        return true;
      });
    };
    const lotRows = rows => {
      const m = {};
      for (const p of rows) {
        const k = [p.warehouse_id, p.item_id, p.lot_number || ''].join('|');
        const r = m[k] = m[k] || { warehouse_code: p.warehouse_code, owner_code: p.owner_code, sku: p.sku, description: p.description, lot_number: p.lot_number, uom: p.uom, pallets: 0, qty: 0, hold: 0, locs: new Set(), oldest: p.received_at };
        r.pallets++; r.qty += Number(p.qty_on_hand); if (p.status === 'hold') r.hold++;
        if (p.location) r.locs.add(p.location);
        if (p.received_at < r.oldest) r.oldest = p.received_at;
      }
      return Object.values(m).map(r => ({ ...r, locations: [...r.locs].sort().join(', ') }));
    };
    const palletCols = () => [
      ['location', 'Location'], ['lp_id', 'WMS Pallet ID'], ...ids.map(x => [x.field, x.label]),
      ['sku', 'SKU'], ['description', 'Description', 'wrap'], ['lot_number', lbl.lotShort()], ['qty_on_hand', 'Qty', 'num'], ['uom', 'UOM'],
      ['status', 'Status'], ['received_at', 'Received'], ['days', 'Days', 'num'],
      ...(multiOwner() ? [['owner_code', 'Account']] : []), ...(f.allWh ? [['warehouse_code', 'Whse']] : [])];
    const lotCols = () => [
      ['sku', 'SKU'], ['description', 'Description', 'wrap'], ['lot_number', lbl.lotShort()], ...(multiOwner() ? [['owner_code', 'Account']] : []),
      ...(f.allWh ? [['warehouse_code', 'Whse']] : []), ['pallets', 'Pallets', 'num'], ['qty', 'Qty', 'num'], ['uom', 'UOM'],
      ['hold', 'On hold', 'num'], ['locations', 'Locations', 'wrap'], ['oldest', 'Oldest received']];
    const sortVal = (r, k) => k === 'days' ? -new Date(r.received_at).getTime()
      : ['qty_on_hand', 'qty', 'pallets', 'hold'].includes(k) ? Number(r[k]) : String(r[k] ?? '').toUpperCase();
    const sorted = (rows, cols) => {
      const k = cols.some(c => c[0] === f.sort) ? f.sort : cols[0][0];
      return rows.slice().sort((a, b) => {
        const x = sortVal(a, k), y = sortVal(b, k);
        return (x < y ? -1 : x > y ? 1 : String(a.lp_id || a.sku).localeCompare(String(b.lp_id || b.sku), undefined, { numeric: true })) * f.dir;
      });
    };
    const cell = (r, k) => {
      if (k === 'qty_on_hand' || k === 'qty') return esc(fmtQty(r[k]));
      if (k === 'received_at' || k === 'oldest') return esc(fmtDate(r[k]));
      if (k === 'days') return String(daysOld(r.received_at));
      if (k === 'status') return r.status === 'hold' ? badge('hold') : 'On hand';
      if (k === 'lp_id') return `<strong class="mono">${esc(r.lp_id)}</strong>`;
      if (k === 'hold') return r.hold ? String(r.hold) : '-';
      return esc(r[k] ?? '');
    };
    let current = { rows: [], cols: [], pallets: [] };

    const draw = () => {
      const pallets = matchRows();
      const isLots = f.view === 'lots';
      const cols = isLots ? lotCols() : palletCols();
      const rows = sorted(isLots ? lotRows(pallets) : pallets, cols);
      current = { rows, cols, pallets };
      const uoms = [...new Set(pallets.map(p => p.uom))];
      const qty = pallets.reduce((a, p) => a + Number(p.qty_on_hand), 0);
      const shown = rows.slice(0, 500);
      const sortK = cols.some(c => c[0] === f.sort) ? f.sort : cols[0][0];
      $('#inv-out').innerHTML = `
        <div class="row spread" style="margin:4px 0 8px">
          <strong>${pallets.length.toLocaleString()} pallet${pallets.length === 1 ? '' : 's'}${uoms.length === 1 ? ` &middot; ${esc(fmtQty(qty))} ${esc(uoms[0])}` : ''}${isLots ? ` &middot; ${rows.length} item/${esc(lbl.lotShort().toLowerCase())} line${rows.length === 1 ? '' : 's'}` : ''}</strong>
          <span class="muted small">${rows.length > 500 ? 'Showing the first 500. Export or narrow the filters to see all.' : 'Click a column to sort.'}</span>
        </div>
        ${rows.length ? `<div class="card table-card"><div class="table-wrap"><table class="data inv-table">
          <thead><tr>${cols.map(([k, label, cls]) => `<th class="${cls || ''} sortable" data-sort="${k}">${esc(label)}${k === sortK ? (f.dir > 0 ? ' &#9650;' : ' &#9660;') : ''}</th>`).join('')}</tr></thead>
          <tbody>${shown.map((r, i) => `<tr ${isLots ? `data-lot="${i}"` : `data-p="${i}"`}>${cols.map(([k, , cls]) => `<td class="${cls || ''}">${cell(r, k)}</td>`).join('')}</tr>`).join('')}</tbody>
          ${uoms.length === 1 ? `<tfoot><tr>${cols.map(([k, , cls], i) => `<td class="${cls || ''}">${i === 0 ? 'Total' : k === 'qty_on_hand' || k === 'qty' ? esc(fmtQty(qty)) : k === 'pallets' ? pallets.length : ''}</td>`).join('')}</tr></tfoot>` : ''}
        </table></div></div>` : `<div class="notice warn">Nothing on hand matches these filters.</div>`}`;
      $$('#inv-out th[data-sort]').forEach(th => th.onclick = () => {
        if (f.sort === th.dataset.sort) f.dir = -f.dir; else { f.sort = th.dataset.sort; f.dir = 1; }
        save(); draw();
      });
      $$('#inv-out tr[data-p]').forEach(tr => tr.onclick = () => palletModal(shown[Number(tr.dataset.p)], () => viewInventory()));
      $$('#inv-out tr[data-lot]').forEach(tr => tr.onclick = () => {
        const r = shown[Number(tr.dataset.lot)];
        f.view = 'pallets'; f.q = [r.sku, r.lot_number].filter(Boolean).join(' '); save();
        $('#inv-view').value = 'pallets'; $('#inv-q').value = f.q; draw();
      });
    };
    draw();

    let t;
    const later = () => { clearTimeout(t); t = setTimeout(() => { save(); draw(); }, 150); };
    $('#inv-q').oninput = e => { f.q = e.target.value; later(); };
    $('#inv-loc').oninput = e => { f.loc = e.target.value; later(); };
    $('#inv-acct')?.addEventListener('change', e => { f.acct = e.target.value; save(); draw(); });
    $('#inv-status').onchange = e => { f.status = e.target.value; save(); draw(); };
    $('#inv-view').onchange = e => { f.view = e.target.value; save(); draw(); };
    $('#inv-allwh')?.addEventListener('change', e => { f.allWh = e.target.checked; save(); viewInventory(); });
    $('#inv-clear').onclick = () => { Object.assign(f, { acct: '', loc: '', q: '', status: '' }); save(); viewInventory(); };
    const filterText = () => [f.q && `Search "${f.q}"`, f.loc && `Location ${f.loc.toUpperCase()}*`, f.acct && `Account ${ownerById(f.acct).code}`,
      f.status && (f.status === 'hold' ? 'On hold only' : 'On hand only'), f.allWh ? 'All warehouses' : multiWh() ? whById(S.whId).code : ''].filter(Boolean).join(' · ') || 'Everything on hand';
    $('#inv-csv').onclick = () => {
      const plain = (r, k) => k === 'days' ? daysOld(r.received_at) : k === 'received_at' || k === 'oldest' ? fmtDate(r[k]) : r[k];
      const n = downloadCsv(`inventory-${localStamp()}.csv`, current.cols.map(c => c[1]), current.rows.map(r => current.cols.map(([k]) => plain(r, k))));
      toast(`Exported ${n} row${n === 1 ? '' : 's'}.`);
    };
    $('#inv-print').onclick = () => {
      if (!current.rows.length) return toast('Nothing to print.', 'bad');
      const plain = (r, k) => k === 'days' ? String(daysOld(r.received_at)) : k === 'received_at' || k === 'oldest' ? fmtDate(r[k])
        : k === 'qty_on_hand' || k === 'qty' ? fmtQty(r[k]) : k === 'status' ? (r.status === 'hold' ? 'HOLD' : '') : String(r[k] ?? '');
      WmsPrint.table(f.view === 'lots' ? `Inventory by item & ${lbl.lotShort().toLowerCase()}` : 'Inventory by pallet', filterText(),
        current.cols.map(([k, label, cls]) => ({ label, num: cls === 'num' })), current.rows.map(r => current.cols.map(([k]) => plain(r, k))), S.settings);
    };
    $('#inv-count').onclick = () => {
      if (!current.pallets.length) return toast('Nothing to print.', 'bad');
      const rows = current.pallets.slice().sort((a, b) => String(a.location || '').localeCompare(String(b.location || ''), undefined, { numeric: true }) || a.lp_id.localeCompare(b.lp_id));
      WmsPrint.locationReport(rows, filterText(), S.settings);
    };
  }

  async function viewLookup(term) {
    const mySeq = navSeq;
    const stale = () => mySeq !== navSeq || !document.getElementById('lk-results');
    render(`
      <a class="back" href="${isLift() ? '#/dock' : '#/'}">&larr; ${isLift() ? 'Dock' : 'Home'}</a>
      <h1>Inventory Lookup</h1>
      <form id="lk-form" class="card">
        <label for="lk">Scan or search: WMS pallet ID, ${esc([...idFields().map(f => f.label), 'SKU', lbl.lotShort(), 'description'].join(', '))}</label>
        <div class="input-scan"><input id="lk" value="${esc(term)}" autocomplete="off" enterkeyhint="search">${scanBtn('lk', 'lk-form')}</div>
        <div class="btn-row"><button class="btn" id="lk-btn">Search</button>
          ${term ? `<a class="btn ghost" href="#/lookup">Show all on hand</a>` : ''}</div>
        ${multiWh() ? `<label class="check" style="margin-top:8px"><input type="checkbox" id="lk-allwh" ${loadPref('lookupAllWh', false) ? 'checked' : ''}> All warehouses</label>` : ''}
      </form>
      <div id="lk-results"><div class="loading">Loading...</div></div>`);
    const form = $('#lk-form');
    wireScanButtons(form);
    form.onsubmit = e => {
      e.preventDefault();
      const t = $('#lk').value.trim();
      const target = '#/lookup' + (t ? '/' + encodeURIComponent(t) : '');
      if (location.hash === target) viewLookup(t); else location.hash = target;
    };
    if (!term) setTimeout(() => $('#lk')?.focus(), 50);

    const out = $('#lk-results');
    const allWh = multiWh() && loadPref('lookupAllWh', false);
    const scope = qb => allWh ? qb : qb.eq('warehouse_id', S.whId);
    $('#lk-allwh')?.addEventListener('change', e => { savePref('lookupAllWh', e.target.checked); viewLookup(term); });
    const whOwnerText = r => [allWh || r.warehouse_id !== S.whId ? (multiWh() ? r.warehouse_code : '') : '', multiOwner() ? r.owner_code : ''].filter(Boolean).join(' · ');
    if (!term) {
      const rows = await q(scope(sb.from('v_inventory_by_lot').select('*')).order('sku').order('lot_number'));
      if (stale()) return;
      const totalPallets = rows.reduce((a, r) => a + Number(r.pallets), 0);
      out.innerHTML = `
        <div class="card"><div class="row spread"><h2 style="margin:0">On Hand by ${esc(lbl.lotShort())}${multiWh() ? ' <span class="wh-tag">' + esc(allWh ? 'ALL' : whById(S.whId).code) + '</span>' : ''}</h2>
          <span class="muted">${totalPallets} pallets</span></div>
          ${rows.length ? `<div class="table-wrap" style="margin-top:10px"><table class="data">
            <thead><tr><th>SKU</th><th>${esc(lbl.lotShort())}</th><th class="num">Pallets</th><th class="num">On hand</th><th class="num">Avail</th></tr></thead>
            <tbody>${rows.map(r => `<tr data-term="${esc(r.sku)}" style="cursor:pointer">
              <td><strong>${esc(r.sku)}</strong><div class="muted small">${esc(r.description)}${whOwnerText(r) ? ' &middot; ' + esc(whOwnerText(r)) : ''}</div></td>
              <td>${esc(r.lot_number || '-')}</td><td class="num">${r.pallets}</td>
              <td class="num">${esc(fmtQty(r.qty_on_hand))} ${esc(r.uom)}</td>
              <td class="num">${esc(fmtQty(r.qty_available))}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">Nothing on hand yet.</p>'}
        </div>`;
      $$('tr[data-term]', out).forEach(tr => tr.onclick = () => { location.hash = '#/lookup/' + encodeURIComponent(tr.dataset.term); });
      return;
    }

    // exact pallet match first (our pallet ID, customer pallet ID, ref1, ref2)
    let rows = await q(sb.rpc('wms_find_pallet', { p_code: term }));
    let exact = rows.length > 0;
    if (!exact) {
      const safe = term.replace(/[,()*%\\]/g, ' ').trim();
      rows = safe ? await q(scope(sb.from('v_inventory').select('*'))
        .or(`sku.ilike.*${safe}*,lot_number.ilike.*${safe}*,description.ilike.*${safe}*,lp_id.ilike.*${safe}*,customer_pallet_id.ilike.*${safe}*,ref1.ilike.*${safe}*,ref2.ilike.*${safe}*`)
        .order('sku').order('lot_number').order('lp_id').limit(200)) : [];
    }
    if (stale()) return;
    if (!rows.length) {
      out.innerHTML = `<div class="notice warn">Nothing in stock matches "${esc(term)}".</div>`;
      return;
    }
    const totalQty = rows.reduce((a, r) => a + Number(r.qty_on_hand), 0);
    const sameUom = rows.every(r => r.uom === rows[0].uom);
    out.innerHTML = `
      <p class="muted">${rows.length} pallet${rows.length === 1 ? '' : 's'}${sameUom ? ` &middot; ${esc(fmtQty(totalQty))} ${esc(rows[0].uom)}` : ''}${rows.length === 200 ? ' (first 200 shown)' : ''}</p>
      ${rows.map(r => `
        <a class="list-item pallet" href="#" data-pallet="${r.pallet_id}">
          <div>
            <div class="lp">${esc(r.lp_id)} ${r.status !== 'on_hand' ? badge(r.status) : ''}</div>
            <div><strong>${esc(r.sku)}</strong> &middot; ${lotText(r)}</div>
            <div class="meta">${esc(locLabel(r.location_id) || r.location || '')} &middot; Rcvd ${esc(fmtDate(r.received_at))}${multiOwner() ? ' &middot; ' + esc(r.owner_code) : ''}</div>
            ${idText(r) ? `<div class="meta">${idText(r)}</div>` : ''}
          </div>
          <div class="qty">${esc(fmtQty(r.qty_on_hand))}<div class="meta">${esc(r.uom)}</div></div>
        </a>`).join('')}`;
    $$('[data-pallet]', out).forEach(a => a.onclick = e => {
      e.preventDefault();
      palletModal(rows.find(r => r.pallet_id === a.dataset.pallet), () => viewLookup(term));
    });
    if (exact && rows.length === 1) palletModal(rows[0], () => viewLookup(term));
  }

  async function palletModal(p, onChange) {
    const body = openModal(p.lp_id, `<div class="loading">Loading...</div>`);
    const hist = await q(sb.from('v_transactions').select('*').eq('lp_id', p.lp_id).order('id', { ascending: false }).limit(50));
    if (!body.isConnected) return;
    // current warehouse first; other warehouses listed after (a move there is a transfer)
    const optFor = l => `<option value="${l.id}" ${l.id === p.location_id ? 'selected' : ''}>${esc(multiWh() ? whById(l.warehouse_id).code + ' ' + l.code : l.code)}</option>`;
    const locOptions = [...whLocations(p.warehouse_id || S.whId), ...S.locations.filter(l => l.active && l.warehouse_id !== (p.warehouse_id || S.whId))]
      .map(optFor).join('');
    body.innerHTML = `
      <dl class="kv">
        <dt>Item</dt><dd>${esc(p.sku)} — ${esc(p.description)}</dd>
        <dt>${esc(lbl.lot())}</dt><dd>${esc(p.lot_number || '-')}</dd>
        <dt>On hand</dt><dd>${esc(fmtQty(p.qty_on_hand))} ${esc(p.uom)}${Number(p.qty_allocated) ? ` (${esc(fmtQty(p.qty_allocated))} allocated)` : ''}</dd>
        <dt>Location</dt><dd>${esc(multiWh() ? (p.warehouse_code || '') + ' ' : '')}${esc(p.location || '-')}</dd>
        ${multiOwner() ? `<dt>Account</dt><dd>${esc(p.owner_code || '')} — ${esc(p.owner_name || '')}</dd>` : ''}
        <dt>Status</dt><dd>${badge(p.status)}</dd>
        ${idFields().filter(f => p[f.field]).map(f => `<dt>${esc(f.label)}</dt><dd>${esc(p[f.field])}</dd>`).join('')}
        ${p.production_date ? `<dt>Produced</dt><dd>${esc(fmtDate(p.production_date))}</dd>` : ''}
        ${p.expiration_date ? `<dt>Expires</dt><dd>${esc(fmtDate(p.expiration_date))}</dd>` : ''}
        <dt>Received</dt><dd><a href="#/receipt/${p.receipt_id}" id="pm-rcpt">${esc(p.receipt_no || '')}</a> ${esc(fmtDate(p.received_at))}</dd>
      </dl>

      ${canDock() ? `
        <form id="pm-move" class="row" style="margin-top:14px">
          <select id="pm-loc" style="flex:1">${locOptions}</select>
          <button class="btn" id="pm-move-btn">Move</button>
        </form>` : ''}

      <div class="btn-row">
        <button class="btn secondary" id="pm-label">Reprint Label</button>
        ${can('manager') ? `<button class="btn ghost" id="pm-adjust">Adjust Qty</button>
          <button class="btn ghost" id="pm-hold">${p.status === 'hold' ? 'Release Hold' : 'Put on Hold'}</button>` : ''}
      </div>

      <h3 style="margin-top:18px">History</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>When</th><th>Action</th><th class="num">Qty</th><th>Detail</th></tr></thead>
        <tbody>${hist.map(h => `<tr>
          <td class="small">${esc(fmtDateTime(h.created_at))}</td>
          <td>${esc(h.txn_type.replace('_', ' '))}</td>
          <td class="num">${Number(h.qty_change) ? esc((h.qty_change > 0 ? '+' : '') + fmtQty(h.qty_change)) : ''}</td>
          <td class="small">${esc([h.from_location && h.to_location ? `${h.from_location} → ${h.to_location}` : (h.to_location || ''),
            h.shipment_no, h.reason, h.user_name].filter(Boolean).join(' · '))}</td></tr>`).join('')}</tbody>
      </table></div>`;

    $('#pm-rcpt', body).onclick = () => closeModal();
    $('#pm-label', body).onclick = () => WmsPrint.labels([{ ...p, qty: p.qty_on_hand }], docSettings(p.warehouse_id), loadPref('labelCopies', 1));
    $('#pm-move', body)?.addEventListener('submit', e => {
      e.preventDefault();
      busy($('#pm-move-btn', body), async () => {
        const to = $('#pm-loc', body).value;
        if (to === p.location_id) { toast('Already in that location.'); return; }
        await q(sb.rpc('wms_move_pallet', { p_pallet_id: p.pallet_id, p_to_location_id: to }));
        const tl = locById(to);
        toast(`${p.lp_id} moved to ${tl.warehouse_id !== p.warehouse_id ? whById(tl.warehouse_id).code + ' ' : ''}${tl.code}.`);
        closeModal(); onChange && onChange();
      });
    });
    $('#pm-adjust', body)?.addEventListener('click', () => {
      body.innerHTML = `
        <p>Current quantity on <strong>${esc(p.lp_id)}</strong>: ${esc(fmtQty(p.qty_on_hand))} ${esc(p.uom)}</p>
        <form id="adj-form">
          <div class="field"><label for="adj-qty">Counted quantity</label>
            <input id="adj-qty" type="number" inputmode="decimal" min="0" step="any" required></div>
          <div class="field"><label for="adj-reason">Reason</label>
            <input id="adj-reason" required maxlength="200" placeholder="Cycle count, damage, etc."></div>
          <button class="btn block" id="adj-btn">Save Adjustment</button>
        </form>`;
      $('#adj-qty', body).focus();
      $('#adj-form', body).onsubmit = e => {
        e.preventDefault();
        busy($('#adj-btn', body), async () => {
          await q(sb.rpc('wms_adjust_pallet', {
            p_pallet_id: p.pallet_id, p_new_qty: Number($('#adj-qty', body).value), p_reason: $('#adj-reason', body).value.trim()
          }));
          toast(`${p.lp_id} adjusted.`);
          closeModal(); onChange && onChange();
        });
      };
    });
    $('#pm-hold', body)?.addEventListener('click', async () => {
      const hold = p.status !== 'hold';
      const reason = hold ? await askReason(`Hold ${p.lp_id}?`, 'Held pallets cannot be shipped until released.', 'Put on Hold') : 'Released';
      if (!reason) return;
      busy(null, async () => {
        await q(sb.rpc('wms_set_hold', { p_pallet_id: p.pallet_id, p_hold: hold, p_reason: reason }));
        toast(`${p.lp_id} ${hold ? 'on hold' : 'released'}.`);
        if (!$('#modal').hidden) closeModal();
        onChange && onChange();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* SCHEDULE: daily / weekly inbound + outbound calendar                */
  /* ------------------------------------------------------------------ */
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const weekStart = d => addDays(d, -d.getDay());   // Sunday-start week
  const dayLabel = (d, opts) => d.toLocaleDateString(undefined, opts || { weekday: 'long', month: 'short', day: 'numeric' });
  let scheduleTimer = null;
  let scheduleFilter = loadPref('scheduleFilter', 'all');

  async function loadSchedule(from, toExclusive) {
    const startIso = from.toISOString(), endIso = toExclusive.toISOString();
    const lastDay = ymd(addDays(toExclusive, -1));
    const rSel = 'id, receipt_no, status, expected_at, received_at, unloaded_at, dock_door, vendor_name, carrier, trailer_no, pallets(count)';
    const [rExp, rWalk, ships] = await Promise.all([
      q(sb.from('receipts').select(rSel).eq('warehouse_id', S.whId).neq('status', 'void').gte('expected_at', startIso).lt('expected_at', endIso)),
      q(sb.from('receipts').select(rSel).eq('warehouse_id', S.whId).neq('status', 'void').is('expected_at', null).gte('received_at', startIso).lt('received_at', endIso)),
      q(sb.from('shipments')
        .select('id, shipment_no, status, ship_date, appt_time, dock_door, ship_to_name, ship_to_city, ship_to_state, carrier, loaded_at, shipped_at, shipment_lines(count)')
        .eq('warehouse_id', S.whId).neq('status', 'void').gte('ship_date', ymd(from)).lte('ship_date', lastDay))
    ]);
    const now = new Date(), today = ymd(now);
    const events = [];
    for (const r of [...rExp, ...rWalk]) {
      const at = new Date(r.expected_at || r.received_at);
      const pallets = r.pallets?.[0]?.count ?? 0;
      let st;
      if (r.status === 'closed') st = ['done', 'Received'];
      else if (r.unloaded_at) st = ['ready', 'Unloaded'];
      else if (pallets > 0) st = ['active', 'Unloading'];
      else if (r.expected_at && at < now) st = ['late', 'Late'];
      else st = ['sched', 'Expected'];
      events.push({
        kind: 'in', id: r.id, no: r.receipt_no, name: r.vendor_name || 'Inbound', at, day: ymd(at), timed: true,
        door: r.dock_door, carrier: r.carrier, pallets, cls: st[0], label: st[1],
        href: isLift() ? '#/dock/unload/' + r.id : '#/receipt/' + r.id
      });
    }
    for (const s of ships) {
      const at = s.appt_time ? new Date(`${s.ship_date}T${s.appt_time.slice(0, 5)}`) : parseYmd(s.ship_date);
      const pallets = s.shipment_lines?.[0]?.count ?? 0;
      let st;
      if (s.status === 'shipped') st = ['done', 'Shipped'];
      else if (s.loaded_at) st = ['ready', 'Loaded'];
      else if (pallets > 0) st = ['active', 'Loading'];
      else if (s.ship_date < today || (s.appt_time && at < now)) st = ['late', 'Late'];
      else st = ['sched', 'Scheduled'];
      events.push({
        kind: 'out', id: s.id, no: s.shipment_no, name: s.ship_to_name || 'Outbound', at, day: s.ship_date, timed: !!s.appt_time,
        door: s.dock_door, carrier: s.carrier, pallets, cls: st[0], label: st[1],
        dest: [s.ship_to_city, s.ship_to_state].filter(Boolean).join(', '),
        href: isLift() ? '#/dock/load/' + s.id : '#/shipment/' + s.id
      });
    }
    // timed first by time, then "any time" ones
    events.sort((a, b) => (a.day.localeCompare(b.day)) || (b.timed - a.timed) || (a.at - b.at) || a.no.localeCompare(b.no));
    return events;
  }

  function eventCard(e, compact) {
    const time = e.timed ? e.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Any time';
    if (compact) return `
      <a class="ev ev-${e.cls} compact" href="${e.href}">
        <span class="ev-dir ${e.kind}">${e.kind === 'in' ? 'IN' : 'OUT'}</span>
        <span class="ev-time">${esc(time)}</span>
        <span class="ev-name">${esc(e.name)}</span>
      </a>`;
    return `
      <a class="ev ev-${e.cls}" href="${e.href}">
        <div class="ev-left"><div class="ev-time">${esc(time)}</div><span class="ev-dir ${e.kind}">${e.kind === 'in' ? 'INBOUND' : 'OUTBOUND'}</span></div>
        <div class="ev-body">
          <div class="row spread"><span class="ev-name">${esc(e.name)}</span><span class="ev-status">${esc(e.label)}</span></div>
          <div class="meta">${esc(e.no)}${e.door ? ' &middot; <strong>Door ' + esc(e.door) + '</strong>' : ''}${e.carrier ? ' &middot; ' + esc(e.carrier) : ''}${e.dest ? ' &middot; ' + esc(e.dest) : ''}</div>
          <div class="meta">${e.pallets} pallet${e.pallets === 1 ? '' : 's'} ${e.kind === 'in' ? 'received' : 'loaded'}</div>
        </div>
      </a>`;
  }

  async function viewSchedule(mode, dateStr) {
    const mySeq = navSeq;
    clearInterval(scheduleTimer);
    mode = mode === 'week' ? 'week' : 'day';
    const base = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? parseYmd(dateStr) : new Date(new Date().toDateString());
    const from = mode === 'week' ? weekStart(base) : base;
    const to = addDays(from, mode === 'week' ? 7 : 1);
    const prev = ymd(addDays(from, mode === 'week' ? -7 : -1));
    const next = ymd(to);
    const todayStr = ymd(new Date());
    if (!document.querySelector('#sched-page')) render(`<div class="loading">Loading...</div>`);

    const all = await loadSchedule(from, to);
    if (mySeq !== navSeq) return;
    const events = all.filter(e => scheduleFilter === 'all' || e.kind === scheduleFilter);
    const nIn = all.filter(e => e.kind === 'in').length, nOut = all.length - nIn;
    const nLate = all.filter(e => e.cls === 'late').length;
    const title = mode === 'week'
      ? `${dayLabel(from, { month: 'short', day: 'numeric' })} – ${dayLabel(addDays(to, -1), { month: 'short', day: 'numeric', year: 'numeric' })}`
      : dayLabel(from, { weekday: 'long', month: 'long', day: 'numeric' });

    let body;
    if (mode === 'day') {
      body = events.length ? events.map(e => eventCard(e, false)).join('')
        : `<div class="card"><p class="muted" style="margin:0">Nothing scheduled${scheduleFilter !== 'all' ? ' for this filter' : ''}.</p></div>`;
    } else {
      body = `<div class="week">${[...Array(7)].map((_, i) => {
        const d = addDays(from, i), ds = ymd(d);
        const evs = events.filter(e => e.day === ds);
        return `<div class="week-day ${ds === todayStr ? 'today' : ''}">
          <a class="week-head" href="#/schedule/day/${ds}">
            <span>${esc(dayLabel(d, { weekday: 'short' }))} <strong>${d.getDate()}</strong></span>
            <span class="muted small">${evs.length ? evs.filter(e => e.kind === 'in').length + ' in · ' + evs.filter(e => e.kind === 'out').length + ' out' : ''}</span></a>
          ${evs.map(e => eventCard(e, true)).join('') || '<div class="muted small week-empty">—</div>'}
        </div>`;
      }).join('')}</div>`;
    }

    render(`
      <div id="sched-page">
        <a class="back" href="${isLift() ? '#/dock' : '#/'}">&larr; ${isLift() ? 'Dock' : 'Home'}</a>
        <div class="row spread"><h1 style="margin-bottom:6px">Schedule${multiWh() ? ` <span class="wh-tag">${esc(whById(S.whId).code)}</span>` : ''}</h1>
          <div class="seg">
            <a href="#/schedule/day/${ymd(mode === 'week' && ymd(from) <= todayStr && todayStr < ymd(to) ? new Date() : from)}" class="${mode === 'day' ? 'on' : ''}">Day</a>
            <a href="#/schedule/week/${ymd(from)}" class="${mode === 'week' ? 'on' : ''}">Week</a>
          </div></div>
        <div class="sched-nav">
          <a class="btn sm ghost" href="#/schedule/${mode}/${prev}" aria-label="Previous">&lsaquo;</a>
          <div class="sched-title">${esc(title)}</div>
          <a class="btn sm ghost" href="#/schedule/${mode}/${next}" aria-label="Next">&rsaquo;</a>
        </div>
        <div class="row" style="margin-bottom:12px">
          <a class="btn sm ${from <= new Date() && new Date() < to ? 'dark' : 'ghost'}" href="#/schedule/${mode}/${todayStr}">Today</a>
          <input type="date" id="sched-date" value="${ymd(from)}" style="width:auto;min-height:40px">
          <div class="seg small-seg">
            ${[['all', `All ${all.length}`], ['in', `In ${nIn}`], ['out', `Out ${nOut}`]].map(([k, l]) =>
              `<a href="#" data-filter="${k}" class="${scheduleFilter === k ? 'on' : ''}">${l}</a>`).join('')}
          </div>
        </div>
        ${nLate ? `<div class="notice bad">${nLate} late: ${esc(all.filter(e => e.cls === 'late').map(e => e.name).join(', '))}</div>` : ''}
        ${body}
        <div class="legend small">
          <span class="lg sched">Scheduled</span><span class="lg active">In progress</span><span class="lg ready">Loaded / Unloaded</span>
          <span class="lg done">Done</span><span class="lg late">Late</span>
        </div>
        <p class="muted small">Updates every minute.${can('operator') ? ' Set times on receipts (Expected arrival) and shipments (Ship date + Appointment).' : ''}</p>
      </div>`);

    $('#sched-date').addEventListener('change', e => { if (e.target.value) location.hash = `#/schedule/${mode}/${e.target.value}`; });
    $$('[data-filter]').forEach(a => a.onclick = ev => {
      ev.preventDefault();
      scheduleFilter = a.dataset.filter; savePref('scheduleFilter', scheduleFilter);
      viewSchedule(mode, ymd(from));
    });
    // live board: refresh while this page stays open
    scheduleTimer = setInterval(() => {
      if (mySeq !== navSeq || !document.querySelector('#sched-page')) { clearInterval(scheduleTimer); return; }
      if ($('#modal').hidden) viewSchedule(mode, ymd(from)).catch(() => {});
    }, 60000);
  }

  /* ------------------------------------------------------------------ */
  /* DOCK MODE (lift operators): big buttons, scan-first, no paperwork   */
  /* ------------------------------------------------------------------ */
  let dockFlash = null;   // last scan result, shown big after re-render
  function flash(kind, title, detail) {
    dockFlash = { kind, title, detail, at: Date.now() };
    try { if (navigator.vibrate) navigator.vibrate(kind === 'bad' ? [120, 60, 120] : 40); } catch { /* not supported */ }
  }
  function flashHtml() {
    if (!dockFlash || Date.now() - dockFlash.at > 15000) return '';
    return `<div class="flash ${dockFlash.kind}"><div class="flash-title">${esc(dockFlash.title)}</div>
      ${dockFlash.detail ? `<div class="flash-detail">${esc(dockFlash.detail)}</div>` : ''}</div>`;
  }
  const todayStr = () => toLocalInput().slice(0, 10);

  async function viewDockHome() {
    const mySeq = navSeq;
    render(`<div class="loading">Loading...</div>`);
    const countOpen = table => q(sb.from(table).select('id', { count: 'exact', head: true }).eq('status', 'open').eq('warehouse_id', S.whId)
      .then(r => ({ data: r.count, error: r.error })));
    const [ships, rcpts] = await Promise.all([countOpen('shipments'), countOpen('receipts')]);
    if (mySeq !== navSeq) return;
    render(`
      ${!isLift() ? '<a class="back" href="#/">&larr; Office</a>' : ''}
      <h1>Dock${multiWh() ? ` <span class="wh-tag">${esc(whById(S.whId).code)}</span>` : ''}</h1>
      <div class="dock-tiles">
        <a class="dock-tile" href="#/dock/load"><strong>Load</strong><span>${ships} open load${ships === 1 ? '' : 's'}</span></a>
        <a class="dock-tile" href="#/dock/unload"><strong>Unload</strong><span>${rcpts} open receipt${rcpts === 1 ? '' : 's'}</span></a>
        <a class="dock-tile" href="#/dock/move"><strong>Move</strong><span>Put away / relocate</span></a>
        <a class="dock-tile" href="#/lookup"><strong>Lookup</strong><span>Find a pallet</span></a>
        <a class="dock-tile wide" href="#/schedule"><strong>Schedule</strong><span>Today's trucks</span></a>
      </div>
      <p class="muted small" style="margin-top:20px">Signed in as ${esc(S.profile.full_name)} (${esc(S.profile.role)}) &middot; v${esc(cfg.APP_VERSION)}</p>`);
  }

  /* ---------- load: pick a load ---------- */
  async function viewDockLoads() {
    const mySeq = navSeq;
    render(`<div class="loading">Loading...</div>`);
    const rows = await q(sb.from('shipments')
      .select('id, shipment_no, ship_date, appt_time, dock_door, ship_to_name, carrier, loaded_at, shipment_lines(count)')
      .eq('status', 'open').eq('warehouse_id', S.whId).order('ship_date').order('appt_time', { nullsFirst: false }).limit(50));
    if (mySeq !== navSeq) return;
    render(`
      <a class="back" href="#/dock">&larr; Dock</a>
      <h1>Load</h1>
      <form id="pick-load" class="card accent" autocomplete="off">
        <label for="load-code">Scan the load sheet</label>
        <div class="input-scan"><input id="load-code" class="big-input" enterkeyhint="go" placeholder="SHP-1001">${scanBtn('load-code', 'pick-load')}</div>
      </form>
      <h2>Open loads</h2>
      ${rows.length ? rows.map(r => `
        <a class="list-item dock-item" href="#/dock/load/${r.id}">
          <div class="row spread"><span class="title">${esc(r.ship_to_name || r.shipment_no)}</span>
            ${r.loaded_at ? '<span class="badge open">Loaded</span>' : r.ship_date <= todayStr() ? '<span class="badge hold">Today</span>' : ''}</div>
          <div class="meta">${esc(r.shipment_no)} &middot; ${esc(fmtDate(r.ship_date))}${r.appt_time ? ' ' + esc(fmtTime(r.appt_time)) : ''}${r.dock_door ? ' &middot; Door ' + esc(r.dock_door) : ''}</div>
          <div class="meta">${r.shipment_lines?.[0]?.count ?? 0} pallets loaded${r.carrier ? ' &middot; ' + esc(r.carrier) : ''}</div>
        </a>`).join('') : '<p class="muted">No open loads.</p>'}`);
    const form = $('#pick-load');
    wireScanButtons(form);
    setTimeout(() => $('#load-code')?.focus(), 50);
    form.onsubmit = e => {
      e.preventDefault();
      busy(null, async () => {
        const code = $('#load-code').value.trim().toUpperCase();
        if (!code) return;
        const hit = await q(sb.from('shipments').select('id, status').eq('shipment_no', code).maybeSingle());
        if (!hit) throw new Error(`No load found for ${code}.`);
        if (hit.status !== 'open') throw new Error(`${code} is already ${hit.status}.`);
        dockFlash = null;
        location.hash = '#/dock/load/' + hit.id;
      });
    };
  }

  /* ---------- load: scan pallets onto one load ---------- */
  async function viewDockLoad(id) {
    const mySeq = navSeq;
    if (!document.querySelector('#dock-load')) render(`<div class="loading">Loading...</div>`);
    const [ship, lines, orders] = await Promise.all([
      q(sb.from('shipments').select('id, shipment_no, status, ship_date, appt_time, dock_door, ship_to_name, ship_to_city, ship_to_state, carrier, trailer_no, special_instructions, loaded_at').eq('id', id).single()),
      q(sb.from('v_shipment_detail').select('*').eq('shipment_id', id).order('created_at', { ascending: false })),
      q(sb.from('v_order_progress').select('*').eq('shipment_id', id).order('created_at'))
    ]);
    if (mySeq !== navSeq) return;
    const isOpen = ship.status === 'open';
    const allDone = orders.length > 0 && orders.every(orderDone);
    const shortText = orders.map(orderRemaining).filter(Boolean).join('; ');

    render(`
      <div id="dock-load">
        <a class="back" href="#/dock/load">&larr; Loads</a>
        <div class="dock-head">
          <div class="dock-head-main">${esc(ship.ship_to_name || 'No ship-to')}</div>
          <div>${esc(ship.shipment_no)}${ship.dock_door ? ' &middot; <strong>Door ' + esc(ship.dock_door) + '</strong>' : ''}${ship.appt_time ? ' &middot; ' + esc(fmtTime(ship.appt_time)) : ''}</div>
          <div class="muted small">${esc([ship.carrier, ship.trailer_no && 'Trailer ' + ship.trailer_no].filter(Boolean).join(' · '))}</div>
        </div>
        ${!isOpen ? `<div class="notice warn">This load is ${esc(ship.status)}.</div>` : ''}
        ${isOpen && ship.loaded_at ? '<div class="notice ok">Marked loaded. The office will ship it. Scanning another pallet reopens it.</div>' : ''}
        ${ship.special_instructions ? `<div class="notice warn">${esc(ship.special_instructions)}</div>` : ''}

        ${isOpen ? `
        <form id="load-scan" class="card accent" autocomplete="off">
          <label for="ld">Scan pallet</label>
          <input id="ld" class="big-input" enterkeyhint="go" autocomplete="off">
          <div class="row" style="margin-top:8px">${scanBtn('ld', 'load-scan')}<button class="btn" id="ld-btn">Load</button></div>
        </form>` : ''}
        ${flashHtml()}

        ${orders.length ? `<div class="card"><h2>${allDone ? 'Order complete' : 'Needed on this load'}</h2>
          ${orders.map(o => orderRow(o, false)).join('')}</div>`
        : '<div class="notice">No order list for this load. Load per the paperwork.</div>'}

        <div class="card">
          <div class="row spread"><h2 style="margin:0">Loaded</h2><span class="muted">${lines.length} pallet${lines.length === 1 ? '' : 's'}</span></div>
          <div style="margin-top:10px">${lines.map(l => `
            <div class="list-item pallet">
              <div><div class="lp">${esc(l.lp_id)}</div>
                <div><strong>${esc(l.sku)}</strong> &middot; ${lotText(l)}</div>
                ${idText(l) ? `<div class="meta">${idText(l)}</div>` : ''}</div>
              <div class="qty">${esc(fmtQty(l.qty))}<div class="meta">${esc(l.uom)}</div></div>
              ${isOpen ? `<div class="row" style="grid-column:1/-1"><button class="btn sm danger" data-unload="${l.pallet_id}">Take off load</button></div>` : ''}
            </div>`).join('') || '<p class="muted">Nothing loaded yet.</p>'}</div>
        </div>

        ${isOpen && !ship.loaded_at ? `<button class="btn block" id="done-load" ${lines.length ? '' : 'disabled'}>Done Loading</button>` : ''}
      </div>`);

    const page = $('#dock-load');
    wireScanButtons(page);
    const reload = () => viewDockLoad(id);
    const input = $('#ld', page);
    if (input) setTimeout(() => input.focus(), 30);

    $('#load-scan', page)?.addEventListener('submit', e => {
      e.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      busy($('#ld-btn', page), async () => {
        try {
          const found = await q(sb.rpc('wms_find_pallet', { p_code: code }));
          if (!found.length) throw new Error(`No pallet in stock matches ${code}.`);
          if (found.length > 1) throw new Error(`${code} matches ${found.length} pallets. Scan the WMS pallet ID.`);
          const p = found[0];
          const line = await q(sb.rpc('wms_add_to_shipment', { p_shipment_id: id, p_pallet_id: p.pallet_id, p_qty: null }));
          const partial = Number(line.qty) < Number(p.qty_available);
          flash('ok', `LOADED ${p.lp_id}`, `${p.sku} · ${fmtQty(line.qty)} ${p.uom}${partial ? ` (partial: take ${fmtQty(line.qty)} of ${fmtQty(p.qty_available)})` : ''}`);
        } catch (err) {
          flash('bad', /WRONG PALLET/.test(friendly(err)) ? 'WRONG PALLET' : 'NOT LOADED', friendly(err).replace(/^WRONG PALLET:\s*/, ''));
        }
        await reload();
      });
    });

    $$('[data-unload]', page).forEach(b => b.onclick = async () => {
      const l = lines.find(x => x.pallet_id === b.dataset.unload);
      if (!await askConfirm(`Take ${l.lp_id} off the load?`, 'Use this if it was scanned by mistake or pulled back off the trailer.', 'Take Off')) return;
      busy(b, async () => {
        await q(sb.rpc('wms_remove_from_shipment', { p_shipment_id: id, p_pallet_id: l.pallet_id }));
        flash('ok', `REMOVED ${l.lp_id}`, 'Taken off this load.');
        await reload();
      });
    });

    $('#done-load', page)?.addEventListener('click', async () => {
      const msg = shortText
        ? `<strong>This load is short:</strong> ${esc(shortText)}<br><br>Mark it loaded anyway? The office will see what is missing.`
        : `${lines.length} pallet${lines.length === 1 ? '' : 's'} on ${esc(ship.shipment_no)}. The office will ship it.`;
      if (!await askConfirm('Done loading?', msg, 'Done Loading')) return;
      busy($('#done-load'), async () => {
        await q(sb.rpc('wms_mark_loaded', { p_shipment_id: id }));
        dockFlash = null;
        toast(`${ship.shipment_no} marked loaded.`);
        location.hash = '#/dock/load';
      });
    });
  }

  /* ---------- unload: pick a receipt ---------- */
  async function viewDockReceipts() {
    const mySeq = navSeq;
    render(`<div class="loading">Loading...</div>`);
    const rows = await q(sb.from('receipts')
      .select('id, receipt_no, expected_at, received_at, dock_door, vendor_name, carrier, trailer_no, unloaded_at, pallets(count)')
      .eq('status', 'open').eq('warehouse_id', S.whId).order('expected_at', { nullsFirst: false }).order('received_at').limit(50));
    if (mySeq !== navSeq) return;
    render(`
      <a class="back" href="#/dock">&larr; Dock</a>
      <h1>Unload</h1>
      <form id="pick-rcpt" class="card accent" autocomplete="off">
        <label for="rcpt-code">Scan the unload sheet</label>
        <div class="input-scan"><input id="rcpt-code" class="big-input" enterkeyhint="go" placeholder="RCV-1001">${scanBtn('rcpt-code', 'pick-rcpt')}</div>
      </form>
      <h2>Open receipts</h2>
      ${rows.length ? rows.map(r => `
        <a class="list-item dock-item" href="#/dock/unload/${r.id}">
          <div class="row spread"><span class="title">${esc(r.vendor_name || r.receipt_no)}</span>
            ${r.unloaded_at ? '<span class="badge open">Unloaded</span>' : ''}</div>
          <div class="meta">${esc(r.receipt_no)}${r.expected_at ? ' &middot; Expected ' + esc(fmtDateTime(r.expected_at)) : ''}${r.dock_door ? ' &middot; Door ' + esc(r.dock_door) : ''}</div>
          <div class="meta">${r.pallets?.[0]?.count ?? 0} pallets${r.carrier ? ' &middot; ' + esc(r.carrier) : ''}${r.trailer_no ? ' &middot; Trailer ' + esc(r.trailer_no) : ''}</div>
        </a>`).join('') : '<p class="muted">No open receipts. The office creates them.</p>'}`);
    const form = $('#pick-rcpt');
    wireScanButtons(form);
    setTimeout(() => $('#rcpt-code')?.focus(), 50);
    form.onsubmit = e => {
      e.preventDefault();
      busy(null, async () => {
        const code = $('#rcpt-code').value.trim().toUpperCase();
        if (!code) return;
        const hit = await q(sb.from('receipts').select('id, status').eq('receipt_no', code).maybeSingle());
        if (!hit) throw new Error(`No receipt found for ${code}.`);
        if (hit.status !== 'open') throw new Error(`${code} is already ${hit.status}.`);
        location.hash = '#/dock/unload/' + hit.id;
      });
    };
  }

  /* ---------- move ---------- */
  async function viewDockMove() {
    render(`
      <a class="back" href="#/dock">&larr; Dock</a>
      <h1>Move</h1>
      <form id="mv-form" class="card accent" autocomplete="off">
        <label for="mv-pallet">1. Scan pallet</label>
        <div class="input-scan"><input id="mv-pallet" class="big-input" enterkeyhint="next">${scanBtn('mv-pallet')}</div>
        <div id="mv-info" style="margin:10px 0"></div>
        ${multiWh() ? `<div class="field" style="margin-top:6px"><label for="mv-wh">To warehouse</label>
          <select id="mv-wh">${activeWhs().map(w => `<option value="${w.id}" ${w.id === S.whId ? 'selected' : ''}>${esc(w.code)} — ${esc(w.name)}</option>`).join('')}</select></div>` : ''}
        <label for="mv-loc">2. Scan or pick location</label>
        <div class="input-scan"><input id="mv-loc" class="big-input" list="mv-locs" enterkeyhint="go" autocapitalize="characters">${scanBtn('mv-loc', 'mv-form')}</div>
        <datalist id="mv-locs">${whLocations(S.whId).map(l => `<option value="${esc(l.code)}"></option>`).join('')}</datalist>
        <button class="btn block" id="mv-btn" style="margin-top:12px">Move</button>
      </form>
      ${flashHtml()}`);
    const form = $('#mv-form');
    wireScanButtons(form);
    const pIn = $('#mv-pallet'), lIn = $('#mv-loc');
    const destWh = () => $('#mv-wh')?.value || S.whId;
    $('#mv-wh')?.addEventListener('change', () => {
      $('#mv-locs').innerHTML = whLocations(destWh()).map(l => `<option value="${esc(l.code)}"></option>`).join('');
      lIn.value = ''; lIn.focus();
    });
    let pallet = null;
    setTimeout(() => pIn.focus(), 50);

    const lookupPallet = async () => {
      const code = pIn.value.trim();
      pallet = null; $('#mv-info').innerHTML = '';
      if (!code) return;
      const found = await q(sb.rpc('wms_find_pallet', { p_code: code }));
      if (found.length !== 1) {
        $('#mv-info').innerHTML = `<div class="notice bad">${found.length ? 'More than one pallet matches. Scan the WMS pallet ID.' : 'No pallet in stock matches ' + esc(code) + '.'}</div>`;
        return;
      }
      pallet = found[0];
      $('#mv-info').innerHTML = `<div class="notice ok"><strong>${esc(pallet.lp_id)}</strong> &middot; ${esc(pallet.sku)} &middot; ${lotText(pallet)} &middot; ${esc(fmtQty(pallet.qty_on_hand))} ${esc(pallet.uom)}<br>Now at <strong>${esc(multiWh() ? pallet.warehouse_code + ' ' : '')}${esc(pallet.location || '-')}</strong></div>`;
    };
    pIn.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      busy(null, async () => { await lookupPallet(); if (pallet) lIn.focus(); });
    });
    pIn.addEventListener('change', () => busy(null, lookupPallet));

    form.onsubmit = e => {
      e.preventDefault();
      busy($('#mv-btn'), async () => {
        if (!pallet) await lookupPallet();
        if (!pallet) throw new Error('Scan a pallet first.');
        const code = lIn.value.trim().toUpperCase();
        const loc = whLocations(destWh()).find(l => l.code.toUpperCase() === code);
        if (!loc) throw new Error(`Location ${code || '(blank)'} not found in ${whById(destWh()).code || 'this warehouse'}.`);
        if (loc.id === pallet.location_id) throw new Error(`${pallet.lp_id} is already in ${loc.code}.`);
        await q(sb.rpc('wms_move_pallet', { p_pallet_id: pallet.pallet_id, p_to_location_id: loc.id }));
        flash('ok', `MOVED ${pallet.lp_id}`, multiWh() && loc.warehouse_id !== pallet.warehouse_id
          ? `${pallet.warehouse_code} ${pallet.location || '-'} → ${whById(loc.warehouse_id).code} ${loc.code} (transfer)`
          : `${pallet.location || '-'} → ${loc.code}`);
        viewDockMove();
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* shipping: list                                                      */
  /* ------------------------------------------------------------------ */
  const FREIGHT_TERMS = { prepaid: 'Prepaid', collect: 'Collect', third_party: '3rd Party' };
  function fmtTime(t) {
    if (!t) return '';
    const [h, m] = String(t).split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // order line progress, e.g. "WID-100 BIN Class 714: 3 of 5 pallets"
  function orderNeed(o) {
    const parts = [];
    if (o.pallets_ordered) parts.push(`${o.pallets_loaded} of ${o.pallets_ordered} pallet${o.pallets_ordered === 1 ? '' : 's'}`);
    if (o.qty_ordered) parts.push(`${fmtQty(o.qty_loaded)} of ${fmtQty(o.qty_ordered)} ${o.uom}`);
    return parts.join(' · ');
  }
  function orderDone(o) {
    return (!o.pallets_ordered || o.pallets_loaded >= o.pallets_ordered) && (!o.qty_ordered || Number(o.qty_loaded) >= Number(o.qty_ordered));
  }
  function orderRemaining(o) {
    if (orderDone(o)) return '';
    const bits = [];
    if (o.pallets_ordered && o.pallets_loaded < o.pallets_ordered) bits.push(`${o.pallets_ordered - o.pallets_loaded} pallet${o.pallets_ordered - o.pallets_loaded === 1 ? '' : 's'}`);
    if (o.qty_ordered && Number(o.qty_loaded) < Number(o.qty_ordered)) bits.push(`${fmtQty(o.qty_ordered - o.qty_loaded)} ${o.uom}`);
    return `${o.sku}${o.lot_number ? ' ' + lbl.lotShort() + ' ' + o.lot_number : ''} (${bits.join(', ')})`;
  }
  function orderPct(o) {
    const a = o.pallets_ordered ? o.pallets_loaded / o.pallets_ordered : 1;
    const b = o.qty_ordered ? Number(o.qty_loaded) / Number(o.qty_ordered) : 1;
    return Math.max(0, Math.min(1, Math.min(a, b)));
  }
  function orderRow(o, canDelete) {
    const done = orderDone(o);
    return `
      <div class="list-item order-line ${done ? 'done' : ''}">
        <div class="row spread">
          <div><strong>${esc(o.sku)}</strong> &middot; ${o.lot_number ? esc(lbl.lotShort()) + ' ' + esc(o.lot_number) : 'any ' + esc(lbl.lotShort().toLowerCase())}
            <div class="meta">${esc(o.description)}</div></div>
          <div style="text-align:right"><strong>${esc(orderNeed(o))}</strong>${done ? '<div class="meta" style="color:var(--ok)">Complete</div>' : ''}</div>
        </div>
        <div class="bar"><span style="width:${Math.round(orderPct(o) * 100)}%"></span></div>
        ${canDelete ? `<div class="row" style="margin-top:6px"><button type="button" class="btn sm ghost" data-ol-del="${o.order_line_id}">Remove line</button></div>` : ''}
      </div>`;
  }

  async function viewShipments() {
    const mySeq = navSeq;
    render(`<div class="loading">Loading...</div>`);
    const rows = await q(sb.from('shipments')
      .select('id, shipment_no, status, ship_date, appt_time, dock_door, loaded_at, ship_to_name, ship_to_city, ship_to_state, carrier, customer_order_no, po_number, owner_id, shipment_lines(count)')
      .eq('warehouse_id', S.whId)
      .order('ship_date', { ascending: false }).order('shipment_no', { ascending: false }).limit(60));
    if (mySeq !== navSeq) return;
    const open = rows.filter(r => r.status === 'open').sort((a, b) =>
      (a.ship_date + (a.appt_time || '')).localeCompare(b.ship_date + (b.appt_time || '')));
    const rest = rows.filter(r => r.status !== 'open');
    const item = r => `
      <a class="list-item" href="#/shipment/${r.id}">
        <div class="row spread"><span class="title">${esc(r.shipment_no)}</span>
          <span>${r.status === 'open' && r.loaded_at ? '<span class="badge open">Loaded</span> ' : ''}${badge(r.status)}</span></div>
        <div><strong>${esc(r.ship_to_name || 'No ship-to yet')}</strong>${r.ship_to_city ? ' &middot; ' + esc([r.ship_to_city, r.ship_to_state].filter(Boolean).join(', ')) : ''}</div>
        <div class="meta">${esc(fmtDate(r.ship_date))}${r.appt_time ? ' at ' + esc(fmtTime(r.appt_time)) : ''}${r.dock_door ? ' &middot; Door ' + esc(r.dock_door) : ''} &middot; ${r.shipment_lines?.[0]?.count ?? 0} pallets</div>
        <div class="meta">${esc([multiOwner() && ownerById(r.owner_id).code, r.carrier, r.customer_order_no && 'Order ' + r.customer_order_no, r.po_number && 'PO ' + r.po_number].filter(Boolean).join(' · '))}</div>
      </a>`;
    const table = list => `
      <div class="card table-card dwrap"><table class="data">
        <thead><tr><th>Shipment</th><th>Status</th>${multiOwner() ? '<th>Account</th>' : ''}<th>Ship date</th><th>Appt</th><th>Door</th><th>Ship to</th><th>Carrier</th><th>Order</th><th>PO</th><th class="num">Pallets</th></tr></thead>
        <tbody>${list.map(r => `<tr data-href="#/shipment/${r.id}">
          <td><a href="#/shipment/${r.id}"><strong>${esc(r.shipment_no)}</strong></a></td>
          <td>${r.status === 'open' && r.loaded_at ? '<span class="badge open">Loaded</span> ' : ''}${badge(r.status)}</td>
          ${multiOwner() ? `<td>${esc(ownerById(r.owner_id).code || '')}</td>` : ''}
          <td>${esc(fmtDate(r.ship_date))}</td><td>${r.appt_time ? esc(fmtTime(r.appt_time)) : ''}</td><td>${esc(r.dock_door || '')}</td>
          <td>${esc(r.ship_to_name || '')}${r.ship_to_city ? '<span class="muted"> &middot; ' + esc([r.ship_to_city, r.ship_to_state].filter(Boolean).join(', ')) + '</span>' : ''}</td>
          <td>${esc(r.carrier || '')}</td><td>${esc(r.customer_order_no || '')}</td><td>${esc(r.po_number || '')}</td>
          <td class="num">${r.shipment_lines?.[0]?.count ?? 0}</td></tr>`).join('')}</tbody>
      </table></div>`;
    render(`
      <a class="back" href="#/">&larr; Home</a>
      <div class="row spread"><h1>Shipping${multiWh() ? ' <span class="wh-tag">' + esc(whById(S.whId).code) + '</span>' : ''}</h1>
        ${can('operator') ? `<a class="btn" href="#/shipment/new">New Shipment</a>` : ''}</div>
      <h2>Open</h2>
      ${open.length ? `<div class="list mlist">${open.map(item).join('')}</div>${table(open)}` : `<p class="muted">No open shipments.</p>`}
      <h2 style="margin-top:20px">Recent</h2>
      ${rest.length ? `<div class="list mlist">${rest.map(item).join('')}</div>${table(rest)}` : `<p class="muted">Nothing yet.</p>`}`);
    wireRowLinks();
  }

  /* ------------------------------------------------------------------ */
  /* shipping: header form                                               */
  /* ------------------------------------------------------------------ */
  function shipmentHeaderFields(r = {}, lockScope = false) {
    const customers = S.parties.filter(p => p.active && p.party_type !== 'vendor');
    const terms = r.freight_terms || 'prepaid';
    return `
      <div class="grid2">
        <div class="field"><label for="owner_id">Customer account (whose product)</label>
          <select id="owner_id" required ${lockScope ? 'disabled' : ''}>${ownerOptions(r.owner_id)}</select>
          ${lockScope ? '<div class="hint">Locked: the order or load has started.</div>' : ''}</div>
        <div class="field"><label>Ship from</label>
          <input value="${esc(whById(r.warehouse_id || S.whId).code || '')} — ${esc(whById(r.warehouse_id || S.whId).name || '')}" readonly></div>
      </div>
      <div class="field"><label for="consignee_id">Ship-to</label>
        <select id="consignee_id">
          <option value="">${customers.length ? 'Select a saved customer, or type the address below' : 'Type the address below'}</option>
          ${customers.map(c => `<option value="${c.id}" ${r.consignee_id === c.id ? 'selected' : ''}>${esc(c.name)}${c.city ? ' — ' + esc(c.city) : ''}</option>`).join('')}
        </select>
        ${can('manager') ? '<div class="hint">Save customers in Setup &gt; Customers.</div>' : ''}</div>
      <div class="field"><label for="ship_to_name">Ship-to name</label>
        <input id="ship_to_name" value="${esc(r.ship_to_name || '')}" maxlength="120" required></div>
      <div class="field"><label for="ship_to_address1">Address</label>
        <input id="ship_to_address1" value="${esc(r.ship_to_address1 || '')}" maxlength="120"></div>
      <div class="field"><label for="ship_to_address2">Address line 2</label>
        <input id="ship_to_address2" value="${esc(r.ship_to_address2 || '')}" maxlength="120"></div>
      <div class="grid2">
        <div class="field"><label for="ship_to_city">City</label><input id="ship_to_city" value="${esc(r.ship_to_city || '')}" maxlength="60"></div>
        <div class="field"><label for="ship_to_state">State</label><input id="ship_to_state" value="${esc(r.ship_to_state || '')}" maxlength="2"></div>
        <div class="field"><label for="ship_to_zip">ZIP</label><input id="ship_to_zip" value="${esc(r.ship_to_zip || '')}" maxlength="10"></div>
        <div class="field"><label for="ship_to_contact">Contact</label><input id="ship_to_contact" value="${esc(r.ship_to_contact || '')}" maxlength="80"></div>
        <div class="field"><label for="ship_to_phone">Phone</label><input id="ship_to_phone" type="tel" value="${esc(r.ship_to_phone || '')}" maxlength="30"></div>
      </div>
      <h3 style="margin-top:8px">Pickup</h3>
      <div class="grid2">
        <div class="field"><label for="ship_date">Ship date</label>
          <input id="ship_date" type="date" value="${esc(r.ship_date || toLocalInput().slice(0, 10))}" required></div>
        <div class="field"><label for="appt_time">Appointment time</label>
          <input id="appt_time" type="time" value="${esc((r.appt_time || '').slice(0, 5))}"></div>
        <div class="field"><label for="dock_door">Dock door</label>
          <input id="dock_door" value="${esc(r.dock_door || '')}" maxlength="20"></div>
        <div class="field"><label for="carrier">Carrier</label><input id="carrier" value="${esc(r.carrier || '')}" maxlength="120"></div>
        <div class="field"><label for="carrier_scac">SCAC</label><input id="carrier_scac" value="${esc(r.carrier_scac || '')}" maxlength="4"></div>
        <div class="field"><label for="trailer_no">Trailer #</label><input id="trailer_no" value="${esc(r.trailer_no || '')}" maxlength="40"></div>
        <div class="field"><label for="seal_no">Seal #</label><input id="seal_no" value="${esc(r.seal_no || '')}" maxlength="40"></div>
        <div class="field"><label for="pro_number">PRO #</label><input id="pro_number" value="${esc(r.pro_number || '')}" maxlength="40"></div>
        <div class="field"><label for="freight_terms">Freight terms</label>
          <select id="freight_terms">${Object.entries(FREIGHT_TERMS).map(([k, v]) => `<option value="${k}" ${terms === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="field" id="tp-wrap" ${terms === 'third_party' ? '' : 'hidden'}><label for="third_party_bill_to">3rd party bill-to</label>
        <textarea id="third_party_bill_to" maxlength="400" placeholder="Name and address">${esc(r.third_party_bill_to || '')}</textarea></div>
      <h3 style="margin-top:8px">Order</h3>
      <div class="grid2">
        <div class="field"><label for="customer_order_no">Customer order #</label><input id="customer_order_no" value="${esc(r.customer_order_no || '')}" maxlength="60"></div>
        <div class="field"><label for="po_number">PO #</label><input id="po_number" value="${esc(r.po_number || '')}" maxlength="60"></div>
      </div>
      <div class="field"><label for="special_instructions">Special instructions (prints on BOL)</label>
        <textarea id="special_instructions" maxlength="600">${esc(r.special_instructions || '')}</textarea></div>
      <div class="field"><label for="notes">Internal notes</label>
        <textarea id="notes" maxlength="1000">${esc(r.notes || '')}</textarea></div>`;
  }

  function wireShipmentHeader(root) {
    $('#consignee_id', root).addEventListener('change', e => {
      const c = S.parties.find(p => p.id === e.target.value);
      if (!c) return;
      const set = (id, v) => { $('#' + id, root).value = v || ''; };
      set('ship_to_name', c.name); set('ship_to_address1', c.address_line1); set('ship_to_address2', c.address_line2);
      set('ship_to_city', c.city); set('ship_to_state', c.state); set('ship_to_zip', c.zip);
      set('ship_to_contact', c.contact_name); set('ship_to_phone', c.phone);
      if (c.notes && !$('#special_instructions', root).value) set('special_instructions', c.notes);
    });
    $('#freight_terms', root).addEventListener('change', e => {
      $('#tp-wrap', root).hidden = e.target.value !== 'third_party';
    });
  }

  function readShipmentHeader(root) {
    const v = id => $('#' + id, root).value;
    return {
      ...(!$('#owner_id', root).disabled ? { owner_id: v('owner_id') || null } : {}),
      consignee_id: v('consignee_id') || null,
      ship_to_name: strOrNull(v('ship_to_name')),
      ship_to_address1: strOrNull(v('ship_to_address1')), ship_to_address2: strOrNull(v('ship_to_address2')),
      ship_to_city: strOrNull(v('ship_to_city')), ship_to_state: strOrNull(v('ship_to_state').toUpperCase()),
      ship_to_zip: strOrNull(v('ship_to_zip')), ship_to_contact: strOrNull(v('ship_to_contact')),
      ship_to_phone: strOrNull(v('ship_to_phone')),
      ship_date: v('ship_date'), appt_time: v('appt_time') || null, dock_door: strOrNull(v('dock_door')),
      carrier: strOrNull(v('carrier')), carrier_scac: strOrNull(v('carrier_scac').toUpperCase()),
      trailer_no: strOrNull(v('trailer_no')), seal_no: strOrNull(v('seal_no')), pro_number: strOrNull(v('pro_number')),
      freight_terms: v('freight_terms'),
      third_party_bill_to: v('freight_terms') === 'third_party' ? strOrNull(v('third_party_bill_to')) : null,
      customer_order_no: strOrNull(v('customer_order_no')), po_number: strOrNull(v('po_number')),
      special_instructions: strOrNull(v('special_instructions')), notes: strOrNull(v('notes'))
    };
  }

  function viewNewShipment() {
    if (!can('operator')) { location.hash = '#/shipments'; return; }
    render(`
      <a class="back" href="#/shipments">&larr; Shipping</a>
      <h1>New Shipment</h1>
      <form id="new-ship" class="card accent">
        ${shipmentHeaderFields()}
        <button class="btn block" id="create-ship">Create Shipment</button>
      </form>`);
    const form = $('#new-ship');
    wireShipmentHeader(form);
    form.onsubmit = e => {
      e.preventDefault();
      busy($('#create-ship'), async () => {
        const hdr = readShipmentHeader(form);
        if (!hdr.owner_id) throw new Error('Pick the customer account.');
        const row = await q(sb.from('shipments').insert({ ...hdr, warehouse_id: S.whId }).select('id, shipment_no').single());
        toast(`${row.shipment_no} created.`);
        location.hash = '#/shipment/' + row.id;
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* shipping: detail, load pallets, ship                                */
  /* ------------------------------------------------------------------ */
  function shipTotals(lines) {
    const tare = Number(S.settings?.pallet_tare_lbs || 0);
    const pallets = new Set(lines.map(l => l.pallet_id)).size;
    const byUom = {};
    for (const l of lines) byUom[l.uom] = (byUom[l.uom] || 0) + Number(l.qty);
    const product = lines.reduce((a, l) => a + Number(l.product_weight_lbs || 0), 0);
    const missingWeight = lines.some(l => l.unit_weight_lbs === null || l.unit_weight_lbs === undefined);
    return { pallets, byUom, weight: product + tare * pallets, missingWeight };
  }

  async function viewShipment(id, focusScan) {
    const mySeq = navSeq;
    if (!document.querySelector('#ship-page')) render(`<div class="loading">Loading...</div>`);
    const [ship, lines, orders] = await Promise.all([
      q(sb.from('shipments').select('*').eq('id', id).single()),
      q(sb.from('v_shipment_detail').select('*').eq('shipment_id', id).order('created_at')),
      q(sb.from('v_order_progress').select('*').eq('shipment_id', id).order('created_at'))
    ]);
    if (mySeq !== navSeq) return;
    const isOpen = ship.status === 'open';
    const editable = isOpen && can('operator');
    const t = shipTotals(lines);
    const qtyText = Object.entries(t.byUom).map(([u, n]) => `${fmtQty(n)} ${u}`).join(' + ');
    const shortText = orders.map(orderRemaining).filter(Boolean).join('; ');
    const activeItems = itemsFor(ship.owner_id);

    const headerView = `
      <dl class="kv">
        <dt>Account</dt><dd>${esc(ownerById(ship.owner_id).code || '')} — ${esc(ownerById(ship.owner_id).name || '')}</dd>
        ${multiWh() ? `<dt>Ship from</dt><dd>${esc(whById(ship.warehouse_id).code)}</dd>` : ''}
        <dt>Ship to</dt><dd>${esc(ship.ship_to_name || '-')}<br><span class="muted small">${esc([ship.ship_to_address1, ship.ship_to_address2, [ship.ship_to_city, ship.ship_to_state].filter(Boolean).join(', '), ship.ship_to_zip].filter(Boolean).join(' · '))}</span></dd>
        <dt>Ship date</dt><dd>${esc(fmtDate(ship.ship_date))}${ship.appt_time ? ' at ' + esc(fmtTime(ship.appt_time)) : ''}</dd>
        ${ship.dock_door ? `<dt>Door</dt><dd>${esc(ship.dock_door)}</dd>` : ''}
        <dt>Carrier</dt><dd>${esc([ship.carrier, ship.carrier_scac].filter(Boolean).join(' / ') || '-')}</dd>
        <dt>Trailer / Seal</dt><dd>${esc([ship.trailer_no, ship.seal_no].filter(Boolean).join(' / ') || '-')}</dd>
        <dt>PRO #</dt><dd>${esc(ship.pro_number || '-')}</dd>
        <dt>Freight terms</dt><dd>${esc(FREIGHT_TERMS[ship.freight_terms] || ship.freight_terms)}</dd>
        <dt>Order / PO</dt><dd>${esc([ship.customer_order_no, ship.po_number].filter(Boolean).join(' / ') || '-')}</dd>
        ${ship.special_instructions ? `<dt>Instructions</dt><dd>${esc(ship.special_instructions)}</dd>` : ''}
        ${ship.shipped_at ? `<dt>Shipped</dt><dd>${esc(fmtDateTime(ship.shipped_at))}</dd>` : ''}
        ${ship.status === 'void' ? `<dt>Void reason</dt><dd>${esc(ship.void_reason || '')}</dd>` : ''}
      </dl>`;

    const lineRow = l => `
      <div class="list-item pallet">
        <div>
          <div class="lp">${esc(l.lp_id)}</div>
          <div><strong>${esc(l.sku)}</strong> &middot; ${lotText(l)}</div>
          <div class="meta">${esc(l.location || '')}${!isOpen ? '' : Number(l.qty) < Number(l.qty_on_hand) ? ` &middot; partial: ${esc(fmtQty(l.qty))} of ${esc(fmtQty(l.qty_on_hand))}` : ''}</div>
          ${idText(l) ? `<div class="meta">${idText(l)}</div>` : ''}
        </div>
        <div class="qty">${esc(fmtQty(l.qty))}<div class="meta">${esc(l.uom)}</div></div>
        ${editable ? `<div class="row" style="grid-column:1/-1"><button class="btn sm danger" data-remove="${l.pallet_id}">Remove</button></div>` : ''}
      </div>`;

    render(`
      <div id="ship-page">
        <a class="back" href="#/shipments">&larr; Shipping</a>
        <div class="row spread"><h1>${esc(ship.shipment_no)}</h1>${badge(ship.status)}</div>
        ${isOpen && ship.loaded_at ? `<div class="notice ok">Loaded ${esc(fmtDateTime(ship.loaded_at))}${userName(ship.loaded_by) ? ' by ' + esc(userName(ship.loaded_by)) : ''}. Review, add the seal #, then ship.</div>` : ''}
        ${isOpen && shortText ? `<div class="notice warn">Still needed: ${esc(shortText)}</div>` : ''}

        <div class="card">
          ${editable ? `
            <details ${lines.length ? '' : 'open'}><summary class="row spread" style="cursor:pointer">
              <h2 style="margin:0">Shipment Details</h2>
              <span class="muted small">${esc([ship.ship_to_name, fmtDate(ship.ship_date)].filter(Boolean).join(' · ') || 'tap to edit')}</span></summary>
              <form id="ship-hdr" style="margin-top:12px">${shipmentHeaderFields(ship, lines.length > 0 || orders.length > 0)}
                <button class="btn secondary block" id="ship-hdr-save">Save Shipment Details</button></form>
            </details>` : `<h2>Shipment Details</h2>${headerView}`}
        </div>

        <div class="card">
          <div class="row spread"><h2 style="margin:0">Order</h2>
            <span class="muted small">${orders.length ? 'Only these products can be loaded' : 'No order lines: any pallet can be loaded'}</span></div>
          <div style="margin-top:10px">${orders.map(o => orderRow(o, editable)).join('')}</div>
          ${editable ? `
          <form id="ol-form" style="margin-top:8px" autocomplete="off">
            <div class="field"><label for="ol-item">Add product to load</label>
              <select id="ol-item" required><option value="">Select item...</option>
                ${activeItems.map(i => `<option value="${i.id}">${esc(i.sku)} — ${esc(i.description)}</option>`).join('')}</select></div>
            <div class="grid2">
              <div class="field"><label for="ol-lot">${esc(lbl.lot())} <span class="muted small">(blank = any)</span></label>
                <input id="ol-lot" maxlength="60"></div>
              <div class="field"><label for="ol-pallets">Pallets</label>
                <input id="ol-pallets" type="number" inputmode="numeric" min="1" step="1"></div>
              <div class="field"><label for="ol-qty">or Qty <span class="muted small">(partial pallets OK)</span></label>
                <input id="ol-qty" type="number" inputmode="decimal" min="0.01" step="any"></div>
              <div class="field" style="display:flex;align-items:flex-end"><button class="btn secondary block" id="ol-add">Add to Order</button></div>
            </div>
          </form>` : ''}
        </div>

        ${editable ? `
        <form id="scan-form" class="card accent" autocomplete="off">
          <h2>Load Pallets</h2>
          <label for="sc">Scan any pallet ID</label>
          <div class="input-scan"><input id="sc" enterkeyhint="go">${scanBtn('sc', 'scan-form')}</div>
          <div class="grid2" style="margin-top:10px">
            <div class="field"><label for="sc-qty">Qty <span class="muted small">(blank = whole pallet)</span></label>
              <input id="sc-qty" type="number" inputmode="decimal" min="0.01" step="any"></div>
            <div class="field" style="display:flex;align-items:flex-end"><button class="btn block" id="sc-btn">Add to Shipment</button></div>
          </div>
          <details class="more" id="pick-details"><summary>Pick by item (oldest first)</summary>
            <select id="pick-item"><option value="">Select item...</option>
              ${activeItems.map(i => `<option value="${i.id}">${esc(i.sku)} — ${esc(i.description)}</option>`).join('')}</select>
            <div id="pick-list" style="margin-top:10px"></div>
          </details>
        </form>` : ''}

        <div class="card">
          <div class="row spread"><h2 style="margin:0">Pallets</h2>
            <span class="muted">${t.pallets} pallet${t.pallets === 1 ? '' : 's'}${qtyText ? ' &middot; ' + esc(qtyText) : ''}${t.weight ? ' &middot; ' + esc(fmtQty(Math.round(t.weight))) + ' lbs' : ''}</span></div>
          ${t.missingWeight && lines.length ? '<div class="notice warn" style="margin-top:10px">Some items have no unit weight, so the BOL weight will be low. Set weights in Setup &gt; Items.</div>' : ''}
          <div style="margin-top:12px">${lines.length ? lines.map(lineRow).join('') : '<p class="muted">No pallets yet. Scan a pallet to add it.</p>'}</div>
        </div>

        ${can('operator') && ship.status !== 'void' ? '<div class="card" id="charges-card"></div>' : ''}

        <div class="btn-row">
          ${isOpen ? `<button class="btn secondary" id="print-load">Print Load Sheet</button>` : ''}
          <button class="btn dark" id="print-bol" ${lines.length ? '' : 'disabled'}>Print BOL</button>
          ${editable ? `<button class="btn" id="ship-btn" ${lines.length ? '' : 'disabled'}>Ship</button>` : ''}
          ${ship.status !== 'void' && can('manager') ? `<button class="btn danger" id="void-ship">Void Shipment</button>` : ''}
        </div>
      </div>`);

    const page = $('#ship-page');
    wireScanButtons(page);
    const reload = focus => viewShipment(id, focus);
    wireCharges($('#charges-card', page), { shipment_id: id, owner_id: ship.owner_id, warehouse_id: ship.warehouse_id });

    const hdr = $('#ship-hdr', page);
    if (hdr) {
      wireShipmentHeader(hdr);
      hdr.onsubmit = e => {
        e.preventDefault();
        busy($('#ship-hdr-save'), async () => {
          await q(sb.from('shipments').update(readShipmentHeader(hdr)).eq('id', id));
          await reload();
          toast('Shipment details saved.');
        });
      };
    }

    const scanForm = $('#scan-form', page);
    if (scanForm) {
      if (focusScan) setTimeout(() => $('#sc')?.focus(), 30);
      scanForm.onsubmit = e => {
        e.preventDefault();
        busy($('#sc-btn', scanForm), async () => {
          const code = $('#sc', scanForm).value.trim();
          if (!code) { $('#sc', scanForm).focus(); throw new Error('Scan or type a pallet ID.'); }
          const qty = numOrNull($('#sc-qty', scanForm).value);
          const found = await q(sb.rpc('wms_find_pallet', { p_code: code }));
          if (!found.length) throw new Error(`No pallet in stock matches "${code}".`);
          if (found.length > 1) throw new Error(`"${code}" matches ${found.length} pallets. Scan the WMS pallet ID instead.`);
          const p = found[0];
          const line = await q(sb.rpc('wms_add_to_shipment', { p_shipment_id: id, p_pallet_id: p.pallet_id, p_qty: qty }));
          await reload(true);   // screen ready for the next scan before confirming
          toast(`Added ${p.lp_id}: ${fmtQty(line.qty)} ${p.uom}.`);
        });
      };
      $('#pick-item', scanForm).addEventListener('change', async e => {
        const out = $('#pick-list', scanForm);
        if (!e.target.value) { out.innerHTML = ''; return; }
        out.innerHTML = '<div class="muted">Loading...</div>';
        try {
          const onShip = new Set(lines.map(l => l.pallet_id));
          const rows = (await q(sb.from('v_inventory').select('*').eq('item_id', e.target.value).eq('warehouse_id', ship.warehouse_id)
            .order('received_at').order('lp_id').limit(100)))
            .filter(r => r.status === 'on_hand' && Number(r.qty_available) > 0 && !onShip.has(r.pallet_id));
          out.innerHTML = rows.length ? rows.map(r => `
            <div class="list-item row spread">
              <div><div class="lp" style="font-family:monospace;font-weight:800">${esc(r.lp_id)}</div>
                <div class="meta">${lotText(r)} &middot; ${esc(r.location || '')} &middot; Rcvd ${esc(fmtDate(r.received_at))}</div>
                ${idText(r) ? `<div class="meta">${idText(r)}</div>` : ''}</div>
              <div style="text-align:right"><strong>${esc(fmtQty(r.qty_available))}</strong> ${esc(r.uom)}
                <div><button type="button" class="btn sm" data-pick="${r.pallet_id}">Add</button></div></div>
            </div>`).join('') : '<p class="muted">No available pallets for this item.</p>';
          $$('[data-pick]', out).forEach(b => b.onclick = () => busy(b, async () => {
            const r = rows.find(x => x.pallet_id === b.dataset.pick);
            const line = await q(sb.rpc('wms_add_to_shipment', { p_shipment_id: id, p_pallet_id: r.pallet_id, p_qty: null }));
            await reload();
            toast(`Added ${r.lp_id}: ${fmtQty(line.qty)} ${r.uom}.`);
          }));
        } catch (err) { out.innerHTML = `<div class="notice bad">${esc(friendly(err))}</div>`; }
      });
    }

    $$('[data-remove]', page).forEach(b => b.onclick = () => busy(b, async () => {
      await q(sb.rpc('wms_remove_from_shipment', { p_shipment_id: id, p_pallet_id: b.dataset.remove }));
      await reload();
      toast('Pallet removed.');
    }));

    $('#print-bol', page).onclick = () => WmsPrint.bol(ship, lines, docSettings(ship.warehouse_id), ownerById(ship.owner_id));
    $('#print-load', page)?.addEventListener('click', () => WmsPrint.loadSheet(ship, orders, docSettings(ship.warehouse_id), ownerById(ship.owner_id)));

    $('#ol-form', page)?.addEventListener('submit', e => {
      e.preventDefault();
      const f = e.target;
      busy($('#ol-add', f), async () => {
        const pallets = numOrNull($('#ol-pallets', f).value);
        const qty = numOrNull($('#ol-qty', f).value);
        if (!pallets && !qty) throw new Error('Enter pallets, qty, or both.');
        if (pallets !== null && (!Number.isInteger(pallets) || pallets < 1)) throw new Error('Pallets must be a whole number.');
        await q(sb.from('shipment_order_lines').insert({
          shipment_id: id, item_id: $('#ol-item', f).value,
          lot_number: strOrNull($('#ol-lot', f).value), pallets_ordered: pallets, qty_ordered: qty
        }));
        await reload();
        toast('Added to order.');
      });
    });
    $$('[data-ol-del]', page).forEach(b => b.onclick = () => busy(b, async () => {
      await q(sb.from('shipment_order_lines').delete().eq('id', b.dataset.olDel));
      await reload();
      toast('Order line removed.');
    }));

    $('#ship-btn', page)?.addEventListener('click', async () => {
      if (!ship.ship_to_name) { toast('Add the ship-to before shipping.', 'bad'); return; }
      const ok = await askConfirm(`Ship ${ship.shipment_no}?`,
        `${t.pallets} pallet${t.pallets === 1 ? '' : 's'} (${esc(qtyText)}) to <strong>${esc(ship.ship_to_name)}</strong>. Inventory will be removed and the shipment locked.`
        + (shortText ? `<br><br><strong>This load is short:</strong> ${esc(shortText)}` : '')
        + (!ship.loaded_at ? '<br><br>The dock has not marked this load as loaded.' : ''), 'Ship');
      if (!ok) return;
      busy($('#ship-btn'), async () => {
        await q(sb.rpc('wms_ship_shipment', { p_shipment_id: id }));
        await reload();
        toast(`${ship.shipment_no} shipped.`);
      });
    });

    $('#void-ship', page)?.addEventListener('click', async () => {
      const reason = await askReason(`Void ${ship.shipment_no}?`, ship.status === 'shipped'
        ? 'This puts every pallet on this shipment back into inventory.'
        : 'This releases the pallets on this shipment.', 'Void Shipment');
      if (!reason) return;
      busy(null, async () => {
        await q(sb.rpc('wms_void_shipment', { p_shipment_id: id, p_reason: reason }));
        await reload();
        toast(`${ship.shipment_no} voided.`);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* setup: users (calls the admin-users server function)                */
  /* ------------------------------------------------------------------ */
  async function callAdminUsers(body) {
    const { data, error } = await sb.functions.invoke('admin-users', { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* keep generic */ }
      if (/Failed to send a request|Function not found|404/i.test(msg)) msg = 'The user manager is not set up yet (admin-users function).';
      throw new Error(msg);
    }
    return data;
  }
  function makePassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const buf = new Uint32Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf, n => chars[n % chars.length]).join('');
  }
  const ROLE_HELP = {
    admin: 'Everything, including company settings and all users',
    manager: 'Office + setup, adjustments, voids; manages operator, lift and viewer logins',
    operator: 'Office: receipts, shipments, order lines, ship and close',
    lift: 'Dock Mode only: unload, load, move, look up',
    viewer: 'Look up inventory and paperwork, run reports'
  };

  async function setupUsers(out) {
    out.innerHTML = '<div class="loading">Loading users...</div>';
    let data;
    try { data = await callAdminUsers({ action: 'list' }); }
    catch (e) { out.innerHTML = `<div class="notice bad">${esc(friendly(e))}</div>`; return; }
    const users = data.users;
    out.innerHTML = `
      <div class="row spread" style="margin-bottom:10px">
        <span class="muted">${users.filter(u => u.active).length} active</span>
        <button class="btn" id="add-user">Add User</button></div>
      ${users.map(u => `
        <a class="list-item" href="#" data-user="${u.id}" style="${u.active ? '' : 'opacity:.55'}">
          <div class="row spread"><span class="title">${esc(u.full_name)}</span>
            <span>${u.active ? '' : badge('inactive') + ' '}<span class="badge">${esc(u.role)}</span></span></div>
          <div class="meta">Sign in: <strong>${esc(u.login)}</strong></div>
          <div class="meta">${u.last_sign_in_at ? 'Last signed in ' + esc(fmtDateTime(u.last_sign_in_at)) : 'Never signed in'}
            ${u.id === S.profile.id ? ' &middot; you' : ''}</div>
        </a>`).join('')}
      <div class="notice" style="margin-top:12px">Dock and floor staff can use a simple username (like <strong>mike.dock</strong>) instead of an email.
        Passwords are set here; there is no email step.</div>`;
    $('#add-user', out).onclick = () => userForm(null, data);
    $$('[data-user]', out).forEach(a => a.onclick = e => {
      e.preventDefault();
      const u = users.find(x => x.id === a.dataset.user);
      if (!u.can_manage) { toast(u.id === S.profile.id ? 'This is you. Ask another admin to change your account.' : `Only an admin can change ${u.role} accounts.`, 'bad'); return; }
      userForm(u, data);
    });
  }

  function userForm(u, data) {
    const roles = data.assignable_roles;
    const isNew = !u;
    const body = openModal(isNew ? 'Add User' : `Edit ${u.full_name}`, `
      <form id="user-form" autocomplete="off">
        <div class="field"><label for="u-name">Full name</label>
          <input id="u-name" value="${esc(u?.full_name || '')}" required maxlength="80"></div>
        ${isNew ? `
        <div class="field"><label for="u-login">Username or email</label>
          <input id="u-login" required maxlength="80" autocapitalize="none" spellcheck="false" placeholder="mike.dock">
          <div class="hint">A username (letters, numbers, dot) is easiest for dock tablets. Use an email for office staff who may want to reset their own password.</div></div>`
        : `<p class="muted">Sign in: <strong>${esc(u.login)}</strong></p>`}
        <div class="field"><label for="u-role">Role</label>
          <select id="u-role">${roles.map(r => `<option value="${r}" ${(u?.role || 'lift') === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
          <div class="hint" id="u-role-help"></div></div>
        ${isNew ? `
        <div class="field"><label for="u-pw">Temporary password</label>
          <div class="input-scan"><input id="u-pw" value="${makePassword()}" required minlength="6" maxlength="72" autocapitalize="none" spellcheck="false">
            <button type="button" class="btn secondary" id="u-gen">New</button></div></div>`
        : `<div class="field"><label class="check"><input type="checkbox" id="u-active" ${u.active ? 'checked' : ''}> Active (can sign in)</label></div>`}
        <button class="btn block" id="u-save">${isNew ? 'Create Login' : 'Save'}</button>
      </form>
      ${isNew ? '' : `
      <form id="pw-reset" style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px" autocomplete="off">
        <h3>Reset password</h3>
        <div class="input-scan"><input id="u-newpw" value="${makePassword()}" minlength="6" maxlength="72" autocapitalize="none" spellcheck="false">
          <button class="btn secondary" id="u-pwbtn">Set</button></div>
        <div class="hint">Give the new password to ${esc(u.full_name)}.</div>
      </form>`}`);
    const roleSel = $('#u-role', body);
    const help = () => { $('#u-role-help', body).textContent = ROLE_HELP[roleSel.value] || ''; };
    roleSel.onchange = help; help();
    $('#u-gen', body)?.addEventListener('click', () => { $('#u-pw', body).value = makePassword(); });

    $('#user-form', body).onsubmit = e => {
      e.preventDefault();
      busy($('#u-save', body), async () => {
        if (isNew) {
          const pw = $('#u-pw', body).value;
          const r = await callAdminUsers({ action: 'create', full_name: $('#u-name', body).value, login: $('#u-login', body).value, role: roleSel.value, password: pw });
          openModal('Login created', `
            <p>Give these to <strong>${esc(r.full_name)}</strong>:</p>
            <dl class="kv" style="font-size:20px"><dt>Sign in</dt><dd>${esc(r.login)}</dd><dt>Password</dt><dd style="font-family:monospace">${esc(pw)}</dd></dl>
            <p class="muted small">The password is not shown again. You can reset it any time from Users.</p>
            <button class="btn block" id="u-done">Done</button>`);
          $('#u-done').onclick = () => { closeModal(); viewSetup('users'); };
        } else {
          await callAdminUsers({ action: 'update', id: u.id, full_name: $('#u-name', body).value, role: roleSel.value, active: $('#u-active', body).checked });
          toast(`${$('#u-name', body).value} saved.`);
          closeModal(); viewSetup('users');
        }
      });
    };
    $('#pw-reset', body)?.addEventListener('submit', e => {
      e.preventDefault();
      busy($('#u-pwbtn', body), async () => {
        const pw = $('#u-newpw', body).value;
        await callAdminUsers({ action: 'set_password', id: u.id, password: pw });
        toast(`Password set for ${u.full_name}: ${pw}`);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* BILLING: rates, manual charges, monthly statements                  */
  /* ------------------------------------------------------------------ */
  const money = n => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const rateText = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const pad2 = n => String(n).padStart(2, '0');
  const ymOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  const validYm = v => /^\d{4}-\d{2}$/.test(v || '') ? v : null;
  function addYm(ym, n) { const [y, m] = ym.split('-').map(Number); return ymOf(new Date(y, m - 1 + n, 1)); }
  function monthLabel(ym, short = false) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', short ? { month: 'short' } : { month: 'long', year: 'numeric' });
  }
  function todayIso() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  // last day of a past month, today for the current month
  function defaultChargeDate(ym) {
    if (!ym || ym >= ymOf(new Date())) return todayIso();
    const [y, m] = ym.split('-').map(Number);
    return `${ym}-${pad2(new Date(y, m, 0).getDate())}`;
  }
  function chargeTypeById(id) { return (S.chargeTypes || []).find(t => t.id === id) || {}; }

  const RATE_GROUPS = [
    { title: 'Handling', note: 'Most contracts pay in and out together up front: put the whole fee on Inbound and leave Outbound blank.',
      rows: [['in_pallet', 'Inbound, per pallet'], ['in_unit', 'Inbound, per unit'], ['out_pallet', 'Outbound, per pallet'], ['out_unit', 'Outbound, per unit']] },
    { title: 'Load fees', rows: [['receipt_fee', 'Per inbound load (receipt)'], ['shipment_fee', 'Per outbound load (shipment)']] },
    { title: 'Storage', note: 'On arrival bills the month a pallet comes in, whatever the day. On the 1st bills everything still here at 12:00 AM.',
      rows: [['storage_init_pallet', 'On arrival, per pallet'], ['storage_init_unit', 'On arrival, per unit'],
             ['storage_recur_pallet', 'On the 1st, per pallet on hand'], ['storage_recur_unit', 'On the 1st, per unit on hand']] },
    { title: 'Monthly contract', note: 'Fixed every month, whatever is in the building.',
      rows: [['monthly_sqft', 'Space: rate per sq ft'], ['monthly_flat', 'Flat monthly fee']] }
  ];

  /* ---- charges card on a receipt or shipment ---- */
  async function wireCharges(card, ctx) {
    if (!card) return;
    const col = ctx.receipt_id ? 'receipt_id' : 'shipment_id';
    const docId = ctx.receipt_id || ctx.shipment_id;
    const draw = async () => {
      const rows = await q(sb.from('manual_charges').select('*').eq(col, docId).order('created_at'));
      if (!card.isConnected) return;
      const total = rows.reduce((a, r) => a + Number(r.amount), 0);
      card.innerHTML = `
        <div class="row spread"><h2 style="margin:0">Charges</h2>
          <button class="btn sm secondary" id="add-charge" type="button">Add Charge</button></div>
        <p class="muted small" style="margin:6px 0 0">Extras for this load: admin, special handling, after hours. Handling and storage are added automatically on the monthly statement.</p>
        ${rows.length ? `<div style="margin-top:10px">${rows.map(chargeRow).join('')}</div>
          <div class="row spread" style="margin-top:8px"><strong>Total</strong><strong>${money(total)}</strong></div>` : ''}`;
      $('#add-charge', card).onclick = () => busy(null, () => chargeForm(ctx, draw));
      wireChargeRemove(card, rows, draw);
    };
    await draw().catch(e => { if (card.isConnected) card.innerHTML = `<div class="notice bad">${esc(friendly(e))}</div>`; });
  }

  function chargeRow(r) {
    const ct = chargeTypeById(r.charge_type_id);
    return `
      <div class="list-item charge">
        <div><strong>${esc(ct.name || 'Charge')}</strong>${r.description ? ' &middot; ' + esc(r.description) : ''}
          <div class="meta">${esc(fmtDate(r.charge_date))} &middot; ${esc(fmtQty(r.qty))} ${esc(ct.unit || '')} &times; ${rateText(r.rate)}${userName(r.created_by) ? ' &middot; ' + esc(userName(r.created_by)) : ''}</div></div>
        <div class="qty">${money(r.amount)}
          ${can('manager') ? `<div><button class="btn sm ghost" type="button" data-del-charge="${r.id}">Remove</button></div>` : ''}</div>
      </div>`;
  }

  function wireChargeRemove(container, rows, after) {
    $$('[data-del-charge]', container).forEach(b => b.onclick = async () => {
      const r = rows.find(x => x.id === b.dataset.delCharge);
      if (!await askConfirm('Remove charge?', `${esc(chargeTypeById(r.charge_type_id).name || 'Charge')}, ${money(r.amount)}.`, 'Remove', true)) return;
      busy(null, async () => {
        await q(sb.from('manual_charges').delete().eq('id', r.id));
        await after();
        toast('Charge removed.');
      });
    });
  }

  // ctx: { owner_id, receipt_id?, shipment_id?, warehouse_id?, date? }
  async function chargeForm(ctx, after) {
    const types = (S.chargeTypes || []).filter(t => t.active);
    if (!types.length) throw new Error('No charge types are set up. A manager can add them under Billing > Charge Types.');
    const rates = await q(sb.from('account_rates').select('charge_type_id, rate').eq('owner_id', ctx.owner_id).eq('basis', 'manual'));
    const rateFor = id => { const r = rates.find(x => x.charge_type_id === id); return r ? Number(r.rate) : Number(chargeTypeById(id).default_rate || 0); };
    const body = openModal('Add Charge', `
      <form id="chg-form" autocomplete="off">
        <p class="muted small" style="margin-top:0">Account ${esc(ownerById(ctx.owner_id).code || '')}</p>
        <div class="field"><label for="chg-type">Charge</label>
          <select id="chg-type">${types.map(t => `<option value="${t.id}">${esc(t.name)} (per ${esc(t.unit)})</option>`).join('')}</select></div>
        <div class="grid2">
          <div class="field"><label for="chg-qty">Qty</label><input id="chg-qty" type="number" inputmode="decimal" step="any" min="0.01" value="1" required></div>
          <div class="field"><label for="chg-rate">Rate ($)</label><input id="chg-rate" type="number" inputmode="decimal" step="any" min="0" required></div>
        </div>
        <div class="field"><label for="chg-date">Date</label><input id="chg-date" type="date" value="${esc(ctx.date || todayIso())}" required></div>
        <div class="field"><label for="chg-desc">Note (prints on the statement)</label><input id="chg-desc" maxlength="120" placeholder="e.g. Sat unload, 2 hrs restack"></div>
        <p class="muted" id="chg-amt" style="font-weight:700"></p>
        <button class="btn block" id="chg-save">Add Charge</button>
      </form>`);
    const typeSel = $('#chg-type', body), qtyIn = $('#chg-qty', body), rateIn = $('#chg-rate', body);
    const showAmt = () => { $('#chg-amt', body).textContent = 'Amount: ' + money(Math.round((Number(qtyIn.value) || 0) * (Number(rateIn.value) || 0) * 100) / 100); };
    const setRate = () => { rateIn.value = rateFor(typeSel.value); showAmt(); };
    typeSel.onchange = setRate; qtyIn.oninput = showAmt; rateIn.oninput = showAmt;
    setRate();
    $('#chg-form', body).onsubmit = e => {
      e.preventDefault();
      busy($('#chg-save', body), async () => {
        const qty = Number(qtyIn.value), rate = Number(rateIn.value);
        if (!(qty > 0)) throw new Error('Qty must be more than zero.');
        if (!(rate >= 0)) throw new Error('Enter a rate.');
        await q(sb.from('manual_charges').insert({
          owner_id: ctx.owner_id, receipt_id: ctx.receipt_id || null, shipment_id: ctx.shipment_id || null,
          warehouse_id: ctx.warehouse_id || null, charge_type_id: typeSel.value, qty, rate,
          charge_date: $('#chg-date', body).value, description: strOrNull($('#chg-desc', body).value)
        }));
        closeModal();
        await after();
        toast(`Charge added: ${money(Math.round(qty * rate * 100) / 100)}.`);
      });
    };
  }

  /* ---- Billing home: every account for a month ---- */
  async function viewBilling(ymArg) {
    if (!can('manager')) { location.hash = '#/'; return; }
    const mySeq = navSeq;
    const ym = validYm(ymArg) || validYm(loadPref('billMonth', null)) || addYm(ymOf(new Date()), -1);
    if (!document.querySelector('#bill-page')) render(`<div class="loading">Loading...</div>`);
    const rows = await q(sb.rpc('wms_billing_summary', { p_month: ym + '-01' }));
    if (mySeq !== navSeq) return;
    const list = rows.map(r => ({ ...r, o: ownerById(r.owner_id) })).sort((a, b) => (a.o.code || '').localeCompare(b.o.code || ''));
    const grand = list.reduce((a, r) => a + Number(r.total), 0);
    render(`
      <div id="bill-page">
        <a class="back" href="#/">&larr; Home</a>
        <h1>Billing</h1>
        <div class="card accent">
          <div class="row spread" style="align-items:flex-end">
            <div class="field" style="margin:0"><label for="bill-month">Month</label><input id="bill-month" type="month" value="${ym}" style="width:auto"></div>
            <div style="text-align:right"><div class="muted small">All accounts</div><div class="big-money">${money(grand)}</div></div>
          </div>
        </div>
        <div class="list">${list.map(r => `
          <a class="list-item" href="#/billing/${r.owner_id}/${ym}">
            <div class="row spread"><span class="title">${esc(r.o.code || '?')} — ${esc(r.o.name || '')}</span><strong>${money(r.total)}</strong></div>
            <div class="meta">${r.status === 'closed' ? badge('closed') : '<span class="badge open">open</span>'} &middot; ${r.line_count} line${r.line_count === 1 ? '' : 's'}</div>
          </a>`).join('') || '<p class="muted">No accounts yet. Add them in Setup &gt; Accounts.</p>'}</div>
        <p class="muted small">Open months are live and change as loads come and go. Close a month after it's billed to freeze it.</p>
        <div class="btn-row"><button class="btn secondary" id="charge-types" type="button">Charge Types</button></div>
      </div>`);
    $('#bill-month').onchange = e => { if (validYm(e.target.value)) { savePref('billMonth', e.target.value); viewBilling(e.target.value); } };
    $('#charge-types').onclick = () => chargeTypesModal();
  }

  /* ---- one account's statement for a month ---- */
  async function viewStatement(ownerId, ymArg) {
    if (!can('manager')) { location.hash = '#/'; return; }
    const mySeq = navSeq;
    const owner = ownerById(ownerId);
    if (!owner.id) { render(`<div class="card"><h2>Account not found</h2><a class="btn" href="#/billing">Billing</a></div>`); return; }
    const ym = validYm(ymArg) || addYm(ymOf(new Date()), -1);
    savePref('billMonth', ym);
    if (!document.querySelector('#st-page')) render(`<div class="loading">Loading...</div>`);
    const [st, charges, rates] = await Promise.all([
      q(sb.rpc('wms_billing_statement', { p_owner_id: ownerId, p_month: ym + '-01' })),
      q(sb.from('manual_charges').select('*').eq('owner_id', ownerId).gte('charge_date', ym + '-01').lt('charge_date', addYm(ym, 1) + '-01').order('charge_date')),
      q(sb.from('account_rates').select('id').eq('owner_id', ownerId))
    ]);
    if (mySeq !== navSeq) return;
    const isOpen = st.status === 'open';
    const lines = st.lines || [];
    const cats = [...new Set(lines.map(l => l.category))];
    const showWh = new Set(lines.map(l => l.warehouse_code).filter(Boolean)).size > 1;
    const lineRow = l => `
      <div class="list-item st-line">
        <div>${esc(l.description)}
          <div class="meta">${esc([showWh && l.warehouse_code, l.ref].filter(Boolean).join(' · '))}${(showWh && l.warehouse_code) || l.ref ? ' &middot; ' : ''}${esc(fmtQty(l.qty))} ${esc(Number(l.qty) === 1 && l.uom === 'pallets' ? 'pallet' : (l.uom || ''))} &times; ${rateText(l.rate)}</div></div>
        <div class="qty">${money(l.amount)}</div>
      </div>`;
    render(`
      <div id="st-page">
        <a class="back" href="#/billing">&larr; Billing</a>
        <div class="row spread"><h1>${esc(owner.code)} &middot; ${esc(monthLabel(ym))}</h1>${isOpen ? '<span class="badge open">open</span>' : badge('closed')}</div>
        <div class="row" style="gap:8px;margin:-4px 0 12px">
          <a class="btn sm ghost" href="#/billing/${ownerId}/${addYm(ym, -1)}">&lsaquo; ${esc(monthLabel(addYm(ym, -1), true))}</a>
          <a class="btn sm ghost" href="#/billing/${ownerId}/${addYm(ym, 1)}">${esc(monthLabel(addYm(ym, 1), true))} &rsaquo;</a>
          <span class="muted small">Statement ${esc(st.statement_no)}</span>
        </div>
        ${!isOpen ? `<div class="notice ok">Closed ${esc(fmtDateTime(st.closed_at))}${st.closed_by ? ' by ' + esc(st.closed_by) : ''}. These numbers are frozen.</div>`
          : st.month_ended ? `<div class="notice warn">${esc(monthLabel(ym))} is over. Review the charges, then <strong>Close Month</strong> to freeze this statement.</div>`
          : `<div class="notice">Month in progress. These numbers update as loads come and go.</div>`}
        ${!rates.length ? `<div class="notice warn">No rates are set for ${esc(owner.code)} yet, so only manual charges show. Tap <strong>Rates</strong> to enter the contract.</div>` : ''}
        <div class="card">
          ${cats.length ? cats.map(c => {
            const rows = lines.filter(l => l.category === c);
            return `<h2 style="margin:4px 0 6px">${esc(c)}</h2>${rows.map(lineRow).join('')}
              <div class="row spread small" style="margin:4px 0 12px"><span class="muted">${esc(c)} subtotal</span><strong>${money(rows.reduce((a, l) => a + Number(l.amount), 0))}</strong></div>`;
          }).join('') : '<p class="muted">No charges for this month.</p>'}
          <div class="row spread st-total"><strong>Total</strong><strong class="big-money">${money(st.total)}</strong></div>
        </div>
        ${charges.length ? `<div class="card"><h2 style="margin-top:0">Manual charges this month</h2><div id="st-charges">${charges.map(chargeRow).join('')}</div></div>` : ''}
        <div class="btn-row">
          <button class="btn dark" id="st-print" type="button">Print Statement</button>
          <button class="btn secondary" id="st-csv" type="button">Export CSV</button>
          <button class="btn secondary" id="st-detail" type="button">Pallet Detail CSV</button>
          <button class="btn secondary" id="st-rates" type="button">Rates</button>
          ${isOpen ? '<button class="btn secondary" id="st-add" type="button">Add Charge</button>' : ''}
          ${isOpen && st.month_ended ? '<button class="btn" id="st-close" type="button">Close Month</button>' : ''}
          ${!isOpen && can('admin') ? '<button class="btn danger" id="st-reopen" type="button">Reopen Month</button>' : ''}
        </div>
      </div>`);
    const page = $('#st-page');
    const reload = () => viewStatement(ownerId, ym);
    if (isOpen) wireChargeRemove(page, charges, reload);
    else $$('[data-del-charge]', page).forEach(b => b.remove());

    $('#st-print').onclick = () => WmsPrint.statement(st, owner, S.settings, monthLabel(ym));
    $('#st-csv').onclick = () => {
      const n = downloadCsv(`statement-${st.statement_no}.csv`,
        ['Statement', 'Account', 'Month', 'Status', 'Category', 'Description', 'Warehouse', 'Ref', 'Qty', 'Unit', 'Rate', 'Amount'],
        lines.map(l => [st.statement_no, owner.code, ym, st.status, l.category, l.description, l.warehouse_code, l.ref, l.qty, l.uom, l.rate, l.amount]));
      toast(`Exported ${n} line${n === 1 ? '' : 's'}.`);
    };
    $('#st-detail').onclick = () => busy($('#st-detail'), async () => {
      const rows = await q(sb.rpc('wms_billing_detail', { p_owner_id: ownerId, p_month: ym + '-01' }));
      const n = downloadCsv(`billing-detail-${owner.code}-${ym}.csv`,
        ['Event', 'Date', 'Warehouse', 'Ref', 'WMS Pallet ID', lbl.cust(), 'SKU', lbl.lot(), 'Qty', 'UOM'],
        rows.map(r => [r.event, fmtDateTime(r.event_at), r.warehouse_code, r.ref, r.lp_id, r.customer_pallet_id, r.sku, r.lot_number, r.qty, r.uom]));
      toast(`Exported ${n} pallet row${n === 1 ? '' : 's'}.`);
    });
    $('#st-rates').onclick = () => busy(null, () => ratesModal(owner, reload));
    $('#st-add')?.addEventListener('click', () => busy(null, () => chargeForm({ owner_id: ownerId, date: defaultChargeDate(ym) }, reload)));
    $('#st-close')?.addEventListener('click', async () => {
      if (!await askConfirm(`Close ${monthLabel(ym)}?`,
        `This freezes statement ${esc(st.statement_no)} at ${money(st.total)}. Charges for ${esc(monthLabel(ym))} can't be added or removed until an admin reopens it.`, 'Close Month')) return;
      busy($('#st-close'), async () => {
        await q(sb.rpc('wms_close_billing_period', { p_owner_id: ownerId, p_month: ym + '-01' }));
        await reload();
        toast(`${monthLabel(ym)} closed for ${owner.code}.`);
      });
    });
    $('#st-reopen')?.addEventListener('click', async () => {
      if (!await askConfirm(`Reopen ${monthLabel(ym)}?`,
        'The statement goes back to live numbers, which may differ from what was billed. Close it again when done.', 'Reopen', true)) return;
      busy($('#st-reopen'), async () => {
        await q(sb.rpc('wms_reopen_billing_period', { p_owner_id: ownerId, p_month: ym + '-01' }));
        await reload();
        toast(`${monthLabel(ym)} reopened.`);
      });
    });
  }

  /* ---- an account's contract rates ---- */
  async function ratesModal(owner, after) {
    const existing = await q(sb.from('account_rates').select('*').eq('owner_id', owner.id));
    const find = (basis, ct = null) => existing.find(r => r.basis === basis && (r.charge_type_id || null) === ct);
    const val = r => r ? String(Number(r.rate)) : '';
    const types = (S.chargeTypes || []).filter(t => t.active);
    const sq = find('monthly_sqft');
    const body = openModal(`Rates: ${owner.code}`, `
      <form id="rates-form" autocomplete="off">
        <p class="muted small" style="margin-top:0">Dollars per unit. Leave a box blank if the contract doesn't charge it. Changes apply to open months; closed months keep what was billed.</p>
        ${RATE_GROUPS.map(g => `
          <h2 style="margin:14px 0 4px">${esc(g.title)}</h2>
          ${g.note ? `<p class="muted small" style="margin:0 0 6px">${esc(g.note)}</p>` : ''}
          <div class="grid2">${g.rows.map(([b, label]) => `
            <div class="field"><label for="r-${b}">${esc(label)}</label>
              <input id="r-${b}" type="number" inputmode="decimal" step="any" min="0" value="${esc(val(find(b)))}" placeholder="not billed"></div>
            ${b === 'monthly_sqft' ? `<div class="field"><label for="r-sqft">Contract sq ft</label>
              <input id="r-sqft" type="number" inputmode="numeric" step="any" min="1" value="${esc(sq?.qty ? String(Number(sq.qty)) : '')}"></div>` : ''}`).join('')}
          </div>`).join('')}
        <h2 style="margin:14px 0 4px">Accessorial prices</h2>
        <p class="muted small" style="margin:0 0 6px">This account's price for each extra charge. Blank uses the standard rate shown.</p>
        <div class="grid2">${types.map(t => `
          <div class="field"><label for="r-ct-${t.id}">${esc(t.name)} (per ${esc(t.unit)})</label>
            <input id="r-ct-${t.id}" type="number" inputmode="decimal" step="any" min="0" value="${esc(val(find('manual', t.id)))}" placeholder="${esc(rateText(t.default_rate))}"></div>`).join('')}
        </div>
        <button class="btn block" id="rates-save" style="margin-top:10px">Save Rates</button>
      </form>`);
    $('#rates-form', body).onsubmit = e => {
      e.preventDefault();
      busy($('#rates-save', body), async () => {
        const want = [];
        RATE_GROUPS.forEach(g => g.rows.forEach(([b]) => want.push({ basis: b, charge_type_id: null, rate: numOrNull($('#r-' + b, body).value) })));
        types.forEach(t => want.push({ basis: 'manual', charge_type_id: t.id, rate: numOrNull($('#r-ct-' + t.id, body).value) }));
        const sqft = numOrNull($('#r-sqft', body).value);
        for (const w of want) if (w.rate !== null && !(w.rate >= 0)) throw new Error('Rates must be zero or more.');
        if (want.find(w => w.basis === 'monthly_sqft').rate !== null && !(sqft > 0)) throw new Error('Enter the contract square feet for the space rate.');
        for (const w of want) {
          const cur = find(w.basis, w.charge_type_id);
          const qty = w.basis === 'monthly_sqft' ? sqft : null;
          if (w.rate === null) { if (cur) await q(sb.from('account_rates').delete().eq('id', cur.id)); continue; }
          if (cur && Number(cur.rate) === w.rate && (cur.qty === null ? null : Number(cur.qty)) === qty) continue;
          if (cur) await q(sb.from('account_rates').update({ rate: w.rate, qty }).eq('id', cur.id));
          else await q(sb.from('account_rates').insert({ owner_id: owner.id, basis: w.basis, charge_type_id: w.charge_type_id, rate: w.rate, qty }));
        }
        closeModal();
        await after();
        toast(`Rates saved for ${owner.code}.`);
      });
    };
  }

  /* ---- accessorial charge types (shared by all accounts) ---- */
  function chargeTypesModal() {
    const rows = S.chargeTypes || [];
    const body = openModal('Charge Types', `
      <p class="muted small" style="margin-top:0">Extra charges office staff can add to a receipt, shipment or account. The standard rate is used unless an account has its own price under Rates.</p>
      <div class="list">${rows.map(t => `
        <a class="list-item" href="#" data-ct="${t.id}" style="${t.active ? '' : 'opacity:.55'}">
          <div class="row spread"><span class="title">${esc(t.name)}</span><span>${rateText(t.default_rate)} / ${esc(t.unit)}</span></div>
          <div class="meta">${esc(t.code)}${t.active ? '' : ' &middot; inactive'}</div></a>`).join('')}</div>
      <button class="btn block" id="add-ct" type="button" style="margin-top:10px">Add Charge Type</button>`);
    $('#add-ct', body).onclick = () => chargeTypeForm(null);
    $$('[data-ct]', body).forEach(a => a.onclick = e => { e.preventDefault(); chargeTypeForm(rows.find(r => r.id === a.dataset.ct)); });
  }

  function chargeTypeForm(t) {
    const r = t || { unit: 'each', default_rate: 0, active: true, sort_order: (S.chargeTypes || []).length + 1 };
    const body = openModal(t ? `Edit ${t.code}` : 'Add Charge Type', `
      <form id="ct-form" autocomplete="off">
        <div class="grid2">
          <div class="field"><label for="ct-code">Code</label><input id="ct-code" value="${esc(r.code || '')}" required maxlength="12" autocapitalize="characters" placeholder="LUMPER"></div>
          <div class="field"><label for="ct-name">Name</label><input id="ct-name" value="${esc(r.name || '')}" required maxlength="60" placeholder="Lumper service"></div>
          <div class="field"><label for="ct-unit">Unit</label><input id="ct-unit" value="${esc(r.unit || 'each')}" required maxlength="20" placeholder="each, hour, pallet"></div>
          <div class="field"><label for="ct-rate">Standard rate ($)</label><input id="ct-rate" type="number" inputmode="decimal" step="any" min="0" value="${esc(String(Number(r.default_rate || 0)))}" required></div>
        </div>
        <div class="field"><label class="check"><input type="checkbox" id="ct-active" ${r.active ? 'checked' : ''}> Active</label></div>
        <button class="btn block" id="ct-save">${t ? 'Save' : 'Add Charge Type'}</button>
      </form>`);
    $('#ct-form', body).onsubmit = e => {
      e.preventDefault();
      busy($('#ct-save', body), async () => {
        const row = {
          code: $('#ct-code', body).value.trim().toUpperCase(), name: $('#ct-name', body).value.trim(),
          unit: $('#ct-unit', body).value.trim().toLowerCase(), default_rate: Number($('#ct-rate', body).value) || 0,
          active: $('#ct-active', body).checked
        };
        if (t) await q(sb.from('charge_types').update(row).eq('id', t.id));
        else await q(sb.from('charge_types').insert({ ...row, sort_order: r.sort_order }));
        S.chargeTypes = await q(sb.from('charge_types').select('*').order('sort_order').order('name'));
        toast(`${row.code} saved.`);
        chargeTypesModal();
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* REPORTS & EXPORTS (CSV, opens in Excel)                             */
  /* ------------------------------------------------------------------ */
  function downloadCsv(filename, headers, rows) {
    const cell = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = '﻿' + [headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return rows.length;
  }
  const idHeaders = () => idFields().map(f => f.label);
  const idValues = r => idFields().map(f => r[f.field] || '');
  const localStamp = () => ymd(new Date());

  async function viewReports() {
    if (isLift() || !can('viewer')) { location.hash = '#/'; return; }
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    render(`
      <a class="back" href="#/">&larr; Home</a>
      <h1>Reports</h1>
      <p class="muted">Downloads open in Excel. Customer field names (${esc(idHeaders().concat(lbl.lotShort()).join(', '))}) are used as column headers.</p>

      <div class="card accent">
        <h2>Inventory on hand</h2>
        <div class="btn-row">
          <button class="btn" data-rpt="pallets">By pallet</button>
          <button class="btn secondary" data-rpt="lots">By item &amp; ${esc(lbl.lotShort().toLowerCase())}</button>
        </div>
        <div class="hint">Right now, including allocated quantities and locations.</div>
      </div>

      <div class="card">
        <h2>Activity for a date range</h2>
        <div class="grid2">
          <div class="field"><label for="r-from">From</label><input id="r-from" type="date" value="${ymd(first)}"></div>
          <div class="field"><label for="r-to">Through</label><input id="r-to" type="date" value="${ymd(today)}"></div>
        </div>
        <div class="btn-row">
          <button class="btn" data-rpt="received">Received pallets</button>
          <button class="btn" data-rpt="shipped">Shipped pallets</button>
          <button class="btn secondary" data-rpt="txns">All transactions</button>
          <button class="btn secondary" data-view="audit">Adjustments &amp; voids</button>
        </div>
        <div class="hint">Received and shipped list one row per pallet with the receipt / BOL number, for billing and customer questions. Adjustments &amp; voids lists every quantity change, hold and void with who did it and why.</div>
      </div>

      <div class="card">
        <h2>Lot trace / recall</h2>
        <div class="grid2">
          <div class="field"><label for="lt-lot">${esc(lbl.lot())}</label><input id="lt-lot" autocomplete="off" placeholder="e.g. 10-08/26"></div>
          <div class="field"><label for="lt-sku">SKU (optional)</label><input id="lt-sku" autocomplete="off" autocapitalize="characters"></div>
        </div>
        <div class="btn-row"><button class="btn" data-view="trace">Trace ${esc(lbl.lotShort().toLowerCase())}</button></div>
        <div class="hint">Every pallet of the ${esc(lbl.lotShort().toLowerCase())}: when it came in, every shipment it went out on (ship-to and BOL #), and what's still here.</div>
      </div>

      <div class="card">
        <h2>Inventory as of a date</h2>
        <div class="grid2">
          <div class="field"><label for="asof">On hand at the end of</label><input id="asof" type="date" value="${ymd(addDays(first, -1))}"></div>
          ${multiWh() ? `<div class="field"><label for="asof-wh">Warehouse</label><select id="asof-wh"><option value="">All warehouses</option>${activeWhs().map(w => `<option value="${w.id}">${esc(w.code)} — ${esc(w.name)}</option>`).join('')}</select></div>` : ''}
        </div>
        <div class="btn-row"><button class="btn" data-view="asof">Show inventory</button></div>
        <div class="hint">Rebuilt from the pallet history, e.g. month-end inventory for a customer or an audit.</div>
      </div>
      <div id="rpt-msg"></div>
      <div id="rpt-out"></div>`);

    const range = () => {
      const f = $('#r-from').value, t = $('#r-to').value;
      if (!f || !t || f > t) throw new Error('Pick a valid date range.');
      return { f, t, from: parseYmd(f).toISOString(), to: addDays(parseYmd(t), 1).toISOString() };
    };
    const done = (n, what) => { $('#rpt-msg').innerHTML = `<div class="notice ok">${n} row${n === 1 ? '' : 's'} exported: ${esc(what)}.</div>`; };

    const reports = {
      pallets: async () => {
        const rows = await fetchAll(() => sb.from('v_inventory').select('*').order('warehouse_code').order('owner_code').order('sku').order('lot_number').order('lp_id'));
        done(downloadCsv(`inventory-by-pallet-${localStamp()}.csv`,
          ['Warehouse', 'Account', 'WMS Pallet ID', ...idHeaders(), 'SKU', 'Description', lbl.lotShort(), 'Production Date', 'Expiration Date',
            'Qty On Hand', 'UOM', 'Allocated', 'Available', 'Location', 'Status', 'Received', 'Receipt #'],
          rows.map(r => [r.warehouse_code, r.owner_code, r.lp_id, ...idValues(r), r.sku, r.description, r.lot_number, r.production_date, r.expiration_date,
            r.qty_on_hand, r.uom, r.qty_allocated, r.qty_available, r.location, r.status, fmtDateTime(r.received_at), r.receipt_no])), 'inventory by pallet');
      },
      lots: async () => {
        const rows = await fetchAll(() => sb.from('v_inventory_by_lot').select('*').order('warehouse_code').order('owner_code').order('sku').order('lot_number').order('item_id'));
        done(downloadCsv(`inventory-by-lot-${localStamp()}.csv`,
          ['Warehouse', 'Account', 'SKU', 'Description', lbl.lotShort(), 'Pallets', 'Qty On Hand', 'Allocated', 'Available', 'UOM', 'Oldest Received'],
          rows.map(r => [r.warehouse_code, r.owner_code, r.sku, r.description, r.lot_number, r.pallets, r.qty_on_hand, r.qty_allocated, r.qty_available, r.uom, fmtDate(r.oldest_received)])),
          'inventory by item and ' + lbl.lotShort().toLowerCase());
      },
      received: async () => {
        const g = range();
        const rcpts = await fetchAll(() => sb.from('receipts').select('id, receipt_no, received_at, vendor_name, carrier, trailer_no, po_number, inbound_bol, status, warehouse_id, owner_id')
          .neq('status', 'void').gte('received_at', g.from).lt('received_at', g.to).order('id'));
        const byId = Object.fromEntries(rcpts.map(r => [r.id, r]));
        const pallets = await fetchIn(rcpts.map(r => r.id), chunk => () => sb.from('pallets')
          .select('lp_id, customer_pallet_id, ref1, ref2, item_id, lot_number, qty_received, status, receipt_id')
          .in('receipt_id', chunk).neq('status', 'void').order('lp_id'));
        done(downloadCsv(`received-${g.f}-to-${g.t}.csv`,
          ['Warehouse', 'Account', 'Received', 'Receipt #', 'Vendor', 'Carrier', 'Trailer #', 'PO #', 'Inbound BOL', 'WMS Pallet ID', ...idHeaders(),
            'SKU', 'Description', lbl.lotShort(), 'Qty Received', 'UOM'],
          pallets.map(p => { const r = byId[p.receipt_id], it = itemById(p.item_id);
            return [whById(r.warehouse_id).code, ownerById(r.owner_id).code, fmtDateTime(r.received_at), r.receipt_no, r.vendor_name, r.carrier, r.trailer_no, r.po_number, r.inbound_bol,
              p.lp_id, ...idValues(p), it.sku, it.description, p.lot_number, p.qty_received, it.uom]; })), 'received pallets');
      },
      shipped: async () => {
        const g = range();
        const ships = await fetchAll(() => sb.from('shipments').select('id, shipment_no, shipped_at, ship_to_name, ship_to_city, ship_to_state, carrier, pro_number, customer_order_no, po_number, warehouse_id, owner_id')
          .eq('status', 'shipped').gte('shipped_at', g.from).lt('shipped_at', g.to).order('id'));
        const byId = Object.fromEntries(ships.map(s => [s.id, s]));
        const lines = await fetchIn(ships.map(s => s.id), chunk => () => sb.from('v_shipment_detail').select('*').in('shipment_id', chunk).order('shipment_id').order('lp_id'));
        done(downloadCsv(`shipped-${g.f}-to-${g.t}.csv`,
          ['Warehouse', 'Account', 'Shipped', 'BOL #', 'Ship To', 'City', 'State', 'Carrier', 'PRO #', 'Order #', 'PO #', 'WMS Pallet ID', ...idHeaders(),
            'SKU', 'Description', lbl.lotShort(), 'Qty Shipped', 'UOM', 'Weight (lbs)'],
          lines.map(l => { const s = byId[l.shipment_id];
            return [whById(s.warehouse_id).code, ownerById(s.owner_id).code, fmtDateTime(s.shipped_at), s.shipment_no, s.ship_to_name, s.ship_to_city, s.ship_to_state, s.carrier, s.pro_number,
              s.customer_order_no, s.po_number, l.lp_id, ...idValues(l), l.sku, l.description, l.lot_number, l.qty, l.uom, l.product_weight_lbs]; })),
          'shipped pallets');
      },
      txns: async () => {
        const g = range();
        const rows = await fetchAll(() => sb.from('v_transactions').select('*').gte('created_at', g.from).lt('created_at', g.to).order('id'));
        done(downloadCsv(`transactions-${g.f}-to-${g.t}.csv`,
          ['When', 'Action', 'Account', 'WMS Pallet ID', lbl.cust(), 'SKU', lbl.lotShort(), 'Qty Change', 'Qty After',
            'From Warehouse', 'From', 'To Warehouse', 'To', 'Receipt #', 'BOL #', 'Reason', 'User'],
          rows.map(r => [fmtDateTime(r.created_at), r.txn_type, r.owner_code, r.lp_id, r.customer_pallet_id, r.sku, r.lot_number, r.qty_change, r.qty_after,
            r.from_warehouse, r.from_location, r.to_warehouse, r.to_location, r.receipt_no, r.shipment_no, r.reason, r.user_name])), 'transactions');
      }
    };
    $$('[data-rpt]').forEach(b => b.onclick = () => busy(b, reports[b.dataset.rpt]));

    // on-screen reports: a table with Export and Print
    const show = (title, sub, cols, rows, file) => {
      const out = $('#rpt-out');
      out.innerHTML = `
        <div class="card" id="rpt-view">
          <div class="row spread"><div><h2 style="margin:0">${esc(title)}</h2><div class="muted small">${esc(sub)}</div></div>
            <div class="row"><button class="btn secondary sm" id="rv-csv" type="button">Export CSV</button><button class="btn secondary sm" id="rv-print" type="button">Print</button></div></div>
          ${rows.length ? `<div class="table-wrap" style="margin-top:10px"><table class="data">
            <thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${rows.slice(0, 1000).map(r => `<tr>${r.map((v, i) => `<td class="${cols[i].num ? 'num' : ''}">${esc(v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
          </table></div>${rows.length > 1000 ? '<p class="muted small">Showing the first 1,000 rows. Export to see them all.</p>' : ''}` : '<p class="muted" style="margin-top:10px">Nothing found.</p>'}
        </div>`;
      $('#rv-csv').onclick = () => { const n = downloadCsv(file, cols.map(c => c.label), rows); toast(`Exported ${n} row${n === 1 ? '' : 's'}.`); };
      $('#rv-print').onclick = () => WmsPrint.table(title, sub, cols, rows.map(r => r.map(v => String(v ?? ''))), S.settings);
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const views = {
      trace: async () => {
        const lot = $('#lt-lot').value.trim(), sku = $('#lt-sku').value.trim();
        if (!lot) throw new Error(`Enter the ${lbl.lotShort().toLowerCase()} to trace.`);
        const rows = await fetchAll(() => sb.rpc('wms_lot_trace', { p_lot: lot, p_sku: sku || null }));
        const sum = ev => rows.filter(r => r.event === ev);
        const units = list => { const u = [...new Set(list.map(r => r.uom))]; return u.length === 1 ? `${fmtQty(list.reduce((a, r) => a + Number(r.qty), 0))} ${u[0]}` : `${list.length} lines`; };
        const rec = sum('RECEIVED'), shp = sum('SHIPPED'), oh = sum('ON HAND');
        const shipTo = new Set(shp.map(r => r.party)).size;
        show(`Lot trace: ${lot.toUpperCase()}${sku ? ' · ' + sku.toUpperCase() : ''}`,
          rows.length ? `Received ${rec.length} pallet${rec.length === 1 ? '' : 's'} (${units(rec)}) · shipped ${shp.length ? units(shp) : 'none'} to ${shipTo} ship-to${shipTo === 1 ? '' : 's'} · on hand ${oh.length ? units(oh) : 'none'}` : 'No pallets with that lot.',
          [{ label: 'Event' }, { label: 'Date' }, { label: 'WMS Pallet ID' }, { label: lbl.cust() }, { label: 'SKU' }, { label: lbl.lotShort() },
           { label: 'Qty', num: true }, { label: 'UOM' }, { label: 'Receipt / BOL #' }, { label: 'Vendor / Ship-to' }, { label: 'City' },
           ...(multiOwner() ? [{ label: 'Account' }] : []), ...(multiWh() ? [{ label: 'Whse' }] : []), { label: 'Location now' }],
          rows.map(r => [r.event, r.event === 'ON HAND' ? 'now' : fmtDateTime(r.event_at), r.lp_id, r.customer_pallet_id, r.sku, r.lot_number,
            fmtQty(r.qty), r.uom, r.doc_no, r.party, r.party_city, ...(multiOwner() ? [r.owner_code] : []), ...(multiWh() ? [r.warehouse_code] : []),
            r.status_now === 'shipped' ? 'shipped' : r.location_now]),
          `lot-trace-${lot.replace(/[^\w-]+/g, '_')}.csv`);
      },
      asof: async () => {
        const d = $('#asof').value;
        if (!d) throw new Error('Pick a date.');
        const wh = $('#asof-wh')?.value || null;
        const rows = await fetchAll(() => sb.rpc('wms_inventory_as_of', { p_date: d, p_warehouse_id: wh }));
        const uoms = [...new Set(rows.map(r => r.uom))];
        show(`Inventory on hand at end of ${fmtDate(d)}`,
          `${rows.length} pallet${rows.length === 1 ? '' : 's'}${uoms.length === 1 ? ' · ' + fmtQty(rows.reduce((a, r) => a + Number(r.qty), 0)) + ' ' + uoms[0] : ''}${wh ? ' · ' + whById(wh).code : ''}`,
          [...(multiWh() ? [{ label: 'Whse' }] : []), ...(multiOwner() ? [{ label: 'Account' }] : []), { label: 'Location' }, { label: 'WMS Pallet ID' }, ...idHeaders().map(h => ({ label: h })),
           { label: 'SKU' }, { label: 'Description' }, { label: lbl.lotShort() }, { label: 'Qty', num: true }, { label: 'UOM' }, { label: 'Received' }, { label: 'Receipt #' }],
          rows.map(r => [...(multiWh() ? [r.warehouse_code] : []), ...(multiOwner() ? [r.owner_code] : []), r.location, r.lp_id, ...idValues(r),
            r.sku, r.description, r.lot_number, fmtQty(r.qty), r.uom, fmtDate(r.received_at), r.receipt_no]),
          `inventory-as-of-${d}.csv`);
      },
      audit: async () => {
        const g = range();
        const rows = await fetchAll(() => sb.from('v_transactions').select('*')
          .in('txn_type', ['ADJUST', 'HOLD', 'RELEASE', 'VOID_RECEIVE', 'VOID_SHIP']).gte('created_at', g.from).lt('created_at', g.to).order('id'));
        const what = { ADJUST: 'Qty adjusted', HOLD: 'Put on hold', RELEASE: 'Released from hold', VOID_RECEIVE: 'Pallet voided', VOID_SHIP: 'Shipment voided (returned to stock)' };
        show(`Adjustments & voids, ${fmtDate(g.f)} to ${fmtDate(g.t)}`, `${rows.length} change${rows.length === 1 ? '' : 's'}`,
          [{ label: 'When' }, { label: 'What' }, ...(multiOwner() ? [{ label: 'Account' }] : []), { label: 'WMS Pallet ID' }, { label: 'SKU' }, { label: lbl.lotShort() },
           { label: 'Qty change', num: true }, { label: 'Qty after', num: true }, { label: 'Ref' }, { label: 'Reason' }, { label: 'By' }],
          rows.map(r => [fmtDateTime(r.created_at), what[r.txn_type] || r.txn_type, ...(multiOwner() ? [r.owner_code] : []), r.lp_id, r.sku, r.lot_number,
            Number(r.qty_change) ? fmtQty(r.qty_change) : '', fmtQty(r.qty_after), r.receipt_no || r.shipment_no || '', r.reason, r.user_name]),
          `adjustments-voids-${g.f}-to-${g.t}.csv`);
      }
    };
    $$('[data-view]').forEach(b => b.onclick = () => busy(b, views[b.dataset.view]));
    $('#lt-lot').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); busy($('[data-view=trace]'), views.trace); } });
  }

  /* ------------------------------------------------------------------ */
  /* setup: items, locations, customers & vendors, company              */
  /* ------------------------------------------------------------------ */
  async function viewSetup(tab) {
    if (!can('manager')) { location.hash = '#/'; return; }
    const mySeq = navSeq;
    await loadRef();
    if (mySeq !== navSeq) return;
    const tabs = [['items', 'Items'], ['locations', 'Locations'], ['accounts', 'Accounts'], ['parties', 'Ship-To'],
      ['warehouses', 'Warehouses'], ['users', 'Users']].concat(can('admin') ? [['company', 'Company']] : []);
    render(`
      <a class="back" href="#/">&larr; Home</a>
      <h1>Setup</h1>
      <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/setup/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
      <div id="setup-body"></div>`);
    const out = $('#setup-body');
    if (tab === 'locations') return setupLocations(out);
    if (tab === 'parties') return setupParties(out);
    if (tab === 'accounts') return setupAccounts(out);
    if (tab === 'warehouses') return setupWarehouses(out);
    if (tab === 'users') return setupUsers(out);
    if (tab === 'company' && can('admin')) return setupCompany(out);
    return setupItems(out);
  }

  function setupItems(out) {
    const f = loadPref('itemsOwner', '');
    const list = S.items.filter(i => !f || i.owner_id === f);
    out.innerHTML = `
      <div class="row spread" style="margin-bottom:10px">
        ${multiOwner() ? `<select id="items-owner" style="width:auto;min-height:44px"><option value="">All accounts</option>
          ${activeOwners().map(o => `<option value="${o.id}" ${o.id === f ? 'selected' : ''}>${esc(o.code)}</option>`).join('')}</select>`
          : `<span class="muted">${list.length} items</span>`}
        <button class="btn" id="add-item">Add Item</button></div>
      ${list.length ? list.map(i => `
        <a class="list-item" href="#" data-item="${i.id}" style="${i.active ? '' : 'opacity:.55'}">
          <div class="row spread"><span class="title">${esc(i.sku)}</span>
            <span>${multiOwner() ? '<span class="badge">' + esc(ownerById(i.owner_id).code) + '</span> ' : ''}${i.active ? '' : badge('inactive')}</span></div>
          <div>${esc(i.description)}</div>
          <div class="meta">${esc(i.uom)}${i.units_per_pallet ? ` &middot; ${esc(fmtQty(i.units_per_pallet))} per pallet` : ''} &middot; ${esc(lbl.lotShort())} ${i.lot_required ? 'required' : 'optional'}</div>
        </a>`).join('') : '<p class="muted">No items yet. Add the products this warehouse stores.</p>'}`;
    $('#items-owner', out)?.addEventListener('change', e => { savePref('itemsOwner', e.target.value); viewSetup('items'); });
    $('#add-item', out).onclick = () => itemForm(null);
    $$('[data-item]', out).forEach(a => a.onclick = e => { e.preventDefault(); itemForm(S.items.find(i => i.id === a.dataset.item)); });
  }

  function itemForm(it) {
    const i = it || { uom: S.settings?.default_uom || 'EA', lot_required: true, active: true, owner_id: loadPref('itemsOwner', '') || undefined };
    const body = openModal(it ? `Edit ${it.sku}` : 'Add Item', `
      <form id="item-form">
        <div class="field"><label for="f-owner">Customer account</label>
          <select id="f-owner" required>${ownerOptions(i.owner_id)}</select></div>
        <div class="field"><label for="f-sku">SKU / Item #</label>
          <input id="f-sku" value="${esc(i.sku || '')}" required maxlength="60" autocapitalize="characters"></div>
        <div class="field"><label for="f-desc">Description</label>
          <input id="f-desc" value="${esc(i.description || '')}" required maxlength="200"></div>
        <div class="grid2">
          <div class="field"><label for="f-uom">Unit of measure</label>
            <input id="f-uom" value="${esc(i.uom || '')}" required maxlength="10" placeholder="EA, CS, LB"></div>
          <div class="field"><label for="f-upp">Standard qty per pallet</label>
            <input id="f-upp" type="number" inputmode="decimal" min="0" step="any" value="${esc(i.units_per_pallet ?? '')}"></div>
          <div class="field"><label for="f-wt">Weight per unit (lbs)</label>
            <input id="f-wt" type="number" inputmode="decimal" min="0" step="any" value="${esc(i.unit_weight_lbs ?? '')}"></div>
          <div class="field"><label for="f-class">Freight class</label>
            <input id="f-class" value="${esc(i.freight_class || '')}" maxlength="10"></div>
          <div class="field"><label for="f-nmfc">NMFC #</label>
            <input id="f-nmfc" value="${esc(i.nmfc || '')}" maxlength="20"></div>
        </div>
        <div class="field"><label class="check"><input type="checkbox" id="f-lot" ${i.lot_required ? 'checked' : ''}> ${esc(lbl.lot())} required</label></div>
        <div class="field"><label class="check"><input type="checkbox" id="f-active" ${i.active ? 'checked' : ''}> Active</label></div>
        <div class="field"><label for="f-notes">Notes</label><input id="f-notes" value="${esc(i.notes || '')}" maxlength="300"></div>
        <button class="btn block" id="item-save">${it ? 'Save Item' : 'Add Item'}</button>
      </form>`);
    $('#item-form', body).onsubmit = e => {
      e.preventDefault();
      busy($('#item-save', body), async () => {
        const row = {
          sku: $('#f-sku', body).value.trim().toUpperCase(),
          description: $('#f-desc', body).value.trim(),
          uom: $('#f-uom', body).value.trim().toUpperCase(),
          units_per_pallet: numOrNull($('#f-upp', body).value),
          unit_weight_lbs: numOrNull($('#f-wt', body).value),
          freight_class: strOrNull($('#f-class', body).value),
          nmfc: strOrNull($('#f-nmfc', body).value),
          lot_required: $('#f-lot', body).checked,
          active: $('#f-active', body).checked,
          notes: strOrNull($('#f-notes', body).value),
          owner_id: $('#f-owner', body).value || null
        };
        if (!row.owner_id) throw new Error('Pick the customer account.');
        if (it) await q(sb.from('items').update(row).eq('id', it.id));
        else await q(sb.from('items').insert(row));
        toast(`${row.sku} saved.`);
        closeModal();
        viewSetup('items');
      });
    };
  }

  function setupLocations(out) {
    const locs = S.locations.filter(l => l.warehouse_id === S.whId);
    out.innerHTML = `
      ${multiWh() ? `<div class="notice">Locations in <strong>${esc(whById(S.whId).code)} — ${esc(whById(S.whId).name)}</strong>. Switch warehouses in the header to manage the other building.</div>` : ''}
      <form id="loc-form" class="card accent">
        <h2>Add Location</h2>
        <div class="grid2">
          <div class="field"><label for="l-code">Code</label>
            <input id="l-code" required maxlength="30" placeholder="A-01-1" autocapitalize="characters"></div>
          <div class="field"><label for="l-zone">Zone (optional)</label><input id="l-zone" maxlength="30"></div>
          <div class="field"><label for="l-type">Type</label>
            <select id="l-type">${['storage', 'floor', 'staging', 'dock', 'hold'].map(t => `<option>${t}</option>`).join('')}</select></div>
          <div class="field"><label for="l-sort">Sort order</label>
            <input id="l-sort" type="number" inputmode="numeric" value="${(locs.length + 1) * 10}"></div>
        </div>
        <button class="btn block" id="loc-save">Add Location</button>
      </form>
      ${locs.map(l => `
        <div class="list-item row spread" style="${l.active ? '' : 'opacity:.55'}">
          <div><span class="title">${esc(l.code)}</span>
            <div class="meta">${esc(l.loc_type)}${l.zone ? ' &middot; ' + esc(l.zone) : ''}</div></div>
          ${['DOCK', 'FLOOR', 'HOLD'].includes(l.code) ? '<span class="muted small">built-in</span>'
            : `<button class="btn sm ghost" data-toggle="${l.id}">${l.active ? 'Deactivate' : 'Activate'}</button>`}
        </div>`).join('')}`;
    $('#loc-form', out).onsubmit = e => {
      e.preventDefault();
      busy($('#loc-save', out), async () => {
        const code = $('#l-code', out).value.trim().toUpperCase();
        await q(sb.from('locations').insert({
          code, zone: strOrNull($('#l-zone', out).value), loc_type: $('#l-type', out).value,
          sort_order: Number($('#l-sort', out).value) || 0, warehouse_id: S.whId
        }));
        toast(`${code} added.`);
        viewSetup('locations');
      });
    };
    $$('[data-toggle]', out).forEach(b => b.onclick = () => busy(b, async () => {
      const l = S.locations.find(x => x.id === b.dataset.toggle);
      await q(sb.from('locations').update({ active: !l.active }).eq('id', l.id));
      viewSetup('locations');
    }));
  }

  const PARTY_TYPES = { consignee: 'Customer / Ship-to', vendor: 'Vendor / Ship-from', both: 'Both' };

  function setupParties(out) {
    const rows = S.parties;
    out.innerHTML = `
      <div class="row spread" style="margin-bottom:10px">
        <span class="muted">${rows.length} saved</span>
        <button class="btn" id="add-party">Add</button></div>
      <p class="muted small">Ship-to addresses fill in shipments and BOLs; vendors are suggested on receipts. (Customer <em>accounts</em>, whose product it is and who is billed, are on the Accounts tab.)</p>
      ${rows.length ? rows.map(r => `
        <a class="list-item" href="#" data-party="${r.id}" style="${r.active ? '' : 'opacity:.55'}">
          <div class="row spread"><span class="title">${esc(r.name)}</span>${r.active ? '' : badge('inactive')}</div>
          <div class="meta">${esc(PARTY_TYPES[r.party_type] || r.party_type)}</div>
          <div class="meta">${esc([r.address_line1, [r.city, r.state].filter(Boolean).join(', '), r.zip].filter(Boolean).join(' · '))}</div>
        </a>`).join('') : '<p class="muted">Nothing saved yet.</p>'}`;
    $('#add-party', out).onclick = () => partyForm(null);
    $$('[data-party]', out).forEach(a => a.onclick = e => { e.preventDefault(); partyForm(rows.find(r => r.id === a.dataset.party)); });
  }

  function partyForm(pt) {
    const r = pt || { party_type: 'consignee', active: true };
    const body = openModal(pt ? `Edit ${pt.name}` : 'Add Customer or Vendor', `
      <form id="party-form">
        <div class="field"><label for="p-name">Name</label>
          <input id="p-name" value="${esc(r.name || '')}" required maxlength="120"></div>
        <div class="field"><label for="p-type">Type</label>
          <select id="p-type">${Object.entries(PARTY_TYPES).map(([k, v]) => `<option value="${k}" ${r.party_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="p-a1">Address</label><input id="p-a1" value="${esc(r.address_line1 || '')}" maxlength="120"></div>
        <div class="field"><label for="p-a2">Address line 2</label><input id="p-a2" value="${esc(r.address_line2 || '')}" maxlength="120"></div>
        <div class="grid2">
          <div class="field"><label for="p-city">City</label><input id="p-city" value="${esc(r.city || '')}" maxlength="60"></div>
          <div class="field"><label for="p-state">State</label><input id="p-state" value="${esc(r.state || '')}" maxlength="2"></div>
          <div class="field"><label for="p-zip">ZIP</label><input id="p-zip" value="${esc(r.zip || '')}" maxlength="10"></div>
          <div class="field"><label for="p-contact">Contact</label><input id="p-contact" value="${esc(r.contact_name || '')}" maxlength="80"></div>
          <div class="field"><label for="p-phone">Phone</label><input id="p-phone" type="tel" value="${esc(r.phone || '')}" maxlength="30"></div>
          <div class="field"><label for="p-email">Email</label><input id="p-email" type="email" value="${esc(r.email || '')}" maxlength="120"></div>
        </div>
        <div class="field"><label for="p-notes">Notes (dock hours, appointment rules)</label><input id="p-notes" value="${esc(r.notes || '')}" maxlength="300"></div>
        <div class="field"><label class="check"><input type="checkbox" id="p-active" ${r.active ? 'checked' : ''}> Active</label></div>
        <button class="btn block" id="party-save">${pt ? 'Save' : 'Add'}</button>
      </form>`);
    $('#party-form', body).onsubmit = e => {
      e.preventDefault();
      busy($('#party-save', body), async () => {
        const row = {
          name: $('#p-name', body).value.trim(),
          party_type: $('#p-type', body).value,
          address_line1: strOrNull($('#p-a1', body).value), address_line2: strOrNull($('#p-a2', body).value),
          city: strOrNull($('#p-city', body).value), state: strOrNull($('#p-state', body).value.toUpperCase()),
          zip: strOrNull($('#p-zip', body).value), contact_name: strOrNull($('#p-contact', body).value),
          phone: strOrNull($('#p-phone', body).value), email: strOrNull($('#p-email', body).value),
          notes: strOrNull($('#p-notes', body).value), active: $('#p-active', body).checked
        };
        if (pt) await q(sb.from('parties').update(row).eq('id', pt.id));
        else await q(sb.from('parties').insert(row));
        toast(`${row.name} saved.`);
        closeModal();
        viewSetup('parties');
      });
    };
  }

  function setupAccounts(out) {
    const rows = S.owners;
    out.innerHTML = `
      <div class="row spread" style="margin-bottom:10px"><span class="muted">${rows.filter(r => r.active).length} active accounts</span>
        <button class="btn" id="add-acct">Add Account</button></div>
      <p class="muted small">An account is a customer whose product you store. Every item belongs to one account, and each receipt and shipment is for one account.</p>
      ${rows.map(o => `
        <a class="list-item" href="#" data-acct="${o.id}" style="${o.active ? '' : 'opacity:.55'}">
          <div class="row spread"><span class="title">${esc(o.code)} — ${esc(o.name)}</span>${o.active ? '' : badge('inactive')}</div>
          <div class="meta">${S.items.filter(i => i.owner_id === o.id).length} items${o.contact_name ? ' &middot; ' + esc(o.contact_name) : ''}${o.email ? ' &middot; ' + esc(o.email) : ''}</div>
        </a>`).join('')}`;
    $('#add-acct', out).onclick = () => accountForm(null);
    $$('[data-acct]', out).forEach(a => a.onclick = e => { e.preventDefault(); accountForm(rows.find(r => r.id === a.dataset.acct)); });
  }

  function accountForm(o) {
    const r = o || { active: true };
    const body = openModal(o ? `Edit ${o.code}` : 'Add Account', `
      <form id="acct-form">
        <div class="grid2">
          <div class="field"><label for="a-code">Code</label>
            <input id="a-code" value="${esc(r.code || '')}" required maxlength="12" autocapitalize="characters" placeholder="ACME"></div>
          <div class="field"><label for="a-name">Name</label><input id="a-name" value="${esc(r.name || '')}" required maxlength="120"></div>
          <div class="field"><label for="a-contact">Contact</label><input id="a-contact" value="${esc(r.contact_name || '')}" maxlength="80"></div>
          <div class="field"><label for="a-email">Email</label><input id="a-email" type="email" value="${esc(r.email || '')}" maxlength="120"></div>
          <div class="field"><label for="a-phone">Phone</label><input id="a-phone" type="tel" value="${esc(r.phone || '')}" maxlength="30"></div>
        </div>
        <div class="field"><label for="a-bill">Billing address</label><textarea id="a-bill" maxlength="400">${esc(r.billing_address || '')}</textarea></div>
        <div class="field"><label for="a-notes">Notes</label><input id="a-notes" value="${esc(r.notes || '')}" maxlength="300"></div>
        <div class="field"><label class="check"><input type="checkbox" id="a-active" ${r.active ? 'checked' : ''}> Active</label></div>
        <button class="btn block" id="acct-save">${o ? 'Save' : 'Add Account'}</button>
      </form>`);
    $('#acct-form', body).onsubmit = e => {
      e.preventDefault();
      busy($('#acct-save', body), async () => {
        const row = {
          code: $('#a-code', body).value.trim().toUpperCase(), name: $('#a-name', body).value.trim(),
          contact_name: strOrNull($('#a-contact', body).value), email: strOrNull($('#a-email', body).value),
          phone: strOrNull($('#a-phone', body).value), billing_address: strOrNull($('#a-bill', body).value),
          notes: strOrNull($('#a-notes', body).value), active: $('#a-active', body).checked
        };
        if (o) await q(sb.from('owners').update(row).eq('id', o.id));
        else await q(sb.from('owners').insert(row));
        toast(`${row.code} saved.`);
        closeModal(); viewSetup('accounts');
      });
    };
  }

  function setupWarehouses(out) {
    const rows = S.warehouses;
    out.innerHTML = `
      <div class="row spread" style="margin-bottom:10px"><span class="muted">${activeWhs().length} active</span>
        <button class="btn" id="add-wh">Add Warehouse</button></div>
      <p class="muted small">Each warehouse has its own locations, docks, receipts, shipments and schedule. New warehouses start with DOCK, FLOOR and HOLD. The address prints as the ship-from on that building's paperwork.</p>
      ${rows.map(w => `
        <a class="list-item" href="#" data-wh="${w.id}" style="${w.active ? '' : 'opacity:.55'}">
          <div class="row spread"><span class="title">${esc(w.code)} — ${esc(w.name)}</span>${w.active ? '' : badge('inactive')}</div>
          <div class="meta">${S.locations.filter(l => l.warehouse_id === w.id && l.active).length} locations${w.address_line1 ? ' &middot; ' + esc([w.address_line1, w.city, w.state].filter(Boolean).join(', ')) : ''}</div>
        </a>`).join('')}`;
    $('#add-wh', out).onclick = () => warehouseForm(null);
    $$('[data-wh]', out).forEach(a => a.onclick = e => { e.preventDefault(); warehouseForm(rows.find(r => r.id === a.dataset.wh)); });
  }

  function warehouseForm(w) {
    const r = w || { active: true, sort_order: (S.warehouses.length + 1) };
    const body = openModal(w ? `Edit ${w.code}` : 'Add Warehouse', `
      <form id="wh-form">
        <div class="grid2">
          <div class="field"><label for="w-code">Code</label>
            <input id="w-code" value="${esc(r.code || '')}" required maxlength="10" autocapitalize="characters" placeholder="WHSE2"></div>
          <div class="field"><label for="w-name">Name</label><input id="w-name" value="${esc(r.name || '')}" required maxlength="80" placeholder="Across the street"></div>
        </div>
        <div class="field"><label for="w-a1">Address</label><input id="w-a1" value="${esc(r.address_line1 || '')}" maxlength="120"></div>
        <div class="field"><label for="w-a2">Address line 2</label><input id="w-a2" value="${esc(r.address_line2 || '')}" maxlength="120"></div>
        <div class="grid2">
          <div class="field"><label for="w-city">City</label><input id="w-city" value="${esc(r.city || '')}" maxlength="60"></div>
          <div class="field"><label for="w-state">State</label><input id="w-state" value="${esc(r.state || '')}" maxlength="2"></div>
          <div class="field"><label for="w-zip">ZIP</label><input id="w-zip" value="${esc(r.zip || '')}" maxlength="10"></div>
          <div class="field"><label for="w-phone">Phone</label><input id="w-phone" type="tel" value="${esc(r.phone || '')}" maxlength="30"></div>
          <div class="field"><label for="w-sort">Sort order</label><input id="w-sort" type="number" value="${esc(r.sort_order ?? 0)}"></div>
        </div>
        <div class="field"><label class="check"><input type="checkbox" id="w-active" ${r.active ? 'checked' : ''}> Active</label></div>
        <button class="btn block" id="wh-save">${w ? 'Save' : 'Add Warehouse'}</button>
      </form>`);
    $('#wh-form', body).onsubmit = e => {
      e.preventDefault();
      busy($('#wh-save', body), async () => {
        const row = {
          code: $('#w-code', body).value.trim().toUpperCase(), name: $('#w-name', body).value.trim(),
          address_line1: strOrNull($('#w-a1', body).value), address_line2: strOrNull($('#w-a2', body).value),
          city: strOrNull($('#w-city', body).value), state: strOrNull($('#w-state', body).value.toUpperCase()),
          zip: strOrNull($('#w-zip', body).value), phone: strOrNull($('#w-phone', body).value),
          sort_order: Number($('#w-sort', body).value) || 0, active: $('#w-active', body).checked
        };
        if (w && !row.active && w.id === S.whId) throw new Error('Switch to another warehouse before deactivating this one.');
        if (w) await q(sb.from('warehouses').update(row).eq('id', w.id));
        else await q(sb.from('warehouses').insert(row));
        toast(`${row.code} saved.`);
        closeModal(); await loadRef(); renderHeader(); viewSetup('warehouses');
      });
    };
  }

  async function setupCompany(out) {
    const s = S.settings || {};
    const hasPallets = (await q(sb.from('pallets').select('id', { count: 'exact', head: true }).neq('status', 'void')
      .then(r => ({ data: r.count, error: r.error })))) > 0;
    out.innerHTML = `
      <form id="co-form" class="card accent">
        <p class="muted small">Printed on receipts and bills of lading.</p>
        <div class="field"><label for="c-name">Company name</label><input id="c-name" value="${esc(s.company_name || '')}" required></div>
        <div class="field"><label for="c-a1">Address</label><input id="c-a1" value="${esc(s.address_line1 || '')}"></div>
        <div class="field"><label for="c-a2">Address line 2</label><input id="c-a2" value="${esc(s.address_line2 || '')}"></div>
        <div class="grid2">
          <div class="field"><label for="c-city">City</label><input id="c-city" value="${esc(s.city || '')}"></div>
          <div class="field"><label for="c-state">State</label><input id="c-state" value="${esc(s.state || '')}" maxlength="2"></div>
          <div class="field"><label for="c-zip">ZIP</label><input id="c-zip" value="${esc(s.zip || '')}" maxlength="10"></div>
          <div class="field"><label for="c-phone">Phone</label><input id="c-phone" type="tel" value="${esc(s.phone || '')}"></div>
          <div class="field"><label for="c-prefix">Pallet ID prefix</label>
            <input id="c-prefix" value="${esc(s.lp_prefix || '')}" maxlength="6" ${hasPallets ? 'readonly' : ''} required>
            <div class="hint">${hasPallets ? 'Locked: pallets with this prefix are in use.' : 'Example: ' + esc((s.lp_prefix || 'LP') + '000001')}</div></div>
          <div class="field"><label for="c-uom">Default unit of measure</label><input id="c-uom" value="${esc(s.default_uom || 'EA')}" maxlength="10"></div>
          <div class="field"><label for="c-tare">Empty pallet weight (lbs)</label>
            <input id="c-tare" type="number" inputmode="decimal" min="0" step="any" value="${esc(Number(s.pallet_tare_lbs || 0))}">
            <div class="hint">Added per pallet to BOL weight. A wood pallet is typically 40-50 lbs.</div></div>
        </div>

        <h2 style="margin-top:18px">Pallet Identifiers</h2>
        <p class="muted small">Rename the fields to match the customer's paperwork. Extra identifiers only show up once they have a name.</p>
        <div class="grid2">
          <div class="field"><label for="c-lotlbl">Lot field name</label>
            <input id="c-lotlbl" value="${esc(s.lot_label || 'Lot / Production #')}" maxlength="30" required>
            <div class="hint">Example: BIN Class. Required or optional is set per item.</div></div>
          <div class="field"><label for="c-custlbl">Customer pallet ID name</label>
            <input id="c-custlbl" value="${esc(s.cust_pallet_label || 'Customer Pallet ID')}" maxlength="30" required>
            <div class="row" style="margin-top:6px">
              <label class="check"><input type="checkbox" id="c-custreq" ${s.cust_pallet_required ? 'checked' : ''}> Required</label>
              <label class="check"><input type="checkbox" id="c-custbc" ${s.cust_pallet_barcode ? 'checked' : ''}> Barcode on label</label>
            </div></div>
          ${[1, 2].map(n => `
          <div class="field"><label for="c-ref${n}">Extra identifier ${n} name</label>
            <input id="c-ref${n}" value="${esc(s['ref' + n + '_label'] || '')}" maxlength="30" placeholder="Leave blank to hide">
            <div class="row" style="margin-top:6px">
              <label class="check"><input type="checkbox" id="c-ref${n}req" ${s['ref' + n + '_required'] ? 'checked' : ''}> Required</label>
              <label class="check"><input type="checkbox" id="c-ref${n}uniq" ${s['ref' + n + '_unique'] ? 'checked' : ''}> Unique per pallet</label>
              <label class="check"><input type="checkbox" id="c-ref${n}bc" ${s['ref' + n + '_barcode'] ? 'checked' : ''}> Barcode on label</label>
            </div></div>`).join('')}
        </div>
        <button class="btn block" id="co-save">Save</button>
      </form>`;
    $('#co-form', out).onsubmit = e => {
      e.preventDefault();
      busy($('#co-save', out), async () => {
        const row = {
          company_name: $('#c-name', out).value.trim(),
          address_line1: strOrNull($('#c-a1', out).value), address_line2: strOrNull($('#c-a2', out).value),
          city: strOrNull($('#c-city', out).value), state: strOrNull($('#c-state', out).value.toUpperCase()),
          zip: strOrNull($('#c-zip', out).value), phone: strOrNull($('#c-phone', out).value),
          default_uom: $('#c-uom', out).value.trim().toUpperCase() || 'EA',
          pallet_tare_lbs: Number($('#c-tare', out).value) || 0,
          lot_label: $('#c-lotlbl', out).value.trim() || 'Lot / Production #',
          cust_pallet_label: $('#c-custlbl', out).value.trim() || 'Customer Pallet ID',
          cust_pallet_required: $('#c-custreq', out).checked,
          cust_pallet_barcode: $('#c-custbc', out).checked
        };
        for (const n of [1, 2]) {
          row['ref' + n + '_label'] = strOrNull($('#c-ref' + n, out).value);
          row['ref' + n + '_required'] = $('#c-ref' + n + 'req', out).checked;
          row['ref' + n + '_unique'] = $('#c-ref' + n + 'uniq', out).checked;
          row['ref' + n + '_barcode'] = $('#c-ref' + n + 'bc', out).checked;
        }
        if (!hasPallets) row.lp_prefix = $('#c-prefix', out).value.trim().toUpperCase();
        await q(sb.from('settings').update(row).eq('id', 1));
        toast('Company info saved.');
        viewSetup('company');
      });
    };
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */
  async function boot() {
    if (cfg.BRAND_SHORT) $('#brand-mark').textContent = cfg.BRAND_SHORT;
    if (cfg.BRAND_NAME) $('#brand-text').textContent = cfg.BRAND_NAME;
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    sb.auth.onAuthStateChange((event, session) => {
      S.session = session;
      if (event === 'PASSWORD_RECOVERY') { recoveryMode = true; setTimeout(route, 0); }
      if (event === 'SIGNED_OUT') { S.profile = null; setTimeout(() => { renderHeader(); route(); }, 0); }
    });
    try {
      const { data } = await sb.auth.getSession();
      S.session = data.session;
      if (S.session) await loadUser();
    } catch (e) {
      console.error(e);
      toast(friendly(e), 'bad');
    }
    renderHeader();
    window.addEventListener('hashchange', route);
    route();
  }

  boot();
})();
