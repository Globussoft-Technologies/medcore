"use client";

// Pearl ERP Stage 1 §2.1.7 — threaded remarks modal.
//
// What / which modules / why:
//   Reusable modal that surfaces the AppointmentRemark thread for a
//   single appointment. Lists pinned remarks first then newest-first;
//   lets any non-PATIENT role create a remark with a visibility scope
//   (ALL_STAFF, DOCTOR_ONLY, RECEPTION_ONLY, PRIVATE); lets DOCTOR/ADMIN
//   pin or unpin; lets the author edit/delete (and ADMIN delete any).
//
//   Replies inherit the parent's visibility on the server, so the UI
//   intentionally hides the visibility picker when composing a reply
//   (we display the parent's visibility instead and let the server
//   enforce inheritance).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { Pin, Reply, Trash2, X, Pencil, Lock, Globe2, Stethoscope, UserCheck } from "lucide-react";

type Visibility = "ALL_STAFF" | "DOCTOR_ONLY" | "RECEPTION_ONLY" | "PRIVATE";

interface RemarkAuthor {
  id: string;
  name: string;
  role: string;
}

interface Remark {
  id: string;
  appointmentId: string;
  authorUserId: string;
  parentRemarkId: string | null;
  body: string;
  visibility: Visibility;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  author?: RemarkAuthor | null;
}

interface Props {
  appointmentId: string;
  patientName?: string;
  onClose: () => void;
}

const VISIBILITY_LABEL: Record<Visibility, string> = {
  ALL_STAFF: "All staff",
  DOCTOR_ONLY: "Doctors only",
  RECEPTION_ONLY: "Reception only",
  PRIVATE: "Only me",
};

const VISIBILITY_ICON: Record<Visibility, React.ComponentType<{ size?: number; className?: string }>> = {
  ALL_STAFF: Globe2,
  DOCTOR_ONLY: Stethoscope,
  RECEPTION_ONLY: UserCheck,
  PRIVATE: Lock,
};

// Human-readable, colour-coded author-role badges (raw enums like "LAB_TECH"
// read poorly in the thread). Unknown roles fall back to Title Case + grey.
const ROLE_LABEL: Record<string, string> = {
  DOCTOR: "Doctor",
  ADMIN: "Admin",
  SUPER_ADMIN: "Super Admin",
  RECEPTION: "Reception",
  NURSE: "Nurse",
  PHARMACIST: "Pharmacist",
  LAB_TECH: "Lab Tech",
  PATIENT: "Patient",
};
const ROLE_BADGE: Record<string, string> = {
  DOCTOR: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  ADMIN: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  SUPER_ADMIN: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  RECEPTION: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  NURSE: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  PHARMACIST: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  LAB_TECH: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
};
function roleLabel(role: string): string {
  return (
    ROLE_LABEL[role] ??
    role
      .split("_")
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(" ")
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function AppointmentRemarksModal({ appointmentId, patientName, onClose }: Props) {
  const { user } = useAuthStore();
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("ALL_STAFF");
  const [replyingTo, setReplyingTo] = useState<Remark | null>(null);
  const [editing, setEditing] = useState<Remark | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isStaff = !!user?.role && user.role !== "PATIENT";
  const isDoctorOrAdmin =
    user?.role === "DOCTOR" || user?.role === "ADMIN";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Remark[] }>(
        `/appointments/${appointmentId}/remarks`,
      );
      setRemarks(res.data ?? []);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to load remarks");
    } finally {
      setLoading(false);
    }
  }, [appointmentId]);

  // Fetch exactly once per appointment. The ref guard neutralises React
  // StrictMode's deliberate double-invocation of effects in development (which
  // otherwise fires the GET /remarks request twice for a single open) while
  // still re-fetching if the modal is reused for a different appointmentId.
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedForRef.current === appointmentId) return;
    loadedForRef.current = appointmentId;
    void load();
  }, [appointmentId, load]);

  const handleSubmit = async () => {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    try {
      if (editing) {
        await api.patch(
          `/appointments/${appointmentId}/remarks/${editing.id}`,
          { body: body.trim() },
        );
        toast.success("Remark updated");
      } else {
        await api.post(`/appointments/${appointmentId}/remarks`, {
          body: body.trim(),
          // Reply: server inherits parent visibility; we still send for clarity.
          visibility: replyingTo ? replyingTo.visibility : visibility,
          parentRemarkId: replyingTo?.id ?? null,
        });
        toast.success(replyingTo ? "Reply posted" : "Remark added");
      }
      setBody("");
      setReplyingTo(null);
      setEditing(null);
      void load();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save remark");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePin = async (remark: Remark) => {
    try {
      await api.patch(
        `/appointments/${appointmentId}/remarks/${remark.id}/pin`,
        { isPinned: !remark.isPinned },
      );
      toast.success(remark.isPinned ? "Unpinned" : "Pinned");
      void load();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to pin");
    }
  };

  const handleDelete = async (remark: Remark) => {
    if (!confirm("Delete this remark? This cannot be undone.")) return;
    try {
      await api.delete(`/appointments/${appointmentId}/remarks/${remark.id}`);
      toast.success("Remark deleted");
      void load();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to delete");
    }
  };

  const handleEdit = (remark: Remark) => {
    setEditing(remark);
    setReplyingTo(null);
    setBody(remark.body);
  };

  const handleReply = (remark: Remark) => {
    setReplyingTo(remark);
    setEditing(null);
    setBody("");
  };

  const cancelCompose = () => {
    setReplyingTo(null);
    setEditing(null);
    setBody("");
  };

  // Group replies under their parent for indented rendering.
  const grouped = useMemo(() => {
    const tops = remarks.filter((r) => !r.parentRemarkId);
    const childrenOf = (id: string) =>
      remarks
        .filter((r) => r.parentRemarkId === id)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return tops.map((t) => ({ remark: t, replies: childrenOf(t.id) }));
  }, [remarks]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="Appointment remarks"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-800 flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Remarks
            </h2>
            {patientName && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {patientName}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close remarks"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : grouped.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 italic">
              No remarks yet. Add the first one below.
            </p>
          ) : (
            <ul className="space-y-3">
              {grouped.map(({ remark, replies }) => (
                <RemarkCard
                  key={remark.id}
                  remark={remark}
                  replies={replies}
                  callerUserId={user?.id ?? ""}
                  callerRole={user?.role ?? ""}
                  isDoctorOrAdmin={isDoctorOrAdmin}
                  onPin={() => handlePin(remark)}
                  onDelete={() => handleDelete(remark)}
                  onEdit={() => handleEdit(remark)}
                  onReply={() => handleReply(remark)}
                  onDeleteReply={(r) => handleDelete(r)}
                  onEditReply={(r) => handleEdit(r)}
                />
              ))}
            </ul>
          )}
        </div>

        {isStaff && (
          <div className="border-t border-gray-200 bg-gray-50 px-5 py-3 dark:border-gray-700 dark:bg-gray-900/50">
            {(replyingTo || editing) && (
              <div className="mb-2 flex items-center justify-between rounded bg-blue-50 px-3 py-1.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                <span>
                  {editing ? "Editing remark" : `Replying to ${replyingTo?.author?.name ?? "remark"}`}
                  {replyingTo && (
                    <>
                      {" · visibility inherited: "}
                      <strong>{VISIBILITY_LABEL[replyingTo.visibility]}</strong>
                    </>
                  )}
                </span>
                <button
                  onClick={cancelCompose}
                  className="ml-2 underline hover:no-underline"
                >
                  Cancel
                </button>
              </div>
            )}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Add a remark…"
              rows={3}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              maxLength={5000}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              {!replyingTo && !editing ? (
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as Visibility)}
                  className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  aria-label="Visibility"
                >
                  {(Object.keys(VISIBILITY_LABEL) as Visibility[]).map((v) => (
                    <option key={v} value={v}>
                      {VISIBILITY_LABEL[v]}
                    </option>
                  ))}
                </select>
              ) : (
                <div />
              )}
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Close
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!body.trim() || submitting}
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {editing ? "Save" : replyingTo ? "Post reply" : "Post"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  remark: Remark;
  replies: Remark[];
  callerUserId: string;
  callerRole: string;
  isDoctorOrAdmin: boolean;
  onPin: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onReply: () => void;
  onDeleteReply: (r: Remark) => void;
  onEditReply: (r: Remark) => void;
}

function RemarkCard(props: CardProps) {
  const {
    remark,
    replies,
    callerUserId,
    callerRole,
    isDoctorOrAdmin,
    onPin,
    onDelete,
    onEdit,
    onReply,
    onDeleteReply,
    onEditReply,
  } = props;
  const VIcon = VISIBILITY_ICON[remark.visibility];

  return (
    <li className="rounded border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <RemarkRow
        remark={remark}
        showPin
        showReply
        callerUserId={callerUserId}
        callerRole={callerRole}
        isDoctorOrAdmin={isDoctorOrAdmin}
        onPin={onPin}
        onDelete={onDelete}
        onEdit={onEdit}
        onReply={onReply}
        VIcon={VIcon}
      />
      {replies.length > 0 && (
        <ul className="mt-2 ml-6 space-y-2 border-l-2 border-gray-200 pl-3 dark:border-gray-700">
          {replies.map((r) => (
            <li key={r.id}>
              <RemarkRow
                remark={r}
                callerUserId={callerUserId}
                callerRole={callerRole}
                isDoctorOrAdmin={isDoctorOrAdmin}
                onDelete={() => onDeleteReply(r)}
                onEdit={() => onEditReply(r)}
                VIcon={VISIBILITY_ICON[r.visibility]}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface RowProps {
  remark: Remark;
  showPin?: boolean;
  showReply?: boolean;
  callerUserId: string;
  callerRole: string;
  isDoctorOrAdmin: boolean;
  onPin?: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onReply?: () => void;
  VIcon: React.ComponentType<{ size?: number; className?: string }>;
}

function RemarkRow({
  remark,
  showPin,
  showReply,
  callerUserId,
  callerRole,
  isDoctorOrAdmin,
  onPin,
  onDelete,
  onEdit,
  onReply,
  VIcon,
}: RowProps) {
  const isAuthor = remark.authorUserId === callerUserId;
  const isAdmin = callerRole === "ADMIN";
  return (
    <div className="text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {remark.author?.name ?? "Unknown"}
            </span>
            {remark.author?.role && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  ROLE_BADGE[remark.author.role] ??
                  "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                }`}
              >
                {roleLabel(remark.author.role)}
              </span>
            )}
            <span
              className="text-xs text-gray-400 dark:text-gray-500"
              title={new Date(remark.createdAt).toLocaleString()}
            >
              {formatRelative(remark.createdAt)}
            </span>
            {remark.editedAt && (
              <span className="text-xs italic text-gray-400 dark:text-gray-500">
                edited
              </span>
            )}
            {remark.isPinned && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                <Pin size={10} /> Pinned
              </span>
            )}
            <span
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-700/60 dark:text-gray-400"
              title={VISIBILITY_LABEL[remark.visibility]}
            >
              <VIcon size={10} />
              {VISIBILITY_LABEL[remark.visibility]}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-100">
            {remark.body}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {showPin && onPin && isDoctorOrAdmin && (
            <button
              onClick={onPin}
              aria-label={remark.isPinned ? "Unpin remark" : "Pin remark"}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-amber-600 dark:hover:bg-gray-700"
            >
              <Pin size={14} />
            </button>
          )}
          {showReply && onReply && (
            <button
              onClick={onReply}
              aria-label="Reply"
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700"
            >
              <Reply size={14} />
            </button>
          )}
          {isAuthor && (
            <button
              onClick={onEdit}
              aria-label="Edit remark"
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700"
            >
              <Pencil size={14} />
            </button>
          )}
          {(isAuthor || isAdmin) && (
            <button
              onClick={onDelete}
              aria-label="Delete remark"
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
