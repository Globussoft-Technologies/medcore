// No-show predictor backed by a logistic regression model.
//
// At training time we pull 6+ months of historical appointments, materialise
// a feature matrix via `./ml/feature-extractor`, fit the LR model, and
// persist the weights to disk at `apps/api/data/ml/no-show-weights.json`.
//
// At inference time we attempt to load those weights; if the file is missing
// or corrupt we fall back to the legacy rule-based scoring so the service
// still works on a fresh install or in tests that don't have a trained
// model artifact.

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@medcore/db";
import {
  extractFeatures,
  explainFeatures,
  riskBucket,
  NUM_FEATURES,
  NO_SHOW_FEATURE_VERSION,
  FEATURE_NAMES,
  type PastAppointmentSummary,
} from "./ml/feature-extractor";
import {
  train,
  predictOne,
  trainTestSplit,
  evaluate,
  type TrainedModel,
} from "./ml/logistic-regression";

/** Risk prediction result for a single appointment. */
export interface NoShowPrediction {
  appointmentId: string;
  riskScore: number; // 0.0–1.0
  riskLevel: "low" | "medium" | "high";
  factors: string[]; // human-readable reason strings
  recommendation: string; // what front desk should do
  /** Which model produced this score — "ml" when weights were loaded, "rules" when falling back. */
  source: "ml" | "rules";
}

/** Format of the persisted weights file. */
export interface PersistedModel {
  version: number;
  featureNames: readonly string[];
  trainedAt: string;
  /** Number of samples used for training. */
  nTrain: number;
  /** Number of samples used for held-out evaluation. */
  nTest: number;
  /** Log-loss on the test set (lower is better). */
  testLogLoss: number;
  /** Accuracy @ 0.5 on the test set. */
  testAccuracy: number;
  /** The trained model itself. */
  model: TrainedModel;
}

const DEFAULT_WEIGHTS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "ml",
  "no-show-weights.json"
);

/** Resolve the weights path.  Honours NOSHOW_WEIGHTS_PATH (used by tests /
 *  deployments that want to pin a location) and otherwise defaults to
 *  `apps/api/data/ml/no-show-weights.json`. */
function getWeightsPath(): string {
  return process.env.NOSHOW_WEIGHTS_PATH || DEFAULT_WEIGHTS_PATH;
}

// In-process cache so we don't re-read the JSON file on every predict call.
let _cached: PersistedModel | null | undefined = undefined;
let _cachedPath: string | null = null;

/**
 * Load the persisted weights from disk.  Returns null if the file is missing
 * or the feature version does not match the current extractor.  Results are
 * cached in-process; call {@link resetNoShowModelCache} to force a reload.
 */
export async function loadModel(
  filePath: string = getWeightsPath()
): Promise<PersistedModel | null> {
  if (_cached !== undefined && _cachedPath === filePath) return _cached;
  _cachedPath = filePath;
  try {
    const buf = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(buf) as PersistedModel;
    if (parsed.version !== NO_SHOW_FEATURE_VERSION) {
      _cached = null;
      return null;
    }
    _cached = parsed;
    return parsed;
  } catch {
    _cached = null;
    return null;
  }
}

/** Clear the in-process model cache.  Exposed for tests and after retrain. */
export function resetNoShowModelCache(): void {
  _cached = undefined;
  _cachedPath = null;
}

/** Score using the legacy rule-based logic (used as a fallback). */
function ruleBasedScore(input: {
  pastAppointments: PastAppointmentSummary[];
  leadTimeDays: number;
  dayOfWeek: number;
  hourOfDay: number;
  isNewPatient: boolean;
  hasRecentNoShow: boolean;
}): number {
  const { pastAppointments, leadTimeDays, dayOfWeek, hourOfDay, isNewPatient, hasRecentNoShow } =
    input;
  let historicalNoShowRate: number;
  if (pastAppointments.length < 5) {
    historicalNoShowRate = 0.1;
  } else {
    const noShowCount = pastAppointments.filter((a) => a.status === "NO_SHOW").length;
    historicalNoShowRate = noShowCount / pastAppointments.length;
  }
  let score = historicalNoShowRate * 0.4;
  if (leadTimeDays > 14) score += 0.15;
  else if (leadTimeDays > 7) score += 0.08;
  if (dayOfWeek === 1) score += 0.05;
  if (dayOfWeek === 5) score += 0.05;
  if (hourOfDay >= 17) score += 0.08;
  if (hourOfDay <= 8) score += 0.05;
  if (isNewPatient) score += 0.05;
  if (hasRecentNoShow) score += 0.2;
  return Math.min(score, 1.0);
}

function recommendationFor(level: "low" | "medium" | "high"): string {
  if (level === "low") return "No action needed";
  if (level === "medium") return "Send a reminder call";
  return "Call patient to confirm + book a backup slot";
}

/**
 * Score the no-show risk for a single appointment.
 *
 * If a trained ML model is present on disk the logistic regression prediction
 * is used; otherwise a rule-based fallback is applied so the service degrades
 * gracefully.  The function signature is unchanged from the previous
 * rule-based version.
 *
 * @param appointmentId UUID of the appointment to score.
 */
export async function predictNoShow(appointmentId: string): Promise<NoShowPrediction> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true },
  });
  if (!appointment) {
    throw new Error(`Appointment ${appointmentId} not found`);
  }

  const now = new Date();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

  const pastAppointments = await prisma.appointment.findMany({
    where: {
      patientId: appointment.patientId,
      id: { not: appointmentId },
      date: { gte: twelveMonthsAgo },
    },
    select: { status: true, date: true },
  });

  const featureInput = {
    createdAt: appointment.createdAt,
    date: appointment.date,
    slotStart: appointment.slotStart,
    type: appointment.type as string,
    patientAge: appointment.patient?.age ?? null,
    patientAddress: appointment.patient?.address ?? null,
    distanceKm: null,
    pastAppointments: pastAppointments.map((p) => ({
      status: p.status as string,
      date: p.date,
    })),
  };

  const features = extractFeatures(featureInput, now);
  const factors = explainFeatures(featureInput, now);

  const model = await loadModel();
  let score: number;
  let source: "ml" | "rules";
  if (model) {
    score = predictOne(features, model.model);
    source = "ml";
  } else {
    // Fallback to legacy rule-based scoring
    const apptDate = new Date(appointment.date);
    const createdAt = new Date(appointment.createdAt);
    const leadTimeDays = Math.max(
      0,
      Math.floor((apptDate.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
    );
    let hourOfDay = 12;
    if (appointment.slotStart) {
      hourOfDay = parseInt(appointment.slotStart.split(":")[0], 10);
      if (Number.isNaN(hourOfDay)) hourOfDay = 12;
    }
    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const hasRecentNoShow = pastAppointments.some(
      (a) => a.status === "NO_SHOW" && new Date(a.date) >= sixtyDaysAgo
    );
    score = ruleBasedScore({
      pastAppointments: pastAppointments.map((p) => ({
        status: p.status as string,
        date: p.date,
      })),
      leadTimeDays,
      dayOfWeek: apptDate.getDay(),
      hourOfDay,
      isNewPatient: pastAppointments.length < 3,
      hasRecentNoShow,
    });
    source = "rules";
  }

  const level = riskBucket(score);

  return {
    appointmentId,
    riskScore: Math.round(score * 1000) / 1000,
    riskLevel: level,
    factors,
    recommendation: recommendationFor(level),
    source,
  };
}

/**
 * Score all BOOKED appointments on a given calendar date, sorted by risk
 * score descending so the front desk can prioritise outreach calls.
 *
 * @param date ISO date string (YYYY-MM-DD).
 */
export async function batchPredictNoShow(date: string): Promise<NoShowPrediction[]> {
  const dateObj = new Date(date);
  const bookedAppointments = await prisma.appointment.findMany({
    where: { date: dateObj, status: "BOOKED" },
    select: { id: true },
  });

  const predictions = await Promise.all(
    bookedAppointments.map((appt) => predictNoShow(appt.id))
  );
  return predictions.sort((a, b) => b.riskScore - a.riskScore);
}

/** Summary returned from {@link trainModel}. */
export interface TrainModelResult {
  nSamples: number;
  nTrain: number;
  nTest: number;
  initialLoss: number;
  finalLoss: number;
  testLogLoss: number;
  testAccuracy: number;
  savedTo: string;
  epochsRan: number;
}

/**
 * Train a new no-show model from the last `monthsBack` months of history,
 * persist it to disk, and return a summary of the run.  Designed to be
 * invoked from a cron task / admin script — not during a request.
 *
 * The training set is restricted to appointments whose outcome is observable
 * (COMPLETED, CANCELLED, NO_SHOW) — BOOKED/IN_CONSULTATION are ignored.
 * Labels are 1 when `status = NO_SHOW` and 0 otherwise.
 *
 * @param monthsBack How many months of history to pull.  Defaults to 6.
 * @param opts       Optional override for the persistence path (tests pass a
 *                   temp dir here) and LR hyperparameters.
 */
export async function trainModel(
  monthsBack: number = 6,
  opts: {
    weightsPath?: string;
    learningRate?: number;
    epochs?: number;
    l2?: number;
    seed?: number;
  } = {}
): Promise<TrainModelResult> {
  const weightsPath = opts.weightsPath ?? getWeightsPath();
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);

  const rows = await prisma.appointment.findMany({
    where: {
      date: { gte: since },
      status: { in: ["COMPLETED", "CANCELLED", "NO_SHOW"] as any },
    },
    include: { patient: true },
  });

  if (rows.length < 20) {
    throw new Error(
      `trainModel: not enough training data (${rows.length} labelled appointments; need at least 20)`
    );
  }

  // Build a patient → past-appointment-summary lookup so we can compute the
  // history features without an O(N) prisma round-trip per row.
  const patientHistory = new Map<string, PastAppointmentSummary[]>();
  for (const r of rows) {
    if (!patientHistory.has(r.patientId)) patientHistory.set(r.patientId, []);
    patientHistory.get(r.patientId)!.push({
      status: r.status as string,
      date: r.date,
    });
  }

  const X: number[][] = [];
  const y: number[] = [];

  for (const r of rows) {
    const past = (patientHistory.get(r.patientId) ?? []).filter(
      (h) => +new Date(h.date) !== +new Date(r.date) || h.status !== r.status
    );
    const feats = extractFeatures(
      {
        createdAt: r.createdAt,
        date: r.date,
        slotStart: r.slotStart,
        type: r.type as string,
        patientAge: r.patient?.age ?? null,
        patientAddress: r.patient?.address ?? null,
        distanceKm: null,
        pastAppointments: past,
      },
      new Date(r.date) // "now" relative to this appointment
    );
    if (feats.length !== NUM_FEATURES) {
      throw new Error(
        `trainModel: feature length mismatch (got ${feats.length}, expected ${NUM_FEATURES})`
      );
    }
    X.push(feats);
    y.push(r.status === "NO_SHOW" ? 1 : 0);
  }

  const { XTrain, yTrain, XTest, yTest } = trainTestSplit(X, y, 0.2, opts.seed ?? 42);

  const model = train(XTrain, yTrain, {
    learningRate: opts.learningRate ?? 0.1,
    epochs: opts.epochs ?? 1000,
    l2: opts.l2 ?? 0.01,
    standardize: true,
    fitIntercept: true,
  });

  const metrics = evaluate(XTest, yTest, model);

  const toPersist: PersistedModel = {
    version: NO_SHOW_FEATURE_VERSION,
    featureNames: FEATURE_NAMES,
    trainedAt: new Date().toISOString(),
    nTrain: XTrain.length,
    nTest: XTest.length,
    testLogLoss: metrics.logLoss,
    testAccuracy: metrics.accuracy,
    model,
  };

  await fs.mkdir(path.dirname(weightsPath), { recursive: true });
  await fs.writeFile(weightsPath, JSON.stringify(toPersist, null, 2), "utf8");

  // Invalidate cache so next predict call picks up the new weights
  resetNoShowModelCache();

  return {
    nSamples: X.length,
    nTrain: XTrain.length,
    nTest: XTest.length,
    initialLoss: model.initialLoss,
    finalLoss: model.finalLoss,
    testLogLoss: metrics.logLoss,
    testAccuracy: metrics.accuracy,
    savedTo: weightsPath,
    epochsRan: model.epochs,
  };
}
