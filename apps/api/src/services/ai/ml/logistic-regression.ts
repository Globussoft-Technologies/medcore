// Pure-TypeScript logistic regression implementation.
//
// Implements batch gradient descent with optional L2 regularisation and a
// numerically stable sigmoid.  Designed for small-to-medium feature sets
// (< 100 features, < 100k samples) that fit in a single Node process
// memory footprint — enough for MedCore's appointment history.
//
// No external ML/math dependencies are used; everything is implemented with
// plain `number[]` arrays so the model artifact is trivially serialisable
// to JSON for on-disk persistence.

/** Options controlling the training loop. */
export interface TrainOptions {
  /** Step size for gradient descent.  Default 0.05. */
  learningRate?: number;
  /** Number of full passes over the training set.  Default 500. */
  epochs?: number;
  /** L2 regularisation strength (ridge penalty).  Default 0 (no penalty). */
  l2?: number;
  /** If true, z-score standardise features before training.  Default true. */
  standardize?: boolean;
  /** Include an intercept (bias) term.  Default true. */
  fitIntercept?: boolean;
  /**
   * Early-stopping tolerance on loss delta between epochs.  When set, the
   * loop stops if |lossPrev - lossCurr| < tolerance for 3 consecutive epochs.
   * Default 1e-7.
   */
  tolerance?: number;
}

/** Trained logistic regression model.  All fields are plain JSON-safe values. */
export interface TrainedModel {
  /** Learned coefficients (one per feature, in the original feature order). */
  weights: number[];
  /** Learned intercept.  Always 0 when `fitIntercept: false`. */
  intercept: number;
  /** Per-feature mean used during standardisation; `null` if disabled. */
  mean: number[] | null;
  /** Per-feature standard deviation used during standardisation. */
  std: number[] | null;
  /** Log-loss on the training set at the final epoch. */
  finalLoss: number;
  /** Loss at epoch 0, useful for monitoring convergence. */
  initialLoss: number;
  /** Number of epochs actually performed (may be < requested if early-stop). */
  epochs: number;
}

const DEFAULTS = {
  learningRate: 0.05,
  epochs: 500,
  l2: 0,
  standardize: true,
  fitIntercept: true,
  tolerance: 1e-7,
};

/**
 * Numerically stable logistic sigmoid.  For large |z| the naive
 * `1 / (1 + exp(-z))` overflows; this branch avoids that by computing
 * `exp(z) / (1 + exp(z))` when z is negative.
 */
export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Compute per-feature mean and standard deviation for a feature matrix.
 * Columns with zero variance get a std of 1 to avoid division-by-zero
 * (the resulting standardised column will be all zeros).
 */
export function computeStandardization(X: number[][]): { mean: number[]; std: number[] } {
  if (X.length === 0) return { mean: [], std: [] };
  const nFeatures = X[0].length;
  const mean = new Array<number>(nFeatures).fill(0);
  const std = new Array<number>(nFeatures).fill(0);

  for (const row of X) {
    for (let j = 0; j < nFeatures; j++) mean[j] += row[j];
  }
  for (let j = 0; j < nFeatures; j++) mean[j] /= X.length;

  for (const row of X) {
    for (let j = 0; j < nFeatures; j++) {
      const d = row[j] - mean[j];
      std[j] += d * d;
    }
  }
  for (let j = 0; j < nFeatures; j++) {
    std[j] = Math.sqrt(std[j] / X.length);
    if (std[j] < 1e-12) std[j] = 1; // avoid divide-by-zero
  }
  return { mean, std };
}

/** Apply an existing mean/std to a feature matrix. */
export function applyStandardization(
  X: number[][],
  mean: number[],
  std: number[]
): number[][] {
  return X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
}

/**
 * Train a logistic regression classifier via batch gradient descent.
 *
 * @param X  Feature matrix, shape [nSamples, nFeatures].  All rows must have
 *           the same length.
 * @param y  Binary labels (0 or 1), length nSamples.
 * @param opts  Training hyperparameters.  See {@link TrainOptions}.
 * @returns A {@link TrainedModel} containing the weights, intercept and the
 *          standardisation statistics that must be re-applied at inference
 *          time.
 */
export function train(X: number[][], y: number[], opts: TrainOptions = {}): TrainedModel {
  if (X.length === 0) throw new Error("train: X must contain at least one sample");
  if (X.length !== y.length) {
    throw new Error(`train: X and y length mismatch (${X.length} vs ${y.length})`);
  }

  const learningRate = opts.learningRate ?? DEFAULTS.learningRate;
  const epochs = opts.epochs ?? DEFAULTS.epochs;
  const l2 = opts.l2 ?? DEFAULTS.l2;
  const standardize = opts.standardize ?? DEFAULTS.standardize;
  const fitIntercept = opts.fitIntercept ?? DEFAULTS.fitIntercept;
  const tolerance = opts.tolerance ?? DEFAULTS.tolerance;

  const nSamples = X.length;
  const nFeatures = X[0].length;

  // Feature standardisation
  let Xs = X;
  let mean: number[] | null = null;
  let std: number[] | null = null;
  if (standardize) {
    const s = computeStandardization(X);
    mean = s.mean;
    std = s.std;
    Xs = applyStandardization(X, mean, std);
  }

  // Init weights to zero (with small perturbation would also work; zeros are
  // fine for logistic regression because the problem is convex).
  const weights = new Array<number>(nFeatures).fill(0);
  let intercept = 0;

  let initialLoss = Infinity;
  let prevLoss = Infinity;
  let stableCount = 0;
  let finalLoss = 0;
  let epochsRan = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Forward pass: compute predictions + gradient accumulators in one sweep.
    const gradW = new Array<number>(nFeatures).fill(0);
    let gradB = 0;
    let loss = 0;

    for (let i = 0; i < nSamples; i++) {
      const row = Xs[i];
      let z = intercept;
      for (let j = 0; j < nFeatures; j++) z += weights[j] * row[j];
      const p = sigmoid(z);
      const err = p - y[i]; // derivative of BCE w.r.t. z

      for (let j = 0; j < nFeatures; j++) gradW[j] += err * row[j];
      if (fitIntercept) gradB += err;

      // Clamped log-loss for numerical stability when computing the metric
      const pClamped = Math.max(1e-15, Math.min(1 - 1e-15, p));
      loss += -(y[i] * Math.log(pClamped) + (1 - y[i]) * Math.log(1 - pClamped));
    }

    loss /= nSamples;
    if (l2 > 0) {
      let reg = 0;
      for (let j = 0; j < nFeatures; j++) reg += weights[j] * weights[j];
      loss += (l2 / (2 * nSamples)) * reg;
    }

    if (epoch === 0) initialLoss = loss;
    finalLoss = loss;
    epochsRan = epoch + 1;

    // Update: w <- w - lr * (gradW/n + l2*w/n), b <- b - lr * gradB/n
    for (let j = 0; j < nFeatures; j++) {
      const g = gradW[j] / nSamples + (l2 * weights[j]) / nSamples;
      weights[j] -= learningRate * g;
    }
    if (fitIntercept) intercept -= (learningRate * gradB) / nSamples;

    // Early stopping
    if (Math.abs(prevLoss - loss) < tolerance) {
      stableCount++;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
    }
    prevLoss = loss;
  }

  return {
    weights,
    intercept,
    mean,
    std,
    finalLoss,
    initialLoss,
    epochs: epochsRan,
  };
}

/**
 * Compute predicted probabilities for a feature matrix given a trained model.
 * The input matrix is standardised using the model's stored mean/std before
 * applying the learned weights.
 *
 * @param X      Feature matrix, shape [nSamples, nFeatures].
 * @param model  The {@link TrainedModel} returned from {@link train}.  The
 *               function also accepts a raw `number[]` weight vector for
 *               backwards-compatibility, in which case no standardisation and
 *               no intercept are applied.
 * @returns Array of probabilities in [0, 1], length nSamples.
 */
export function predict(
  X: number[][],
  model: TrainedModel | number[]
): number[] {
  if (X.length === 0) return [];

  // Back-compat path: raw weights with no intercept, no standardisation.
  if (Array.isArray(model)) {
    return X.map((row) => {
      let z = 0;
      for (let j = 0; j < row.length && j < model.length; j++) z += row[j] * model[j];
      return sigmoid(z);
    });
  }

  let Xs = X;
  if (model.mean && model.std) {
    Xs = applyStandardization(X, model.mean, model.std);
  }

  return Xs.map((row) => {
    let z = model.intercept;
    for (let j = 0; j < row.length && j < model.weights.length; j++) {
      z += row[j] * model.weights[j];
    }
    return sigmoid(z);
  });
}

/**
 * Convenience wrapper for scoring a single sample.  Returns the same value
 * as `predict([x], model)[0]`.
 */
export function predictOne(x: number[], model: TrainedModel | number[]): number {
  return predict([x], model)[0];
}

/**
 * Split a dataset into train/test partitions using a simple deterministic
 * shuffle (linear-congruential generator seeded by `seed`).  Keeping the
 * split deterministic lets model training produce the same weights across
 * runs, which is important for golden tests.
 */
export function trainTestSplit<T>(
  X: T[],
  y: number[],
  testSize = 0.2,
  seed = 42
): { XTrain: T[]; yTrain: number[]; XTest: T[]; yTest: number[] } {
  if (X.length !== y.length) {
    throw new Error("trainTestSplit: X and y length mismatch");
  }
  const n = X.length;
  const indices = Array.from({ length: n }, (_, i) => i);

  // Deterministic LCG shuffle
  let state = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const testCount = Math.max(1, Math.floor(n * testSize));
  const testIdx = new Set(indices.slice(0, testCount));

  const XTrain: T[] = [];
  const yTrain: number[] = [];
  const XTest: T[] = [];
  const yTest: number[] = [];
  for (let i = 0; i < n; i++) {
    if (testIdx.has(i)) {
      XTest.push(X[i]);
      yTest.push(y[i]);
    } else {
      XTrain.push(X[i]);
      yTrain.push(y[i]);
    }
  }
  return { XTrain, yTrain, XTest, yTest };
}

/**
 * Evaluate a trained model on a held-out set.  Returns log-loss, accuracy
 * at threshold 0.5, and a simple 2x2 confusion matrix.
 */
export function evaluate(
  X: number[][],
  y: number[],
  model: TrainedModel,
  threshold = 0.5
): { logLoss: number; accuracy: number; tp: number; fp: number; tn: number; fn: number } {
  const probs = predict(X, model);
  let logLoss = 0;
  let correct = 0;
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.max(1e-15, Math.min(1 - 1e-15, probs[i]));
    logLoss += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
    const pred = probs[i] >= threshold ? 1 : 0;
    if (pred === y[i]) correct++;
    if (pred === 1 && y[i] === 1) tp++;
    else if (pred === 1 && y[i] === 0) fp++;
    else if (pred === 0 && y[i] === 0) tn++;
    else fn++;
  }
  return {
    logLoss: logLoss / (probs.length || 1),
    accuracy: correct / (probs.length || 1),
    tp,
    fp,
    tn,
    fn,
  };
}
