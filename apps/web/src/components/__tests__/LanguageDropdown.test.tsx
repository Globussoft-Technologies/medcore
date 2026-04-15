import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageDropdown } from "../LanguageDropdown";
import { useI18nStore } from "@/lib/i18n";

describe("LanguageDropdown", () => {
  it("shows the current language from the store", () => {
    useI18nStore.setState({ lang: "en" });
    render(<LanguageDropdown />);
    const select = screen.getByLabelText("Select language") as HTMLSelectElement;
    expect(select.value).toBe("en");
  });

  it("changing selection updates the store", async () => {
    useI18nStore.setState({ lang: "en" });
    render(<LanguageDropdown />);
    const select = screen.getByLabelText("Select language");
    await userEvent.selectOptions(select, "hi");
    expect(useI18nStore.getState().lang).toBe("hi");
  });

  it("persists the new language to localStorage", async () => {
    useI18nStore.setState({ lang: "en" });
    render(<LanguageDropdown />);
    const select = screen.getByLabelText("Select language");
    await userEvent.selectOptions(select, "hi");
    expect(window.localStorage.getItem("medcore_lang")).toBe("hi");
  });
});
