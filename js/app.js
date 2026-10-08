/* RMB Warehouse — lite WMS front end
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

  function friendly(err) {
    const m = (err && (err.message || err.error_description)) || String(err);
    if (/row-level security|permission denied|42501/i.test(m)) return 'You do not have permission to do this.';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'No connection. Check Wi-Fi and try again.';
    if (/items_sku_key/i.test(m)) return 'That SKU already exists.';
    if (/locations_code_key/i.test(m)) return 'That location code already exists.';
    if (/ux_pallets_customer_pallet_id/i.test(m)) return `That ${lbl.cust()} is already in use.`;
    if (/Invalid login credentials/i.test(m)) return 'Email or password is incorrect.';
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
    const [settings, items, locations, parties] = await Promise.all([
      q(sb.from('settings').select('*').eq('id', 1).single()),
      q(sb.from('items').select('*').order('sku')),
      q(sb.from('locations').select('*').order('sort_order').order('code')),
      q(sb.from('parties').select('*').order('name'))
    ]);
    S.settings = settings; S.items = items; S.locations = locations; S.parties = parties;
    S.users = await q(sb.from('app_users').select('id, full_name')).catch(() => []);
    document.title = companyName() + ' WMS';
  }

  function renderHeader() {
    const el = $('#header-right');
    if (!S.session) { el.innerHTML = ''; return; }
    const name = S.profile?.full_name || S.session.user.email;
    el.innerHTML = `<span class="who">${esc(name)}</span><button id="signout" type="button">Sign out</button>`;
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

  async function route() {
    const path = location.hash.replace(/^#\/?/, '');
    const [a, b, c] = path.split('/');
    navSeq++;
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
      if (a === 'shipments') return viewShipments();
      if (a === 'shipment' && b === 'new') return viewNewShipment();
      if (a === 'shipment' && b) return viewShipment(b);
      if (a === 'setup') return viewSetup(b || 'items');
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
          <div class="field"><label for="email">Email</label>
            <input id="email" type="email" autocomplete="username" required></div>
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
          email: $('#email').value.trim(), password: $('#password').value
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
  async function viewHome() {
    const mySeq = navSeq;
    render(`<div class="loading">Loading...</div>`);
    const countOpen = table => q(sb.from(table).select('id', { count: 'exact', head: true }).eq('status', 'open')
      .then(r => ({ data: r.count, error: r.error })));
    const [openCount, onHand, openShip] = await Promise.all([
      countOpen('receipts'),
      q(sb.from('v_inventory_by_lot').select('pallets')),
      countOpen('shipments')
    ]);
    if (mySeq !== navSeq) return;
    const pallets = onHand.reduce((a, r) => a + Number(r.pallets), 0);
    render(`
      <h1>${esc(companyName())}</h1>
      <div class="tiles">
        <a class="tile" href="#/receipts"><strong>Receiving</strong>
          <span>${openCount ? `${openCount} open receipt${openCount === 1 ? '' : 's'}` : 'Receive pallets, print labels'}</span></a>
        <a class="tile" href="#/lookup"><strong>Inventory Lookup</strong>
          <span>${pallets.toLocaleString()} pallet${pallets === 1 ? '' : 's'} on hand</span></a>
        <a class="tile" href="#/shipments"><strong>Shipping</strong>
          <span>${openShip ? `${openShip} open shipment${openShip === 1 ? '' : 's'}` : 'Load pallets, print BOLs'}</span></a>
        ${can('operator') ? `<a class="tile" href="#/dock"><strong>Dock Mode</strong><span>The forklift screens: load, unload, move</span></a>` : ''}
        ${can('manager') ? `<a class="tile" href="#/setup"><strong>Setup</strong><span>Items, locations, customers, company info</span></a>` : ''}
      </div>
      <p class="muted small" style="margin-top:20px">Signed in as ${esc(S.profile.full_name)} (${esc(S.profile.role)}) &middot; v${esc(cfg.APP_VERSION)}</p>`);
  }

  /* ------------------------------------------------------------------ */
  /* receiving: list                                                     */
  /* ------------------------------------------------------------------ */
  async function viewReceipts() {
    const mySeq = navSeq;
    render(`<div class="loading">Loading...</div>`);
    const rows = await q(sb.from('receipts')
      .select('id, receipt_no, status, received_at, expected_at, unloaded_at, dock_door, vendor_name, carrier, trailer_no, po_number, pallets(count)')
      .order('received_at', { ascending: false }).limit(60));
    if (mySeq !== navSeq) return;
    const open = rows.filter(r => r.status === 'open');
    const rest = rows.filter(r => r.status !== 'open');
    const item = r => `
      <a class="list-item" href="#/receipt/${r.id}">
        <div class="row spread"><span class="title">${esc(r.receipt_no)}</span>
          <span>${r.status === 'open' && r.unloaded_at ? '<span class="badge open">Unloaded</span> ' : ''}${badge(r.status)}</span></div>
        <div class="meta">${r.expected_at && !(r.pallets?.[0]?.count) ? 'Expected ' + esc(fmtDateTime(r.expected_at)) : esc(fmtDateTime(r.received_at))}${r.dock_door ? ' &middot; Door ' + esc(r.dock_door) : ''} &middot; ${r.pallets?.[0]?.count ?? 0} pallets</div>
        <div class="meta">${esc([r.vendor_name, r.carrier, r.trailer_no && 'Trailer ' + r.trailer_no, r.po_number && 'PO ' + r.po_number].filter(Boolean).join(' · '))}</div>
      </a>`;
    render(`
      <a class="back" href="#/">&larr; Home</a>
      <div class="row spread"><h1>Receiving</h1>
        ${can('operator') ? `<a class="btn" href="#/receipt/new">New Receipt</a>` : ''}</div>
      <h2>Open</h2>
      ${open.length ? `<div class="list">${open.map(item).join('')}</div>` : `<p class="muted">No open receipts.</p>`}
      <h2 style="margin-top:20px">Recent</h2>
      ${rest.length ? `<div class="list">${rest.map(item).join('')}</div>` : `<p class="muted">Nothing yet.</p>`}`);
  }

  /* ------------------------------------------------------------------ */
  /* receiving: new receipt                                              */
  /* ------------------------------------------------------------------ */
  function receiptHeaderFields(r = {}, isNew = false) {
    return `
      <div class="grid2">
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
    await loadVendorSuggestions().catch(() => {});
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
        const row = await q(sb.from('receipts').insert(readReceiptHeader($('#new-rcpt'))).select('id, receipt_no').single());
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
      received_at: rcpt.received_at, receipt_no: rcpt.receipt_no
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
    const activeItems = S.items.filter(i => i.active);
    const last = S.lastReceive || {};
    const lastItem = activeItems.find(i => i.id === last.item_id);
    const dock = S.locations.find(l => l.code === 'DOCK');
    const printPref = loadPref('printLabels', true);
    const copiesPref = loadPref('labelCopies', 1);

    const headerView = `
      <dl class="kv">
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
      <div class="card"><div class="notice warn">No items set up yet.
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
              ${S.locations.filter(l => l.active).map(l => `<option value="${l.id}" ${(last.location_id ? last.location_id === l.id : dock && dock.id === l.id) ? 'selected' : ''}>${esc(l.code)}</option>`).join('')}
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
            <div class="meta">${esc(locById(p.location_id).code || '')}${p.expiration_date ? ' &middot; Exp ' + esc(fmtDate(p.expiration_date)) : ''}</div>
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
              <form id="hdr-form" style="margin-top:12px">${receiptHeaderFields(rcpt)}
                <button class="btn secondary block" id="hdr-save">Save Load Details</button></form>
            </details>` : `<h2>Load Details</h2>${headerView}`}
        </div>

        ${addForm}

        <div class="card">
          <div class="row spread"><h2 style="margin:0">Pallets</h2>
            <span class="muted">${active.length} pallet${active.length === 1 ? '' : 's'}${totalText}</span></div>
          <div style="margin-top:12px">${pallets.length ? pallets.map(palletRow).join('') : '<p class="muted">No pallets yet.</p>'}</div>
        </div>

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

    /* header save */
    $('#hdr-form', page)?.addEventListener('submit', e => {
      e.preventDefault();
      busy($('#hdr-save'), async () => {
        await q(sb.from('receipts').update(readReceiptHeader($('#hdr-form'))).eq('id', id));
        toast('Load details saved.');
        await reload();
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
          S.lastReceive = { item_id: it.id, lot, qty, location_id: locId };
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

          if (received.length === count) {
            toast(received.length === 1 ? `Received ${received[0].lp_id}.`
              : `Received ${received.length} pallets: ${received[0].lp_id} to ${received[received.length - 1].lp_id}.`);
          }
          await reload(received[received.length - 1].id);
          // ready for the next pallet: back to the first identifier that was used
          const firstUsed = ids.find(f => vals[f.key] || f.required);
          (firstUsed ? $('#' + firstUsed.key) : $('#qty'))?.focus();
          if (doPrint) WmsPrint.labels(received.map(p => palletForPrint(p, rcpt)), S.settings, copies);
        });
      };
    }

    /* pallet buttons */
    $$('[data-label]', page).forEach(b => b.onclick = () => {
      const p = pallets.find(x => x.id === b.dataset.label);
      WmsPrint.labels([palletForPrint(p, rcpt)], S.settings, loadPref('labelCopies', 1));
    });
    $$('[data-void]', page).forEach(b => b.onclick = async () => {
      const p = pallets.find(x => x.id === b.dataset.void);
      const reason = await askReason(`Void ${p.lp_id}?`,
        `This removes the pallet from inventory. The label for ${esc(p.lp_id)} should be thrown away.`, 'Void Pallet');
      if (!reason) return;
      busy(null, async () => {
        await q(sb.rpc('wms_void_pallet', { p_pallet_id: p.id, p_reason: reason }));
        toast(`${p.lp_id} voided.`);
        await reload();
      });
    });

    /* receipt actions */
    $('#print-rcpt', page)?.addEventListener('click', () =>
      WmsPrint.receipt(rcpt, active.map(p => palletForPrint(p, rcpt)), S.settings));
    $('#print-unload', page)?.addEventListener('click', () => WmsPrint.unloadSheet(rcpt, S.settings));
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
      WmsPrint.labels(active.filter(p => p.status !== 'shipped').map(p => palletForPrint(p, rcpt)), S.settings, loadPref('labelCopies', 1));

    $('#close-rcpt', page)?.addEventListener('click', async () => {
      const msg = active.length
        ? `Close ${esc(rcpt.receipt_no)} with ${active.length} pallet${active.length === 1 ? '' : 's'}? No more pallets can be added after closing.`
        : `${esc(rcpt.receipt_no)} has no pallets. Close it anyway?`;
      if (!await askConfirm('Close receipt?', msg, 'Close Receipt')) return;
      busy($('#close-rcpt'), async () => {
        await q(sb.rpc('wms_close_receipt', { p_receipt_id: id }));
        toast(`${rcpt.receipt_no} closed.`);
        await reload();
      });
    });
    $('#reopen-rcpt', page)?.addEventListener('click', () => busy($('#reopen-rcpt'), async () => {
      await q(sb.rpc('wms_reopen_receipt', { p_receipt_id: id }));
      toast(`${rcpt.receipt_no} reopened.`);
      await reload();
    }));
    $('#void-rcpt', page)?.addEventListener('click', async () => {
      const reason = await askReason(`Void ${rcpt.receipt_no}?`,
        'Every pallet on this receipt will be removed from inventory. This only works if nothing from it has shipped.', 'Void Receipt');
      if (!reason) return;
      busy(null, async () => {
        await q(sb.rpc('wms_void_receipt', { p_receipt_id: id, p_reason: reason }));
        toast(`${rcpt.receipt_no} voided.`);
        await reload();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* inventory lookup                                                    */
  /* ------------------------------------------------------------------ */
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
    if (!term) {
      const rows = await q(sb.from('v_inventory_by_lot').select('*').order('sku').order('lot_number'));
      if (stale()) return;
      const totalPallets = rows.reduce((a, r) => a + Number(r.pallets), 0);
      out.innerHTML = `
        <div class="card"><div class="row spread"><h2 style="margin:0">On Hand by ${esc(lbl.lotShort())}</h2>
          <span class="muted">${totalPallets} pallets</span></div>
          ${rows.length ? `<div class="table-wrap" style="margin-top:10px"><table class="data">
            <thead><tr><th>SKU</th><th>${esc(lbl.lotShort())}</th><th class="num">Pallets</th><th class="num">On hand</th><th class="num">Avail</th></tr></thead>
            <tbody>${rows.map(r => `<tr data-term="${esc(r.sku)}" style="cursor:pointer">
              <td><strong>${esc(r.sku)}</strong><div class="muted small">${esc(r.description)}</div></td>
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
      rows = safe ? await q(sb.from('v_inventory').select('*')
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
            <div class="meta">${esc(r.location || '')} &middot; Rcvd ${esc(fmtDate(r.received_at))}</div>
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
    const locOptions = S.locations.filter(l => l.active)
      .map(l => `<option value="${l.id}" ${l.id === p.location_id ? 'selected' : ''}>${esc(l.code)}</option>`).join('');
    body.innerHTML = `
      <dl class="kv">
        <dt>Item</dt><dd>${esc(p.sku)} — ${esc(p.description)}</dd>
        <dt>${esc(lbl.lot())}</dt><dd>${esc(p.lot_number || '-')}</dd>
        <dt>On hand</dt><dd>${esc(fmtQty(p.qty_on_hand))} ${esc(p.uom)}${Number(p.qty_allocated) ? ` (${esc(fmtQty(p.qty_allocated))} allocated)` : ''}</dd>
        <dt>Location</dt><dd>${esc(p.location || '-')}</dd>
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
    $('#pm-label', body).onclick = () => WmsPrint.labels([{ ...p, qty: p.qty_on_hand }], S.settings, loadPref('labelCopies', 1));
    $('#pm-move', body)?.addEventListener('submit', e => {
      e.preventDefault();
      busy($('#pm-move-btn', body), async () => {
        const to = $('#pm-loc', body).value;
        if (to === p.location_id) { toast('Already in that location.'); return; }
        await q(sb.rpc('wms_move_pallet', { p_pallet_id: p.pallet_id, p_to_location_id: to }));
        toast(`${p.lp_id} moved to ${locById(to).code}.`);
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
    const countOpen = table => q(sb.from(table).select('id', { count: 'exact', head: true }).eq('status', 'open')
      .then(r => ({ data: r.count, error: r.error })));
    const [ships, rcpts] = await Promise.all([countOpen('shipments'), countOpen('receipts')]);
    if (mySeq !== navSeq) return;
    render(`
      ${!isLift() ? '<a class="back" href="#/">&larr; Office</a>' : ''}
      <h1>Dock</h1>
      <div class="dock-tiles">
        <a class="dock-tile" href="#/dock/load"><strong>Load</strong><span>${ships} open load${ships === 1 ? '' : 's'}</span></a>
        <a class="dock-tile" href="#/dock/unload"><strong>Unload</strong><span>${rcpts} open receipt${rcpts === 1 ? '' : 's'}</span></a>
        <a class="dock-tile" href="#/dock/move"><strong>Move</strong><span>Put away / relocate</span></a>
        <a class="dock-tile" href="#/lookup"><strong>Lookup</strong><span>Find a pallet</span></a>
      </div>
      <p class="muted small" style="margin-top:20px">Signed in as ${esc(S.profile.full_name)} (${esc(S.profile.role)}) &middot; v${esc(cfg.APP_VERSION)}</p>`);
  }

  /* ---------- load: pick a load ---------- */
  async function viewDockLoads() {
    const mySeq = navSeq;
    render(`<div class="loading">Loading...</div>`);
    const rows = await q(sb.from('shipments')
      .select('id, shipment_no, ship_date, appt_time, dock_door, ship_to_name, carrier, loaded_at, shipment_lines(count)')
      .eq('status', 'open').order('ship_date').order('appt_time', { nullsFirst: false }).limit(50));
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
      .eq('status', 'open').order('expected_at', { nullsFirst: false }).order('received_at').limit(50));
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
        <label for="mv-loc">2. Scan or pick location</label>
        <div class="input-scan"><input id="mv-loc" class="big-input" list="mv-locs" enterkeyhint="go" autocapitalize="characters">${scanBtn('mv-loc', 'mv-form')}</div>
        <datalist id="mv-locs">${S.locations.filter(l => l.active).map(l => `<option value="${esc(l.code)}"></option>`).join('')}</datalist>
        <button class="btn block" id="mv-btn" style="margin-top:12px">Move</button>
      </form>
      ${flashHtml()}`);
    const form = $('#mv-form');
    wireScanButtons(form);
    const pIn = $('#mv-pallet'), lIn = $('#mv-loc');
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
      $('#mv-info').innerHTML = `<div class="notice ok"><strong>${esc(pallet.lp_id)}</strong> &middot; ${esc(pallet.sku)} &middot; ${lotText(pallet)} &middot; ${esc(fmtQty(pallet.qty_on_hand))} ${esc(pallet.uom)}<br>Now at <strong>${esc(pallet.location || '-')}</strong></div>`;
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
        const loc = S.locations.find(l => l.active && l.code.toUpperCase() === code);
        if (!loc) throw new Error(`Location ${code || '(blank)'} not found.`);
        if (loc.id === pallet.location_id) throw new Error(`${pallet.lp_id} is already in ${loc.code}.`);
        await q(sb.rpc('wms_move_pallet', { p_pallet_id: pallet.pallet_id, p_to_location_id: loc.id }));
        flash('ok', `MOVED ${pallet.lp_id}`, `${pallet.location || '-'} → ${loc.code}`);
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
      .select('id, shipment_no, status, ship_date, appt_time, dock_door, loaded_at, ship_to_name, ship_to_city, ship_to_state, carrier, customer_order_no, po_number, shipment_lines(count)')
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
        <div class="meta">${esc([r.carrier, r.customer_order_no && 'Order ' + r.customer_order_no, r.po_number && 'PO ' + r.po_number].filter(Boolean).join(' · '))}</div>
      </a>`;
    render(`
      <a class="back" href="#/">&larr; Home</a>
      <div class="row spread"><h1>Shipping</h1>
        ${can('operator') ? `<a class="btn" href="#/shipment/new">New Shipment</a>` : ''}</div>
      <h2>Open</h2>
      ${open.length ? `<div class="list">${open.map(item).join('')}</div>` : `<p class="muted">No open shipments.</p>`}
      <h2 style="margin-top:20px">Recent</h2>
      ${rest.length ? `<div class="list">${rest.map(item).join('')}</div>` : `<p class="muted">Nothing yet.</p>`}`);
  }

  /* ------------------------------------------------------------------ */
  /* shipping: header form                                               */
  /* ------------------------------------------------------------------ */
  function shipmentHeaderFields(r = {}) {
    const customers = S.parties.filter(p => p.active && p.party_type !== 'vendor');
    const terms = r.freight_terms || 'prepaid';
    return `
      <div class="field"><label for="consignee_id">Customer / Ship-to</label>
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
        const row = await q(sb.from('shipments').insert(readShipmentHeader(form)).select('id, shipment_no').single());
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
    const activeItems = S.items.filter(i => i.active);

    const headerView = `
      <dl class="kv">
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
              <form id="ship-hdr" style="margin-top:12px">${shipmentHeaderFields(ship)}
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

    const hdr = $('#ship-hdr', page);
    if (hdr) {
      wireShipmentHeader(hdr);
      hdr.onsubmit = e => {
        e.preventDefault();
        busy($('#ship-hdr-save'), async () => {
          await q(sb.from('shipments').update(readShipmentHeader(hdr)).eq('id', id));
          toast('Shipment details saved.');
          await reload();
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
          toast(`Added ${p.lp_id}: ${fmtQty(line.qty)} ${p.uom}.`);
          await reload(true);
        });
      };
      $('#pick-item', scanForm).addEventListener('change', async e => {
        const out = $('#pick-list', scanForm);
        if (!e.target.value) { out.innerHTML = ''; return; }
        out.innerHTML = '<div class="muted">Loading...</div>';
        try {
          const onShip = new Set(lines.map(l => l.pallet_id));
          const rows = (await q(sb.from('v_inventory').select('*').eq('item_id', e.target.value)
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
            toast(`Added ${r.lp_id}: ${fmtQty(line.qty)} ${r.uom}.`);
            await reload();
          }));
        } catch (err) { out.innerHTML = `<div class="notice bad">${esc(friendly(err))}</div>`; }
      });
    }

    $$('[data-remove]', page).forEach(b => b.onclick = () => busy(b, async () => {
      await q(sb.rpc('wms_remove_from_shipment', { p_shipment_id: id, p_pallet_id: b.dataset.remove }));
      toast('Pallet removed.');
      await reload();
    }));

    $('#print-bol', page).onclick = () => WmsPrint.bol(ship, lines, S.settings);
    $('#print-load', page)?.addEventListener('click', () => WmsPrint.loadSheet(ship, orders, S.settings));

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
        toast('Added to order.');
        await reload();
      });
    });
    $$('[data-ol-del]', page).forEach(b => b.onclick = () => busy(b, async () => {
      await q(sb.from('shipment_order_lines').delete().eq('id', b.dataset.olDel));
      toast('Order line removed.');
      await reload();
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
        toast(`${ship.shipment_no} shipped.`);
        await reload();
      });
    });

    $('#void-ship', page)?.addEventListener('click', async () => {
      const reason = await askReason(`Void ${ship.shipment_no}?`, ship.status === 'shipped'
        ? 'This puts every pallet on this shipment back into inventory.'
        : 'This releases the pallets on this shipment.', 'Void Shipment');
      if (!reason) return;
      busy(null, async () => {
        await q(sb.rpc('wms_void_shipment', { p_shipment_id: id, p_reason: reason }));
        toast(`${ship.shipment_no} voided.`);
        await reload();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* setup: items, locations, customers & vendors, company              */
  /* ------------------------------------------------------------------ */
  async function viewSetup(tab) {
    if (!can('manager')) { location.hash = '#/'; return; }
    await loadRef();
    const tabs = [['items', 'Items'], ['locations', 'Locations'], ['parties', 'Customers']].concat(can('admin') ? [['company', 'Company']] : []);
    render(`
      <a class="back" href="#/">&larr; Home</a>
      <h1>Setup</h1>
      <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/setup/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
      <div id="setup-body"></div>`);
    const out = $('#setup-body');
    if (tab === 'locations') return setupLocations(out);
    if (tab === 'parties') return setupParties(out);
    if (tab === 'company' && can('admin')) return setupCompany(out);
    return setupItems(out);
  }

  function setupItems(out) {
    out.innerHTML = `
      <div class="row spread" style="margin-bottom:10px"><span class="muted">${S.items.length} items</span>
        <button class="btn" id="add-item">Add Item</button></div>
      ${S.items.length ? S.items.map(i => `
        <a class="list-item" href="#" data-item="${i.id}" style="${i.active ? '' : 'opacity:.55'}">
          <div class="row spread"><span class="title">${esc(i.sku)}</span>${i.active ? '' : badge('inactive')}</div>
          <div>${esc(i.description)}</div>
          <div class="meta">${esc(i.uom)}${i.units_per_pallet ? ` &middot; ${esc(fmtQty(i.units_per_pallet))} per pallet` : ''} &middot; ${esc(lbl.lotShort())} ${i.lot_required ? 'required' : 'optional'}</div>
        </a>`).join('') : '<p class="muted">No items yet. Add the products this warehouse stores.</p>'}`;
    $('#add-item', out).onclick = () => itemForm(null);
    $$('[data-item]', out).forEach(a => a.onclick = e => { e.preventDefault(); itemForm(S.items.find(i => i.id === a.dataset.item)); });
  }

  function itemForm(it) {
    const i = it || { uom: S.settings?.default_uom || 'EA', lot_required: true, active: true };
    const body = openModal(it ? `Edit ${it.sku}` : 'Add Item', `
      <form id="item-form">
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
          notes: strOrNull($('#f-notes', body).value)
        };
        if (it) await q(sb.from('items').update(row).eq('id', it.id));
        else await q(sb.from('items').insert(row));
        toast(`${row.sku} saved.`);
        closeModal();
        viewSetup('items');
      });
    };
  }

  function setupLocations(out) {
    out.innerHTML = `
      <form id="loc-form" class="card accent">
        <h2>Add Location</h2>
        <div class="grid2">
          <div class="field"><label for="l-code">Code</label>
            <input id="l-code" required maxlength="30" placeholder="A-01-1" autocapitalize="characters"></div>
          <div class="field"><label for="l-zone">Zone (optional)</label><input id="l-zone" maxlength="30"></div>
          <div class="field"><label for="l-type">Type</label>
            <select id="l-type">${['storage', 'floor', 'staging', 'dock', 'hold'].map(t => `<option>${t}</option>`).join('')}</select></div>
          <div class="field"><label for="l-sort">Sort order</label>
            <input id="l-sort" type="number" inputmode="numeric" value="${(S.locations.length + 1) * 10}"></div>
        </div>
        <button class="btn block" id="loc-save">Add Location</button>
      </form>
      ${S.locations.map(l => `
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
          sort_order: Number($('#l-sort', out).value) || 0
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
      <p class="muted small">Vendors show up as suggestions on receipts. Customers / ship-tos will fill in the ship-to on shipments and BOLs.</p>
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

  async function setupCompany(out) {
    const s = S.settings || {};
    const hasPallets = (await q(sb.from('pallets').select('id', { count: 'exact', head: true })
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
            <div class="hint">${hasPallets ? 'Locked: pallets have already been received.' : 'Example: ' + esc((s.lp_prefix || 'LP') + '000001')}</div></div>
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
            <label class="check" style="margin-top:6px"><input type="checkbox" id="c-custreq" ${s.cust_pallet_required ? 'checked' : ''}> Required</label></div>
          ${[1, 2].map(n => `
          <div class="field"><label for="c-ref${n}">Extra identifier ${n} name</label>
            <input id="c-ref${n}" value="${esc(s['ref' + n + '_label'] || '')}" maxlength="30" placeholder="Leave blank to hide">
            <div class="row" style="margin-top:6px">
              <label class="check"><input type="checkbox" id="c-ref${n}req" ${s['ref' + n + '_required'] ? 'checked' : ''}> Required</label>
              <label class="check"><input type="checkbox" id="c-ref${n}uniq" ${s['ref' + n + '_unique'] ? 'checked' : ''}> Unique per pallet</label>
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
          cust_pallet_required: $('#c-custreq', out).checked
        };
        for (const n of [1, 2]) {
          row['ref' + n + '_label'] = strOrNull($('#c-ref' + n, out).value);
          row['ref' + n + '_required'] = $('#c-ref' + n + 'req', out).checked;
          row['ref' + n + '_unique'] = $('#c-ref' + n + 'uniq', out).checked;
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
