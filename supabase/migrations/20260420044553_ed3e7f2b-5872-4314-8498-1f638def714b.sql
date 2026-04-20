-- 1) أعمدة جديدة لدعم الاعتماد التلقائي
ALTER TABLE public.payment_requests
  ADD COLUMN IF NOT EXISTS auto_approval_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_approved boolean NOT NULL DEFAULT false;

-- 2) فهرس للاستعلام السريع من قِبل cron
CREATE INDEX IF NOT EXISTS idx_payment_requests_auto_approval
  ON public.payment_requests (auto_approval_scheduled_at)
  WHERE status = 'pending' AND auto_approval_scheduled_at IS NOT NULL;

-- 3) جدول سجل الاعتمادات التلقائية
CREATE TABLE IF NOT EXISTS public.auto_approval_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount numeric NOT NULL,
  expected_amount numeric,
  extracted_amount numeric,
  extracted_recipient text,
  extracted_sender text,
  recipient_match boolean,
  fraud_status text,
  receipt_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.auto_approval_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view auto approval log"
  ON public.auto_approval_log
  FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "No client writes to auto approval log"
  ON public.auto_approval_log
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

-- 4) دالة تُرجع كل المبالغ القياسية للخطط النشطة (zone a + b + default)
CREATE OR REPLACE FUNCTION public.get_standard_plan_amounts()
RETURNS TABLE(amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT a FROM (
    SELECT price_zone_a AS a FROM public.subscription_plans WHERE is_active = true AND is_free = false
    UNION ALL
    SELECT price_zone_b FROM public.subscription_plans WHERE is_active = true AND is_free = false
    UNION ALL
    SELECT price_default FROM public.subscription_plans WHERE is_active = true AND is_free = false
    UNION ALL
    SELECT price_zone_a FROM public.subscription_settings
    UNION ALL
    SELECT price_zone_b FROM public.subscription_settings
    UNION ALL
    SELECT price FROM public.subscription_settings
  ) t WHERE a IS NOT NULL AND a > 0;
$$;

-- 5) تفعيل الإضافات اللازمة لـ cron
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;