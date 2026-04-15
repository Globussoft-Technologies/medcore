import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonRow,
  SkeletonTable,
} from "../Skeleton";

describe("Skeleton", () => {
  it("renders base Skeleton with mc-skeleton class", () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector(".mc-skeleton");
    expect(el).toBeInTheDocument();
  });

  it("SkeletonText renders N lines", () => {
    const { container } = render(<SkeletonText lines={4} />);
    const lines = container.querySelectorAll(".mc-skeleton");
    expect(lines.length).toBe(4);
  });

  it("SkeletonCard renders a card wrapper with skeleton children", () => {
    const { container } = render(<SkeletonCard />);
    const skeletons = container.querySelectorAll(".mc-skeleton");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("SkeletonRow renders the requested number of cells", () => {
    const { container } = render(
      <table>
        <tbody>
          <SkeletonRow columns={7} />
        </tbody>
      </table>
    );
    const cells = container.querySelectorAll("td");
    expect(cells.length).toBe(7);
  });

  it("SkeletonTable renders rows × columns skeleton cells", () => {
    const { container } = render(<SkeletonTable rows={3} columns={4} />);
    const cells = container.querySelectorAll("td");
    expect(cells.length).toBe(12);
  });

  it("accepts a custom className", () => {
    const { container } = render(<Skeleton className="custom-skel" />);
    expect(container.querySelector(".custom-skel")).toBeInTheDocument();
  });

  it("circle variant renders with rounded-full", () => {
    const { container } = render(<Skeleton variant="circle" />);
    expect(container.querySelector(".rounded-full")).toBeInTheDocument();
  });
});
