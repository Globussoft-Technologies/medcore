import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { Autocomplete } from "../Autocomplete";

interface Item {
  id: string;
  label: string;
}

function Harness({
  fetchOptions,
  onChange,
  debounce = 10,
}: {
  fetchOptions: (q: string) => Promise<Item[]>;
  onChange?: (val: string, item?: Item) => void;
  debounce?: number;
}) {
  const [val, setVal] = useState("");
  return (
    <Autocomplete<Item>
      value={val}
      onChange={(v, item) => {
        setVal(v);
        onChange?.(v, item);
      }}
      fetchOptions={fetchOptions}
      renderOption={(it) => <span>{it.label}</span>}
      getOptionLabel={(it) => it.label}
      placeholder="Search patients"
      debounce={debounce}
      minChars={1}
      aria-label="patient-search"
    />
  );
}

describe("Autocomplete", () => {
  it("renders the placeholder", () => {
    render(
      <Autocomplete
        value=""
        onChange={() => {}}
        fetchOptions={async () => []}
        renderOption={() => null}
        placeholder="Type here"
      />
    );
    expect(screen.getByPlaceholderText("Type here")).toBeInTheDocument();
  });

  it("typing triggers fetchOptions after the debounce delay", async () => {
    const fetchOptions = vi.fn(async () => [{ id: "1", label: "Ananya" }]);
    render(<Harness fetchOptions={fetchOptions} debounce={50} />);
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "An" } });
    await waitFor(() => {
      expect(fetchOptions).toHaveBeenCalled();
    });
  });

  it("results appear in the listbox dropdown", async () => {
    const fetchOptions = vi.fn(async () => [{ id: "1", label: "Ananya" }]);
    render(<Harness fetchOptions={fetchOptions} debounce={10} />);
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "An" } });
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(screen.getByText("Ananya")).toBeInTheDocument();
    });
  });

  it("clicking an option (mousedown) calls onChange with the item", async () => {
    const onChange = vi.fn();
    const fetchOptions = vi.fn(async () => [{ id: "1", label: "Ananya" }]);
    render(
      <Harness fetchOptions={fetchOptions} onChange={onChange} debounce={10} />
    );
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "A" } });
    await waitFor(() => screen.getByText("Ananya"));
    fireEvent.mouseDown(screen.getByText("Ananya"));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(last[0]).toBe("Ananya");
    expect(last[1]).toEqual({ id: "1", label: "Ananya" });
  });

  it("keyboard ArrowDown+Enter selects highlighted option", async () => {
    const onChange = vi.fn();
    const fetchOptions = vi.fn(async () => [
      { id: "1", label: "One" },
      { id: "2", label: "Two" },
      { id: "3", label: "Three" },
    ]);
    render(
      <Harness fetchOptions={fetchOptions} onChange={onChange} debounce={10} />
    );
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "x" } });
    await waitFor(() => screen.getByText("Three"));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(last[0]).toBe("Three");
  });

  it("Escape closes the dropdown", async () => {
    const fetchOptions = vi.fn(async () => [{ id: "1", label: "One" }]);
    render(<Harness fetchOptions={fetchOptions} debounce={10} />);
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows loading indicator while fetching", async () => {
    let resolveFetch: (v: Item[]) => void = () => {};
    const fetchOptions = vi.fn(
      () => new Promise<Item[]>((resolve) => (resolveFetch = resolve))
    );
    render(<Harness fetchOptions={fetchOptions} debounce={10} />);
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    await waitFor(() => {
      expect(screen.getByText(/searching/i)).toBeInTheDocument();
    });
    await act(async () => {
      resolveFetch([{ id: "1", label: "Done" }]);
    });
  });

  it("shows 'no matches' when results are empty", async () => {
    const fetchOptions = vi.fn(async () => []);
    render(<Harness fetchOptions={fetchOptions} debounce={10} />);
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz" } });
    await waitFor(() =>
      expect(screen.getByText(/no matches/i)).toBeInTheDocument()
    );
  });

  it("respects a larger debounce delay", async () => {
    const fetchOptions = vi.fn(async () => []);
    render(<Harness fetchOptions={fetchOptions} debounce={200} />);
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    // Not called within 50ms
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchOptions).not.toHaveBeenCalled();
    // Called within 300ms
    await waitFor(
      () => expect(fetchOptions).toHaveBeenCalled(),
      { timeout: 500 }
    );
  });

  it("stale result from an earlier query is not rendered after a newer one resolves", async () => {
    let stallResolve: (v: Item[]) => void = () => {};
    const calls: string[] = [];
    const fetchOptions = vi.fn(async (q: string) => {
      calls.push(q);
      if (calls.length === 1) {
        return new Promise<Item[]>((resolve) => (stallResolve = resolve));
      }
      return [{ id: "fresh", label: "FreshResult" }];
    });
    render(<Harness fetchOptions={fetchOptions} debounce={10} />);
    const input = screen.getByPlaceholderText("Search patients");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    // Give debounce time to fire the first call
    await waitFor(() => expect(fetchOptions).toHaveBeenCalledTimes(1));
    // Now change input — starts second fetch
    fireEvent.change(input, { target: { value: "ab" } });
    await waitFor(() =>
      expect(screen.getByText("FreshResult")).toBeInTheDocument()
    );
    // Resolve stale fetch AFTER fresh one landed
    await act(async () => {
      stallResolve([{ id: "stale", label: "StaleResult" }]);
    });
    // Stale result should NOT appear
    expect(screen.queryByText("StaleResult")).toBeNull();
  });
});
