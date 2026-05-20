# Session snapshot — 2026-05-20 evening (Pearl gap analysis + 3 of top 10 closed)

End-of-session handoff. Read this first, then [`/TODO.md`](../../TODO.md), then go. Replaces `SESSION_SNAPSHOT_2026-05-18-evening.md` as the most recent handoff.

## State at session end

- **HEAD on `main`** = `704a5f5` (`feat(db,api,web): Pearl §2.1.4 — Doctor.nmcRegNumber + render on Rx PDF`).
- **Working tree:** clean for code. `Hardik's Req_pearl woman.txt` remains untracked at the repo root (source PRD; intentionally left untracked so the user can decide its final home).
- **Open PRs:** unchanged from this morning's wave (auto-merge keeps the dependabot queue near-empty).
- **9 commits this session on `main`** — the gap analysis doc + 5-PR Pearl M1 stack + 2 follow-on Pearl §2.1.4 closures.

## What this session shipped

### 1. Pearl ERP Stage 1 gap analysis (`b86e69f`)

A 419-line doc at [`docs/PEARL_STAGE1_GAP_ANALYSIS.md`](../PEARL_STAGE1_GAP_ANALYSIS.md), mirroring the format used in [`docs/MYKARE_GAP_ANALYSIS.md`](../MYKARE_GAP_ANALYSIS.md). Source PRD: `Hardik's Req_pearl woman.txt` (untracked, root).

**Headline:** ~65-70% of Pearl Stage 1 is already covered by MedCore. MedCore is *broader* on clinical/AI/IPD/interop axes, *narrower* on Pearl's marketing-side scaffolding (lead pipeline + campaign engine) and Pearl's tenant/branch/super-admin shape. A top-10 ordered build list summing to ~17-18 engineer-weeks fits inside Pearl's own 18-week Stage-1 calendar (PRD §13).

### 2. Pearl M1 build #1 — `Doctor.appointmentMode` end-to-end (5 PRs)

Closes the **single largest M1 gap** (PRD §2.1.2 + §3.2): three doctor modes (Calling / Token / Slot).

| PR | Commit | Surface |
|---|---|---|
| 1 | `bfd11a8` | Schema migration `20260520000002` — `AppointmentMode` + `LastHourPolicy` enums; Doctor knobs (`tokenPrefix`/`tokenStartNumber`/`dailyAppointmentLimit`/`nearTurnAlertThreshold`/`lastHourPolicy`); Appointment.tokenNumber → nullable; new `arrivalSeq` column; new `@@unique (doctorId, date, slotStart)`. |
| 2 | `6913d62` | API `PATCH /doctors/:id/appointment-mode` + Zod schema + 6 integration tests (PATCH semantics, null clears, audit). |
| 3 | `e35081b` | API booking branches by mode in `routes/appointments.ts` — TOKEN mints `tokenNumber` (legacy), CALLING mints `arrivalSeq`, SLOT requires `slotId` + uses the new unique to block double-bookings. New `getNextArrivalSeq()` helper + 4 integration tests. |
| 4a | `fd58688` | Web: doctor-detail "Appointment Mode" editor card (`/dashboard/doctors/:id`). Admin-only edit, all 6 knobs surfaced. |
| 4b | `47131fa` | Web: `/dashboard/appointments` booking modal hides the slot picker and shows an "Add to today's queue" button when the chosen doctor is in CALLING mode. SLOT and TOKEN flows unchanged. |
| 5 | `6febb54` | API `/queue` extends per-doctor data with `appointmentMode`, `nextToken`, `currentArrivalSeq`, `upcomingSlots[]` (next 3 booked, patient label redacted "First L." per PRD §2.1.5). Web `/display/page.tsx` lifts the doctor card into a `DoctorCard` component that renders 3 layouts — TOKEN Now/Next/Waiting, CALLING arrival counter, SLOT next-3-slots strip — plus a mode badge per card. |

**End-to-end demo flow** (works on local + the dev demo once deployed):
1. Admin opens `/dashboard/doctors/:id` → flips the doctor to CALLING.
2. Booking modal swaps the slot picker for a blue "Add to today's queue" button.
3. API mints `arrivalSeq` (no token, no slot).
4. Display board renders "Now Serving Arrival #N" in the doctor's card.

Default TOKEN mode preserved for every existing doctor — no regression.

### 3. Pearl §2.1.4 — Rx safety gate (2 additional follow-on commits)

Both address Pearl's hard §2.1.4 acceptance criteria for the prescription writer:

| Build # | Commit | What |
|---|---|---|
| **#7** | `954b141` | `PatientAllergy` block at Rx create. New `checkPatientAllergies()` helper cross-references each medicine's brand+generic tokens against the patient's allergies (bidirectional case-insensitive substring). Conflict → 400 with structured `allergyConflicts[]`. Override requires `overrideAllergies=true` + 3-500 char `allergyOverrideReason` (Zod refine). `PRESCRIPTION_ALLERGY_OVERRIDE` audit row written on override. 4 integration tests. |
| **#10a** | `704a5f5` | Schema migration `20260520000003` adds `Doctor.nmcRegNumber TEXT`. PDF generator renders it in both the doctor-info block + the signature block. Doctor-detail page editor adds the input. 1 integration test. PDF gracefully shows "-" when blank. |

## Pearl gap progress

**3 of top 10 items closed this session** out of the ~17-18 engineer-week total. Remaining (per [`PEARL_STAGE1_GAP_ANALYSIS.md`](../PEARL_STAGE1_GAP_ANALYSIS.md) §7):

| # | Item | Effort | Notes |
|---|---|---|---|
| 2 | `Branch` model + `branchScopedPrisma` + branch picker | 3-4 wk | Big — schema migration touches ~20 tables; backfill default branch per tenant. |
| 3 | Lead pipeline (6-stage state machine + activity log + convert-to-patient) | 1.5 wk | Closes M2 §3.3 entirely. |
| 4 | Campaign engine (`Campaign`, `CampaignSend`, audience builder, A/B, send-window) | 2.5 wk | Closes M4 §5.1 entirely. Reuses existing `services/channels/*`. |
| 5 | Patient PWA route group + service worker + phone-OTP login | 3 wk | Closes M5 §6. Backend ~90% reused. |
| 6 | Super-admin route group on separate vhost + onboarding wizard + Pearl-billing | 2.5 wk | Closes M7 §8.1+8.3. |
| 8 | Threaded `AppointmentRemark` + per-row Quick-Action buttons | 1 wk | Closes M1 §2.1.7 + §2.1.8. Small + contained — likely the easiest next pickup. |
| 9 | Tenant feature-flag mechanism + hide Stage-2+ surfaces | 1 wk | Operational requirement for any Pearl pilot. |
| 10b | Razorpay live cred per tenant + mandatory-TOTP toggle for tenant ADMIN | 1 wk | Compliance + onboarding-wizard prerequisites. |

## Top priority for next session

1. **#8 Threaded `AppointmentRemark` + Quick-Action buttons** (~1 wk) — same shape as today's builds. Schema + Zod + route + UI. Lowest friction next pickup.
2. **#9 Tenant feature-flag mechanism** (~1 wk) — also small and contained. Hides Stage-2+ surfaces for a Pearl pilot.
3. **#10b Razorpay live-cred per tenant + mandatory-TOTP toggle** (~1 wk) — finishes the compliance bundle started in #10a.
4. **#3 Lead pipeline** (~1.5 wk) — first of the multi-week items; the cleanest "new module" to start when there's appetite.

The big multi-week items (#2 Branch model, #4 Campaign engine, #5 Patient PWA, #6 Super-admin) really do want dedicated sessions per the gap doc — don't try to chunk them.

## Reference

- **HEAD**: `704a5f5` on main.
- Source PRD: `Hardik's Req_pearl woman.txt` (untracked, root).
- Gap analysis: [`docs/PEARL_STAGE1_GAP_ANALYSIS.md`](../PEARL_STAGE1_GAP_ANALYSIS.md).
- [`/TODO.md`](../../TODO.md) — banner reflects this session.

## Net for the day

Delivered a structured Pearl ERP Stage 1 gap analysis (the team's first against this PRD), then drove 3 of the top-10 builds to completion end-to-end: Pearl M1 build #1 (5 PRs, the biggest M1 blocker), the Rx allergy-block gate (PRD §2.1.4), and the NMC reg-number requirement (PRD §2.1.4). Every build is additive + backward-compatible: existing data behaves exactly as before, new Pearl behaviour kicks in when admins opt doctors into it. Net ~3 of ~17-18 engineer-weeks of the Pearl gap closed in a single session — Pearl's own 18-week Stage-1 calendar still fits.
