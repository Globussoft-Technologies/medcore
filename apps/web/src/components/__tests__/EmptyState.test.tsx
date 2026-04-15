import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(<EmptyState title="No records" description="Start by adding one" />);
    expect(screen.getByText("No records")).toBeInTheDocument();
    expect(screen.getByText("Start by adding one")).toBeInTheDocument();
  });

  it("renders a custom icon when provided", () => {
    render(
      <EmptyState
        title="Nothing"
        icon={<span data-testid="empty-icon">ICO</span>}
      />
    );
    expect(screen.getByTestId("empty-icon")).toBeInTheDocument();
  });

  it("fires action callback when the button is clicked", async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Nothing"
        action={{ label: "Add one", onClick }}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Add one" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not render an action button when action is not provided", () => {
    render(<EmptyState title="Nothing" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
