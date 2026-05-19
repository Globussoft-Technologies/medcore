-- ================================================================
-- 20260519000005_add_emergency_lwbs_escalation_notification_type_893
--
-- Closes: #893 (ER LEFT_WITHOUT_BEING_SEEN on high-acuity triage
--               creates no alert, no audit, no follow-up).
--
-- Adds the EMERGENCY_LWBS_ESCALATION value to the NotificationType
-- enum so the emergency.ts close handler can fanout an alert to all
-- ADMIN users + the attending doctor (if assigned) when a
-- RESUSCITATION/EMERGENT/URGENT triage patient walks out without
-- being seen.
--
-- Postgres ALTER TYPE ADD VALUE is non-transactional and additive;
-- safe to run on a live database without locking the enum.
-- ================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'EMERGENCY_LWBS_ESCALATION';
