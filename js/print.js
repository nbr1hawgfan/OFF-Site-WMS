/* Printing: 4x6 pallet labels and letter-size receiving receipts.
   Output renders into #print-root, which is only visible when printing. */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtQty(n) {
  const x = Number(n);
  return Number.isInteger(x) ? x.toLocaleString() : x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  const dt = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00') : new Date(d);
  return dt.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const WmsPrint = (() => {
  const root = () => document.getElementById('print-root');

  function renderBarcodes(container) {
    container.querySelectorAll('svg.bc[data-value]').forEach(svg => {
      try {
        JsBarcode(svg, svg.dataset.value, {
          format: 'CODE128', displayValue: false, margin: 0,
          width: 2, height: Number(svg.dataset.h || 80)
        });
        svg.setAttribute('preserveAspectRatio', 'none');
      } catch (e) { console.warn('barcode failed', e); }
    });
  }

  function printDoc(html, pageCss) {
    const el = root();
    el.innerHTML = `<style>@page { ${pageCss} }</style>${html}`;
    renderBarcodes(el);
    const clear = () => { el.innerHTML = ''; window.removeEventListener('afterprint', clear); };
    window.addEventListener('afterprint', clear);
    // let the browser lay out the SVGs before opening the dialog
    setTimeout(() => window.print(), 150);
  }

  // identifier labels configured in Company setup
  function idDefs(settings) {
    const st = settings || {};
    const out = [{ field: 'customer_pallet_id', label: st.cust_pallet_label || 'Customer Pallet ID', barcode: !!st.cust_pallet_barcode }];
    for (let n = 1; n <= 7; n++) if (st['ref' + n + '_label']) out.push({ field: 'ref' + n, label: st['ref' + n + '_label'], barcode: !!st['ref' + n + '_barcode'] });
    return out;
  }
  const lotLabel = st => (st && st.lot_label) || 'Lot / Production #';

  /* pallets: [{ lp_id, customer_pallet_id, ref1, ref2, lot_number, qty, uom, sku, description,
                 production_date, expiration_date, received_at, receipt_no }] */
  function labels(pallets, settings, copies = 1) {
    const company = esc((settings?.company_name || '').replace(/_/g, ' '));
    const ids = idDefs(settings);
    const one = p => {
      const extraBc = ids.filter(d => d.barcode && p[d.field]).length + (ids.filter(d => p[d.field]).length > 4 ? 2 : 0);   // shrink the big barcode to make room
      return `
      <section class="lbl">
        <div class="lbl-top"><span>${company}</span><span>${esc(fmtDate(p.received_at))}</span></div>
        <div class="lbl-caption">WMS PALLET ID</div>
        <div class="lbl-lp">${esc(p.lp_id)}</div>
        <svg class="bc lbl-bc ${extraBc >= 2 ? 'tight' : ''}" data-value="${esc(p.lp_id)}" data-h="90"></svg>
        <div class="lbl-sku">${esc(p.sku)}</div>
        <div class="lbl-desc">${esc(p.description)}</div>
        <div class="lbl-grid">
          <div><div class="lbl-caption">${esc(lotLabel(settings).toUpperCase())}</div><div class="lbl-val">${esc(p.lot_number || '-')}</div></div>
          <div class="right"><div class="lbl-caption">QTY</div><div class="lbl-val big">${esc(fmtQty(p.qty))} <small>${esc(p.uom)}</small></div></div>
        </div>
        ${p.lot_number ? `<svg class="bc lbl-bc-sm" data-value="${esc(p.lot_number)}" data-h="40"></svg>` : ''}
        ${ids.filter(d => p[d.field] && d.barcode).map(d =>
          `<div class="lbl-idbc"><div class="lbl-cust"><span class="lbl-caption">${esc(d.label.toUpperCase())}</span> ${esc(p[d.field])}</div>
              <svg class="bc lbl-bc-id" data-value="${esc(p[d.field])}" data-h="36"></svg></div>`).join('')}
        ${(() => { // text-only identifiers: a compact two-column grid when there are many (e.g. Nissan's 8)
          const t = ids.filter(d => p[d.field] && !d.barcode);
          return t.length > 3
            ? `<div class="lbl-ids">${t.map(d => `<div><span class="lbl-caption">${esc(d.label.toUpperCase())}</span> ${esc(p[d.field])}</div>`).join('')}</div>`
            : t.map(d => `<div class="lbl-cust"><span class="lbl-caption">${esc(d.label.toUpperCase())}</span> ${esc(p[d.field])}</div>`).join('');
        })()}
        ${(p.production_date || p.expiration_date) ? `<div class="lbl-dates">
            ${p.production_date ? `Prod: ${esc(fmtDate(p.production_date))}` : ''}
            ${p.expiration_date ? `&nbsp;&nbsp;Exp: ${esc(fmtDate(p.expiration_date))}` : ''}</div>` : ''}
        <div class="lbl-foot">Receipt ${esc(p.receipt_no || '')}${p.owner_code ? ' &middot; ' + esc(p.owner_code) : ''}${settings?.warehouse_code ? ' &middot; ' + esc(settings.warehouse_code) : ''}</div>
      </section>`;
    };

    let html = '';
    for (const p of pallets) for (let i = 0; i < copies; i++) html += one(p);

    const css = `
      <style>
        .lbl { width: 4in; height: 6in; padding: .18in .2in; box-sizing: border-box;
               font-family: Arial, Helvetica, sans-serif; color: #000;
               page-break-after: always; break-after: page; overflow: hidden; }
        .lbl:last-child { page-break-after: auto; break-after: auto; }
        .lbl-top { display: flex; justify-content: space-between; font-size: 11pt; font-weight: 700;
                   border-bottom: 2pt solid #000; padding-bottom: 3pt; margin-bottom: 6pt; }
        .lbl-caption { font-size: 8pt; font-weight: 700; letter-spacing: .5pt; color: #000; }
        .lbl-lp { font-family: "Courier New", monospace; font-weight: 800; font-size: 34pt; line-height: 1; margin: 1pt 0 5pt; }
        .lbl-bc { width: 100%; height: 1.05in; display: block; }
        .lbl-bc.tight { height: .8in; }
        .lbl-bc-id { width: 62%; height: .34in; display: block; margin-top: 1pt; }
        .lbl-idbc { margin-top: 2pt; }
        .lbl-bc-sm { width: 70%; height: .42in; display: block; margin-top: 4pt; }
        .lbl-sku { font-size: 24pt; font-weight: 800; margin-top: 8pt; line-height: 1.05; }
        .lbl-desc { font-size: 12pt; margin-bottom: 6pt; max-height: .42in; overflow: hidden; }
        .lbl-grid { display: flex; justify-content: space-between; gap: 8pt;
                    border-top: 1.5pt solid #000; padding-top: 5pt; }
        .lbl-grid .right { text-align: right; }
        .lbl-val { font-size: 20pt; font-weight: 800; }
        .lbl-val.big { font-size: 28pt; }
        .lbl-val small { font-size: 12pt; }
        .lbl-cust { font-size: 13pt; font-weight: 700; margin-top: 4pt; }
        .lbl-ids { display: grid; grid-template-columns: 1fr 1fr; gap: 1pt 8pt; margin-top: 4pt; font-size: 10pt; font-weight: 700; }
        .lbl-ids div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lbl-dates { font-size: 11pt; margin-top: 3pt; }
        .lbl-foot { font-size: 10pt; margin-top: 5pt; border-top: 1pt solid #000; padding-top: 3pt; }
      </style>`;
    printDoc(css + html, 'size: 4in 6in; margin: 0;');
  }

  /* receipt: header row; pallets: active pallets with sku/description/uom */
  function receipt(rcpt, pallets, settings, owner, billTo) {
    const s = settings || {};
    const company = esc((s.company_name || '').replace(/_/g, ' '));
    const addr = [s.address_line1, s.address_line2, [s.city, s.state].filter(Boolean).join(', ') + (s.zip ? ' ' + s.zip : '')]
      .filter(x => x && x.trim()).map(esc).join('<br>');

    // totals by SKU + lot
    const totals = {};
    for (const p of pallets) {
      const k = p.sku + '|' + (p.lot_number || '');
      totals[k] = totals[k] || { sku: p.sku, description: p.description, lot: p.lot_number, uom: p.uom, pallets: 0, qty: 0 };
      totals[k].pallets += 1; totals[k].qty += Number(p.qty_received);
    }
    // only print identifier columns that have data on this receipt
    const usedIds = idDefs(s).filter(d => pallets.some(p => p[d.field]));
    const totalRows = Object.values(totals).sort((a, b) => (a.sku + a.lot).localeCompare(b.sku + b.lot));
    const totalQty = pallets.reduce((a, p) => a + Number(p.qty_received), 0);
    const uoms = [...new Set(pallets.map(p => p.uom))];
    const totalCell = uoms.length === 1 ? `${esc(fmtQty(totalQty))}` : '';
    const totalUom = uoms.length === 1 ? esc(uoms[0]) : '';

    const html = `
      <style>
        .rc { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 10.5pt; }
        .rc-head { display: flex; justify-content: space-between; align-items: flex-start;
                   border-bottom: 3pt solid ${window.WMS_DOC_ACCENT || '#C41230'}; padding-bottom: 8pt; margin-bottom: 10pt; }
        .rc-co { font-size: 16pt; font-weight: 800; }
        .rc-title { text-align: right; }
        .rc-title h1 { font-size: 18pt; margin: 0; }
        .rc-no { font-family: "Courier New", monospace; font-size: 14pt; font-weight: 800; }
        .rc-info { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4pt 16pt; margin-bottom: 12pt; }
        .rc-info div span { display: block; font-size: 8pt; font-weight: 700; color: #444; text-transform: uppercase; }
        .rc h2 { font-size: 12pt; margin: 12pt 0 4pt; border-bottom: 1pt solid #000; }
        .rc table { width: 100%; border-collapse: collapse; }
        .rc th, .rc td { border-bottom: .5pt solid #999; padding: 3pt 4pt; text-align: left; vertical-align: top; }
        .rc th { font-size: 8.5pt; text-transform: uppercase; background: #eee; }
        .rc .num { text-align: right; }
        .rc tfoot td { font-weight: 800; border-top: 1.5pt solid #000; }
        .rc .mono { font-family: "Courier New", monospace; }
        .rc-notes { margin-top: 10pt; }
        .rc-sign { display: grid; grid-template-columns: 1fr 1fr; gap: 30pt; margin-top: 36pt; }
        .rc-sign div { border-top: 1pt solid #000; padding-top: 3pt; font-size: 9pt; }
        .rc-foot { margin-top: 18pt; font-size: 8pt; color: #555; }
      </style>
      <div class="rc">
        <div class="rc-head">
          <div><div class="rc-co">${company}</div><div>${addr}</div>${s.phone ? `<div>${esc(s.phone)}</div>` : ''}</div>
          <div class="rc-title"><h1>Receiving Receipt</h1><div class="rc-no">${esc(rcpt.receipt_no)}</div>
            ${rcpt.status === 'void' ? '<div style="color:#b3261e;font-weight:800">VOID</div>' : ''}</div>
        </div>
        <div class="rc-info">
          <div><span>Customer account</span>${esc(owner ? owner.code + ' — ' + owner.name : '')}</div>
          <div><span>Bill-to</span>${esc(billTo && billTo.code ? billTo.code + ' — ' + billTo.name : (owner ? owner.code : ''))}</div>
          <div><span>Carrier arranged by</span>${rcpt.carrier_by === 'lwh' ? 'Logistics Warehouse' : 'Customer / shipper'}</div>
          <div><span>Received</span>${esc(fmtDateTime(rcpt.received_at))}</div>
          <div><span>From / Vendor</span>${esc(rcpt.vendor_name || '')}</div>
          <div><span>PO #</span>${esc(rcpt.po_number || '')}</div>
          <div><span>Carrier</span>${esc(rcpt.carrier || '')}</div>
          <div><span>Trailer #</span>${esc(rcpt.trailer_no || '')}</div>
          <div><span>Seal #</span>${esc(rcpt.seal_no || '')}</div>
          <div><span>Inbound BOL / PRO</span>${esc(rcpt.inbound_bol || '')}</div>
          <div><span>Status</span>${esc(rcpt.status.charAt(0).toUpperCase() + rcpt.status.slice(1))}</div>
          <div><span>Pallets</span>${pallets.length}</div>
        </div>

        <h2>Summary</h2>
        <table>
          <thead><tr><th>SKU</th><th>Description</th><th>${esc(lotLabel(s))}</th><th class="num">Pallets</th><th class="num">Qty</th><th>UOM</th></tr></thead>
          <tbody>${totalRows.map(t => `<tr><td>${esc(t.sku)}</td><td>${esc(t.description)}</td><td>${esc(t.lot || '')}</td>
            <td class="num">${t.pallets}</td><td class="num">${esc(fmtQty(t.qty))}</td><td>${esc(t.uom)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="3">Total</td><td class="num">${pallets.length}</td><td class="num">${totalCell}</td><td>${totalUom}</td></tr></tfoot>
        </table>

        <h2>Pallet Detail</h2>
        <table>
          <thead><tr><th>WMS Pallet ID</th>${usedIds.map(d => `<th>${esc(d.label)}</th>`).join('')}<th>SKU</th><th>${esc(lotLabel(s))}</th><th class="num">Qty</th><th>Location</th></tr></thead>
          <tbody>${pallets.map(p => `<tr><td class="mono">${esc(p.lp_id)}</td>${usedIds.map(d => `<td>${esc(p[d.field] || '')}</td>`).join('')}
            <td>${esc(p.sku)}</td><td>${esc(p.lot_number || '')}</td><td class="num">${esc(fmtQty(p.qty_received))}</td>
            <td>${esc(p.location || '')}</td></tr>`).join('')}</tbody>
        </table>

        ${rcpt.notes ? `<div class="rc-notes"><strong>Notes:</strong> ${esc(rcpt.notes)}</div>` : ''}

        <div class="rc-sign"><div>Received by</div><div>Driver signature</div></div>
        <div class="rc-foot">Printed ${esc(fmtDateTime(new Date()))}</div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.5in;');
  }

  /* Straight bill of lading (letter). lines: v_shipment_detail rows */
  function bol(ship, lines, settings, owner, billTo) {
    const s = settings || {};
    const tare = Number(s.pallet_tare_lbs || 0);
    const company = esc((s.company_name || '').replace(/_/g, ' '));
    const fromAddr = [s.address_line1, s.address_line2, [s.city, s.state].filter(Boolean).join(', ') + (s.zip ? ' ' + s.zip : '')]
      .filter(x => x && x.trim()).map(esc).join('<br>');
    const toAddr = [ship.ship_to_address1, ship.ship_to_address2,
      [ship.ship_to_city, ship.ship_to_state].filter(Boolean).join(', ') + (ship.ship_to_zip ? ' ' + ship.ship_to_zip : '')]
      .filter(x => x && x.trim()).map(esc).join('<br>');
    const fmtTimeStr = t => {
      if (!t) return '';
      const [h, m] = String(t).split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    };
    const box = on => `<span class="bx">${on ? '&#10003;' : '&nbsp;'}</span>`;

    // carrier lines: one per item (freight class / NMFC are per item)
    const byItem = {};
    for (const l of lines) {
      const k = l.item_id;
      byItem[k] = byItem[k] || { sku: l.sku, description: l.description, uom: l.uom, nmfc: l.nmfc, cls: l.freight_class,
        pallets: new Set(), qty: 0, weight: 0 };
      byItem[k].pallets.add(l.pallet_id);
      byItem[k].qty += Number(l.qty);
      byItem[k].weight += Number(l.product_weight_lbs || 0);
    }
    const items = Object.values(byItem).sort((a, b) => a.sku.localeCompare(b.sku));
    items.forEach(i => { i.hu = i.pallets.size; i.weight += tare * i.hu; });
    const totHU = new Set(lines.map(l => l.pallet_id)).size;
    const totWeight = items.reduce((a, i) => a + i.weight, 0);
    const uoms = [...new Set(items.map(i => i.uom))];
    const totQty = uoms.length === 1 ? fmtQty(items.reduce((a, i) => a + i.qty, 0)) : '';
    const wt = n => n ? fmtQty(Math.round(n)) : '';

    const ids = idDefs(s).filter(d => lines.some(l => l[d.field]));
    // pallet detail: grouped by item (like the LWH BOL), each with an item total
    const sortedLines = [...lines].sort((a, b) => a.sku.localeCompare(b.sku) || String(a.lot_number || '').localeCompare(String(b.lot_number || '')) || String(a.lp_id).localeCompare(String(b.lp_id)));
    const detailGroups = [];
    for (const l of sortedLines) {
      let g = detailGroups[detailGroups.length - 1];
      if (!g || g.item_id !== l.item_id) detailGroups.push(g = { item_id: l.item_id, sku: l.sku, description: l.description, uom: l.uom, qty: 0, rows: [] });
      g.rows.push(l); g.qty += Number(l.qty);
    }

    const html = `
      <style>
        .bl tr.itot td { font-weight: 700; background: #f7f7f7; border-top: 1.25pt solid #000; }
        .bl { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 9.5pt; }
        .bl table { width: 100%; border-collapse: collapse; }
        .bl td, .bl th { border: .75pt solid #000; padding: 3pt 4pt; vertical-align: top; text-align: left; }
        .bl th { background: #e6e6e6; font-size: 8pt; text-transform: uppercase; }
        .bl .cap { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; display: block; margin-bottom: 1pt; }
        .bl .hdr td { border: 0; padding: 0; }
        .bl h1 { font-size: 17pt; margin: 0; }
        .bl .sub { font-size: 9pt; }
        .bl .bolno { font-family: "Courier New", monospace; font-size: 15pt; font-weight: 800; }
        .bl .num { text-align: right; }
        .bl .center { text-align: center; }
        .bl .big { font-size: 11pt; font-weight: 700; }
        .bl .bx { display: inline-block; width: 9pt; height: 9pt; border: .75pt solid #000; text-align: center;
                  line-height: 9pt; font-size: 8pt; margin-right: 3pt; vertical-align: middle; }
        .bl .sec { margin-top: 6pt; }
        .bl .fine { font-size: 7.5pt; }
        .bl .sig td { height: 46pt; width: 33.3%; }
        .bl tfoot td { font-weight: 800; background: #f2f2f2; }
        .bl .bc-bol { width: 2.4in; height: .45in; display: block; margin-left: auto; }
        .bl .mono { font-family: "Courier New", monospace; }
        .bl .pg2 { page-break-before: always; break-before: page; }
      </style>
      <div class="bl">
        <table class="hdr"><tr>
          <td><h1>BILL OF LADING</h1><div class="sub">Straight Bill of Lading &mdash; Short Form &mdash; Not Negotiable</div></td>
          <td style="text-align:right"><span class="cap">BOL Number</span><div class="bolno">${esc(ship.shipment_no)}</div>
            <svg class="bc bc-bol" data-value="${esc(ship.shipment_no)}" data-h="45"></svg></td>
        </tr></table>

        <table class="sec">
          <tr>
            <td style="width:50%"><span class="cap">Ship From</span>${owner && owner.name ? `<span class="big">${esc(owner.name)}</span><br>c/o ${company}` : `<span class="big">${company}</span>`}<br>${fromAddr}${s.phone ? '<br>' + esc(s.phone) : ''}</td>
            <td><span class="cap">Date</span>${esc(fmtDate(ship.ship_date))}${ship.appt_time ? ' &nbsp; Appt ' + esc(fmtTimeStr(ship.appt_time)) : ''}<br>
              <span class="cap" style="margin-top:4pt">Carrier Name</span>${esc(ship.carrier || '')}</td>
          </tr>
          <tr>
            <td><span class="cap">Ship To</span><span class="big">${esc(ship.ship_to_name || '')}</span><br>${toAddr}
              ${ship.ship_to_contact || ship.ship_to_phone ? `<br>Attn: ${esc([ship.ship_to_contact, ship.ship_to_phone].filter(Boolean).join(' · '))}` : ''}</td>
            <td>
              <table class="hdr"><tr>
                <td style="width:50%"><span class="cap">Trailer #</span>${esc(ship.trailer_no || '')}</td>
                <td><span class="cap">Seal #</span>${esc(ship.seal_no || '')}</td></tr>
                <tr><td style="padding-top:4pt"><span class="cap">SCAC</span>${esc(ship.carrier_scac || '')}</td>
                <td style="padding-top:4pt"><span class="cap">PRO #</span>${esc(ship.pro_number || '')}</td></tr></table>
            </td>
          </tr>
          <tr>
            <td><span class="cap">Third Party Freight Charges Bill To</span>${esc(ship.third_party_bill_to || '').replace(/\n/g, '<br>')}</td>
            <td><span class="cap">Freight Charge Terms</span>
              ${box(ship.freight_terms === 'prepaid')} Prepaid &nbsp; ${box(ship.freight_terms === 'collect')} Collect &nbsp; ${box(ship.freight_terms === 'third_party')} 3rd Party
              ${ship.carrier_by !== 'lwh' ? '<br><span style="font-size:8.5pt">Customer pickup: carrier arranged by customer</span>' : ''}</td>
          </tr>
          <tr><td colspan="2"><span class="cap">Special Instructions</span>${esc(ship.special_instructions || '')}</td></tr>
        </table>

        <table class="sec">
          <thead><tr><th>Customer Order #</th><th class="num"># Pkgs</th><th class="num">Weight (lbs)</th><th class="center">Pallet/Slip</th><th>Additional Shipper Info</th></tr></thead>
          <tbody><tr><td>${esc(ship.customer_order_no || '')}</td><td class="num">${esc(totQty)}</td><td class="num">${esc(wt(totWeight))}</td>
            <td class="center">${totHU ? 'Y' : 'N'}</td><td>${esc([ship.po_number && 'PO ' + ship.po_number, owner && 'Acct ' + owner.code, billTo && billTo.code && owner && billTo.code !== owner.code && 'Bill-to ' + billTo.code].filter(Boolean).join(' · '))}</td></tr></tbody>
        </table>

        <table class="sec">
          <thead><tr><th class="num">HU Qty</th><th>HU Type</th><th class="num">Pkg Qty</th><th>Pkg Type</th><th class="num">Weight (lbs)</th>
            <th class="center">H.M.</th><th>Commodity Description</th><th>NMFC #</th><th>Class</th></tr></thead>
          <tbody>${items.map(i => `<tr><td class="num">${i.hu}</td><td>PLT</td><td class="num">${esc(fmtQty(i.qty))}</td><td>${esc(i.uom)}</td>
            <td class="num">${esc(wt(i.weight))}</td><td class="center"></td><td>${esc(i.sku)} &mdash; ${esc(i.description)}</td>
            <td>${esc(i.nmfc || '')}</td><td>${esc(i.cls || '')}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td class="num">${totHU}</td><td>PLT</td><td class="num">${esc(totQty)}</td><td>${uoms.length === 1 ? esc(uoms[0]) : ''}</td>
            <td class="num">${esc(wt(totWeight))}</td><td></td><td>Grand Total</td><td></td><td></td></tr></tfoot>
        </table>

        <p class="fine sec">This is to certify that the above named materials are properly classified, packaged, marked and labeled,
          and are in proper condition for transportation according to applicable regulations. Received subject to the rates,
          classifications and rules agreed between the carrier and shipper, or as published by the carrier.</p>

        <table class="sec sig">
          <tr>
            <td><span class="cap">Shipper Signature / Date</span></td>
            <td><span class="cap">Trailer Loaded</span>${box(false)} By shipper &nbsp; ${box(false)} By driver
              <span class="cap" style="margin-top:6pt">Freight Counted</span>${box(false)} By shipper &nbsp; ${box(false)} By driver</td>
            <td><span class="cap">Carrier Signature / Pickup Date</span></td>
          </tr>
          <tr><td colspan="3" style="height:40pt"><span class="cap">Consignee: received in good order, except as noted / Signature / Date</span></td></tr>
        </table>

        <div class="pg2">
          <table class="hdr"><tr><td><h1 style="font-size:14pt">Pallet Detail</h1></td>
            <td style="text-align:right"><span class="cap">BOL Number</span><span class="bolno" style="font-size:12pt">${esc(ship.shipment_no)}</span></td></tr></table>
          <table class="sec">
            <thead><tr><th>WMS Pallet ID</th>${ids.map(d => `<th>${esc(d.label)}</th>`).join('')}<th>SKU</th><th>${esc(lotLabel(s))}</th><th class="num">Qty</th><th>UOM</th></tr></thead>
            <tbody>${detailGroups.map(g => g.rows.map(l => `<tr><td class="mono">${esc(l.lp_id)}</td>${ids.map(d => `<td>${esc(l[d.field] || '')}</td>`).join('')}
              <td>${esc(l.sku)}</td><td>${esc(l.lot_number || '')}</td><td class="num">${esc(fmtQty(l.qty))}</td><td>${esc(l.uom)}</td></tr>`).join('')
              + `<tr class="itot"><td>${g.rows.length} pallet${g.rows.length === 1 ? '' : 's'}</td><td colspan="${ids.length + 2}">Item Total &mdash; ${esc(g.sku)} ${esc(g.description || '')}</td>
              <td class="num">${esc(fmtQty(g.qty))}</td><td>${esc(g.uom)}</td></tr>`).join('')}</tbody>
            <tfoot><tr><td>${totHU} pallet${totHU === 1 ? '' : 's'}</td><td colspan="${ids.length + 2}">Grand Total</td><td class="num">${esc(totQty)}</td><td>${uoms.length === 1 ? esc(uoms[0]) : ''}</td></tr></tfoot>
          </table>
          <p class="fine sec">Printed ${esc(fmtDateTime(new Date()))}${ship.status !== 'shipped' ? ' &middot; ' + esc(ship.status.toUpperCase()) + ' (not yet shipped)' : ''}</p>
        </div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.4in;');
  }

  /* shared look for the dock sheets */
  const sheetCss = `
    <style>
      .ds { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 11pt; }
      .ds-head { display: flex; justify-content: space-between; align-items: flex-start;
                 border-bottom: 3pt solid ${window.WMS_DOC_ACCENT || '#C41230'}; padding-bottom: 8pt; margin-bottom: 10pt; }
      .ds h1 { font-size: 24pt; margin: 0; letter-spacing: 1pt; }
      .ds .co { font-size: 11pt; font-weight: 700; }
      .ds .code { font-family: "Courier New", monospace; font-size: 22pt; font-weight: 800; text-align: right; }
      .ds .bc-big { width: 3.3in; height: .9in; display: block; margin-left: auto; }
      .ds .who { font-size: 20pt; font-weight: 800; margin: 2pt 0 8pt; }
      .ds .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6pt 14pt; margin-bottom: 10pt; }
      .ds .grid span { display: block; font-size: 8pt; font-weight: 700; text-transform: uppercase; color: #444; }
      .ds .grid div { font-size: 13pt; font-weight: 700; }
      .ds table { width: 100%; border-collapse: collapse; margin-top: 6pt; }
      .ds th, .ds td { border: .75pt solid #000; padding: 6pt 6pt; text-align: left; vertical-align: middle; }
      .ds th { background: #e6e6e6; font-size: 9pt; text-transform: uppercase; }
      .ds td { font-size: 12pt; height: 22pt; }
      .ds .num { text-align: right; }
      .ds .chk { width: 70pt; }
      .ds td.bays { font-size: 10pt; font-weight: 700; }
      .ds .box { display: inline-block; width: 14pt; height: 14pt; border: 1.25pt solid #000; vertical-align: middle; }
      .ds .note { border: 1.5pt solid #000; padding: 8pt; margin-top: 10pt; font-size: 12pt; }
      .ds .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 30pt; margin-top: 34pt; }
      .ds .sign div { border-top: 1pt solid #000; padding-top: 3pt; font-size: 9pt; }
      .ds .foot { margin-top: 14pt; font-size: 8pt; color: #555; }
    </style>`;
  const timeStr = t => {
    if (!t) return '';
    const [h, m] = String(t).split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };

  /* Load sheet: what the lift driver takes to the dock. orders: v_order_progress rows */
  function loadSheet(ship, orders, settings, owner) {
    const s = settings || {};
    const lotLbl = lotLabel(s).split(' /')[0];
    const html = sheetCss + `
      <div class="ds">
        <div class="ds-head">
          <div><h1>LOAD SHEET</h1><div class="co">${esc((s.company_name || '').replace(/_/g, ' '))}</div></div>
          <div><div class="code">${esc(ship.shipment_no)}</div><svg class="bc bc-big" data-value="${esc(ship.shipment_no)}" data-h="80"></svg></div>
        </div>
        <div class="who">${esc(ship.ship_to_name || '')}</div>
        ${owner || s.warehouse_code ? `<div style="margin:-4pt 0 8pt">${esc([owner && 'Account ' + owner.code + ' — ' + owner.name, s.warehouse_code && 'Ship from ' + s.warehouse_code].filter(Boolean).join(' · '))}</div>` : ''}
        <div class="grid">
          <div><span>Ship date</span>${esc(fmtDate(ship.ship_date))}</div>
          <div><span>Appointment</span>${esc(timeStr(ship.appt_time) || '-')}</div>
          <div><span>Door</span>${esc(ship.dock_door || '-')}</div>
          <div><span>Carrier</span>${esc(ship.carrier || '-')}</div>
          <div><span>Trailer #</span>${esc(ship.trailer_no || '')}</div>
          <div><span>Destination</span>${esc([ship.ship_to_city, ship.ship_to_state].filter(Boolean).join(', '))}</div>
        </div>
        ${ship.special_instructions ? `<div class="note"><strong>Instructions:</strong> ${esc(ship.special_instructions)}</div>` : ''}
        <table>
          <thead><tr><th>SKU</th><th>Description</th><th>${esc(lotLbl)}</th><th class="num">Pallets</th><th class="num">Qty</th><th>Pick from (oldest first)</th><th class="chk">Loaded</th></tr></thead>
          <tbody>${orders.length ? orders.map(o => `<tr><td><strong>${esc(o.sku)}</strong></td><td>${esc(o.description)}</td>
              <td><strong>${esc(o.lot_number || 'Any')}</strong></td><td class="num">${esc(o.pallets_ordered ?? '')}</td>
              <td class="num">${o.qty_ordered ? esc(fmtQty(o.qty_ordered) + ' ' + o.uom) : ''}</td>
              <td class="bays">${o.bays === undefined ? '' : o.bays ? esc(o.bays) : '<em>none on hand</em>'}</td><td><span class="box"></span> ____</td></tr>`).join('')
            : '<tr><td colspan="7">No order list: load per the paperwork.</td></tr>'}
            ${'<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(Math.max(0, 4 - orders.length))}</tbody>
        </table>
        <div class="sign"><div>Loaded by</div><div>Time finished</div></div>
        <div class="foot">Scan the barcode above in Dock Mode &gt; Load. Printed ${esc(fmtDateTime(new Date()))}</div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.5in;');
  }

  /* Unload sheet: for scheduled inbound trucks */
  function unloadSheet(rcpt, settings, owner, expected = []) {
    const s = settings || {};
    const lotLbl = lotLabel(s).split(' /')[0];
    const html = sheetCss + `
      <div class="ds">
        <div class="ds-head">
          <div><h1>UNLOAD SHEET</h1><div class="co">${esc((s.company_name || '').replace(/_/g, ' '))}</div></div>
          <div><div class="code">${esc(rcpt.receipt_no)}</div><svg class="bc bc-big" data-value="${esc(rcpt.receipt_no)}" data-h="80"></svg></div>
        </div>
        <div class="who">${esc(rcpt.vendor_name || 'Inbound')}</div>
        ${owner || s.warehouse_code ? `<div style="margin:-4pt 0 8pt">${esc([owner && 'Account ' + owner.code + ' — ' + owner.name, s.warehouse_code && 'Warehouse ' + s.warehouse_code].filter(Boolean).join(' · '))}</div>` : ''}
        <div class="grid">
          <div><span>Expected</span>${esc(rcpt.expected_at ? fmtDateTime(rcpt.expected_at) : '-')}</div>
          <div><span>Door</span>${esc(rcpt.dock_door || '-')}</div>
          <div><span>PO #</span>${esc(rcpt.po_number || '-')}</div>
          <div><span>Carrier</span>${esc(rcpt.carrier || '-')}</div>
          <div><span>Trailer #</span>${esc(rcpt.trailer_no || '')}</div>
          <div><span>Inbound BOL / PRO</span>${esc(rcpt.inbound_bol || '')}</div>
        </div>
        ${rcpt.notes ? `<div class="note"><strong>Notes:</strong> ${esc(rcpt.notes)}</div>` : ''}
        <table>
          <thead><tr><th>SKU</th><th>${esc(lotLbl)}</th><th class="num">Pallets</th><th class="num">Qty</th><th>Damage / notes</th></tr></thead>
          <tbody>${expected.map(x => `<tr><td><strong>${esc(x.sku)}</strong>${x.ref ? `<div style="font-size:9pt">${esc(x.ref)}</div>` : ''}</td><td><strong>${esc(x.lot || '')}</strong></td>
            <td class="num">${esc(x.pallets ?? '')}</td><td class="num">${x.qty ? esc(fmtQty(x.qty) + ' ' + (x.uom || '')) : ''}</td><td></td></tr>`).join('')}
            ${'<tr><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(Math.max(2, 8 - expected.length))}</tbody>
        </table>
        <div class="sign"><div>Unloaded by</div><div>Seal # verified / time</div></div>
        <div class="foot">Scan the barcode above in Dock Mode &gt; Unload. Printed ${esc(fmtDateTime(new Date()))}</div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.5in;');
  }

  /* Monthly billing statement (letter). st: wms_billing_statement() result */
  function statement(st, owner, settings, monthLabel) {
    const s = settings || {};
    const company = esc((s.company_name || '').replace(/_/g, ' '));
    const addr = [s.address_line1, s.address_line2, [s.city, s.state].filter(Boolean).join(', ') + (s.zip ? ' ' + s.zip : '')]
      .filter(x => x && x.trim()).map(esc).join('<br>');
    const money = n => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const rate = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    const lines = st.lines || [];
    const showWh = lines.some(l => l.warehouse_code) && new Set(lines.map(l => l.warehouse_code).filter(Boolean)).size > 1;
    const billTo = [owner.name, owner.contact_name ? 'Attn: ' + owner.contact_name : '', owner.billing_address]
      .filter(Boolean).map(x => esc(x).replace(/\n/g, '<br>')).join('<br>');
    const html = `
      <style>
        .st { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 10pt; }
        .st-head { display: flex; justify-content: space-between; align-items: flex-start;
                   border-bottom: 3pt solid ${window.WMS_DOC_ACCENT || '#C41230'}; padding-bottom: 8pt; margin-bottom: 10pt; }
        .st-co { font-size: 16pt; font-weight: 800; }
        .st-title { text-align: right; }
        .st-title h1 { font-size: 18pt; margin: 0; }
        .st-no { font-family: "Courier New", monospace; font-size: 12pt; font-weight: 800; }
        .st-info { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 4pt 16pt; margin-bottom: 12pt; }
        .st-info div span { display: block; font-size: 8pt; font-weight: 700; color: #444; text-transform: uppercase; }
        .st h2 { font-size: 11.5pt; margin: 12pt 0 3pt; border-bottom: 1pt solid #000; }
        .st table { width: 100%; border-collapse: collapse; }
        .st th, .st td { border-bottom: .5pt solid #999; padding: 3pt 4pt; text-align: left; vertical-align: top; }
        .st th { font-size: 8pt; text-transform: uppercase; background: #eee; }
        .st .num { text-align: right; white-space: nowrap; }
        .st .sub td { font-weight: 700; border-bottom: 1pt solid #000; }
        .st-acct { display: flex; gap: 8pt; align-items: baseline; margin: 14pt 0 2pt; padding: 4pt 6pt; background: #111; color: #fff; font-size: 11pt; }
        .st-acct span { font-weight: 800; } .st-acct b { margin-left: auto; }
        .st-total { margin-top: 12pt; display: flex; justify-content: flex-end; }
        .st-total div { border-top: 2pt solid #000; padding-top: 4pt; font-size: 14pt; font-weight: 800; min-width: 2.6in; display: flex; justify-content: space-between; }
        .st-foot { margin-top: 18pt; font-size: 8pt; color: #555; }
      </style>
      <div class="st">
        <div class="st-head">
          <div><div class="st-co">${company}</div><div>${addr}</div>${s.phone ? `<div>${esc(s.phone)}</div>` : ''}</div>
          <div class="st-title"><h1>Warehouse Statement</h1><div class="st-no">${esc(st.statement_no)}</div>
            <div>${esc(monthLabel)}</div>
            ${st.status === 'open' ? '<div style="color:#b3261e;font-weight:800">PRELIMINARY</div>' : ''}</div>
        </div>
        <div class="st-info">
          <div><span>Bill to</span>${billTo}</div>
          <div><span>Account</span>${esc(owner.code)}</div>
          <div><span>Period</span>${esc(monthLabel)}</div>
        </div>
        ${lines.length ? [...new Set(lines.map(l => l.account_code || owner.code))].map(code => {
          const al = lines.filter(l => (l.account_code || owner.code) === code);
          const multi = new Set(lines.map(l => l.account_code || owner.code)).size > 1;
          return (multi ? `<div class="st-acct"><span>${esc(code)}</span> ${esc((al[0] || {}).account_name || '')}<b>${money(al.reduce((a, l) => a + Number(l.amount), 0))}</b></div>` : '')
            + [...new Set(al.map(l => l.category))].map(c => {
          const rows = al.filter(l => l.category === c);
          const sub = rows.reduce((a, l) => a + Number(l.amount), 0);
          return `<h2>${esc(c)}</h2>
          <table style="table-layout:fixed">
            <colgroup><col style="width:${showWh ? 36 : 44}%">${showWh ? '<col style="width:8%">' : ''}<col style="width:14%"><col style="width:10%"><col style="width:9%"><col style="width:11%"><col style="width:12%"></colgroup>
            <thead><tr><th>Description</th>${showWh ? '<th>Whse</th>' : ''}<th>Ref</th><th class="num">Qty</th><th>Unit</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
            <tbody>${rows.map(l => `<tr><td>${esc(l.description)}</td>${showWh ? `<td>${esc(l.warehouse_code || '')}</td>` : ''}
              <td>${esc(l.ref || '')}</td><td class="num">${esc(fmtQty(l.qty))}</td><td>${esc(Number(l.qty) === 1 && l.uom === 'pallets' ? 'pallet' : (l.uom || ''))}</td>
              <td class="num">${rate(l.rate)}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}
              <tr class="sub"><td colspan="${showWh ? 6 : 5}">${esc(c)} subtotal</td><td class="num">${money(sub)}</td></tr></tbody>
          </table>`;
        }).join('');
        }).join('') : '<p>No charges this period.</p>'}
        <div class="st-total"><div><span>Total</span><span>${money(st.total)}</span></div></div>
        <div class="st-foot">Printed ${esc(fmtDateTime(new Date()))}</div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.5in;');
  }

  // QR code as inline SVG (falls back to the plain text if the QR library didn't load)
  function qrSvg(text, px) {
    try {
      const q = window.qrcode(0, 'M');
      q.addData(String(text)); q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    } catch (e) { return `<span class="mono">${esc(text)}</span>`; }
  }

  function docHead(s, title, sub) {
    const company = esc((s.company_name || '').replace(/_/g, ' '));
    return `<div class="tb-head"><div><div class="tb-co">${company}</div><div class="tb-sub">${esc(sub || '')}</div></div>
      <div class="tb-title"><h1>${esc(title)}</h1><div>${esc(fmtDateTime(new Date()))}</div></div></div>`;
  }
  const TB_CSS = () => `
    .tb { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 9pt; }
    .tb-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5pt solid ${window.WMS_DOC_ACCENT || '#C41230'}; padding-bottom: 5pt; margin-bottom: 8pt; }
    .tb-co { font-size: 13pt; font-weight: 800; }
    .tb-sub { font-size: 9pt; color: #333; }
    .tb-title { text-align: right; } .tb-title h1 { font-size: 15pt; margin: 0; }
    .tb table { width: 100%; border-collapse: collapse; }
    .tb th, .tb td { border-bottom: .5pt solid #aaa; padding: 2.5pt 4pt; text-align: left; vertical-align: middle; }
    .tb th { font-size: 7.5pt; text-transform: uppercase; background: #eee; }
    .tb thead { display: table-header-group; }
    .tb tr { page-break-inside: avoid; }
    .tb .num { text-align: right; }
    .tb .mono { font-family: "Courier New", monospace; font-weight: 700; }
    .tb tfoot td { font-weight: 800; border-top: 1.2pt solid #000; }`;

  /* any on-screen table, printed (letter landscape) */
  function table(title, sub, cols, rows, settings) {
    const html = `<style>${TB_CSS()}</style><div class="tb">${docHead(settings || {}, title, sub)}
      <table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((v, i) => `<td class="${cols[i].num ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <div style="margin-top:6pt;font-size:8pt;color:#555">${rows.length} row${rows.length === 1 ? '' : 's'}</div></div>`;
    printDoc(html, 'size: letter landscape; margin: 0.4in;');
  }

  /* one pallet's full record (recall / audit) */
  function palletHistory(H, rows, settings, x) {
    const { p, item, owner, rcpt, ships } = H;
    const kv = pairs => `<table class="kv">${pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
    const html = `<style>${TB_CSS()}
        .ph .kv { width: 100%; border-collapse: collapse; margin: 0; }
        .ph .kv th { text-align: left; width: 34%; font-size: 8pt; color: #444; background: none; border: 0; border-bottom: .5pt solid #ccc; padding: 2pt 4pt; text-transform: none; }
        .ph .kv td { border: 0; border-bottom: .5pt solid #ccc; padding: 2pt 4pt; }
        .ph .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12pt; margin: 6pt 0; }
        .ph h3 { font-size: 10pt; margin: 8pt 0 3pt; text-transform: uppercase; letter-spacing: .5pt; }
        .ph .ship { border: .75pt solid #000; padding: 4pt 6pt; margin-bottom: 4pt; font-size: 9pt; }
      </style>
      <div class="tb ph">${docHead(settings || {}, 'Pallet History — ' + p.lp_id, [item.sku, item.description].filter(Boolean).join(' — '))}
        <div class="two">
          <div><h3>Pallet</h3>${kv([['WMS Pallet ID', p.lp_id], ...x.ids.filter(f => p[f.field]).map(f => [f.label, p[f.field]]),
            ['LWH Control #', p.origin_ref], ['Item', `${item.sku || ''} — ${item.description || ''}`], [x.lotLabel, p.lot_number || '-'],
            ['Account', owner.code ? `${owner.code} — ${owner.name}` : ''], ['Produced', p.production_date ? fmtDate(p.production_date) : ''],
            ['Expires', p.expiration_date ? fmtDate(p.expiration_date) : ''], ['Qty received', `${fmtQty(p.qty_received)} ${item.uom || ''}`],
            ['On hand now', `${fmtQty(p.qty_on_hand)} ${item.uom || ''}`], ['Status', String(p.status).toUpperCase()]])}</div>
          <div><h3>Inbound</h3>${rcpt ? kv([['Receipt', rcpt.receipt_no + (rcpt.is_opening ? ' (opening / transfer)' : '')], ['Received', fmtDateTime(p.created_at)],
            ['Warehouse', x.multiWh ? x.whCode(rcpt.warehouse_id) : ''], ['From / Vendor', rcpt.vendor_name], ['Carrier', rcpt.carrier],
            ['Trailer / Seal', [rcpt.trailer_no, rcpt.seal_no].filter(Boolean).join(' / ')], ['PO #', rcpt.po_number], ['Inbound BOL', rcpt.inbound_bol]]) : '<p>No receipt on file.</p>'}</div>
        </div>
        <h3>Outbound</h3>
        ${ships.length ? ships.map(sh => `<div class="ship"><strong>${esc(sh.shipment_no)}</strong> &middot; ${esc(String(sh.status).toUpperCase())} &middot;
          ${esc(sh.status === 'shipped' ? 'Shipped ' + fmtDateTime(sh.shipped_at) : 'Ship date ' + fmtDate(sh.ship_date))} &middot; ${esc(fmtQty(sh.qty))} ${esc(item.uom || '')}<br>
          <strong>${esc(sh.ship_to_name || '')}</strong> ${esc(x.addr(sh))}<br>
          ${esc([sh.carrier && 'Carrier ' + sh.carrier, sh.trailer_no && 'Trailer ' + sh.trailer_no, sh.seal_no && 'Seal ' + sh.seal_no, sh.pro_number && 'PRO ' + sh.pro_number,
            sh.customer_order_no && 'Order ' + sh.customer_order_no, sh.po_number && 'PO ' + sh.po_number].filter(Boolean).join(' · '))}</div>`).join('') : '<p>Not on any load.</p>'}
        <h3>Every move</h3>
        <table><thead><tr>${['When', 'Event', 'Where', 'Qty', 'After', 'Ref', 'By', 'Reason'].map((c, i) => `<th class="${i === 3 || i === 4 ? 'num' : ''}">${c}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(r => `<tr>${r.map((v, i) => `<td class="${i === 3 || i === 4 ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>
        <div style="margin-top:6pt;font-size:8pt;color:#555">Printed ${esc(fmtDateTime(new Date()))}</div></div>`;
    printDoc(html, 'size: letter portrait; margin: 0.4in;');
  }

  /* cycle count sheet: one block per bay with its QR; expected pallets listed unless blind */
  function countSheet(sess, bays, review, settings, o) {
    const s = settings || {};
    const html = sheetCss + `<style>
        .cc-bay { border: 1.5pt solid #000; padding: 8pt; margin-bottom: 8pt; break-inside: avoid; page-break-inside: avoid; }
        .cc-bay-head { display: flex; justify-content: space-between; align-items: center; }
        .cc-bay-code { font-size: 22pt; font-weight: 800; }
        .cc-bay table td { height: 18pt; font-size: 10pt; }
        .cc-bay svg { width: .8in; height: .8in; }
      </style>
      <div class="ds">
        <div class="ds-head">
          <div><h1>COUNT SHEET</h1><div class="co">${esc((s.company_name || '').replace(/_/g, ' '))}${s.warehouse_code ? ' · ' + esc(s.warehouse_code) : ''}</div></div>
          <div><div class="code">${esc(sess.count_no)}</div><div style="text-align:right">${esc(o.acct ? 'Account ' + o.acct : 'All accounts')} · ${review ? 'expected list' : 'blind count'}</div></div>
        </div>
        <p style="margin:0 0 8pt">Scan every pallet you find in each bay (Dock Mode &gt; Count), or write it below. Note damaged or unlabeled pallets.</p>
        ${bays.map(b => {
          const exp = review ? review.filter(r => r.system_location_id === b.location_id && r.result !== 'unknown') : [];
          return `<div class="cc-bay"><div class="cc-bay-head"><div class="cc-bay-code">${esc(b.loc.code)}</div>${qrSvg(b.loc.code, 80)}</div>
            <table><thead><tr><th>Pallet ID</th><th>SKU</th><th>${esc(o.lot || 'Lot')}</th><th class="num">Qty</th><th>Found?</th></tr></thead>
            <tbody>${exp.map(r => `<tr><td>${esc(r.lp_id || '')}</td><td>${esc(r.sku || '')}</td><td>${esc(r.lot_number || '')}</td><td class="num">${esc(fmtQty(r.system_qty))}</td><td><span class="box"></span></td></tr>`).join('')}
            ${'<tr><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(review ? 2 : 4)}</tbody></table>
            <div style="margin-top:4pt;font-size:9pt">Counted by ________________ &nbsp; Time ________</div></div>`;
        }).join('')}
        <div class="foot">Printed ${esc(fmtDateTime(new Date()))}</div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.5in;');
  }

  /* location / cycle-count report: pallets grouped by location, a QR per pallet */
  function locationReport(pallets, sub, settings) {
    const s = settings || {};
    const ids = idDefs(s).filter(d => pallets.some(p => p[d.field]));
    const locs = [];
    for (const p of pallets) {
      const k = (p.warehouse_code ? p.warehouse_code + ' ' : '') + (p.location || '(no location)');
      if (!locs.length || locs[locs.length - 1].k !== k) locs.push({ k, rows: [] });
      locs[locs.length - 1].rows.push(p);
    }
    const html = `<style>${TB_CSS()}
        .lr-loc { font-size: 12pt; font-weight: 800; margin: 10pt 0 3pt; padding: 3pt 6pt; background: #111; color: #fff; page-break-after: avoid; }
        .lr td.qr { width: 0.62in; padding: 2pt; }
        .lr td.qr svg { display: block; }
        .lr .cnt { width: 0.9in; border-bottom: 1pt solid #000; }
        .lr-sign { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24pt; margin-top: 24pt; }
        .lr-sign div { border-top: 1pt solid #000; padding-top: 2pt; font-size: 8pt; }
      </style>
      <div class="tb lr">${docHead(s, 'Location Report', sub + ' · ' + pallets.length + ' pallets in ' + locs.length + ' location' + (locs.length === 1 ? '' : 's'))}
        ${locs.map(l => `
          <div class="lr-loc">${esc(l.k)} &nbsp;·&nbsp; ${l.rows.length} pallet${l.rows.length === 1 ? '' : 's'}</div>
          <table>
            <thead><tr><th>QR</th><th>WMS Pallet ID</th>${ids.map(d => `<th>${esc(d.label)}</th>`).join('')}<th>SKU</th><th>Description</th>
              <th>${esc(lotLabel(s))}</th><th class="num">Qty</th><th>UOM</th><th>Counted</th></tr></thead>
            <tbody>${l.rows.map(p => `<tr>
              <td class="qr">${qrSvg(p.lp_id, 44)}</td><td class="mono">${esc(p.lp_id)}${p.status === 'hold' ? ' <b>HOLD</b>' : ''}</td>
              ${ids.map(d => `<td>${esc(p[d.field] || '')}</td>`).join('')}<td>${esc(p.sku)}</td><td>${esc(p.description || '')}</td>
              <td>${esc(p.lot_number || '')}</td><td class="num">${esc(fmtQty(p.qty_on_hand))}</td><td>${esc(p.uom || '')}</td><td class="cnt"></td></tr>`).join('')}</tbody>
          </table>`).join('')}
        <div class="lr-sign"><div>Counted by</div><div>Date / time</div><div>Verified by</div></div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.4in;');
  }

  return { labels, receipt, bol, loadSheet, unloadSheet, statement, table, locationReport, palletHistory, countSheet };
})();
