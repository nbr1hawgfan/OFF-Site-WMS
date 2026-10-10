/**
 * LWH WMS — email sender (Google Apps Script)
 *
 * Sends the emails the WMS queues in Supabase (table email_outbox):
 *   - BOL when a load ships, receipt when a receipt closes (per-account switches)
 *   - daily inventory each morning, test emails, manual "Email BOL / Receipt"
 *
 * Setup (once):
 *   1. script.google.com > New project, paste this file as Code.gs.
 *   2. Project Settings > Script Properties, add:
 *        SUPABASE_URL         https://ulclsqwgyvrqjalrmfhr.supabase.co
 *        SUPABASE_SECRET_KEY  the project's secret key (sb_secret_... or the
 *                             legacy service_role key). Keep it private: it
 *                             bypasses all access rules.
 *        APP_URL              https://nbr1hawgfan.github.io/OFF-Site-WMS/
 *        FROM_NAME            (optional) e.g. Logistics Warehouse
 *        REPLY_TO             (optional) e.g. shipping@logistics-warehouse.com
 *   3. Run testConnection() and approve the permissions it asks for.
 *   4. Run setup() once. It adds two triggers: send every 5 minutes, and
 *      queue the daily inventory emails at 6 AM Central.
 *
 * Emails go out from the Google account that owns the script (Workspace
 * accounts can send about 1,500 a day; a free Gmail account about 100).
 */

const TZ = 'America/Chicago';
const MAX_ATTEMPTS = 3;

function cfg_() {
  const p = PropertiesService.getScriptProperties();
  const c = {
    url: (p.getProperty('SUPABASE_URL') || '').replace(/\/+$/, ''),
    key: p.getProperty('SUPABASE_SECRET_KEY') || '',
    app: p.getProperty('APP_URL') || '',
    fromName: p.getProperty('FROM_NAME') || '',
    replyTo: p.getProperty('REPLY_TO') || ''
  };
  if (!c.url || !c.key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in Project Settings > Script Properties.');
  return c;
}

function api_(method, path, body) {
  const c = cfg_();
  const headers = { apikey: c.key, 'Content-Type': 'application/json' };
  if (c.key.indexOf('eyJ') === 0) headers.Authorization = 'Bearer ' + c.key;   // legacy service_role key
  if (method === 'patch') headers.Prefer = 'return=minimal';
  const res = UrlFetchApp.fetch(c.url + '/rest/v1/' + path, {
    method: method, headers: headers, muteHttpExceptions: true,
    payload: body === undefined ? undefined : JSON.stringify(body)
  });
  const code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error('Supabase ' + code + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

/* ---------------- entry points ---------------- */

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['sendQueued', 'dailyInventory'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendQueued').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('dailyInventory').timeBased().atHour(6).everyDays(1).inTimezone(TZ).create();
  Logger.log('Triggers set: sendQueued every 5 minutes, dailyInventory at 6 AM ' + TZ + '.');
}

function testConnection() {
  const rows = api_('get', 'email_outbox?select=id,status&order=id.desc&limit=5');
  Logger.log('Connected. Latest queue rows: ' + JSON.stringify(rows));
  Logger.log('Emails left today for this account: ' + MailApp.getRemainingDailyQuota());
}

// queue each account's daily inventory (accounts with "Daily inventory" on), then send
function dailyInventory() {
  const n = api_('post', 'rpc/wms_queue_daily_inventory', {});
  Logger.log('Daily inventory emails queued: ' + n);
  sendQueued();
}

function sendQueued() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;            // another run is still sending
  try {
    const c = cfg_();
    const rows = api_('get', 'email_outbox?status=eq.queued&order=id.asc&limit=40&select=*');
    rows.forEach(function (row) {
      if (MailApp.getRemainingDailyQuota() < 1) throw new Error('Daily email quota used up; the rest send tomorrow.');
      try {
        const m = render_(row, c);
        const opts = { to: row.to_addr, subject: row.subject, htmlBody: m.html, attachments: m.attachments,
          name: c.fromName || (row.payload.company && row.payload.company.name) || 'Warehouse' };
        if (c.replyTo) opts.replyTo = c.replyTo;
        MailApp.sendEmail(opts);
        api_('patch', 'email_outbox?id=eq.' + row.id, { status: 'sent', sent_at: new Date().toISOString(), attempts: row.attempts + 1, error: null });
      } catch (e) {
        const tries = row.attempts + 1;
        api_('patch', 'email_outbox?id=eq.' + row.id,
          { status: tries >= MAX_ATTEMPTS ? 'error' : 'queued', attempts: tries, error: String(e.message || e).slice(0, 500) });
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- rendering ---------------- */

function esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function num_(n) { const v = Number(n || 0); return v % 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toLocaleString('en-US'); }
function when_(iso, withTime) {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return Utilities.formatDate(d, TZ, withTime ? 'MM/dd/yyyy h:mm a' : 'MM/dd/yyyy');
}
function daysOld_(iso) { return iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : ''; }

// identifier columns used by any pallet: [{ field, label }]
function idCols_(company, pallets) {
  return (company.ids || []).filter(function (d) {
    const key = d.field === 'customer_pallet_id' ? 'customer_pallet_id' : d.field;
    return pallets.some(function (p) { return p.ids && p.ids[key]; });
  });
}

function table_(heads, rows, numCols) {
  numCols = numCols || [];
  const th = 'style="text-align:left;padding:6px 8px;background:#f2f2f2;border-bottom:2px solid #999;font-size:12px;text-transform:uppercase"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #ddd;font-size:13px"';
  const tdn = 'style="padding:6px 8px;border-bottom:1px solid #ddd;font-size:13px;text-align:right"';
  return '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 14px">'
    + '<tr>' + heads.map(function (h, i) { return '<th ' + (numCols.indexOf(i) >= 0 ? th.replace('text-align:left', 'text-align:right') : th) + '>' + esc_(h) + '</th>'; }).join('') + '</tr>'
    + rows.map(function (r) { return '<tr>' + r.map(function (v, i) { return '<td ' + (numCols.indexOf(i) >= 0 ? tdn : td) + '>' + esc_(v) + '</td>'; }).join('') + '</tr>'; }).join('')
    + '</table>';
}
function facts_(pairs) {
  return '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:6px 0 14px">'
    + pairs.filter(function (p) { return p[1] !== null && p[1] !== undefined && p[1] !== ''; }).map(function (p) {
      return '<tr><td style="padding:3px 14px 3px 0;color:#666;font-size:12px;text-transform:uppercase;vertical-align:top">' + esc_(p[0])
        + '</td><td style="padding:3px 0;font-size:14px">' + esc_(p[1]) + '</td></tr>';
    }).join('') + '</table>';
}
function frame_(company, title, sub, body, c) {
  const accent = company.accent || '#C41230';
  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:760px">'
    + '<div style="border-top:6px solid ' + accent + ';padding:14px 0 8px"><div style="font-size:20px;font-weight:bold">' + esc_(company.name) + '</div>'
    + '<div style="font-size:12px;color:#555">' + esc_([company.address, company.phone].filter(Boolean).join(' · ')) + '</div></div>'
    + '<h2 style="margin:10px 0 2px;font-size:20px">' + esc_(title) + '</h2>'
    + (sub ? '<div style="color:#555;font-size:13px;margin-bottom:10px">' + esc_(sub) + '</div>' : '')
    + body
    + '<div style="margin-top:18px;padding-top:10px;border-top:1px solid #ddd;font-size:12px;color:#777">'
    + (c.app ? 'Log in to see inventory, pallet history and paperwork any time: <a href="' + esc_(c.app) + '" style="color:' + accent + '">' + esc_(c.app) + '</a><br>' : '')
    + 'Sent automatically by the ' + esc_(company.name) + ' warehouse system.</div></div>';
}

// summary by item and lot: [sku, description, lot, pallets, qty, uom]
function byItem_(pallets) {
  const m = {};
  pallets.forEach(function (p) {
    const k = [p.warehouse || '', p.sku, p.lot || ''].join('|');
    m[k] = m[k] || { wh: p.warehouse || '', sku: p.sku, desc: p.description, lot: p.lot || '', pallets: 0, qty: 0, uom: p.uom, oldest: 0 };
    m[k].pallets++; m[k].qty += Number(p.qty || 0); m[k].oldest = Math.max(m[k].oldest, daysOld_(p.received) || 0);
  });
  return Object.keys(m).sort().map(function (k) { return m[k]; });
}

function palletCsv_(company, pallets, extra) {
  const ids = idCols_(company, pallets);
  const heads = (extra ? ['Warehouse', 'Location'] : []).concat(['WMS Pallet ID'], ids.map(function (d) { return d.label; }),
    ['SKU', 'Description', company.lot_label || 'Lot', 'Qty', 'UOM'], extra ? ['Received', 'Days', 'Status'] : []);
  const cell = function (v) { const s = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [heads].concat(pallets.map(function (p) {
    return (extra ? [p.warehouse || '', p.location || ''] : []).concat([p.lp_id], ids.map(function (d) { return (p.ids || {})[d.field] || ''; }),
      [p.sku, p.description, p.lot || '', p.qty, p.uom], extra ? [when_(p.received), daysOld_(p.received), p.status || ''] : []);
  }));
  return '﻿' + lines.map(function (r) { return r.map(cell).join(','); }).join('\r\n');
}

function render_(row, c) {
  const P = row.payload || {}, company = P.company || {}, acct = company.account || {}, d = P.doc || {};
  const pallets = P.pallets || [];
  const ids = idCols_(company, pallets);
  const lotLbl = company.lot_label || 'Lot';
  const detail = function () {
    return table_(['WMS Pallet ID'].concat(ids.map(function (x) { return x.label; }), ['SKU', lotLbl, 'Qty', 'UOM']),
      pallets.map(function (p) { return [p.lp_id].concat(ids.map(function (x) { return (p.ids || {})[x.field] || ''; }), [p.sku, p.lot || '', num_(p.qty), p.uom]); }),
      [ids.length + 3]);
  };
  const summary = function (withWh) {
    const rows = byItem_(pallets);
    return table_((withWh ? ['Warehouse'] : []).concat(['SKU', 'Description', lotLbl, 'Pallets', 'Qty', 'UOM'], withWh ? ['Oldest (days)'] : []),
      rows.map(function (r) { return (withWh ? [r.wh] : []).concat([r.sku, r.desc, r.lot, num_(r.pallets), num_(r.qty), r.uom], withWh ? [r.oldest] : []); }),
      withWh ? [4, 5, 7] : [3, 4]);
  };
  const totals = function () {
    const uoms = pallets.map(function (p) { return p.uom; }).filter(function (u, i, a) { return a.indexOf(u) === i; });
    const qty = pallets.reduce(function (a, p) { return a + Number(p.qty || 0); }, 0);
    return num_(pallets.length) + ' pallet' + (pallets.length === 1 ? '' : 's') + (uoms.length === 1 ? ' · ' + num_(qty) + ' ' + uoms[0] : '');
  };
  const csv = function (name, extra) { return [Utilities.newBlob(palletCsv_(company, pallets, extra), 'text/csv', name)]; };

  if (row.kind === 'bol') {
    const addr = [d.ship_to_address1, d.ship_to_address2, [d.ship_to_city, d.ship_to_state].filter(Boolean).join(', '), d.ship_to_zip].filter(Boolean).join(', ');
    const body = facts_([['BOL #', d.shipment_no], ['Account', acct.code ? acct.code + ' — ' + acct.name : ''], ['Shipped', when_(d.shipped_at, true)],
      ['Ship to', [d.ship_to_name, addr].filter(Boolean).join(' — ')], ['Carrier', d.carrier], ['Trailer', d.trailer_no], ['Seal', d.seal_no],
      ['PRO #', d.pro_number], ['Order #', d.customer_order_no], ['PO #', d.po_number], ['Total', totals()]])
      + '<h3 style="margin:8px 0 0;font-size:15px">Items</h3>' + summary(false)
      + '<h3 style="margin:8px 0 0;font-size:15px">Pallets</h3>' + detail();
    return { html: frame_(company, 'Shipped — BOL ' + d.shipment_no, d.ship_to_name ? 'to ' + d.ship_to_name : '', body, c), attachments: csv('BOL-' + d.shipment_no + '.csv') };
  }
  if (row.kind === 'receipt') {
    const body = facts_([['Receipt #', d.receipt_no], ['Account', acct.code ? acct.code + ' — ' + acct.name : ''], ['Received', when_(d.received_at, true)],
      ['Warehouse', company.warehouse], ['From', d.vendor_name], ['Carrier', d.carrier], ['Trailer', d.trailer_no], ['Seal', d.seal_no],
      ['PO #', d.po_number], ['Inbound BOL', d.inbound_bol], ['Total', totals()]])
      + '<h3 style="margin:8px 0 0;font-size:15px">Items</h3>' + summary(false)
      + '<h3 style="margin:8px 0 0;font-size:15px">Pallets</h3>' + detail();
    return { html: frame_(company, 'Received — ' + d.receipt_no, d.vendor_name ? 'from ' + d.vendor_name : '', body, c), attachments: csv('Receipt-' + d.receipt_no + '.csv') };
  }
  if (row.kind === 'daily') {
    const held = pallets.filter(function (p) { return p.status === 'hold'; }).length;
    const body = facts_([['Account', acct.code ? acct.code + ' — ' + acct.name : ''], ['As of', when_(new Date().toISOString(), true)],
      ['On hand', pallets.length ? totals() : 'Nothing on hand'], ['On hold', held ? num_(held) + ' pallet' + (held === 1 ? '' : 's') : '']])
      + (pallets.length ? '<h3 style="margin:8px 0 0;font-size:15px">By item and ' + esc_(lotLbl.toLowerCase()) + '</h3>' + summary(true)
        + '<div style="font-size:12px;color:#555">Every pallet with its location and IDs is in the attached spreadsheet.</div>' : '');
    return { html: frame_(company, 'Daily inventory', acct.name || '', body, c),
      attachments: pallets.length ? csv('Inventory-' + (acct.code || 'account') + '-' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '.csv', true) : [] };
  }
  // test
  return { html: frame_(company, 'Test email', acct.name || '',
    '<p style="font-size:14px">Emails from the warehouse system will reach this address. You can turn on BOL, receipt and daily inventory emails for account '
    + esc_(acct.code || '') + ' in Setup &gt; Accounts.</p>', c), attachments: [] };
}
