// Cross-tab cookie-swap detection — closes the session-morphing cluster
// (#524 / #538 / #540 / #564 / #567 / #584).
//
// Background: cookies on `medcore.globusdemos.com` are origin-scoped, NOT
// tab-scoped. When a user signs in on a 2nd tab, the new Set-Cookie
// atomically overwrites `medcore_at` / `medcore_rt` / `medcore_csrf`
// origin-wide. The original tab's next /auth/me probe authenticates as
// the NEW user and (without a defence) silently re-hydrates the auth
// store with a different principal — so the original tab's UI starts
// rendering data scoped to a different user.
//
// The post-hydration role-clobber + userId-clobber checks in
// `lib/store.ts:236-265` already catch the mismatch and force a redirect
// to /login, but they only run AFTER the /auth/me response lands. Any
// requests that were in flight at the moment of the cookie swap can
// still leak the new principal's data into the original tab's UI before
// the redirect fires.
//
// This module adds a real-time channel: every login / logout / identity
// change broadcasts a message to all tabs of the same origin via
// BroadcastChannel("medcore-auth"). Subscribed tabs that detect a
// userId mismatch immediately force-rehydrate (re-poll /auth/me; if the
// principal still differs, redirect to /login?reason=cross_tab_session_change).
// This shrinks the leak window from "until the next /auth/me" to "tens
// of milliseconds after the cookie swap".
//
// BroadcastChannel is supported in all evergreen browsers; for older
// targets we fall back to a `localStorage` `storage`-event channel (the
// same key written from one tab fires the event on every OTHER tab in
// the same origin).

const CHANNEL_NAME = "medcore-auth";
const FALLBACK_STORAGE_KEY = "medcore_auth_broadcast";

export type AuthBroadcastMessage =
  | {
      kind: "auth-changed";
      userId: string;
      role: string;
      ts: number;
      // Tagged with a per-tab id so a tab doesn't react to its own
      // outbound message (BroadcastChannel doesn't deliver self-posts,
      // but the localStorage fallback does — same-origin storage events
      // fire on every OTHER window of the origin EXCEPT the one that
      // wrote, but Safari historically had quirks; the tab id makes the
      // self-skip explicit and forward-compatible).
      tabId: string;
    }
  | { kind: "auth-cleared"; ts: number; tabId: string };

// One id per page-load. Used by `postMessage` so the receiver can skip
// echoes of its own broadcasts in any channel where same-origin loop
// delivery isn't perfectly suppressed.
const TAB_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type Listener = (msg: AuthBroadcastMessage) => void;

interface ChannelImpl {
  post: (msg: AuthBroadcastMessage) => void;
  subscribe: (fn: Listener) => () => void;
  close: () => void;
}

function isBroadcastChannelAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { BroadcastChannel?: unknown })
      .BroadcastChannel === "function"
  );
}

function makeBroadcastChannelImpl(): ChannelImpl {
  // Type-check passed in `isBroadcastChannelAvailable()`; cast is safe.
  const Ctor = (window as unknown as { BroadcastChannel: typeof BroadcastChannel })
    .BroadcastChannel;
  const ch = new Ctor(CHANNEL_NAME);
  const listeners = new Set<Listener>();
  const onMessage = (event: MessageEvent) => {
    const data = event.data as AuthBroadcastMessage | undefined;
    if (!data || typeof data !== "object" || !("kind" in data)) return;
    // BroadcastChannel doesn't deliver to the sender, so this is a
    // belt-and-braces guard for any future bridging.
    if ("tabId" in data && data.tabId === TAB_ID) return;
    listeners.forEach((fn) => {
      try {
        fn(data);
      } catch {
        // Listener errors must not break siblings.
      }
    });
  };
  ch.addEventListener("message", onMessage);
  return {
    post: (msg) => {
      try {
        ch.postMessage(msg);
      } catch {
        // Channel may be closed under tear-down; best-effort.
      }
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    close: () => {
      try {
        ch.removeEventListener("message", onMessage);
        ch.close();
      } catch {
        /* ignore */
      }
      listeners.clear();
    },
  };
}

function makeStorageFallbackImpl(): ChannelImpl {
  // localStorage `storage` events fire on every OTHER window of the
  // origin when the key changes. We write a JSON-serialised message
  // under a fixed key; receivers parse it from the event payload.
  const listeners = new Set<Listener>();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== FALLBACK_STORAGE_KEY) return;
    if (!event.newValue) return; // null on remove — ignore.
    let data: AuthBroadcastMessage | null = null;
    try {
      data = JSON.parse(event.newValue) as AuthBroadcastMessage;
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || !("kind" in data)) return;
    if ("tabId" in data && data.tabId === TAB_ID) return;
    listeners.forEach((fn) => {
      try {
        fn(data);
      } catch {
        /* ignore */
      }
    });
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return {
    post: (msg) => {
      try {
        // Use a unique payload each time (the timestamp is already
        // monotonically advancing, but identical posts within the same
        // millisecond would otherwise be deduped by the browser — write
        // a marker first to force a change, then the real value).
        const payload = JSON.stringify(msg);
        localStorage.setItem(FALLBACK_STORAGE_KEY, payload);
        // Clean up the key shortly after so it doesn't accumulate stale
        // auth events in storage. Receivers have already parsed the
        // value from the event payload by the time this runs.
        setTimeout(() => {
          try {
            const cur = localStorage.getItem(FALLBACK_STORAGE_KEY);
            if (cur === payload) {
              localStorage.removeItem(FALLBACK_STORAGE_KEY);
            }
          } catch {
            /* ignore */
          }
        }, 0);
      } catch {
        // localStorage may be unavailable in private mode — best-effort.
      }
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    close: () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
      }
      listeners.clear();
    },
  };
}

let channelSingleton: ChannelImpl | null = null;

function getChannel(): ChannelImpl | null {
  if (typeof window === "undefined") return null; // SSR no-op.
  if (channelSingleton) return channelSingleton;
  channelSingleton = isBroadcastChannelAvailable()
    ? makeBroadcastChannelImpl()
    : makeStorageFallbackImpl();
  return channelSingleton;
}

/**
 * Post a message that the local user just logged in or had their identity
 * change (e.g. role swap from 2FA-completion). All other tabs of the
 * same origin will hear it and force-rehydrate if their cached userId
 * doesn't match.
 */
export function broadcastAuthChanged(userId: string, role: string): void {
  const ch = getChannel();
  if (!ch) return;
  ch.post({
    kind: "auth-changed",
    userId,
    role,
    ts: Date.now(),
    tabId: TAB_ID,
  });
}

/** Post a message that the local user just signed out. */
export function broadcastAuthCleared(): void {
  const ch = getChannel();
  if (!ch) return;
  ch.post({ kind: "auth-cleared", ts: Date.now(), tabId: TAB_ID });
}

/**
 * Subscribe to auth-broadcast events from OTHER tabs of the same origin.
 * Returns an unsubscribe function.
 */
export function onAuthBroadcast(fn: Listener): () => void {
  const ch = getChannel();
  if (!ch) return () => undefined;
  return ch.subscribe(fn);
}

/** This tab's per-page-load id. Exposed for tests + downstream filters. */
export function getTabId(): string {
  return TAB_ID;
}

/**
 * Test-only: tear down the singleton channel so each test starts with a
 * fresh one. Avoids cross-test listener leakage under
 * `vitest --pool=threads` where the same module instance is shared.
 */
export function __resetAuthBroadcastForTests(): void {
  if (channelSingleton) {
    channelSingleton.close();
    channelSingleton = null;
  }
}
