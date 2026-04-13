import { Request } from "express";
import { prisma } from "@medcore/db";

export async function auditLog(
  req: Request,
  action: string,
  entity: string,
  entityId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  const userId = req.user?.userId ?? null;
  const forwarded = req.headers["x-forwarded-for"];
  const ipAddress =
    (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip) ??
    null;

  await prisma.auditLog.create({
    data: {
      userId,
      action,
      entity,
      entityId: entityId ?? null,
      details: (details as any) ?? undefined,
      ipAddress,
    },
  });
}
