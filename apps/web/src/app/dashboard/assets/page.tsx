"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { Wrench, Plus, Search, AlertTriangle } from "lucide-react";

interface AssetAssignment {
  id: string;
  assignedTo: string;
  assignedAt: string;
  returnedAt?: string | null;
  location?: string | null;
  notes?: string | null;
  assignee?: { id: string; name: string; role: string };
}

interface MaintenanceLog {
  id: string;
  type: string;
  performedAt: string;
  vendor?: string | null;
  cost?: number | null;
  description: string;
  nextDueDate?: string | null;
  technician?: { id: string; name: string };
}

interface Asset {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  manufacturer?: string | null;
  modelNumber?: string | null;
  serialNumber?: string | null;
  location?: string | null;
  department?: string | null;
  status: "IN_USE" | "IDLE" | "UNDER_MAINTENANCE" | "RETIRED" | "LOST";
  purchaseCost?: number | null;
  purchaseDate?: string | null;
  warrantyExpiry?: string | null;
  amcExpiryDate?: string | null;
  amcProvider?: string | null;
  assignments?: AssetAssignment[];
  maintenance?: MaintenanceLog[];
}

interface User {
  id: string;
  name: string;
  role: string;
}

const STATUS_COLORS: Record<string, string> = {
  IN_USE: "bg-blue-100 text-blue-700",
  IDLE: "bg-green-100 text-green-700",
  UNDER_MAINTENANCE: "bg-yellow-100 text-yellow-700",
  RETIRED: "bg-gray-200 text-gray-700",
  LOST: "bg-red-100 text-red-700",
};

const MAINTENANCE_TYPES = [
  "SCHEDULED",
  "BREAKDOWN",
  "CALIBRATION",
  "INSPECTION",
];

type Tab = "all" | "assigned" | "idle" | "maintenance" | "warranty";

export default function AssetsPage() {
  const { user } = useAuthStore();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("all");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [warrantyAlerts, setWarrantyAlerts] = useState<Asset[]>([]);
  const [maintDue, setMaintDue] = useState<Asset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showAssign, setShowAssign] = useState<Asset | null>(null);
  const [showMaint, setShowMaint] = useState<Asset | null>(null);

  const canManage = user?.role === "ADMIN";

  async function load() {
    setLoading(true);
    try {
      const statusParam = tab === "assigned" ? "IN_USE" : tab === "idle" ? "IDLE" : tab === "maintenance" ? "UNDER_MAINTENANCE" : undefined;
      const qs = [
        `limit=200`,
        search ? `search=${encodeURIComponent(search)}` : null,
        statusParam ? `status=${statusParam}` : null,
      ].filter(Boolean).join("&");

      const [aRes, wRes, mRes] = await Promise.all([
        api.get<{ data: Asset[] }>(`/assets?${qs}`),
        api.get<{ data: Asset[] }>("/assets/warranty/expiring?days=30"),
        api.get<{ data: Asset[] }>("/assets/maintenance/due"),
      ]);
      setAssets(aRes.data);
      setWarrantyAlerts(wRes.data);
      setMaintDue(mRes.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function openAssetDetail(a: Asset) {
    try {
      const res = await api.get<{ data: Asset }>(`/assets/${a.id}`);
      setSelectedAsset(res.data);
    } catch (err) {
      console.error(err);
    }
  }

  async function returnAsset(id: string) {
    if (!(await confirm({ title: "Return this asset?" }))) return;
    try {
      await api.post(`/assets/${id}/return`, {});
      load();
      setSelectedAsset(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const totalAssets = assets.length;
  const inUse = assets.filter((a) => a.status === "IN_USE").length;
  const underMaint = assets.filter((a) => a.status === "UNDER_MAINTENANCE").length;

  const displayList = tab === "warranty" ? warrantyAlerts : assets;

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Wrench className="text-gray-700" size={28} />
        <h1 className="text-2xl font-bold">Asset Management</h1>
        <div className="ml-auto flex gap-2">
          {canManage && (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
            >
              <Plus size={16} /> Add Asset
            </button>
          )}
        </div>
      </div>

      {/* Header stats */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-xs text-gray-500">Total Assets</p>
          <p className="text-2xl font-bold">{totalAssets}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-xs text-gray-500">In Use</p>
          <p className="text-2xl font-bold text-blue-600">{inUse}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-xs text-gray-500">Under Maintenance</p>
          <p className="text-2xl font-bold text-yellow-600">{underMaint}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-xs text-gray-500">Warranty Expiring</p>
          <p className="text-2xl font-bold text-red-600">{warrantyAlerts.length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b">
        {(["all", "assigned", "idle", "maintenance", "warranty"] as Tab[]).map(
          (t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize ${
                tab === t
                  ? "border-b-2 border-blue-600 text-blue-600"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {t === "warranty" ? "Warranty Alerts" : t}
            </button>
          )
        )}
      </div>

      {tab !== "warranty" && (
        <div className="mb-3 flex items-center gap-2 rounded border bg-white px-3 py-2">
          <Search size={16} className="text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="Search by name, tag, serial"
            className="flex-1 outline-none"
          />
          <button
            onClick={load}
            className="rounded bg-gray-100 px-3 py-1 text-xs"
          >
            Search
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <div className="rounded-lg bg-white shadow">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="p-3">Tag</th>
                <th className="p-3">Name</th>
                <th className="p-3">Category</th>
                <th className="p-3">Location</th>
                <th className="p-3">Status</th>
                <th className="p-3">Assigned To</th>
                {tab === "warranty" && <th className="p-3">Warranty Expires</th>}
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayList.map((a) => {
                // Issue #59 (Apr 2026): a RETIRED asset can't have a live
                // assignee — the API closes any active assignment when it
                // transitions to RETIRED, but until that data has flowed
                // back we also hide the column at the UI level so a stale
                // open-assignment row never leaks the previous owner.
                const active =
                  a.status === "RETIRED"
                    ? undefined
                    : a.assignments?.find((as) => !as.returnedAt);
                return (
                  <tr
                    key={a.id}
                    className="border-b hover:bg-gray-50 cursor-pointer"
                    onClick={() => openAssetDetail(a)}
                  >
                    <td className="p-3 font-mono text-xs">{a.assetTag}</td>
                    <td className="p-3 font-medium">{a.name}</td>
                    <td className="p-3">{a.category}</td>
                    <td className="p-3 text-xs text-gray-500">{a.location || "—"}</td>
                    <td className="p-3">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          STATUS_COLORS[a.status] || "bg-gray-100"
                        }`}
                      >
                        {a.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="p-3 text-xs">
                      {active?.assignee?.name || "—"}
                    </td>
                    {tab === "warranty" && (
                      <td className="p-3 text-xs text-red-600">
                        {a.warrantyExpiry
                          ? new Date(a.warrantyExpiry).toLocaleDateString()
                          : "—"}
                      </td>
                    )}
                    <td className="p-3" onClick={(e) => e.stopPropagation()}>
                      {canManage && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => setShowAssign(a)}
                            className="rounded bg-blue-600 px-2 py-1 text-xs text-white"
                          >
                            Assign
                          </button>
                          <button
                            onClick={() => setShowMaint(a)}
                            className="rounded bg-yellow-600 px-2 py-1 text-xs text-white"
                          >
                            Log Maintenance
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {displayList.length === 0 && (
                <tr>
                  <td colSpan={tab === "warranty" ? 8 : 7} className="p-6 text-center text-gray-400">
                    No assets
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {maintDue.length > 0 && tab === "maintenance" && (
        <div className="mt-4 rounded border-l-4 border-yellow-500 bg-yellow-50 p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-yellow-700" />
            <p className="font-medium text-yellow-800">
              {maintDue.length} assets have maintenance due in the next 30 days
            </p>
          </div>
        </div>
      )}

      {/* Side panel */}
      {selectedAsset && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
          <div className="h-full w-full max-w-lg overflow-auto bg-white p-6">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold">{selectedAsset.name}</h2>
                <p className="font-mono text-xs text-gray-500">
                  {selectedAsset.assetTag}
                </p>
              </div>
              <button
                onClick={() => setSelectedAsset(null)}
                className="text-gray-400"
              >
                ✕
              </button>
            </div>

            <div className="mb-4 space-y-1 text-sm">
              <div>
                <strong>Category:</strong> {selectedAsset.category}
              </div>
              {selectedAsset.manufacturer && (
                <div>
                  <strong>Manufacturer:</strong> {selectedAsset.manufacturer}
                </div>
              )}
              {selectedAsset.modelNumber && (
                <div>
                  <strong>Model:</strong> {selectedAsset.modelNumber}
                </div>
              )}
              {selectedAsset.serialNumber && (
                <div>
                  <strong>Serial:</strong> {selectedAsset.serialNumber}
                </div>
              )}
              {selectedAsset.location && (
                <div>
                  <strong>Location:</strong> {selectedAsset.location}
                </div>
              )}
              {selectedAsset.warrantyExpiry && (
                <div>
                  <strong>Warranty:</strong>{" "}
                  {new Date(selectedAsset.warrantyExpiry).toLocaleDateString()}
                </div>
              )}
              {selectedAsset.amcExpiryDate && (
                <div>
                  <strong>AMC:</strong> {selectedAsset.amcProvider} (exp{" "}
                  {new Date(selectedAsset.amcExpiryDate).toLocaleDateString()})
                </div>
              )}
              <div>
                <strong>Status:</strong>{" "}
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    STATUS_COLORS[selectedAsset.status]
                  }`}
                >
                  {selectedAsset.status.replace(/_/g, " ")}
                </span>
              </div>
            </div>

            <h3 className="mb-2 font-semibold">Assignment History</h3>
            <div className="mb-4 space-y-2">
              {selectedAsset.assignments?.length === 0 && (
                <p className="text-xs text-gray-400">No assignments</p>
              )}
              {selectedAsset.assignments?.map((as) => (
                <div key={as.id} className="rounded border p-2 text-xs">
                  <div className="font-medium">{as.assignee?.name}</div>
                  <div className="text-gray-500">
                    {new Date(as.assignedAt).toLocaleDateString()}
                    {as.returnedAt
                      ? ` → ${new Date(as.returnedAt).toLocaleDateString()}`
                      : selectedAsset.status === "RETIRED"
                        ? " (closed on retire)"
                        : " (current)"}
                  </div>
                  {as.location && <div>@ {as.location}</div>}
                </div>
              ))}
              {canManage &&
                selectedAsset.status !== "RETIRED" &&
                selectedAsset.assignments?.some((as) => !as.returnedAt) && (
                  <button
                    onClick={() => returnAsset(selectedAsset.id)}
                    className="rounded bg-gray-600 px-3 py-1 text-xs text-white"
                  >
                    Return Asset
                  </button>
                )}
            </div>

            <h3 className="mb-2 font-semibold">Maintenance History</h3>
            <div className="space-y-2">
              {selectedAsset.maintenance?.length === 0 && (
                <p className="text-xs text-gray-400">No maintenance logs</p>
              )}
              {selectedAsset.maintenance?.map((m) => (
                <div key={m.id} className="rounded border p-2 text-xs">
                  <div className="flex justify-between">
                    <span className="font-medium">{m.type}</span>
                    <span className="text-gray-500">
                      {new Date(m.performedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="text-gray-700">{m.description}</div>
                  {m.vendor && <div className="text-gray-500">Vendor: {m.vendor}</div>}
                  {m.nextDueDate && (
                    <div className="text-gray-500">
                      Next due: {new Date(m.nextDueDate).toLocaleDateString()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <AddAssetModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {showAssign && (
        <AssignModal
          asset={showAssign}
          onClose={() => setShowAssign(null)}
          onSaved={() => {
            setShowAssign(null);
            load();
          }}
        />
      )}

      {showMaint && (
        <MaintenanceModal
          asset={showMaint}
          onClose={() => setShowMaint(null)}
          onSaved={() => {
            setShowMaint(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function AddAssetModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    assetTag: "",
    name: "",
    category: "Medical Equipment",
    manufacturer: "",
    modelNumber: "",
    serialNumber: "",
    purchaseDate: "",
    purchaseCost: "",
    warrantyExpiry: "",
    location: "",
    department: "",
    amcProvider: "",
    amcExpiryDate: "",
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.post("/assets", {
        assetTag: form.assetTag,
        name: form.name,
        category: form.category,
        manufacturer: form.manufacturer || undefined,
        modelNumber: form.modelNumber || undefined,
        serialNumber: form.serialNumber || undefined,
        purchaseDate: form.purchaseDate || undefined,
        purchaseCost: form.purchaseCost ? Number(form.purchaseCost) : undefined,
        warrantyExpiry: form.warrantyExpiry || undefined,
        location: form.location || undefined,
        department: form.department || undefined,
        amcProvider: form.amcProvider || undefined,
        amcExpiryDate: form.amcExpiryDate || undefined,
      });
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Add Asset</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <input
            placeholder="Asset Tag (e.g. ASSET-001)"
            className="w-full rounded border p-2"
            value={form.assetTag}
            onChange={(e) => setForm({ ...form, assetTag: e.target.value })}
          />
          <input
            placeholder="Name"
            className="w-full rounded border p-2"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <select
            className="w-full rounded border p-2"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            <option>Medical Equipment</option>
            <option>IT</option>
            <option>Furniture</option>
            <option>Vehicle</option>
            <option>Other</option>
          </select>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Manufacturer"
              className="rounded border p-2"
              value={form.manufacturer}
              onChange={(e) => setForm({ ...form, manufacturer: e.target.value })}
            />
            <input
              placeholder="Model Number"
              className="rounded border p-2"
              value={form.modelNumber}
              onChange={(e) => setForm({ ...form, modelNumber: e.target.value })}
            />
          </div>
          <input
            placeholder="Serial Number"
            className="w-full rounded border p-2"
            value={form.serialNumber}
            onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600">Purchase Date</label>
              <input
                type="date"
                className="w-full rounded border p-2"
                value={form.purchaseDate}
                onChange={(e) =>
                  setForm({ ...form, purchaseDate: e.target.value })
                }
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Cost (₹)</label>
              <input
                type="number"
                className="w-full rounded border p-2"
                value={form.purchaseCost}
                onChange={(e) =>
                  setForm({ ...form, purchaseCost: e.target.value })
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600">Warranty Expiry</label>
              <input
                type="date"
                className="w-full rounded border p-2"
                value={form.warrantyExpiry}
                onChange={(e) =>
                  setForm({ ...form, warrantyExpiry: e.target.value })
                }
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">AMC Expiry</label>
              <input
                type="date"
                className="w-full rounded border p-2"
                value={form.amcExpiryDate}
                onChange={(e) =>
                  setForm({ ...form, amcExpiryDate: e.target.value })
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Location"
              className="rounded border p-2"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
            <input
              placeholder="Department"
              className="rounded border p-2"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
            />
          </div>
          <input
            placeholder="AMC Provider"
            className="w-full rounded border p-2"
            value={form.amcProvider}
            onChange={(e) => setForm({ ...form, amcProvider: e.target.value })}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !form.assetTag || !form.name}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Add Asset"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssignModal({
  asset,
  onClose,
  onSaved,
}: {
  asset: Asset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [assignedTo, setAssignedTo] = useState("");
  const [location, setLocation] = useState(asset.location || "");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ data: User[] }>("/auth/users?limit=200")
      .then((res) => setUsers(res.data || []))
      .catch(() => {
        // fallback: try /users
        api
          .get<{ data: User[] }>("/users?limit=200")
          .then((r) => setUsers(r.data || []))
          .catch(console.error);
      });
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api.post(`/assets/${asset.id}/assign`, {
        assignedTo,
        location: location || undefined,
        notes: notes || undefined,
      });
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Assign {asset.name}</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <select
            className="w-full rounded border p-2"
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
          >
            <option value="">Select staff member</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </select>
          <input
            placeholder="Location"
            className="w-full rounded border p-2"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <textarea
            placeholder="Notes"
            className="w-full rounded border p-2"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !assignedTo}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Assign"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MaintenanceModal({
  asset,
  onClose,
  onSaved,
}: {
  asset: Asset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState("SCHEDULED");
  const [vendor, setVendor] = useState("");
  const [cost, setCost] = useState("");
  const [description, setDescription] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.post("/assets/maintenance", {
        assetId: asset.id,
        type,
        vendor: vendor || undefined,
        cost: cost ? Number(cost) : undefined,
        description,
        nextDueDate: nextDueDate || undefined,
      });
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Log Maintenance — {asset.name}</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <select
            className="w-full rounded border p-2"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {MAINTENANCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            placeholder="Vendor"
            className="w-full rounded border p-2"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
          <input
            type="number"
            placeholder="Cost (₹)"
            className="w-full rounded border p-2"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
          <textarea
            placeholder="Description"
            className="w-full rounded border p-2"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div>
            <label className="text-xs text-gray-600">Next due date</label>
            <input
              type="date"
              className="w-full rounded border p-2"
              value={nextDueDate}
              onChange={(e) => setNextDueDate(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !description}
            className="rounded bg-yellow-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Log"}
          </button>
        </div>
      </div>
    </div>
  );
}
