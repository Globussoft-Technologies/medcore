import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThemeStore } from "../theme";

describe("theme store", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
    window.localStorage.clear();
    useThemeStore.setState({ mode: "system", resolved: "light" });
  });

  it("setMode('dark') adds dark class and persists to localStorage", () => {
    useThemeStore.getState().setMode("dark");
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().resolved).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem("medcore_theme")).toBe("dark");
  });

  it("setMode('light') removes dark class", () => {
    document.documentElement.classList.add("dark");
    useThemeStore.getState().setMode("light");
    expect(useThemeStore.getState().resolved).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("toggle flips from light to dark and back", () => {
    useThemeStore.getState().setMode("light");
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().resolved).toBe("dark");
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().resolved).toBe("light");
  });

  it("init reads stored preference", () => {
    window.localStorage.setItem("medcore_theme", "dark");
    useThemeStore.getState().init();
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("mode=system resolves based on prefers-color-scheme", () => {
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
    useThemeStore.getState().setMode("system");
    expect(useThemeStore.getState().resolved).toBe("dark");
  });
});
