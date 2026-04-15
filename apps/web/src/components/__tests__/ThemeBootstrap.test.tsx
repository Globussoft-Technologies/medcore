import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { ThemeBootstrap } from "../ThemeBootstrap";
import { useThemeStore } from "@/lib/theme";

describe("ThemeBootstrap", () => {
  beforeEach(() => {
    // Clean up dark class from previous renders
    document.documentElement.classList.remove("dark");
    useThemeStore.setState({ mode: "system", resolved: "light" });
  });

  it("reads medcore_theme from localStorage on mount (dark)", () => {
    window.localStorage.setItem("medcore_theme", "dark");
    render(<ThemeBootstrap />);
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applies light when stored preference is light", () => {
    window.localStorage.setItem("medcore_theme", "light");
    render(<ThemeBootstrap />);
    expect(useThemeStore.getState().resolved).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("honours system preference when mode is 'system'", () => {
    window.localStorage.setItem("medcore_theme", "system");
    // Mock matchMedia to prefer dark
    (window.matchMedia as any) = (q: string) => ({
      matches: q.includes("dark"),
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    render(<ThemeBootstrap />);
    expect(useThemeStore.getState().resolved).toBe("dark");
  });

  it("returns null (no DOM output)", () => {
    const { container } = render(<ThemeBootstrap />);
    expect(container.firstChild).toBeNull();
  });
});
