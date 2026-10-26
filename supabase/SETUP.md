# Van Stock Pro — Supabase multi-device setup

This folder is a **preparation branch only**. It does not change the live GitHub Pages app and does not yet connect the app to a cloud database. Keeping the existing live app untouched protects current stock data while the cloud setup is prepared.

## Architecture

- GitHub Pages continues to host the app.
- Supabase Auth provides sign-in.
- Supabase Postgres stores stock items, movements, job usage and workspace membership.
- Supabase Storage stores item photos privately.
- QR images are generated from stored item identifiers/URLs when displayed; the QR image itself does not need to be stored.
- The app's existing browser data remains untouched until a verified migration has been built and tested.

## 1. Create a Supabase project

1. Open https://supabase.com/dashboard and create a project.
2. Choose a strong database password and save it somewhere safe.
3. Wait until the project finishes provisioning.
4. In **SQL Editor**, open a new query, paste all of `schema.sql`, and run it.
5. In **Project Settings → API** (or the project's Connect/API panel), copy the **Project URL** and the **publishable key** (or legacy anon/public key).

Never send or put the database password, `service_role` key, secret API keys, or personal access tokens into the browser app or a chat. The browser only uses the public/publishable key; row-level security is required.

## 2. Send the two public configuration values

Provide:
- Project URL (looks like `https://xxxx.supabase.co`)
- Publishable/anon public key

These values are intended for a browser client. Do not provide the service-role key.

## 3. Implementation and migration sequence

Before publishing any integration to `main`:

1. Add sign-in and sign-out with clear session handling.
2. Create the first workspace for the signed-in user and assign the owner role.
3. Add a one-time import preview from the existing Van Stock Pro JSON backup. Preview item counts, photo counts, movement counts and job-usage counts before applying.
4. Upload photos to the private `van-stock-item-photos` bucket and store paths in `stock_items.photo_path`.
5. Preserve legacy item IDs so movement/job history can be linked to the correct items.
6. Add cloud CRUD, live refresh/realtime updates, and conflict-safe stock quantity updates.
7. Test two devices, access restrictions, offline/error states, backup/restore, QR generation, and barcode scanning.
8. Only then deploy to the live branch. Keep the original local data and JSON backup until the migration has been verified on both devices.

## Current legacy browser storage keys

- `van-stock-pro-items-v1`: stock item records, including barcode values and photos embedded as compressed data URLs.
- `van-stock-pro-movements-v2`: movement history.
- `van-stock-pro-usage-v1`: job-use history.
- Other `van-stock-pro-*` keys may contain additional settings; use the app's **Download data backup** feature to capture all matching keys before migration.

## Important safety note

Do not migrate by simply replacing localStorage with cloud reads. The app currently has local save/restore logic and multiple stock operations; each needs to be moved to a shared, atomic database operation to avoid overwriting another device's changes.
