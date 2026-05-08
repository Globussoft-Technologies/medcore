// Unit tests for the cross-tab auth-broadcast helper.
// Covers:
//   - BroadcastChannel path: post + subscribe round-trip across two
//     channel instances on the same name.
//   - localStorage fallback path: simulated by deleting the global
//     BroadcastChannel before module import; subscribers receive
//     payloads via dispatched StorageEvents.
//   - Self-message suppression by tabId.
//   - Reset hook tears down listeners cleanly.
//
// jsdom note: BroadcastChannel is shipped in modern jsdom, so the
// happy path uses the real implementation. The fallback path
// stubs `globalThis.BroadcastChannel` to undefined before importing
// the module so its branch selector picks the storage path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("auth-broadcast (BroadcastChannel path)", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    const mod = await import("../auth-broadcast");
    mod.__resetAuthBroadcastForTests();
  });

  it("delivers auth-changed messages across two BroadcastChannel listeners", async () => {
    // We test against a SECOND, raw BroadcastChannel for the same name,
    // because the module's own channel doesn't echo posts back to the
    // sending instance (per spec). This sibling channel simulates what
    // a different tab would observe.
    const received: unknown[] = [];
    const sibling = new BroadcastChannel("medcore-auth");
    sibling.addEventListener("message", (e: MessageEvent) => {
      received.push(e.data);
    });

    const mod = await import("../auth-broadcast");
    mod.broadcastAuthChanged("user-123", "DOCTOR");

    // Microtask + macrotask flush — BroadcastChannel delivery is async.
    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(1);
    const msg = received[0] as Record<string, unknown>;
    expect(msg.kind).toBe("auth-changed");
    expect(msg.userId).toBe("user-123");
    expect(msg.role).toBe("DOCTOR");
    expect(typeof msg.ts).toBe("number");
    expect(typeof msg.tabId).toBe("string");

    sibling.close();
  });

  it("delivers auth-cleared messages with a tabId tag", async () => {
    const received: unknown[] = [];
    const sibling = new BroadcastChannel("medcore-auth");
    sibling.addEventListener("message", (e: MessageEvent) => {
      received.push(e.data);
    });

    const mod = await import("../auth-broadcast");
    mod.broadcastAuthCleared();
    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(1);
    const msg = received[0] as Record<string, unknown>;
    expect(msg.kind).toBe("auth-cleared");
    expect(msg.tabId).toBe(mod.getTabId());

    sibling.close();
  });

  it("does not echo a tab's own broadcasts back to its own subscribers", async () => {
    const mod = await import("../auth-broadcast");
    const seen: unknown[] = [];
    const unsub = mod.onAuthBroadcast((m) => seen.push(m));
    mod.broadcastAuthChanged("u-self", "ADMIN");
    await new Promise((r) => setTimeout(r, 10));
    // BroadcastChannel never delivers self-posts; the subscriber should
    // see nothing.
    expect(seen.length).toBe(0);
    unsub();
  });

  it("subscribers added via onAuthBroadcast receive cross-channel messages", async () => {
    const mod = await import("../auth-broadcast");
    const seen: unknown[] = [];
    const unsub = mod.onAuthBroadcast((m) => seen.push(m));

    // Simulate "another tab" posting through a fresh raw channel.
    const otherTab = new BroadcastChannel("medcore-auth");
    otherTab.postMessage({
      kind: "auth-changed",
      userId: "u-other",
      role: "PATIENT",
      ts: Date.now(),
      tabId: "fake-other-tab",
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(seen.length).toBe(1);
    const msg = seen[0] as Record<string, unknown>;
    expect(msg.userId).toBe("u-other");
    expect(msg.tabId).toBe("fake-other-tab");

    unsub();
    otherTab.close();
  });

  it("__resetAuthBroadcastForTests detaches listeners", async () => {
    const mod = await import("../auth-broadcast");
    const seen: unknown[] = [];
    mod.onAuthBroadcast((m) => seen.push(m));
    mod.__resetAuthBroadcastForTests();

    // Post from a sibling channel after reset — old listener must not
    // fire because the channel was closed and its listener pool cleared.
    const otherTab = new BroadcastChannel("medcore-auth");
    otherTab.postMessage({
      kind: "auth-cleared",
      ts: Date.now(),
      tabId: "fake-other-tab",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.length).toBe(0);
    otherTab.close();
  });
});

describe("auth-broadcast (localStorage fallback path)", () => {
  // Save/restore the BroadcastChannel global so we don't poison sibling
  // tests in the same suite.
  let originalBC: typeof BroadcastChannel | undefined;

  beforeEach(() => {
    vi.resetModules();
    // Force the fallback branch: hide BroadcastChannel BEFORE the
    // module is loaded (the `isBroadcastChannelAvailable()` check runs
    // at first `getChannel()` call, not at import time, but wiping it
    // here ensures the first call sees no constructor).
    originalBC = (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel })
      .BroadcastChannel;
    delete (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel })
      .BroadcastChannel;
    delete (window as unknown as { BroadcastChannel?: typeof BroadcastChannel })
      .BroadcastChannel;
  });

  afterEach(async () => {
    if (originalBC) {
      (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel })
        .BroadcastChannel = originalBC;
      (window as unknown as { BroadcastChannel: typeof BroadcastChannel })
        .BroadcastChannel = originalBC;
    }
    const mod = await import("../auth-broadcast");
    mod.__resetAuthBroadcastForTests();
  });

  it("posts to localStorage under the fallback key", async () => {
    const mod = await import("../auth-broadcast");
    mod.broadcastAuthChanged("u-fallback", "NURSE");
    // The post is synchronous before the timeout-cleanup runs; assert
    // before we yield so the value hasn't been removed yet.
    const raw = window.localStorage.getItem("medcore_auth_broadcast");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.kind).toBe("auth-changed");
    expect(parsed.userId).toBe("u-fallback");
    expect(parsed.role).toBe("NURSE");
  });

  it("delivers to subscribers via dispatched storage events", async () => {
    const mod = await import("../auth-broadcast");
    const seen: unknown[] = [];
    const unsub = mod.onAuthBroadcast((m) => seen.push(m));

    // Simulate another tab writing to localStorage by dispatching a
    // synthetic StorageEvent. jsdom doesn't auto-fire storage events
    // on same-window writes, so we hand-roll one to mimic the
    // cross-tab path.
    const payload = JSON.stringify({
      kind: "auth-changed",
      userId: "u-other-fallback",
      role: "ADMIN",
      ts: Date.now(),
      tabId: "fake-other-tab-fallback",
    });
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "medcore_auth_broadcast",
        newValue: payload,
        oldValue: null,
        storageArea: window.localStorage,
        url: window.location.href,
      }),
    );

    expect(seen.length).toBe(1);
    const msg = seen[0] as Record<string, unknown>;
    expect(msg.userId).toBe("u-other-fallback");
    expect(msg.role).toBe("ADMIN");
    unsub();
  });

  it("ignores storage events for unrelated keys", async () => {
    const mod = await import("../auth-broadcast");
    const seen: unknown[] = [];
    const unsub = mod.onAuthBroadcast((m) => seen.push(m));

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "some_other_key",
        newValue: "irrelevant",
        oldValue: null,
        storageArea: window.localStorage,
        url: window.location.href,
      }),
    );
    expect(seen.length).toBe(0);
    unsub();
  });

  it("ignores storage events without a parseable payload", async () => {
    const mod = await import("../auth-broadcast");
    const seen: unknown[] = [];
    const unsub = mod.onAuthBroadcast((m) => seen.push(m));

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "medcore_auth_broadcast",
        newValue: "not-json{",
        oldValue: null,
        storageArea: window.localStorage,
        url: window.location.href,
      }),
    );
    expect(seen.length).toBe(0);
    unsub();
  });

  it("filters out a tab's own messages by tabId", async () => {
    const mod = await import("../auth-broadcast");
    const seen: unknown[] = [];
    const unsub = mod.onAuthBroadcast((m) => seen.push(m));

    // Use the same tabId this module instance is using → message
    // should be skipped.
    const ownId = mod.getTabId();
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "medcore_auth_broadcast",
        newValue: JSON.stringify({
          kind: "auth-cleared",
          ts: Date.now(),
          tabId: ownId,
        }),
        oldValue: null,
        storageArea: window.localStorage,
        url: window.location.href,
      }),
    );
    expect(seen.length).toBe(0);
    unsub();
  });
});
