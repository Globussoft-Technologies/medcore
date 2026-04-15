import { describe, it, expect } from "vitest";
import {
  computeVitalsFlags,
  computeVitalsFlagsWithBaseline,
} from "./vitals-analysis";

describe("computeVitalsFlags - BMI", () => {
  it("computes BMI for normal weight", () => {
    const r = computeVitalsFlags({ weight: 70, height: 175 });
    expect(r.bmi).toBeCloseTo(22.9, 1);
    expect(r.bmiCategory).toBe("Normal");
    expect(r.flags).not.toContain("ABNORMAL_BMI");
  });

  it("flags severely underweight as abnormal", () => {
    const r = computeVitalsFlags({ weight: 40, height: 175 });
    expect(r.bmiCategory).toBe("Underweight");
    expect(r.flags).toContain("ABNORMAL_BMI");
  });

  it("classifies overweight", () => {
    const r = computeVitalsFlags({ weight: 80, height: 170 });
    expect(r.bmiCategory).toBe("Overweight");
  });

  it("classifies obese", () => {
    const r = computeVitalsFlags({ weight: 110, height: 170 });
    expect(r.bmiCategory).toBe("Obese");
    expect(r.flags).toContain("ABNORMAL_BMI");
  });

  it("returns null BMI when height missing", () => {
    const r = computeVitalsFlags({ weight: 70 });
    expect(r.bmi).toBeNull();
    expect(r.bmiCategory).toBeNull();
  });
});

describe("computeVitalsFlags - blood pressure", () => {
  it("flags hypertensive crisis on systolic >= 180", () => {
    const r = computeVitalsFlags({ bloodPressureSystolic: 185, bloodPressureDiastolic: 110 });
    expect(r.flags).toContain("HYPERTENSIVE_CRISIS");
    expect(r.critical).toContain("HYPERTENSIVE_CRISIS");
    expect(r.isCritical).toBe(true);
  });

  it("flags hypertensive crisis on diastolic >= 120", () => {
    const r = computeVitalsFlags({ bloodPressureSystolic: 130, bloodPressureDiastolic: 125 });
    expect(r.flags).toContain("HYPERTENSIVE_CRISIS");
  });

  it("flags HIGH_BP at >=140 systolic", () => {
    const r = computeVitalsFlags({ bloodPressureSystolic: 145, bloodPressureDiastolic: 92 });
    expect(r.flags).toContain("HIGH_BP");
    expect(r.flags).not.toContain("HYPERTENSIVE_CRISIS");
  });

  it("flags LOW_BP and critical when systolic < 80", () => {
    const r = computeVitalsFlags({ bloodPressureSystolic: 75 });
    expect(r.flags).toContain("LOW_BP");
    expect(r.critical).toContain("LOW_BP");
  });

  it("flags LOW_BP non-critical when 80 <= sys < 90", () => {
    const r = computeVitalsFlags({ bloodPressureSystolic: 85 });
    expect(r.flags).toContain("LOW_BP");
    expect(r.critical).not.toContain("LOW_BP");
  });

  it("does not flag normotensive readings", () => {
    const r = computeVitalsFlags({ bloodPressureSystolic: 120, bloodPressureDiastolic: 80 });
    expect(r.flags).toEqual([]);
    expect(r.isAbnormal).toBe(false);
  });
});

describe("computeVitalsFlags - SpO2", () => {
  it("flags critical low SpO2 < 90", () => {
    const r = computeVitalsFlags({ spO2: 86 });
    expect(r.flags).toContain("LOW_SPO2");
    expect(r.critical).toContain("LOW_SPO2");
  });

  it("flags non-critical low SpO2 90-94", () => {
    const r = computeVitalsFlags({ spO2: 93 });
    expect(r.flags).toContain("LOW_SPO2");
    expect(r.critical).not.toContain("LOW_SPO2");
  });

  it("does not flag normal SpO2", () => {
    const r = computeVitalsFlags({ spO2: 98 });
    expect(r.flags).not.toContain("LOW_SPO2");
  });
});

describe("computeVitalsFlags - pulse", () => {
  it("flags critical tachycardia >130", () => {
    const r = computeVitalsFlags({ pulseRate: 140 });
    expect(r.flags).toContain("TACHYCARDIA");
    expect(r.critical).toContain("TACHYCARDIA");
  });

  it("flags tachycardia 101-130", () => {
    const r = computeVitalsFlags({ pulseRate: 110 });
    expect(r.flags).toContain("TACHYCARDIA");
    expect(r.critical).not.toContain("TACHYCARDIA");
  });

  it("flags critical bradycardia <40", () => {
    const r = computeVitalsFlags({ pulseRate: 35 });
    expect(r.flags).toContain("BRADYCARDIA");
    expect(r.critical).toContain("BRADYCARDIA");
  });

  it("flags bradycardia 40-49", () => {
    const r = computeVitalsFlags({ pulseRate: 45 });
    expect(r.flags).toContain("BRADYCARDIA");
  });
});

describe("computeVitalsFlags - temperature", () => {
  it("flags HIGH_FEVER >=103F", () => {
    const r = computeVitalsFlags({ temperature: 104, temperatureUnit: "F" });
    expect(r.flags).toContain("HIGH_FEVER");
    expect(r.critical).toContain("HIGH_FEVER");
  });

  it("flags FEVER 100.4-102.9F", () => {
    const r = computeVitalsFlags({ temperature: 101, temperatureUnit: "F" });
    expect(r.flags).toContain("FEVER");
  });

  it("flags HYPOTHERMIA <95F", () => {
    const r = computeVitalsFlags({ temperature: 94, temperatureUnit: "F" });
    expect(r.flags).toContain("HYPOTHERMIA");
    expect(r.critical).toContain("HYPOTHERMIA");
  });

  it("converts Celsius to Fahrenheit and flags fever", () => {
    const r = computeVitalsFlags({ temperature: 39, temperatureUnit: "C" }); // 102.2 F
    expect(r.flags).toContain("FEVER");
  });

  it("does not flag normal temp", () => {
    const r = computeVitalsFlags({ temperature: 98.6, temperatureUnit: "F" });
    expect(r.flags).not.toContain("FEVER");
    expect(r.flags).not.toContain("HYPOTHERMIA");
  });
});

describe("computeVitalsFlags - respiratory rate & pain", () => {
  it("flags TACHYPNEA >24", () => {
    const r = computeVitalsFlags({ respiratoryRate: 28 });
    expect(r.flags).toContain("TACHYPNEA");
  });

  it("flags critical BRADYPNEA <10", () => {
    const r = computeVitalsFlags({ respiratoryRate: 8 });
    expect(r.flags).toContain("BRADYPNEA");
    expect(r.critical).toContain("BRADYPNEA");
  });

  it("flags severe pain >=7", () => {
    const r = computeVitalsFlags({ painScale: 8 });
    expect(r.flags).toContain("SEVERE_PAIN");
  });

  it("does not flag mild pain", () => {
    const r = computeVitalsFlags({ painScale: 3 });
    expect(r.flags).not.toContain("SEVERE_PAIN");
  });
});

describe("computeVitalsFlags - empty input", () => {
  it("returns no flags for empty vitals", () => {
    const r = computeVitalsFlags({});
    expect(r.flags).toEqual([]);
    expect(r.isAbnormal).toBe(false);
    expect(r.isCritical).toBe(false);
    expect(r.bmi).toBeNull();
  });
});

describe("computeVitalsFlagsWithBaseline", () => {
  it("adds SIGNIFICANT_CHANGE_FROM_BASELINE when systolic deviates >20%", () => {
    const r = computeVitalsFlagsWithBaseline(
      { bloodPressureSystolic: 160 },
      {
        bpSystolic: { baseline: 120 },
        bpDiastolic: { baseline: 80 },
        pulse: { baseline: 75 },
        spO2: { baseline: 98 },
      }
    );
    expect(r.flags).toContain("SIGNIFICANT_CHANGE_FROM_BASELINE");
    expect(r.baselineDeviations).toContain("bpSystolic");
  });

  it("does not flag baseline deviation when value within 20%", () => {
    const r = computeVitalsFlagsWithBaseline(
      { bloodPressureSystolic: 130 },
      {
        bpSystolic: { baseline: 120 },
        bpDiastolic: { baseline: 80 },
        pulse: { baseline: 75 },
        spO2: { baseline: 98 },
      }
    );
    expect(r.baselineDeviations).not.toContain("bpSystolic");
  });

  it("handles null baseline gracefully", () => {
    const r = computeVitalsFlagsWithBaseline(
      { bloodPressureSystolic: 130 },
      null
    );
    expect(r.baselineDeviations).toEqual([]);
  });
});
