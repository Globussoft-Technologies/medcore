export enum Role {
  ADMIN = "ADMIN",
  DOCTOR = "DOCTOR",
  RECEPTION = "RECEPTION",
  NURSE = "NURSE",
  PATIENT = "PATIENT",
  PHARMACIST = "PHARMACIST",
  LAB_TECH = "LAB_TECH",
}

export interface UserBase {
  id: string;
  email: string;
  phone: string;
  name: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
