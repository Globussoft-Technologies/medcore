import { tenantScopedPrisma as prisma } from "../tenant-prisma";
import { generateText } from "./sarvam";
import { sanitizeUserInput } from "./prompt-safety";

/**
 * Shape of an individual line item flagged by the explainer as needing
 * attention — e.g. a charge that insurance likely won't cover, or an
 * unusually high item.
 */
export interface FlaggedBillItem {
  description: string;
  amount: number;
  reason: string;
}

export interface BillExplanationResult {
  content: string;
  flaggedItems: FlaggedBillItem[];
  language: "en" | "hi";
}

const SYSTEM_PROMPT =
  "You are MedCore's patient billing assistant. Translate the structured invoice + insurance snapshot below into a warm, plain-language explanation (NOT financial advice) that helps a patient understand what each line item is, what their insurance will likely cover, and their out-of-pocket estimate. Use short sentences. If any item seems unusual or likely to be disputed with insurance, call it out in a separate 'Items to check' section at the end. Never recommend payment dispute action; instead end with 'Please speak to our billing desk if you have questions.'";

/**
 * Heuristic flagging pass that runs BEFORE the LLM call so that even if Sarvam
 * is offline, the HITL reviewer still sees a list of items worth checking.
 * Flags items that look disproportionately large (>50% of subtotal) or that
 * share categories known to be insurance-excluded.
 */
function heuristicFlag(items: {
  description: string;
  amount: number;
  category: string;
}[], subtotal: number): FlaggedBillItem[] {
  const flags: FlaggedBillItem[] = [];
  const subtotalSafe = Math.max(subtotal, 1);
  const disputableCats = new Set(["MEDICINE", "CONSUMABLE", "NON_MEDICAL"]);

  for (const item of items) {
    if (item.amount / subtotalSafe > 0.5 && items.length > 1) {
      flags.push({
        description: item.description,
        amount: item.amount,
        reason: "Single item is >50% of total — double-check with billing desk",
      });
    }
    if (disputableCats.has((item.category || "").toUpperCase())) {
      flags.push({
        description: item.description,
        amount: item.amount,
        reason: "Category often not covered by standard insurance plans",
      });
    }
  }

  return flags;
}

/**
 * Resolve language preference for a patient (en | hi). Falls back to "en".
 */
async function resolveLanguage(patientId: string): Promise<"en" | "hi"> {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { preferredLanguage: true },
  });
  return patient?.preferredLanguage === "hi" ? "hi" : "en";
}

/**
 * Generate a plain-language bill explanation for an invoice. Reads the
 * invoice + its line items and the patient's stored insurance snapshot and
 * calls Sarvam to produce a patient-friendly narrative. Returns the
 * generated content plus any line items the heuristic flagger marked.
 *
 * The explanation is NOT persisted by this function — the route handler is
 * responsible for creating the `BillExplanation` record.
 */
export async function generateBillExplanation(
  invoiceId: string
): Promise<BillExplanationResult> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      items: true,
      patient: {
        select: {
          id: true,
          insuranceProvider: true,
          insurancePolicyNumber: true,
          preferredLanguage: true,
        },
      },
    },
  });

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  const language = (invoice.patient?.preferredLanguage === "hi" ? "hi" : "en") as
    | "en"
    | "hi";

  const items = invoice.items.map((it: any) => ({
    description: it.description,
    category: it.category,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    amount: it.amount,
  }));

  // Issue #901: Invoice.subtotal is Prisma.Decimal — coerce for heuristic.
  const subN = typeof (invoice.subtotal as unknown) === "number"
    ? (invoice.subtotal as unknown as number)
    : (invoice.subtotal as unknown as { toNumber: () => number }).toNumber();
  const flaggedItems = heuristicFlag(items, subN);

  const insuranceLine = invoice.patient?.insuranceProvider
    ? `Insurance: ${sanitizeUserInput(invoice.patient.insuranceProvider, { maxLen: 120 })} (policy ${sanitizeUserInput(invoice.patient.insurancePolicyNumber ?? "not recorded", { maxLen: 80 })})`
    : "Insurance: not on file — full amount is payable by the patient.";

  const itemLines = items
    .map(
      (it) =>
        `- ${sanitizeUserInput(it.description, { maxLen: 200 })} [${sanitizeUserInput(it.category || "GENERAL", { maxLen: 40 })}] x${it.quantity} @ ₹${it.unitPrice} = ₹${it.amount}`
    )
    .join("\n");

  const totals = `Subtotal: ₹${invoice.subtotal}\nDiscount: ₹${invoice.discountAmount}\nCGST: ₹${invoice.cgstAmount}\nSGST: ₹${invoice.sgstAmount}\nTotal payable: ₹${invoice.totalAmount}`;

  const userPrompt = `INVOICE ${sanitizeUserInput(invoice.invoiceNumber, { maxLen: 80 })}
${insuranceLine}

LINE ITEMS:
${itemLines}

TOTALS:
${totals}

Write a patient-friendly explanation. ${language === "hi" ? "Respond in Hindi." : "Respond in English."} Use 3-5 short paragraphs covering: 1) what this bill is for, 2) a breakdown of major line items, 3) what insurance will typically cover, 4) estimated out-of-pocket, 5) items to double-check if any. End with the billing-desk suggestion.`;

  const content = await generateText({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1024,
    temperature: 0.3,
  });

  // If Sarvam is offline, generateText returns "" — provide a minimal
  // deterministic fallback so the HITL reviewer still gets something to send.
  const finalContent =
    content && content.trim().length > 0
      ? content
      : `Your invoice ${invoice.invoiceNumber} totals ₹${invoice.totalAmount}. ${invoice.patient?.insuranceProvider ? `Your ${invoice.patient.insuranceProvider} insurance may cover a portion of eligible items.` : "This amount is payable in full as no insurance is on file."} Please speak to our billing desk if you have questions.`;

  return {
    content: finalContent,
    flaggedItems,
    language,
  };
}

// re-export so tests can override if needed
export { resolveLanguage };
