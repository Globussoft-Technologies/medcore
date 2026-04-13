import * as SecureStore from "expo-secure-store";

const BASE_URL = "https://medcore.globusdemos.com/api/v1";

const ACCESS_TOKEN_KEY = "medcore_access_token";
const REFRESH_TOKEN_KEY = "medcore_refresh_token";

async function getAccessToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function setTokens(accessToken: string, refreshToken: string) {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
}

async function clearTokens() {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

async function request<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message || res.statusText, body);
  }

  return res.json();
}

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, message: string, body: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ── Auth ────────────────────────────────────────────────────────────────

export async function loginApi(email: string, password: string) {
  const res = await request<{
    data: {
      user: any;
      tokens: { accessToken: string; refreshToken: string };
    };
  }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  await setTokens(res.data.tokens.accessToken, res.data.tokens.refreshToken);
  return res.data;
}

export async function registerApi(data: {
  name: string;
  email: string;
  phone: string;
  password: string;
  gender?: string;
  age?: number;
}) {
  const res = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...data, role: "PATIENT" }),
  });
  return res;
}

export async function fetchMe() {
  const res = await request<{ data: any }>("/auth/me");
  return res.data;
}

export async function logoutApi() {
  await clearTokens();
}

export async function hasStoredToken(): Promise<boolean> {
  const token = await getAccessToken();
  return !!token;
}

// ── Doctors ─────────────────────────────────────────────────────────────

export async function fetchDoctors() {
  const res = await request<{ data: any[] }>("/doctors");
  return res.data;
}

export async function fetchDoctorSlots(doctorId: string, date: string) {
  const res = await request<{ data: any[] }>(
    `/doctors/${doctorId}/slots?date=${date}`
  );
  return res.data;
}

// ── Appointments ────────────────────────────────────────────────────────

export async function fetchAppointments(params?: {
  date?: string;
  patientId?: string;
}) {
  const query = new URLSearchParams();
  if (params?.date) query.set("date", params.date);
  if (params?.patientId) query.set("patientId", params.patientId);
  const qs = query.toString();
  const res = await request<{ data: any[] }>(
    `/appointments${qs ? `?${qs}` : ""}`
  );
  return res.data;
}

export async function bookAppointment(data: {
  patientId: string;
  doctorId: string;
  date: string;
  slotId: string;
}) {
  const res = await request("/appointments/book", {
    method: "POST",
    body: JSON.stringify(data),
  });
  return res;
}

export async function updateAppointmentStatus(
  id: string,
  status: string
) {
  const res = await request(`/appointments/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  return res;
}

// ── Queue ───────────────────────────────────────────────────────────────

export async function fetchQueue(doctorId?: string) {
  if (doctorId) {
    const res = await request<{ data: any }>(`/queue/${doctorId}`);
    return res.data;
  }
  const res = await request<{ data: any[] }>("/queue");
  return res.data;
}

// ── Prescriptions ───────────────────────────────────────────────────────

export async function fetchPrescriptions(patientId?: string) {
  const qs = patientId ? `?patientId=${patientId}` : "";
  const res = await request<{ data: any[] }>(`/prescriptions${qs}`);
  return res.data;
}

export async function fetchPrescriptionDetail(id: string) {
  const res = await request<{ data: any }>(`/prescriptions/${id}`);
  return res.data;
}

// ── Billing ─────────────────────────────────────────────────────────────

export async function fetchInvoices(patientId?: string) {
  const qs = patientId ? `?patientId=${patientId}` : "";
  const res = await request<{ data: any[] }>(`/billing/invoices${qs}`);
  return res.data;
}

// ── Patients ────────────────────────────────────────────────────────────

export async function fetchPatientDetail(id: string) {
  const res = await request<{ data: any }>(`/patients/${id}`);
  return res.data;
}
