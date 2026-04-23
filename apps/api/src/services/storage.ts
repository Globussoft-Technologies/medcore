// Storage abstraction: local disk (default) or AWS S3 (production).
//
// Env vars for S3:
//   STORAGE_PROVIDER      — "s3" to activate (default: "local")
//   AWS_REGION            — e.g. "ap-south-1"
//   AWS_S3_BUCKET         — bucket name
//   AWS_ACCESS_KEY_ID     — IAM key
//   AWS_SECRET_ACCESS_KEY — IAM secret
//   AWS_S3_ENDPOINT       — optional custom endpoint (Cloudflare R2, MinIO, etc.)

import fs from "fs";
import path from "path";
import { promisify } from "util";

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

const LOCAL_UPLOAD_DIR = path.resolve(process.cwd(), "uploads/ehr");

export interface StorageResult {
  key: string;
  url: string;
}

function isS3Enabled(): boolean {
  return (
    process.env.STORAGE_PROVIDER === "s3" &&
    !!process.env.AWS_S3_BUCKET &&
    !!process.env.AWS_REGION
  );
}

// ── Local disk ────────────────────────────────────────────────────────────────

async function localUpload(
  buffer: Buffer,
  filename: string
): Promise<StorageResult> {
  if (!fs.existsSync(LOCAL_UPLOAD_DIR)) {
    fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  }
  const dest = path.join(LOCAL_UPLOAD_DIR, filename);
  await writeFile(dest, buffer);
  return { key: `uploads/ehr/${filename}`, url: `/api/v1/uploads/${filename}` };
}

async function localDelete(key: string): Promise<void> {
  const fullPath = path.resolve(process.cwd(), key);
  if (fs.existsSync(fullPath)) await unlink(fullPath);
}

async function localSignedUrl(key: string, ttlSeconds = 900): Promise<string> {
  const { signParts } = await import("./signed-url");
  const filename = path.basename(key);
  const parts = signParts(`file:${filename}`, ttlSeconds);
  return `/api/v1/uploads/${filename}?expires=${parts.expires}&sig=${parts.sig}`;
}

// ── AWS S3 ────────────────────────────────────────────────────────────────────

async function s3Upload(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<StorageResult> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const bucket = process.env.AWS_S3_BUCKET!;
  const region = process.env.AWS_REGION!;
  const key = `ehr/${filename}`;

  const client = new S3Client({
    region,
    ...(process.env.AWS_S3_ENDPOINT
      ? { endpoint: process.env.AWS_S3_ENDPOINT, forcePathStyle: true }
      : {}),
  });

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
    })
  );

  return {
    key,
    url: process.env.AWS_S3_ENDPOINT
      ? `${process.env.AWS_S3_ENDPOINT}/${bucket}/${key}`
      : `https://${bucket}.s3.${region}.amazonaws.com/${key}`,
  };
}

async function s3Delete(key: string): Promise<void> {
  const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: process.env.AWS_REGION! });
  await client.send(
    new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key })
  );
}

async function s3SignedUrl(key: string, ttlSeconds = 900): Promise<string> {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = new S3Client({ region: process.env.AWS_REGION! });
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key }),
    { expiresIn: ttlSeconds }
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function uploadFile(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<StorageResult> {
  return isS3Enabled()
    ? s3Upload(buffer, filename, contentType)
    : localUpload(buffer, filename);
}

export async function deleteFile(key: string): Promise<void> {
  return isS3Enabled() ? s3Delete(key) : localDelete(key);
}

export async function getSignedDownloadUrl(
  key: string,
  ttlSeconds = 900
): Promise<string> {
  return isS3Enabled() ? s3SignedUrl(key, ttlSeconds) : localSignedUrl(key, ttlSeconds);
}

export { isS3Enabled };
