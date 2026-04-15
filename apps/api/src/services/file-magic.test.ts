import { describe, it, expect } from "vitest";
import { detectMime, isAllowedFileBuffer } from "./file-magic";

describe("file-magic", () => {
  it("detects PDF", () => {
    expect(detectMime(Buffer.from("%PDF-1.7\nbody"))).toBe("application/pdf");
  });

  it("detects PNG", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectMime(png)).toBe("image/png");
  });

  it("detects JPEG", () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(detectMime(jpg)).toBe("image/jpeg");
  });

  it("detects WEBP", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP"),
    ]);
    expect(detectMime(webp)).toBe("image/webp");
  });

  it("detects DICOM with DICM at offset 128", () => {
    const buf = Buffer.alloc(132);
    buf.write("DICM", 128, "ascii");
    expect(detectMime(buf)).toBe("application/dicom");
  });

  it("flags PE/EXE as msdownload", () => {
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
    expect(detectMime(exe)).toBe("application/x-msdownload");
    expect(isAllowedFileBuffer(exe)).toBe(false);
  });

  it("flags HTML", () => {
    const html = Buffer.from("<!DOCTYPE html><html></html>");
    expect(detectMime(html)).toBe("text/html");
  });

  it("returns null for unknown bytes", () => {
    const noise = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(detectMime(noise)).toBeNull();
    expect(isAllowedFileBuffer(noise)).toBe(false);
  });

  it("isAllowedFileBuffer accepts PDF", () => {
    expect(isAllowedFileBuffer(Buffer.from("%PDF-1.4\n"))).toBe(true);
  });
});
