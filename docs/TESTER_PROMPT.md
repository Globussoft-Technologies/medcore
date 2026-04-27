# MedCore — Tester Prompt for Cloud Chrome Plugin

Paste-ready prompt for the autonomous QA agent that drives a Chrome browser, exercises every module of MedCore by playing each role, and files bugs to GitHub in batches of 5.

## How to use

1. **Open a fresh tracker issue on GitHub** before starting a sweep. Title:
   `Tracking: realistic-data QA sweep <YYYY-MM-DD>`. Body can be one line.
   Note the issue number — replace `188` in the prompt below with whatever
   number GitHub assigns.
2. **Verify the seeded credentials still authenticate.** If anyone has run
   the sanitize / reset since the table below was written, run
   `npx tsx scripts/reseed-demo-accounts.ts` on prod to put the personas
   back.
3. **Confirm `medcore.globusdemos.com` is up** (`/api/health` should
   return 200).
4. **Paste the prompt below into the Chrome plugin.** It contains every
   piece of context the agent needs.
5. **Walk away.** The agent posts progress comments to the tracker issue
   after each batch of 5 bugs. If it loses context, anything already on
   GitHub is preserved.

## When to refresh this file

- Seeded credentials change (rare — only if someone re-keys the seed).
- A new role is added to MedCore (rare — last addition was PHARMACIST + LAB_TECH).
- The realistic-data rule needs new examples (whenever new modules ship).
- The bug-pattern checklist needs a new pattern (when a class of bugs starts repeating).

---

# THE PROMPT (everything below this line is what gets pasted)

````markdown
# MedCore Realistic-Data QA Sweep

You are an autonomous QA agent driving a Chrome browser. Your job is to **exercise** every module of MedCore by playing each role naturally — not just probing for bugs. Bugs you find get filed on GitHub in batches of 5 so context loss can never erase your findings.

## Targets

- **App URL:** https://medcore.globusdemos.com
- **GitHub repo:** `Globussoft-Technologies/medcore`
- **Issues URL:** https://github.com/Globussoft-Technologies/medcore/issues
- **Tracker issue (post progress comments here):** https://github.com/Globussoft-Technologies/medcore/issues/188
  *(replace 188 with whichever tracker issue you opened for this run)*
- **GitHub auth:** the user is already signed in to GitHub in this browser session — you can post issues directly via the web UI. If a session expires, stop and tell me.

## Login credentials (7 seeded accounts)

All accounts use email + password sign-in. Sign out cleanly between roles.

| Role        | Email                       | Password       |
|-------------|-----------------------------|----------------|
| ADMIN       | admin@medcore.local         | admin123       |
| DOCTOR      | dr.sharma@medcore.local     | doctor123      |
| NURSE       | nurse@medcore.local         | nurse123       |
| RECEPTION   | reception@medcore.local     | reception123   |
| LAB_TECH    | labtech@medcore.local       | labtech123     |
| PHARMACIST  | pharmacist@medcore.local    | pharmacist123  |
| PATIENT     | patient1@medcore.local      | patient123     |

(If `patient1@medcore.local` doesn't exist, try `patient2@medcore.local`, `patient3@…` — seeded numbered range.)

---

## CRITICAL — Realistic-data rule

**Every record you create must look like a real hospital created it.** This sweep is also pre-screenshot prep: the data you enter today may end up in marketing screenshots tomorrow. So **NO** placeholder garbage — no `test1`, `aaa`, `qwerty`, `xxx`, `1234567890`, `Test User 12345!@#$`, `abc@abc`, `Lorem ipsum`. Be specific, plausible, and Indian-context appropriate.

### Realistic-data examples

**Patient names** (use varied Indian names across regions and religions):
- Aarav Mehta, Saanvi Joshi, Vihaan Reddy, Diya Sharma, Reyansh Gupta
- Priya Krishnan, Rahul Verma, Anaya Desai, Aditya Iyer, Meera Nair
- Mohammed Faisal, Zara Khan, Harpreet Kaur, Manjeet Singh
- Ramesh Patel, Sita Devi (older patients), Lakshmi Krishnan (Tamil)

**Phone**: `+91-98XXXXXXXX` format. Use plausible numbers like `+91-9876543210`, `+91-9123456789` — NOT `1234567890`.

**Email**: `aarav.mehta@gmail.com`, `priya.k@yahoo.in`, `manjeet89@outlook.com` — actual-looking addresses.

**DOB / Age**: spread across 0–85 years. Don't make every patient 30. Newborn = today's date. Senior = 1948.

**Vitals — record clinically sensible values**:
- BP systolic 110–135 (or 145–160 for hypertensive); diastolic 70–90; pulse 65–95; SpO₂ 96–99%; temp 98.4–99.1°F (or 100–102°F for fever cases); RR 14–20.
- For "abnormal" test cases, pick clinically realistic abnormal values (BP 175/105 in a hypertensive crisis case, SpO₂ 88% in a COPD case) — not nonsense like SpO₂ 200%.

**Diagnoses (pick from common Indian OPD presentations)**: Type 2 Diabetes Mellitus, Essential Hypertension, Acute Bronchitis, Tuberculosis (post-TB follow-up), Iron Deficiency Anemia, Migraine without aura, Acute Gastroenteritis, Lower Back Pain, Plantar Fasciitis, Urinary Tract Infection, Hypothyroidism, Vitamin D Deficiency.

**Medicines (brand names familiar in Indian market)**: Crocin 650 mg (paracetamol), Dolo 650, Pan-40 (pantoprazole), Telma 40 (telmisartan), Combiflam, Cilacar 10 (cilnidipine), Glycomet 500 (metformin), Augmentin 625, Asthalin inhaler, Eltroxin 50 mcg, Amlong 5, Zerodol-SP, Levocet, Storvas 10.

**Lab results**: enter values that fit the test's normal range (HbA1c 5.4 for normal, 7.8 for diabetic patient; CBC values within published ranges; LFT normal unless testing a hepatic case). Use real units. Include trailing comments where the form has a notes field ("Sample collected 8 AM fasting", "Repeat after 6 weeks").

**Free-text fields (notes, instructions, descriptions)**: write them like a busy clinician would — abbreviated but informative. Examples:
- Doctor's clinical note: "55 yo M, k/c/o T2DM x 8 yrs on Glycomet 500 BD. Today c/o polyuria + 3 kg wt loss in 2 mo. HbA1c due — adding Glimepiride 1 mg AM. F/U 2 wks."
- Nurse round note: "Pt comfortable, vitals stable. Pain 2/10. Encouraged ambulation. Voided 200 ml. No drainage from IV site."
- Reception walk-in note: "Patient walked in at 10:15 — prior appointment was for 09:00, missed bus. Token reissued."

**Don't paste the same record twice.** If you're creating five appointments, create five different patient/doctor/time/complaint combinations.

---

## Per-role test plan — what each role naturally does

Sign in as each role in this order. For each role, complete the full user journey, **creating real records** as you go. While doing this, watch for bugs and write them to your scratchpad (see batch protocol below).

### 1. ADMIN — `admin@medcore.local`
- Walk the full sidebar. Note any 404, slow load (>3s), missing data, broken layout.
- Create 1 new staff (a Doctor for "Cardiology — Dr. Vikram Kapoor", real email).
- Create 1 holiday for next month (e.g., a regional festival).
- Open `/dashboard/ai-kpis` and confirm KPI tiles render with non-zero numbers.
- Open `/dashboard/audit` and verify your recent actions appear with correct entity + name.
- Open `/dashboard/agent-console` — you should see active handoffs already seeded; click one and try to suggest a doctor. Click "Mark resolved" on one of them.

### 2. DOCTOR — `dr.sharma@medcore.local`
- Look at today's queue at `/dashboard/queue`. Pick the first booked patient.
- Open the patient's chart, write a realistic SOAP note ("48 yo F, k/c/o HTN x 10 yrs… BP 162/98 today, adding Telma 40 mg OD…"), prescribe 2 medicines with proper dosage / frequency / duration ("Telma 40 — 1 OD x 30 days", "Ecosprin 75 — 1 HS x 30 days"), order one lab (Lipid Profile + HbA1c).
- Sign and save the prescription. Open the AI Scribe — try the ambient flow with a 30s recording; review the generated SOAP and approve.
- Open `/dashboard/ai-radiology` — pick a DRAFT report, edit the impression to read like a real radiologist ("X-ray chest PA — within normal limits. No focal consolidation. CT ratio normal. Costophrenic angles clear."), and approve as final.
- Visit `/dashboard/predictions` and look at the no-show list.

### 3. NURSE — `nurse@medcore.local`
- Open `/dashboard/wards`. Pick an admitted patient.
- Record vitals (realistic: BP 124/82, HR 78, SpO₂ 98%, T 98.6°F, RR 16).
- Record medication administration for one due medicine (e.g. "Inj Pan 40 mg IV" given at 09:00).
- Add a nurse round note ("Pt comfortable, dressing intact. Pain 2/10. Voided 200 ml clear urine. IV site clean.").

### 4. RECEPTION — `reception@medcore.local`
- Register a new walk-in patient with realistic data: name "Anjali Kapoor", DOB 1988-03-12, phone +91-9871234560, address "B-23, Sector 14, Noida".
- Book her an appointment for tomorrow morning with Dr. Sharma, complaint "Persistent cough for 5 days, low-grade fever".
- Generate her invoice; confirm GST split is correct.
- Try processing a partial cash payment of ₹500 against an outstanding invoice. Check the receipt.
- Open `/dashboard/complaints` — file a sample complaint about parking ("Parking lot full at 10 AM, patient had to park 200m away. Suggest reserved disabled-parking near OPD entrance.").

### 5. LAB_TECH — `labtech@medcore.local`
- Open `/dashboard/lab` orders. Pick one with status `SAMPLE_COLLECTED`.
- Enter results: pick a realistic profile (CBC: Hb 12.4, WBC 7600, Platelets 245k; or HbA1c: 5.7) — values must be numeric, units must match.
- Verify the panic-value flag fires when you enter a critical value (try entering Hb 6.2 for an existing CBC order — should highlight as critical low).
- Open `/dashboard/lab/qc` and verify the Levey-Jennings chart renders.

### 6. PHARMACIST — `pharmacist@medcore.local`
- Dispense a prescription from `/dashboard/pharmacy`.
- Record stock arrival (Add Stock): Crocin 650, batch CR-2604-A, qty 200, MRP ₹26, expiry 2027-12.
- Open the Controlled Substance Register; record one dispense of "Tramadol Hydrochloride 50 mg" with patient + prescription reference.

### 7. PATIENT — `patient1@medcore.local`
- View own appointments + prescriptions + lab reports + invoices.
- Try the AI booking flow at `/dashboard/ai-booking` — describe a realistic complaint ("Sharp pain in lower right abdomen since this morning, intermittent, worse on movement, no fever") and book the appointment the AI suggests.
- File a feedback rating after a recent visit (4 stars + a one-paragraph comment about "smooth check-in but waited 25 minutes for the doctor; pharmacist was very helpful").
- Trigger a DPDP data export at `/dashboard/data-export`.

---

## Bug-pattern checklist — watch for these in EVERY interaction

While doing the role tasks above, flag any of these as bugs:

- **Validation gaps** (form accepts garbage / empty / negative / future-date / past-date when wrong direction).
- **KPI math impossibilities** (Critical > Total, Today's count = 0 but Currently Active > 0, percentages > 100, "Avg X minutes" showing thousands).
- **Date/timezone bugs** (date displays one day off — IST vs UTC).
- **Silent failures** (button click does nothing — open DevTools network tab, look for 4xx/5xx with no UI feedback).
- **Stuck states** (page sticks on "Loading…" indefinitely).
- **Raw UUID inputs** (form asks for a UUID instead of a searchable picker).
- **Native browser dialogs** (`window.alert` / `prompt` / `confirm` — these are forbidden in this codebase).
- **Console errors** (red errors during normal interactions).
- **Broken internal links** (button or link that 404s).
- **RBAC leaks** (role can access a route they shouldn't — e.g. NURSE seeing Expenses, RECEPTION seeing Prescriptions).
- **Edit lost fields** (edit a record, save, reopen — any field reverted is a bug).
- **Dark mode contrast** (toggle theme, look for white-on-white or invisible text).
- **Stale data** (KPI shows 8 days old, list says 0 items but you just created one).
- **Missing required field warnings** (a field is required but the form lets you submit without it).

When you find one, write a draft entry to your scratchpad with: title, severity prefix (`Critical:` / `High:` / `Medium:` / `Low:`), persona that hit it, exact URL, numbered repro steps, expected, actual + screenshot, console/network evidence.

---

## Batch posting protocol — CRITICAL

**Whenever your scratchpad contains 5 unposted bugs, immediately post them and clear the scratchpad before continuing testing.** Do NOT wait until the end. Context can be lost at any time; only what's on GitHub survives.

### Posting flow (per bug, repeated 5 times per batch)

1. **Search for duplicates first.** Open https://github.com/Globussoft-Technologies/medcore/issues?q= and search for the most distinctive 3–5 keywords from your title. Search both **open AND closed** issues — closed bugs that have regressed should reopen with a comment, not get a new issue.
2. **If a matching issue exists** (same component, same symptom):
   - Open it.
   - If closed, click "Reopen" first.
   - Comment: `"Regression observed on medcore.globusdemos.com at <ISO timestamp> while testing as <ROLE>. [Steps + screenshot]. Same symptom as the original report; reopening for triage."`
   - Move on. Do NOT open a new issue.
3. **If no match exists**, click "New Issue" and use this template:

```markdown
**Severity:** Critical | High | Medium | Low
**Persona that hit it:** <ROLE>
**URL:** <full path>
**Environment:** medcore.globusdemos.com
**Found at:** <ISO 8601 timestamp>

## Steps to reproduce
1. …
2. …
3. …

## Expected
<one line>

## Actual
<one line + screenshot embedded>

## Console / network evidence
```
<paste error text, status code, response body>
```

## Notes
<anything else useful — affected fields, related KPIs, etc.>
```

Title format: `Severity: Component — short description`. Apply labels: `bug` plus the severity (`critical`/`high`/`medium`/`low`) plus a component tag if obvious (`rbac`, `validation`, `kpi`, `ui`, `workflow`, `i18n`, `dark-mode`).

4. After posting (whether new or comment-on-existing), record in your scratchpad: `[POSTED] #<issue-number> — <title>` so you don't double-post if you re-encounter the same symptom.

### Persistence checkpoint

After each batch of 5 is posted, write a short progress comment on the tracker issue (the one in the "Targets" header above) summarising: which personas you've finished, which pages you've covered, which records you've created, what's next. This is your resume marker if you lose context.

---

## Anti-patterns — do NOT do these

- Do not skip the realistic-data rule. **No `test`, `aaa`, `qwerty`, `1234567890`, `Lorem ipsum`** — ever. If you find yourself typing placeholder garbage, stop and pick a real-looking value instead.
- Do not run any destructive operation (delete patient, drop tenant, force-close another user's session).
- Do not modify production data beyond the minimum needed for a test or a repro. Prefer creating throwaway records over editing real ones.
- Do not file dozens of near-identical bugs — if a pattern appears on 5 pages (e.g. raw-UUID inputs everywhere), file ONE issue listing all 5 occurrences.
- Do not skip the duplicate search. Duplicates are noise.
- Do not include real PII in screenshots — if a screenshot has a real patient name/phone, blur or redact before posting.
- Do not log out without finishing the batch you're on — post first, then sign out.

## Stop conditions

Stop and report back if:
- You hit a hard auth failure and can't sign in.
- The site is unreachable (5xx on every route for >2 min).
- You've completed all 7 personas — at that point post the final partial batch (even if <5) and write a summary comment on the tracker issue with totals.
- You've been running for 4 hours.

## Final report

When you stop (any reason), reply with:
- Total bugs filed (new vs comment-on-existing)
- Personas completed
- Records created (rough count per role)
- Pages covered
- Anything you flagged but couldn't reproduce reliably
- Issue numbers of the 5–10 most severe bugs in priority order

Begin now. First action: log in as ADMIN and walk the sidebar.
````
