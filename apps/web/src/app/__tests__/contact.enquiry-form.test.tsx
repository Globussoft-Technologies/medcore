/* eslint-disable @typescript-eslint/no-explicit-any */
// Issue #45 regression: the marketing contact form must show INLINE field
// errors (under each input) when validation fails, NOT a generic
// "Invalid enquiry payload" toast or banner.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EnquiryForm } from "../(marketing)/contact/EnquiryForm";

function fillHappyPathExcept(
  user: ReturnType<typeof userEvent.setup>,
  skip: Set<string>
) {
  async function type(label: RegExp, value: string) {
    await user.type(screen.getByLabelText(label), value);
  }
  async function selectOption(label: RegExp, value: string) {
    await user.selectOptions(screen.getByLabelText(label), value);
  }
  const tasks: Array<[string, () => Promise<void>]> = [
    ["fullName", () => type(/full name/i, "Dr. Meera Rao")],
    ["email", () => type(/work email/i, "meera@asha.in")],
    ["phone", () => type(/phone/i, "+91 9876543210")],
    ["hospitalName", () => type(/hospital name/i, "Asha Hospital")],
    ["hospitalSize", () => selectOption(/hospital size/i, "10-50")],
    ["role", () => selectOption(/your role/i, "Administrator")],
    [
      "message",
      () =>
        type(/message/i, "Looking for a detailed demo of OPD + billing."),
    ],
  ];
  return (async () => {
    for (const [field, task] of tasks) {
      if (skip.has(field)) continue;
      await task();
    }
  })();
}

describe("EnquiryForm (Issue #45) — inline field errors", () => {
  beforeEach(() => {
    // Default: fetch should never be called when client-side validation fails.
    (globalThis as any).fetch = vi.fn();
  });

  it("submitting with bad email shows inline error AND does NOT show generic toast", async () => {
    const user = userEvent.setup();
    render(<EnquiryForm />);
    await fillHappyPathExcept(user, new Set(["email"]));
    await user.type(screen.getByLabelText(/work email/i), "abc");
    await user.click(screen.getByRole("button", { name: /request a demo/i }));

    // Inline field error visible — contains "email" in its text.
    await waitFor(() => {
      expect(document.getElementById("email-error")?.textContent).toMatch(
        /email/i,
      );
    });

    // The generic server toast must NOT appear.
    expect(screen.queryByText(/invalid enquiry payload/i)).toBeNull();

    // No network call — client-side validation stopped it.
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it("submitting with short name shows inline name error", async () => {
    const user = userEvent.setup();
    render(<EnquiryForm />);
    await fillHappyPathExcept(user, new Set(["fullName"]));
    await user.type(screen.getByLabelText(/full name/i), "X");
    await user.click(screen.getByRole("button", { name: /request a demo/i }));

    const alerts = await screen.findAllByRole("alert");
    const texts = alerts.map((a) => a.textContent || "");
    expect(texts.some((t) => /name/i.test(t))).toBe(true);
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it("submitting with short message shows inline message error", async () => {
    const user = userEvent.setup();
    render(<EnquiryForm />);
    await fillHappyPathExcept(user, new Set(["message"]));
    await user.type(screen.getByLabelText(/message/i), "hi");
    await user.click(screen.getByRole("button", { name: /request a demo/i }));

    const alerts = await screen.findAllByRole("alert");
    const texts = alerts.map((a) => a.textContent || "");
    expect(texts.some((t) => /message/i.test(t))).toBe(true);
  });

  it("maps server-side structured errors back onto field alerts", async () => {
    // Simulate a server that validates more strictly than the client — the
    // form must still surface each error inline.
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: false,
          data: null,
          error: "Please correct the highlighted fields.",
          errors: [
            {
              field: "email",
              message: "Email already registered as an enquiry",
            },
          ],
        }),
        { status: 400 }
      )
    );

    const user = userEvent.setup();
    render(<EnquiryForm />);
    await fillHappyPathExcept(user, new Set());
    await user.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(document.getElementById("email-error")?.textContent).toMatch(
        /already registered/i,
      );
    });
    // Confirm the old generic toast is absent.
    expect(screen.queryByText(/invalid enquiry payload/i)).toBeNull();
  });

  it("happy path: valid submission calls the API and shows success", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, data: { id: "enq_1" } }),
        { status: 201 }
      )
    );

    const user = userEvent.setup();
    render(<EnquiryForm />);
    await fillHappyPathExcept(user, new Set());
    await user.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/we.*ll be in touch/i)
    ).toBeInTheDocument();
  });
});
