const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

interface FetchOptions extends RequestInit {
  token?: string;
}

async function request<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { token, headers: customHeaders, ...rest } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((customHeaders as Record<string, string>) || {}),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else if (typeof window !== "undefined") {
    const stored = localStorage.getItem("medcore_token");
    if (stored) headers["Authorization"] = `Bearer ${stored}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers,
    ...rest,
  });

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(data.error || "Request failed") as Error & {
      status?: number;
      payload?: unknown;
    };
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data;
}

export const api = {
  get: <T>(endpoint: string, opts?: FetchOptions) =>
    request<T>(endpoint, { method: "GET", ...opts }),

  post: <T>(endpoint: string, body?: unknown, opts?: FetchOptions) =>
    request<T>(endpoint, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    }),

  patch: <T>(endpoint: string, body?: unknown, opts?: FetchOptions) =>
    request<T>(endpoint, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    }),

  put: <T>(endpoint: string, body?: unknown, opts?: FetchOptions) =>
    request<T>(endpoint, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    }),

  delete: <T>(endpoint: string, opts?: FetchOptions) =>
    request<T>(endpoint, { method: "DELETE", ...opts }),
};
