// Holt-Winters triple exponential smoothing.
//
// Reference: "Forecasting: Principles and Practice" (Hyndman & Athanasopoulos),
// chapter 7.3 — additive Holt-Winters method.  All computation is in plain
// TypeScript; there are no external math dependencies.
//
// Two flavours are supported:
//   - period = 7  → weekly seasonality
//   - period = 12 → monthly seasonality
//   - period = 0  → seasonality disabled (double exp smoothing only)
//
// Prediction intervals follow the standard "additive errors" approximation:
// PI = forecast +/- z * sigma * sqrt(h), where sigma is the residual SD on
// the training set.

/** Parameters controlling the Holt-Winters fit. */
export interface HoltWintersOptions {
  /** Seasonal period (7 for weekly, 12 for monthly, 0 to disable). */
  period?: number;
  /** Level smoothing parameter in (0, 1).  Default 0.3. */
  alpha?: number;
  /** Trend smoothing parameter in (0, 1).  Default 0.1. */
  beta?: number;
  /** Seasonal smoothing parameter in (0, 1).  Default 0.1. */
  gamma?: number;
  /** Z-score for the prediction interval.  Default 1.96 (approx 95%). */
  z?: number;
  /**
   * If true and period > 0, fit is done with a multiplicative seasonal
   * component (better for series whose amplitude scales with level).
   * Defaults to false (additive).
   */
  multiplicative?: boolean;
}

/** A single forecasted point along with its prediction interval. */
export interface ForecastPoint {
  /** The point forecast. */
  yhat: number;
  /** Lower bound of the prediction interval. */
  lower: number;
  /** Upper bound of the prediction interval. */
  upper: number;
}

/** Result of a Holt-Winters fit and forecast. */
export interface HoltWintersResult {
  /** Forecasted values (length = horizon). */
  forecast: ForecastPoint[];
  /** Final level after training. */
  level: number;
  /** Final trend after training. */
  trend: number;
  /** Final seasonal components (empty when period = 0). */
  seasonal: number[];
  /** Residual standard deviation used for the prediction interval. */
  sigma: number;
  /** One-step-ahead fitted values over the training series (length = series length). */
  fitted: number[];
}

const DEFAULTS = {
  period: 0,
  alpha: 0.3,
  beta: 0.1,
  gamma: 0.1,
  z: 1.96,
  multiplicative: false,
};

/** Seed the level, trend and initial seasonal components from the training data. */
function seedComponents(
  series: number[],
  period: number,
  multiplicative: boolean
): { level: number; trend: number; seasonal: number[] } {
  if (period <= 1) {
    // No seasonality — level = first point, trend = mean first-diff.
    const level = series[0];
    let trend = 0;
    if (series.length >= 2) {
      let sum = 0;
      for (let i = 1; i < series.length; i++) sum += series[i] - series[i - 1];
      trend = sum / (series.length - 1);
    }
    return { level, trend, seasonal: [] };
  }

  // Need at least 2 full seasons to seed reasonably; otherwise fall back to
  // zero seasonal offsets (additive) / 1.0 (multiplicative).
  const seasonsAvail = Math.floor(series.length / period);
  if (seasonsAvail < 2) {
    const level = series.slice(0, period).reduce((s, v) => s + v, 0) / period;
    const seasonal: number[] = new Array(period).fill(multiplicative ? 1 : 0);
    return { level, trend: 0, seasonal };
  }

  // Seasonal averages: average over all complete seasons
  const seasonMeans: number[] = new Array(seasonsAvail).fill(0);
  for (let s = 0; s < seasonsAvail; s++) {
    let sum = 0;
    for (let i = 0; i < period; i++) sum += series[s * period + i];
    seasonMeans[s] = sum / period;
  }

  // Trend: mean difference between consecutive season means, normalised to one step
  let trend = 0;
  for (let s = 1; s < seasonsAvail; s++) trend += seasonMeans[s] - seasonMeans[s - 1];
  trend /= period * (seasonsAvail - 1);

  // Level = first season mean
  const level = seasonMeans[0];

  // Seasonal components: average of (value - seasonMean) [additive] or
  // (value / seasonMean) [multiplicative] over all seasons.
  const seasonal: number[] = new Array(period).fill(0);
  for (let i = 0; i < period; i++) {
    let sum = 0;
    let n = 0;
    for (let s = 0; s < seasonsAvail; s++) {
      const v = series[s * period + i];
      const mean = seasonMeans[s];
      if (multiplicative) {
        if (mean !== 0) {
          sum += v / mean;
          n++;
        }
      } else {
        sum += v - mean;
        n++;
      }
    }
    seasonal[i] = n > 0 ? sum / n : multiplicative ? 1 : 0;
  }

  return { level, trend, seasonal };
}

/**
 * Fit a Holt-Winters model on a univariate time series and forecast `horizon`
 * steps ahead with prediction intervals.
 *
 * @param series   The historical series, oldest to newest.  Must have length >= 2.
 * @param horizon  Number of future points to forecast.  Must be >= 1.
 * @param opts     Model hyperparameters (alpha/beta/gamma, seasonal period).
 * @returns A {@link HoltWintersResult} with the forecast plus fitted values.
 */
export function holtWinters(
  series: number[],
  horizon: number,
  opts: HoltWintersOptions = {}
): HoltWintersResult {
  if (!Array.isArray(series) || series.length < 2) {
    throw new Error("holtWinters: series must have at least 2 points");
  }
  if (horizon < 1) throw new Error("holtWinters: horizon must be >= 1");

  const alpha = opts.alpha ?? DEFAULTS.alpha;
  const beta = opts.beta ?? DEFAULTS.beta;
  const gamma = opts.gamma ?? DEFAULTS.gamma;
  const z = opts.z ?? DEFAULTS.z;
  const period = opts.period ?? DEFAULTS.period;
  const multiplicative = opts.multiplicative ?? DEFAULTS.multiplicative;

  const hasSeason = period > 1;

  // Seed components from the series
  let { level, trend, seasonal } = seedComponents(series, hasSeason ? period : 0, multiplicative);

  // Prepare arrays for fitted values + residuals
  const fitted: number[] = new Array(series.length).fill(0);
  const residuals: number[] = [];

  // Start the smoothing recursion.  If we have period, we already consumed
  // roughly one season of data to seed; iterate over the full series for
  // simplicity — the in-sample fit will just adjust the components quickly.
  for (let t = 0; t < series.length; t++) {
    const y = series[t];
    const sIdx = hasSeason ? ((t % period) + period) % period : -1;
    const sComp = hasSeason ? seasonal[sIdx] : multiplicative ? 1 : 0;

    // One-step-ahead forecast for fitted[t] using previous state
    let yhat: number;
    if (hasSeason) {
      yhat = multiplicative ? (level + trend) * sComp : level + trend + sComp;
    } else {
      yhat = level + trend;
    }
    fitted[t] = yhat;
    residuals.push(y - yhat);

    // Update level, trend, seasonal
    const levelPrev = level;
    if (hasSeason) {
      if (multiplicative) {
        level = (alpha * y) / (sComp || 1) + (1 - alpha) * (levelPrev + trend);
      } else {
        level = alpha * (y - sComp) + (1 - alpha) * (levelPrev + trend);
      }
    } else {
      level = alpha * y + (1 - alpha) * (levelPrev + trend);
    }
    trend = beta * (level - levelPrev) + (1 - beta) * trend;
    if (hasSeason) {
      if (multiplicative) {
        seasonal[sIdx] = (gamma * y) / (level || 1) + (1 - gamma) * sComp;
      } else {
        seasonal[sIdx] = gamma * (y - level) + (1 - gamma) * sComp;
      }
    }
  }

  // Residual sigma (skip first `period` observations as warm-up when seasonal)
  const warmup = hasSeason ? Math.min(period, residuals.length - 1) : 0;
  const usable = residuals.slice(warmup);
  let sigma = 0;
  if (usable.length > 1) {
    const mean = usable.reduce((s, v) => s + v, 0) / usable.length;
    const varr = usable.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (usable.length - 1);
    sigma = Math.sqrt(varr);
  }

  // Forecast the horizon
  const forecast: ForecastPoint[] = [];
  const nSeries = series.length;
  for (let h = 1; h <= horizon; h++) {
    let yhat: number;
    if (hasSeason) {
      const sIdx = ((nSeries + h - 1) % period + period) % period;
      const sComp = seasonal[sIdx];
      yhat = multiplicative ? (level + h * trend) * sComp : level + h * trend + sComp;
    } else {
      yhat = level + h * trend;
    }
    const pi = z * sigma * Math.sqrt(h);
    forecast.push({
      yhat,
      lower: yhat - pi,
      upper: yhat + pi,
    });
  }

  return {
    forecast,
    level,
    trend,
    seasonal: [...seasonal],
    sigma,
    fitted,
  };
}

/**
 * Convenience wrapper: sum the point forecast over `horizon` days.  Useful
 * for computing total expected demand over a reorder horizon.  Returns the
 * summed point forecast plus summed lower/upper interval bounds (note that
 * summing independent intervals over-estimates the uncertainty — this is
 * conservative by design for stockout decisions).
 */
export function sumForecast(result: HoltWintersResult): {
  yhat: number;
  lower: number;
  upper: number;
} {
  let yhat = 0;
  let lower = 0;
  let upper = 0;
  for (const p of result.forecast) {
    yhat += p.yhat;
    lower += p.lower;
    upper += p.upper;
  }
  return { yhat, lower, upper };
}
