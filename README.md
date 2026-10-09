# LWH Warehouse (Lite WMS)

Mobile-first warehouse app operated under Logistics Warehouse, Inc. Static PWA (no build step) on
GitHub Pages, backed by the **Offsite WMS** Supabase project.

**v0.7.0 adds:**
- **Multiple warehouses** (Setup > Warehouses): WHSE1, WHSE2, and so on. Each
  building has its own locations, receipts, shipments, schedule and paperwork
  address. Switch buildings from the selector in the red header.
- **Customer accounts** (Setup > Accounts): whose product it is. Every item,
  receipt and shipment belongs to one account. The same SKU can exist under two
  accounts.
- **Transfers:** moving a pallet to a location in the other building is logged
  as a transfer. Dock Mode > Move has a "To warehouse" picker.
- **Guards:** a load refuses pallets from another account or another building
  (WRONG PALLET).
- **Reports** gain Warehouse and Account columns and cover all buildings.

**Earlier releases include:**
- **Users screen** (Setup > Users): admins and managers create logins (simple
  usernames for dock staff), change roles, deactivate, and reset passwords.
- **Reports:** Excel-ready exports of inventory, received, shipped, and all
  transactions.
- **Identifier barcodes** on pallet labels (per field, Setup > Company).
- **Schedule:** a daily and weekly calendar of inbound and outbound loads, with
  late flags. It refreshes every minute.
- **LWH branding** in the app header, name, and icon.
- **Sign-in** with roles, including a **lift** role that only sees Dock Mode.
- **Dock Mode:** big-button Load, Unload, Move, and Lookup screens for the
  floor.
- **Office/dock split:** order lines with wrong-pallet blocking, scheduled
  receipts, and printed load and unload sheets.
- **Receiving:** receipts, pallets, 4x6 labels, printed receipt.
- **Shipping:** scan or pick pallets, partial pallets, ship, BOL.
- **Inventory lookup:** scan or search, move, adjust, hold.
- **Setup:** items, locations, accounts, ship-to & vendors, warehouses,
  users, company info, pallet identifiers.

> **Database:** migrations 001–008 and the `admin-users` Edge Function.
> **v0.7 needs migration 008** (`supabase/migrations/008_warehouses_accounts.sql`)
> run before the new app files go live.

## Files

| Path | What it is |
|---|---|
| `index.html` | App shell |
| `js/config.js` | Supabase URL + publishable key |
| `js/app.js` | Screens and logic |
| `js/print.js` | Pallet labels and receiving receipt |
| `css/app.css` | Styles (red header, black accents) |
| `sw.js` | Service worker. **Bump `CACHE` on every release.** |
| `supabase/migrations/` | Database schema (run in order in the SQL Editor) |

## Deploy (GitHub Pages)

1. Push this folder to a GitHub repo.
2. In the repo's Settings > Pages, set the source to the `main` branch, root folder.
3. In Supabase, open Authentication > URL Configuration:
   - Set **Site URL** to the Pages URL.
   - Add the Pages URL to **Redirect URLs**.

   Password-reset emails won't work without this step.

## Users

**Setup > Users**, for admins and managers:
- **Add User:** name, a **username** (e.g. `mike.dock`) or an email, a role,
  and a temporary password. The login and password are shown once to hand to
  the person.
- **Usernames:** these sign in as typed. In the background they map to
  `username@wms.logistics-warehouse.com`; no email is ever sent.
- **Edit:** change the name or role, **deactivate** (blocks sign-in at once), or
  reactivate.
- **Reset password:** sets a new password for that person.

Who can do what:
- **Admins** manage everyone.
- **Managers** manage operator, lift, and viewer logins only.
- **Nobody** can change their own role or deactivate themselves.

All of this runs through the `admin-users` Edge Function
(`supabase/functions/admin-users`). It uses the project's secret key
server-side and checks the caller on every request. The rules live in
`users-core.js`.

| Role | Can |
|---|---|
| viewer | Look up inventory, view receipts and shipments |
| lift | **Dock Mode only:** receive onto open receipts, load pallets onto open shipments, move pallets, mark loads loaded/unloaded. Cannot create or edit receipt/shipment details, close receipts, or ship. |
| operator | Office: create and edit receipts and shipments, order lines, receive, load, move, close receipts, ship |
| manager | + setup (items, locations), adjust qty, hold/release, reopen/void receipts, void any unshipped pallet |
| admin | + company info |

## Warehouses and accounts

**Warehouses** (Setup > Warehouses, managers):
- Existing data was moved into **WHSE1 — Main Warehouse** (address copied from
  Company).
- **Add Warehouse** creates the building with DOCK, FLOOR and HOLD. Add its
  racks under Setup > Locations while that warehouse is selected. Location
  codes only need to be unique within a building.
- **The header selector** sets which building you're working in. Each phone
  remembers its last choice, and it follows the user to other devices.
- **Lookup** shows the current building, with an **All warehouses** checkbox.
- **Paperwork** (BOL, receipt, labels, sheets) prints that building's address
  as the ship-from when it has one, and the warehouse code on labels.
- Any lift driver can work in any building by switching the header.

**Accounts** (Setup > Accounts, managers):
- Existing items, receipts and shipments were put under **MAIN — Main
  Account**. Rename it to the real customer.
- With more than one account, new items, receipts and shipments ask which
  account. Receipts only list that account's items.
- The account and warehouse lock once a receipt has pallets or a shipment has
  pallets or order lines.

## Pallet identifiers

Every pallet gets a **WMS Pallet ID** (e.g. LWH000123), plus up to four
identifiers you name in **Setup > Company > Pallet Identifiers**:

| Field | Default name | Example (One Source style) | Rules |
|---|---|---|---|
| Lot | Lot / Production # | BIN Class (714) | Required or optional per item |
| Customer pallet ID | Customer Pallet ID | Pallet ID | Always unique; can be required |
| Extra identifier 1 | *(hidden)* | PGID | Optional, required, and/or unique |
| Extra identifier 2 | *(hidden)* | *(hidden)* | Optional, required, and/or unique |

- **Visible fields:** an extra identifier only appears once it has a name.
- **Unique values:** no two active pallets can share one. A voided pallet frees
  its value.
- **Scanning:** all identifiers are scannable, print on labels and receipts, and
  work in Lookup.
- **Handheld scanners:** scan into the first identifier and each Enter moves to
  the next field. The last Enter receives the pallet.

## Schedule

**Home > Schedule** (and **Dock > Schedule**) shows every truck by day or week:
- **Inbound:** receipts at their **Expected arrival**, or their received time
  for walk-ins.
- **Outbound:** shipments at **Ship date + Appointment**.

| Color | Meaning |
|---|---|
| Gray | Scheduled |
| Amber | In progress (unloading / loading) |
| Green | Unloaded / Loaded, waiting on the office |
| Dark | Done (closed / shipped) |
| Red | Late (past its time with nothing started) |

Tapping an entry opens it. Office users go to the receipt or shipment, and lift
users go straight to the Dock screen. Filter by In/Out. The page refreshes every
minute, so it works as a wall display on a dock TV.

## Reports

**Home > Reports** downloads CSV files that open in Excel. Column headers use
the customer's field names (BIN Class, Pallet ID, PGID, ...).
- **Inventory on hand:** by pallet, or by item and lot.
- **Received pallets** (date range): one row per pallet, with receipt #,
  vendor, carrier, and PO.
- **Shipped pallets** (date range): one row per pallet, with BOL #, ship-to,
  PRO, order #, and weight.
- **All transactions** (date range): the full audit trail.

## Branding

- **App frame:** the header mark and app name come from `BRAND_SHORT` /
  `BRAND_NAME` in `js/config.js`. The icons are in `icons/`.
- **Printed documents:** labels, receipts, BOLs, and sheets use **Setup >
  Company** (name, address, phone).
- **Pallet ID prefix:** set in Setup > Company. It can be changed until real
  (non-voided) pallets exist.

## Office and dock workflow

**Outbound:**
1. **Office:** create the shipment (customer, appointment, door, carrier).
2. **Office:** add **order lines**, e.g. "WID-100, BIN Class 714, 2 pallets"
   or "BOX-5, any, 100 EA". Print the **load sheet**.
3. **Lift (Dock Mode > Load):** scan the load sheet barcode, then scan pallets.
   - **Wrong pallets** (item or lot not on the order, or a line already full)
     are refused with a red WRONG PALLET screen.
   - **Qty lines** only take what's needed from a pallet, and the rest stays on
     it.
4. **Lift:** tap **Done Loading**. The load shows **Loaded** in the office.
5. **Office:** review, add the seal #, **Ship**, and print the BOL.

**Inbound:**
1. **Office:** create the receipt with an **expected arrival** and door, then
   print the **unload sheet**.
2. **Lift (Dock Mode > Unload):** scan the unload sheet barcode, receive pallets
   (labels print as usual), then tap **Done Unloading**. The arrival time is
   stamped at the first pallet.
3. **Office:** review and **Close Receipt**.

A load with no order lines accepts any in-stock pallet, the same as v0.3.
Office users can open Dock Mode too, from its tile on the home screen.

## Shipping

1. **New Shipment:** pick a saved customer to fill the ship-to and special
   instructions, then set the date, appointment time, carrier, and freight terms.
2. **Load pallets:** scan any pallet identifier (WMS, customer, or extra) to add
   the whole pallet. Enter a qty first for a partial pallet. **Pick by item**
   lists available pallets oldest first.
3. **Print BOL:** page 1 is a straight bill of lading with weight, NMFC, and
   class per item. Page 2 is the pallet detail.
4. **Ship:** removes the inventory and locks the shipment. Partial pallets keep
   their remainder in the same location.

**How the BOL is filled in:**
- **Weight:** qty times the item's unit weight, plus the empty pallet weight
  (Setup > Company) for each pallet. Items with no weight show a warning.
- **NMFC and class:** taken from each item (Setup > Items).

**Voiding** a shipment (managers) releases the pallets if it's open, or puts
everything back into inventory if it already shipped.

## Ship-to & vendors

**Setup > Ship-To** stores vendors (ship-from) and customers (ship-to). Saved
vendors, and any vendor names typed on past receipts, are suggested on new
receipts. Customers will fill in the ship-to on shipments and BOLs.

## Printing

- **Labels:** 4x6 inches, one pallet per page. Set the label printer's paper
  size to 4x6 and scale to 100% (turn off "fit to page"). Each label carries
  Code 128 barcodes for the WMS pallet ID and the lot. You can add barcodes for
  the customer pallet ID and the extra identifiers under **Setup > Company >
  Barcode on label**.
- **Receipts:** letter size. Use "Save as PDF" in the print dialog to email one.

## Scanning

- **Handheld scanners in keyboard mode** scan straight into any field.
- **The Scan button** uses the phone camera. The site must be on HTTPS (GitHub
  Pages is) and the user must allow camera access.
- **Lookup** accepts our pallet ID (LWH000123), a customer pallet ID, a SKU, a
  lot, or a description.

## How inventory stays correct

Inventory lives in an append-only ledger (`inventory_transactions`). Pallet
quantities and locations are maintained from that ledger by the database.
Every change goes through a `wms_*` function that checks the user's role and
locks the pallet. Nobody can edit quantities directly, and every void or
adjustment requires a reason that stays in the history.

Useful queries:

```sql
select * from v_inventory_by_lot order by sku, lot_number;   -- on hand by item/lot
select * from v_inventory where warehouse_code = 'WHSE2';     -- pallet level, one building
select * from v_transactions order by id desc limit 100;      -- recent activity
```
