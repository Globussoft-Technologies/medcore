"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { Plus, Package, Search } from "lucide-react";

interface InventoryItem {
  id: string;
  batchNumber: string;
  quantity: number;
  unitCost?: number;
  sellingPrice?: number;
  expiryDate: string;
  supplier?: string | null;
  location?: string | null;
  reorderLevel?: number | null;
  medicine: { id: string; name: string; genericName?: string | null };
}

interface Movement {
  id: string;
  type: string;
  quantity: number;
  createdAt: string;
  notes?: string | null;
  inventory?: { batchNumber: string; medicine: { name: string } };
}

interface Medicine {
  id: string;
  name: string;
  genericName?: string | null;
}

type Tab =
  | "inventory"
  | "low"
  | "expiring"
  | "movements"
  | "returns"
  | "transfers"
  | "valuation";

interface ReturnRow {
  id: string;
  returnNumber: string;
  quantity: number;
  reason: string;
  refundAmount: number;
  createdAt: string;
  inventoryItem: {
    batchNumber: string;
    medicine: { name: string };
  };
}

interface TransferRow {
  id: string;
  transferNumber: string;
  fromLocation: string;
  toLocation: string;
  quantity: number;
  transferredAt: string;
  inventoryItem: {
    batchNumber: string;
    medicine: { name: string };
  };
}

interface ValuationRow {
  medicineId: string;
  medicineName: string;
  onHand: number;
  unitValue: number;
  totalValue: number;
}

const MOVEMENT_COLORS: Record<string, string> = {
  PURCHASE: "bg-green-100 text-green-700",
  DISPENSED: "bg-blue-100 text-blue-700",
  EXPIRED: "bg-red-100 text-red-700",
  ADJUSTMENT: "bg-yellow-100 text-yellow-700",
  RETURN: "bg-purple-100 text-purple-700",
  DAMAGED: "bg-gray-100 text-gray-700",
};

export default function PharmacyPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const confirm = useConfirm();

  // RBAC (issue #98): RECEPTION must NOT see stock levels (or write inventory).
  // The API now enforces 403; the UI mirrors the redirect so receptionists
  // who land here via stale bookmarks don't get a wall of empty tables.
  // Issue #179: target /dashboard/not-authorized so the layout chrome stays.
  useEffect(() => {
    if (user && user.role === "RECEPTION") {
      toast.error("Pharmacy inventory is restricted to clinical and pharmacy roles.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/pharmacy")}`,
      );
    }
  }, [user, router, pathname]);
  const [tab, setTab] = useState<Tab>("inventory");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [valuation, setValuation] = useState<{
    method: string;
    perMedicine: ValuationRow[];
    totalValue: number;
  } | null>(null);
  const [valuationMethod, setValuationMethod] = useState("WEIGHTED_AVG");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [returnFor, setReturnFor] = useState<InventoryItem | null>(null);
  const [transferFor, setTransferFor] = useState<InventoryItem | null>(null);
  const [orderingId, setOrderingId] = useState<string | null>(null);

  // RBAC (issue #98): inventory write capability is now ADMIN + PHARMACIST.
  // RECEPTION lost the ability — they shouldn't even reach this page (see
  // redirect above) but guard the UI just in case.
  const canManage = user?.role === "ADMIN" || user?.role === "PHARMACIST";
  const isAdmin = user?.role === "ADMIN";

  useEffect(() => {
    if (tab === "movements") loadMovements();
    else if (tab === "returns") loadReturns();
    else if (tab === "transfers") loadTransfers();
    else if (tab === "valuation") loadValuation();
    else loadInventory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, search, valuationMethod]);

  async function loadReturns() {
    setLoading(true);
    try {
      const res = await api.get<{ data: ReturnRow[] }>("/pharmacy/returns");
      setReturns(res.data);
    } catch {
      setReturns([]);
    }
    setLoading(false);
  }

  async function loadTransfers() {
    setLoading(true);
    try {
      const res = await api.get<{ data: TransferRow[] }>("/pharmacy/transfers");
      setTransfers(res.data);
    } catch {
      setTransfers([]);
    }
    setLoading(false);
  }

  async function loadValuation() {
    setLoading(true);
    try {
      const res = await api.get<{
        data: { method: string; perMedicine: ValuationRow[]; totalValue: number };
      }>(`/pharmacy/reports/valuation?method=${valuationMethod}`);
      setValuation(res.data);
    } catch {
      setValuation(null);
    }
    setLoading(false);
  }

  async function orderFromSupplier(itemId: string) {
    if (!(await confirm({ title: "Create draft PO from best supplier for this medicine?" }))) return;
    setOrderingId(itemId);
    try {
      const res = await api.post<{
        data: { po: { poNumber: string }; emailStub: string };
      }>(`/pharmacy/inventory/${itemId}/order-from-supplier`);
      toast.success(`PO ${res.data.po.poNumber} created. ${res.data.emailStub}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
    setOrderingId(null);
  }

  async function loadInventory() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (tab === "low") params.set("lowStock", "true");
      let endpoint = `/pharmacy/inventory?${params.toString()}`;
      if (tab === "expiring") {
        endpoint = `/pharmacy/inventory/expiring?days=30`;
      }
      const res = await api.get<{ data: InventoryItem[] }>(endpoint);
      setItems(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function loadMovements() {
    setLoading(true);
    try {
      const res = await api.get<{ data: Movement[] }>(
        "/pharmacy/movements?limit=100"
      );
      setMovements(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  function qtyColor(item: InventoryItem): string {
    if (item.quantity === 0) return "text-red-600 font-semibold";
    if (item.reorderLevel && item.quantity <= item.reorderLevel)
      return "text-orange-600 font-semibold";
    return "text-green-700";
  }

  function expiryColor(exp: string): string {
    const days = (new Date(exp).getTime() - Date.now()) / (86400 * 1000);
    if (days < 0) return "text-red-700 font-semibold";
    if (days < 30) return "text-orange-600 font-semibold";
    return "text-gray-700";
  }

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
            <Package className="text-primary" /> Pharmacy
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Inventory management</p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Add Stock
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setTab("inventory")} className={tabClass("inventory")}>
          Inventory
        </button>
        <button onClick={() => setTab("low")} className={tabClass("low")}>
          Low Stock
        </button>
        <button onClick={() => setTab("expiring")} className={tabClass("expiring")}>
          Expiring Soon
        </button>
        <button onClick={() => setTab("movements")} className={tabClass("movements")}>
          Movements
        </button>
        <button onClick={() => setTab("returns")} className={tabClass("returns")}>
          Returns
        </button>
        <button onClick={() => setTab("transfers")} className={tabClass("transfers")}>
          Transfers
        </button>
        {isAdmin && (
          <button
            onClick={() => setTab("valuation")}
            className={tabClass("valuation")}
          >
            Valuation
          </button>
        )}
      </div>

      {(tab === "inventory" || tab === "low" || tab === "expiring") && (
        <div className="mb-4 relative max-w-md">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            placeholder="Search medicines or batches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pl-9 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
          />
        </div>
      )}

      <div className="rounded-xl bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
        ) : tab === "movements" ? (
          movements.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">No movements.</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Medicine</th>
                  <th className="px-4 py-3">Batch</th>
                  <th className="px-4 py-3">Quantity</th>
                  <th className="px-4 py-3">Notes</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                    <td className="px-4 py-3 text-sm">
                      {new Date(m.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${MOVEMENT_COLORS[m.type] || "bg-gray-100 text-gray-700"}`}
                      >
                        {m.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {m.inventory?.medicine.name || "—"}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {m.inventory?.batchNumber || "—"}
                    </td>
                    <td className="px-4 py-3 text-sm">{m.quantity}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                      {m.notes || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : tab === "returns" ? (
          returns.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">No returns.</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-4 py-3">Return #</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Medicine</th>
                  <th className="px-4 py-3">Batch</th>
                  <th className="px-4 py-3">Qty</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Refund</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                    <td className="px-4 py-3 font-mono text-sm">
                      {r.returnNumber}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {r.inventoryItem.medicine.name}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {r.inventoryItem.batchNumber}
                    </td>
                    <td className="px-4 py-3 text-sm">{r.quantity}</td>
                    <td className="px-4 py-3 text-sm">{r.reason}</td>
                    <td className="px-4 py-3 text-sm">
                      ₹{r.refundAmount.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : tab === "transfers" ? (
          transfers.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">No transfers.</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-4 py-3">Transfer #</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Medicine</th>
                  <th className="px-4 py-3">Batch</th>
                  <th className="px-4 py-3">From</th>
                  <th className="px-4 py-3">To</th>
                  <th className="px-4 py-3">Qty</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                    <td className="px-4 py-3 font-mono text-sm">
                      {t.transferNumber}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {new Date(t.transferredAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {t.inventoryItem.medicine.name}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {t.inventoryItem.batchNumber}
                    </td>
                    <td className="px-4 py-3 text-sm">{t.fromLocation}</td>
                    <td className="px-4 py-3 text-sm">{t.toLocation}</td>
                    <td className="px-4 py-3 text-sm">{t.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : tab === "valuation" ? (
          <div>
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <label className="text-sm text-gray-600">Method:</label>
              <select
                value={valuationMethod}
                onChange={(e) => setValuationMethod(e.target.value)}
                className="rounded border px-2 py-1 text-sm"
              >
                <option value="WEIGHTED_AVG">Weighted Average</option>
                <option value="FIFO">FIFO</option>
                <option value="LIFO">LIFO</option>
              </select>
              <div className="ml-auto text-sm text-gray-600">
                Total Value:{" "}
                <span className="text-lg font-bold text-primary">
                  ₹
                  {valuation?.totalValue?.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  }) ?? "0.00"}
                </span>
              </div>
            </div>
            {!valuation || valuation.perMedicine.length === 0 ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                No valuation data.
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="px-4 py-3">Medicine</th>
                    <th className="px-4 py-3">On Hand</th>
                    <th className="px-4 py-3">Unit Value</th>
                    <th className="px-4 py-3">Total Value</th>
                  </tr>
                </thead>
                <tbody>
                  {valuation.perMedicine.map((v) => (
                    <tr
                      key={v.medicineId}
                      className="border-b border-gray-100 last:border-0 dark:border-gray-700"
                    >
                      <td className="px-4 py-3 text-sm">{v.medicineName}</td>
                      <td className="px-4 py-3 text-sm">{v.onHand}</td>
                      <td className="px-4 py-3 text-sm">
                        ₹{v.unitValue.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium">
                        ₹{v.totalValue.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            No inventory items.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">Medicine</th>
                <th className="px-4 py-3">Batch</th>
                <th className="px-4 py-3">Quantity</th>
                <th className="px-4 py-3">Expiry</th>
                <th className="px-4 py-3">Price</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Reorder</th>
                {canManage && <th className="px-4 py-3">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const isLow =
                  i.reorderLevel != null && i.quantity <= i.reorderLevel;
                return (
                  <tr key={i.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                    <td className="px-4 py-3">
                      <p className="font-medium">{i.medicine.name}</p>
                      {i.medicine.genericName && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {i.medicine.genericName}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">{i.batchNumber}</td>
                    <td className={`px-4 py-3 text-sm ${qtyColor(i)}`}>
                      {i.quantity}
                    </td>
                    <td className={`px-4 py-3 text-sm ${expiryColor(i.expiryDate)}`}>
                      {new Date(i.expiryDate).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {i.sellingPrice
                        ? `₹${i.sellingPrice.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-sm">{i.location || "—"}</td>
                    <td className="px-4 py-3 text-sm">
                      {i.reorderLevel ?? "—"}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          <button
                            onClick={() => setReturnFor(i)}
                            className="rounded bg-purple-100 px-2 py-1 text-xs font-medium text-purple-700 hover:bg-purple-200"
                          >
                            Return
                          </button>
                          <button
                            onClick={() => setTransferFor(i)}
                            className="rounded bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-200"
                          >
                            Transfer
                          </button>
                          {isLow && (
                            <button
                              disabled={orderingId === i.id}
                              onClick={() => orderFromSupplier(i.id)}
                              className="rounded bg-orange-100 px-2 py-1 text-xs font-medium text-orange-700 hover:bg-orange-200 disabled:opacity-50"
                            >
                              {orderingId === i.id
                                ? "…"
                                : "Order from Supplier"}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <AddStockModal onClose={() => setShowAdd(false)} onSaved={loadInventory} />
      )}

      {returnFor && (
        <ReturnModal
          item={returnFor}
          onClose={() => setReturnFor(null)}
          onSaved={() => {
            loadInventory();
            if (tab === "returns") loadReturns();
          }}
        />
      )}
      {transferFor && (
        <TransferModal
          item={transferFor}
          onClose={() => setTransferFor(null)}
          onSaved={() => {
            loadInventory();
            if (tab === "transfers") loadTransfers();
          }}
        />
      )}
    </div>
  );
}

function ReturnModal({
  item,
  onClose,
  onSaved,
}: {
  item: InventoryItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("PATIENT_RETURNED");
  const [refundAmount, setRefundAmount] = useState("0");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Issue #51: enforce on-hand cap client side too — `<input max>` only
    // surfaces a browser-native validation message and is bypassable by
    // typing/pasting a larger value. We toast and bail before POSTing.
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) {
      toast.error("Quantity must be a positive whole number");
      return;
    }
    if (qty > item.quantity) {
      toast.error(
        `Cannot return more than on-hand stock (${item.quantity}). Adjust the quantity and try again.`,
      );
      return;
    }
    setSaving(true);
    try {
      await api.post("/pharmacy/returns", {
        inventoryItemId: item.id,
        quantity: qty,
        reason,
        refundAmount: parseFloat(refundAmount || "0"),
      });
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-bold">
          Return {item.medicine.name} ({item.batchNumber})
        </h2>
        <div className="space-y-3 text-sm">
          {/* Issue #51: Return quantity must never exceed on-hand stock — was
              previously capped at 2x by mistake which let users return more
              than they had. */}
          <div>
            <label
              htmlFor="pharmacy-return-qty"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-pharmacy-return-qty"
            >
              Quantity to Return
            </label>
            <input
              id="pharmacy-return-qty"
              type="number"
              min={1}
              max={item.quantity}
              placeholder={`Quantity (max ${item.quantity})`}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full rounded border px-3 py-2"
              data-testid="pharmacy-return-qty"
              required
            />
            <p className="mt-1 text-xs text-gray-500" data-testid="pharmacy-return-onhand">
              On hand: {item.quantity}
            </p>
          </div>
          <div>
            <label
              htmlFor="pharmacy-return-reason"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-pharmacy-return-reason"
            >
              Reason for Return
            </label>
            <select
              id="pharmacy-return-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded border px-3 py-2"
            >
              <option value="PATIENT_RETURNED">Patient Returned</option>
              <option value="WRONG_ITEM">Wrong Item</option>
              <option value="EXPIRED">Expired</option>
              <option value="DAMAGED">Damaged</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="pharmacy-return-refund"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-pharmacy-return-refund"
            >
              Refund Amount
            </label>
            <input
              id="pharmacy-return-refund"
              type="number"
              step="0.01"
              placeholder="Refund Amount (optional)"
              value={refundAmount}
              onChange={(e) => setRefundAmount(e.target.value)}
              className="w-full rounded border px-3 py-2"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {saving ? "Saving..." : "Record Return"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TransferModal({
  item,
  onClose,
  onSaved,
}: {
  item: InventoryItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fromLocation, setFromLocation] = useState(item.location || "");
  const [toLocation, setToLocation] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post("/pharmacy/transfers", {
        inventoryItemId: item.id,
        fromLocation,
        toLocation,
        quantity: parseInt(quantity, 10),
        notes: notes || undefined,
      });
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-bold">
          Transfer {item.medicine.name} ({item.batchNumber})
        </h2>
        <div className="space-y-3 text-sm">
          <input
            placeholder="From Location"
            value={fromLocation}
            onChange={(e) => setFromLocation(e.target.value)}
            className="w-full rounded border px-3 py-2"
            required
          />
          <input
            placeholder="To Location"
            value={toLocation}
            onChange={(e) => setToLocation(e.target.value)}
            className="w-full rounded border px-3 py-2"
            required
          />
          <input
            type="number"
            min={1}
            max={item.quantity}
            placeholder="Quantity"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-full rounded border px-3 py-2"
            required
          />
          <textarea
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded border px-3 py-2"
            rows={2}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {saving ? "Saving..." : "Transfer"}
          </button>
        </div>
      </form>
    </div>
  );
}

function AddStockModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [medSearch, setMedSearch] = useState("");
  const [medResults, setMedResults] = useState<Medicine[]>([]);
  const [selectedMed, setSelectedMed] = useState<Medicine | null>(null);
  const [form, setForm] = useState({
    batchNumber: "",
    quantity: "",
    unitCost: "",
    sellingPrice: "",
    expiryDate: "",
    supplier: "",
    location: "",
    reorderLevel: "",
  });
  // Issue #141 / #96 (Apr 2026): per-field error map mirrors the API zod
  // messages so the UI shows a red border + hint instead of a single toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Issue #96: HTML5 `min` for the date picker is tomorrow.
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  useEffect(() => {
    if (medSearch.length < 2) {
      setMedResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: Medicine[] }>(
          `/medicines?search=${encodeURIComponent(medSearch)}`
        );
        setMedResults(res.data);
      } catch {
        setMedResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [medSearch]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Issue #141 / #96: client mirror of the server zod schema. Fail fast
    // so the user sees the field-level error before a network round-trip.
    const errs: Record<string, string> = {};
    if (!selectedMed) errs.medicineId = "Medicine is required";
    if (!form.batchNumber.trim()) errs.batchNumber = "Batch number is required";
    const qty = parseInt(form.quantity, 10);
    if (!form.quantity.trim()) errs.quantity = "Quantity is required";
    else if (!Number.isFinite(qty) || qty < 1)
      errs.quantity = "Quantity must be at least 1";
    const cost = parseFloat(form.unitCost);
    if (!form.unitCost.trim()) errs.unitCost = "Unit cost is required";
    else if (!Number.isFinite(cost) || cost <= 0)
      errs.unitCost = "Unit cost must be greater than 0";
    const price = parseFloat(form.sellingPrice);
    if (!form.sellingPrice.trim())
      errs.sellingPrice = "Selling price is required";
    else if (!Number.isFinite(price) || price <= 0)
      errs.sellingPrice = "Selling price must be greater than 0";
    if (form.reorderLevel.trim()) {
      const ro = parseInt(form.reorderLevel, 10);
      if (!Number.isFinite(ro) || ro < 0)
        errs.reorderLevel = "Reorder level cannot be negative";
    }
    if (!form.expiryDate) errs.expiryDate = "Expiry date is required";
    else if (form.expiryDate < tomorrow)
      errs.expiryDate = "Expiry date must be in the future";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.warning("Please fix the highlighted fields");
      return;
    }
    try {
      await api.post("/pharmacy/inventory", {
        medicineId: selectedMed!.id,
        batchNumber: form.batchNumber.trim(),
        quantity: qty,
        unitCost: cost,
        sellingPrice: price,
        expiryDate: form.expiryDate,
        supplier: form.supplier || undefined,
        location: form.location || undefined,
        reorderLevel: form.reorderLevel
          ? parseInt(form.reorderLevel, 10)
          : undefined,
      });
      onSaved();
      onClose();
    } catch (err) {
      // Surface server-side zod field errors (in case the schema tightens
      // further than the client mirror).
      const payload = (err as { payload?: { details?: Array<{ field?: string; message?: string }> } })
        .payload;
      if (payload?.details && Array.isArray(payload.details)) {
        const next: Record<string, string> = {};
        for (const d of payload.details) {
          if (d?.field && d?.message) next[d.field] = d.message;
        }
        if (Object.keys(next).length > 0) {
          setFieldErrors(next);
          toast.error(Object.values(next)[0] || "Failed to add stock");
          return;
        }
      }
      toast.error(err instanceof Error ? err.message : "Failed to add stock");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
      >
        <h2 className="mb-4 text-lg font-semibold">Add Stock</h2>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">
              Medicine <span className="text-red-600">*</span>
            </label>
            {selectedMed ? (
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900">
                <span data-testid="add-stock-medicine-chosen">
                  {selectedMed.name}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedMed(null)}
                  className="text-xs text-red-600 dark:text-red-400"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  placeholder="Search medicines"
                  value={medSearch}
                  onChange={(e) => setMedSearch(e.target.value)}
                  data-testid="add-stock-medicine-search"
                  aria-invalid={fieldErrors.medicineId ? "true" : undefined}
                  className={
                    "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 " +
                    (fieldErrors.medicineId
                      ? "border-red-500 bg-red-50"
                      : "border-gray-300 dark:border-gray-700")
                  }
                />
                {medResults.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                    {medResults.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setSelectedMed(m);
                          setMedResults([]);
                          if (fieldErrors.medicineId)
                            setFieldErrors((p) => ({ ...p, medicineId: "" }));
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-700"
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {fieldErrors.medicineId && (
              <p
                data-testid="error-add-stock-medicineId"
                className="mt-1 text-xs text-red-600"
              >
                {fieldErrors.medicineId}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Batch #</label>
              <input
                required
                value={form.batchNumber}
                data-testid="add-stock-batch"
                onChange={(e) =>
                  setForm({ ...form, batchNumber: e.target.value })
                }
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (fieldErrors.batchNumber
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 dark:border-gray-700")
                }
              />
              {fieldErrors.batchNumber && (
                <p
                  data-testid="error-add-stock-batchNumber"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.batchNumber}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Quantity</label>
              <input
                required
                type="number"
                /* Issue #96: at least 1 unit per stock entry. */
                min={1}
                step={1}
                value={form.quantity}
                data-testid="add-stock-quantity"
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (fieldErrors.quantity
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 dark:border-gray-700")
                }
              />
              {fieldErrors.quantity && (
                <p
                  data-testid="error-add-stock-quantity"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.quantity}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Unit Cost</label>
              <input
                type="number"
                /* Issue #96: > 0 — a zero-cost batch breaks valuation. */
                min={0.01}
                step="0.01"
                value={form.unitCost}
                data-testid="add-stock-unit-cost"
                onChange={(e) => setForm({ ...form, unitCost: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (fieldErrors.unitCost
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 dark:border-gray-700")
                }
              />
              {fieldErrors.unitCost && (
                <p
                  data-testid="error-add-stock-unitCost"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.unitCost}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Selling Price
              </label>
              <input
                type="number"
                /* Issue #96: > 0 — billing engine never expects ₹0. */
                min={0.01}
                step="0.01"
                value={form.sellingPrice}
                data-testid="add-stock-selling-price"
                onChange={(e) =>
                  setForm({ ...form, sellingPrice: e.target.value })
                }
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (fieldErrors.sellingPrice
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 dark:border-gray-700")
                }
              />
              {fieldErrors.sellingPrice && (
                <p
                  data-testid="error-add-stock-sellingPrice"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.sellingPrice}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Expiry Date
              </label>
              <input
                required
                type="date"
                /* Issue #96: HTML5 min — tomorrow. JS validation also enforces. */
                min={tomorrow}
                value={form.expiryDate}
                data-testid="add-stock-expiry"
                onChange={(e) =>
                  setForm({ ...form, expiryDate: e.target.value })
                }
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (fieldErrors.expiryDate
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 dark:border-gray-700")
                }
              />
              {fieldErrors.expiryDate && (
                <p
                  data-testid="error-add-stock-expiryDate"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.expiryDate}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Supplier</label>
              <input
                value={form.supplier}
                onChange={(e) => setForm({ ...form, supplier: e.target.value })}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Location</label>
              <input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Reorder Level
              </label>
              <input
                type="number"
                /* Issue #96: ≥ 0 (0 = "never auto-flag low stock"). */
                min={0}
                step={1}
                value={form.reorderLevel}
                data-testid="add-stock-reorder-level"
                onChange={(e) =>
                  setForm({ ...form, reorderLevel: e.target.value })
                }
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (fieldErrors.reorderLevel
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 dark:border-gray-700")
                }
              />
              {fieldErrors.reorderLevel && (
                <p
                  data-testid="error-add-stock-reorderLevel"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.reorderLevel}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Add Stock
          </button>
        </div>
      </form>
    </div>
  );
}
