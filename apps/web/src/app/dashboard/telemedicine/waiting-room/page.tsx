"use client";

/**
 * Patient-facing waiting room for a Jitsi tele-consult.
 *
 * Flow:
 *   1. Patient picks (or the URL passes ?sessionId=xxx) an upcoming session.
 *   2. Runs camera + mic self-test (navigator.mediaDevices.getUserMedia).
 *   3. POSTs /precheck, then /waiting-room/join — enters "waiting" state.
 *   4. Listens on Socket.IO for `telemedicine:admitted`. When it arrives,
 *      redirects to the signed Jitsi URL.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { getSocket } from "@/lib/socket";
import { useAuthStore } from "@/lib/store";
import { Video, Mic, MicOff, VideoOff, CheckCircle2, XCircle, Loader2 } from "lucide-react";

interface SessionLite {
  id: string;
  sessionNumber: string;
  scheduledAt: string;
  meetingUrl?: string | null;
  status: string;
  doctor: { user: { name: string }; specialization?: string | null };
}

type PrecheckStatus = "idle" | "testing" | "passed" | "failed";
type WaitStatus = "idle" | "joining" | "waiting" | "admitted" | "denied";

export default function TelemedicineWaitingRoomPage() {
  const { user } = useAuthStore();
  const searchParams = useSearchParams();
  const urlSessionId = searchParams.get("sessionId");

  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [sessionId, setSessionId] = useState<string>(urlSessionId ?? "");
  const [session, setSession] = useState<SessionLite | null>(null);

  const [precheck, setPrecheck] = useState<PrecheckStatus>("idle");
  const [cameraOk, setCameraOk] = useState<boolean | null>(null);
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const [precheckError, setPrecheckError] = useState<string>("");

  const [waitStatus, setWaitStatus] = useState<WaitStatus>("idle");
  const [admitUrl, setAdmitUrl] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState<string>("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Load upcoming sessions for this patient so they can pick one.
  useEffect(() => {
    (async () => {
      try {
        const [sched, waiting] = await Promise.all([
          api.get<{ data: SessionLite[] }>("/telemedicine?status=SCHEDULED&limit=20"),
          api
            .get<{ data: SessionLite[] }>("/telemedicine?status=WAITING&limit=20")
            .catch(() => ({ data: [] as SessionLite[] })),
        ]);
        const merged = [...sched.data, ...waiting.data];
        setSessions(merged);
        if (!sessionId && merged.length === 1) setSessionId(merged[0].id);
      } catch {
        setSessions([]);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load selected session details
  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      return;
    }
    (async () => {
      try {
        const res = await api.get<{ data: SessionLite }>(`/telemedicine/${sessionId}`);
        setSession(res.data);
      } catch {
        setSession(null);
      }
    })();
  }, [sessionId]);

  const runPrecheck = useCallback(async () => {
    setPrecheck("testing");
    setPrecheckError("");
    setCameraOk(null);
    setMicOk(null);

    let cam = false;
    let mic = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      cam = stream.getVideoTracks().some((t) => t.readyState === "live");
      mic = stream.getAudioTracks().some((t) => t.readyState === "live");
      setCameraOk(cam);
      setMicOk(mic);
    } catch (err) {
      setPrecheckError(
        err instanceof Error ? err.message : "Failed to access camera or microphone"
      );
      setCameraOk(false);
      setMicOk(false);
    }

    const passed = cam && mic;
    setPrecheck(passed ? "passed" : "failed");

    // Report to server
    if (sessionId) {
      try {
        await api.post(`/telemedicine/${sessionId}/precheck`, {
          camera: cam,
          mic,
          userAgent:
            typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : undefined,
        });
      } catch {
        // non-fatal
      }
    }
  }, [sessionId]);

  const joinWaitingRoom = useCallback(async () => {
    if (!sessionId) return;
    setWaitStatus("joining");
    try {
      await api.post(`/telemedicine/${sessionId}/waiting-room/join`, {
        deviceInfo: {
          userAgent:
            typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : undefined,
          camera: !!cameraOk,
          mic: !!micOk,
        },
      });
      setWaitStatus("waiting");
    } catch (err) {
      setWaitStatus("idle");
      alert(err instanceof Error ? err.message : "Failed to join waiting room");
    }
  }, [sessionId, cameraOk, micOk]);

  // Socket subscription — listen for admit decisions
  useEffect(() => {
    if (!sessionId || !user?.id) return;
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    socket.emit("join", `telemedicine:${sessionId}`);
    socket.emit("join", `user:${user.id}`);

    const handler = (payload: {
      sessionId: string;
      admitted: boolean;
      url?: string;
      reason?: string | null;
    }) => {
      if (payload.sessionId !== sessionId) return;
      if (payload.admitted) {
        setWaitStatus("admitted");
        if (payload.url) {
          setAdmitUrl(payload.url);
          // Auto-open after a short beat so the user sees the confirmation
          setTimeout(() => {
            window.open(payload.url, "_blank", "noopener");
          }, 800);
        }
      } else {
        setWaitStatus("denied");
        setDenyReason(payload.reason ?? "");
      }
    };

    socket.on("telemedicine:admitted", handler);

    return () => {
      socket.off("telemedicine:admitted", handler);
    };
  }, [sessionId, user?.id]);

  // Cleanup camera/mic on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Telemedicine Waiting Room</h1>
        <p className="text-sm text-gray-500">
          Run a quick camera &amp; mic check, then wait for your doctor to admit you.
        </p>
      </div>

      {/* Session picker */}
      {!urlSessionId && (
        <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
          <label className="mb-2 block text-sm font-medium">Select Session</label>
          <select
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          >
            <option value="">Pick an upcoming session…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.sessionNumber} — Dr. {s.doctor.user.name} (
                {new Date(s.scheduledAt).toLocaleString()})
              </option>
            ))}
          </select>
        </div>
      )}

      {session && (
        <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
          <p className="text-xs text-gray-400">{session.sessionNumber}</p>
          <h2 className="text-lg font-semibold">Dr. {session.doctor.user.name}</h2>
          {session.doctor.specialization && (
            <p className="text-sm text-gray-500">{session.doctor.specialization}</p>
          )}
          <p className="mt-2 text-sm text-gray-600">
            Scheduled: {new Date(session.scheduledAt).toLocaleString()}
          </p>
        </div>
      )}

      {/* Pre-check */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold">1. Camera &amp; Mic Check</h3>

        <div className="mb-4 aspect-video w-full overflow-hidden rounded-lg bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover"
          />
        </div>

        <div className="mb-3 flex flex-wrap gap-3 text-sm">
          <span
            className={`flex items-center gap-1 rounded-full px-3 py-1 ${
              cameraOk === true
                ? "bg-green-100 text-green-700"
                : cameraOk === false
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-600"
            }`}
          >
            {cameraOk ? <Video size={14} /> : <VideoOff size={14} />}
            Camera {cameraOk === null ? "not tested" : cameraOk ? "OK" : "failed"}
          </span>
          <span
            className={`flex items-center gap-1 rounded-full px-3 py-1 ${
              micOk === true
                ? "bg-green-100 text-green-700"
                : micOk === false
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-600"
            }`}
          >
            {micOk ? <Mic size={14} /> : <MicOff size={14} />}
            Mic {micOk === null ? "not tested" : micOk ? "OK" : "failed"}
          </span>
        </div>

        {precheckError && (
          <p className="mb-3 rounded-lg bg-red-50 p-2 text-xs text-red-700">
            {precheckError}
          </p>
        )}

        <button
          onClick={runPrecheck}
          disabled={precheck === "testing" || !sessionId}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
        >
          {precheck === "testing" ? (
            <span className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Testing…
            </span>
          ) : precheck === "passed" ? (
            "Re-test Devices"
          ) : (
            "Run Device Test"
          )}
        </button>
      </div>

      {/* Join */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold">2. Enter Waiting Room</h3>
        <p className="mb-4 text-sm text-gray-600">
          Your doctor will be notified the moment you join.
        </p>
        <button
          onClick={joinWaitingRoom}
          disabled={
            !sessionId ||
            precheck !== "passed" ||
            waitStatus === "waiting" ||
            waitStatus === "admitted"
          }
          className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {waitStatus === "joining" ? (
            <span className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Joining…
            </span>
          ) : waitStatus === "waiting" ? (
            "Waiting for doctor…"
          ) : (
            "Join Waiting Room"
          )}
        </button>

        {waitStatus === "waiting" && (
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-purple-50 p-3 text-sm text-purple-800">
            <Loader2 size={14} className="animate-spin" />
            <span>
              Doctor has been notified. Please keep this tab open — you will be admitted
              automatically.
            </span>
          </div>
        )}

        {waitStatus === "admitted" && (
          <div className="mt-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <CheckCircle2 size={16} /> Admitted! Opening call…
            </div>
            {admitUrl && (
              <a
                href={admitUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
              >
                <Video size={14} /> Open Call
              </a>
            )}
          </div>
        )}

        {waitStatus === "denied" && (
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">
            <XCircle size={16} />
            <div>
              <p className="font-medium">Not admitted</p>
              {denyReason && <p className="mt-0.5 text-xs">{denyReason}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
