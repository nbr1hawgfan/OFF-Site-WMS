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
    const out = [{ field: 'customer_pallet_id', label: st.cust_pallet_label || 'Customer Pallet ID' }];
    if (st.ref1_label) out.push({ field: 'ref1', label: st.ref1_label });
    if (st.ref2_label) out.push({ field: 'ref2', label: st.ref2_label });
    return out;
  }
  const lotLabel = st => (st && st.lot_label) || 'Lot / Production #';

  /* pallets: [{ lp_id, customer_pallet_id, ref1, ref2, lot_number, qty, uom, sku, description,
                 production_date, expiration_date, received_at, receipt_no }] */
  function labels(pallets, settings, copies = 1) {
    const company = esc((settings?.company_name || '').replace(/_/g, ' '));
    const ids = idDefs(settings);
    const one = p => `
      <section class="lbl">
        <div class="lbl-top"><span>${company}</span><span>${esc(fmtDate(p.received_at))}</span></div>
        <div class="lbl-caption">WMS PALLET ID</div>
        <div class="lbl-lp">${esc(p.lp_id)}</div>
        <svg class="bc lbl-bc" data-value="${esc(p.lp_id)}" data-h="90"></svg>
        <div class="lbl-sku">${esc(p.sku)}</div>
        <div class="lbl-desc">${esc(p.description)}</div>
        <div class="lbl-grid">
          <div><div class="lbl-caption">${esc(lotLabel(settings).toUpperCase())}</div><div class="lbl-val">${esc(p.lot_number || '-')}</div></div>
          <div class="right"><div class="lbl-caption">QTY</div><div class="lbl-val big">${esc(fmtQty(p.qty))} <small>${esc(p.uom)}</small></div></div>
        </div>
        ${p.lot_number ? `<svg class="bc lbl-bc-sm" data-value="${esc(p.lot_number)}" data-h="40"></svg>` : ''}
        ${ids.filter(d => p[d.field]).map(d =>
          `<div class="lbl-cust"><span class="lbl-caption">${esc(d.label.toUpperCase())}</span> ${esc(p[d.field])}</div>`).join('')}
        ${(p.production_date || p.expiration_date) ? `<div class="lbl-dates">
            ${p.production_date ? `Prod: ${esc(fmtDate(p.production_date))}` : ''}
            ${p.expiration_date ? `&nbsp;&nbsp;Exp: ${esc(fmtDate(p.expiration_date))}` : ''}</div>` : ''}
        <div class="lbl-foot">Receipt ${esc(p.receipt_no || '')}</div>
      </section>`;

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
        .lbl-dates { font-size: 11pt; margin-top: 3pt; }
        .lbl-foot { font-size: 10pt; margin-top: 5pt; border-top: 1pt solid #000; padding-top: 3pt; }
      </style>`;
    printDoc(css + html, 'size: 4in 6in; margin: 0;');
  }

  /* receipt: header row; pallets: active pallets with sku/description/uom */
  function receipt(rcpt, pallets, settings) {
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
                   border-bottom: 3pt solid #C41230; padding-bottom: 8pt; margin-bottom: 10pt; }
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
  function bol(ship, lines, settings) {
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

    const html = `
      <style>
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
            <td style="width:50%"><span class="cap">Ship From</span><span class="big">${company}</span><br>${fromAddr}${s.phone ? '<br>' + esc(s.phone) : ''}</td>
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
              ${box(ship.freight_terms === 'prepaid')} Prepaid &nbsp; ${box(ship.freight_terms === 'collect')} Collect &nbsp; ${box(ship.freight_terms === 'third_party')} 3rd Party</td>
          </tr>
          <tr><td colspan="2"><span class="cap">Special Instructions</span>${esc(ship.special_instructions || '')}</td></tr>
        </table>

        <table class="sec">
          <thead><tr><th>Customer Order #</th><th class="num"># Pkgs</th><th class="num">Weight (lbs)</th><th class="center">Pallet/Slip</th><th>Additional Shipper Info</th></tr></thead>
          <tbody><tr><td>${esc(ship.customer_order_no || '')}</td><td class="num">${esc(totQty)}</td><td class="num">${esc(wt(totWeight))}</td>
            <td class="center">${totHU ? 'Y' : 'N'}</td><td>${ship.po_number ? 'PO ' + esc(ship.po_number) : ''}</td></tr></tbody>
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
            <tbody>${lines.map(l => `<tr><td class="mono">${esc(l.lp_id)}</td>${ids.map(d => `<td>${esc(l[d.field] || '')}</td>`).join('')}
              <td>${esc(l.sku)}</td><td>${esc(l.lot_number || '')}</td><td class="num">${esc(fmtQty(l.qty))}</td><td>${esc(l.uom)}</td></tr>`).join('')}</tbody>
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
                 border-bottom: 3pt solid #C41230; padding-bottom: 8pt; margin-bottom: 10pt; }
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
  function loadSheet(ship, orders, settings) {
    const s = settings || {};
    const lotLbl = lotLabel(s).split(' /')[0];
    const html = sheetCss + `
      <div class="ds">
        <div class="ds-head">
          <div><h1>LOAD SHEET</h1><div class="co">${esc((s.company_name || '').replace(/_/g, ' '))}</div></div>
          <div><div class="code">${esc(ship.shipment_no)}</div><svg class="bc bc-big" data-value="${esc(ship.shipment_no)}" data-h="80"></svg></div>
        </div>
        <div class="who">${esc(ship.ship_to_name || '')}</div>
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
          <thead><tr><th>SKU</th><th>Description</th><th>${esc(lotLbl)}</th><th class="num">Pallets</th><th class="num">Qty</th><th class="chk">Loaded</th></tr></thead>
          <tbody>${orders.length ? orders.map(o => `<tr><td><strong>${esc(o.sku)}</strong></td><td>${esc(o.description)}</td>
              <td><strong>${esc(o.lot_number || 'Any')}</strong></td><td class="num">${esc(o.pallets_ordered ?? '')}</td>
              <td class="num">${o.qty_ordered ? esc(fmtQty(o.qty_ordered) + ' ' + o.uom) : ''}</td><td><span class="box"></span> ____</td></tr>`).join('')
            : '<tr><td colspan="6">No order list: load per the paperwork.</td></tr>'}
            ${'<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(Math.max(0, 4 - orders.length))}</tbody>
        </table>
        <div class="sign"><div>Loaded by</div><div>Time finished</div></div>
        <div class="foot">Scan the barcode above in Dock Mode &gt; Load. Printed ${esc(fmtDateTime(new Date()))}</div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.5in;');
  }

  /* Unload sheet: for scheduled inbound trucks */
  function unloadSheet(rcpt, settings) {
    const s = settings || {};
    const lotLbl = lotLabel(s).split(' /')[0];
    const html = sheetCss + `
      <div class="ds">
        <div class="ds-head">
          <div><h1>UNLOAD SHEET</h1><div class="co">${esc((s.company_name || '').replace(/_/g, ' '))}</div></div>
          <div><div class="code">${esc(rcpt.receipt_no)}</div><svg class="bc bc-big" data-value="${esc(rcpt.receipt_no)}" data-h="80"></svg></div>
        </div>
        <div class="who">${esc(rcpt.vendor_name || 'Inbound')}</div>
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
          <tbody>${'<tr><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(8)}</tbody>
        </table>
        <div class="sign"><div>Unloaded by</div><div>Seal # verified / time</div></div>
        <div class="foot">Scan the barcode above in Dock Mode &gt; Unload. Printed ${esc(fmtDateTime(new Date()))}</div>
      </div>`;
    printDoc(html, 'size: letter portrait; margin: 0.5in;');
  }

  return { labels, receipt, bol, loadSheet, unloadSheet };
})();
