import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted so factories can see them) ──────────
const { sendNotification, prismaMock } = vi.hoisted(() => ({
  sendNotification: vi.fn(async (_arg: any) => {}),
  prismaMock: {
    appointment: { findUnique: vi.fn(), findMany: vi.fn() },
    patient: { findUnique: vi.fn() },
    doctor: { findUnique: vi.fn() },
  },
}));

vi.mock("./notification", () => ({ sendNotification }));
vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

// Must import AFTER mocks are set up
import {
  onAppointmentBooked,
  onAppointmentCancelled,
  onTokenCalled,
  onPrescriptionReady,
  onBillGenerated,
  onPaymentReceived,
  onDoctorScheduleSummary,
  notifyQueuePosition,
} from "./notification-triggers";

function baseAppt(overrides: Partial<any> = {}) {
  return {
    id: "appt-1",
    tokenNumber: 5,
    date: new Date("2024-05-10"),
    slotStart: "10:00",
    patient: {
      id: "p1",
      userId: "pu1",
      user: { name: "Ananya", phone: "+91..." },
    },
    doctor: {
      id: "d1",
      userId: "du1",
      user: { name: "Gupta" },
    },
    ...overrides,
  };
}

describe("notification-triggers", () => {
  beforeEach(() => {
    sendNotification.mockClear();
    Object.values(prismaMock).forEach((group) =>
      Object.values(group).forEach((fn: any) => fn.mockReset?.())
    );
  });

  it("onAppointmentBooked notifies both patient and doctor", async () => {
    await onAppointmentBooked(baseAppt() as any);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const userIds = sendNotification.mock.calls.map((c) => (c[0] as any).userId);
    expect(userIds).toContain("pu1");
    expect(userIds).toContain("du1");
  });

  it("onAppointmentCancelled notifies both parties", async () => {
    await onAppointmentCancelled(baseAppt() as any);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const titles = sendNotification.mock.calls.map((c) => (c[0] as any).title);
    expect(titles).toEqual(
      expect.arrayContaining(["Appointment Cancelled", "Appointment Cancelled"])
    );
  });

  it("onTokenCalled sends only to the patient", async () => {
    await onTokenCalled(baseAppt() as any);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect((sendNotification.mock.calls[0][0] as any).userId).toBe("pu1");
  });

  it("onPrescriptionReady sends to the patient with a link in message", async () => {
    await onPrescriptionReady({
      id: "rx-1",
      patient: { id: "p1", userId: "pu1", user: { name: "A", phone: "+9" } },
      doctor: { id: "d1", user: { name: "Dr" } },
    } as any);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const arg = sendNotification.mock.calls[0][0] as any;
    expect(arg.userId).toBe("pu1");
    expect(arg.message).toContain("/prescriptions/rx-1");
  });

  it("onBillGenerated notifies patient with amount and payment link", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce({
      user: { id: "pu1", name: "A", phone: "+9" },
    });
    await onBillGenerated({
      id: "inv-1",
      invoiceNumber: "INV-001",
      totalAmount: 1500,
      patientId: "p1",
    });
    expect(prismaMock.patient.findUnique).toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const arg = sendNotification.mock.calls[0][0] as any;
    expect(arg.message).toContain("INV-001");
    expect(arg.message).toContain("1500");
    expect(arg.message).toContain("/billing/invoices/inv-1/pay");
  });

  it("onPaymentReceived notifies patient with paid amount + mode", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce({
      user: { id: "pu1", name: "A", phone: "+9" },
    });
    await onPaymentReceived(
      { id: "pay-1", amount: 500, mode: "CASH" },
      {
        id: "inv-1",
        invoiceNumber: "INV-001",
        totalAmount: 1500,
        patientId: "p1",
      }
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const arg = sendNotification.mock.calls[0][0] as any;
    expect(arg.message).toContain("CASH");
    expect(arg.message).toContain("500");
  });

  it("onDoctorScheduleSummary fetches today's appts and notifies doctor", async () => {
    prismaMock.doctor.findUnique.mockResolvedValueOnce({
      user: { id: "du1", name: "Dr. A" },
    });
    prismaMock.appointment.findMany.mockResolvedValueOnce([
      { tokenNumber: 1, patient: { user: { name: "A" } } },
      { tokenNumber: 2, patient: { user: { name: "B" } } },
    ]);
    await onDoctorScheduleSummary("d1");
    expect(prismaMock.doctor.findUnique).toHaveBeenCalled();
    expect(prismaMock.appointment.findMany).toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const arg = sendNotification.mock.calls[0][0] as any;
    expect(arg.message).toContain("2 appointment");
  });

  it("notifyQueuePosition sends queue position + wait info", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce({
      id: "appt-1",
      doctorId: "d1",
      date: new Date("2024-05-10"),
      status: "CHECKED_IN",
      patient: { user: { id: "pu1", name: "Ananya" } },
      doctor: { user: { name: "Gupta" } },
    });
    prismaMock.appointment.findMany.mockResolvedValueOnce([
      { id: "other", tokenNumber: 1, priority: "NORMAL", status: "IN_CONSULTATION" },
      { id: "appt-1", tokenNumber: 5, priority: "NORMAL", status: "CHECKED_IN" },
    ]);
    await notifyQueuePosition("appt-1");
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const arg = sendNotification.mock.calls[0][0] as any;
    expect(arg.message).toContain("#2");
    expect(arg.data.estimatedWaitMinutes).toBe(15);
  });
});
