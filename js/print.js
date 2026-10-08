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

  return { labels, receipt };
})();
