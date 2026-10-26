# Cloud migration implementation checklist

This document is a release gate for Van Stock Pro's Supabase integration. It does not enable sync or change app data.

## Required before migration code is enabled

- Preserve all existing `van-stock-pro-*` browser storage keys. Cloud setup must never clear or replace local data.
- Keep import preview read-only. Only a separate, explicit commit action may begin migration.
- Make import retries idempotent using the workspace-scoped legacy ID, never the item name.
- Upload photos to the private bucket first; verify the uploaded object before writing its path to a stock record.
- Preserve movements and job usage, including historical item name/SKU snapshots when a linked item is missing.
- Use server-side atomic stock adjustments so two devices cannot overwrite each other's quantities.
- Enforce workspace membership and role checks in the database, not only in the UI.
- Test owner, editor, viewer, and non-member access; retry after network loss; repeated imports; partial photo failures; and two independent devices.
- Keep production deployment separate until all checks pass and a user verifies the imported counts against the original backup.

## Current state

The current integration is account/workspace setup plus a read-only backup preview. Stock CRUD, photo migration, and real multi-device synchronization are not implemented. Do not treat static checks as proof of live Supabase or browser behaviour.

## History retry identity preparation

- `migrations/20261026_history_import_idempotency.sql` adds nullable `legacy_record_id` columns and workspace-scoped partial unique indexes for movement and job-usage history.
- This migration is additive and does not import or rewrite data. It must be reviewed and run manually in Supabase SQL Editor only when the existing schema is confirmed present.
- Existing history without stable source IDs remains a blocker for repeat-safe import until a deterministic identity strategy is verified against real backup samples.
- Do not claim cloud import, multi-device sync, or database-level tests are complete based on the Node synthetic suite.
