-- 1) حقول جديدة لتخزين نتيجة تحليل السند ومسار التجاوز
ALTER TABLE public.payment_requests
  ADD COLUMN IF NOT EXISTS extracted_recipient text,
  ADD COLUMN IF NOT EXISTS extracted_sender text,
  ADD COLUMN IF NOT EXISTS recipient_match boolean,
  ADD COLUMN IF NOT EXISTS approval_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason text;

-- 2) دالة التحقق من قابلية الموافقة
CREATE OR REPLACE FUNCTION public.guard_payment_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- نطبّق الحماية فقط عند الانتقال إلى approved
  IF NEW.status = 'approved' AND COALESCE(OLD.status, '') <> 'approved' THEN

    -- إذا كان السند مشبوهاً أو بحاجة مراجعة، يجب وجود override صريح + سبب
    IF NEW.fraud_status IN ('suspicious', 'review') THEN
      IF NEW.approval_override IS NOT TRUE
         OR NEW.override_reason IS NULL
         OR length(trim(NEW.override_reason)) < 10 THEN
        RAISE EXCEPTION 'لا يمكن اعتماد طلب دفع مصنّف % بدون تأكيد صريح وسبب تجاوز واضح (10 أحرف على الأقل)', NEW.fraud_status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- إذا كان تحليل السند يثبت عدم تطابق المستلم، يجب override
    IF NEW.recipient_match IS FALSE THEN
      IF NEW.approval_override IS NOT TRUE
         OR NEW.override_reason IS NULL
         OR length(trim(NEW.override_reason)) < 10 THEN
        RAISE EXCEPTION 'بيانات المستلم في السند غير مطابقة. يلزم تأكيد صريح وسبب تجاوز قبل الاعتماد'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- إذا كان فارق المبلغ كبيراً (≠ تطابق تام)، يلزم override
    IF NEW.expected_amount IS NOT NULL
       AND NEW.extracted_amount IS NOT NULL
       AND NEW.extracted_amount <> NEW.expected_amount THEN
      IF NEW.approval_override IS NOT TRUE
         OR NEW.override_reason IS NULL
         OR length(trim(NEW.override_reason)) < 10 THEN
        RAISE EXCEPTION 'المبلغ المستخرج من السند (%) لا يطابق المبلغ المتوقع (%). يلزم تأكيد صريح وسبب تجاوز',
          NEW.extracted_amount, NEW.expected_amount
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 3) ربط الـ Trigger
DROP TRIGGER IF EXISTS trg_guard_payment_approval ON public.payment_requests;
CREATE TRIGGER trg_guard_payment_approval
BEFORE UPDATE ON public.payment_requests
FOR EACH ROW
EXECUTE FUNCTION public.guard_payment_approval();