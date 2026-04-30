# RBAC Audit — Web Page Role Gates vs API Endpoint Gates

**Date:** 2026-04-30
**Issue:** #174 — RBAC bypass via direct URL on admin-only modules
**Author:** Claude Opus (issue #174 sweep)

## Methodology

For each `/dashboard/<module>` route:

1. Open `apps/web/src/app/dashboard/<module>/page.tsx`.
2. Find the `useAuthStore` role check (if any) — record the allowed-set.
3. Identify the API endpoint(s) the page calls.
4. Compare with `authorize(...)` on that route in `apps/api/src/routes/`.
5. Mark the gap status.

**Status legend:**

- `MATCH` — web allowed-set equals API authorize set.
- `API LOOSER` — API allows roles the web page hides. Direct-URL bypass possible. **HIGH RISK.**
- `API STRICTER` — API rejects roles the web page would let in. Page renders, but data loads fail.
- `NO API GATE` — API has only `authenticate`, no `authorize`. Worst case.
- `NO WEB GATE` — Web page has no role check at all. Sidebar visibility is the only barrier.
- `FIXED 2026-04-30` — Closed in this sweep.

## Audit Table

| Route                                | Web hook role-set                                        | API endpoint                                | API gate                                                       | Status                          |
|--------------------------------------|----------------------------------------------------------|---------------------------------------------|----------------------------------------------------------------|---------------------------------|
| /dashboard/suppliers                 | NO WEB GATE                                              | GET /suppliers                              | `authorize(ADMIN, RECEPTION, PHARMACIST)` (post-sweep)         | FIXED 2026-04-30 (API only)     |
| /dashboard/suppliers/:id             | NO WEB GATE                                              | GET /suppliers/:id                          | `authorize(ADMIN, RECEPTION, PHARMACIST)` (post-sweep)         | FIXED 2026-04-30 (API only)     |
| /dashboard/suppliers/:id/payments    | NO WEB GATE                                              | GET /suppliers/:id/payments                 | `authorize(ADMIN, RECEPTION)` (post-sweep)                     | FIXED 2026-04-30 (API only)     |
| /dashboard/purchase-orders           | NO WEB GATE                                              | GET /purchase-orders                        | `authorize(ADMIN, RECEPTION, PHARMACIST)` (post-sweep)         | FIXED 2026-04-30 (API only)     |
| /dashboard/purchase-orders/:id       | NO WEB GATE                                              | GET /purchase-orders/:id                    | `authorize(ADMIN, RECEPTION, PHARMACIST)` (post-sweep)         | FIXED 2026-04-30 (API only)     |
| /dashboard/visitors                  | NO WEB GATE                                              | GET /visitors                               | `authorize(ADMIN, RECEPTION, DOCTOR, NURSE)`                   | MATCH (web gap, API fine)       |
| /dashboard/assets                    | `canManage = ADMIN` (write only — read open)              | GET /assets, GET /assets/:id                | `authorize(ADMIN, RECEPTION)` (post-sweep)                     | FIXED 2026-04-30 (API only)     |
| /dashboard/assets (depreciation)     | NO WEB GATE                                              | GET /assets/:id/depreciation                | `authorize(ADMIN)` (post-sweep)                                | FIXED 2026-04-30 (API only)     |
| /dashboard/ambulance                 | `AMBULANCE_ALLOWED = ADMIN, NURSE, RECEPTION, DOCTOR`    | GET /ambulance, GET /ambulance/trips        | `authorize(ADMIN, RECEPTION, NURSE, DOCTOR)` (post-sweep)      | FIXED 2026-04-30                |
| /dashboard/ambulance (fuel-logs)     | `AMBULANCE_ALLOWED`                                      | GET /ambulance/fuel-logs                    | `authorize(ADMIN, RECEPTION)` (post-sweep)                     | API STRICTER (intentional)      |
| /dashboard/insurance-claims          | `["ADMIN", "RECEPTION"]`                                 | GET /claims                                 | `authorize(ADMIN, RECEPTION, DOCTOR)`                          | API LOOSER (DOCTOR drift)       |
| /dashboard/ot                        | NO WEB GATE                                              | GET /surgery/ots, GET /surgery/ots/:id/sched| `authorize(ADMIN, DOCTOR, NURSE, RECEPTION)` (post-sweep)      | FIXED 2026-04-30 (API only)     |
| /dashboard/wards                     | `isAdmin` for write only — read open                     | GET /wards                                  | only `authenticate`                                            | NO API GATE (low risk: counts)  |
| /dashboard/adherence                 | `isPatient = PATIENT` branches between /mine and /:id    | GET /ai/adherence/:patientId                | ownership check inline                                         | MATCH                           |
| /dashboard/fhir-export               | `user.role === ADMIN`                                    | GET /fhir/Patient/:id, POST /fhir/Bundle    | `authorize(ADMIN, DOCTOR, NURSE, RECEPTION, PATIENT)` GET; `authorize(ADMIN)` POST | API LOOSER (GET allows non-ADMIN) |
| /dashboard/ai-booking                | `user` only used for "Start Consultation" CTA            | POST /ai-triage/* + appointments            | mixed — triage open, appointments gated                        | MIXED (low risk: own triage)    |
| /dashboard/expenses                  | `ALLOWED_ROLES = ADMIN`                                  | GET /expenses                               | `authorize(ADMIN)`                                             | MATCH                           |
| /dashboard/billing                   | `BILLING_ALLOWED = ADMIN, RECEPTION, PATIENT (own)`      | GET /billing/invoices                       | `authorize(ADMIN, RECEPTION, PATIENT)`                         | MATCH                           |
| /dashboard/audit                     | `user.role === ADMIN`                                    | GET /audit                                  | `authorize(ADMIN)` (router-level)                              | MATCH                           |
| /dashboard/payroll                   | `user.role === ADMIN`                                    | POST /hr-ops/payroll, GET /shifts/roster    | `authorize(ADMIN)` payroll; `authorize(ADMIN,RECEPTION,DOC,NURSE)` roster (post-sweep) | MATCH (post-sweep)            |
| /dashboard/users                     | implicit ADMIN (page reads `users` list)                 | GET /admin/users                            | `authorize(ADMIN)` via admin-console router                    | MATCH                           |
| /dashboard/tenants                   | `user.role === ADMIN`                                    | GET /tenants                                | `authorize(ADMIN)` + `requireSuperAdmin`                       | MATCH                           |
| /dashboard/admin-console             | `user.role === ADMIN`                                    | GET /admin/*                                | `authorize(ADMIN)`                                             | MATCH                           |
| /dashboard/scheduled-reports         | `user.role === ADMIN`                                    | GET /scheduled-reports                      | `authorize(ADMIN)` (router-level)                              | MATCH                           |
| /dashboard/controlled-substances     | `ADMIN, PHARMACIST, DOCTOR`                              | GET /controlled-substances                  | `authorize(ADMIN, PHARMACIST, DOCTOR)` (router-level)          | MATCH                           |
| /dashboard/bloodbank                 | open page (writes gated client-side)                     | GET /bloodbank/donors                       | `authorize(ADMIN, DOCTOR, NURSE, LAB_TECH)` (post-sweep)       | FIXED 2026-04-30 (API only)     |
| /dashboard/surgery                   | `canSchedule = DOCTOR, ADMIN` (write only)               | GET /surgery                                | inline PATIENT scope; auth open for staff                      | MATCH (PATIENT scoped inline)   |
| /dashboard/pharmacy                  | RECEPTION redirected client-side                         | GET /pharmacy/medicines, /movements         | `authorize(ADMIN, PHARMACIST, DOCTOR, NURSE)` movements (post-sweep) | FIXED 2026-04-30 (API only)     |
| /dashboard/lab                       | (clinical roles — covered by issue #90)                  | GET /lab/orders                             | `authorize(ADMIN, DOCTOR, NURSE, LAB_TECH)`                    | MATCH                           |
| /dashboard/prescriptions             | (covered by agent 3 — out of scope here)                 | GET /prescriptions                          | `authorize(ADMIN, DOCTOR, NURSE, PHARMACIST)`                  | MATCH                           |
| /dashboard/referrals                 | (covered by agent 4 — out of scope here)                 | n/a                                         | n/a                                                            | n/a                             |
| /dashboard/doctors                   | (covered by agent 2 — out of scope here)                 | n/a                                         | n/a                                                            | n/a                             |
| /dashboard/patients/:id              | open page                                                | GET /patients/:id                           | only `authenticate`                                            | NO API GATE (medium risk)       |
| /dashboard/telemedicine              | open page                                                | GET /telemedicine                           | inline PATIENT/DOCTOR scope                                    | MATCH                           |
| /dashboard/feedback                  | open page                                                | GET /feedback                               | `authorize(ADMIN, RECEPTION, DOCTOR, NURSE)`                   | MATCH (PATIENT excluded server) |
| /dashboard/calendar                  | open page                                                | GET /appointments                           | `authorize(ADMIN, DOCTOR, RECEPTION)`                          | MATCH                           |

## Top Critical Web-Side Gaps for the Next Wave

These are the biggest residual gaps where the web page has **no role gate at all**. Even with the API gates this sweep added, the page itself will still try to render before the 403 comes back, leading to a confusing flash of empty admin UI for unauthorized roles. Add `if (user.role !== ALLOWED) router.push('/dashboard/not-authorized')` pattern (see `/dashboard/expenses/page.tsx` for the canonical guard).

1. **`/dashboard/suppliers/page.tsx` and `/dashboard/purchase-orders/page.tsx`** — no `useAuthStore` import, no redirect. After the API gate added today, doctors will see an "Access Denied"-style empty state. Add the same `BILLING_ALLOWED` pattern with `[ADMIN, RECEPTION, PHARMACIST]`.

2. **`/dashboard/visitors/page.tsx`** — no role gate. The API allows `ADMIN/RECEPTION/DOCTOR/NURSE` but the page should redirect PATIENT.

3. **`/dashboard/ot/page.tsx`** (operating theaters) — no role gate. API now restricts to clinical/ops, but the page still renders the "Add OT" button to anyone. Same fix pattern as expenses.

## Residual API Gaps (Not Closed in This PR)

- `/api/v1/wards` GET — only authenticated. Low risk (just bed counts) but worth tightening.
- `/api/v1/patients/:id` GET — only authenticated. Medium risk: any logged-in user (including PATIENT) can read another patient's chart by guessing the UUID. Needs ownership scoping via `assertPatientAccess`-style helper. Out of scope for this sweep because it requires careful coordination with FE to avoid breaking the patient self-view.
- `/api/v1/insurance-claims` GET — currently allows DOCTOR; web only allows ADMIN/RECEPTION. DOCTOR drift is intentional? Confirm with product before tightening.
- `/api/v1/fhir/Patient/:id` GET — allows PATIENT (with ownership check) but `/dashboard/fhir-export` page restricts to ADMIN. The API gate is more permissive on purpose (FHIR clients) — keep the discrepancy but document it.

## Endpoints Hardened in This Sweep

- `suppliers.ts`: GET /, GET /:id, GET /:id/payments, GET /:id/performance, GET /:id/catalog
- `purchase-orders.ts`: GET /, GET /:id, GET /:id/grns
- `assets.ts`: GET /, GET /:id, GET /maintenance/due, GET /warranty/expiring, GET /:id/depreciation, GET /amc/expiring, GET /calibration/due, GET /:id/transfers, GET /:id/qr-payload
- `ambulance.ts`: GET /, GET /:id, GET /trips, GET /trips/:id, GET /fuel-logs
- `surgery.ts`: GET /ots, GET /ots/:id/schedule
- `pharmacy.ts`: GET /movements
- `bloodbank.ts`: GET /donors, GET /donors/:id
- `shifts.ts`: GET /roster

**Total: 22 endpoints hardened.**
