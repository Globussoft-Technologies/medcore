"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { ArrowLeft, AlertTriangle, Activity, FileText, BedDouble, Filter } from "lucide-react";
import { SkeletonCard } from "@/components/Skeleton";

interface ProblemItem {
  id: string;
  type: "condition" | "allergy" | "diagnosis" | "admission";
  title: string;
  severity: string;
  status: string;
  lastUpdated: string;
  source: string;
  icd10Code?: string | null;
}

const severityColor: Record<string, string> = {
  LIFE_THREATENING: "bg-red-100 text-red-800 border-red-300",
  SEVERE: "bg-orange-100 text-orange-800 border-orange-300",
  ACTIVE: "bg-amber-100 text-amber-800 border-amber-300",
  RELAPSED: "bg-amber-100 text-amber-800 border-amber-300",
  CONTROLLED: "bg-yellow-50 text-yellow-800 border-yellow-200",
  MODERATE: "bg-yellow-50 text-yellow-800 border-yellow-200",
  MILD: "bg-slate-100 text-slate-700 border-slate-200",
  ADMITTED: "bg-blue-100 text-blue-800 border-blue-300",
};

function iconFor(type: ProblemItem["type"]) {
  switch (type) {
    case "condition":
      return <Activity className="h-4 w-4" />;
    case "allergy":
      return <AlertTriangle className="h-4 w-4" />;
    case "diagnosis":
      return <FileText className="h-4 w-4" />;
    case "admission":
      return <BedDouble className="h-4 w-4" />;
  }
}

export default function PatientProblemListPage() {
  const params = useParams();
  const patientId = params.id as string;
  const [items, setItems] = useState<ProblemItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeOnly, setActiveOnly] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        qs.set("activeOnly", String(activeOnly));
        if (typeFilter) qs.set("type", typeFilter);
        const res = await api.get<{ data: ProblemItem[] }>(
          `/ehr/patients/${patientId}/problem-list?${qs.toString()}`
        );
        setItems(res.data || []);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [patientId, activeOnly, typeFilter]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <Link
          href={`/dashboard/patients/${patientId}`}
          className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" /> Back to patient
        </Link>
        <h1 className="text-2xl font-bold mt-2">Consolidated Problem List</h1>
        <p className="text-sm text-slate-600">
          Active conditions, severe allergies, recent diagnoses and current admission.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 items-center mb-4 p-3 bg-white border border-slate-200 rounded-lg">
        <Filter className="h-4 w-4 text-slate-500" />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
          />
          Active only
        </label>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="text-sm border border-slate-200 rounded px-2 py-1"
        >
          <option value="">All types</option>
          <option value="condition">Conditions</option>
          <option value="allergy">Allergies</option>
          <option value="diagnosis">Diagnoses</option>
          <option value="admission">Admission</option>
        </select>
        <span className="text-xs text-slate-500 ml-auto">{items.length} items</span>
      </div>

      {loading ? (
        <div
          data-testid="problem-list-loading"
          aria-busy="true"
          className="space-y-3"
        >
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : items.length === 0 ? (
        <div className="p-8 text-center text-slate-500 border border-dashed border-slate-300 rounded-lg">
          No problems found.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((p) => (
            <li
              key={`${p.type}-${p.id}`}
              className="p-4 bg-white border border-slate-200 rounded-lg flex items-start gap-4 hover:shadow-sm"
            >
              <div className="mt-1 text-slate-600">{iconFor(p.type)}</div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900">{p.title}</span>
                  {p.icd10Code && (
                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                      {p.icd10Code}
                    </span>
                  )}
                  <span
                    className={`text-xs px-2 py-0.5 rounded border ${
                      severityColor[p.severity] || "bg-slate-100 text-slate-700 border-slate-200"
                    }`}
                  >
                    {p.severity}
                  </span>
                </div>
                <div className="text-sm text-slate-600 mt-0.5">{p.source}</div>
              </div>
              <div className="text-xs text-slate-500 shrink-0">
                {new Date(p.lastUpdated).toLocaleDateString()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
