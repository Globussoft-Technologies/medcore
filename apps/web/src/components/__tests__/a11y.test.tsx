// Component-level a11y regression tests (vitest-axe).
//
// Closes P3 from `docs/TEST_COVERAGE_AUDIT.md` (jest-axe / vitest-axe
// in unit suite). Healthcare WCAG 2.1 AA compliance is mandatory; the
// Playwright a11y spec at `e2e/a11y.spec.ts` covers full pages but
// runs only at the e2e tier (~25 min). Component-level checks here
// run sub-second, surface violations earlier in the dev loop, and
// keep DataTable / EntityPicker / ConfirmDialog / EmptyState pinned
// against accidental ARIA / contrast / form-label regressions.
//
// Pinned to wcag2a + wcag2aa + wcag21a + wcag21aa to mirror the e2e
// spec's `withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])`.
// The shared helper at `src/test/a11y.ts` filters by impact level so
// the seed assertions catch every `moderate` / `serious` / `critical`
// finding without flooding on `minor` ones during initial rollout.

import { describe, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { DataTable, type Column } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { ConfirmDialog } from "../ConfirmDialog";
import { EntityPicker } from "../EntityPicker";
import { expectNoA11yViolations } from "@/test/a11y";

interface Row {
  id: string;
  name: string;
  age: number;
}

const sampleData: Row[] = [
  { id: "1", name: "Aadhya Sharma", age: 29 },
  { id: "2", name: "Bhavik Patel", age: 45 },
];

const sampleColumns: Column<Row>[] = [
  { key: "name", label: "Name", sortable: true, filterable: true },
  { key: "age", label: "Age", sortable: true },
];

describe("Component a11y — vitest-axe", () => {
  it("DataTable with rows — no a11y violations", async () => {
    const { container } = render(
      <DataTable data={sampleData} columns={sampleColumns} keyField="id" />,
    );
    await expectNoA11yViolations(container);
  });

  it("DataTable empty state — no a11y violations", async () => {
    const { container } = render(
      <DataTable
        data={[]}
        columns={sampleColumns}
        keyField="id"
        empty={{
          title: "No patients found",
          description: "Try adjusting your search filters",
        }}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("DataTable loading state — no a11y violations", async () => {
    const { container } = render(
      <DataTable
        data={[]}
        columns={sampleColumns}
        keyField="id"
        loading
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("EmptyState with action button — no a11y violations", async () => {
    const { container } = render(
      <EmptyState
        title="No appointments today"
        description="Walk-ins can be added from the queue."
        action={{ label: "Add walk-in", onClick: vi.fn() }}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("ConfirmDialog (open) — no a11y violations", async () => {
    // ConfirmDialog renders into a portal; pass the parent document so
    // axe can see the dialog node + its title/description aria links.
    render(
      <ConfirmDialog
        open
        title="Delete patient record?"
        message="This action cannot be undone. All clinical history will be archived."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await expectNoA11yViolations(document);
  });

  it("EntityPicker closed state — no a11y violations", async () => {
    // Real prop shape: parent owns the chosen-id (controlled), and we
    // reach the API via `endpoint`. An empty `value` renders the search
    // input; `initialLabel` lets us skip the fetch-by-id round-trip in
    // tests so axe sees a steady-state DOM.
    const { container } = render(
      <EntityPicker
        endpoint="/patients"
        labelField="name"
        value=""
        onChange={vi.fn()}
        searchPlaceholder="Search by name or MRN"
        testIdPrefix="patient-picker"
      />,
    );
    await expectNoA11yViolations(container);
  });
});
