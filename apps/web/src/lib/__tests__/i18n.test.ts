import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useI18nStore, useTranslation } from "../i18n";

describe("i18n store & useTranslation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useI18nStore.setState({ lang: "en" });
  });

  it("t() returns the English translation by default", () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t("login.title")).toBe("Sign In");
  });

  it("t() returns the Hindi translation when lang=hi", () => {
    useI18nStore.setState({ lang: "hi" });
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t("login.title")).toBe("साइन इन करें");
  });

  it("missing keys fall back to the fallback argument, then the key itself", () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t("nonexistent.key", "Default")).toBe("Default");
    expect(result.current.t("nonexistent.key2")).toBe("nonexistent.key2");
  });

  it("setLang persists choice to localStorage", () => {
    const { result } = renderHook(() => useTranslation());
    act(() => result.current.setLang("hi"));
    expect(window.localStorage.getItem("medcore_lang")).toBe("hi");
  });

  it("init() restores lang from localStorage", () => {
    window.localStorage.setItem("medcore_lang", "hi");
    useI18nStore.getState().init();
    expect(useI18nStore.getState().lang).toBe("hi");
  });
});
