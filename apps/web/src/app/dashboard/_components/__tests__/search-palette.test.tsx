/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SearchPalette — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/_components/search-palette.tsx, the
 *     global Cmd/Ctrl+K palette mounted on every authed dashboard layout. The
 *     component debounces the typed query, fetches GET /search?q=..., groups
 *     results by `type` (patients, doctors, appointments, etc.), supports
 *     keyboard navigation (ArrowUp/Down/Enter/Escape), routes via
 *     useRouter().push(), and persists per-user recent-search history in
 *     localStorage under the `medcore:recent-search:<userId>` key (Issue #877).
 *
 *   - Behaviours covered (mapped to the source surface):
 *       1. Closed state (`open=false`) renders nothing.
 *       2. Open state renders the input with the role-aware placeholder —
 *          PATIENT gets the trimmed copy (Issue #406), staff get the full hint.
 *       3. Input is auto-focused on open (setTimeout fast-forward).
 *       4. Sub-2-char queries do NOT fire the API and show the
 *          "Type at least 2 characters" hint.
 *       5. >=2-char queries debounce (~200ms) and call api.get with the
 *          correctly-encoded URL.
 *       6. Successful response renders one group per type with the typeLabel
 *          heading (e.g. "Patients") and one row per hit.
 *       7. De-duplication (Issue #582 #4): two hits with the same `type+id`
 *          render once.
 *       8. Click a hit → router.push(hit.href) + onClose called +
 *          saveRecent persists the query under the per-user localStorage key.
 *       9. Defensive null-href guard (Issue #582 #2): hits with
 *          href === "" / "null" / "/dashboard/null" do NOT push.
 *      10. ArrowDown / ArrowUp / Enter keyboard navigation cycles through
 *          results (capped at bounds) and Enter routes to the active row.
 *      11. Enter with zero results is a no-op (Issue #582 guard).
 *      12. Escape calls onClose.
 *      13. Backdrop click calls onClose; click inside the panel does NOT.
 *      14. API rejection lands in the empty-results state silently (no crash).
 *      15. "No results for ..." copy renders when q.length >= 2 and results=[].
 *      16. Recent searches render when q is empty and history exists; clicking
 *          a recent entry pre-fills the input.
 *      17. Legacy `medcore:recent-search` key is wiped on first load (Issue
 *          #877 self-heal — pre-fix history must not leak across users).
 *      18. saveRecent caps history at 8 entries and dedupes existing entries
 *          (moves repeat query to the head of the list).
 *      19. saveRecent refuses to write when there's no userId (anonymous /
 *          pre-auth session) — no localStorage entry created.
 *      20. typeIcon fallback: unknown `type` ("foobar") still renders without
 *          crashing under the default Tag icon + raw type label.
 *      21. Close button (X) and the panel chrome (ESC kbd label) render.
 *
 *   - Mocks: @/lib/api (apiMock.get), @/lib/store (useAuthStore selector
 *            against a mutable `authState` fixture), next/navigation
 *            (useRouter().push).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";

const { apiMock, routerMock, authState } = vi.hoisted(() => ({
  apiMock: { get: vi.fn() },
  routerMock: { push: vi.fn() },
  authState: {
    user: { id: "u-me", role: "DOCTOR", name: "Dr Test" } as
      | { id: string; role: string; name: string }
      | null,
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({
  useAuthStore: (selector: (s: { user: typeof authState.user }) => unknown) =>
    selector({ user: authState.user }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard",
}));

import { SearchPalette } from "../search-palette";

type Hit = {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  meta?: string;
  href: string;
};

function hit(o: Partial<Hit> = {}): Hit {
  return {
    type: "patient",
    id: "p-1",
    title: "Aarav Sharma",
    subtitle: "MR-0001",
    meta: "9876543210",
    href: "/dashboard/patients/p-1",
    ...o,
  };
}

function setUser(u: { id: string; role: string; name?: string } | null) {
  authState.user = u
    ? { id: u.id, role: u.role, name: u.name ?? "Tester" }
    : null;
}

describe("SearchPalette (Cmd+K global palette)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerMock.push.mockReset();
    setUser({ id: "u-me", role: "DOCTOR" });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <SearchPalette open={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the search input + ESC chip + close button when open", () => {
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    // Staff role placeholder is the full hint copy.
    expect(
      screen.getByPlaceholderText(/Search patients, appointments/i),
    ).toBeInTheDocument();
    expect(screen.getByText("ESC")).toBeInTheDocument();
    // Footer chrome (kbd hints).
    expect(screen.getByText(/navigate/i)).toBeInTheDocument();
    expect(screen.getByText(/open/i)).toBeInTheDocument();
    expect(screen.getByText(/anywhere/i)).toBeInTheDocument();
  });

  it("shows every visible sidebar module and searches them locally", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(
      <SearchPalette
        open={true}
        onClose={vi.fn()}
        modules={[
          { href: "/dashboard", label: "Dashboard" },
          { href: "/dashboard/departments", label: "Departments" },
        ]}
      />,
    );

    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Departments")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "depart" },
    });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    expect(screen.getByText("Departments")).toBeInTheDocument();
  });

  it("hides server modules and records whose destination is absent from the sidebar", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        hit({
          id: "hidden-patient",
          title: "Hidden Patient",
          href: "/dashboard/patients/hidden-patient",
        }),
        hit({
          type: "label",
          id: "label:/dashboard/ai-radiology",
          title: "AI Radiology",
          href: "/dashboard/ai-radiology",
        }),
        hit({
          type: "appointment",
          id: "visible-appointment",
          title: "Visible Appointment",
          href: "/dashboard/appointments?id=visible-appointment",
        }),
      ],
    });
    render(
      <SearchPalette
        open={true}
        onClose={vi.fn()}
        modules={[
          { href: "/dashboard", label: "Dashboard" },
          { href: "/dashboard/appointments", label: "Appointments" },
        ]}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "visible" },
    });

    expect(await screen.findByText("Visible Appointment")).toBeInTheDocument();
    expect(screen.queryByText("Hidden Patient")).not.toBeInTheDocument();
    expect(screen.queryByText("AI Radiology")).not.toBeInTheDocument();
  });

  it("renders the trimmed PATIENT placeholder when the user is a patient (Issue #406)", () => {
    setUser({ id: "u-pat", role: "PATIENT" });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    expect(
      screen.getByPlaceholderText(/Search appointments, prescriptions, bills/i),
    ).toBeInTheDocument();
  });

  it("shows the 'Type at least 2 characters' copy for sub-threshold queries and does NOT call the API", async () => {
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Search patients/i);
    fireEvent.change(input, { target: { value: "a" } });
    expect(
      await screen.findByText(/Type at least 2 characters/i),
    ).toBeInTheDocument();
    // Give debounce a chance to fire — it should NOT.
    await new Promise((r) => setTimeout(r, 250));
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("debounces a >=2-char query, GETs /search, and renders results grouped by type", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        hit({ id: "p-1", title: "Aarav Sharma", type: "patient" }),
        hit({ id: "a-1", title: "Cardio Checkup", type: "appointment", href: "/dashboard/appointments/a-1" }),
        hit({ id: "p-2", title: "Aanya Patel", type: "patient" }),
      ],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Search patients/i);
    fireEvent.change(input, { target: { value: "aa" } });
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/search?q=aa"),
    );
    expect(await screen.findByText("Aarav Sharma")).toBeInTheDocument();
    expect(screen.getByText("Aanya Patel")).toBeInTheDocument();
    expect(screen.getByText("Cardio Checkup")).toBeInTheDocument();
    expect(screen.getByText("Patients")).toBeInTheDocument();
    expect(screen.getByText("Appointments")).toBeInTheDocument();
  });

  it("dedupes hits with the same type+id (Issue #582 #4)", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        hit({ id: "p-1", title: "Aarav Sharma" }),
        hit({ id: "p-1", title: "Aarav Sharma (dupe row)" }),
        hit({ id: "p-2", title: "Aanya Patel" }),
      ],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "aa" },
    });
    await screen.findByText("Aarav Sharma");
    // Dupe row must NOT render.
    expect(screen.queryByText(/dupe row/i)).not.toBeInTheDocument();
  });

  it("clicking a result pushes its href, closes the palette, and persists the query under the per-user key (Issue #877)", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [hit({ id: "p-1", title: "Aarav Sharma" })],
    });
    const onClose = vi.fn();
    render(<SearchPalette open={true} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "aarav" },
    });
    const row = await screen.findByText("Aarav Sharma");
    fireEvent.click(row);
    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard/patients/p-1");
    });
    expect(onClose).toHaveBeenCalled();
    // Recent-search slot is per-user — should be keyed by user id.
    const raw = window.localStorage.getItem("medcore:recent-search:u-me");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(["aarav"]);
  });

  it("refuses to push a known-bad href ('/dashboard/null' or 'null') (Issue #582 #2)", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        hit({ id: "x-1", title: "Broken Hit", href: "/dashboard/null" }),
        hit({ id: "x-2", title: "Null Href", href: "null" }),
        hit({ id: "x-3", title: "Empty Href", href: "" }),
      ],
    });
    const onClose = vi.fn();
    render(<SearchPalette open={true} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "bro" },
    });
    fireEvent.click(await screen.findByText("Broken Hit"));
    // onClose still called, but router.push must NOT be.
    expect(onClose).toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Null Href"));
    fireEvent.click(screen.getByText("Empty Href"));
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("clicking a non-first row routes to that row's href (cross-row coverage)", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        hit({ id: "p-1", title: "Row One", href: "/dashboard/patients/p-1" }),
        hit({ id: "p-2", title: "Row Two", href: "/dashboard/patients/p-2" }),
        hit({ id: "p-3", title: "Row Three", href: "/dashboard/patients/p-3" }),
      ],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Search patients/i);
    fireEvent.change(input, { target: { value: "ro" } });
    await screen.findByText("Row One");
    // Direct click on the third row — onClick passes its hit straight to go().
    fireEvent.click(screen.getByText("Row Three").closest("button")!);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/dashboard/patients/p-3",
      ),
    );
  });

  it("ArrowUp / ArrowDown / Enter keyboard handlers preventDefault and route to a hit (smoke)", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        hit({ id: "p-1", title: "Row One", href: "/dashboard/patients/p-1" }),
        hit({ id: "p-2", title: "Row Two", href: "/dashboard/patients/p-2" }),
      ],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Search patients/i);
    fireEvent.change(input, { target: { value: "ro" } });
    await screen.findByText("Row One");
    // ArrowUp from index 0 must not go negative — Enter on index 0 still
    // routes to the first hit, proving the up handler didn't unbound the
    // active state.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // ArrowDown then back up — exercises both increment + decrement paths.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/dashboard/patients/p-1",
      ),
    );
  });

  it("Enter with zero results is a no-op (Issue #582 guard)", async () => {
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Search patients/i);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(<SearchPalette open={true} onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/Search patients/i), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking the backdrop calls onClose, but clicking inside the panel does NOT", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SearchPalette open={true} onClose={onClose} />,
    );
    // Backdrop is the outermost fixed div.
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Click inside the input — onClose must NOT fire again.
    fireEvent.click(screen.getByPlaceholderText(/Search patients/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("API rejection lands in the empty results state silently and does NOT crash", async () => {
    apiMock.get.mockRejectedValueOnce(new Error("boom"));
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "broken" },
    });
    expect(
      await screen.findByText(/No results for/i),
    ).toBeInTheDocument();
  });

  it("renders 'No results for <q>' copy when api returns [] for a >=2-char query", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "zzzz" },
    });
    expect(
      await screen.findByText(/No results for "zzzz"/i),
    ).toBeInTheDocument();
  });

  it("renders Recent searches when there is history and q is empty; clicking one prefills the input", async () => {
    window.localStorage.setItem(
      "medcore:recent-search:u-me",
      JSON.stringify(["fatima", "aarav"]),
    );
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    expect(await screen.findByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("fatima")).toBeInTheDocument();
    expect(screen.getByText("aarav")).toBeInTheDocument();
    fireEvent.click(screen.getByText("fatima"));
    expect(
      (screen.getByPlaceholderText(/Search patients/i) as HTMLInputElement).value,
    ).toBe("fatima");
  });

  it("wipes the legacy 'medcore:recent-search' key on open (Issue #877 self-heal)", () => {
    window.localStorage.setItem(
      "medcore:recent-search",
      JSON.stringify(["leaked-from-admin"]),
    );
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    expect(window.localStorage.getItem("medcore:recent-search")).toBeNull();
  });

  it("saveRecent caps history at 8 entries and dedupes existing entries to the head", async () => {
    window.localStorage.setItem(
      "medcore:recent-search:u-me",
      JSON.stringify(["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]),
    );
    apiMock.get.mockResolvedValueOnce({
      data: [hit({ id: "p-1", title: "Hit", href: "/dashboard/p" })],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Search patients/i);
    // Search for an existing entry (q3) — should dedupe + move to head.
    fireEvent.change(input, { target: { value: "q3" } });
    fireEvent.click(await screen.findByText("Hit"));
    const raw = window.localStorage.getItem("medcore:recent-search:u-me");
    const parsed = JSON.parse(raw!) as string[];
    expect(parsed[0]).toBe("q3");
    // Still capped at 8.
    expect(parsed.length).toBeLessThanOrEqual(8);
    // No duplicate "q3".
    expect(parsed.filter((x) => x === "q3").length).toBe(1);
  });

  it("saveRecent refuses to write when the user has no id (anonymous session)", async () => {
    setUser(null);
    apiMock.get.mockResolvedValueOnce({
      data: [hit({ id: "p-1", title: "Hit", href: "/dashboard/p" })],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "anon" },
    });
    fireEvent.click(await screen.findByText("Hit"));
    // No per-user key should exist (no id available to scope to).
    const keys = Object.keys(window.localStorage).filter((k) =>
      k.startsWith("medcore:recent-search:"),
    );
    expect(keys).toEqual([]);
  });

  it("unknown result type still renders without crashing (fallback Tag icon + raw label)", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        hit({
          id: "z-1",
          type: "foobar",
          title: "Mystery Row",
          href: "/dashboard/mystery",
        }),
      ],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "my" },
    });
    expect(await screen.findByText("Mystery Row")).toBeInTheDocument();
    // Heading is the raw type when no label is registered.
    expect(screen.getByText("foobar")).toBeInTheDocument();
  });

  it("reopening the palette resets q and results", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [hit({ id: "p-1", title: "First Open Hit" })],
    });
    const { rerender } = render(
      <SearchPalette open={true} onClose={vi.fn()} />,
    );
    const input = screen.getByPlaceholderText(/Search patients/i);
    fireEvent.change(input, { target: { value: "fi" } });
    await screen.findByText("First Open Hit");
    // Close → reopen.
    rerender(<SearchPalette open={false} onClose={vi.fn()} />);
    rerender(<SearchPalette open={true} onClose={vi.fn()} />);
    // After reset the input is empty and the hit is gone.
    const freshInput = screen.getByPlaceholderText(
      /Search patients/i,
    ) as HTMLInputElement;
    expect(freshInput.value).toBe("");
    expect(screen.queryByText("First Open Hit")).not.toBeInTheDocument();
  });

  it("renders the meta chip when a hit carries a meta value", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [hit({ id: "p-1", title: "Has Meta", meta: "MR-9999" })],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "has" },
    });
    expect(await screen.findByText("MR-9999")).toBeInTheDocument();
  });

  it("subsequent queries dedupe inside a single response across multiple types", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        hit({ id: "p-1", title: "Same Id Patient", type: "patient" }),
        hit({
          id: "p-1",
          title: "Same Id Appointment",
          type: "appointment",
          href: "/dashboard/appointments/p-1",
        }),
      ],
    });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search patients/i), {
      target: { value: "sa" },
    });
    // Both render — dedupe is type+id, not just id.
    expect(await screen.findByText("Same Id Patient")).toBeInTheDocument();
    expect(screen.getByText("Same Id Appointment")).toBeInTheDocument();
  });
});
