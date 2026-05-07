/**
 * Issue #534 — Admin Console IP exposure of internal services.
 *
 * The audit log surfaces the request `ipAddress` for every captured
 * action; the Admin Console's "Error breakdown" tile renders the most
 * frequent IP per action so ops can spot bot-traffic at a glance. When
 * the originating client is a request that traversed our internal
 * network — a worker hitting an internal API endpoint, a cron pod
 * making a bootstrap call, an ops jumphost — the recorded IP belongs
 * to the private RFC1918 space (e.g. 10.42.7.13 or 192.168.4.5).
 * Putting that on a customer-facing dashboard leaks topology details
 * an attacker could use to map our infrastructure.
 *
 * The mitigation is to RENDER private IPs as `[redacted internal]` in
 * customer-facing surfaces. The raw IP stays in the audit log row on
 * the API side for actual security investigations (only DBAs / SRE
 * read those rows directly).
 *
 * Returns a redaction tag for any IP in:
 *   - 10.0.0.0/8        (private Class A)
 *   - 172.16.0.0/12     (private Class B)
 *   - 192.168.0.0/16    (private Class C)
 *   - 127.0.0.0/8       (loopback)
 *   - ::1               (IPv6 loopback)
 *   - fc00::/7          (IPv6 unique local)
 * Otherwise returns the IP unchanged.
 *
 * Empty / "(unknown)" values pass through (the Admin Console already
 * renders an em-dash for them).
 */
export function scrubInternalIp(raw: string | null | undefined): string {
  if (!raw) return "";
  const ip = String(raw).trim();
  if (!ip || ip === "(unknown)") return ip;

  // IPv6 loopback / unique-local. Lower-case for the IPv6 hex prefix
  // check; we don't normalize zero-suppression because we only need to
  // identify the leading prefix.
  const lower = ip.toLowerCase();
  if (lower === "::1") return "[redacted internal]";
  if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) {
    return "[redacted internal]";
  }
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) gets the same treatment as the
  // bare v4 below — strip the v6 prefix and re-test.
  const stripped = lower.startsWith("::ffff:") ? lower.slice(7) : lower;

  // Match dotted-quad. Anything that doesn't parse as v4 falls through
  // unchanged so public IPv6 / public IPv4 still render verbatim.
  const m = stripped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return raw;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return raw;
  if (a === 10) return "[redacted internal]";
  if (a === 127) return "[redacted internal]";
  if (a === 192 && b === 168) return "[redacted internal]";
  if (a === 172 && b >= 16 && b <= 31) return "[redacted internal]";
  return raw;
}
