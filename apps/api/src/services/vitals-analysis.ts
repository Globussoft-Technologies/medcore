// Vitals analysis helper — computes BMI and flags abnormal readings.
// Used by both the Vitals POST route and any other code that creates vitals.

export type VitalsInput = {
  bloodPressureSystolic?: number | null;
  bloodPressureDiastolic?: number | null;
  temperature?: number | null; // value in the unit below
  temperatureUnit?: "F" | "C" | null;
  weight?: number | null; // kg
  height?: number | null; // cm
  pulseRate?: number | null;
  spO2?: number | null;
  respiratoryRate?: number | null;
  painScale?: number | null;
};

export type VitalsAnalysis = {
  bmi: number | null;
  bmiCategory: string | null;
  flags: string[]; // e.g. ["HIGH_BP","LOW_SPO2"]
  critical: string[]; // subset of flags that are critical
  isAbnormal: boolean;
  isCritical: boolean;
};

export function computeVitalsFlags(v: VitalsInput): VitalsAnalysis {
  const flags: string[] = [];
  const critical: string[] = [];

  // BMI
  let bmi: number | null = null;
  let bmiCategory: string | null = null;
  if (v.weight && v.height && v.height > 0) {
    const m = v.height / 100;
    bmi = Math.round((v.weight / (m * m)) * 10) / 10;
    if (bmi < 18.5) bmiCategory = "Underweight";
    else if (bmi < 25) bmiCategory = "Normal";
    else if (bmi < 30) bmiCategory = "Overweight";
    else bmiCategory = "Obese";
    if (bmi < 16 || bmi >= 35) flags.push("ABNORMAL_BMI");
  }

  // Blood pressure
  const sys = v.bloodPressureSystolic;
  const dia = v.bloodPressureDiastolic;
  if (sys != null && sys >= 180) {
    flags.push("HYPERTENSIVE_CRISIS");
    critical.push("HYPERTENSIVE_CRISIS");
  } else if (sys != null && sys >= 140) {
    flags.push("HIGH_BP");
  } else if (sys != null && sys < 90) {
    flags.push("LOW_BP");
    if (sys < 80) critical.push("LOW_BP");
  }
  if (dia != null && dia >= 120) {
    if (!flags.includes("HYPERTENSIVE_CRISIS")) flags.push("HYPERTENSIVE_CRISIS");
    critical.push("HYPERTENSIVE_CRISIS");
  } else if (dia != null && dia >= 90) {
    if (!flags.includes("HIGH_BP")) flags.push("HIGH_BP");
  }

  // SpO2
  if (v.spO2 != null) {
    if (v.spO2 < 90) {
      flags.push("LOW_SPO2");
      critical.push("LOW_SPO2");
    } else if (v.spO2 < 95) {
      flags.push("LOW_SPO2");
    }
  }

  // Pulse rate
  if (v.pulseRate != null) {
    if (v.pulseRate > 130) {
      flags.push("TACHYCARDIA");
      critical.push("TACHYCARDIA");
    } else if (v.pulseRate > 100) flags.push("TACHYCARDIA");
    if (v.pulseRate < 50) {
      flags.push("BRADYCARDIA");
      if (v.pulseRate < 40) critical.push("BRADYCARDIA");
    }
  }

  // Temperature — normalise to Fahrenheit for comparison
  let tempF: number | null = null;
  if (v.temperature != null) {
    tempF =
      (v.temperatureUnit ?? "F") === "C"
        ? v.temperature * 9 / 5 + 32
        : v.temperature;
    if (tempF >= 103) {
      flags.push("HIGH_FEVER");
      critical.push("HIGH_FEVER");
    } else if (tempF >= 100.4) flags.push("FEVER");
    else if (tempF < 95) {
      flags.push("HYPOTHERMIA");
      critical.push("HYPOTHERMIA");
    }
  }

  // Respiratory rate
  if (v.respiratoryRate != null) {
    if (v.respiratoryRate > 24) flags.push("TACHYPNEA");
    if (v.respiratoryRate < 10) {
      flags.push("BRADYPNEA");
      critical.push("BRADYPNEA");
    }
  }

  // Pain scale
  if (v.painScale != null && v.painScale >= 7) flags.push("SEVERE_PAIN");

  return {
    bmi,
    bmiCategory,
    flags,
    critical,
    isAbnormal: flags.length > 0,
    isCritical: critical.length > 0,
  };
}
