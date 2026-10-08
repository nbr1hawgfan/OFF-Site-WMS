# RMB Warehouse (Lite WMS)

Mobile-first warehouse app for RMB Logistics. Static PWA (no build step) on
GitHub Pages, backed by the **Offsite WMS** Supabase project.

**v0.1.0 includes:** sign-in, receiving (receipts, pallets, 4x6 labels, printed
receipt), inventory lookup (scan or search, move, adjust, hold), and setup
(items, locations, company info).
**Coming next:** shipping and BOLs.

## Files

| Path | What it is |
|---|---|
| `index.html` | App shell |
| `js/config.js` | Supabase URL + publishable key |
| `js/app.js` | Screens and logic |
| `js/print.js` | Pallet labels and receiving receipt |
| `css/app.css` | Styles (red header, black accents) |
| `sw.js` | Service worker. **Bump `CACHE` on every release.** |
| `supabase/migrations/` | Database schema, already applied to Offsite WMS |

## Deploy (GitHub Pages)

1. Push this folder to a GitHub repo.
2. In the repo's Settings > Pages, set the source to the `main` branch, root folder.
3. In Supabase, open Authentication > URL Configuration:
   - Set **Site URL** to the Pages URL.
   - Add the Pages URL to **Redirect URLs**.

   Password-reset emails won't work without this step.

## Adding a user

1. In Supabase, open Authentication > Users > Add user > Create new user. Enter
   their email and a temporary password, and check **Auto Confirm User**.
2. Run this in the SQL Editor:

```sql
insert into public.app_users (id, full_name, role)
select id, 'Full Name', 'operator'      -- admin | manager | operator | viewer
from auth.users where email = 'person@example.com';
```

To deactivate someone: `update app_users set active = false where full_name = '...';`

| Role | Can |
|---|---|
| viewer | Look up inventory, view receipts |
| operator | + create receipts, receive, move pallets, void pallets on open receipts, close receipts |
| manager | + setup (items, locations), adjust qty, hold/release, reopen/void receipts, void any unshipped pallet |
| admin | + company info |

## Printing

- **Labels:** 4x6 inches, one pallet per page. Set the label printer's paper
  size to 4x6 and scale to 100% (turn off "fit to page"). Each label carries
  Code 128 barcodes for the pallet ID and the lot.
- **Receipts:** letter size. Use "Save as PDF" in the print dialog to email one.

## Scanning

- **Handheld scanners in keyboard mode** scan straight into any field.
- **The Scan button** uses the phone camera. The site must be on HTTPS (GitHub
  Pages is) and the user must allow camera access.
- **Lookup** accepts our pallet ID (RMB000123), a customer pallet ID, a SKU, a
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
select * from v_inventory where location = 'DOCK';            -- pallet level
select * from v_transactions order by id desc limit 100;      -- recent activity
```
