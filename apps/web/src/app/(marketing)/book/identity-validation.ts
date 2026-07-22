export type QuickBookGender = "" | "MALE" | "FEMALE" | "OTHER";

export interface QuickBookIdentityInput {
  name: string;
  phone: string;
  gender: QuickBookGender;
  dob: string;
  email: string;
}

export interface QuickBookIdentityErrors {
  name?: string;
  phone?: string;
  gender?: string;
  dob?: string;
  email?: string;
}

const PATIENT_NAME_REGEX = /^[A-Za-z\u0900-\u097F\s.'-]+$/u;

function digitCount(value: string): number {
  return value.replace(/\D/g, "").length;
}

function isFutureIsoDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date.getTime() > today.getTime();
}

export function validateQuickBookIdentity(
  input: QuickBookIdentityInput,
): QuickBookIdentityErrors {
  const errors: QuickBookIdentityErrors = {};
  const name = input.name.trim();
  const phone = input.phone.trim();
  const email = input.email.trim();

  if (name.length < 2) {
    errors.name = "Name must be at least 2 characters.";
  } else if (name.length > 100) {
    errors.name = "Name must be at most 100 characters.";
  } else if (!PATIENT_NAME_REGEX.test(name)) {
    errors.name =
      "Name may contain letters, spaces, '.', '-' and apostrophes only.";
  }

  const digits = digitCount(phone);
  if (!/^[+]?[\d\s-]{10,18}$/.test(phone) || digits < 10 || digits > 15) {
    errors.phone = "Enter a valid 10-15 digit WhatsApp number.";
  }

  if (!input.gender) {
    errors.gender = "Please select your gender.";
  }

  if (!input.dob) {
    errors.dob = "Please select your full date of birth.";
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dob)) {
    errors.dob = "Date of birth must be YYYY-MM-DD.";
  } else if (isFutureIsoDate(input.dob)) {
    errors.dob = "Date of birth cannot be in the future.";
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Enter a valid email address, or leave it blank.";
  }

  return errors;
}

export function firstQuickBookIdentityError(
  errors: QuickBookIdentityErrors,
): string | null {
  return (
    errors.name ??
    errors.phone ??
    errors.gender ??
    errors.dob ??
    errors.email ??
    null
  );
}
