"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BadgeIndianRupee,
  Bell,
  CalendarCheck,
  CalendarDays,
  Copy,
  Check,
  Printer,
  Download,
  ClipboardList,
  CreditCard,
  FileText,
  FlaskConical,
  LogIn,
  MapPin,
  QrCode,
  Search,
  ShieldCheck,
  ShieldAlert,
  Stethoscope,
  Ticket,
  UserRoundPlus,
  X,
} from "lucide-react";
import { api, downloadFileEndpoint } from "@/lib/api";
import { formatDoctorName } from "@/lib/format-doctor-name";

type Mode = "TOKEN" | "SLOT" | "CALLING";

interface Doctor {
  id: string;
  specialization: string | null;
  qualification: string | null;
  experienceYears: number | null;
  appointmentMode: Mode;
  consultationFee: number | null;
  averageRating: number | null;
  user: { name: string };
}

interface KioskData {
  authenticated?: boolean;
  tenantId?: string | null;
  hospital?: { id: string; name: string; subdomain?: string | null } | null;
  guest?: { temporaryPatientId: string };
  departments: string[];
  doctors: Doctor[];
  patient?: {
    id: string;
    name: string;
    patientId: string;
    phone?: string | null;
    email?: string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
  };
  todaysAppointments?: Appointment[];
  upcomingAppointments?: Appointment[];
  prescriptions?: Array<{
    id: string;
    diagnosis: string;
    createdAt: string;
    // Doctor's signature — when set, the Rx is signed and downloadable.
    signatureUrl?: string | null;
    status?: string | null;
  }>;
  pendingBills?: Array<{
    id: string;
    invoiceNumber: string;
    subtotal?: number;
    taxAmount?: number;
    totalAmount: number;
    paymentStatus: string;
  }>;
  labReports?: Array<{ id: string; orderNumber: string; status: string; orderedAt: string }>;
  medicalHistory?: { prescriptions: number; labReports: number; pendingBills: number };
  referrals?: Array<{ id: string; referralNumber: string; specialty?: string | null; status: string }>;
  notifications?: Array<{ id: string; title: string; message: string }>;
}

interface Appointment {
  id: string;
  date: string;
  slotStart?: string | null;
  tokenNumber?: number | null;
  arrivalSeq?: number | null;
  status: string;
  doctor?: { specialization?: string | null; user?: { name?: string | null } | null } | null;
}

interface Slot {
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function modeLabel(mode: Mode): string {
  if (mode === "SLOT") return "Time slot";
  if (mode === "CALLING") return "Arrival queue";
  return "Token";
}

// Fetches + renders the scannable Appointment QR for a confirmed booking,
// plus Copy-link and Print actions.
function AppointmentQr({ appointmentId }: { appointmentId: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ ok: boolean; qrDataUrl: string; url: string }>(
        `/public/appointments/${appointmentId}/qr`,
        { skip401Redirect: true },
      )
      .then((r) => {
        if (!cancelled) {
          setQr(r.qrDataUrl ?? null);
          setUrl(r.url ?? null);
        }
      })
      .catch(() => {
        /* QR is a nice-to-have on the confirmation — ignore failures */
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentId]);

  async function copyLink() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  function printQr() {
    if (!qr) return;
    const w = window.open("", "_blank", "width=420,height=560");
    if (!w) return;
    w.document.write(
      `<!doctype html><html><head><title>Appointment QR</title>` +
        `<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px;margin:0}` +
        `img{width:260px;height:260px}p{color:#334155;font-size:13px;margin-top:12px}</style></head>` +
        `<body><img src="${qr}" alt="Appointment QR"/>` +
        `<p>Show this QR at the front desk</p>` +
        `<script>window.onload=function(){window.focus();window.print();}<\/script>` +
        `</body></html>`,
    );
    w.document.close();
  }

  if (!qr) return null;
  return (
    <div className="mt-3 flex flex-col items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={qr}
        alt="Appointment QR code"
        data-testid="appointment-qr"
        className="h-40 w-40 rounded-lg bg-white p-1"
      />
      <p className="mt-1 text-xs text-emerald-800">Show this QR at the front desk</p>
      <div className="mt-3 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={printQr}
          data-testid="appointment-qr-print"
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-50"
        >
          <Printer className="h-3.5 w-3.5" />
          Print
        </button>
        <button
          type="button"
          onClick={() => void copyLink()}
          disabled={!url}
          data-testid="appointment-qr-copy"
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy link
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "Today";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function HospitalQrPage() {
  const [data, setData] = useState<KioskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("All");
  const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
  const [date, setDate] = useState(todayYmd());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [booking, setBooking] = useState(false);
  const [bookingResult, setBookingResult] = useState<any>(null);
  // Set when the pre-submit check finds this patient already booked this
  // doctor on this date — the modal shows the existing appointment instead.
  const [duplicateAppointment, setDuplicateAppointment] = useState<any>(null);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    gender: "",
    dateOfBirth: "",
    symptom: "",
  });
  const [checkinLoading, setCheckinLoading] = useState<string | null>(null);
  const [checkinResult, setCheckinResult] = useState<any>(null);
  const [error, setError] = useState("");
  // Booking is a MODAL popup (not the side panel). Opens on a doctor click.
  const [bookingOpen, setBookingOpen] = useState(false);

  // Build the kiosk query string: the scanned hospital QR carries which
  // hospital this kiosk is for (?tenantId / ?code), and the department filter
  // is applied SERVER-SIDE (?department). A logged-in patient's own tenant
  // always wins server-side, so the hospital param only matters pre-login.
  function kioskQuery(dept: string, search: string): string {
    const params = new URLSearchParams();
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      const tenantId = sp.get("tenantId");
      const code = sp.get("code");
      if (tenantId) params.set("tenantId", tenantId);
      if (code) params.set("code", code);
    }
    if (dept && dept !== "All") params.set("department", dept);
    if (search.trim()) params.set("search", search.trim());
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  // `initial` gates the FULL-SCREEN loader. It's true ONLY on the first mount.
  // Search / department re-fetches pass initial=false so the page (and the
  // search input) stays mounted — flipping the page to the "Loading..." screen
  // on every keystroke unmounted the input and stole focus, which is why you
  // had to click back in between words.
  async function load(
    dept: string = department,
    search: string = query,
    initial = false,
  ) {
    if (initial) setLoading(true);
    setError("");
    try {
      const suffix = kioskQuery(dept, search);
      const me = await api.get<{ success: boolean; data: KioskData }>(
        `/hospital-kiosk/me${suffix}`,
        { skip401Redirect: true },
      );
      if (me.data.authenticated) setData(me.data);
      else {
        const session = await api.get<{ success: boolean; data: KioskData }>(
          `/hospital-kiosk/session${suffix}`,
          { skip401Redirect: true },
        );
        setData(session.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load kiosk");
    } finally {
      if (initial) setLoading(false);
    }
  }

  // Re-fetch from the API whenever the department filter changes (server-side
  // filter — not a frontend .filter()).
  function onDepartmentChange(dept: string) {
    setDepartment(dept);
    void load(dept, query);
  }

  useEffect(() => {
    void load("All", "", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced server-side doctor search (by name or department). Skips the
  // very first render (handled by the mount load above).
  const searchMounted = useRef(false);
  useEffect(() => {
    if (!searchMounted.current) {
      searchMounted.current = true;
      return;
    }
    const t = setTimeout(() => {
      void load(department, query);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    async function loadSlots() {
      if (!selectedDoctor || selectedDoctor.appointmentMode !== "SLOT") {
        setSlots([]);
        setSelectedSlot("");
        return;
      }
      const res = await api.get<{ success: boolean; data: { slots: Slot[] } }>(
        `/hospital-kiosk/doctors/${selectedDoctor.id}/slots?date=${encodeURIComponent(date)}`,
        { skip401Redirect: true },
      );
      setSlots(res.data.slots ?? []);
      setSelectedSlot("");
    }
    void loadSlots().catch(() => setSlots([]));
  }, [selectedDoctor, date]);

  const filteredDoctors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.doctors ?? []).filter((doctor) => {
      const deptOk = department === "All" || doctor.specialization === department;
      const text = `${doctor.user.name} ${doctor.specialization ?? ""} ${doctor.qualification ?? ""}`.toLowerCase();
      return deptOk && (!q || text.includes(q));
    });
  }, [data?.doctors, department, query]);

  async function submitBooking() {
    if (!selectedDoctor) return;
    setBooking(true);
    setError("");
    setDuplicateAppointment(null);
    try {
      // Pre-submit duplicate check: if this (name + phone) already has an open
      // appointment with THIS doctor on THIS date, show the existing booking
      // instead of creating a second one.
      const dupRes = await api.post<{
        success: boolean;
        data: { exists: boolean; appointment?: any };
      }>(
        "/public/booking/check-appointment",
        {
          name: form.name,
          phone: form.phone,
          doctorId: selectedDoctor.id,
          date,
          tenantId: data?.tenantId ?? undefined,
        },
        { skip401Redirect: true },
      );
      if (dupRes.data.exists && dupRes.data.appointment) {
        setDuplicateAppointment(dupRes.data.appointment);
        return; // stop — the modal now shows the existing appointment
      }

      const body = {
        ...form,
        gender: form.gender || "OTHER",
        doctorId: selectedDoctor.id,
        date,
        slotId: selectedDoctor.appointmentMode === "SLOT" ? selectedSlot : undefined,
        tenantId: data?.tenantId ?? undefined,
      };
      const res = await api.post<{ success: boolean; data: any }>("/public/booking/book", body, {
        skip401Redirect: true,
      });
      setBookingResult(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not book appointment");
    } finally {
      setBooking(false);
    }
  }

  async function checkIn(appointmentId: string) {
    setCheckinLoading(appointmentId);
    setError("");
    try {
      const res = await api.post<{ success: boolean; data: any }>(
        "/hospital-kiosk/check-in",
        { appointmentId },
      );
      setCheckinResult(res.data);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check in");
    } finally {
      setCheckinLoading(null);
    }
  }

  const todayAppointment = data?.todaysAppointments?.find((a) => a.status === "BOOKED");

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600">
        Loading hospital QR workflow...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-600 text-white">
              <QrCode className="h-6 w-6" />
            </span>
            <div>
              <p className="text-sm font-medium text-slate-500">Hospital QR entry</p>
              <h1 className="text-2xl font-semibold">{data?.hospital?.name ?? "MedCore Hospital"}</h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {!data?.authenticated ? (
              <>
                <Link className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium" href="/patient/login?next=/hospital/qr">
                  <LogIn className="h-4 w-4" /> Login
                </Link>
                <Link className="inline-flex h-11 items-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white" href="/patient/register">
                  <UserRoundPlus className="h-4 w-4" /> Register
                </Link>
              </>
            ) : (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800">
                {data.patient?.name} - {data.patient?.patientId}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[1.25fr_0.75fr]">
        <section className="space-y-5">
          {!data?.authenticated ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="text-sm font-semibold text-blue-900">Guest mode active</p>
              <p className="mt-1 text-sm text-blue-800">
                Temporary Patient ID: <span className="font-mono font-semibold">{data?.guest?.temporaryPatientId}</span>
              </p>
            </div>
          ) : null}

          {data?.authenticated ? (
            <PatientPanel
              data={data}
              todayAppointment={todayAppointment}
              onCheckIn={checkIn}
              checkinLoading={checkinLoading}
              checkinResult={checkinResult}
            />
          ) : null}

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <h2 className="text-lg font-semibold">Departments and doctors</h2>
              <label className="relative block lg:w-80">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search doctor or department"
                  className="h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </label>
            </div>
            {/* Department filter — a dropdown, driven by the API's `departments`
                list; changing it re-fetches doctors server-side (?department=). */}
            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Filter by department
              </label>
              <select
                data-testid="kiosk-department-filter"
                value={department}
                onChange={(e) => onDepartmentChange(e.target.value)}
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:w-72"
              >
                <option value="All">All departments</option>
                {(data?.departments ?? []).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {filteredDoctors.map((doctor) => (
                <button
                  key={doctor.id}
                  type="button"
                  onClick={() => {
                    setSelectedDoctor(doctor);
                    setBookingResult(null);
                    setDuplicateAppointment(null);
                    setError("");
                    setSelectedSlot("");
                    // Logged-in patient → auto-fill their known details from
                    // /me so they don't re-type them (locked in the form);
                    // only Reason-for-visit is left blank/editable.
                    if (data?.authenticated && data.patient) {
                      setForm({
                        name: data.patient.name ?? "",
                        phone: data.patient.phone ?? "",
                        email: data.patient.email ?? "",
                        gender: data.patient.gender ?? "",
                        dateOfBirth: data.patient.dateOfBirth ?? "",
                        symptom: "",
                      });
                    }
                    setBookingOpen(true);
                  }}
                  className="rounded-lg border border-slate-200 bg-white p-4 text-left transition hover:border-blue-400 hover:bg-blue-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{formatDoctorName(doctor.user.name)}</p>
                      <p className="mt-1 text-sm text-slate-600">{doctor.specialization ?? "General"}</p>
                      <p className="mt-1 text-xs text-slate-500">{doctor.qualification ?? "Consultant"}</p>
                    </div>
                    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium">{modeLabel(doctor.appointmentMode)}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1"><Stethoscope className="h-3.5 w-3.5" /> {doctor.experienceYears ?? 0}+ yrs</span>
                    {doctor.consultationFee != null ? (
                      <span className="inline-flex items-center gap-1"><BadgeIndianRupee className="h-3.5 w-3.5" /> Rs. {doctor.consultationFee}</span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="space-y-5">
          <GuestRules />
        </aside>
      </div>

      {/* Booking popup — opens on a doctor click. Shows the appointment form,
          then (after Confirm) the appointment QR + details together. Every
          view has a Back button. */}
      {bookingOpen && selectedDoctor && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="kiosk-booking-modal"
          // Top-aligned + scrollable so a tall form (many time slots + all
          // fields) never overflows ABOVE the viewport — centering a
          // taller-than-screen modal pushed its header/Back button off the top.
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
          onClick={() => {
            if (!booking) setBookingOpen(false);
          }}
        >
          <div
            className="my-4 max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <BookingPanel
              doctor={selectedDoctor}
              date={date}
              setDate={setDate}
              slots={slots}
              selectedSlot={selectedSlot}
              setSelectedSlot={setSelectedSlot}
              form={form}
              setForm={setForm}
              lockedIdentity={!!(data?.authenticated && data.patient)}
              onSubmit={submitBooking}
              booking={booking}
              bookingResult={bookingResult}
              duplicateAppointment={duplicateAppointment}
              error={error}
              onBack={() => {
                if (booking) return;
                // If we're showing the "already booked" notice, Back returns
                // to the form (lets them change the doctor/date), not close.
                if (duplicateAppointment) {
                  setDuplicateAppointment(null);
                  return;
                }
                setBookingOpen(false);
                setBookingResult(null);
              }}
            />
          </div>
        </div>
      )}
    </main>
  );
}

type DetailKind =
  | "prescriptions"
  | "labReports"
  | "pendingBills"
  | "notifications"
  | "appointment";

function PatientPanel({
  data,
  todayAppointment,
  onCheckIn,
  checkinLoading,
  checkinResult,
}: {
  data: KioskData;
  todayAppointment?: Appointment;
  onCheckIn: (id: string) => void;
  checkinLoading: string | null;
  checkinResult: any;
}) {
  // Which detail popup is open (null = none). For an appointment we also stash
  // the clicked appointment so the modal can show its specifics.
  const [detail, setDetail] = useState<DetailKind | null>(null);
  const [detailAppt, setDetailAppt] = useState<Appointment | null>(null);

  const cards: Array<{ label: string; value: number; icon: any; kind: DetailKind }> = [
    { label: "Prescriptions", value: data.medicalHistory?.prescriptions ?? 0, icon: FileText, kind: "prescriptions" },
    { label: "Lab reports", value: data.medicalHistory?.labReports ?? 0, icon: FlaskConical, kind: "labReports" },
    { label: "Pending bills", value: data.medicalHistory?.pendingBills ?? 0, icon: CreditCard, kind: "pendingBills" },
    { label: "Notifications", value: data.notifications?.length ?? 0, icon: Bell, kind: "notifications" },
  ];

  function openAppt(appt: Appointment) {
    setDetailAppt(appt);
    setDetail("appointment");
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm text-slate-500">Patient dashboard</p>
          <h2 className="text-xl font-semibold">{data.patient?.name}</h2>
          <p className="text-sm text-slate-600">{data.patient?.patientId}</p>
        </div>
        {todayAppointment ? (
          <button
            type="button"
            onClick={() => onCheckIn(todayAppointment.id)}
            disabled={checkinLoading === todayAppointment.id}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-emerald-700 px-5 text-sm font-semibold text-white disabled:opacity-60"
          >
            <MapPin className="h-4 w-4" />
            {checkinLoading === todayAppointment.id ? "Checking in..." : "I'm Arrived"}
          </button>
        ) : null}
      </div>
      {checkinResult ? (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Checked in successfully</p>
          <p className="mt-1">
            {checkinResult.department ?? "OPD"} - Room {checkinResult.roomNumber ?? "OPD"} -
            Token {checkinResult.tokenNumber ?? checkinResult.arrivalSeq ?? "-"} -
            Est. wait {checkinResult.estimatedWaitMinutes ?? 15} min
          </p>
        </div>
      ) : null}
      {/* Clickable stat cards — each opens its detail popup. */}
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map(({ label, value, icon: Icon, kind }) => (
          <button
            key={label}
            type="button"
            onClick={() => setDetail(kind)}
            data-testid={`kiosk-stat-${kind}`}
            className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-blue-400 hover:bg-blue-50"
          >
            <Icon className="h-5 w-5 text-blue-600" />
            <p className="mt-2 text-2xl font-semibold">{value}</p>
            <p className="text-xs text-slate-500">{label}</p>
          </button>
        ))}
      </div>
      {/* Clickable appointment cards — each opens its booking details. */}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {(data.upcomingAppointments ?? []).slice(0, 4).map((appt) => (
          <button
            key={appt.id}
            type="button"
            onClick={() => openAppt(appt)}
            data-testid="kiosk-appt-card"
            className="rounded-lg border border-slate-200 p-3 text-left text-sm transition hover:border-blue-400 hover:bg-blue-50"
          >
            <p className="font-medium">{formatDoctorName(appt.doctor?.user?.name ?? "Doctor")}</p>
            <p className="text-slate-600">
              {formatDate(appt.date)} {appt.slotStart ? `- ${appt.slotStart}` : ""}
              {" · "}
              {String(appt.status).replace(/_/g, " ")}
            </p>
          </button>
        ))}
      </div>

      {detail ? (
        <DetailModal
          kind={detail}
          data={data}
          appt={detailAppt}
          onClose={() => {
            setDetail(null);
            setDetailAppt(null);
          }}
        />
      ) : null}
    </div>
  );
}

// Popup showing the details for a clicked stat card or appointment card.
function DetailModal({
  kind,
  data,
  appt,
  onClose,
}: {
  kind: DetailKind;
  data: KioskData;
  appt: Appointment | null;
  onClose: () => void;
}) {
  const titles: Record<DetailKind, string> = {
    prescriptions: "Prescriptions",
    labReports: "Lab reports",
    pendingBills: "Pending bills",
    notifications: "Notifications",
    appointment: "Appointment details",
  };

  function Empty({ label }: { label: string }) {
    return <p className="py-6 text-center text-sm text-slate-500">No {label} yet.</p>;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="kiosk-detail-modal"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="my-4 max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{titles[kind]}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-2 overflow-y-auto">
          {kind === "prescriptions" &&
            ((data.prescriptions ?? []).length ? (
              (data.prescriptions ?? []).map((rx) => {
                // The doctor's signature is the "signed" signal — only a signed
                // prescription can be downloaded as a PDF.
                const signed = !!rx.signatureUrl;
                return (
                  <div key={rx.id} className="rounded-md border border-slate-200 p-3 text-sm">
                    <p className="font-medium text-slate-900">{rx.diagnosis || "Prescription"}</p>
                    <p className="text-xs text-slate-500">{formatDate(rx.createdAt)}</p>
                    {signed ? (
                      <button
                        type="button"
                        data-testid="kiosk-rx-download"
                        onClick={() =>
                          void downloadFileEndpoint(
                            `/prescriptions/${rx.id}/pdf?format=pdf&download=1`,
                            `prescription-${rx.id}.pdf`,
                          )
                        }
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download PDF
                      </button>
                    ) : (
                      <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                        Awaiting doctor&apos;s signature
                      </p>
                    )}
                  </div>
                );
              })
            ) : (
              <Empty label="prescriptions" />
            ))}

          {kind === "labReports" &&
            ((data.labReports ?? []).length ? (
              (data.labReports ?? []).map((lab) => (
                <div key={lab.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="font-medium text-slate-900">{lab.orderNumber}</p>
                  <p className="text-xs text-slate-500">
                    {String(lab.status).replace(/_/g, " ")} · {formatDate(lab.orderedAt)}
                  </p>
                </div>
              ))
            ) : (
              <Empty label="lab reports" />
            ))}

          {kind === "pendingBills" &&
            ((data.pendingBills ?? []).length ? (
              (data.pendingBills ?? []).map((bill) => <BillRow key={bill.id} bill={bill} />)
            ) : (
              <Empty label="pending bills" />
            ))}

          {kind === "notifications" &&
            ((data.notifications ?? []).length ? (
              (data.notifications ?? []).map((n) => (
                <div key={n.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="font-medium text-slate-900">{n.title}</p>
                  <p className="text-xs text-slate-600">{n.message}</p>
                </div>
              ))
            ) : (
              <Empty label="notifications" />
            ))}

          {kind === "appointment" && appt ? (
            <dl className="space-y-2">
              <DetailRow label="Doctor" value={formatDoctorName(appt.doctor?.user?.name ?? "Doctor")} />
              {appt.doctor?.specialization ? (
                <DetailRow label="Department" value={appt.doctor.specialization} />
              ) : null}
              <DetailRow
                label="Date"
                value={appt.slotStart ? `${formatDate(appt.date)} · ${appt.slotStart}` : formatDate(appt.date)}
              />
              {appt.tokenNumber != null ? (
                <DetailRow label="Token" value={String(appt.tokenNumber)} />
              ) : null}
              {appt.arrivalSeq != null ? (
                <DetailRow label="Arrival #" value={String(appt.arrivalSeq)} />
              ) : null}
              <DetailRow label="Status" value={String(appt.status).replace(/_/g, " ")} />
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}

// One pending-bill row: shows the excluding-GST amount up front, and on click
// expands the full breakdown (subtotal / GST / total) + a Download PDF action.
function BillRow({
  bill,
}: {
  bill: {
    id: string;
    invoiceNumber: string;
    subtotal?: number;
    taxAmount?: number;
    totalAmount: number;
    paymentStatus: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const exclGst = bill.subtotal ?? bill.totalAmount;
  return (
    <div className="rounded-md border border-slate-200 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="kiosk-bill-row"
        className="flex w-full items-center justify-between gap-3 p-3 text-left transition hover:bg-slate-50"
      >
        <div>
          <p className="font-medium text-slate-900">{bill.invoiceNumber}</p>
          <p className="text-xs text-slate-500">
            {String(bill.paymentStatus).replace(/_/g, " ")}
          </p>
        </div>
        <div className="text-right">
          {/* Amount excluding GST shown up front. */}
          <p className="font-semibold text-slate-900">Rs. {exclGst}</p>
          <p className="text-xs text-slate-500">excl. GST</p>
        </div>
      </button>

      {open ? (
        <div className="space-y-2 border-t border-slate-100 p-3">
          <DetailRow label="Amount (excl. GST)" value={`Rs. ${exclGst}`} />
          {bill.taxAmount != null ? (
            <DetailRow label="GST" value={`Rs. ${bill.taxAmount}`} />
          ) : null}
          <DetailRow label="Total payable" value={`Rs. ${bill.totalAmount}`} />
          <DetailRow label="Status" value={String(bill.paymentStatus).replace(/_/g, " ")} />
          <button
            type="button"
            data-testid="kiosk-bill-download"
            onClick={() =>
              void downloadFileEndpoint(
                `/billing/invoices/${bill.id}/pdf?format=pdf`,
                `invoice-${bill.invoiceNumber}.pdf`,
              )
            }
            className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
          >
            <Download className="h-3.5 w-3.5" />
            Download PDF
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Field label with a red asterisk for mandatory fields (optional=false → *).
function FieldLabel({ text, required = false }: { text: string; required?: boolean }) {
  return (
    <label className="mb-1 block text-xs font-medium text-slate-600">
      {text}
      {required ? <span className="ml-0.5 text-red-500">*</span> : (
        <span className="ml-1 font-normal text-slate-400">(optional)</span>
      )}
    </label>
  );
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-emerald-100 pb-1">
      <dt className="text-emerald-700">{label}</dt>
      <dd className="font-medium text-emerald-900">{value}</dd>
    </div>
  );
}

function BookingPanel(props: {
  doctor: Doctor | null;
  date: string;
  setDate: (v: string) => void;
  slots: Slot[];
  selectedSlot: string;
  setSelectedSlot: (v: string) => void;
  form: any;
  setForm: (v: any) => void;
  // When true (logged-in patient), identity fields are prefilled + read-only;
  // only Reason-for-visit stays editable.
  lockedIdentity?: boolean;
  onSubmit: () => void;
  booking: boolean;
  bookingResult: any;
  duplicateAppointment?: any;
  error: string;
  onBack?: () => void;
}) {
  const { doctor, form, setForm } = props;
  const locked = !!props.lockedIdentity;
  const canBook =
    doctor &&
    form.name &&
    form.phone &&
    form.gender &&
    form.dateOfBirth &&
    form.symptom &&
    form.symptom.trim() &&
    (doctor.appointmentMode !== "SLOT" || props.selectedSlot);
  const isConfirmed = !!props.bookingResult;
  const dup = props.duplicateAppointment;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
      <div className="flex items-center justify-between">
        {props.onBack ? (
          <button
            type="button"
            data-testid="kiosk-booking-back"
            onClick={props.onBack}
            disabled={props.booking}
            className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        ) : (
          <span />
        )}
        <h2 className="text-lg font-semibold">
          {dup ? "Already booked" : isConfirmed ? "Confirmed" : "Book appointment"}
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={props.onBack}
          disabled={props.booking}
          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      {!doctor ? (
        <p className="mt-3 text-sm text-slate-600">Select a doctor to start booking.</p>
      ) : dup ? (
        // Duplicate found — this patient already has an appointment with this
        // doctor on this date. Show the existing booking, no Confirm button.
        <div
          data-testid="kiosk-duplicate-notice"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-center text-sm text-amber-900"
        >
          <p className="text-base font-semibold">
            You already have an appointment with this doctor
          </p>
          <p className="mt-1 text-xs text-amber-700">
            on {formatDate(dup.date)}. Here are the details.
          </p>
          <dl className="mx-auto mt-3 max-w-xs space-y-1 text-left">
            <ConfirmRow label="Doctor" value={dup.doctorName} />
            <ConfirmRow label="Department" value={dup.department ?? "General"} />
            <ConfirmRow label="Date" value={formatDate(dup.date)} />
            {dup.slotStart && <ConfirmRow label="Time" value={dup.slotStart} />}
            <ConfirmRow
              label="Token"
              value={String(dup.displayToken ?? dup.arrivalSeq ?? "-")}
            />
            <ConfirmRow label="Status" value={String(dup.status).replace(/_/g, " ")} />
          </dl>
          <button
            type="button"
            data-testid="kiosk-duplicate-back"
            onClick={props.onBack}
            className="mt-4 inline-flex h-11 w-full items-center justify-center gap-1 rounded-md border border-amber-300 bg-white px-4 text-sm font-semibold text-amber-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>
      ) : props.bookingResult ? (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center text-sm text-emerald-900">
          <ShieldCheck className="mx-auto h-8 w-8" />
          <p className="mt-2 text-base font-semibold">Appointment confirmed</p>
          {/* Appointment QR + details together. */}
          <AppointmentQr appointmentId={props.bookingResult.appointmentId} />
          <dl className="mx-auto mt-3 max-w-xs space-y-1 text-left">
            <ConfirmRow label="Doctor" value={props.bookingResult.doctorName} />
            <ConfirmRow label="Department" value={doctor.specialization ?? "General"} />
            <ConfirmRow label="Date" value={formatDate(props.bookingResult.date)} />
            <ConfirmRow
              label="Token"
              value={String(
                props.bookingResult.displayToken ??
                  props.bookingResult.arrivalSeq ??
                  "-",
              )}
            />
          </dl>
          <button
            type="button"
            onClick={props.onBack}
            className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white"
          >
            Done
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="rounded-md bg-slate-50 p-3 text-sm">
            <p className="font-medium">{formatDoctorName(doctor.user.name)}</p>
            <p className="text-slate-600">{doctor.specialization ?? "General"} - {modeLabel(doctor.appointmentMode)}</p>
          </div>
          <p className="text-xs text-slate-500">
            Fields marked <span className="font-semibold text-red-500">*</span> are required.
          </p>
          <div>
            <FieldLabel text="Appointment date" required />
            <div className="relative">
              <input type="date" min={todayYmd()} value={props.date} onChange={(e) => props.setDate(e.target.value)} className="date-input h-11 w-full rounded-md border border-slate-300 bg-white pl-3 pr-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            </div>
          </div>
          {doctor.appointmentMode === "SLOT" ? (
            <div>
              <FieldLabel text="Time slot" required />
              {(() => {
                const open = props.slots.filter((s) => s.isAvailable);
                if (open.length === 0) {
                  return (
                    <p
                      className="rounded-md p-3 text-center text-sm font-medium"
                      style={{ color: "#92400e", backgroundColor: "#fef3c7", border: "1px solid #fcd34d" }}
                    >
                      No time slots left for this date. Please pick another day.
                    </p>
                  );
                }
                return (
                  <div className="grid grid-cols-3 gap-2">
                    {open.slice(0, 18).map((slot) => (
                      <button
                        key={slot.startTime}
                        type="button"
                        onClick={() => props.setSelectedSlot(slot.startTime)}
                        className={`h-10 rounded-md border text-xs font-medium ${props.selectedSlot === slot.startTime ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-900 hover:border-blue-400"}`}
                      >
                        {slot.startTime}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          ) : null}
          {locked ? (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
              Booking with your saved profile — only the reason for visit is
              needed.
            </p>
          ) : null}
          <div>
            <FieldLabel text="Full name" required />
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" readOnly={locked} disabled={locked} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500" />
          </div>
          <div>
            <FieldLabel text="Mobile number" required />
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="10-digit mobile number" inputMode="numeric" readOnly={locked} disabled={locked} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500" />
          </div>
          <div>
            <FieldLabel text="Email" />
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" readOnly={locked} disabled={locked} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500" />
          </div>
          <div>
            <FieldLabel text="Gender" required />
            <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} disabled={locked} className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500">
              <option value="">Select gender</option>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div>
            <FieldLabel text="Date of birth" required />
            {/* Full-width row so the browser's native date-picker popup anchors
                under the field with room, instead of overflowing the modal's
                right edge (it did when the input was in a narrow 2-col cell). */}
            <div className="relative">
              <input type="date" max={todayYmd()} value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} readOnly={locked} disabled={locked} className="date-input h-11 w-full rounded-md border border-slate-300 bg-white pl-3 pr-10 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500" />
              <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            </div>
          </div>
          <div>
            <FieldLabel text="Reason for visit" required />
            <textarea value={form.symptom} onChange={(e) => setForm({ ...form, symptom: e.target.value })} placeholder="Describe your symptoms or reason for visit" className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          {props.error ? (
            <p
              role="alert"
              data-testid="kiosk-booking-error"
              className="flex items-start gap-2 rounded-md p-3 text-sm font-semibold"
              // Inline colours so the alert is always high-contrast regardless of
              // Tailwind's dev JIT state: dark-red text on a light-red field.
              style={{ color: "#991b1b", backgroundColor: "#fee2e2", border: "1px solid #f87171" }}
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#dc2626" }} />
              <span>{props.error}</span>
            </p>
          ) : null}
          <button type="button" disabled={!canBook || props.booking} onClick={props.onSubmit} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-60">
            <CalendarCheck className="h-4 w-4" />
            {props.booking ? "Booking..." : "Confirm appointment"}
          </button>
        </div>
      )}
    </div>
  );
}

function GuestRules() {
  const allowed = ["View doctors", "View departments", "Hospital information", "Check services", "Book after registration"];
  const privateItems = ["Prescriptions", "Reports", "Bills", "Medical history", "Check-in"];
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">Access rules</h2>
      <div className="mt-3 grid gap-3 text-sm">
        <div>
          <p className="font-medium text-emerald-800">Guest can</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {allowed.map((item) => <span key={item} className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-800">{item}</span>)}
          </div>
        </div>
        <div>
          <p className="font-medium text-slate-700">Login required</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {privateItems.map((item) => <span key={item} className="rounded-md bg-slate-100 px-2 py-1 text-slate-700">{item}</span>)}
          </div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs text-slate-600">
        <span className="rounded-md bg-slate-50 p-2"><Ticket className="mx-auto mb-1 h-4 w-4" />Queue</span>
        <span className="rounded-md bg-slate-50 p-2"><ClipboardList className="mx-auto mb-1 h-4 w-4" />Records</span>
        <span className="rounded-md bg-slate-50 p-2"><FlaskConical className="mx-auto mb-1 h-4 w-4" />Reports</span>
      </div>
    </div>
  );
}
