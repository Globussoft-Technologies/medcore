import type { Metadata } from "next";
import {
  LegalH1,
  LegalH2,
  LegalP,
  LegalUL,
  LegalEffective,
} from "../_components/Prose";

export const metadata: Metadata = {
  title: "Privacy Policy — MedCore",
  description:
    "How MedCore Health collects, uses, stores, and protects your personal and medical information under India's DPDP Act 2023.",
};

export default function PrivacyPage() {
  return (
    <article>
      <LegalH1>Privacy Policy</LegalH1>
      <LegalEffective date="28 May 2026" />

      <LegalP>
        MedCore Health (&ldquo;MedCore&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) provides hospital
        and clinic information systems to healthcare providers across India. This
        Privacy Policy explains what personal and medical information we collect
        when you interact with a MedCore-powered hospital, how we use it, and the
        rights you have under the Digital Personal Data Protection Act, 2023
        (&ldquo;DPDP Act&rdquo;).
      </LegalP>

      <LegalH2>1. Who is responsible for your data</LegalH2>
      <LegalP>
        Your hospital or clinic is the <strong>Data Fiduciary</strong> for the medical
        records created during your care. MedCore acts as a <strong>Data Processor</strong>{" "}
        on the hospital&rsquo;s behalf and only processes your information per the
        hospital&rsquo;s written instructions. See our{" "}
        <a href="/legal/data-processing" className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
          Data Processing Notice
        </a>{" "}
        for the technical and contractual safeguards involved.
      </LegalP>

      <LegalH2>2. What we collect</LegalH2>
      <LegalUL>
        <li>
          <strong>Identity:</strong> name, gender, date of birth, MR number, photograph
          (optional), Aadhaar / ABHA number (when you choose to link it).
        </li>
        <li>
          <strong>Contact:</strong> phone, email, address, emergency contact.
        </li>
        <li>
          <strong>Clinical:</strong> visits, diagnoses, prescriptions, lab results,
          imaging (X-ray, CT, MRI, ultrasound), vitals, allergies, immunisations.
        </li>
        <li>
          <strong>Financial:</strong> bills, payments, insurance policy details, claims.
        </li>
        <li>
          <strong>Operational telemetry:</strong> device type, browser, IP address,
          session timing. Used only for security and reliability.
        </li>
      </LegalUL>

      <LegalH2>3. How we use it</LegalH2>
      <LegalUL>
        <li>Deliver care: booking, consultations, prescriptions, diagnostics.</li>
        <li>Bill and accept payment for the services you receive.</li>
        <li>
          Send appointment reminders, prescription notices, report-ready alerts,
          and payment receipts via SMS, WhatsApp, push notification, or email — you
          can opt out of any channel at any time.
        </li>
        <li>Comply with statutory record-keeping under the NMC, NABH, and DPDP Act.</li>
        <li>
          Improve clinical-AI features (e.g. radiology drafting, triage routing).
          Personally identifying details are stripped before any model training.
        </li>
      </LegalUL>

      <LegalH2>4. Who we share it with</LegalH2>
      <LegalUL>
        <li>
          Clinicians, nurses, and authorised staff at your hospital, scoped by role.
        </li>
        <li>
          The Ayushman Bharat Digital Mission (ABDM) gateway when you explicitly
          link your ABHA and grant consent for record exchange.
        </li>
        <li>Insurance partners only when you submit a cashless / claim request.</li>
        <li>
          Payment processors (Razorpay) to collect bills. Card and UPI credentials
          never touch MedCore servers.
        </li>
        <li>Government authorities when compelled by valid legal process.</li>
      </LegalUL>

      <LegalH2>5. Your rights under the DPDP Act</LegalH2>
      <LegalUL>
        <li>Access a copy of the personal data we hold about you.</li>
        <li>Correct inaccurate or outdated information.</li>
        <li>
          Erase data that is no longer required for the purpose for which it was
          collected (subject to medical retention rules).
        </li>
        <li>Withdraw consent to non-essential processing (e.g. marketing).</li>
        <li>Nominate another person to exercise your rights on your behalf.</li>
        <li>
          Lodge a complaint with the Data Protection Board of India if you believe
          your rights have been violated.
        </li>
      </LegalUL>
      <LegalP>
        To exercise these rights, email{" "}
        <a href="mailto:support@medcore.software" className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
          support@medcore.software
        </a>{" "}
        with the subject line &ldquo;DPDP request&rdquo;. We respond within 30 days.
      </LegalP>

      <LegalH2>6. How long we keep it</LegalH2>
      <LegalP>
        Medical records are retained for the minimum period mandated by the
        Indian Medical Council Act and your hospital&rsquo;s NABH retention schedule
        (typically 3&nbsp;years for outpatient records, 10&nbsp;years for in-patient
        records, lifetime for paediatric records). Non-clinical telemetry is
        purged within 90 days unless required for a security investigation.
      </LegalP>

      <LegalH2>7. Children</LegalH2>
      <LegalP>
        Care for patients under 18 requires verifiable consent from a parent or
        legal guardian, captured at registration. Marketing communications are
        never sent to minors.
      </LegalP>

      <LegalH2>8. Cross-border transfers</LegalH2>
      <LegalP>
        Personal data is stored in MedCore&rsquo;s India region (ap-south-1). AI
        features that route to OpenAI may transfer de-identified content
        internationally; full identifiers (name, MRN, phone, address) are stripped
        before any such transfer.
      </LegalP>

      <LegalH2>9. Updates</LegalH2>
      <LegalP>
        We update this policy when our practices change. If a change is material
        (e.g. a new category of recipient), we notify you in-app and by SMS at
        least 14 days before it takes effect. The current version is always
        available at <code>/legal/privacy</code>.
      </LegalP>

      <LegalH2>10. Contact</LegalH2>
      <LegalP>
        {/* <strong>Grievance Officer:</strong> Dr. Anika Reddy */}
        {/* <br /> */}
        Email:{" "}
        <a href="mailto:support@medcore.software" className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
          support@medcore.software
        </a>
        <br />
        Postal address: MedCore Health Technologies Pvt. Ltd., 4th Floor, Prestige
        Atlanta, Koramangala, Bengaluru 560034, India.
      </LegalP>
    </article>
  );
}
