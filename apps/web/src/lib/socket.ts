import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

function resolveSocketBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  return raw.replace(/\/api\/v1\/?$/, "");
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io(resolveSocketBaseUrl(), {
      transports: ["websocket"],
      autoConnect: false,
      withCredentials: true,
    });
  }
  return socket;
}
