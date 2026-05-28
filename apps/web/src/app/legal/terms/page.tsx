import type { Metadata } from "next";
import {
  LegalH1,
  LegalH2,
  LegalP,
  LegalUL,
  LegalEffective,
} from "../_components/Prose";

export const metadata: Metadata = {
  title: "Terms of Service — MedCore",
  description:
    "The rules that govern your use of MedCore patient portal, AI booking, and connected services.",
};

export default function TermsPage() {
  return (
    <article>
      <LegalH1>Terms of Service</LegalH1>
      <LegalEffective date="28 May 2026" />

      <LegalP>
        These Terms govern your use of the MedCore patient portal, AI-assisted
        booking, ABHA linking, and other features (collectively, &ldquo;the Service&rdquo;).
        By creating an account or booking an appointment through MedCore, you
        agree to be bound by them. If you do not agree, please do not use the
        Service.
      </LegalP>

      <LegalH2>1. Eligibility</LegalH2>
      <LegalUL>
        <li>You must be 18 years or older to create an account.</li>
        <li>
          Patients under 18 may use the Service through a parent or legal
          guardian&rsquo;s account.
        </li>
        <li>
          You agree to provide accurate, current information at registration and
          to keep it updated.
        </li>
      </LegalUL>

      <LegalH2>2. The Service is not a substitute for medical advice</LegalH2>
      <LegalP>
        MedCore is a hospital information system. The AI features — including
        symptom triage, doctor routing, and report drafting — are <strong>decision-support
        tools for clinicians</strong>, not a substitute for professional medical
        diagnosis or treatment. Every AI-generated draft is reviewed and signed
        by a qualified human before it is treated as a final report.
      </LegalP>
      <LegalP>
        <strong>In a medical emergency, call 112 or go to the nearest emergency department
        immediately.</strong> Do not rely on the chat to route emergencies.
      </LegalP>

      <LegalH2>3. Your account</LegalH2>
      <LegalUL>
        <li>You are responsible for keeping your login credentials confidential.</li>
        <li>
          Notify us within 24 hours if you suspect your account has been accessed
          by anyone else.
        </li>
        <li>
          We may suspend an account that we reasonably believe has been used to
          impersonate, defraud, or harm another person.
        </li>
      </LegalUL>

      <LegalH2>4. Appointments, bookings, cancellations</LegalH2>
      <LegalUL>
        <li>
          Booking creates a contract between you and the treating hospital, not
          MedCore. Hospital cancellation, no-show, and refund policies apply.
        </li>
        <li>
          You agree to receive appointment reminders by SMS, WhatsApp, push, or
          email. You can opt out of non-essential channels from your profile.
        </li>
        <li>
          Repeated no-shows may result in the hospital declining future online
          bookings until you confirm by phone.
        </li>
      </LegalUL>

      <LegalH2>5. Payments</LegalH2>
      <LegalUL>
        <li>
          Bills are issued by the treating hospital. MedCore is not a party to
          the financial transaction.
        </li>
        <li>
          Payments are processed by Razorpay under their own terms. We do not
          store full card or UPI details.
        </li>
        <li>
          Refund decisions rest with the hospital. We can only forward refund
          requests on your behalf.
        </li>
      </LegalUL>

      <LegalH2>6. Acceptable use</LegalH2>
      <LegalP>You agree not to:</LegalP>
      <LegalUL>
        <li>Use the Service to harass, defame, or threaten any user or staff member.</li>
        <li>
          Upload content that infringes someone else&rsquo;s rights, contains malware,
          or is otherwise unlawful.
        </li>
        <li>
          Attempt to access another patient&rsquo;s record, bypass authentication,
          probe for vulnerabilities, or interfere with the integrity of the
          system.
        </li>
        <li>
          Use automated tools (scrapers, bots) to extract data, except where we
          provide a documented API.
        </li>
      </LegalUL>

      <LegalH2>7. AI features</LegalH2>
      <LegalP>
        AI booking, AI radiology drafting, ambient scribe, differential
        suggestions and similar features are provided on an &ldquo;as-is&rdquo; basis.
        Confidence scores are estimates, not guarantees. A clinician&rsquo;s
        independent judgement always overrides the AI output before it affects
        your care.
      </LegalP>

      <LegalH2>8. Intellectual property</LegalH2>
      <LegalP>
        The Service, including its design, code, and content (other than your
        medical records and content you upload), is owned by MedCore Health
        Technologies Pvt. Ltd. You receive a personal, non-exclusive,
        non-transferable licence to use the Service for its intended purpose.
      </LegalP>

      <LegalH2>9. Disclaimers and liability</LegalH2>
      <LegalP>
        To the extent permitted by law, the Service is provided &ldquo;as is&rdquo;,
        without warranties of any kind. MedCore is not liable for any indirect,
        incidental, or consequential loss arising from your use of the Service.
        Our aggregate liability for any direct loss is capped at the fees you
        paid for the Service in the preceding twelve months, or ₹10,000,
        whichever is higher.
      </LegalP>
      <LegalP>
        Nothing in these Terms limits liability that cannot be limited by
        Indian law — including liability for death, personal injury caused by
        negligence, or fraud.
      </LegalP>

      <LegalH2>10. Termination</LegalH2>
      <LegalP>
        You may close your account at any time from your profile. We may
        suspend or close an account that breaches these Terms, with reasonable
        notice except where immediate suspension is required to protect another
        user or the integrity of the system. On closure, your medical records
        are retained per the hospital&rsquo;s statutory retention schedule (see the{" "}
        <a href="/legal/privacy" className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
          Privacy Policy
        </a>
        ).
      </LegalP>

      <LegalH2>11. Governing law and disputes</LegalH2>
      <LegalP>
        These Terms are governed by Indian law. Any dispute arising out of the
        Service is subject to the exclusive jurisdiction of the courts at
        Bengaluru, Karnataka. Before litigation, you agree to attempt
        good-faith resolution by emailing{" "}
        <a href="mailto:support@medcore.software" className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
          support@medcore.software
        </a>
        .
      </LegalP>

      <LegalH2>12. Changes</LegalH2>
      <LegalP>
        We may update these Terms from time to time. Material changes are
        notified in-app at least 14 days before they take effect. Continued use
        after the effective date constitutes acceptance.
      </LegalP>
    </article>
  );
}
