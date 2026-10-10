# LWH Warehouse (Lite WMS)

Mobile-first warehouse app operated under Logistics Warehouse, Inc. Static PWA (no build step) on
GitHub Pages, backed by the **Offsite WMS** Supabase project.

**v1.8.0 load import** (migration 018): Receiving / Shipping > Import Loads.
- **What it does:** drop in the customer's schedule sheet (.xlsx, .csv or
  pasted rows).
  - **Inbound:** each BOL becomes an open receipt (account, warehouse,
    appointment, shipper, carrier, BOL #) with its expected lines (item, lot,
    pallets, qty, and an identifier such as PGID).
  - **Outbound:** each order # becomes a shipment with order lines.
- **Column setup:** first-time guesses come from the headers; warehouse values
  like "3333 S Zero Street" are matched to a warehouse; save the setup per
  customer.
- **Duplicates:** BOL / order #s already in the system are skipped.
- **Receiving:** the receipt shows "Expected on this load" with progress. The
  receive form is pre-filled from the next unfinished line (item, lot, qty per
  pallet, PGID), so the dock just scans each pallet label. The unload sheet
  prints the expected lines.

**v1.7.0 photos, bay map, cycle counts** (migration 017):
- **Load photos:** "Add Photo" on receipts, shipments and the Dock Mode
  load/unload screens.
  - **Taking them:** the phone camera opens, you tag each photo Damage / Seal /
    Loaded trailer / Product / Other, and it's shrunk to about 100-250 KB before
    upload.
  - **Storage:** files go in a private `load-photos` storage bucket.
  - **Viewing:** customers see their own loads' photos in the portal; Pallet
    History shows photos from the loads a pallet was on. Tap a photo to add a
    note; managers (or whoever took it, within an hour) can delete.
- **Bay Map:** every bay as a tile, grouped by zone or code prefix, shaded by
  Fullness (needs capacity), Age of the oldest pallet, or pallet count.
  - **Bay detail:** tap a bay for its pallets.
  - **Account highlight:** the account filter highlights one customer's bays.
  - **Capacity setup:** Setup > Locations: "most bays hold N" per warehouse, a
    bulk "bays starting with MR hold 2", or per bay.
- **Cycle counts:**
  1. **Start (manager):** Cycle Counts > New Count: pick aisles/zones or type
     bays, optionally one account, blind or not.
  2. **Count sheet:** print it (one block per bay with a QR).
  3. **Scan (dock):** Dock Mode > Count: pick a bay, scan every pallet (qty if
     partial), then "Bay Counted".
  4. **Review:** the manager sees Match / In a different bay / Qty differs /
     Not found / Label not in system.
  5. **Approve:** checked fixes are posted as moves and adjustments with reason
     "Cycle count CC-####", and the count's results are kept.

**v1.6.0 customer portal + automatic emails** (migration 016, admin-users function update):
- **Customer logins:** Setup > Users > role "customer" + the account. They
  sign in at the same address and see only that account (a bill-to master
  also sees its subs):
  - **What they get:** dashboard, inventory, lookup, Pallet History, receipts,
    shipments/BOLs, schedule, lot trace and exports.
  - **Read-only, enforced by the database** (customer-only read policies; staff
    policies never apply to them).
- **Emails** (Setup > Accounts > edit): "Email to" addresses plus switches for
  BOL when a load ships, receipt when one closes, and a daily inventory each
  morning (with a CSV of every pallet).
  - **Extra buttons:** "Send test email", a recent-email log, and
    Email BOL / Email Receipt buttons on shipped loads and closed receipts.
  - **How they're sent:** emails queue in `email_outbox`. The Google Apps
    Script in `tools/email-sender/Code.gs` sends them every 5 minutes and queues
    the daily inventory at 6 AM (setup steps are at the top of that file).

**v1.5.1 full history export** (Reports, managers): one Excel workbook with
every pallet (any status), every transaction, receipts, shipments and their
pallets, charges, rates, items, accounts, locations and ship-tos, plus an About
sheet with row counts. Meant as a monthly off-site copy of the records.

**v1.5.0 pallet history + warehouse-aware accounts:**
- **Pallet History** (Reports, or `#/history`): find any pallet by any ID, even
  shipped or voided, for its full record:
  - **Inbound:** the receipt with vendor, carrier, trailer/seal, PO and inbound
    BOL.
  - **Every move:** each bay move, hold, adjustment and void, with who and why.
  - **Outbound:** each load it went on, with ship-to, carrier, trailer, seal,
    PRO and order #.
  - **Output:** printable and exportable.
- **Linked from:** Inventory Lookup shows past pallets when nothing in stock
  matches, the pallet card has "Full pallet history", and pallet IDs in on-screen
  reports link to it.
- **Retention:** nothing is ever deleted (the ledger is append-only and voids
  are kept), so records stay for as long as the database does.
- **Accounts by warehouse:** switching warehouses (or signing in) moves a
  remembered account filter that has no stock there to the account with the most
  pallets there. Account dropdowns list who has stock here first, with a pallet
  count.

**v1.4.1 picking help:**
- **Adding a product to a load** shows pallets available per item (in the
  dropdown) and, once picked, a table by lot with qty and bays. Tap a lot to
  use it.
- **Pick from:** order lines (office, Dock Mode and the printed Load Sheet)
  list the bays to pull from, oldest pallets first.
- **BOL pallet detail** is grouped by item with an Item Total row, like the
  LWH BOL.
- **Charge picker** shows each charge type's code (e.g. "59 — Manual inbound").
  A receipt can be closed with no pallets, so drop-offs that never hit inventory
  just carry their charges.

**v1.4.0 identifiers per account** (migration 015):
- **Setup:** Setup > Accounts > edit > Pallet identifiers > "Custom for this
  account" gives that account its own names and Required / Unique / Barcode
  rules for Customer Pallet ID and Unique2–8.
- **Lookup order:** the account's own setup, then its bill-to master's, then
  Setup > Company.
- **Where it applies:** receiving, labels, receipts, BOLs, pallet details and
  imports. Mixed lists and exports show combined names (e.g. "PGID / Serial").
- **Unique identifiers** are now checked within the account.
- **LWH import:** also reads ItemDesc (creates items with real descriptions)
  and ReceivedDate.

**v1.3.0 lines up with the LWH WMS:**
- **8 pallet identifiers**, matching LWH's Comments + Unique2–Unique8.
  - **Mapping:** Customer Pallet ID = Comments, identifiers 2–8 = Unique2–8.
  - **Setup:** name each one in Setup > Company (4–8 are tucked under
    "Identifiers 4–8"). Each can be required, unique, and/or a barcode on the
    label. Unnamed ones stay hidden.
  - **Labels:** with many identifiers, labels switch to a compact two-column
    list.
  - **Search:** all identifiers can be scanned and searched.
- **LWH WMS transfer import** (Setup > Import): paste the LWH inventory query
  (ControlNumber … CurrentBay) straight from SQL Server.
  - **Mapping:** SubCustNm = account, ItemNm = SKU, LotNum, Qty, CurrentBay =
    location (in the selected warehouse), ControlNumber kept as "LWH Control #".
  - **Handled for you:** NULL cells are read as blank, Still_In_Inventory = No
    rows are skipped, and missing items and locations can be created.
  - **No double loads:** a control number that's already here is refused.
  - **Billing:** pallets load like opening inventory (no inbound charges).
- **Export LWH format** (Inventory screen, managers): the filtered pallets in
  the same LWH columns, plus our WMS pallet ID, for moving product back.

**v1.2.0 added subcustomers and load parties:**
- **Master bill-to accounts** (Setup > Accounts > Bills to):
  - **Subcustomers:** a plant or location bills to a master account. Each
    plant keeps its own items, inventory, receipts and shipments.
  - **Statements:** the master gets one statement, with a section per plant.
    Billing lists masters only, and a month closes for the master and all its
    plants together.
  - **Rates:** plants use the master's rates unless they have their own (shown
    in gray in Rates). Monthly space and flat fees are never copied. The
    master's accessorial prices fill in plant charges.
- **Shipper / Consignee / Bill-to** show on every receipt and shipment, and the
  bill-to prints on receipts and BOLs. A BOL's Ship From reads "*Customer*, c/o
  *warehouse*".
- **Carrier arranged by:** Customer (pickup / their own carrier, the default,
  freight collect) or Logistics Warehouse (prepaid). On our trucks the load
  prompts for a **Freight** charge, which bills to the master.
- **Modern theme:** darker card outlines.

**v1.1.0 added:**
- **Spreadsheet import** (Setup > Import, managers): items, ship-to & vendors,
  accounts, locations, and **opening inventory**.
  - **Input:** a CSV or Excel file, or rows pasted straight from Excel or Google
    Sheets.
  - **Templates:** downloadable, using your own field names (BIN Class, Pallet
    ID, PGID).
  - **Check before saving:** a preview flags every bad row with the reason.
    Bad rows can be downloaded to fix. Matching records update when "Update
    existing" is checked.
  - **Opening inventory:** loads the pallets already in the building onto a
    closed "OPENING INVENTORY" receipt. Pallets keep their original received
    dates, missing locations can be created, and none of it bills as inbound
    (no handling-in, arrival storage or receiving fee). Those pallets bill
    storage on the 1st like any other.
- **Schedule lanes:** Inbound and Outbound show as separate lanes in the Day and
  Week views. "Together" switches back to the combined view.
- **Theme choice** (Setup > Company > Look, admins):
  - **LWH:** the red header.
  - **Modern:** bright white, sharp lines, one accent color (default teal
    #00667D) that also colors the line on printed documents.
  - **Readability:** thin type is used only on desktop. Phones and Dock Mode
    keep bold text and solid buttons for sunlight.

**v1.0.0 added:**
- **Inventory screen** (menu > Inventory):
  - Filter by search words, location/bay, account, and on hand/hold.
  - **Search:** every word must match, so `1234 10-08/26` finds item 1234 *and*
    that lot.
  - **Location / bay:** matches the start of the code, so `A01` finds A01-1,
    A01-2, ...
  - **Views:** each pallet, or totals per item and lot (click a line to see its
    pallets). Click a column header to sort.
  - **Output:** Export CSV, Print List, and **Location Report (QR)**, a count
    sheet grouped by location with a QR code per pallet. Scan a QR in Lookup or
    Dock Move.
- **New reports** (Reports page), each on screen with Export and Print:
  - **Lot trace / recall:** where every pallet of a lot came from and went.
  - **Inventory as of a date:** on hand at the end of any day.
  - **Adjustments & voids:** every quantity change, hold and void, with the
    reason and who did it.
- **Header clock and weather** on desktop. Weather is for the selected
  warehouse's town (its address in Setup > Warehouses, else the company
  address), from Open-Meteo, refreshed every 20 minutes.
- **Exports page through all rows**, so large files are no longer cut off at
  1,000 rows.

**v0.9.0 added a dashboard and desktop layout:**
- **Dashboard home:**
  - Headline numbers: pallets on hand, SKUs, received/shipped in the last 30
    days, open loads, today's trucks, and billing month-to-date (managers).
  - Charts: a 30-day in-vs-out line, pallets by account, and inventory age.
  - Tables: by account and top items.
  - Filters: one account, and all warehouses. Click an account row to focus on
    it.
- **Desktop layout:** on screens 1100px and wider, office users get a left menu,
  full-width pages, and receipts/shipments as tables (click a row to open it).
  Phones and Dock Mode keep the big-button layout.

**v0.8.0 added billing:**
- **Rates per customer account:** handling in/out per pallet or unit, per-load
  fees, storage on arrival and again on the 1st, contract square footage, a flat
  monthly fee, and the account's own price for each extra charge.
- **Extra charges** (admin, special handling, after hours, labor, and any you
  add) on a receipt, a shipment, or the account itself.
- **Monthly statement** for each account. It's live while the month is open,
  and you can print it, export it to CSV, or export a pallet-level backup.
  **Close Month** freezes it; an admin can reopen it.

**v0.7.0 added:**
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

> **Database:** migrations 001–018 and the `admin-users` Edge Function, all
> applied to Offsite WMS.

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
| operator | Office: create and edit receipts and shipments, order lines, receive, load, move, close receipts, ship, add extra charges |
| manager | + setup (items, locations, accounts, warehouses), billing (rates, statements, close month, remove charges), adjust qty, hold/release, reopen/void receipts, void any unshipped pallet |
| admin | + company info, reopen a closed billing month |

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

## Billing

**Home > Billing** (managers and admins). Pick a month to see every account's
total, then tap an account for its statement.

**Rates** (on any statement, tap **Rates**). Leave a box blank if the contract
doesn't charge it:

| Rate | Billed |
|---|---|
| Inbound per pallet / per unit | When each pallet is received |
| Outbound per pallet / per unit | When the shipment ships. Leave blank for contracts that pay in+out up front on inbound. |
| Per inbound / outbound load | Once per receipt (the month its first pallet arrived) / per shipment shipped |
| Storage on arrival, per pallet / unit | In the month the pallet arrives, whatever the day |
| Storage on the 1st, per pallet / unit | Everything on hand at 12:00 AM on the 1st, including pallets on hold |
| Contract space (sq ft x rate) | Every month, fixed by contract |
| Flat monthly fee | Every month |
| Accessorial prices | This account's price for each charge type, overriding the standard rate |

**Extra charges:**
- **Where:** office staff (operators and up, not lift drivers) tap **Add
  Charge** on a receipt or shipment. Managers can also add them from the
  statement.
- **Price:** the account's own rate fills in; it can be changed for that one
  charge.
- **Removing:** managers can remove a charge while its month is open.
- **Charge types** (Billing > Charge Types): add your own, e.g. Lumper, Shrink
  wrap, Re-label, with a standard rate and unit.

**Month end:**
1. Open last month's statement and review it. **Pallet Detail CSV** lists every
   pallet behind the numbers: on hand on the 1st, in, and out.
2. Tap **Print Statement** (or Save as PDF) and/or **Export CSV**.
3. Tap **Close Month**. The statement is frozen as billed, and charges for that
   month are locked. A month can only be closed after it ends.
4. If something was missed, an admin taps **Reopen Month**, fixes it, and
   closes it again.

**Rules to know:**
- **Time zone:** months run midnight to midnight, Central time
  (`settings.timezone`).
- **Voids:** a voided pallet is never billed. Voiding after a month is closed
  doesn't change that month's frozen statement.
- **Accounts:** charges follow the account of the receipt or shipment, so each
  customer only sees their own loads.

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
