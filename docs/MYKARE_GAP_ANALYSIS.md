# MedCore vs Mykare.ai — Gap Analysis + Build Plan

**Source:** Mykare.ai homepage marketing copy + nav (How it Works / Why Mykare / About / Awards), scanned 2026-05-16.
**Purpose:** Identify what Mykare positions that MedCore doesn't (positioning gap) AND what Mykare ships that MedCore doesn't (capability gap), then decide what to build vs what to amplify.

## TL;DR

| Axis | MedCore | Mykare | Verdict |
|---|---|---|---|
| **Clinical depth** | EHR, lab QC, blood bank, ANC, pediatric, immunization, controlled-substance | Not positioned | MedCore wins |
| **Hospital operations** | OPD queue, admissions, OT, ambulance, beds, surgery | Not positioned | MedCore wins |
| **Finance** | GST/CGST/SGST, packages, payment plans, payroll, refunds | Not positioned | MedCore wins |
| **Interop** | ABDM/ABHA, FHIR R4, HL7 v2 inbound | Not positioned | MedCore wins |
| **Multi-tenant** | Self-serve provisioning in one transaction | Not positioned | MedCore wins |
| **AI clinical** | Triage (8 langs), scribe, radiology, drug-safety, chart search | Not positioned at this depth | MedCore wins |
| **AI voice receptionist (inbound)** | ❌ Not built | ✅ 24/7 voice answering | Mykare wins |
| **AI outbound sales agent** | ❌ Not built | ✅ Calls leads, books appts | Mykare wins |
| **International patient coordination** | ❌ Not built | ✅ Visa, currency, flights, hotels | Mykare wins |
| **Healthcare marketing / patient acquisition** | ❌ Not built | ✅ Front-of-funnel framing | Mykare wins |
| **Vision framing** | "Hospital management" (category) | "AI-native OS for healthcare" / "Self-driving clinic" | Mykare wins |
| **TAM-anchored story** | Implied via pricing tiers | Explicit ($200B / 75-80% underserved) | Mykare wins |
| **Three-pillar architecture** | 8 feature buckets, no philosophy | "System of record / action / transaction" | Mykare wins |
| **Compliance badges** | Mentioned in copy | Prominent (HIPAA / VAPT / DPDP) | Mykare wins |
| **Press / awards** | None shown | YourStory, Inc42, Forbes 2023, etc. | Mykare wins |
| **Live demo** | `medcore.globusdemos.com` (real, public) | "Book a Demo" | MedCore wins |

**Net read:** MedCore is more capability-complete on clinical / ops / finance / interop / multi-tenant. Mykare is better positioned and has a real voice-AI / outbound-sales / international-patient surface that MedCore doesn't.

## Positioning gap — fix on the website (this PR)

### Gap 1: Vision framing

**Mykare says** "AI-native operating system for healthcare" + "Self-driving clinic" + product designed by doctors.

**MedCore says** "Hospital management built for Indian hospitals" + "Run your hospital, not spreadsheets."

**Fix:** Add a vision line to the home hero: something like *"The operating system for the 75% of Indian hospitals nobody built software for."* Keep the catchy "Run your hospital, not spreadsheets" as the headline but add a vision subtitle.

### Gap 2: TAM-anchored story

**Mykare says** "India's hospital market is nearly $200B. 80% of facilities run on fragmented workflows. Large PE-backed groups capture 20%; no one is building for the remaining 75-80%."

**MedCore says** Nothing about market structure.

**Fix:** Add a section to the home page (between hero and feature mosaic): a 3-bullet market-framing block ($200B TAM, 80% on fragmented workflows, 75% underserved by legacy + corporate HMS).

### Gap 3: Three-pillar system framing

**Mykare says** "System of record / action / transaction" (slightly contrived but memorable).

**MedCore says** 8 feature buckets (Clinical / Operations / Finance / HR / Engagement / Mobile / AI / Compliance).

**Fix:** Add a "Why MedCore is a system, not a feature list" section to the home page above the feature mosaic. Map MedCore's existing capabilities to the three-pillar framing:
- **System of record** — EHR, audit log, FHIR export, multi-tenant data model
- **System of action** — AI scribe, AI triage, AI radiology, agent console, automated reminders
- **System of transaction** — billing, payment plans, claims auto-draft, refunds, payroll

### Gap 4: Compliance trust badges

**Mykare** displays HIPAA / VAPT / DPDP / certifications visibly.

**MedCore** mentions these in copy but doesn't badge them.

**Fix:** Add a horizontal badge row to the home page footer-area (above the existing `CTASection`): DPDP-compliant, ABDM-ready, FHIR R4, HL7 v2, Razorpay verified webhook, India data residency.

### Gap 5: Honest capability gaps

We don't have voice-AI / outbound-sales / international-patient flows yet. Mykare does. We shouldn't hide that — we should put it on a **public roadmap section** on the features page so prospects know what's coming.

**Fix:** Add a "Coming next quarter" subsection to the features page listing the 4-5 capabilities we're building (see "Capability gap" below).

## Capability gap — engineering build plan

Listed in priority order. Each is a dedicated 1-4 week initiative.

### Build 1: AI Voice Receptionist (inbound) — **highest leverage**

**What:** A 24/7 voice agent that answers the hospital phone line, qualifies the caller (booking / lab report / billing query / emergency triage), books appointments directly into the OPD queue, or hands off to a human in the agent console with full context.

**Why it's high-leverage:**
- Closes the biggest visible Mykare differentiator.
- Hospitals lose ~30% of inbound leads on missed calls (industry data).
- Uses MedCore's existing OPD queue + agent console + Sarvam ASR / 8-language stack — most of the plumbing is already there.

**Build:**
- New service `apps/api/src/services/voice-receptionist.ts` driving a Twilio (or equivalent) voice webhook + Sarvam ASR + Sarvam TTS for the response.
- Reuse `medcore.bot/triage` for the intent classification; add a new `BOOKING` intent that calls the existing `/appointments` API.
- New entity `VoiceCall` + `VoiceCallEvent` for the conversation transcript + audit trail.
- Agent console gets a "Voice call" tab with live transcript + intervention button.

**Est:** 3-4 weeks (1 engineer).

### Build 2: International patient coordination

**What:** A specialised flow for international patients including: visa support letter generation (the doctor + admin sign-off workflow), currency-aware billing (USD/EUR/AED display, payment in INR), and a checklist UX covering flight + hotel + local transport coordination.

**Why:**
- Mykare positions this as a discrete agent type ("International Sales Agent").
- For mid-sized Indian hospitals doing medical tourism, this is a real revenue lever (a single international patient = 5-10x avg domestic ARPU).
- Builds on existing `Patient` + `Appointment` + `Billing` models — incremental, not rewrite.

**Build:**
- New entity `InternationalPatient` with country, visa class, currency, coordinator (User), checklist state.
- PDF template + admin approval workflow for visa support letters (reuse existing PDF infra).
- Currency-aware display layer in billing (server-side conversion via a rates service or admin-set rates).
- Patient-app sub-flow for international tour (translation widget, currency, contacts).

**Est:** 2-3 weeks (1 engineer).

### Build 3: AI Outbound sales / follow-up agent

**What:** An outbound caller (voice + WhatsApp) that contacts new enquiries, qualifies, follows up until booked, and hands off to reception when the patient is on the phone.

**Why:**
- Mykare positions this as a top-3 agent.
- MedCore already has feedback collection + chat agent + WhatsApp templates — extend with outbound dial-out.

**Build:**
- Twilio outbound call API + Sarvam TTS for voice; existing WhatsApp template engine for text.
- New entity `OutboundCampaign` + scheduler (cron, MAX 3 attempts, quiet-hours respected via existing notification orchestrator).
- Agent console: shows live transcript + has a "Take over" button to bridge to a human.

**Est:** 2-3 weeks (1 engineer) — assumes voice receptionist (Build 1) ships first to share infrastructure.

### Build 4: Healthcare marketing / patient acquisition front-of-funnel

**What:** A landing-page builder per hospital (specialty pages, doctor profiles, treatment-cost calculators), with lead capture wired to MedCore's CRM-equivalent (`Patient` records pre-onboarding state).

**Why:**
- Mykare positions "from healthcare marketing, patient acquisition..." as the front of the funnel.
- For clinics, organic SEO on treatment pages drives 40-60% of new patient volume — owning this means MedCore captures the patient earlier in the journey.

**Build:**
- New `apps/marketing-sites` workspace (multi-tenant Next.js with subdomain routing, similar to existing multi-tenant onboarding).
- Templates for: treatment pages, doctor profiles, packages, FAQs, contact forms.
- Lead-capture endpoint → `Lead` entity → reception's queue.
- SEO essentials: sitemaps, schema.org `Hospital` markup, hreflang for international pages.

**Est:** 3-4 weeks (1 engineer + 1 designer).

### Build 5: Named-agent orchestration framework

**What:** Refactor the existing chat / scribe / triage / agent console into a unified "agents" framework so each agent is a first-class product surface with handoffs between them, similar to Mykare's "15+ specialised agents with invisible handoffs" framing.

**Why:** This is mostly a renaming + product-surface exercise, NOT a deep rebuild. The agents already exist (triage = chat agent, scribe = clinical agent, predictions = analytics agent). Naming them and giving each a settings/audit UI brings MedCore's existing AI to feature-parity in *narrative* without major engineering cost.

**Build:**
- New `apps/web/src/app/dashboard/agents/page.tsx` listing all agents with status, last-used, audit-log link.
- Per-agent settings sub-page (prompt registry version, runtime toggle, quiet-hours).
- Update existing AI surfaces to reference their named agent.

**Est:** 1 week (1 engineer).

## Priority sequencing

Best ROI: build in this order.

1. **Gap 1-3 + 5 website fixes** (this PR) — ~half-day, zero engineering cost, unlocks better positioning immediately.
2. **Build 5 (Named-agent orchestration)** — 1 week, mostly UI work; lets the website claims about "AI agents" land on something real.
3. **Build 1 (Voice receptionist)** — 3-4 weeks; closes the single biggest Mykare differentiator.
4. **Build 2 (International patient)** — 2-3 weeks; clear revenue lever for hospitals targeting medical tourism.
5. **Build 3 (Outbound agent)** — 2-3 weeks; reuses Build 1 infrastructure.
6. **Build 4 (Marketing sites)** — 3-4 weeks; biggest scope; ship after the above to drive demand into the now-better product.

**Total runway:** ~12-14 weeks of focused engineering to reach Mykare feature-narrative parity AND keep MedCore's existing depth advantage on clinical + ops + finance + interop.

## What we DON'T need to build

Mykare positions these and we can ignore for now:
- **15+ specialised agents** — naming-game; Build 5 covers this.
- **"Emotion detection" / "Intent classification"** — already implicit in the AI triage + agent console; we just don't badge it.
- **Awards / press kit** — we'll earn these naturally as customers grow; not a website build.

## Out of scope for this PR

- The 5 capability builds — separate engineering work, separate PRDs.
- Rebranding (logo / colour / typography) — current MedCore brand is fine.
- Pricing changes — Mykare doesn't publish pricing; we shouldn't copy.

## Tracking

When the build initiatives start, file them as:
- `BUILD-VOICE` issue → epic linked to Build 1
- `BUILD-INTL` issue → epic linked to Build 2
- `BUILD-OUTBOUND` issue → epic linked to Build 3
- `BUILD-MARKETING` issue → epic linked to Build 4
- `BUILD-AGENTS` issue → epic linked to Build 5
