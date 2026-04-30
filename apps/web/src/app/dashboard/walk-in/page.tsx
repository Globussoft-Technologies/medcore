"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { sanitizeUserInput } from "@medcore/shared";

interface Doctor {
  id: string;
  user: { name: string };
  specialization: string;
}

interface PatientResult {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
}

export default function WalkInPage() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<PatientResult[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientResult | null>(null);
  const [showNewPatient, setShowNewPatient] = useState(false);
  const [newPatient, setNewPatient] = useState({
    name: "",
    phone: "",
    gender: "MALE",
    age: "",
    // Issue #206 (2026-04-30): reception needs DOB / Address / Email at
    // walk-in registration so the back office isn't chasing the patient
    // for these later. All three are optional on the API side.
    dateOfBirth: "",
    address: "",
    email: "",
  });
  // Issue #354: track age error too now that the walk-in "+ New Patient"
  // form enforces a sane numeric range.
  // Issue #206: extend errors map to cover DOB / address / email.
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    phone?: string;
    age?: string;
    dateOfBirth?: string;
    address?: string;
    email?: string;
  }>({});
  const [result, setResult] = useState<{
    tokenNumber: number;
    doctorName: string;
    patientName: string;
    // Issue #118: surface MR number on the success card alongside the
    // patient name so the front-desk can confirm at a glance.
    mrNumber: string;
  } | null>(null);

  useEffect(() => {
    api
      .get<{ data: Doctor[] }>("/doctors")
      .then((r) => setDoctors(r.data))
      .catch(() => {});
  }, []);

  async function searchPatients(q: string) {
    setSearch(q);
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      const res = await api.get<{ data: PatientResult[] }>(
        `/patients?search=${encodeURIComponent(q)}&limit=5`
      );
      setSearchResults(res.data);
    } catch {
      // empty
    }
  }

  // Issue #354 (2026-04-26): align walk-in "+ New Patient" with the canonical
  // patient name/phone regexes from packages/shared (so digits in names and
  // letters in phones get rejected here, not just on the patient list page).
  // Issue #167: age must be at least 1 for adult registration unless the user
  // also supplies a date of birth.
  const PATIENT_NAME_REGEX_LOCAL = /^[A-Za-zऀ-ॿ\s.\-']{2,100}$/;
  const PHONE_REGEX_LOCAL = /^\+?\d{10,15}$/;
  // Issue #206: simple sanity-check email regex (server applies the
  // canonical RFC-ish check via zod's .email()).
  const EMAIL_REGEX_LOCAL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function validateNewPatient(): boolean {
    const errs: {
      name?: string;
      phone?: string;
      age?: string;
      dateOfBirth?: string;
      address?: string;
      email?: string;
    } = {};
    // Issue #260, #284 (Apr 2026): layer the canonical XSS-rejecting
    // sanitizer on top of the existing PATIENT_NAME_REGEX so the same
    // payload that XSSed staff fields can't slip through Walk-in either.
    const sanitized = sanitizeUserInput(newPatient.name, {
      field: "Name",
      maxLength: 100,
    });
    const trimmedName = sanitized.ok ? sanitized.value! : "";
    if (!sanitized.ok) errs.name = sanitized.error || "Name is required";
    else if (!PATIENT_NAME_REGEX_LOCAL.test(trimmedName))
      errs.name =
        "Name must be 2–100 characters; letters, spaces, dots, hyphens, apostrophes only";
    const trimmedPhone = newPatient.phone.trim();
    if (!trimmedPhone) errs.phone = "Phone number is required";
    else if (!PHONE_REGEX_LOCAL.test(trimmedPhone))
      errs.phone = "Phone must be 10–15 digits, optional leading +";
    if (newPatient.age) {
      const a = parseInt(newPatient.age, 10);
      if (Number.isNaN(a) || a < 1 || a > 150) {
        errs.age = "Age must be between 1 and 150";
      }
    }
    // Issue #206: DOB must parse and not be in the future. Empty is OK
    // (field is optional on the API side).
    if (newPatient.dateOfBirth) {
      const dob = new Date(newPatient.dateOfBirth);
      if (Number.isNaN(dob.getTime())) {
        errs.dateOfBirth = "Invalid date of birth";
      } else {
        const today = new Date();
        today.setHours(23, 59, 59, 999);
        if (dob.getTime() > today.getTime()) {
          errs.dateOfBirth = "Date of birth cannot be in the future";
        }
      }
    }
    // Issue #206: address is free-form but bounded so a paste-bomb
    // can't break the row.
    if (newPatient.address && newPatient.address.length > 500) {
      errs.address = "Address must be at most 500 characters";
    }
    // Issue #206: email is optional, but if present must look like one.
    if (newPatient.email) {
      const trimmedEmail = newPatient.email.trim();
      if (!EMAIL_REGEX_LOCAL.test(trimmedEmail)) {
        errs.email = "Email must be a valid address (e.g. user@example.com)";
      }
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function registerAndWalkIn() {
    if (!validateNewPatient()) return;
    try {
      // Register new patient first
      // Issue #206: pass DOB / address / email through so the User+Patient
      // rows are seeded with what reception captured here. The /patients
      // route already accepts these fields via createPatientSchema.
      const patientRes = await api.post<{ data: PatientResult }>("/patients", {
        name: newPatient.name,
        phone: newPatient.phone,
        gender: newPatient.gender,
        age: newPatient.age ? parseInt(newPatient.age) : undefined,
        dateOfBirth: newPatient.dateOfBirth || undefined,
        address: newPatient.address.trim() || undefined,
        email: newPatient.email.trim() || undefined,
      });

      // Then register walk-in
      await submitWalkIn(patientRes.data.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
    }
  }

  async function submitWalkIn(patientId: string) {
    try {
      const res = await api.post<{
        data: {
          tokenNumber: number;
          doctor: { user: { name: string } };
          patient: { user: { name: string }; mrNumber?: string };
        };
      }>("/appointments/walk-in", {
        patientId,
        doctorId: selectedDoctor,
        priority,
        notes: notes || undefined,
      });

      setResult({
        tokenNumber: res.data.tokenNumber,
        doctorName: res.data.doctor.user.name,
        patientName: res.data.patient.user.name,
        // Issue #118: server may return mrNumber on the embedded patient.
        // Fall back to the locally selected patient (search result) when
        // not present so the success card never goes blank.
        mrNumber:
          res.data.patient.mrNumber ?? selectedPatient?.mrNumber ?? "",
      });

      // Reset form
      setSelectedPatient(null);
      setSearch("");
      setNotes("");
      setPriority("NORMAL");
      setShowNewPatient(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Walk-in registration failed");
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">Walk-in Registration</h1>

      {/* Success token display — Issue #118: patient name + MR number must
          be prominent. Previously the patient name rendered as a thin
          text-lg line that visually disappeared next to the giant token. */}
      {result && (
        <div
          className="mb-6 rounded-xl bg-green-50 border-2 border-green-200 p-8 text-center"
          data-testid="walkin-success"
        >
          <p className="text-sm text-green-600">Token Assigned</p>
          <p
            className="text-6xl font-bold text-green-700"
            data-testid="walkin-token"
          >
            {result.tokenNumber}
          </p>
          <p
            className="mt-3 text-2xl font-semibold text-gray-900 dark:text-gray-100"
            data-testid="walkin-patient-name"
          >
            {result.patientName}
          </p>
          {result.mrNumber && (
            <p
              className="mt-1 text-sm font-medium text-gray-700 dark:text-gray-300"
              data-testid="walkin-mr-number"
            >
              MR # {result.mrNumber}
            </p>
          )}
          <p className="mt-2 text-sm text-gray-500">Doctor: {result.doctorName}</p>
          <button
            onClick={() => setResult(null)}
            className="mt-4 rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white"
          >
            Register Next
          </button>
        </div>
      )}

      {!result && (
        <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
          {/* Step 1: Select Doctor */}
          <div className="mb-6">
            <label className="mb-2 block font-medium">1. Select Doctor</label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {doctors.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setSelectedDoctor(d.id)}
                  className={`rounded-lg border-2 p-3 text-left text-sm text-gray-900 transition dark:text-gray-100 ${
                    selectedDoctor === d.id
                      ? "border-primary bg-blue-50 dark:border-blue-400 dark:bg-blue-900/30"
                      : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-500"
                  }`}
                >
                  <p className="font-medium">{d.user.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{d.specialization}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: Find or register patient */}
          <div className="mb-6">
            <label className="mb-2 block font-medium">2. Patient</label>

            {selectedPatient ? (
              <div className="flex items-center justify-between rounded-lg bg-green-50 p-3 dark:bg-green-900/30">
                <div>
                  <p className="font-medium text-gray-900 dark:text-gray-100">{selectedPatient.user.name}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-300">
                    {selectedPatient.mrNumber} | {selectedPatient.user.phone}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedPatient(null)}
                  className="text-sm text-red-500 dark:text-red-400"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  placeholder="Search patient by name, phone, or MR number..."
                  value={search}
                  onChange={(e) => searchPatients(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                />
                {searchResults.length > 0 && (
                  <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700">
                    {searchResults.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setSelectedPatient(p);
                          setSearchResults([]);
                        }}
                        className="w-full border-b border-gray-200 px-3 py-2 text-left text-sm text-gray-900 last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700"
                      >
                        {p.user.name} — {p.mrNumber} — {p.user.phone}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => setShowNewPatient(true)}
                  className="mt-2 text-sm font-medium text-primary"
                >
                  + New Patient
                </button>

                {showNewPatient && (
                  <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <input
                          placeholder="Name"
                          value={newPatient.name}
                          onChange={(e) => {
                            // Issue #267 (2026-04-26): clear stale "Name is
                            // required" error the moment the user types.
                            setNewPatient({ ...newPatient, name: e.target.value });
                            if (fieldErrors.name)
                              setFieldErrors((p) => ({ ...p, name: undefined }));
                          }}
                          className={`w-full rounded border bg-white px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 ${
                            fieldErrors.name ? "border-red-500" : "border-gray-200 dark:border-gray-600"
                          }`}
                          data-testid="walkin-newpatient-name"
                        />
                        {fieldErrors.name && (
                          <p
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                            data-testid="error-name"
                          >
                            {fieldErrors.name}
                          </p>
                        )}
                      </div>
                      <div>
                        <input
                          placeholder="Phone"
                          value={newPatient.phone}
                          onChange={(e) => {
                            // Issue #267: same clear-on-edit behavior for phone.
                            setNewPatient({ ...newPatient, phone: e.target.value });
                            if (fieldErrors.phone)
                              setFieldErrors((p) => ({ ...p, phone: undefined }));
                          }}
                          className={`w-full rounded border bg-white px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 ${
                            fieldErrors.phone ? "border-red-500" : "border-gray-200 dark:border-gray-600"
                          }`}
                          data-testid="walkin-newpatient-phone"
                        />
                        {fieldErrors.phone && (
                          <p
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                            data-testid="error-phone"
                          >
                            {fieldErrors.phone}
                          </p>
                        )}
                      </div>
                      <select
                        value={newPatient.gender}
                        onChange={(e) =>
                          setNewPatient({
                            ...newPatient,
                            gender: e.target.value,
                          })
                        }
                        className="rounded border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                      >
                        <option value="MALE">Male</option>
                        <option value="FEMALE">Female</option>
                        <option value="OTHER">Other</option>
                      </select>
                      <div>
                        <input
                          placeholder="Age"
                          type="number"
                          value={newPatient.age}
                          onChange={(e) => {
                            setNewPatient({ ...newPatient, age: e.target.value });
                            if (fieldErrors.age)
                              setFieldErrors((p) => ({ ...p, age: undefined }));
                          }}
                          className={`w-full rounded border bg-white px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 ${
                            fieldErrors.age ? "border-red-500" : "border-gray-200 dark:border-gray-600"
                          }`}
                          data-testid="walkin-newpatient-age"
                        />
                        {fieldErrors.age && (
                          <p
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                            data-testid="error-age"
                          >
                            {fieldErrors.age}
                          </p>
                        )}
                      </div>
                      {/* Issue #206 (2026-04-30): DOB / Email / Address.
                          All optional but if filled must validate. */}
                      <div>
                        <input
                          aria-label="Date of birth"
                          placeholder="Date of Birth"
                          type="date"
                          max={new Date().toISOString().split("T")[0]}
                          value={newPatient.dateOfBirth}
                          onChange={(e) => {
                            setNewPatient({
                              ...newPatient,
                              dateOfBirth: e.target.value,
                            });
                            if (fieldErrors.dateOfBirth)
                              setFieldErrors((p) => ({
                                ...p,
                                dateOfBirth: undefined,
                              }));
                          }}
                          className={`w-full rounded border bg-white px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 ${
                            fieldErrors.dateOfBirth
                              ? "border-red-500"
                              : "border-gray-200 dark:border-gray-600"
                          }`}
                          data-testid="walkin-newpatient-dob"
                        />
                        {fieldErrors.dateOfBirth && (
                          <p
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                            data-testid="error-dob"
                          >
                            {fieldErrors.dateOfBirth}
                          </p>
                        )}
                      </div>
                      <div className="col-span-2">
                        <input
                          placeholder="Email (optional)"
                          type="email"
                          value={newPatient.email}
                          onChange={(e) => {
                            setNewPatient({ ...newPatient, email: e.target.value });
                            if (fieldErrors.email)
                              setFieldErrors((p) => ({ ...p, email: undefined }));
                          }}
                          className={`w-full rounded border bg-white px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 ${
                            fieldErrors.email
                              ? "border-red-500"
                              : "border-gray-200 dark:border-gray-600"
                          }`}
                          data-testid="walkin-newpatient-email"
                        />
                        {fieldErrors.email && (
                          <p
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                            data-testid="error-email"
                          >
                            {fieldErrors.email}
                          </p>
                        )}
                      </div>
                      <div className="col-span-2">
                        <textarea
                          placeholder="Address (optional)"
                          rows={2}
                          maxLength={500}
                          value={newPatient.address}
                          onChange={(e) => {
                            setNewPatient({
                              ...newPatient,
                              address: e.target.value,
                            });
                            if (fieldErrors.address)
                              setFieldErrors((p) => ({
                                ...p,
                                address: undefined,
                              }));
                          }}
                          className={`w-full rounded border bg-white px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 ${
                            fieldErrors.address
                              ? "border-red-500"
                              : "border-gray-200 dark:border-gray-600"
                          }`}
                          data-testid="walkin-newpatient-address"
                        />
                        {fieldErrors.address && (
                          <p
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                            data-testid="error-address"
                          >
                            {fieldErrors.address}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Step 3: Priority & Notes */}
          <div className="mb-6 grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="NORMAL">Normal</option>
                <option value="URGENT">Urgent</option>
                <option value="EMERGENCY">Emergency</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Notes</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
              />
            </div>
          </div>

          {/* Submit */}
          <button
            disabled={!selectedDoctor || (!selectedPatient && !showNewPatient)}
            onClick={() => {
              if (selectedPatient) {
                submitWalkIn(selectedPatient.id);
              } else if (showNewPatient) {
                registerAndWalkIn();
              }
            }}
            className="w-full rounded-lg bg-secondary py-3 font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Assign Token
          </button>
        </div>
      )}
    </div>
  );
}
