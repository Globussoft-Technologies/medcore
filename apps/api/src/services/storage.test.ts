import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";

const { s3SendMock, getSignedUrlMock } = vi.hoisted(() => ({
  s3SendMock: vi.fn(async () => ({})),
  getSignedUrlMock: vi.fn(async () => "https://signed.example.com/key?x-amz-signature=abc"),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor(_opts: any) {}
    send = s3SendMock;
  }
  class PutObjectCommand {
    constructor(public input: any) {}
  }
  class GetObjectCommand {
    constructor(public input: any) {}
  }
  class DeleteObjectCommand {
    constructor(public input: any) {}
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

import {
  uploadFile,
  deleteFile,
  getSignedDownloadUrl,
  isS3Enabled,
} from "./storage";

const ENV_KEYS = [
  "STORAGE_PROVIDER",
  "AWS_S3_BUCKET",
  "AWS_REGION",
  "AWS_S3_ENDPOINT",
] as const;
const savedEnv: Record<string, string | undefined> = {};

// Local upload dir is resolved from cwd at module load. We cannot change
// cwd here without breaking the import — so write to the actual dir under
// the resolved upload root and clean up specific files we create.
const uploadRoot = path.resolve(process.cwd(), "uploads/ehr");
const createdFiles: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  s3SendMock.mockClear();
  getSignedUrlMock.mockClear();
  createdFiles.length = 0;
});

afterEach(() => {
  for (const f of createdFiles) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

describe("isS3Enabled", () => {
  it("returns false unless STORAGE_PROVIDER=s3 AND bucket AND region are set", () => {
    expect(isS3Enabled()).toBe(false);
    process.env.STORAGE_PROVIDER = "s3";
    expect(isS3Enabled()).toBe(false);
    process.env.AWS_S3_BUCKET = "b";
    process.env.AWS_REGION = "ap-south-1";
    expect(isS3Enabled()).toBe(true);
  });
});

describe("local storage (default)", () => {
  it("uploadFile writes the buffer and returns key + api URL", async () => {
    const filename = `storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const res = await uploadFile(Buffer.from("hello"), filename, "text/plain");
    const full = path.join(uploadRoot, filename);
    createdFiles.push(full);
    expect(res.key).toBe(`uploads/ehr/${filename}`);
    expect(res.url).toBe(`/api/v1/uploads/${filename}`);
    const written = fs.readFileSync(full, "utf8");
    expect(written).toBe("hello");
  });

  it("getSignedDownloadUrl produces URL with expires and sig query params", async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";
    const url = await getSignedDownloadUrl("uploads/ehr/test.txt", 60);
    expect(url).toMatch(/^\/api\/v1\/uploads\/test\.txt\?expires=\d+&sig=[a-f0-9]+$/);
  });

  it("deleteFile removes an existing file", async () => {
    const filename = `delete-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const res = await uploadFile(Buffer.from("data"), filename, "text/plain");
    const full = path.join(uploadRoot, filename);
    createdFiles.push(full);
    expect(fs.existsSync(full)).toBe(true);
    await deleteFile(res.key);
    expect(fs.existsSync(full)).toBe(false);
  });

  it("deleteFile is a no-op for missing files", async () => {
    await expect(
      deleteFile("uploads/ehr/this-does-not-exist-xyz.txt")
    ).resolves.toBeUndefined();
  });
});

describe("S3 storage (when enabled)", () => {
  beforeEach(() => {
    process.env.STORAGE_PROVIDER = "s3";
    process.env.AWS_S3_BUCKET = "test-bucket";
    process.env.AWS_REGION = "ap-south-1";
  });

  it("uploadFile sends PutObjectCommand with AES256 encryption and returns canonical URL", async () => {
    const res = await uploadFile(Buffer.from("x"), "doc.pdf", "application/pdf");
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    const command = (s3SendMock.mock.calls as any[])[0][0];
    expect(command.input.Bucket).toBe("test-bucket");
    expect(command.input.Key).toBe("ehr/doc.pdf");
    expect(command.input.ContentType).toBe("application/pdf");
    expect(command.input.ServerSideEncryption).toBe("AES256");
    expect(res.key).toBe("ehr/doc.pdf");
    expect(res.url).toBe("https://test-bucket.s3.ap-south-1.amazonaws.com/ehr/doc.pdf");
  });

  it("getSignedDownloadUrl calls presigner and returns presigned URL", async () => {
    const url = await getSignedDownloadUrl("ehr/doc.pdf", 300);
    expect(getSignedUrlMock).toHaveBeenCalled();
    const opts = (getSignedUrlMock.mock.calls as any[])[0][2];
    expect(opts.expiresIn).toBe(300);
    expect(url).toMatch(/^https:\/\//);
  });
});
