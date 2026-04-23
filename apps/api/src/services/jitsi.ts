// Jitsi Meet integration helpers.
//
// This module produces moderated-room URLs for the MedCore tele-consult feature.
// For public-room "meet.jit.si" the JWT is optional — it is only validated by
// self-hosted JaaS / Jitsi-as-a-Service installations. When JITSI_APP_ID and
// JITSI_APP_SECRET are unset we fall back to unsigned URLs (dev/local).
//
// Recording: Jitsi Videobridge handles the actual media recording via Jibri.
// This service only persists the resulting recording URL metadata on the
// TelemedicineSession model — it does not start/stop media capture itself.
// To enable server-side recording on a self-hosted install, configure Jibri
// per https://jitsi.github.io/handbook/docs/devops-guide/jibri and pass the
// resulting mp4 URL back to `POST /:id/recording/stop`.

import jwt from "jsonwebtoken";

export type JitsiRole = "moderator" | "participant";

export interface JitsiUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
}

/**
 * Signs a JWT suitable for passing to a Jitsi room as the `jwt=` query param.
 * Follows the standard Jitsi JWT claims shape (app_id / aud / sub / room /
 * context.user). Returns an empty string when the app is not configured
 * (caller should treat empty as "no JWT" and just use the bare URL).
 */
export function generateJitsiJWT(
  room: string,
  user: JitsiUser,
  role: JitsiRole
): string {
  const appId = process.env.JITSI_APP_ID;
  const appSecret = process.env.JITSI_APP_SECRET;
  if (!appId || !appSecret) return "";

  const domain = process.env.JITSI_DOMAIN || "meet.jit.si";
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    aud: "jitsi",
    iss: appId,
    sub: domain,
    room,
    iat: now,
    // Sessions expire 4 h after issue — long enough for a real consult.
    exp: now + 60 * 60 * 4,
    context: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email || "",
        avatar: user.avatar || "",
        moderator: role === "moderator" ? "true" : "false",
      },
      features: {
        recording: role === "moderator" ? "true" : "false",
        livestreaming: "false",
        "screen-sharing": "true",
        "outbound-call": "false",
      },
    },
  };

  return jwt.sign(payload, appSecret, { algorithm: "HS256" });
}

/**
 * Builds the full Jitsi room URL. Accepts a sessionId (MedCore session id) and
 * appends the JWT if one is provided. Room name uses a stable `medcore-<id>`
 * prefix so moderators and patients always end up in the same room.
 */
export function buildJitsiRoomUrl(
  sessionId: string,
  opts: { jwt?: string; room?: string } = {}
): string {
  const domain = process.env.JITSI_DOMAIN || "meet.jit.si";
  const room = opts.room || `medcore-${sessionId}`;
  const base = `https://${domain}/${encodeURIComponent(room)}`;
  return opts.jwt ? `${base}?jwt=${opts.jwt}` : base;
}

/**
 * Convenience wrapper — sign + build URL in one call.
 */
export function signedJitsiRoomUrl(
  sessionId: string,
  user: JitsiUser,
  role: JitsiRole,
  roomOverride?: string
): { url: string; room: string; jwt: string } {
  const room = roomOverride || `medcore-${sessionId}`;
  const token = generateJitsiJWT(room, user, role);
  const url = buildJitsiRoomUrl(sessionId, { jwt: token, room });
  return { url, room, jwt: token };
}
