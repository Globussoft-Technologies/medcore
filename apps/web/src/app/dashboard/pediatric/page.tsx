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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Pediatric Patients
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Growth monitoring and developmental tracking for children under 18
        </p>
      </div>

      <div className="mb-4 flex items-center gap-2 rounded-xl bg-white p-3 shadow-sm dark:bg-gray-800 dark:shadow-none dark:ring-1 dark:ring-white/10">
        <Search size={16} className="text-gray-400 dark:text-gray-500" />
        <input
          type="text"
          placeholder="Search by name or MR number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border-0 bg-transparent px-2 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
        />
      </div>

      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800 dark:shadow-none dark:ring-1 dark:ring-white/10">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            Loading...
          </div>
        ) : patients.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
            <div className="rounded-full bg-primary/10 p-3 text-primary dark:bg-primary/20">
              <Baby size={28} />
            </div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
              No pediatric patients found.
            </p>
            <p className="max-w-sm text-xs text-gray-500 dark:text-gray-400">
              Patients under 18 will appear here once registered. Try adjusting
              your search.
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-white/10 dark:text-gray-400">
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
                  <tr
                    key={p.id}
                    className="border-b border-gray-200 last:border-0 dark:border-white/10"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                      {p.mrNumber}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/pediatric/${p.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {p.user.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {age !== null ? `${age}y` : "—"}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {p.gender}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {p.user.phone || "—"}
                    </td>
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
