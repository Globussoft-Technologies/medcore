/**
 * Smoke test for useQueueSocket — verifies the hook loads and exposes the
 * expected shape without requiring a real socket.io connection.
 */

describe("lib/socket useQueueSocket", () => {
  it("exports useQueueSocket as a function", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../lib/socket");
    expect(typeof mod.useQueueSocket).toBe("function");
  });

  it("source references the expected queue events", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "socket.ts"),
      "utf8"
    );
    expect(src).toContain("queue.update");
    expect(src).toContain("queue.advance");
    expect(src).toContain("socket.io-client");
  });
});
