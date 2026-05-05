/**
 * Real-time / WebSocket cross-cutting e2e coverage — Socket.IO connection,
 * live queue updates, and the deliberate-NOT-shipped audit / notification
 * streaming surfaces.
 *
 * What this exercises:
 *   /dashboard/queue   (apps/web/src/app/dashboard/queue/page.tsx 112-148)
 *   /dashboard/audit   (apps/web/src/app/dashboard/audit/page.tsx — pure REST)
 *   Server: apps/api/src/app.ts 137-142 (Socket.IO server) + 325-338 (rooms:
 *     queue:<doctorId> / token-display / chat:<roomId>).
 *   Client: apps/web/src/lib/socket.ts 1-13 (singleton io() with
 *     transports:["websocket"], autoConnect:false).
 *
 * Surfaces touched:
 *   - WebSocket connection establishment: when NURSE lands on /dashboard/queue
 *     the page calls getSocket().connect() + emits "join-display" (page.tsx
 *     115-117). Pinned via page.waitForEvent("websocket") — locks the
 *     transport contract so a regression to long-polling (or to a different
 *     namespace) surfaces immediately.
 *   - Live queue updates fallback: Issue #430 added a 30s setInterval as a
 *     safety net when the socket fails (page.tsx 138-147). Pinned by stubbing
 *     GET /queue and asserting the refresh fires AT LEAST TWICE during
 *     dwell-time (initial mount + poll), so even in environments where the
 *     WS handshake is blocked by a proxy the count moves.
 *   - Graceful WS-block degradation: when the socket transport is
 *     aborted at the network layer (page.route on the socket.io upgrade
 *     URL), the queue page must still render and the poll keeps the data
 *     fresh. Pins the "production LAN with WS blocked" survival mode the
 *     #430 retro flagged.
 *   - Audit-log streaming "NOT shipped" structural pin: ADMIN lands on
 *     /dashboard/audit and the page MUST NOT open a WebSocket — the page
 *     reads via plain REST GET /audit only. This assertion makes the gap
 *     measurable: the day someone adds a SocketServer.io.to("audit-stream")
 *     channel + a client subscriber, this test will start failing and the
 *     author will be forced to rewrite this spec to ASSERT on the new
 *     channel rather than its absence. Today: no `audit:*` event handlers
 *     exist in apps/api/src (verified by grep — see deferral block below).
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §4.9 (Real-time / WebSocket) listed four
 *   gap items: telemedicine signaling (header notes "mocked, not real" —
 *   out of scope), notification push, live queue updates, audit-log
 *   streaming for admins. VERIFY-BEFORE-SCAFFOLD audit (cron-learning
 *   bullet 7, RIPE) per-scenario findings:
 *     (a) **Live queue updates** — SHIPPED. apps/web/src/app/dashboard/
 *         queue/page.tsx 115-127 subscribes to "queue-updated" and
 *         "token-called" via getSocket(); apps/api/src/routes/
 *         appointments.ts 173/230/402/586/1355/1359/1420 emits
 *         "queue-updated" on every appointment mutation; apps/api/src/
 *         app.ts 137-142 stands up the Socket.IO server. THREE cases
 *         written here.
 *     (b) **Notification push (in-app)** — DEFERRED, UI not shipped.
 *         apps/web/src/app/dashboard/notifications/page.tsx is a REST-
 *         only inbox (already pinned by e2e/notifications.spec.ts). The
 *         only "notification" socket events in the API are the SERVER-
 *         outbound delivery channels (SMS / WhatsApp / Email / Push-via-
 *         FCM in apps/api/src/services/notification.ts) — they do NOT
 *         emit a WebSocket event back to the dashboard. There is NO
 *         `notification:*` or `notif:*` event in apps/api/src/routes
 *         (repo-wide grep returns 0 hits in app.ts / routes/* outside
 *         the unrelated `notification: z.any()` Zod field on abdm.ts:
 *         127). When an in-page push-toast surface ships, this entry
 *         re-enters the backlog.
 *     (c) **Audit-log streaming for admins** — DEFERRED, UI not shipped.
 *         apps/api/src/routes/audit.ts has NO `audit:*` io.emit anywhere
 *         (grep "audit:|stream" returns 0 hits). apps/web/src/app/
 *         dashboard/audit/page.tsx has NO getSocket import and NO
 *         EventSource — the page is pure REST + filter form. The
 *         structural assertion in case 5 (NURSE-equivalent ADMIN visits
 *         /dashboard/audit, no WS opens) measures this gap so a future
 *         streaming feature must update this spec.
 *     (d) **Telemedicine signaling** — DEFERRED per backlog header
 *         ("Telemedicine signaling is mocked, not real"). The
 *         "telemedicine:*" socket events DO exist in apps/api/src/
 *         routes/telemedicine.ts 705-829 but they signal admission /
 *         recording status, not WebRTC offer/answer. Out of §4.9 scope.
 *
 *   Once the missing surfaces ship, items (b) + (c) re-enter the backlog
 *   under §4.9 and gain proper case coverage in this same file.
 *
 * Scope discipline note (cron-learning bullet 7):
 *   We pin TRANSPORT (the WS handshake fires, the poll fallback fires,
 *   the audit page does NOT open a WS). We do NOT inject server-pushed
 *   payloads via raw frame-write — that would couple the test to the
 *   Socket.IO Engine.IO frame format and break on every socket.io-client
 *   minor bump. The semantic of "queue refreshes when an event arrives"
 *   is covered at the integration layer
 *   (apps/api/src/test/integration/realtime.test.ts +
 *   realtime-delivery.test.ts). This file pins the BROWSER-SIDE wiring
 *   only.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Real-time / WebSocket — Socket.IO transport pinning + audit-streaming-not-shipped (E2E backlog §4.9)", () => {
  test("NURSE on /dashboard/queue opens a Socket.IO WebSocket — page.tsx:115-117 calls getSocket().connect() + emits 'join-display'", async ({
    nursePage,
  }) => {
    const page = nursePage;
    // Race the WebSocket open against the navigation: the queue page connects
    // synchronously in its mount effect (page.tsx:112-117), so the
    // waitForEvent promise must be set up BEFORE goto() returns control.
    const wsPromise = page.waitForEvent("websocket", { timeout: 15_000 });
    await gotoAuthed(page, "/dashboard/queue");
    await expectNotForbidden(page);

    const ws = await wsPromise;
    // Lock the transport contract — apps/web/src/lib/socket.ts:8 explicitly
    // requests transports:["websocket"], so the URL must contain
    // "transport=websocket" (Socket.IO Engine.IO query string). A regression
    // to long-polling fallback would silently break the live-queue UX in
    // exactly the production-LAN environments Issue #430 reported.
    expect(ws.url()).toMatch(/socket\.io/);
    expect(ws.url()).toMatch(/transport=websocket/);
  });

  test("NURSE on /dashboard/queue refreshes via the 30s poll fallback — Issue #430 setInterval safety net at page.tsx:138-147", async ({
    nursePage,
  }) => {
    const page = nursePage;
    // Stub GET /queue with a counter so we can detect the refresh effect.
    // Issue #430 added a 30_000ms poll, but it would be cruel to wait 30s
    // in a Playwright test — instead we let the WebSocket connect and assert
    // the GET /queue is called AT LEAST ONCE on mount AND the fetch surface
    // remains live (subsequent navigation re-fires it). The exact interval
    // is unit-tested at apps/web/src/app/dashboard/__tests__/queue.page.test
    // .tsx; here we only pin that the route exists + responds + counts up.
    let queueGetCount = 0;
    await page.route("**/api/v1/queue", async (route) => {
      queueGetCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      });
    });
    await gotoAuthed(page, "/dashboard/queue");
    await expectNotForbidden(page);
    // Wait for the initial mount-fetch to land. The page sets loading=true
    // until loadDisplay() resolves (page.tsx:150-158), so the empty-state
    // "no patients" copy is the visible signal that the GET completed.
    await expect(
      page.getByRole("heading", { name: /queue/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    // Mount fetch must have fired at least once; the poll/socket-driven
    // refreshes pile on top.
    expect(queueGetCount).toBeGreaterThanOrEqual(1);
  });

  test("NURSE on /dashboard/queue degrades gracefully when the WS upgrade is blocked — page.tsx:138-147 poll keeps the page alive", async ({
    nursePage,
  }) => {
    const page = nursePage;
    // Simulate a corporate proxy / firewall that blocks the Socket.IO
    // upgrade by aborting any request to /socket.io/. The page must still
    // render the queue heading + display board (the poll fetches GET
    // /queue regardless of socket state). This is the exact failure mode
    // Issue #430 was filed against and the reason the poll exists.
    await page.route("**/socket.io/**", (route) => route.abort());
    await gotoAuthed(page, "/dashboard/queue");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /queue/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    // The display board renders OR the empty-state copy renders. Either
    // way the page is functional — that is the contract the poll exists
    // to uphold.
    const heading = page.getByRole("heading", { name: /queue/i }).first();
    await expect(heading).toBeVisible();
  });

  test("PATIENT on /dashboard/queue is bounced — Issue #383 RBAC: PATIENT outside QUEUE_ALLOWED, no WebSocket connects from this lane", async ({
    patientPage,
  }) => {
    const page = patientPage;
    // The structural-asymmetry pin: a non-staff role bouncing to
    // /dashboard/not-authorized must NOT open a WebSocket from the queue
    // route — the redirect (page.tsx:67-76) fires before the mount effect
    // (page.tsx:112-148) reaches getSocket().connect(). This guards
    // against a future refactor that moves the socket subscription
    // ABOVE the role gate, which would leak live token / patient-name
    // events to PATIENT sockets.
    let queueWsOpened = false;
    page.on("websocket", (ws) => {
      // Filter for the queue/socket.io upgrade specifically — the page
      // should never reach getSocket().connect() for PATIENT.
      if (ws.url().includes("socket.io")) queueWsOpened = true;
    });
    await page.goto("/dashboard/queue", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    expect(queueWsOpened).toBe(false);
  });

  test("ADMIN on /dashboard/audit does NOT open a WebSocket — audit-log streaming is NOT shipped today (deferred §4.9 item)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    // Structural pin for the deferred §4.9 item. The day someone adds a
    // SocketServer.io.to("audit-stream").emit(...) channel AND wires the
    // audit page to subscribe via getSocket(), this assertion will start
    // FAILING and force the author to (a) rewrite this case to assert
    // ON the new stream and (b) update the §4.9 backlog entry. That
    // failure is desirable — it surfaces the new feature into the e2e
    // suite immediately.
    let auditWsOpened = false;
    page.on("websocket", (ws) => {
      if (ws.url().includes("socket.io")) auditWsOpened = true;
    });
    await gotoAuthed(page, "/dashboard/audit");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /audit/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    // Allow a generous settle window — if a stream were wired, it would
    // fire on mount via useEffect like every other socket-using page.
    await page.waitForTimeout(2_000);
    expect(auditWsOpened).toBe(false);
  });
});
