"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { getSocket } from "@/lib/socket";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { SkeletonCard } from "@/components/Skeleton";
import { BellRing, BellOff } from "lucide-react";

// Issue #383 (CRITICAL prod RBAC bypass, Apr 29 2026): Live Queue exposes
// every patient currently waiting/in-consultation across the clinic — names,
// tokens, statuses. Staff-only.
const QUEUE_ALLOWED = new Set([
  "ADMIN",
  "RECEPTION",
  "DOCTOR",
  "NURSE",
]);

interface QueueDoctor {
  doctorId: string;
  doctorName: string;
  specialization: string;
  currentToken: number | null;
  waitingCount: number;
  // Pearl ERP §2.1.2 — OPD-screen header branches by the doctor's
  // configured mode. API already returns this on every queue entry
  // (queue.ts:308); the UI just hadn't consumed it. Optional + default
  // TOKEN for back-compat with older API responses.
  appointmentMode?: "CALLING" | "TOKEN" | "SLOT";
}

interface QueueEntry {
  // null for CALLING-mode (arrival-order queue) bookings — no token is minted.
  tokenNumber: number | null;
  patientName: string;
  // Patient's profile photo (User.photoUrl). When present the queue row shows
  // the image; otherwise it falls back to initials, mirroring Next Patient.
  patientPhotoUrl?: string | null;
  // 2026-05-25 — surfaced so the Next Patient row can deep-link into
  // the full patient detail page. The API already returns this field
  // (queue.ts:166); the interface just hadn't claimed it yet.
  patientId: string;
  appointmentId: string;
  type: string;
  status: string;
  priority: string;
  slotTime: string | null;
  hasVitals: boolean;
  estimatedWaitMinutes: number;
  // ACTUAL minutes waited since check-in (from checkInAt); null until the
  // patient checks in. Surfaced as the "X min wait" chip for CALLING/TOKEN.
  waitedMinutes?: number | null;
  // CALLING-mode: ISO timestamp set when the doctor is actively calling this
  // patient (the state between check-in and consult). Null otherwise.
  calledAt?: string | null;
  vulnerableFlags?: {
    isSenior: boolean;
    isChild: boolean;
    isPregnant: boolean;
    ageYears: number | null;
  };
}

interface DoctorQueue {
  doctorId: string;
  date: string;
  currentToken: number | null;
  totalInQueue: number;
  queue: QueueEntry[];
}

export default function QueuePage() {
  const user = useAuthStore((s) => s.user);
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Tracks whether we've already auto-opened the drawer from the URL's
  // `?previewDoctor=<id>` param. One-shot: if the user manually closes
  // the drawer after a restore, we don't re-open it on the next
  // searchParams/display re-render.
  const drawerRestoredRef = useRef(false);
  const { t } = useTranslation();

  // Issue #383: redirect PATIENT (and any other non-staff) away.
  useEffect(() => {
    if (!isAuthLoading && user && !QUEUE_ALLOWED.has(user.role)) {
      // Issue #179: redirect to chrome-wrapped /dashboard/not-authorized so
      // non-staff users see "Access Denied" with the dashboard layout intact.
      toast.error("Live queue is staff-only.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/queue")}`,
      );
    }
  }, [isAuthLoading, user, router, pathname]);
  const [display, setDisplay] = useState<QueueDoctor[]>([]);
  // Pearl §2.1.2 — doctor view splits queue data into two slots:
  //   myDoctorQueue:    pinned to the doctor's own queue, shown in the
  //                     top-split right panel; never overwritten when
  //                     the doctor peeks at another doctor's queue.
  //   otherDoctor*:     the doctor currently being previewed in the
  //                     right-side drawer (clicking an "OTHER DOCTORS"
  //                     card opens the drawer instead of replacing the
  //                     top-split, so the doctor never loses sight of
  //                     their own patients).
  const [myDoctorQueue, setMyDoctorQueue] = useState<DoctorQueue | null>(null);
  const [otherDoctorPreview, setOtherDoctorPreview] = useState<{
    doctor: QueueDoctor;
    queue: DoctorQueue | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  // Pearl §2.1.2 — doctors land on their own card first. Match the
  // logged-in user's display name against the queue's `doctorName` (the
  // user.name field on the Doctor's User row) to find their entry.
  // Non-doctors (ADMIN / RECEPTION / NURSE) get `myDoctor = null` and
  // fall through to the legacy flat-grid layout.
  const isDoctor = user?.role === "DOCTOR";
  const myDoctor = useMemo(
    () =>
      isDoctor && user?.name
        ? display.find((d) => d.doctorName === user.name) ?? null
        : null,
    [isDoctor, user?.name, display],
  );
  const otherDoctors = useMemo(() => {
    const list = myDoctor
      ? display.filter((d) => d.doctorId !== myDoctor.doctorId)
      : display;
    // Surface doctors who actually have patients first: sort by waiting count
    // (highest first); a doctor actively consulting (currentToken set) counts
    // as busy too, so they rank above idle (0-waiting) doctors.
    const activity = (d: QueueDoctor) =>
      (Number(d.waitingCount) || 0) + (d.currentToken != null ? 1 : 0);
    return [...list].sort((a, b) => activity(b) - activity(a));
  }, [display, myDoctor]);

  // Refs mirror `myDoctor` / `otherDoctorPreview` so the live-refresh
  // socket+poll effect can read the LATEST values without listing them
  // in its dependency array. Listing them would re-register the socket
  // on every state change, AND because the effect itself calls
  // `loadDisplay()` which mutates `display` → `myDoctor` (useMemo) →
  // new ref → re-run, you get an unbounded loop of /queue fetches (the
  // bug surfaced 2026-05-25 in the network tab). Refs keep the effect's
  // deps stable while the callbacks still see fresh data.
  const myDoctorRef = useRef(myDoctor);
  const otherDoctorPreviewRef = useRef(otherDoctorPreview);
  useEffect(() => {
    myDoctorRef.current = myDoctor;
  }, [myDoctor]);
  useEffect(() => {
    otherDoctorPreviewRef.current = otherDoctorPreview;
  }, [otherDoctorPreview]);

  // Auto-load my own queue detail on first identification (and re-load
  // if my doctorId flips, e.g. on profile re-bind). Populates
  // `myDoctorQueue` so the top-split right panel never empties when
  // the doctor peeks at another doctor's queue via the drawer.
  useEffect(() => {
    if (!myDoctor) return;
    void loadMyQueue(myDoctor.doctorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myDoctor?.doctorId]);

  async function loadMyQueue(doctorId: string) {
    try {
      const today = new Date().toISOString().split("T")[0];
      const res = await api.get<{ data: DoctorQueue }>(
        `/queue/${doctorId}?date=${today}`,
      );
      setMyDoctorQueue(res.data);
      // If the drawer happens to be previewing the SAME doctor (a
      // doctor peeking at their own card), mirror the response into
      // the drawer state too — saves an identical second HTTP call
      // from runRefresh's drawer-fetch branch.
      setOtherDoctorPreview((prev) =>
        prev && prev.doctor.doctorId === doctorId
          ? { doctor: prev.doctor, queue: res.data }
          : prev,
      );
    } catch {
      // empty
    }
  }

  // CALLING-mode: mark a checked-in patient as "being called" (the state
  // before the consult starts). The doctor can call any patient, in any order.
  // On success refresh the clinic display + the previewed/own queues so the
  // new "calling" highlight + Next Patient surface immediately.
  async function callPatient(appointmentId: string, doctorId: string) {
    try {
      await api.post(`/appointments/${appointmentId}/call`, {});
      loadDisplay();
      const preview = otherDoctorPreviewRef.current;
      if (preview && preview.doctor.doctorId === doctorId) {
        void openOtherDoctorPreview(preview.doctor);
      }
      const mine = myDoctorRef.current;
      if (mine && mine.doctorId === doctorId) void loadMyQueue(doctorId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to call patient",
      );
    }
  }

  // CALLING-mode: cancel an in-progress call — the patient drops back to plain
  // CHECKED_IN (still waiting). Reverse of callPatient.
  async function uncallPatient(appointmentId: string, doctorId: string) {
    try {
      await api.post(`/appointments/${appointmentId}/uncall`, {});
      loadDisplay();
      const preview = otherDoctorPreviewRef.current;
      if (preview && preview.doctor.doctorId === doctorId) {
        void openOtherDoctorPreview(preview.doctor);
      }
      const mine = myDoctorRef.current;
      if (mine && mine.doctorId === doctorId) void loadMyQueue(doctorId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to cancel call",
      );
    }
  }

  // Restore the right-side drawer when arriving from a patient detail
  // page that was opened from this queue (the "Back to Queue" link
  // preserves `?previewDoctor=<id>`). One-shot — guarded by
  // drawerRestoredRef so manually closing the drawer doesn't trigger
  // a re-open on the next render. Waits for `display` so we can find
  // the doctor row to hand to openOtherDoctorPreview.
  useEffect(() => {
    if (drawerRestoredRef.current) return;
    const previewDoctorId = searchParams?.get("previewDoctor");
    if (!previewDoctorId) return;
    if (display.length === 0) return;
    const doc = display.find((d) => d.doctorId === previewDoctorId);
    if (!doc) return;
    drawerRestoredRef.current = true;
    void openOtherDoctorPreview(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, searchParams]);

  async function openOtherDoctorPreview(doc: QueueDoctor) {
    // Doctor previewing their OWN card — reuse the already-loaded
    // myDoctorQueue instead of re-fetching the identical resource.
    if (doc.doctorId === myDoctor?.doctorId && myDoctorQueue) {
      setOtherDoctorPreview({ doctor: doc, queue: myDoctorQueue });
      return;
    }
    // Stamp the drawer open immediately with header info so it doesn't
    // pop up blank during the fetch — then fill in the queue when the
    // response lands.
    setOtherDoctorPreview({ doctor: doc, queue: null });
    try {
      const today = new Date().toISOString().split("T")[0];
      const res = await api.get<{ data: DoctorQueue }>(
        `/queue/${doc.doctorId}?date=${today}`,
      );
      setOtherDoctorPreview((prev) =>
        prev && prev.doctor.doctorId === doc.doctorId
          ? { doctor: doc, queue: res.data }
          : prev,
      );
    } catch {
      // empty — drawer stays open with the "loading…" / no-data state
    }
  }

  function closeOtherDoctorPreview() {
    setOtherDoctorPreview(null);
  }

  useEffect(() => {
    // Issue #383 follow-up: gate socket connect + display fetch on
    // QUEUE_ALLOWED so non-staff (PATIENT) doesn't open a live queue
    // WebSocket on a brief mount-flicker before the role-redirect
    // useEffect above fires. e2e/realtime.spec.ts pins this contract:
    // PATIENT visiting /dashboard/queue must NOT establish a queue WS.
    if (isAuthLoading) return;
    if (user && !QUEUE_ALLOWED.has(user.role)) return;

    loadDisplay();

    const socket = getSocket();
    socket.connect();
    socket.emit("join-display");

    // Live refresh handler — fans out to all three queue slots so the
    // top-split, drawer preview, and legacy detail panel all stay
    // current on any token-called / queue-updated event.
    //
    // Coalesced with a 150ms trailing debounce: the server emits
    // `token-called` AND `queue-updated` back-to-back for the same
    // mutation, and burst broadcasts (e.g. multiple appointments
    // status-changed in one transaction) used to fire one fan-out per
    // event → 3+ duplicate /queue requests in the network tab.
    // Debounce collapses them into one refresh per burst.
    let refreshDebounce: ReturnType<typeof setTimeout> | null = null;
    const runRefresh = () => {
      loadDisplay();
      const currentMyDoctor = myDoctorRef.current;
      const currentPreview = otherDoctorPreviewRef.current;
      if (currentMyDoctor) void loadMyQueue(currentMyDoctor.doctorId);
      // Skip the drawer fetch when the drawer is previewing my own
      // doctor — `loadMyQueue` above already mirrors its response
      // into the drawer state. Without this guard we fired the same
      // /queue/<myDoctorId> URL twice per refresh.
      if (
        currentPreview &&
        currentPreview.doctor.doctorId !== currentMyDoctor?.doctorId
      ) {
        // Re-fetch the drawer doctor's queue inline (not via
        // openOtherDoctorPreview — that resets to "loading…" state
        // which would flicker on every event).
        const today = new Date().toISOString().split("T")[0];
        const previewDoctorId = currentPreview.doctor.doctorId;
        void api
          .get<{ data: DoctorQueue }>(
            `/queue/${previewDoctorId}?date=${today}`,
          )
          .then((res) =>
            setOtherDoctorPreview((prev) =>
              prev && prev.doctor.doctorId === previewDoctorId
                ? { doctor: prev.doctor, queue: res.data }
                : prev,
            ),
          )
          .catch(() => {
            /* keep stale data on transient errors */
          });
      }
    };
    const refreshAllQueues = () => {
      if (refreshDebounce) clearTimeout(refreshDebounce);
      refreshDebounce = setTimeout(runRefresh, 150);
    };

    socket.on("token-called", refreshAllQueues);
    socket.on("queue-updated", refreshAllQueues);

    // Issue #430 (Apr 30 2026): Live Queue does not auto-refresh for the
    // nurse role — the page already subscribes to Socket.IO (`token-called`,
    // `queue-updated`) but the production report shows nurse views going
    // stale. The most likely cause is the socket either failing to connect
    // (proxy / network policy on the prod LAN) or the server not emitting
    // these events for nurse-scoped queries. Add a fallback `setInterval`
    // poll every 30s so even if Socket.IO is silent, the counts move. The
    // socket handlers above remain the primary low-latency path; the poll
    // is a safety net. 30s matches the bug body's "every 15-30s" target.
    const pollMs = 30_000;
    const pollId = setInterval(refreshAllQueues, pollMs);

    return () => {
      socket.disconnect();
      clearInterval(pollId);
      if (refreshDebounce) clearTimeout(refreshDebounce);
    };
    // Refs (myDoctorRef, otherDoctorPreviewRef, selectedDoctorRef) are
    // read inside refreshAllQueues — they don't need to be in deps. The
    // effect should run once per auth/user identity change only, not on
    // every queue mutation. See the refs comment block above for the
    // infinite-loop bug this prevents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthLoading, user]);

  async function loadDisplay() {
    try {
      const res = await api.get<{ data: QueueDoctor[] }>("/queue");
      setDisplay(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  const statusColors: Record<string, string> = {
    BOOKED: "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800",
    CHECKED_IN: "bg-yellow-50 border-yellow-200 dark:bg-yellow-400/10 dark:border-yellow-500/40",
    IN_CONSULTATION: "bg-green-50 border-green-300 dark:bg-green-900/20 dark:border-green-800",
    COMPLETED: "bg-gray-50 border-gray-200 dark:bg-gray-900/40 dark:border-gray-700",
  };

  // Reusable doctor-card renderer. Pulled out of the JSX so doctors can
  // surface their own card in a featured spot at top-left AND keep the
  // same card shape in the "other doctors" grid below.
  function renderDoctorCard(doc: QueueDoctor, opts: { featured?: boolean } = {}) {
    // Pearl ERP §2.1.2 — OPD card header branches by the doctor's mode.
    const mode = doc.appointmentMode ?? "TOKEN";
    const modeBadge =
      mode === "CALLING"
        ? { label: "Calling", cls: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-200" }
        : mode === "SLOT"
          ? { label: "Slot", cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-200" }
          : { label: "Token", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200" };
    const primaryLabel =
      mode === "CALLING"
        ? t("dashboard.queue.nowCalling", "Now Calling")
        : mode === "SLOT"
          ? t("dashboard.queue.todaysSlot", "Today's Slot")
          : t("dashboard.queue.currentToken");
    // Click router — UNIFIED: every role now opens the right-side
    // drawer with the clicked doctor's queue. Previously non-doctors
    // (ADMIN / RECEPTION / NURSE) got a separate detail-block-below-grid
    // layout, but that left admins with no concept of a "current
    // selection" while peeking at multiple doctors. The drawer pattern
    // matches the doctor view and gives every role the same single-
    // surface model for inspecting a doctor's queue.
    const isOwnCard = !!myDoctor && doc.doctorId === myDoctor.doctorId;
    const onCardClick = () => {
      if (isOwnCard) {
        // Doctor previewing their own card — refresh the pinned
        // myDoctorQueue too so the Next Patient panel stays current.
        void loadMyQueue(doc.doctorId);
      }
      void openOtherDoctorPreview(doc);
    };
    const isHighlighted =
      opts.featured || otherDoctorPreview?.doctor.doctorId === doc.doctorId;
    return (
      <button
        key={doc.doctorId}
        onClick={onCardClick}
        className={`rounded-xl border-2 p-6 text-left transition ${
          isHighlighted
            ? "border-primary bg-blue-50 dark:bg-blue-900/30"
            : "border-gray-200 bg-white hover:border-primary/50 dark:border-gray-700 dark:bg-gray-800"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold text-gray-900 dark:text-gray-100">
              {formatDoctorName(doc.doctorName)}
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-300">{doc.specialization}</p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${modeBadge.cls}`}
            title={`Appointment mode: ${mode}`}
          >
            {modeBadge.label}
          </span>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-700 dark:text-gray-300">{primaryLabel}</p>
            <p className="text-4xl font-bold text-primary dark:text-blue-300">
              {doc.currentToken ?? "—"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-700 dark:text-gray-300">{t("dashboard.queue.waiting")}</p>
            <p className="text-2xl font-bold text-gray-800 dark:text-gray-100">
              {doc.waitingCount}
            </p>
          </div>
        </div>
      </button>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">{t("dashboard.queue.title")}</h1>

      {/* Pearl §2.1.2 — when a DOCTOR opens the page, prioritize their
          own card + queue detail at the top (left = their card, right =
          their patient list). The full clinic state lives in the
          "Other Doctors" grid below. Non-doctor roles see the legacy
          flat grid with the selected-doctor detail below. */}
      {myDoctor ? (
        <>
          {/*
            Left + right share a single CSS-Grid row → align-items: stretch
            gives them equal height by default. Row pinned at `lg:h-48`
            (192px) — matches the doctor card's natural content height
            (~170px) with a touch of breathing room, AND caps the right
            panel so the patient list inside gets an invisible scrollbar
            instead of growing unbounded. Bumped down from h-72 because
            the card looked stretched / mostly-empty at 288px.
          */}
          <div
            className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-3 lg:h-48"
            data-testid="queue-my-section"
          >
            <div className="lg:col-span-1 h-full [&>button]:h-full [&>button]:w-full">
              {renderDoctorCard(myDoctor, { featured: true })}
            </div>
            <div className="lg:col-span-2 h-full min-h-0">
              <div className="flex h-full flex-col rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
                <h2 className="mb-4 shrink-0 font-semibold text-gray-900 dark:text-gray-100">
                  {t("dashboard.queue.nextPatient", "Next Patient")}
                </h2>
                {/*
                  Doctor's top-split panel now shows ONLY the next-up
                  patient (first entry in the queue) — the doctor cares
                  about who they're about to call, not the whole list.
                  Full list still available via socket-driven counts
                  (Waiting N on the card) and via the OTHER DOCTORS
                  drawer for cross-clinic visibility. If `waitingCount`
                  > 1, surface a "+ N more waiting" hint so the doctor
                  knows the queue isn't just this one patient.
                */}
                {(() => {
                  // "Next Patient" = the next patient who has ACTUALLY ARRIVED
                  // (CHECKED_IN) and is waiting to be called. We only surface
                  // checked-in patients here — a BOOKED patient hasn't shown up
                  // yet, so they can't be "next" (and shouldn't pad the
                  // "+N more waiting" count). IN_CONSULTATION (in the room now)
                  // and terminal statuses are likewise not "next up".
                  const checkedIn = myDoctorQueue
                    ? myDoctorQueue.queue.filter((e) => e.status === "CHECKED_IN")
                    : [];
                  // CALLING → trust the API's exact check-in (FIFO) order;
                  // tokens are irrelevant. TOKEN/SLOT → next token first.
                  const upcoming =
                    myDoctor?.appointmentMode === "CALLING"
                      ? checkedIn
                      : [...checkedIn].sort(
                          (a, b) =>
                            (a.tokenNumber ?? Number.MAX_SAFE_INTEGER) -
                            (b.tokenNumber ?? Number.MAX_SAFE_INTEGER)
                        );
                  if (!myDoctorQueue || upcoming.length === 0) {
                    return (
                      <p className="text-gray-700 dark:text-gray-300">
                        {t("dashboard.queue.noPatients")}
                      </p>
                    );
                  }
                  const next = upcoming[0];
                  const remaining = Math.max(0, upcoming.length - 1);
                  // Avatar initials — 1st char of first 2 words, e.g.
                    // "Subhadip De" → "SD", "bishnu" → "B". Falls back
                    // to "?" for empty names so the circle never blanks.
                    const initials =
                      next.patientName
                        ?.trim()
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((w) => w[0]?.toUpperCase() ?? "")
                        .join("") || "?";
                    // Stable per-patient color so the same patient gets
                    // the same avatar tint across renders. Cheap hash of
                    // the name → one of 6 palette entries.
                    const palette = [
                      "bg-blue-500",
                      "bg-emerald-500",
                      "bg-amber-500",
                      "bg-rose-500",
                      "bg-violet-500",
                      "bg-cyan-500",
                    ];
                    let hash = 0;
                    for (let i = 0; i < next.patientName.length; i++) {
                      hash = (hash * 31 + next.patientName.charCodeAt(i)) >>> 0;
                    }
                    const avatarBg = palette[hash % palette.length];
                    return (
                      <div className="flex-1" data-testid="queue-my-next-patient">
                        {/* Whole row is a Next.js Link to the patient
                            detail page — clicking opens the full chart
                            (demographics, history, vitals, prescriptions,
                            invoices, …). Hover state hints clickability. */}
                        <Link
                          href={`/dashboard/patients/${next.patientId}?from=queue`}
                          className={`flex items-center justify-between rounded-lg border p-3 text-sm transition hover:shadow-md hover:border-primary/60 ${next.calledAt ? "border-teal-400 bg-teal-50 ring-2 ring-teal-300 dark:border-teal-500 dark:bg-teal-900/25 dark:ring-teal-600" : statusColors[next.status] || "bg-white dark:bg-gray-800 dark:border-gray-700"}`}
                          data-testid="queue-my-next-patient-link"
                          aria-label={`Open patient detail for ${next.patientName}`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {/* Avatar circle — initials. Background tint
                                is name-hash derived so each patient is
                                visually distinct at a glance. */}
                            <div
                              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${avatarBg}`}
                              aria-label={`Avatar for ${next.patientName}`}
                            >
                              {initials}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="truncate font-medium text-gray-900 dark:text-gray-100">
                                  {next.patientName}
                                </p>
                                {/* Token pill (T-N) when a token was issued —
                                    that alone signals a TOKEN booking. The
                                    redundant mode word-badge isn't shown. */}
                                {next.tokenNumber != null && (
                                  <span
                                    className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                                    title={`Token #${next.tokenNumber}`}
                                  >
                                    T-{next.tokenNumber}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                {next.type === "WALK_IN"
                                  ? "Walk-in"
                                  : next.slotTime
                                    ? `Slot: ${next.slotTime}`
                                    : null}
                              </p>
                            </div>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              next.calledAt
                                ? "bg-teal-600 text-white dark:bg-teal-500"
                                : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                            }`}
                          >
                            {next.calledAt ? "CALLING" : next.status}
                          </span>
                        </Link>
                        {remaining > 0 && (
                          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                            +{remaining}{" "}
                            {t("dashboard.queue.moreWaiting", "more waiting")}
                          </p>
                        )}
                      </div>
                    );
                })()}
              </div>
            </div>
          </div>

          {otherDoctors.length > 0 && (
            <>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("dashboard.queue.otherDoctors", "Other Doctors")}
              </h2>
              <div
                className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                data-testid="queue-other-doctors-grid"
              >
                {loading ? (
                  <>
                    <SkeletonCard className="h-36" />
                    <SkeletonCard className="h-36" />
                    <SkeletonCard className="h-36" />
                  </>
                ) : (
                  otherDoctors.map((doc) => renderDoctorCard(doc))
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="queue-doctors-grid">
          {loading ? (
            <>
              <SkeletonCard className="h-36" />
              <SkeletonCard className="h-36" />
              <SkeletonCard className="h-36" />
            </>
          ) : (
            otherDoctors.map((doc) => renderDoctorCard(doc))
          )}
        </div>
      )}

      {/*
        Right-side drawer for previewing another doctor's queue. Opened
        when the doctor (user) clicks a card in the OTHER DOCTORS grid.
        Fixed position with a click-outside backdrop so the doctor can
        glance at a colleague's load without losing their own pinned
        top-split. Invisible scrollbar inside the patient list (same
        chrome-hidden pattern as the top-split).
      */}
      {otherDoctorPreview && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30"
            onClick={closeOtherDoctorPreview}
            aria-hidden="true"
            data-testid="queue-other-drawer-backdrop"
          />
          <aside
            className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-md flex-col bg-white shadow-2xl dark:bg-gray-800"
            role="dialog"
            aria-modal="true"
            aria-labelledby="queue-other-drawer-title"
            data-testid="queue-other-drawer"
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
              <div className="min-w-0">
                <h2
                  id="queue-other-drawer-title"
                  className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100"
                >
                  {formatDoctorName(otherDoctorPreview.doctor.doctorName)}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {otherDoctorPreview.doctor.specialization} ·{" "}
                  {t("dashboard.queue.waiting")}{" "}
                  {otherDoctorPreview.doctor.waitingCount}
                </p>
              </div>
              <button
                type="button"
                onClick={closeOtherDoctorPreview}
                className="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                aria-label={t("dashboard.queue.close", "Close")}
              >
                ✕
              </button>
            </div>
            <div
              className="flex-1 overflow-y-auto px-6 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-testid="queue-other-drawer-patients"
            >
              {!otherDoctorPreview.queue ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("dashboard.queue.loading", "Loading…")}
                </p>
              ) : otherDoctorPreview.queue.queue.filter(
                  (e) =>
                    e.status === "CHECKED_IN" ||
                    e.status === "IN_CONSULTATION"
                ).length === 0 ? (
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t("dashboard.queue.noPatients")}
                </p>
              ) : (
                <div className="space-y-2">
                  {/* The live queue lists only patients who are physically
                      present: CHECKED_IN (waiting) + IN_CONSULTATION (being
                      seen). BOOKED (not arrived) patients live on the
                      Appointments page, not here. IN_CONSULTATION sorts first
                      ("NOW"); within waiting, TOKEN mode sorts by token while
                      CALLING preserves the API's check-in (FIFO) order. */}
                  {otherDoctorPreview.queue.queue
                    .filter(
                      (e) =>
                        e.status === "CHECKED_IN" ||
                        e.status === "IN_CONSULTATION"
                    )
                    .sort((a, b) => {
                      const terminal = new Set([
                        "COMPLETED",
                        "CANCELLED",
                        "NO_SHOW",
                      ]);
                      const aDone = terminal.has(a.status) ? 1 : 0;
                      const bDone = terminal.has(b.status) ? 1 : 0;
                      if (aDone !== bDone) return aDone - bDone;
                      // CALLING → trust the API's check-in (FIFO) + presence
                      // order; tokens don't apply. (Terminal rows already
                      // pushed to the bottom above.)
                      if (
                        otherDoctorPreview.doctor.appointmentMode === "CALLING"
                      ) {
                        return 0;
                      }
                      // Presence: IN_CONSULTATION > CHECKED_IN (arrived) >
                      // BOOKED (not arrived). A checked-in patient is up next
                      // ahead of one who only booked.
                      const presRank = (s: string): number =>
                        s === "IN_CONSULTATION"
                          ? 0
                          : s === "CHECKED_IN"
                            ? 1
                            : 2;
                      const pres = presRank(a.status) - presRank(b.status);
                      if (pres !== 0) return pres;
                      return (
                        (a.tokenNumber ?? Number.MAX_SAFE_INTEGER) -
                        (b.tokenNumber ?? Number.MAX_SAFE_INTEGER)
                      );
                    })
                    .map((entry) => (
                    <div
                      key={entry.appointmentId}
                      className={`relative overflow-hidden rounded-lg border px-3 py-2 text-sm transition ${
                        entry.status === "IN_CONSULTATION"
                          ? "border-emerald-400 bg-emerald-50 shadow-sm ring-1 ring-emerald-200 dark:border-emerald-600 dark:bg-emerald-900/20 dark:ring-emerald-800"
                          : entry.calledAt
                            ? "border-teal-400 bg-teal-50 shadow-sm ring-2 ring-teal-300 dark:border-teal-500 dark:bg-teal-900/25 dark:ring-teal-600"
                            : statusColors[entry.status] ||
                              "bg-white dark:bg-gray-800 dark:border-gray-700"
                      }`}
                    >
                      {/* Left marker bar: emerald for the in-room patient,
                          teal (pulsing) for the patient being called now. */}
                      {entry.calledAt && entry.status !== "IN_CONSULTATION" && (
                        <span
                          className="absolute inset-y-0 left-0 w-1 animate-pulse bg-teal-500"
                          aria-hidden="true"
                        />
                      )}
                      {/* "Currently consulting" marker — a 4-px emerald
                          left bar + pulsing dot make the active row
                          jump out from the rest of the queue. */}
                      {entry.status === "IN_CONSULTATION" && (
                        <span
                          className="absolute inset-y-0 left-0 w-1 bg-emerald-500"
                          aria-hidden="true"
                        />
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          {/* Patient avatar — photo if available, else
                              name-hash-tinted initials (same treatment as the
                              Next Patient panel). Replaces the bare token
                              number circle. */}
                          {(() => {
                            const initials =
                              entry.patientName
                                ?.trim()
                                .split(/\s+/)
                                .slice(0, 2)
                                .map((w) => w[0]?.toUpperCase() ?? "")
                                .join("") || "?";
                            const palette = [
                              "bg-blue-500",
                              "bg-emerald-500",
                              "bg-amber-500",
                              "bg-rose-500",
                              "bg-violet-500",
                              "bg-cyan-500",
                            ];
                            let hash = 0;
                            for (let i = 0; i < entry.patientName.length; i++) {
                              hash =
                                (hash * 31 + entry.patientName.charCodeAt(i)) >>> 0;
                            }
                            const avatarBg = palette[hash % palette.length];
                            return entry.patientPhotoUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={entry.patientPhotoUrl}
                                alt={`Photo of ${entry.patientName}`}
                                className="h-9 w-9 shrink-0 rounded-full object-cover"
                              />
                            ) : (
                              <div
                                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${avatarBg}`}
                                aria-label={`Avatar for ${entry.patientName}`}
                              >
                                {initials}
                              </div>
                            );
                          })()}
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
                              {/* Only the NAME links to the patient profile —
                                  the rest of the row is non-navigating. */}
                              <Link
                                href={`/dashboard/patients/${entry.patientId}?from=queue&previewDoctor=${otherDoctorPreview.doctor.doctorId}`}
                                className="min-w-0 truncate hover:text-primary"
                                aria-label={`Open patient detail for ${entry.patientName}`}
                              >
                                {entry.patientName}
                              </Link>
                              {entry.status === "IN_CONSULTATION" && (
                                <span
                                  className="relative inline-flex h-2 w-2 shrink-0"
                                  aria-label="Currently consulting"
                                  title="Currently consulting"
                                >
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                                </span>
                              )}
                              {entry.vulnerableFlags?.isChild && (
                                <span
                                  title="Child"
                                  aria-label="Child"
                                  className="cursor-default select-none rounded-full bg-pink-100 px-1 py-0.5 text-[10px] dark:bg-pink-900/40"
                                >
                                  👶
                                </span>
                              )}
                              {entry.vulnerableFlags?.isPregnant && (
                                <span
                                  title="Active antenatal case"
                                  className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700 dark:bg-purple-900/40 dark:text-purple-200"
                                >
                                  🤰 ANC
                                </span>
                              )}
                              {entry.vulnerableFlags?.isSenior && (
                                <span
                                  title="Senior citizen (65+)"
                                  className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                                >
                                  🧓 SENIOR
                                </span>
                              )}
                            </p>
                            {/* Secondary line: patient age (+ walk-in / priority
                                badges). The slot time is intentionally omitted
                                here — the queue is arrival/age-driven, not
                                slot-driven. */}
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {entry.type === "WALK_IN" && <span>Walk-in</span>}
                              {entry.priority !== "NORMAL" && (
                                <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
                                  {entry.priority}
                                </span>
                              )}
                              {entry.vulnerableFlags?.ageYears !== null &&
                                entry.vulnerableFlags?.ageYears !== undefined && (
                                  <span
                                    className={
                                      entry.type === "WALK_IN"
                                        ? "ml-2 text-gray-400"
                                        : "text-gray-400"
                                    }
                                  >
                                    Age {entry.vulnerableFlags.ageYears}
                                  </span>
                                )}
                              {/* The token pill (T-N) shows whenever a token
                                  was issued — that alone signals a TOKEN
                                  booking; SLOT rows show their slot time. The
                                  redundant mode word-badge is intentionally not
                                  shown here. */}
                              {entry.tokenNumber != null && (
                                <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                                  T-{entry.tokenNumber}
                                </span>
                              )}
                              {entry.slotTime && (
                                <span className="ml-2 text-gray-400">
                                  {entry.slotTime}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              entry.status === "IN_CONSULTATION"
                                ? "bg-emerald-600 text-white dark:bg-emerald-500"
                                : entry.calledAt
                                  ? "bg-teal-600 text-white dark:bg-teal-500"
                                  : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                            }`}
                          >
                            {entry.status === "IN_CONSULTATION"
                              ? "IN CONSULT"
                              : entry.calledAt
                                ? "CALLING"
                                : entry.status}
                          </span>
                          {/* Actual time waited since check-in. Shown only for
                              CALLING / TOKEN queues (SLOT has a fixed slot
                              time, so an elapsed-wait chip is meaningless) and
                              only once the patient has checked in (waitedMinutes
                              is null for not-yet-arrived BOOKED rows). */}
                          {otherDoctorPreview.doctor.appointmentMode !== "SLOT" &&
                            entry.status === "CHECKED_IN" &&
                            entry.waitedMinutes != null && (
                              <p className="text-[10px] text-gray-500 dark:text-gray-400">
                                ~{entry.waitedMinutes} min wait
                              </p>
                            )}
                        </div>
                      </div>
                      {/* CALLING-mode: "Call" the patient (any order). The
                          patient currently being called shows a live "Calling
                          now" marker instead; calling another patient switches
                          the active call to them. */}
                      {/* The calling indicator is read-only for everyone, but
                          only a DOCTOR can perform the Call action — other
                          roles (reception/admin/nurse) see the queue read-only.
                          Single active call: while ANY patient is being called,
                          the other Call buttons stay VISIBLE but DISABLED until
                          the current call is cancelled (bell-off) or the consult
                          starts (which clears the call). */}
                      {otherDoctorPreview.doctor.appointmentMode === "CALLING" &&
                        entry.status === "CHECKED_IN" &&
                        (entry.calledAt || isDoctor) && (
                          <div className="mt-1 flex justify-end">
                            {entry.calledAt ? (
                              <div className="flex items-center gap-3">
                                {/* Cancel the call (doctor only) — sits BEFORE
                                    the calling bell — reverts this patient back
                                    to plain CHECKED_IN. */}
                                {isDoctor && (
                                  <button
                                    onClick={() =>
                                      uncallPatient(
                                        entry.appointmentId,
                                        otherDoctorPreview.doctor.doctorId,
                                      )
                                    }
                                    aria-label={`Cancel call for ${entry.patientName}`}
                                    title="Cancel call"
                                    className="text-gray-400 hover:text-rose-600 dark:text-gray-500 dark:hover:text-rose-400"
                                  >
                                    <BellOff size={14} aria-hidden="true" />
                                  </button>
                                )}
                                <span
                                  className="inline-flex items-center gap-1.5 text-teal-700 dark:text-teal-300"
                                  aria-label={`Calling ${entry.patientName}`}
                                  title="Calling now"
                                >
                                  <BellRing
                                    size={13}
                                    className="animate-pulse"
                                    aria-hidden="true"
                                  />
                                  {/* Three dots waving left→right (staggered
                                      bounce via negative animation delays). */}
                                  <span className="inline-flex items-end gap-0.5 pb-0.5">
                                    <span className="h-1 w-1 animate-bounce rounded-full bg-teal-500 [animation-delay:-0.3s]" />
                                    <span className="h-1 w-1 animate-bounce rounded-full bg-teal-500 [animation-delay:-0.15s]" />
                                    <span className="h-1 w-1 animate-bounce rounded-full bg-teal-500" />
                                  </span>
                                </span>
                              </div>
                            ) : (
                              (() => {
                                // Disabled while another patient is being called
                                // (single active call) — re-enables once that
                                // call is cancelled or the consult starts.
                                const callBusy =
                                  otherDoctorPreview.queue?.queue.some(
                                    (e) => e.calledAt,
                                  ) ?? false;
                                return (
                                  <button
                                    onClick={() =>
                                      callPatient(
                                        entry.appointmentId,
                                        otherDoctorPreview.doctor.doctorId,
                                      )
                                    }
                                    disabled={callBusy}
                                    aria-label={`Call ${entry.patientName}`}
                                    title={
                                      callBusy
                                        ? "Cancel the current call first"
                                        : "Call patient"
                                    }
                                    className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                                      callBusy
                                        ? "cursor-not-allowed text-gray-400 opacity-50 dark:text-gray-600"
                                        : "text-teal-600 hover:text-teal-700 dark:text-teal-300 dark:hover:text-teal-200"
                                    }`}
                                  >
                                    <BellRing size={11} aria-hidden="true" />
                                    Call
                                  </button>
                                );
                              })()
                            )}
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
