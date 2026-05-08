// Side-effect-only module: loads `apps/api/.env` into process.env.
//
// MUST be the very first import in `./index.ts` so every downstream module
// (auth, sendgrid, openai, sarvam, prisma, etc.) sees the populated env when
// they read `process.env.X` at module evaluation time.
//
// tsx does not auto-load .env files. Prisma's transitive dotenv only loads
// its own connection-string vars. This module is the canonical path.
import { config as loadEnv } from "dotenv";
import path from "path";

loadEnv({ path: path.resolve(__dirname, "../.env") });
