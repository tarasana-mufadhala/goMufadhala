-- Production repair applied 2026-09-26 to the live schedule database.
-- Run only after faculty_private.guard_assignment_request() exists.
-- Restores an inactive assignment only when its identity, group, college,
-- and hours are unchanged and the exact assignment has a published session.
-- An existing approved request may also be reused for that same assignment.
DO $migration$
DECLARE
  ddl text;
  approval_check text := 'AND r.decided_by=auth.uid() AND r.decided_at=now()';
  same_assignment text :=
    'TG_OP=''UPDATE'' AND NOT OLD.is_active AND NEW.instructor_id=OLD.instructor_id '
    || 'AND NEW.delivery_group_id IS NOT DISTINCT FROM OLD.delivery_group_id '
    || 'AND NEW.college_id=OLD.college_id '
    || 'AND NEW.assigned_component_hours IS NOT DISTINCT FROM OLD.assigned_component_hours '
    || 'AND NEW.weekly_hours IS NOT DISTINCT FROM OLD.weekly_hours';
  published_assignment text :=
    'EXISTS (SELECT 1 FROM public.schedule_sessions original '
    || 'JOIN public.schedule_versions original_version ON original_version.id=original.schedule_version_id '
    || 'JOIN public.delivery_groups g ON g.id=NEW.delivery_group_id '
    || 'JOIN public.academic_cohorts cohort ON cohort.id=g.cohort_id '
    || 'WHERE original.teaching_assignment_id=NEW.id '
    || 'AND original.delivery_group_id=NEW.delivery_group_id '
    || 'AND original.instructor_id=NEW.instructor_id '
    || 'AND original_version.status=''published'' '
    || 'AND original_version.academic_term_id=cohort.term_id '
    || 'AND original_version.college_id=NEW.college_id)';
BEGIN
  SELECT pg_get_functiondef('faculty_private.guard_assignment_request()'::regprocedure)
    INTO ddl;
  IF ddl IS NULL THEN RAISE EXCEPTION 'ASSIGNMENT_GUARD_MISSING'; END IF;

  IF position(approval_check IN ddl) > 0 THEN
    ddl := replace(ddl, approval_check,
      'AND ((r.decided_by=auth.uid() AND r.decided_at=now()) OR ('
      || same_assignment || ' AND r.assignment_id=NEW.id '
      || 'AND r.decided_at IS NOT NULL AND '
      || replace(published_assignment,
        'original_version.academic_term_id=cohort.term_id',
        'original_version.academic_term_id=r.term_id') || '))');
  END IF;

  IF position('IF h.home_college_id=NEW.college_id THEN RETURN NEW; END IF;' IN ddl) > 0 THEN
    ddl := replace(ddl,
      'IF h.home_college_id=NEW.college_id THEN RETURN NEW; END IF;',
      'IF h.home_college_id=NEW.college_id THEN RETURN NEW; END IF; '
      || 'IF ' || same_assignment || ' AND ' || published_assignment
      || ' THEN RETURN NEW; END IF;');
  END IF;

  IF position('IF h.home_college_id=NEW.college_id THEN RETURN NEW; END IF; IF TG_OP' IN ddl)=0
    OR position('r.assignment_id=NEW.id AND r.decided_at IS NOT NULL' IN ddl)=0 THEN
    RAISE EXCEPTION 'ASSIGNMENT_GUARD_UNEXPECTED_DEFINITION';
  END IF;
  EXECUTE ddl;
END $migration$;
