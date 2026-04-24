"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Upload, X } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";

interface Visitor {
  id: string;
  passNumber: string;
  name: string;
  phone: string | null;
  idProofType: string | null;
  idProofNumber: string | null;
  patientId: string | null;
  purpose: string;
  department: string | null;
  checkInAt: string;
  checkOutAt: string | null;
  notes: string | null;
  photoUrl?: string | null;
  patient?: { user: { name: string; phone: string } };
}

interface Stats {
  totalToday: number;
  currentInside: number;
  byPurpose: Record<string, number>;
}

const ID_TYPES = ["Aadhaar", "PAN", "Driving License", "Passport", "Voter ID"];
const PURPOSES = ["PATIENT_VISIT", "DELIVERY", "APPOINTMENT", "MEETING", "OTHER"];
const PURPOSE_COLORS: Record<string, string> = {
  PATIENT_VISIT: "bg-blue-500",
  DELIVERY: "bg-green-500",
  APPOINTMENT: "bg-purple-500",
  MEETING: "bg-yellow-500",
  OTHER: "bg-gray-500",
};

function elapsedMinutes(checkInAt: string, checkOutAt: string | null): number {
  const end = checkOutAt ? new Date(checkOutAt).getTime() : Date.now();
  return Math.round((end - new Date(checkInAt).getTime()) / 60000);
}

export default function VisitorsPage() {
  const confirm = useConfirm();
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<"active" | "today">("active");
  const [showModal, setShowModal] = useState(false);
  const [printVisitor, setPrintVisitor] = useState<Visitor | null>(null);
  const [loading, setLoading] = useState(true);

  // Camera state
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Photo data
  const [photoData, setPhotoData] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    phone: "",
    idProofType: "Aadhaar",
    idProofNumber: "",
    patientId: "",
    purpose: "PATIENT_VISIT",
    department: "",
    notes: "",
  });

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Cleanup camera on unmount / modal close
  useEffect(() => {
    return () => stopCamera();
  }, []);

  async function load() {
    setLoading(true);
    try {
      let endpoint = "/visitors/active";
      if (tab === "today") {
        const today = new Date().toISOString().split("T")[0];
        endpoint = `/visitors?date=${today}&limit=200`;
      }
      const [listRes, statsRes] = await Promise.all([
        api.get<{ data: Visitor[] }>(endpoint),
        api.get<{ data: Stats }>("/visitors/stats/daily"),
      ]);
      setVisitors(listRes.data);
      setStats(statsRes.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function startCamera() {
    setCameraError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera API not available");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240 },
      });
      streamRef.current = stream;
      setCameraOpen(true);
      // wait a tick for video ref
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      }, 50);
    } catch (err) {
      setCameraError(
        err instanceof Error ? err.message : "Camera unavailable"
      );
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
  }

  function capturePhoto() {
    if (!videoRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth || 320;
    canvas.height = videoRef.current.videoHeight || 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    setPhotoData(dataUrl);
    stopCamera();
  }

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") setPhotoData(result);
    };
    reader.readAsDataURL(file);
  }

  async function checkIn() {
    if (!form.name) {
      toast.error("Name is required");
      return;
    }
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        purpose: form.purpose,
      };
      if (form.phone) body.phone = form.phone;
      if (form.idProofType) body.idProofType = form.idProofType;
      if (form.idProofNumber) body.idProofNumber = form.idProofNumber;
      if (form.patientId) body.patientId = form.patientId;
      if (form.department) body.department = form.department;
      if (form.notes) body.notes = form.notes;

      const res = await api.post<{ data: Visitor }>("/visitors", body);
      const newVisitor = res.data;

      // If we captured a photo, save it
      if (photoData) {
        try {
          await api.patch(`/visitors/${newVisitor.id}/photo`, {
            photoUrl: photoData,
          });
          newVisitor.photoUrl = photoData;
        } catch {
          // ignore photo failure
        }
      }

      setShowModal(false);
      setForm({
        name: "",
        phone: "",
        idProofType: "Aadhaar",
        idProofNumber: "",
        patientId: "",
        purpose: "PATIENT_VISIT",
        department: "",
        notes: "",
      });
      setPhotoData(null);
      stopCamera();
      load();
      setPrintVisitor(newVisitor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function checkOut(id: string) {
    if (!(await confirm({ title: "Check out this visitor?" }))) return;
    try {
      await api.patch(`/visitors/${id}/checkout`, {});
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  function closeModal() {
    setShowModal(false);
    setPhotoData(null);
    stopCamera();
  }

  const total = Object.values(stats?.byPurpose || {}).reduce(
    (a, b) => a + b,
    0
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Visitors</h1>
        <button
          onClick={() => setShowModal(true)}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          Check In Visitor
        </button>
      </div>

      {/* Stats */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <p className="text-xs text-gray-500">Total Today</p>
          <p className="text-3xl font-bold">{stats?.totalToday || 0}</p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <p className="text-xs text-gray-500">Currently Inside</p>
          <p className="text-3xl font-bold text-green-600">
            {stats?.currentInside || 0}
          </p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <p className="mb-2 text-xs text-gray-500">By Purpose (Today)</p>
          <div className="space-y-1">
            {PURPOSES.map((p) => {
              const count = stats?.byPurpose[p] || 0;
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={p} className="flex items-center gap-2">
                  <div className="w-24 text-xs text-gray-600">
                    {p.replace(/_/g, " ")}
                  </div>
                  <div className="relative h-3 flex-1 rounded bg-gray-100">
                    <div
                      className={`h-full rounded ${PURPOSE_COLORS[p]}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="w-6 text-right text-xs font-semibold">
                    {count}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setTab("active")}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            tab === "active"
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-600"
          }`}
        >
          Active
        </button>
        <button
          onClick={() => setTab("today")}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            tab === "today"
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-600"
          }`}
        >
          All Today
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : visitors.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No visitors</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Photo</th>
                <th className="px-4 py-3">Pass #</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Purpose</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Department</th>
                <th className="px-4 py-3">Check-in</th>
                <th className="px-4 py-3">Elapsed</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visitors.map((v) => (
                <tr key={v.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    {v.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={v.photoUrl}
                        alt={v.name}
                        className="h-10 w-10 rounded-full object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-500">
                        {v.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {v.passNumber}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">{v.name}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {v.phone || "-"}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {v.purpose.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {v.patient?.user.name || "-"}
                  </td>
                  <td className="px-4 py-3 text-xs">{v.department || "-"}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(v.checkInAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-3 text-xs font-semibold">
                    {elapsedMinutes(v.checkInAt, v.checkOutAt)}m
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => setPrintVisitor(v)}
                        className="rounded bg-gray-500 px-2 py-1 text-xs text-white hover:bg-gray-600"
                      >
                        Print Pass
                      </button>
                      {!v.checkOutAt && (
                        <button
                          onClick={() => checkOut(v.id)}
                          className="rounded bg-green-500 px-2 py-1 text-xs text-white hover:bg-green-600"
                        >
                          Check Out
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Check-in modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">Check In Visitor</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Name *
                </label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Phone
                </label>
                <input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  ID Type
                </label>
                <select
                  value={form.idProofType}
                  onChange={(e) =>
                    setForm({ ...form, idProofType: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {ID_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  ID Number
                </label>
                <input
                  value={form.idProofNumber}
                  onChange={(e) =>
                    setForm({ ...form, idProofNumber: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Purpose
                </label>
                <select
                  value={form.purpose}
                  onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {p.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Department
                </label>
                <input
                  value={form.department}
                  onChange={(e) =>
                    setForm({ ...form, department: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Patient ID (optional)
                </label>
                <input
                  value={form.patientId}
                  onChange={(e) =>
                    setForm({ ...form, patientId: e.target.value })
                  }
                  placeholder="UUID if visiting a patient"
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Notes
                </label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>

              {/* Photo capture */}
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Photo
                </label>
                {cameraOpen ? (
                  <div className="flex flex-col items-center gap-2 rounded-lg border bg-gray-50 p-3">
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      className="w-full max-w-xs rounded bg-black"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={capturePhoto}
                        className="rounded bg-primary px-3 py-1 text-xs text-white"
                      >
                        Capture
                      </button>
                      <button
                        onClick={stopCamera}
                        className="rounded border px-3 py-1 text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : photoData ? (
                  <div className="flex items-center gap-3 rounded-lg border p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photoData}
                      alt="Captured"
                      className="h-20 w-20 rounded object-cover"
                    />
                    <button
                      onClick={() => setPhotoData(null)}
                      className="flex items-center gap-1 rounded border px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      <X size={12} /> Remove
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={startCamera}
                      className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
                    >
                      <Camera size={14} /> Capture Photo
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
                    >
                      <Upload size={14} /> Upload Photo
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={onFileSelected}
                      className="hidden"
                    />
                  </div>
                )}
                {cameraError && (
                  <p className="mt-1 text-xs text-red-600">
                    {cameraError}. Try uploading a photo instead.
                  </p>
                )}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={closeModal}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={checkIn}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white"
              >
                Check In
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Print pass modal */}
      {printVisitor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 print:bg-white">
          <div className="w-full max-w-xs rounded-xl bg-white p-6 shadow-xl print:shadow-none">
            <div id="visitor-pass" className="text-center">
              <h2 className="text-xl font-bold">VISITOR PASS</h2>
              <p className="mb-2 text-xs text-gray-500">MedCore Hospital</p>
              {printVisitor.photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={printVisitor.photoUrl}
                  alt={printVisitor.name}
                  className="mx-auto mb-2 h-20 w-20 rounded-full border object-cover"
                />
              )}
              <div className="border-y py-3">
                <p className="font-mono text-lg font-bold">
                  {printVisitor.passNumber}
                </p>
              </div>
              <div className="mt-3 space-y-1 text-left text-sm">
                <p>
                  <span className="font-semibold">Name:</span> {printVisitor.name}
                </p>
                <p>
                  <span className="font-semibold">Purpose:</span>{" "}
                  {printVisitor.purpose.replace(/_/g, " ")}
                </p>
                {printVisitor.department && (
                  <p>
                    <span className="font-semibold">Dept:</span>{" "}
                    {printVisitor.department}
                  </p>
                )}
                <p>
                  <span className="font-semibold">Time:</span>{" "}
                  {new Date(printVisitor.checkInAt).toLocaleString()}
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2 print:hidden">
              <button
                onClick={() => setPrintVisitor(null)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700"
              >
                Close
              </button>
              <button
                onClick={() => window.print()}
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white"
              >
                Print
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
