"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Search, Baby } from "lucide-react";

interface Patient {
  id: string;
  mrNumber: string;
  dateOfBirth?: string | null;
  age?: number | null;
  gender: string;
  user: { name: string; phone?: string };
}

function computeAgeYears(p: Patient): number | null {
  if (p.dateOfBirth) {
    const diff = Date.now() - new Date(p.dateOfBirth).getTime();
    // Issue #751: future-dated DOB rows (data-entry error) previously rendered
    // negative ages like "-74y" / "-884 months" on the pediatric list.
    // Treat anything with DOB > today as invalid and surface as null so the
    // table shows the "—" sentinel and the <18 filter excludes them.
    if (diff < 0) return null;
    return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
  }
  if (typeof p.age === "number" && p.age < 0) return null;
  return p.age ?? null;
}

export default function PediatricPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
  }, [search]);

  async function load() {
    setLoading(true);
    try {
      const qs = search
        ? `?search=${encodeURIComponent(search)}&limit=200`
        : "?limit=200";
      const res = await api.get<{ data: Patient[] }>(`/patients${qs}`);
      // filter age < 18
      const peds = res.data.filter((p) => {
        const age = computeAgeYears(p);
        return age !== null && age < 18;
      });
      setPatients(peds);
    } catch {
      // empty
    }
    setLoading(false);
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Pediatric Patients</h1>
        <p className="text-sm text-gray-500">
          Growth monitoring and developmental tracking for children under 18
        </p>
      </div>

      <div className="mb-4 flex items-center gap-2 rounded-xl bg-white p-3 shadow-sm">
        <Search size={16} className="text-gray-400" />
        <input
          type="text"
          placeholder="Search by name or MR number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border-0 px-2 py-1 text-sm outline-none"
        />
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : patients.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No pediatric patients found.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">MR Number</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Gender</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => {
                const age = computeAgeYears(p);
                return (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">{p.mrNumber}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/pediatric/${p.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {p.user.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {age !== null ? `${age}y` : "—"}
                    </td>
                    <td className="px-4 py-3 text-sm">{p.gender}</td>
                    <td className="px-4 py-3 text-sm">{p.user.phone || "—"}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/pediatric/${p.id}`}
                        className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-dark"
                      >
                        <Baby size={12} /> Growth Chart
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
