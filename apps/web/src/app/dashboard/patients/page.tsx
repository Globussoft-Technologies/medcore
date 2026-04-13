"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Search, Plus } from "lucide-react";

interface PatientRecord {
  id: string;
  mrNumber: string;
  gender: string;
  age: number | null;
  bloodGroup: string | null;
  user: { id: string; name: string; email: string; phone: string };
}

export default function PatientsPage() {
  const { user } = useAuthStore();
  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    age: "",
    gender: "MALE",
    address: "",
    bloodGroup: "",
  });
  const [total, setTotal] = useState(0);

  useEffect(() => {
    loadPatients();
  }, [search]);

  async function loadPatients() {
    setLoading(true);
    try {
      const q = search ? `&search=${encodeURIComponent(search)}` : "";
      const res = await api.get<{ data: PatientRecord[]; meta: { total: number } }>(
        `/patients?limit=50${q}`
      );
      setPatients(res.data);
      setTotal(res.meta?.total ?? 0);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function handleCreatePatient(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post("/patients", {
        ...form,
        age: form.age ? parseInt(form.age) : undefined,
        bloodGroup: form.bloodGroup || undefined,
      });
      setShowForm(false);
      setForm({ name: "", phone: "", email: "", age: "", gender: "MALE", address: "", bloodGroup: "" });
      loadPatients();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to register patient");
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Patients</h1>
          <p className="text-sm text-gray-500">{total} registered patients</p>
        </div>
        {(user?.role === "RECEPTION" || user?.role === "ADMIN") && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Register Patient
          </button>
        )}
      </div>

      {/* Registration form */}
      {showForm && (
        <form
          onSubmit={handleCreatePatient}
          className="mb-6 rounded-xl bg-white p-6 shadow-sm"
        >
          <h2 className="mb-4 font-semibold">New Patient Registration</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <input
              required
              placeholder="Full Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              required
              placeholder="Phone Number"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              placeholder="Email (optional)"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              placeholder="Age"
              type="number"
              value={form.age}
              onChange={(e) => setForm({ ...form, age: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <select
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
            </select>
            <select
              value={form.bloodGroup}
              onChange={(e) => setForm({ ...form, bloodGroup: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="">Blood Group (optional)</option>
              <option value="A+">A+</option>
              <option value="A-">A-</option>
              <option value="B+">B+</option>
              <option value="B-">B-</option>
              <option value="AB+">AB+</option>
              <option value="AB-">AB-</option>
              <option value="O+">O+</option>
              <option value="O-">O-</option>
            </select>
            <input
              placeholder="Address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="col-span-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              Register
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Search */}
      <div className="relative mb-4">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
        />
        <input
          placeholder="Search by name, phone, or MR number..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border py-2.5 pl-10 pr-4 text-sm"
        />
      </div>

      {/* Patients list */}
      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : patients.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No patients found
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">MR Number</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Gender</th>
                <th className="px-4 py-3">Blood Group</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-sm font-medium text-primary">
                    <Link href={`/dashboard/patients/${p.id}`} className="hover:underline">
                      {p.mrNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-medium">{p.user.name}</td>
                  <td className="px-4 py-3 text-sm">{p.user.phone}</td>
                  <td className="px-4 py-3 text-sm">{p.age ?? "—"}</td>
                  <td className="px-4 py-3 text-sm">{p.gender}</td>
                  <td className="px-4 py-3 text-sm">{p.bloodGroup || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
