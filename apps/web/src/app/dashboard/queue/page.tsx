"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePrompt } from "@/lib/use-dialog";
import { getSocket } from "@/lib/socket";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { SkeletonCard } from "@/components/Skeleton";

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
  tokenNumber: number;
  patientName: string;
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
  const promptUser = usePrompt();
  const canTransfer = user?.role === "ADMIN" || user?.role === "RECEPTION";

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
  const [transferTarget, setTransferTarget] = useState<{
    appointmentId: string;
    patientName: string;
    currentDoctorId: string;
  } | null>(null);
  const [transferDoctorId, setTransferDoctorId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [transferring, setTransferring] = useState(false);

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
  const otherDoctors = useMemo(
    () => (myDoctor ? display.filter((d) => d.doctorId !== myDoctor.doctorId) : display),
    [display, myDoctor],
  );

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

  async function handleTransfer() {
    if (!transferTarget || !transferDoctorId || !transferReason.trim()) {
      toast.error("Please select a doctor and enter a reason.");
      return;
    }
    setTransferring(true);
    try {
      await api.post(
        `/appointments/${transferTarget.appointmentId}/transfer`,
        { newDoctorId: transferDoctorId, reason: transferReason }
      );
      setTransferTarget(null);
      setTransferDoctorId("");
      setTransferReason("");
      loadDisplay();
      // Refresh the drawer if it's currently previewing the doctor whose
      // queue this transfer mutated, so the patient row reflects the move.
      const previewing = otherDoctorPreviewRef.current;
      if (previewing) void openOtherDoctorPreview(previewing.doctor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transfer failed");
    }
    setTransferring(false);
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
    CHECKED_IN: "bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800",
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
        ? { label: "Calling", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200" }
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
                  // "Next Patient" = the next token still waiting to
                  // be called. Excludes:
                  //   - COMPLETED / CANCELLED / NO_SHOW: terminal
                  //   - IN_CONSULTATION: already with the doctor RIGHT
                  //     NOW, not a "next up" candidate
                  // After Start Consult flips token 2 to
                  // IN_CONSULTATION, the panel should show "no patients
                  // waiting" — not the in-room patient.
                  const NOT_UPCOMING = new Set([
                    "COMPLETED",
                    "CANCELLED",
                    "NO_SHOW",
                    "IN_CONSULTATION",
                  ]);
                  // Sort by tokenNumber ascending so the panel shows
                  // the IMMEDIATE next token (T-4 after T-3 is being
                  // consulted), not whatever order the API returned.
                  // The API ordering isn't guaranteed and was surfacing
                  // T-7 before T-4 in production.
                  const upcoming = myDoctorQueue
                    ? myDoctorQueue.queue
                        .filter((e) => !NOT_UPCOMING.has(e.status))
                        .sort((a, b) => a.tokenNumber - b.tokenNumber)
                    : [];
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
                          className={`flex items-center justify-between rounded-lg border p-3 text-sm transition hover:shadow-md hover:border-primary/60 ${statusColors[next.status] || "bg-white dark:bg-gray-800 dark:border-gray-700"}`}
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
                                {/* Token chip — moved off the avatar so the
                                    avatar can carry the identity (initials /
                                    later: photo) and the token sits as a
                                    secondary metadata pill next to the name. */}
                                <span
                                  className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary dark:bg-blue-900/40 dark:text-blue-200"
                                  title={`Token #${next.tokenNumber}`}
                                >
                                  T-{next.tokenNumber}
                                </span>
                              </div>
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                {next.type === "WALK_IN"
                                  ? "Walk-in"
                                  : `Slot: ${next.slotTime}`}
                              </p>
                            </div>
                          </div>
                          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                            {next.status}
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
            display.map((doc) => renderDoctorCard(doc))
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
              ) : otherDoctorPreview.queue.queue.length === 0 ? (
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t("dashboard.queue.noPatients")}
                </p>
              ) : (
                <div className="space-y-2">
                  {/* Sort by queue position: active tokens
                      (IN_CONSULTATION / CHECKED_IN / BOOKED) ascending
                      by token number FIRST, then terminal entries
                      (COMPLETED / CANCELLED / NO_SHOW) at the bottom
                      so the doctor sees who's up next without
                      scrolling past finished patients. */}
                  {[...otherDoctorPreview.queue.queue]
                    .sort((a, b) => {
                      const terminal = new Set([
                        "COMPLETED",
                        "CANCELLED",
                        "NO_SHOW",
                      ]);
                      const aDone = terminal.has(a.status) ? 1 : 0;
                      const bDone = terminal.has(b.status) ? 1 : 0;
                      if (aDone !== bDone) return aDone - bDone;
                      return a.tokenNumber - b.tokenNumber;
                    })
                    .map((entry) => (
                    <div
                      key={entry.appointmentId}
                      className={`relative overflow-hidden rounded-lg border p-3 text-sm transition ${
                        entry.status === "IN_CONSULTATION"
                          ? "border-emerald-400 bg-emerald-50 shadow-sm ring-1 ring-emerald-200 dark:border-emerald-600 dark:bg-emerald-900/20 dark:ring-emerald-800"
                          : statusColors[entry.status] ||
                            "bg-white dark:bg-gray-800 dark:border-gray-700"
                      }`}
                    >
                      {/* "Currently consulting" marker — a 4-px emerald
                          left bar + pulsing dot make the active row
                          jump out from the rest of the queue. */}
                      {entry.status === "IN_CONSULTATION" && (
                        <span
                          className="absolute inset-y-0 left-0 w-1 bg-emerald-500"
                          aria-hidden="true"
                        />
                      )}
                      <Link
                        // Append `previewDoctor=<id>` so the patient detail
                        // page can echo it back via its "Back to Queue"
                        // link — clicking back restores this drawer.
                        href={`/dashboard/patients/${entry.patientId}?from=queue&previewDoctor=${otherDoctorPreview.doctor.doctorId}`}
                        className="flex items-center justify-between gap-2 hover:opacity-90"
                        aria-label={`Open patient detail for ${entry.patientName}`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-white">
                            {entry.tokenNumber}
                          </div>
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 truncate font-medium text-gray-900 dark:text-gray-100">
                              <span className="truncate">{entry.patientName}</span>
                              {entry.status === "IN_CONSULTATION" && (
                                <span
                                  className="relative flex h-2 w-2 shrink-0"
                                  aria-label="Currently consulting"
                                  title="Currently consulting"
                                >
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                                </span>
                              )}
                              {entry.vulnerableFlags?.isChild && (
                                <span
                                  title="Child under 5"
                                  className="rounded-full bg-pink-100 px-1.5 py-0.5 text-[10px] font-semibold text-pink-700"
                                >
                                  👶 CHILD
                                </span>
                              )}
                              {entry.vulnerableFlags?.isPregnant && (
                                <span
                                  title="Active antenatal case"
                                  className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700"
                                >
                                  🤰 ANC
                                </span>
                              )}
                              {entry.vulnerableFlags?.isSenior && (
                                <span
                                  title="Senior citizen (65+)"
                                  className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                                >
                                  🧓 SENIOR
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {entry.type === "WALK_IN" ? "Walk-in" : `Slot: ${entry.slotTime}`}
                              {entry.priority !== "NORMAL" && (
                                <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                                  {entry.priority}
                                </span>
                              )}
                              {entry.vulnerableFlags?.ageYears !== null &&
                                entry.vulnerableFlags?.ageYears !== undefined && (
                                  <span className="ml-2 text-gray-400">
                                    · Age {entry.vulnerableFlags.ageYears}
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
                                : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                            }`}
                          >
                            {entry.status === "IN_CONSULTATION"
                              ? "NOW"
                              : entry.status}
                          </span>
                          {entry.status !== "COMPLETED" &&
                            entry.status !== "IN_CONSULTATION" && (
                              <p className="text-[10px] text-gray-500 dark:text-gray-400">
                                ~{entry.estimatedWaitMinutes} min wait
                              </p>
                            )}
                          <p className="text-[10px] text-gray-400">
                            {entry.hasVitals ? "Vitals recorded" : "No vitals"}
                          </p>
                        </div>
                      </Link>
                      {canTransfer &&
                        ["BOOKED", "CHECKED_IN"].includes(entry.status) && (
                          <div className="mt-2 flex justify-end gap-1.5">
                            <button
                              onClick={() =>
                                setTransferTarget({
                                  appointmentId: entry.appointmentId,
                                  patientName: entry.patientName,
                                  currentDoctorId:
                                    otherDoctorPreview.doctor.doctorId,
                                })
                              }
                              aria-label={`Transfer ${entry.patientName} to another doctor`}
                              className="touch-target rounded border border-indigo-400 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800 hover:bg-indigo-100"
                            >
                              {t("dashboard.actions.transfer")}
                            </button>
                            <button
                              onClick={async () => {
                                const reason = await promptUser({
                                  title: "Left Without Being Seen",
                                  label: "LWBS reason",
                                  placeholder:
                                    "e.g., Long wait, Emergency, Patient left",
                                  required: true,
                                });
                                if (!reason) return;
                                try {
                                  await api.patch(
                                    `/appointments/${entry.appointmentId}/lwbs`,
                                    { reason }
                                  );
                                  loadDisplay();
                                  void openOtherDoctorPreview(
                                    otherDoctorPreview.doctor
                                  );
                                } catch (err) {
                                  toast.error(
                                    err instanceof Error ? err.message : "Failed"
                                  );
                                }
                              }}
                              className="touch-target rounded border border-red-400 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800 hover:bg-red-100"
                              aria-label={`Mark ${entry.patientName} as left without being seen`}
                            >
                              {t("dashboard.actions.lwbs")}
                            </button>
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

      {/* Transfer modal */}
      {transferTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
              {t("dashboard.queue.transfer")}
            </h3>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {t("dashboard.appointments.col.patient")}: <span className="font-medium">{transferTarget.patientName}</span>
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="queue-transfer-doctor" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  {t("dashboard.queue.newDoctor")}
                </label>
                <select
                  id="queue-transfer-doctor"
                  value={transferDoctorId}
                  onChange={(e) => setTransferDoctorId(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="">{t("dashboard.queue.selectDoctor")}</option>
                  {display
                    .filter((d) => d.doctorId !== transferTarget.currentDoctorId)
                    .map((d) => (
                      <option key={d.doctorId} value={d.doctorId}>
                        {formatDoctorName(d.doctorName)}
                        {d.specialization ? ` — ${d.specialization}` : ""}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label htmlFor="queue-transfer-reason" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  {t("common.reason")}
                </label>
                <textarea
                  id="queue-transfer-reason"
                  value={transferReason}
                  onChange={(e) => setTransferReason(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  placeholder={t("dashboard.queue.transferReason")}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => {
                  setTransferTarget(null);
                  setTransferDoctorId("");
                  setTransferReason("");
                }}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleTransfer}
                disabled={transferring}
                className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-800 disabled:opacity-60"
              >
                {transferring ? t("dashboard.queue.transferring") : t("dashboard.queue.confirmTransfer")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
