import type { Metadata } from "next";
import {
  LegalH1,
  LegalH2,
  LegalP,
  LegalUL,
  LegalEffective,
} from "../_components/Prose";

export const metadata: Metadata = {
  title: "Data Processing Notice — MedCore",
  description:
    "Technical safeguards, sub-processors, and the data-processing arrangement between hospitals and MedCore Health.",
};

export default function DataProcessingPage() {
  return (
    <article>
      <LegalH1>Data Processing Notice</LegalH1>
      <LegalEffective date="28 May 2026" />

      <LegalP>
        This notice describes the technical and contractual arrangement under
        which MedCore Health (&ldquo;Processor&rdquo;) handles personal data on behalf of
        a treating hospital or clinic (&ldquo;Fiduciary&rdquo;) — including the
        sub-processors involved, the security controls in place, and the
        breach-notification commitments we make under the DPDP Act, 2023.
      </LegalP>

      <LegalH2>1. Roles</LegalH2>
      <LegalUL>
        <li>
          <strong>You</strong> are the data principal — the person whose data is
          being processed.
        </li>
        <li>
          <strong>Your hospital</strong> is the data fiduciary — it determines
          why and how your medical record is created and maintained.
        </li>
        <li>
          <strong>MedCore</strong> is the data processor — we operate the
          software platform under a written agreement with the hospital, and we
          process your data only on its documented instructions.
        </li>
      </LegalUL>

      <LegalH2>2. Categories of data processed</LegalH2>
      <LegalUL>
        <li>Identity + contact details (name, MRN, phone, email, address).</li>
        <li>Clinical records (diagnoses, prescriptions, lab, imaging, vitals).</li>
        <li>Financial records (bills, payments, claims).</li>
        <li>Authentication and audit logs (login times, IP, device, actions taken).</li>
        <li>
          When you opt in: ABHA number / address, linked under ABDM&rsquo;s consent
          framework.
        </li>
      </LegalUL>

      <LegalH2>3. Purposes</LegalH2>
      <LegalUL>
        <li>Care delivery — bookings, consultations, prescriptions, diagnostics.</li>
        <li>Revenue cycle — bills, payments, insurance claims.</li>
        <li>Communication — appointment reminders, report-ready alerts, receipts.</li>
        <li>Statutory compliance — record retention under NMC / NABH / DPDP.</li>
        <li>
          Safety + integrity — audit logging, fraud detection, anomaly
          monitoring.
        </li>
      </LegalUL>

      <LegalH2>4. Sub-processors</LegalH2>
      <LegalP>
        The following third parties may process limited categories of data on
        our behalf, each under a written agreement that mirrors our own DPDP
        obligations:
      </LegalP>
      <LegalUL>
        <li>
          <strong>AWS (ap-south-1, Mumbai)</strong> — infrastructure hosting and
          object storage. All data at rest is encrypted with AES-256.
        </li>
        <li>
          <strong>Razorpay</strong> — payment processing for hospital bills.
          Card and UPI credentials never touch MedCore servers.
        </li>
        <li>
          <strong>Sarvam AI (India)</strong> — Indian-region LLM used for triage,
          summarisation, and translation. Receives only de-identified content.
        </li>
        <li>
          <strong>OpenAI (US)</strong> — vision-capable LLM used for radiology
          drafting. Identifiers (name, MRN, phone, address) are stripped before
          any image or text leaves our servers.
        </li>
        <li>
          <strong>SendGrid (Twilio)</strong> — transactional email delivery
          (receipts, reminders).
        </li>
        <li>
          <strong>Firebase Cloud Messaging (Google)</strong> — push notification
          delivery to the patient PWA.
        </li>
        <li>
          <strong>Sentry</strong> — error and performance monitoring. PHI is
          scrubbed by the client SDK before transmission.
        </li>
        <li>
          <strong>ABDM Gateway (Govt. of India)</strong> — only when you
          explicitly link your ABHA and consent to record exchange.
        </li>
      </LegalUL>
      <LegalP>
        The current sub-processor list is maintained at this URL. We give at
        least 30 days&rsquo; notice before adding a new sub-processor in a way that
        materially changes the data flow.
      </LegalP>

      <LegalH2>5. Security measures</LegalH2>
      <LegalUL>
        <li>TLS 1.3 in transit; AES-256 at rest.</li>
        <li>
          Role-based access control: every clinician sees only what their role +
          tenant context allows.
        </li>
        <li>
          Multi-tenant isolation enforced at the database query layer
          (Prisma extension), not just at the application layer.
        </li>
        <li>
          Append-only audit log — every read or write of clinical data is
          recorded and tamper-evident.
        </li>
        <li>
          httpOnly JWT cookies + double-submit CSRF token on every mutation.
        </li>
        <li>
          Automated dependency vulnerability scanning, with high/critical
          patches applied within 7 days.
        </li>
        <li>
          Penetration testing by an independent firm at least annually; report
          summary available to enterprise customers on request.
        </li>
      </LegalUL>

      <LegalH2>6. Data location and transfers</LegalH2>
      <LegalP>
        Primary storage and backups are located in AWS ap-south-1 (Mumbai).
        Cross-border transfers occur only to the sub-processors listed in
        section 4 and only with the identifier stripping described there.
      </LegalP>

      <LegalH2>7. Retention</LegalH2>
      <LegalUL>
        <li>Clinical records: per your hospital&rsquo;s NABH retention schedule.</li>
        <li>Audit logs: 7 years.</li>
        <li>Operational telemetry: 90 days.</li>
        <li>
          On termination of the hospital&rsquo;s contract with MedCore, data is
          exported back to the hospital within 60 days and then securely
          deleted from MedCore systems.
        </li>
      </LegalUL>

      <LegalH2>8. Personal data breach notification</LegalH2>
      <LegalP>
        If we become aware of a personal data breach affecting your information,
        we will notify the data fiduciary (your hospital) without undue delay,
        and in any event within 72 hours of awareness. The hospital is then
        responsible for notifying you and the Data Protection Board of India in
        line with section 8(6) of the DPDP Act.
      </LegalP>

      <LegalH2>9. Your rights — how requests are routed</LegalH2>
      <LegalP>
        Because the hospital is the fiduciary, DPDP rights requests (access,
        correction, erasure, withdrawal of consent, nomination) are usually
        directed to the hospital. If you contact MedCore directly we forward
        your request to the relevant hospital within 5 business days and
        confirm the routing back to you.
      </LegalP>

      <LegalH2>10. Contact</LegalH2>
      <LegalP>
        {/* <strong>Data Protection Officer:</strong> Karan Mehta */}
        <br />
        Email:{" "}
        <a
          href="mailto:support@medcore.software"
          className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
        >
          support@medcore.software
        </a>
        <br />
        Postal address: MedCore Health Technologies Pvt. Ltd., 4th Floor,
        Prestige Atlanta, Koramangala, Bengaluru 560034, India.
      </LegalP>
    </article>
  );
}
