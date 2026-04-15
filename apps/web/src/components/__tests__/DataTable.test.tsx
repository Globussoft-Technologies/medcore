import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable, type Column } from "../DataTable";

interface Row {
  id: string;
  name: string;
  age: number;
}

const data: Row[] = [
  { id: "1", name: "Aadhya", age: 29 },
  { id: "2", name: "Bhavik", age: 45 },
  { id: "3", name: "Charu", age: 18 },
];

const columns: Column<Row>[] = [
  { key: "name", label: "Name", sortable: true, filterable: true },
  { key: "age", label: "Age", sortable: true, hideMobile: true },
];

describe("DataTable", () => {
  beforeEach(() => {
    // Reset URL between tests.
    window.history.replaceState(null, "", "/?");
  });

  it("renders rows from data", () => {
    render(<DataTable data={data} columns={columns} keyField="id" />);
    expect(screen.getAllByText("Aadhya").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bhavik").length).toBeGreaterThan(0);
  });

  it("sortable columns cycle asc/desc/none on click", async () => {
    const user = userEvent.setup();
    render(<DataTable data={data} columns={columns} keyField="id" />);
    const header = screen.getByRole("button", { name: /name/i });

    // asc
    await user.click(header);
    const rows1 = screen.getAllByRole("row");
    // Row 0 is header, row 1 = filters row? No — filters hidden by default.
    // Find first data cell in first data row.
    const firstAsc = within(rows1[1]).getByText(/Aadhya|Bhavik|Charu/);
    expect(firstAsc.textContent).toBe("Aadhya");

    // desc
    await user.click(header);
    const rows2 = screen.getAllByRole("row");
    const firstDesc = within(rows2[1]).getByText(/Aadhya|Bhavik|Charu/);
    expect(firstDesc.textContent).toBe("Charu");

    // none — original order restored
    await user.click(header);
    const rows3 = screen.getAllByRole("row");
    const firstNone = within(rows3[1]).getByText(/Aadhya|Bhavik|Charu/);
    expect(firstNone.textContent).toBe("Aadhya");
  });

  it("filter input narrows rows by text match", async () => {
    const user = userEvent.setup();
    render(<DataTable data={data} columns={columns} keyField="id" />);
    await user.click(screen.getByLabelText("Toggle filters"));
    const input = screen.getByPlaceholderText(/filter name/i);
    await user.type(input, "Bha");
    expect(screen.queryByText("Aadhya")).toBeNull();
    // "Bhavik" appears in desktop AND mobile card views — just assert >= 1
    expect(screen.getAllByText("Bhavik").length).toBeGreaterThan(0);
  });

  it("bulk selection shows the bulk action bar", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <DataTable
        data={data}
        columns={columns}
        keyField="id"
        bulkActions={[{ label: "Delete", onAction }]}
      />
    );
    const selectAll = screen.getByLabelText("Select all on page");
    await user.click(selectAll);
    expect(screen.getByText(/\d+ selected/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    const args = onAction.mock.calls[0][0] as Row[];
    expect(args.length).toBe(3);
  });

  it("CSV export generates a blob and triggers a download", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    render(<DataTable data={data} columns={columns} keyField="id" csvName="people" />);
    await user.click(screen.getByLabelText("Export CSV"));
    expect(createObjectURL).toHaveBeenCalled();
    const arg = createObjectURL.mock.calls[0][0] as Blob;
    expect(arg).toBeInstanceOf(Blob);
    expect(arg.type).toMatch(/text\/csv/);
  });

  it("pagination rows-per-page select changes pageSize", async () => {
    const many: Row[] = Array.from({ length: 40 }).map((_, i) => ({
      id: String(i),
      name: "User " + i,
      age: 20 + (i % 10),
    }));
    const user = userEvent.setup();
    render(<DataTable data={many} columns={columns} keyField="id" pageSize={10} />);
    // Page 1 of 4 → 1-10 of 40
    expect(screen.getByText(/1-10 of 40/)).toBeInTheDocument();
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "25");
    expect(screen.getByText(/1-25 of 40/)).toBeInTheDocument();
  });

  it("shows empty state when no data", () => {
    render(
      <DataTable
        data={[]}
        columns={columns}
        keyField="id"
        empty={{ title: "No rows here" }}
      />
    );
    expect(screen.getAllByText("No rows here").length).toBeGreaterThan(0);
  });

  it("loading state renders skeleton rows", () => {
    const { container } = render(
      <DataTable data={[]} columns={columns} keyField="id" loading />
    );
    // SkeletonRow renders tr + td with .mc-skeleton inside
    const skels = container.querySelectorAll(".mc-skeleton");
    expect(skels.length).toBeGreaterThan(0);
  });

  it("column visibility toggle hides columns", async () => {
    const user = userEvent.setup();
    render(<DataTable data={data} columns={columns} keyField="id" />);
    await user.click(screen.getByLabelText("Column visibility"));
    // Uncheck Age
    const ageCheckbox = screen.getByLabelText("Age") as HTMLInputElement;
    expect(ageCheckbox.checked).toBe(true);
    await user.click(ageCheckbox);
    // Age column header should no longer appear in desktop table
    const headers = screen.queryAllByRole("columnheader");
    const hasAge = headers.some((h) => /^Age$/.test(h.textContent || ""));
    expect(hasAge).toBe(false);
  });

  it("onRowClick fires with the row", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        data={data}
        columns={columns}
        keyField="id"
        onRowClick={onRowClick}
      />
    );
    // Click a desktop row
    const rows = screen.getAllByRole("row");
    await user.click(rows[1]);
    expect(onRowClick).toHaveBeenCalled();
  });

  it("urlState writes sort to the query string", async () => {
    const user = userEvent.setup();
    render(
      <DataTable data={data} columns={columns} keyField="id" urlState />
    );
    await user.click(screen.getByRole("button", { name: /name/i }));
    expect(window.location.search).toContain("sort=name");
    expect(window.location.search).toContain("dir=asc");
  });

  it("applies dark-mode classes on the root wrapper", () => {
    const { container } = render(
      <DataTable data={data} columns={columns} keyField="id" />
    );
    expect(container.firstChild).toHaveClass("dark:bg-gray-800");
  });

  it("default sort prop is applied on mount", () => {
    render(
      <DataTable
        data={data}
        columns={columns}
        keyField="id"
        defaultSort={{ key: "age", dir: "desc" }}
      />
    );
    const rows = screen.getAllByRole("row");
    const firstNameCell = within(rows[1]).getByText(/Aadhya|Bhavik|Charu/);
    expect(firstNameCell.textContent).toBe("Bhavik");
  });

  it("toolbar extras render in the header", () => {
    render(
      <DataTable
        data={data}
        columns={columns}
        keyField="id"
        toolbarExtras={<span data-testid="extra">hello</span>}
      />
    );
    expect(screen.getByTestId("extra")).toBeInTheDocument();
  });

  it("bulk action Clear resets selection", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        data={data}
        columns={columns}
        keyField="id"
        bulkActions={[{ label: "Delete", onAction: () => {} }]}
      />
    );
    await user.click(screen.getByLabelText("Select all on page"));
    expect(screen.getByText(/\d+ selected/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/\d+ selected/)).toBeNull();
  });
});
