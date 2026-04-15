import { describe, it, expect, vi, beforeEach } from "vitest";
import { api, openPrintEndpoint } from "../api";

describe("api client", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("GET attaches Authorization header when a token is stored", async () => {
    window.localStorage.setItem("medcore_token", "tok-1");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
    await api.get("/ping");
    expect(fetchSpy).toHaveBeenCalled();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-1"
    );
  });

  it("POST sends JSON body with Content-Type and stringified payload", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
    await api.post("/thing", { a: 1 });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("explicit token option overrides localStorage value", async () => {
    window.localStorage.setItem("medcore_token", "stored");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
    await api.get("/x", { token: "explicit" });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer explicit"
    );
  });

  it("error response throws Error with the server message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Nope" }), { status: 400 })
    );
    await expect(api.get("/err")).rejects.toThrow("Nope");
  });

  it("openPrintEndpoint opens a new window, fetches HTML, writes document", async () => {
    const doc = {
      open: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
    };
    const fakeWin = { document: doc, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(fakeWin as any);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>OK</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );
    await openPrintEndpoint("/print/123");
    expect(window.open).toHaveBeenCalled();
    expect(doc.open).toHaveBeenCalled();
    expect(doc.write).toHaveBeenCalledWith("<html>OK</html>");
    expect(doc.close).toHaveBeenCalled();
  });
});
