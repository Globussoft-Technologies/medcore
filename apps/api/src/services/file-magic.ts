// Lightweight magic-byte sniffer. Replaces the optional `file-type` package
// (not available in this deployment) for the small allow-list we care about.
//
// Returns the canonical mime string for the buffer, or null if unrecognised.
// Only inspects the first ~64 bytes — sufficient for every supported format.

export type AllowedMime =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "application/dicom";

export const ALLOWED_MIMES: ReadonlySet<string> = new Set<AllowedMime>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/dicom",
]);

export function detectMime(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;

  // PDF: "%PDF-"
  if (
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  ) {
    return "application/pdf";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // WEBP: "RIFF....WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  // DICOM: "DICM" at offset 128
  if (
    buf.length >= 132 &&
    buf[128] === 0x44 &&
    buf[129] === 0x49 &&
    buf[130] === 0x43 &&
    buf[131] === 0x4d
  ) {
    return "application/dicom";
  }
  // Common unsafe types we want to *explicitly* recognise so the
  // upload route can reject with a useful error.
  // PE/EXE: "MZ"
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    return "application/x-msdownload";
  }
  // ELF: 7F 45 4C 46
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    return "application/x-executable";
  }
  // HTML: looks like "<!DOCTYPE" or "<html"
  const head = buf.slice(0, 16).toString("utf8").toLowerCase().trimStart();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) {
    return "text/html";
  }
  // Script: "#!/" shebang
  if (buf[0] === 0x23 && buf[1] === 0x21) {
    return "application/x-sh";
  }

  return null;
}

/**
 * Returns true iff `buf`'s sniffed mime is in the medical-files allow-list.
 */
export function isAllowedFileBuffer(buf: Buffer): boolean {
  const m = detectMime(buf);
  return !!m && ALLOWED_MIMES.has(m);
}
