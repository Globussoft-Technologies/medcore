import { describe, it, expect } from "vitest";
import {
  sigmoid,
  train,
  predict,
  predictOne,
  evaluate,
  trainTestSplit,
  computeStandardization,
  applyStandardization,
} from "./logistic-regression";

// Deterministic PRNG for reproducible synthetic datasets (linear congruential)
function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Generate a 2-D linearly separable synthetic dataset.
 *  y = 1 iff (2*x1 - x2 + 0.5 > 0) with small Gaussian noise. */
function makeSeparableDataset(n: number, seed: number) {
  const rng = makeRng(seed);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const x1 = rng() * 4 - 2;
    const x2 = rng() * 4 - 2;
    const raw = 2 * x1 - x2 + 0.5;
    const noise = (rng() - 0.5) * 0.05;
    y.push(raw + noise > 0 ? 1 : 0);
    X.push([x1, x2]);
  }
  return { X, y };
}

describe("sigmoid", () => {
  it("returns 0.5 for z=0", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
  });

  it("saturates near 1 for large positive z without overflow", () => {
    const v = sigmoid(1000);
    expect(v).toBeGreaterThan(0.999999);
    expect(v).toBeLessThanOrEqual(1);
    expect(Number.isFinite(v)).toBe(true);
  });

  it("saturates near 0 for large negative z without producing NaN", () => {
    const v = sigmoid(-1000);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1e-6);
    expect(Number.isFinite(v)).toBe(true);
  });

  it("is symmetric about 0", () => {
    for (const z of [0.5, 1, 2, 5]) {
      expect(sigmoid(z) + sigmoid(-z)).toBeCloseTo(1, 10);
    }
  });
});

describe("standardization", () => {
  it("computes mean and std correctly and yields zero-mean/unit-var columns", () => {
    const X = [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ];
    const { mean, std } = computeStandardization(X);
    expect(mean[0]).toBeCloseTo(2.5);
    expect(mean[1]).toBeCloseTo(25);
    const Xs = applyStandardization(X, mean, std);
    const colMeans = [0, 0];
    for (const r of Xs) {
      colMeans[0] += r[0];
      colMeans[1] += r[1];
    }
    expect(Math.abs(colMeans[0])).toBeLessThan(1e-10);
    expect(Math.abs(colMeans[1])).toBeLessThan(1e-10);
  });

  it("handles zero-variance columns without NaN", () => {
    const X = [
      [1, 5],
      [2, 5],
      [3, 5],
    ];
    const { std } = computeStandardization(X);
    expect(std[1]).toBe(1); // fallback to 1
    const Xs = applyStandardization(X, [2, 5], std);
    for (const r of Xs) expect(r[1]).toBe(0);
  });
});

describe("train — convergence", () => {
  it("decreases loss between the first and last epoch", () => {
    const { X, y } = makeSeparableDataset(200, 7);
    const m = train(X, y, { epochs: 300, learningRate: 0.1 });
    expect(m.finalLoss).toBeLessThan(m.initialLoss);
  });

  it("achieves >= 90% accuracy on a separable synthetic dataset", () => {
    const { X, y } = makeSeparableDataset(300, 11);
    const split = trainTestSplit(X, y, 0.25, 3);
    const m = train(split.XTrain, split.yTrain, { epochs: 1500, learningRate: 0.1, l2: 0 });
    const probs = predict(split.XTest, m);
    let correct = 0;
    for (let i = 0; i < probs.length; i++) {
      const pred = probs[i] >= 0.5 ? 1 : 0;
      if (pred === split.yTest[i]) correct++;
    }
    const acc = correct / probs.length;
    expect(acc).toBeGreaterThanOrEqual(0.9);
  });

  it("learns weights whose sign matches the ground-truth coefficients", () => {
    // Ground truth: 2*x1 - x2 + 0.5 > 0, so weight on x1 should be positive,
    // weight on x2 should be negative.
    const { X, y } = makeSeparableDataset(500, 13);
    const m = train(X, y, { epochs: 2000, learningRate: 0.1 });
    expect(m.weights[0]).toBeGreaterThan(0);
    expect(m.weights[1]).toBeLessThan(0);
  });

  it("respects the L2 penalty (higher l2 → smaller weight norms)", () => {
    const { X, y } = makeSeparableDataset(300, 21);
    const low = train(X, y, { epochs: 500, learningRate: 0.1, l2: 0 });
    const high = train(X, y, { epochs: 500, learningRate: 0.1, l2: 5 });
    const norm = (w: number[]) => Math.sqrt(w.reduce((s, v) => s + v * v, 0));
    expect(norm(high.weights)).toBeLessThan(norm(low.weights));
  });

  it("triggers early stopping when the tolerance is easily satisfied", () => {
    const { X, y } = makeSeparableDataset(50, 5);
    const m = train(X, y, {
      epochs: 2000,
      learningRate: 0.05,
      tolerance: 10, // absurdly loose → will stop within a few epochs
    });
    expect(m.epochs).toBeLessThan(20);
  });
});

describe("predict / predictOne", () => {
  it("returns probabilities in [0, 1]", () => {
    const { X, y } = makeSeparableDataset(100, 2);
    const m = train(X, y, { epochs: 200 });
    for (const p of predict(X, m)) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("predictOne is equivalent to predict([x])[0]", () => {
    const { X, y } = makeSeparableDataset(80, 8);
    const m = train(X, y, { epochs: 100 });
    for (let i = 0; i < 10; i++) {
      expect(predictOne(X[i], m)).toBeCloseTo(predict([X[i]], m)[0], 12);
    }
  });

  it("supports the legacy raw-weights calling convention", () => {
    // Two features, weights [1, -1], intercept 0 (implicit), no standardisation
    const p = predict([[2, 0]], [1, -1]);
    expect(p[0]).toBeCloseTo(sigmoid(2), 12);
  });
});

describe("evaluate", () => {
  it("reports test metrics with non-NaN log-loss and accuracy in [0,1]", () => {
    const { X, y } = makeSeparableDataset(200, 4);
    const split = trainTestSplit(X, y, 0.3, 9);
    const m = train(split.XTrain, split.yTrain, { epochs: 500, learningRate: 0.1 });
    const ev = evaluate(split.XTest, split.yTest, m);
    expect(Number.isFinite(ev.logLoss)).toBe(true);
    expect(ev.accuracy).toBeGreaterThanOrEqual(0);
    expect(ev.accuracy).toBeLessThanOrEqual(1);
    expect(ev.tp + ev.fp + ev.tn + ev.fn).toBe(split.XTest.length);
  });
});

describe("trainTestSplit", () => {
  it("partitions all samples and preserves pairing", () => {
    const X = Array.from({ length: 50 }, (_, i) => [i]);
    const y = Array.from({ length: 50 }, (_, i) => i % 2);
    const split = trainTestSplit(X, y, 0.2, 1);
    expect(split.XTrain.length + split.XTest.length).toBe(50);
    expect(split.yTrain.length).toBe(split.XTrain.length);
    expect(split.yTest.length).toBe(split.XTest.length);
    // Labels must still match their rows: row[0] has the same parity as label
    for (let i = 0; i < split.XTrain.length; i++) {
      expect(split.XTrain[i][0] % 2).toBe(split.yTrain[i]);
    }
  });

  it("is deterministic for the same seed", () => {
    const X = Array.from({ length: 30 }, (_, i) => [i]);
    const y = Array.from({ length: 30 }, (_, i) => i % 2);
    const a = trainTestSplit(X, y, 0.3, 7);
    const b = trainTestSplit(X, y, 0.3, 7);
    expect(a.XTrain).toEqual(b.XTrain);
    expect(a.XTest).toEqual(b.XTest);
  });
});
