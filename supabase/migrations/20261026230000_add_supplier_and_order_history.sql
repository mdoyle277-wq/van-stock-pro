-- Van Stock Pro: targeted repair for tables missing from an existing project.
-- Safe to apply once or repeatedly: creates only supplier_details/order_history
-- if absent; does not recreate existing tables or modify stock data.
-- Review against the live schema before applying to production.

BEGIN;

CREATE TABLE IF NOT EXISTS public.supplier_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  supplier_name text NOT NULL,
  contact text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, supplier_name)
);

CREATE INDEX IF NOT EXISTS supplier_details_workspace_name_idx
  ON public.supplier_details(workspace_id, supplier_name);

CREATE TABLE IF NOT EXISTS public.order_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  legacy_order_id text,
  supplier_name text NOT NULL DEFAULT '',
  item_name text NOT NULL DEFAULT '',
  sku text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  quantity numeric NOT NULL CHECK (quantity > 0),
  ordered_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_history_workspace_date_idx
  ON public.order_history(workspace_id, ordered_at DESC);

ALTER TABLE public.supplier_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members can view supplier details" ON public.supplier_details;
CREATE POLICY "members can view supplier details" ON public.supplier_details
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "editors can add supplier details" ON public.supplier_details;
CREATE POLICY "editors can add supplier details" ON public.supplier_details
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']));

DROP POLICY IF EXISTS "editors can update supplier details" ON public.supplier_details;
CREATE POLICY "editors can update supplier details" ON public.supplier_details
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']));

DROP POLICY IF EXISTS "admins can delete supplier details" ON public.supplier_details;
CREATE POLICY "admins can delete supplier details" ON public.supplier_details
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin']));

DROP POLICY IF EXISTS "members can view order history" ON public.order_history;
CREATE POLICY "members can view order history" ON public.order_history
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "editors can add order history" ON public.order_history;
CREATE POLICY "editors can add order history" ON public.order_history
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']));

DROP POLICY IF EXISTS "admins can delete order history" ON public.order_history;
CREATE POLICY "admins can delete order history" ON public.order_history
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin']));

-- Explicit table grants for signed-in clients; RLS still controls individual rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_details TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_history TO authenticated;
REVOKE ALL ON public.supplier_details FROM anon;
REVOKE ALL ON public.order_history FROM anon;

COMMIT;
