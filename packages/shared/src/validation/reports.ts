import { z } from "zod";

export const scheduledReportCreateSchema = z.object({
  name: z.string().min(1).max(200),
  reportType: z.enum(["DAILY_CENSUS", "WEEKLY_REVENUE", "MONTHLY_SUMMARY", "CUSTOM"]),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM"),
  recipients: z.array(z.string().email()).min(1).max(50),
  config: z.record(z.string(), z.any()).optional(),
  active: z.boolean().optional(),
});

export const scheduledReportUpdateSchema = scheduledReportCreateSchema.partial();

export type ScheduledReportCreateInput = z.infer<typeof scheduledReportCreateSchema>;
export type ScheduledReportUpdateInput = z.infer<typeof scheduledReportUpdateSchema>;

export const dashboardPreferenceSchema = z.object({
  layout: z.object({
    widgets: z.array(
      z.object({
        type: z.string(),
        visible: z.boolean().optional(),
        order: z.number().optional(),
        config: z.record(z.string(), z.any()).optional(),
      })
    ),
  }),
});

export type DashboardPreferenceInput = z.infer<typeof dashboardPreferenceSchema>;

// Per-user sidebar ordering. `order` is the list of nav hrefs in the user's
// chosen sequence (pinned items like Dashboard / Admin Console are NOT stored
// here — they are always rendered first by the client). An empty array means
// "no customisation — fall back to the default sidebar order". Hrefs that no
// longer exist (feature-gated off, route removed) are ignored by the client,
// and newly-added nav items not present in `order` are appended in default
// order, so the stored list never needs to be exhaustive.
export const sidebarPreferenceSchema = z.object({
  order: z.array(z.string().min(1).max(200)).max(200),
});

export type SidebarPreferenceInput = z.infer<typeof sidebarPreferenceSchema>;
