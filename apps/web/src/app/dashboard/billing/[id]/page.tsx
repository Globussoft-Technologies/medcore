"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, openPrintEndpoint } from "@/lib/api";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useTranslation } from "@/lib/i18n";
import { useAuthStore } from "@/lib/store";
import { extractFieldErrors } from "@/lib/field-errors";
import {
  categorizeService,
  computeInvoiceTotals,
  computeLineItemTax,
  derivePaymentStatus,
  formatQuantityWithUnit,
} from "@medcore/shared";
import {
  Printer,
  ArrowLeft,
  Plus,
  Trash2,
  Percent,
  Undo2,
  Receipt,
  CreditCard,
  X,
  Globe,
} from "lucide-react";
import { SkeletonCard } from "@/components/Skeleton";
import { fetchRazorpayConfig, openRazorpayCheckout } from "@/lib/razorpay";
import NHCXStepper from "@/components/NHCXStepper";

interface HospitalProfile {
  name: string;
  address: string;
  phone: string;
  email: string;
  gstin: string;
  registration: string;
  tagline: string;
  logoUrl: string;
}

const DEFAULT_HOSPITAL: HospitalProfile = {
  name: "MedCore Hospital & Diagnostics",
  address: "42 Linking Road, Bandra West, Mumbai, Maharashtra 400050",
  phone: "+91-80-2345-6789",
  email: "info@medcorehospital.in",
  gstin: "27AAACM1234Z1Z5",
  registration: "",
  tagline: "Hospital Operations Automation",
  logoUrl: "",
};

interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  paymentStatus: string;
  lateFeeAmount: number;
  lateFeeAppliedAt?: string | null;
  notes: string | null;
  createdAt: string;
  patient: {
    id: string;
    mrNumber: string;
    age: number | null;
    gender: string;
    user: { name: string; phone: string; email: string };
  };
  appointment?: {
    date: string;
    doctor: { user: { name: string }; specialization: string };
  };
  items: Array<{
    id: string;
    description: string;
    category: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    mode: string;
    paidAt: string;
    transactionId: string | null;
  }>;
  // Pearl §4.2 — InsuranceClaim rows returned by GET /billing/invoices/:id
  // (apps/api/src/routes/billing.ts:744). Legacy ClaimStatus enum shape
  // (SUBMITTED / APPROVED / REJECTED / SETTLED); NHCXStepper tolerates
  // the richer NormalisedClaimStatus too.
  insuranceClaims?: Array<{
    id: string;
    status: string;
    insuranceProvider?: string | null;
    claimAmount?: number | null;
    approvedAmount?: number | null;
  }> | null;
}

const REFUND_PREFIX = "REFUND:";

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}


export default function InvoiceDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const confirm = useConfirm();
  const { t } = useTranslation();
  // Issue #861: cashier controls (Apply Discount, Record Payment, Record
  // Refund, Create Plan) must never render for PATIENT role. Even though
  // the API enforces RBAC, exposing the buttons in a patient UI is a
  // trust + UX defect — the patient sees admin-shaped controls, clicks
  // them, gets confusing error toasts. Gate everything off `isStaff`
  // below; PATIENT (and any other non-staff role) only sees Print +
  // Pay Online + Back.
  const { user } = useAuthStore();
  const isStaff = user?.role === "ADMIN" || user?.role === "RECEPTION";
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [hospital, setHospital] = useState<HospitalProfile>(DEFAULT_HOSPITAL);
  // Expand the combined "Consultation Charge" line into its date-wise
  // per-doctor breakdown so the patient can verify each consult.
  const [consultOpen, setConsultOpen] = useState(false);

  // Add item form
  const [newDesc, setNewDesc] = useState("");
  const [newCategory, setNewCategory] = useState("CONSULTATION");
  // Tracks whether the user has manually overridden the auto-derived category.
  // Once they touch the dropdown, we stop overwriting it on description edits.
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [newQty, setNewQty] = useState("1");
  const [newPrice, setNewPrice] = useState("");
  const [adding, setAdding] = useState(false);

  // Discount modal
  const [discOpen, setDiscOpen] = useState(false);
  const [discType, setDiscType] = useState<"percentage" | "flat">("percentage");
  const [discValue, setDiscValue] = useState("");
  const [discReason, setDiscReason] = useState("");
  const [discSubmitting, setDiscSubmitting] = useState(false);

  // Record payment
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMode, setPayMode] = useState("CASH");
  const [paySubmitting, setPaySubmitting] = useState(false);
  // Issue #223: per-field server validation messages for the payment modal.
  const [payFieldErrors, setPayFieldErrors] = useState<
    Record<string, string>
  >({});

  // Refund
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMode, setRefundMode] = useState("CASH");
  const [refundReason, setRefundReason] = useState("");
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  // Pending discount approvals + payment plan modal
  const [pendingApprovals, setPendingApprovals] = useState<Array<{
    id: string;
    amount: number;
    percentage?: number | null;
    reason: string;
  }>>([]);
  const [planOpen, setPlanOpen] = useState(false);

  // Razorpay availability — server tells us whether keys are configured + test mode.
  const [razorpay, setRazorpay] = useState<{
    enabled: boolean;
    isTestMode: boolean;
  }>({ enabled: false, isTestMode: false });
  const [payingOnline, setPayingOnline] = useState(false);

  // Partial-payment picker (A1). Opens before Razorpay so the caller can
  // choose how much to charge. `payOnlineAmount` defaults to the full
  // remaining balance; user can lower it.
  const [payOnlineOpen, setPayOnlineOpen] = useState(false);
  const [payOnlineAmount, setPayOnlineAmount] = useState("");

  const loadInvoice = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: InvoiceDetail }>(
        `/billing/invoices/${id}`
      );
      setInvoice(res.data);
      try {
        const a = await api.get<{
          data: Array<{
            id: string;
            amount: number;
            percentage?: number | null;
            reason: string;
          }>;
        }>(`/billing/discount-approvals?status=PENDING&invoiceId=${id}`);
        setPendingApprovals(a.data || []);
      } catch {
        setPendingApprovals([]);
      }
      // Hospital profile — independent best-effort fetch. We keep the
      // default identity values if the API is unavailable so the invoice
      // header never shows "+91-XXXXXXXXXX" style placeholders.
      try {
        const h = await api.get<{ data: HospitalProfile }>(
          `/billing/hospital-profile`
        );
        if (h?.data) setHospital(h.data);
      } catch {
        setHospital(DEFAULT_HOSPITAL);
      }
    } catch {
      // empty
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    loadInvoice();
  }, [loadInvoice]);

  // Best-effort: tells us whether to render the Pay-Online button + TEST badge.
  useEffect(() => {
    fetchRazorpayConfig().then(setRazorpay).catch(() => {
      setRazorpay({ enabled: false, isTestMode: false });
    });
  }, []);

  // Razorpay handler — used by:
  //   1. Standalone "Pay Online" button via the amount-picker modal (A1).
  //   2. The existing Record-Payment modal when mode=ONLINE (A2).
  // `amount` is optional: omitted → full balance, provided → that exact
  // partial. Server validates the cap so a tampered client can't overpay.
  const payOnline = useCallback(
    async (amount?: number) => {
      if (!invoice) return;
      if (!razorpay.enabled) {
        toast.error("Online payments are not configured. Use Cash or Card.");
        return;
      }
      setPayingOnline(true);
      setPayOpen(false);
      setPayOnlineOpen(false);
      try {
        await openRazorpayCheckout({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          amount,
          patient: {
            name: invoice.patient.user.name,
            email: invoice.patient.user.email,
            phone: invoice.patient.user.phone,
          },
          onSuccess: () => {
            toast.success("Payment captured");
            loadInvoice();
          },
          onFailure: (reason) => {
            if (reason !== "Payment cancelled") toast.error(reason);
          },
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Online payment failed");
      } finally {
        setPayingOnline(false);
      }
    },
    [invoice, razorpay.enabled, loadInvoice]
  );

  // A1: open the amount-picker modal pre-filled with the full remaining
  // balance. Called by the standalone "Pay Online" action-bar button.
  // `balance` is computed in render scope, so we just trust the click
  // origin to pass it. We keep the picker open until the user confirms.
  function openPayOnlinePicker(remainingBalance: number) {
    setPayOnlineAmount(String(remainingBalance.toFixed(2)));
    setPayOnlineOpen(true);
  }

  async function addItem() {
    if (!newDesc.trim()) {
      toast.error("Description is required for the line item");
      return;
    }
    const qty = parseInt(newQty || "0", 10);
    const price = parseFloat(newPrice || "0");
    if (Number.isNaN(qty) || qty < 1) {
      toast.error("Quantity must be at least 1");
      return;
    }
    if (Number.isNaN(price) || price <= 0) {
      toast.error("Unit price must be greater than 0");
      return;
    }
    setAdding(true);
    try {
      await api.post(`/billing/invoices/${id}/items`, {
        description: newDesc,
        category: newCategory,
        quantity: parseInt(newQty),
        unitPrice: parseFloat(newPrice),
      });
      setNewDesc("");
      setNewQty("1");
      setNewPrice("");
      setNewCategory("CONSULTATION");
      setCategoryTouched(false);
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add item");
    }
    setAdding(false);
  }

  // When the user edits the description, auto-derive the category via
  // the shared `categorizeService` helper — unless they've manually
  // touched the Category dropdown (then we respect the override).
  function onDescriptionChange(value: string) {
    setNewDesc(value);
    if (!categoryTouched) {
      const suggested = categorizeService(value);
      setNewCategory(suggested);
    }
  }

  function onCategoryChange(value: string) {
    setCategoryTouched(true);
    setNewCategory(value);
  }

  async function removeItem(itemId: string) {
    if (!(await confirm({ title: "Remove this line item?", danger: true }))) return;
    try {
      await api.delete(`/billing/invoices/${id}/items/${itemId}`);
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove item");
    }
  }

  async function submitDiscount() {
    setDiscSubmitting(true);
    try {
      const body: Record<string, unknown> = { reason: discReason };
      if (discType === "percentage") body.percentage = parseFloat(discValue);
      else body.flatAmount = parseFloat(discValue);
      await api.post(`/billing/invoices/${id}/discount`, body);
      setDiscOpen(false);
      setDiscValue("");
      setDiscReason("");
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discount failed");
    }
    setDiscSubmitting(false);
  }

  async function submitPayment() {
    // If the user picked ONLINE in the modal, hand off to Razorpay instead
    // of recording a manual payment row. The amount they typed in the modal
    // becomes the partial-payment value sent to /pay-online — backend caps
    // at the remaining balance and rejects nonsense values.
    if (payMode === "ONLINE") {
      const parsed = parseFloat(payAmount);
      if (Number.isNaN(parsed) || parsed <= 0) {
        toast.error("Enter a valid amount to pay online");
        return;
      }
      payOnline(parsed);
      return;
    }
    setPaySubmitting(true);
    setPayFieldErrors({});
    try {
      await api.post("/billing/payments", {
        invoiceId: id,
        amount: parseFloat(payAmount),
        mode: payMode,
      });
      setPayOpen(false);
      setPayAmount("");
      setPayMode("CASH");
      loadInvoice();
    } catch (err) {
      // Issue #223: surface per-field zod messages instead of just a
      // generic toast — the user needs to know whether it's `amount`
      // (e.g. exceeds outstanding balance) or `mode` that the API
      // rejected.
      const fields = extractFieldErrors(err);
      if (fields) {
        setPayFieldErrors(fields);
        toast.error(Object.values(fields)[0] || "Please fix the highlighted fields");
      } else {
        toast.error(err instanceof Error ? err.message : "Payment failed");
      }
    }
    setPaySubmitting(false);
  }

  async function submitRefund() {
    setRefundSubmitting(true);
    try {
      await api.post("/billing/refunds", {
        invoiceId: id,
        amount: parseFloat(refundAmount),
        reason: refundReason,
        mode: refundMode,
      });
      setRefundOpen(false);
      setRefundAmount("");
      setRefundReason("");
      setRefundMode("CASH");
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refund failed");
    }
    setRefundSubmitting(false);
  }

  if (loading) {
    return (
      <div
        data-testid="invoice-detail-loading"
        aria-busy="true"
        className="space-y-3 p-4"
      >
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">Invoice not found</p>
        <Link
          href="/dashboard/billing"
          className="mt-4 inline-block text-primary hover:underline"
        >
          Back to Billing
        </Link>
      </div>
    );
  }

  // Issue #598 (May 2026): patients reported the page freezing when
  // clicking an invoice row. The renderer would lock up with no console
  // error. Root cause: a malformed payload (missing `payments` or `items`
  // array, or an item with a non-numeric `amount`) made `.filter` /
  // `.reduce` throw mid-render, which Next.js retries forever in a
  // suspense boundary because the component re-renders with the same
  // bad state on every retry. Coerce to safe arrays + numbers up front
  // so a corrupted invoice degrades gracefully to "no payments" instead
  // of locking the tab.
  const safePayments = Array.isArray(invoice.payments) ? invoice.payments : [];
  const positivePayments = safePayments.filter(
    (p) => typeof p?.amount === "number" && p.amount >= 0,
  );
  const refunds = safePayments.filter(
    (p) => typeof p?.amount === "number" && p.amount < 0,
  );
  const grossPaid = positivePayments.reduce((s, p) => s + (p.amount || 0), 0);
  const totalRefunded = refunds.reduce(
    (s, p) => s + Math.abs(p.amount || 0),
    0,
  );
  const netPaid = grossPaid - totalRefunded;

  // Compute per-line GST at render time via the shared helper. We do NOT
  // persist these columns in this pass — flagged as a follow-up to add
  // `cgst`/`sgst`/`hsnSac` to `InvoiceLineItem` for audit purposes.
  const itemsWithTax = (invoice.items || []).map((it) => ({
    ...it,
    tax: computeLineItemTax(it.amount, it.category),
  }));

  // Split the lines into the GST-exempt consultation charge(s) and the
  // taxable charges (lab / medicine / bed / surgery …). They render as two
  // separate sections so a consult never sits under HSN/SAC + CGST/SGST
  // columns (no GST, no tax, no qty — just the fee), while taxable lines keep
  // the full GST tax-invoice grid. A pure-consult bill shows only the first
  // section; a pure-taxable bill only the second; an admitted patient with a
  // consult + bed/medicine/lab shows both, clearly separated.
  const consultItems = itemsWithTax.filter(
    (it) => it.category === "CONSULTATION",
  );
  const taxableItems = itemsWithTax.filter(
    (it) => it.category !== "CONSULTATION",
  );

  // Single source of truth for the totals block (#202, #236). When the
  // persisted `invoice.totalAmount` was stored without GST (legacy seed
  // path), `computeInvoiceTotals` returns the corrected total derived
  // from per-line GST; otherwise it returns the persisted figure. The
  // footer Total + Running Balance use this in preference to the raw
  // `invoice.totalAmount`, which guarantees Total = Subtotal + GST.
  const totals = computeInvoiceTotals(invoice.items || [], {
    subtotal: invoice.subtotal,
    taxAmount: invoice.taxAmount,
    discountAmount: invoice.discountAmount,
    totalAmount: invoice.totalAmount,
  });
  const displayCgst = totals.cgstAmount;
  const displaySgst = totals.sgstAmount;
  const displayTotalTax = totals.taxAmount;
  const displayTotal = totals.totalAmount;
  const balance = Math.max(0, displayTotal - netPaid);
  // Issue #235: never trust a persisted `paymentStatus` that disagrees
  // with the maths (e.g. `PAID` while balance > 0). The shared helper
  // returns the displayed status so the watermark, badge, and totals
  // block stay self-consistent.
  const displayStatus = derivePaymentStatus(invoice.paymentStatus, displayTotal, netPaid);

  const statusColors: Record<string, string> = {
    PENDING: "bg-red-100 text-red-700",
    PARTIAL: "bg-yellow-100 text-yellow-700",
    PAID: "bg-green-100 text-green-700",
    REFUNDED: "bg-gray-100 text-gray-500",
  };

  // Timeline (payments + refunds) sorted by date. See #598 note above —
  // operate on the sanitized `safePayments` array so a missing field
  // never bubbles up as an unhandled exception during render.
  const timeline = [...safePayments].sort(
    (a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime()
  );

  const isPending = displayStatus === "PENDING";

  // Taxable charges table (lab / medicine / bed / surgery …) — the full GST
  // tax-invoice grid. The consultation fee is GST-exempt and shown as a
  // compact one-line summary above, not as a table row.
  const renderTaxableTable = (rows: typeof itemsWithTax) => (
    <div className="mb-6 overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs tabular-nums [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:last-child]:pr-0">
        <thead>
          <tr className="border-b border-t border-gray-200 text-left text-gray-500 dark:border-gray-700 dark:text-gray-400 print:border-gray-200 print:text-gray-500">
            <th className="py-3">#</th>
            <th className="py-3">
              {t("dashboard.billing.description", "Description")}
            </th>
            <th className="py-3 text-center">
              {t("dashboard.billing.hsnSac", "HSN/SAC")}
            </th>
            <th className="py-3 text-center">
              {t("dashboard.billing.qty", "Qty")}
            </th>
            <th className="py-3 text-right">
              {t("dashboard.billing.rate", "Rate")}
            </th>
            <th className="py-3 text-right">
              {t("dashboard.billing.taxable", "Taxable")}
            </th>
            <th className="py-3 text-right">
              {t("dashboard.billing.cgst", "CGST")}
            </th>
            <th className="py-3 text-right">
              {t("dashboard.billing.sgst", "SGST")}
            </th>
            <th className="py-3 text-right">
              {t("dashboard.billing.total", "Total")}
            </th>
            {isPending && <th className="no-print py-3" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((item, i) => (
            <tr
              key={item.id}
              className="border-b border-gray-200 dark:border-gray-700 print:border-gray-200"
            >
              <td className="py-3">{i + 1}</td>
              <td className="py-3">
                {item.description}
                <p className="text-[10px] text-gray-400 dark:text-gray-500 print:text-gray-400">
                  {item.category} · GST {item.tax.gstRate}%
                </p>
              </td>
              <td className="py-3 text-center font-mono text-[11px]">
                {item.tax.hsnSac}
              </td>
              <td className="py-3 text-center">
                {formatQuantityWithUnit(item.category, item.quantity)}
              </td>
              <td className="py-3 text-right whitespace-nowrap">{fmtMoney(item.unitPrice)}</td>
              <td className="py-3 text-right whitespace-nowrap">{fmtMoney(item.tax.taxable)}</td>
              <td className="py-3 text-right whitespace-nowrap">{fmtMoney(item.tax.cgst)}</td>
              <td className="py-3 text-right whitespace-nowrap">{fmtMoney(item.tax.sgst)}</td>
              <td className="py-3 text-right font-medium whitespace-nowrap">
                {fmtMoney(item.tax.total)}
              </td>
              {isPending && (
                <td className="no-print py-3 text-right">
                  {itemsWithTax.length > 1 && (
                    <button
                      onClick={() => removeItem(item.id)}
                      className="rounded p-1 text-red-500 hover:bg-red-50"
                      title="Remove item"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Consultation fee — one combined GST-exempt line (sum of any consult
  // items). Shown compactly, not as a tax-invoice row.
  const consultTotal = consultItems.reduce((s, it) => s + it.tax.total, 0);
  const consultLabel =
    consultItems.length === 1
      ? consultItems[0].description
      : t("dashboard.billing.consultationCharge", "Consultation Charge");

  // Delete the consultation charge. If there are other (taxable) items, just
  // drop the consult line(s). If the consult IS the whole invoice, the per-item
  // endpoint can't remove the last line — so delete the entire invoice and go
  // back to the billing list.
  const consultIsWholeInvoice =
    consultItems.length > 0 && taxableItems.length === 0;
  const removeConsultCharge = async () => {
    if (consultItems.length === 0) return;
    if (consultIsWholeInvoice) {
      if (
        !(await confirm({
          title: "Delete this consultation invoice?",
          message: "This removes the entire bill. This cannot be undone.",
          danger: true,
        }))
      )
        return;
      try {
        await api.delete(`/billing/invoices/${id}`);
        toast.success("Invoice deleted");
        router.push("/dashboard/billing");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to delete invoice",
        );
      }
      return;
    }
    if (!(await confirm({ title: "Remove the consultation charge?", danger: true })))
      return;
    try {
      for (const it of consultItems) {
        await api.delete(`/billing/invoices/${id}/items/${it.id}`);
      }
      loadInvoice();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove consultation charge",
      );
    }
  };

  return (
    <>
      {/* Global print stylesheet. Was `<style jsx global>` but
          styled-jsx types aren't in the project's TS config — switched
          to dangerouslySetInnerHTML which behaves identically (global
          CSS, static template, no JS interpolation). */}
      {/* Print-only styles. Plain <style> with dangerouslySetInnerHTML
          rather than styled-jsx — the App Router's TypeScript config
          rejects the `jsx` + `global` props on <style> (styled-jsx
          types aren't bundled), and these rules are already written
          with body-wide selectors so the styled-jsx `global` flag
          was redundant anyway. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        @media print {
          body * {
            visibility: hidden;
          }
          #invoice-print,
          #invoice-print * {
            visibility: visible;
          }
          #invoice-print {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            padding: 20px;
          }
          .no-print {
            display: none !important;
          }
        }
      `,
        }}
      />

      {/* Action bar */}
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/dashboard/billing"
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-primary dark:text-gray-300"
        >
          <ArrowLeft size={16} /> Back to Billing
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {/* Issue #861: cashier-only controls. PATIENT must never see
              Apply Discount, Record Payment, Record Refund, or Create
              Plan — those are admin/reception operations. The patient
              keeps Pay Online + Print + Back. */}
          {isStaff &&
            displayStatus !== "PAID" &&
            displayStatus !== "REFUNDED" && (
              <button
                onClick={() => setDiscOpen(true)}
                className="flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                <Percent size={14} /> Apply Discount
              </button>
            )}
          {isStaff && balance > 0 && (
            <button
              onClick={() => {
                setPayAmount(String(balance));
                setPayOpen(true);
              }}
              className="flex items-center gap-1 rounded-lg bg-green-500 px-3 py-1.5 text-sm text-white hover:bg-green-600"
            >
              <Receipt size={14} /> Record Payment
            </button>
          )}
          {balance > 0 && razorpay.enabled && (
            <button
              onClick={() => openPayOnlinePicker(balance)}
              disabled={payingOnline}
              data-testid="pay-online-btn"
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
            >
              <Globe size={14} />
              {payingOnline ? "Opening..." : "Pay Online"}
              {razorpay.isTestMode && (
                <span className="ml-1 rounded bg-yellow-300 px-1 py-0.5 text-[10px] font-bold text-yellow-900">
                  TEST
                </span>
              )}
            </button>
          )}
          {isStaff && netPaid > 0 && (
            <button
              onClick={() => {
                setRefundAmount(String(netPaid));
                setRefundOpen(true);
              }}
              className="flex items-center gap-1 rounded-lg bg-orange-500 px-3 py-1.5 text-sm text-white hover:bg-orange-600"
            >
              <Undo2 size={14} /> Record Refund
            </button>
          )}
          {isStaff && balance > 0 && (
            <button
              onClick={() => setPlanOpen(true)}
              className="flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <CreditCard size={14} /> Create Plan
            </button>
          )}
          <button
            onClick={() => openPrintEndpoint(`/billing/invoices/${invoice.id}/pdf`)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Printer size={16} /> Print Invoice
          </button>
        </div>
      </div>

      {/* Pending discount approval badge */}
      {pendingApprovals.length > 0 && (
        <div className="no-print mx-auto mb-3 max-w-3xl rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-800">
          <strong>Discount Pending Approval:</strong>{" "}
          {pendingApprovals.map((p) => (
            <span key={p.id}>
              Rs.{p.amount.toFixed(2)}
              {p.percentage != null ? ` (${p.percentage}%)` : ""} — {p.reason};{" "}
            </span>
          ))}
        </div>
      )}

      {invoice.lateFeeAmount > 0 && (
        <div className="no-print mx-auto mb-3 max-w-3xl rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <strong>Late fee:</strong> Rs.{invoice.lateFeeAmount.toFixed(2)}{" "}
          applied.
        </div>
      )}

      {/* Invoice content.
          Issue #862: the canvas is a printable PDF-like document. On screen
          we surface it in dark mode (bg-gray-800, body text white) so the
          patient can read it; for the print pipeline we force the white
          paper / dark ink scheme via print: variants. Same dual-mode trick
          is used by the totals + line item rows below. */}
      <div
        id="invoice-print"
        className="relative mx-auto max-w-3xl overflow-hidden rounded-xl bg-white p-8 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100 print:bg-white print:text-gray-900"
      >
        {/* Watermark overlays */}
        {displayStatus === "CANCELLED" && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="select-none rotate-[-30deg] text-[8rem] font-black text-red-500/20">
              CANCELLED
            </span>
          </div>
        )}
        {displayStatus === "PAID" && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="select-none rotate-[-30deg] text-[8rem] font-black text-green-500/15">
              PAID
            </span>
          </div>
        )}
        {pendingApprovals.length > 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="select-none rotate-[-30deg] text-[8rem] font-black text-orange-500/20">
              DRAFT
            </span>
          </div>
        )}
        {/* Header */}
        <div className="mb-8 border-b border-gray-200 pb-6 dark:border-gray-700 print:border-gray-200">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-primary">{hospital.name}</h1>
              {hospital.tagline && (
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 print:text-gray-500">{hospital.tagline}</p>
              )}
              {hospital.address && (
                <p className="text-sm text-gray-500 dark:text-gray-400 print:text-gray-500">{hospital.address}</p>
              )}
              {hospital.phone && (
                <p className="text-sm text-gray-500 dark:text-gray-400 print:text-gray-500">
                  {t("dashboard.billing.phone", "Phone")}: {hospital.phone}
                </p>
              )}
              {hospital.email && (
                <p className="text-sm text-gray-500 dark:text-gray-400 print:text-gray-500">{hospital.email}</p>
              )}
              {hospital.gstin && (
                <p className="mt-1 text-xs font-semibold text-gray-700 dark:text-gray-200 print:text-gray-700">
                  GSTIN: {hospital.gstin}
                </p>
              )}
            </div>
            <div className="text-right">
              <h2 className="text-lg font-semibold">TAX INVOICE</h2>
              <p className="font-mono text-sm font-medium text-primary">
                {invoice.invoiceNumber}
              </p>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 print:text-gray-500">
                Date:{" "}
                {new Date(invoice.createdAt).toLocaleDateString("en-IN", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
              <span
                className={`mt-2 inline-block rounded-full px-3 py-0.5 text-xs font-medium ${statusColors[displayStatus] || ""}`}
                data-testid="invoice-status-badge"
              >
                {displayStatus}
              </span>
            </div>
          </div>
        </div>

        {/* Patient & Doctor Info */}
        <div className="mb-6 grid grid-cols-2 gap-6">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 print:text-gray-400">
              Bill To
            </h3>
            <p className="font-medium">{invoice.patient.user.name}</p>
            <p className="text-sm text-gray-600 dark:text-gray-300 print:text-gray-600">MR#: {invoice.patient.mrNumber}</p>
            <p className="text-sm text-gray-600 dark:text-gray-300 print:text-gray-600">
              {invoice.patient.age ? `${invoice.patient.age} yrs, ` : ""}
              {invoice.patient.gender}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300 print:text-gray-600">{invoice.patient.user.phone}</p>
            {invoice.patient.user.email && (
              <p className="text-sm text-gray-600 dark:text-gray-300 print:text-gray-600">{invoice.patient.user.email}</p>
            )}
            {/* Pharmacists only work with the pharmacy bill they generated, not
                a patient's full invoice history — hide the cross-link for them
                (the per-patient billing page isn't in their scope). */}
            {user?.role !== "PHARMACIST" && (
              <Link
                href={`/dashboard/billing/patient/${invoice.patient.id}`}
                className="no-print mt-2 inline-block text-xs text-primary hover:underline"
              >
                View all patient invoices →
              </Link>
            )}
          </div>
          {invoice.appointment && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 print:text-gray-400">
                Consultation
              </h3>
              <p className="font-medium">
                {formatDoctorName(invoice.appointment.doctor.user.name)}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300 print:text-gray-600">
                {invoice.appointment.doctor.specialization}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300 print:text-gray-600">
                {new Date(invoice.appointment.date).toLocaleDateString("en-IN")}
              </p>
            </div>
          )}
        </div>

        {/* Consultation fee — GST-exempt, one combined compact line (not a
            full tax-invoice row). Keeps the bill short, especially for
            patients with many taxable line items below. Deletable on a PENDING
            invoice as long as ≥1 item would remain. */}
        {consultItems.length > 0 && (
          <div className="mb-4 border-b border-gray-200 pb-3 dark:border-gray-700 print:border-gray-200">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="font-medium text-gray-700 dark:text-gray-200 print:text-gray-700">
                  {consultLabel}
                </span>
                {consultItems.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setConsultOpen((o) => !o)}
                    data-testid="consult-view-toggle"
                    className="no-print whitespace-nowrap text-[11px] font-medium text-primary hover:underline"
                  >
                    {consultOpen ? "Hide doctors ←" : "View doctors →"}
                  </button>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-medium">{fmtMoney(consultTotal)}</span>
                {/* Single consult has no expandable list, so its delete lives
                    on this row. Multiple consults are deleted per-line in the
                    breakdown below. */}
                {isPending && consultItems.length === 1 && (
                  <button
                    onClick={removeConsultCharge}
                    className="no-print rounded p-1 text-red-500 hover:bg-red-50"
                    title={
                      consultIsWholeInvoice
                        ? "Delete invoice"
                        : "Remove consultation charge"
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
            {/* Date-wise breakdown — each consult per doctor, so the patient
                can verify every charge. Each line is individually deletable
                (PENDING). Printed copy itemises these too. */}
            {consultOpen && consultItems.length > 1 && (
              <ul
                className="mt-2 space-y-1"
                data-testid="consult-breakdown"
              >
                {consultItems.map((it) => (
                  <li
                    key={it.id}
                    className="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400"
                  >
                    <span>{it.description}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span>{fmtMoney(it.tax.total)}</span>
                      {isPending && itemsWithTax.length > 1 && (
                        <button
                          onClick={() => removeItem(it.id)}
                          className="no-print rounded p-1 text-red-500 hover:bg-red-50"
                          title="Remove this consultation"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Taxable charges table — only the GST-bearing lines. Hidden entirely
            for a pure consultation bill. */}
        {taxableItems.length > 0
          ? renderTaxableTable(taxableItems)
          : consultItems.length === 0 && (
              <div className="mb-6 overflow-x-auto">
                <table className="w-full text-xs">
                  <tbody>
                    <tr className="border-b border-t border-gray-200 dark:border-gray-700 print:border-gray-200">
                      <td className="py-3 text-gray-500 dark:text-gray-400">
                        {t("dashboard.billing.noItems", "No items")}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

        {/* Add item form (only for PENDING invoices) */}
        {isPending && (
          <div className="no-print mb-6 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-900">
            <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
              {t("dashboard.billing.addLineItem", "Add Line Item")}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
              <input
                type="text"
                aria-label={t("dashboard.billing.description", "Description")}
                placeholder={t("dashboard.billing.description", "Description")}
                value={newDesc}
                onChange={(e) => onDescriptionChange(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 sm:col-span-5"
              />
              <select
                aria-label={t("dashboard.billing.category", "Category")}
                value={newCategory}
                onChange={(e) => onCategoryChange(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 sm:col-span-3"
              >
                {[
                  "CONSULTATION",
                  "PROCEDURE",
                  "LAB",
                  "RADIOLOGY",
                  "PHARMACY",
                  "MEDICINE",
                  "ROOM_CHARGE",
                  "SURGERY",
                  "OTHER",
                ].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                aria-label={t("dashboard.billing.qty", "Qty")}
                placeholder={t("dashboard.billing.qty", "Qty")}
                value={newQty}
                onChange={(e) => setNewQty(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 sm:col-span-1"
              />
              <input
                type="number"
                min="0"
                step="0.01"
                aria-label={t("dashboard.billing.unitPrice", "Unit Price")}
                placeholder={t("dashboard.billing.unitPrice", "Unit Price")}
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 sm:col-span-2"
              />
              <button
                onClick={addItem}
                disabled={adding || !newDesc || !newPrice}
                className="flex items-center justify-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-white hover:bg-primary-dark disabled:opacity-50 sm:col-span-1"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Totals */}
        <div className="mb-8 flex justify-end">
          <div className="w-72 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400 print:text-gray-500">
                {t("dashboard.billing.subtotal", "Subtotal")}
              </span>
              <span data-testid="totals-subtotal">{fmtMoney(totals.subtotal)}</span>
            </div>
            {displayTotalTax > 0 && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400 print:text-gray-500" data-testid="totals-cgst-label">
                    {t("dashboard.billing.cgst", "CGST")}
                  </span>
                  <span data-testid="totals-cgst">{fmtMoney(displayCgst)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400 print:text-gray-500" data-testid="totals-sgst-label">
                    {t("dashboard.billing.sgst", "SGST")}
                  </span>
                  <span data-testid="totals-sgst">{fmtMoney(displaySgst)}</span>
                </div>
                <div className="flex justify-between border-t border-gray-200 pt-1 text-sm font-medium dark:border-gray-700 print:border-gray-200">
                  <span className="text-gray-600 dark:text-gray-300 print:text-gray-600">
                    {t("dashboard.billing.totalGst", "Total GST")}
                  </span>
                  <span>{fmtMoney(displayTotalTax)}</span>
                </div>
              </>
            )}
            {invoice.discountAmount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400 print:text-gray-500">Discount</span>
                <span className="text-green-600 dark:text-green-400 print:text-green-600">
                  - {fmtMoney(invoice.discountAmount)}
                </span>
              </div>
            )}
            <div className="flex justify-between border-t border-gray-200 pt-2 font-semibold dark:border-gray-700 print:border-gray-200">
              <span>Total</span>
              <span data-testid="totals-total">{fmtMoney(displayTotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400 print:text-gray-500">Payments</span>
              <span className="text-green-600 dark:text-green-400 print:text-green-600">{fmtMoney(grossPaid)}</span>
            </div>
            {totalRefunded > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400 print:text-gray-500">Refunds</span>
                <span className="text-orange-500 dark:text-orange-400 print:text-orange-500">
                  - {fmtMoney(totalRefunded)}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400 print:text-gray-500">Net Paid</span>
              <span>{fmtMoney(netPaid)}</span>
            </div>
            <div
              className={`flex justify-between border-t border-gray-200 pt-2 text-sm font-semibold dark:border-gray-700 print:border-gray-200 ${
                balance > 0
                  ? "text-red-600 dark:text-red-400 print:text-red-600"
                  : "text-gray-500 dark:text-gray-400 print:text-gray-500"
              }`}
            >
              <span>Running Balance</span>
              <span data-testid="totals-balance">{fmtMoney(balance)}</span>
            </div>
          </div>
        </div>

        {/* Pearl §4.2 — NHCX cashless stub stepper.
            Renders when this invoice has an InsuranceClaim row attached.
            ADMIN gets a Move-to-next-stage button (test-only per PRD);
            the underlying PATCH /billing/claims/:id endpoint
            (apps/api/src/routes/billing.ts:861) already exists and
            accepts ADMIN+RECEPTION — we scope the UI to ADMIN-only
            per the spec's "admin button for testing" wording. */}
        {invoice.insuranceClaims && invoice.insuranceClaims[0] ? (
          <NHCXStepper
            claim={invoice.insuranceClaims[0]}
            userRole={user?.role}
            onAdvance={async (nextStatus) => {
              const claimId = invoice.insuranceClaims![0].id;
              try {
                await api.patch(`/billing/claims/${claimId}`, {
                  status: nextStatus,
                });
                toast.success(`Claim advanced to ${nextStatus}`);
                await loadInvoice();
              } catch (err) {
                const msg =
                  err instanceof Error ? err.message : "Failed to advance claim";
                toast.error(msg);
                throw err;
              }
            }}
          />
        ) : null}

        {/* Refunds section */}
        {refunds.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200 print:text-gray-700">Refunds Issued</h3>
            <div className="rounded-lg border border-orange-100 bg-orange-50/40 dark:border-orange-900/30 dark:bg-orange-900/10 print:border-orange-100 print:bg-orange-50/40">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-orange-100 text-left text-xs text-gray-500 dark:border-orange-900/40 dark:text-gray-400 print:border-orange-100 print:text-gray-500">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Amount</th>
                    <th className="px-3 py-2">Mode</th>
                    <th className="px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.map((r) => (
                    <tr key={r.id} className="border-b border-orange-100 last:border-0 dark:border-orange-900/40 print:border-orange-100">
                      <td className="px-3 py-2 text-xs">
                        {new Date(r.paidAt).toLocaleString("en-IN")}
                      </td>
                      <td className="px-3 py-2 text-xs font-medium text-orange-600 dark:text-orange-400 print:text-orange-600">
                        {fmtMoney(Math.abs(r.amount))}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.mode}</td>
                      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300 print:text-gray-600">
                        {r.transactionId?.startsWith(REFUND_PREFIX)
                          ? r.transactionId.slice(REFUND_PREFIX.length)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Payment timeline */}
        {timeline.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200 print:text-gray-700">Payment Timeline</h3>
            <ol className="relative border-l-2 border-gray-200 pl-4 dark:border-gray-700 print:border-gray-200">
              {timeline.map((e) => {
                const isRefund = e.amount < 0;
                return (
                  <li key={e.id} className="mb-4 last:mb-0">
                    <span
                      className={`absolute -left-1.75 h-3 w-3 rounded-full ${
                        isRefund ? "bg-orange-500" : "bg-green-500"
                      }`}
                    />
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">
                          {isRefund ? "Refund issued" : "Payment received"} —{" "}
                          <span
                            className={
                              isRefund
                                ? "text-orange-600 dark:text-orange-400 print:text-orange-600"
                                : "text-green-600 dark:text-green-400 print:text-green-600"
                            }
                          >
                            {fmtMoney(Math.abs(e.amount))}
                          </span>
                          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400 print:text-gray-500">({e.mode})</span>
                        </p>
                        {e.transactionId && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 print:text-gray-500">
                            {e.transactionId.startsWith(REFUND_PREFIX)
                              ? `Reason: ${e.transactionId.slice(REFUND_PREFIX.length)}`
                              : `Ref: ${e.transactionId}`}
                          </p>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 dark:text-gray-500 print:text-gray-400">
                        {new Date(e.paidAt).toLocaleString("en-IN")}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {invoice.notes && (
          <div className="mb-6 rounded-lg bg-gray-50 p-3 text-xs text-gray-600 whitespace-pre-line dark:bg-gray-900 dark:text-gray-300 print:bg-gray-50 print:text-gray-600">
            <p className="mb-1 font-semibold text-gray-700 dark:text-gray-200 print:text-gray-700">Notes</p>
            {invoice.notes}
          </div>
        )}

        <div className="border-t border-gray-200 pt-4 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500 print:border-gray-200 print:text-gray-400">
          <p>Thank you for choosing MedCore.</p>
          <p>This is a computer-generated invoice.</p>
        </div>
      </div>

      {/* Discount modal */}
      {discOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-h-[90vh] overflow-y-auto max-w-md rounded-xl bg-white p-6 text-gray-900 shadow-2xl dark:bg-gray-800 dark:text-gray-100">
            <h2 className="mb-4 text-lg font-bold">Apply Discount</h2>
            <div className="space-y-3">
              <div className="flex gap-2">
                <button
                  onClick={() => setDiscType("percentage")}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm ${
                    discType === "percentage"
                      ? "bg-primary text-white"
                      : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                  }`}
                >
                  Percentage
                </button>
                <button
                  onClick={() => setDiscType("flat")}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm ${
                    discType === "flat"
                      ? "bg-primary text-white"
                      : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                  }`}
                >
                  Flat Amount
                </button>
              </div>
              <div>
                <label htmlFor="invoice-disc-value" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                  {discType === "percentage" ? "Percentage (%)" : "Flat Amount (Rs.)"}
                </label>
                <input
                  id="invoice-disc-value"
                  type="number"
                  min="0"
                  step="0.01"
                  value={discValue}
                  onChange={(e) => setDiscValue(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="invoice-disc-reason" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Reason</label>
                <textarea
                  id="invoice-disc-reason"
                  value={discReason}
                  onChange={(e) => setDiscReason(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  rows={2}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDiscOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={submitDiscount}
                disabled={discSubmitting || !discValue || !discReason}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {discSubmitting ? "Saving..." : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment modal */}
      {payOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-h-[90vh] overflow-y-auto max-w-md rounded-xl bg-white p-6 text-gray-900 shadow-2xl dark:bg-gray-800 dark:text-gray-100">
            <h2 className="mb-4 text-lg font-bold">Record Payment</h2>
            <div className="space-y-3">
              <div>
                <label htmlFor="invoice-payment-amount" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Amount (Rs.)</label>
                <input
                  id="invoice-payment-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={payAmount}
                  onChange={(e) => {
                    setPayAmount(e.target.value);
                    if (payFieldErrors.amount)
                      setPayFieldErrors((p) => {
                        const n = { ...p };
                        delete n.amount;
                        return n;
                      });
                  }}
                  data-testid="payment-amount"
                  aria-invalid={!!payFieldErrors.amount}
                  className={`w-full rounded-lg border px-3 py-2 text-sm text-gray-900 dark:text-gray-100 ${
                    payFieldErrors.amount
                      ? "border-red-500 bg-red-50 dark:border-red-500 dark:bg-red-900/30"
                      : "border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-900"
                  }`}
                  autoFocus
                />
                {payFieldErrors.amount && (
                  <p
                    data-testid="error-payment-amount"
                    className="mt-1 text-xs text-red-600 dark:text-red-400"
                  >
                    {payFieldErrors.amount}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="invoice-payment-mode" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Mode</label>
                <select
                  id="invoice-payment-mode"
                  value={payMode}
                  onChange={(e) => setPayMode(e.target.value)}
                  data-testid="payment-mode"
                  aria-invalid={!!payFieldErrors.mode}
                  className={`w-full rounded-lg border px-3 py-2 text-sm text-gray-900 dark:text-gray-100 ${
                    payFieldErrors.mode
                      ? "border-red-500 bg-red-50 dark:border-red-500 dark:bg-red-900/30"
                      : "border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-900"
                  }`}
                >
                  {["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                {payFieldErrors.mode && (
                  <p
                    data-testid="error-payment-mode"
                    className="mt-1 text-xs text-red-600 dark:text-red-400"
                  >
                    {payFieldErrors.mode}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPayOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={submitPayment}
                disabled={paySubmitting || !payAmount}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {paySubmitting ? "Saving..." : "Save Payment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Refund modal */}
      {refundOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-h-[90vh] overflow-y-auto max-w-md rounded-xl bg-white p-6 text-gray-900 shadow-2xl dark:bg-gray-800 dark:text-gray-100">
            <h2 className="mb-4 text-lg font-bold">Issue Refund</h2>
            <div className="space-y-3">
              <div>
                <label htmlFor="invoice-refund-amount" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Amount (Rs.)</label>
                <input
                  id="invoice-refund-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="invoice-refund-mode" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Mode</label>
                <select
                  id="invoice-refund-mode"
                  value={refundMode}
                  onChange={(e) => setRefundMode(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  {["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="invoice-refund-reason" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Reason</label>
                <textarea
                  id="invoice-refund-reason"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  rows={3}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setRefundOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={submitRefund}
                disabled={
                  refundSubmitting ||
                  !refundAmount ||
                  !refundReason ||
                  parseFloat(refundAmount) <= 0
                }
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
              >
                {refundSubmitting ? "Saving..." : "Issue Refund"}
              </button>
            </div>
          </div>
        </div>
      )}

      {planOpen && invoice && (
        <CreatePlanModal
          invoiceId={invoice.id}
          balance={balance}
          onClose={() => setPlanOpen(false)}
          onSaved={loadInvoice}
        />
      )}

      {/* A1 — Pay Online amount picker. Opens before Razorpay so the user
          (patient or staff) can choose a partial amount. Defaults to the
          full remaining balance; the server validates the cap so a
          tampered client can't overpay. */}
      {payOnlineOpen && invoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-h-[90vh] overflow-y-auto max-w-md rounded-xl bg-white p-6 text-gray-900 shadow-2xl dark:bg-gray-800 dark:text-gray-100">
            <h2 className="mb-1 text-lg font-bold">Pay Online</h2>
            <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
              Outstanding balance: {fmtMoney(balance)}
              {razorpay.isTestMode && (
                <span className="ml-2 rounded bg-yellow-300 px-1 py-0.5 text-[10px] font-bold text-yellow-900">
                  TEST MODE
                </span>
              )}
            </p>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="pay-online-amount"
                  className="mb-1 block text-xs text-gray-500 dark:text-gray-400"
                >
                  Amount to pay now (Rs.)
                </label>
                <input
                  id="pay-online-amount"
                  data-testid="pay-online-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={balance}
                  value={payOnlineAmount}
                  onChange={(e) => setPayOnlineAmount(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  autoFocus
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPayOnlineAmount(String((balance / 2).toFixed(2)))}
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    Half
                  </button>
                  <button
                    type="button"
                    onClick={() => setPayOnlineAmount(String(balance.toFixed(2)))}
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    Full
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPayOnlineOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const parsed = parseFloat(payOnlineAmount);
                  if (Number.isNaN(parsed) || parsed <= 0) {
                    toast.error("Enter a valid amount");
                    return;
                  }
                  if (parsed > balance + 0.01) {
                    toast.error("Amount cannot exceed outstanding balance");
                    return;
                  }
                  payOnline(parsed);
                }}
                disabled={payingOnline || !payOnlineAmount}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {payingOnline ? "Opening..." : "Continue to Razorpay"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CreatePlanModal({
  invoiceId,
  balance,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  balance: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [downPayment, setDownPayment] = useState("0");
  const [installments, setInstallments] = useState("3");
  const [frequency, setFrequency] = useState("MONTHLY");
  const [startDate, setStartDate] = useState(
    new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  );
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post("/payment-plans", {
        invoiceId,
        downPayment: parseFloat(downPayment || "0"),
        installments: parseInt(installments, 10),
        frequency,
        startDate,
      });
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setSaving(false);
  }

  const afterDown = Math.max(0, balance - parseFloat(downPayment || "0"));
  const n = parseInt(installments, 10) || 1;
  const each = afterDown / n;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        noValidate
        className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Create Payment Plan</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 text-sm">
          <p className="rounded bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
            Outstanding balance: {fmtMoney(balance)}
          </p>
          <div>
            <label htmlFor="create-plan-down-payment" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
              Down Payment
            </label>
            <input
              id="create-plan-down-payment"
              type="number"
              step="0.01"
              value={downPayment}
              onChange={(e) => setDownPayment(e.target.value)}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label htmlFor="create-plan-installments" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
              Installments
            </label>
            {/* TODO(A4): add React-side validation for installments range (2-60) */}
            <input
              id="create-plan-installments"
              type="number"
              value={installments}
              onChange={(e) => setInstallments(e.target.value)}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label htmlFor="create-plan-frequency" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Frequency</label>
            <select
              id="create-plan-frequency"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="MONTHLY">Monthly</option>
              <option value="BIWEEKLY">Bi-weekly</option>
              <option value="WEEKLY">Weekly</option>
            </select>
          </div>
          <div>
            <label htmlFor="create-plan-start-date" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
              Start Date
            </label>
            {/* TODO(A4): add React-side validation for startDate presence */}
            <input
              id="create-plan-start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <p className="rounded bg-blue-50 p-2 text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-200">
            Each installment: {fmtMoney(each)}
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-300 px-4 py-2 text-sm dark:border-gray-600 dark:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {saving ? "Creating..." : "Create Plan"}
          </button>
        </div>
      </form>
    </div>
  );
}
