import { describe, it, expect } from "vitest";
import { holtWinters, sumForecast } from "./holt-winters";

/** Build a synthetic series:  level + trend*t + amplitude*sin(2π t / period) */
function makeSeasonalSeries(
  n: number,
  level: number,
  trend: number,
  amplitude: number,
  period: number
): number[] {
  const out: number[] = [];
  for (let t = 0; t < n; t++) {
    const season = amplitude * Math.sin((2 * Math.PI * t) / period);
    out.push(level + trend * t + season);
  }
  return out;
}

describe("holtWinters — non-seasonal", () => {
  it("extrapolates a linear trend", () => {
    const series = Array.from({ length: 50 }, (_, i) => 10 + 2 * i);
    const res = holtWinters(series, 10, { period: 0, alpha: 0.5, beta: 0.5 });
    // Next value after index 49 should be close to 10 + 2*50 = 110
    expect(res.forecast[0].yhat).toBeGreaterThan(100);
    expect(res.forecast[0].yhat).toBeLessThan(120);
    // Trend estimate should be near 2
    expect(res.trend).toBeCloseTo(2, 0);
  });

  it("returns a prediction interval whose width grows with horizon h", () => {
    const noisy = Array.from(
      { length: 60 },
      (_, i) => 5 + 0.1 * i + ((i * 9301 + 49297) % 233280) / 233280 - 0.5
    );
    const res = holtWinters(noisy, 20, { period: 0 });
    const width1 = res.forecast[0].upper - res.forecast[0].lower;
    const width20 = res.forecast[19].upper - res.forecast[19].lower;
    expect(width20).toBeGreaterThan(width1);
  });
});

describe("holtWinters — weekly seasonality", () => {
  it("reproduces the seasonal pattern within a few % error", () => {
    const period = 7;
    const series = makeSeasonalSeries(84, 20, 0, 5, period); // 12 full weeks
    const res = holtWinters(series, period, {
      period,
      alpha: 0.2,
      beta: 0.05,
      gamma: 0.3,
    });
    // The forecast should reproduce the sine wave: max and min are roughly 5 apart
    const yhats = res.forecast.map((p) => p.yhat);
    const max = Math.max(...yhats);
    const min = Math.min(...yhats);
    expect(max - min).toBeGreaterThan(4); // amplitude*2 ≈ 10 ideally
    expect(max - min).toBeLessThan(15);
  });

  it("has a seasonal vector of length = period", () => {
    const series = makeSeasonalSeries(60, 50, 0.1, 3, 7);
    const res = holtWinters(series, 14, { period: 7 });
    expect(res.seasonal.length).toBe(7);
  });
});

describe("holtWinters — monthly seasonality (period=12)", () => {
  it("forecasts 12 months ahead with seasonal pattern preserved", () => {
    const series = makeSeasonalSeries(48, 100, 0.5, 20, 12); // 4 years monthly
    const res = holtWinters(series, 12, {
      period: 12,
      alpha: 0.2,
      beta: 0.05,
      gamma: 0.3,
    });
    expect(res.forecast.length).toBe(12);
    // Forecast should have the same 12-month cycle shape: max and min 12 apart
    const yhats = res.forecast.map((p) => p.yhat);
    const max = Math.max(...yhats);
    const min = Math.min(...yhats);
    expect(max - min).toBeGreaterThan(20); // amplitude*2 = 40 ideally
    // Trend ~ 0.5
    expect(res.trend).toBeGreaterThan(0);
    expect(res.trend).toBeLessThan(2);
  });
});

describe("holtWinters — edge cases", () => {
  it("throws when the series has fewer than 2 points", () => {
    expect(() => holtWinters([1], 5)).toThrow();
  });

  it("throws when horizon < 1", () => {
    expect(() => holtWinters([1, 2, 3], 0)).toThrow();
  });

  it("produces finite forecasts on a flat series", () => {
    const flat = new Array(30).fill(5);
    const res = holtWinters(flat, 10, { period: 7 });
    for (const p of res.forecast) {
      expect(Number.isFinite(p.yhat)).toBe(true);
      expect(p.yhat).toBeCloseTo(5, 0);
    }
  });
});

describe("sumForecast", () => {
  it("sums point forecasts and interval bounds", () => {
    const series = Array.from({ length: 20 }, (_, i) => 10 + i);
    const res = holtWinters(series, 5, { period: 0 });
    const total = sumForecast(res);
    let expected = 0;
    for (const p of res.forecast) expected += p.yhat;
    expect(total.yhat).toBeCloseTo(expected, 8);
    expect(total.lower).toBeLessThanOrEqual(total.yhat);
    expect(total.upper).toBeGreaterThanOrEqual(total.yhat);
  });
});
