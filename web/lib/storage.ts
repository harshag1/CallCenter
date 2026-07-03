// Author: Harsha Gundala
// storage.ts — S3 file storage (primary) with lazy client; presigned serving + bytea fallback helper.

import type { S3Client } from "@aws-sdk/client-s3";

const PRESIGN_TTL_SECONDS = 300;

/** S3 is the active store only when full AWS env is present; otherwise bytea fallback applies. */
export function s3Enabled(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.S3_BUCKET
  );
}

function bucket(): string {
  return process.env.S3_BUCKET!;
}

const globalForS3 = globalThis as unknown as { __s3?: S3Client };

/** Lazily constructs (and caches) the client; S3_ENDPOINT enables S3-compatible stores. */
async function s3(): Promise<S3Client> {
  if (globalForS3.__s3) return globalForS3.__s3;
  const { S3Client } = await import("@aws-sdk/client-s3");
  globalForS3.__s3 = new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.S3_ENDPOINT
      ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
      : {}),
  });
  return globalForS3.__s3;
}

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 180);
  return clean || "file";
}

/** Canonical object key: orgId/documentId/sanitized-filename. */
export function fileKey(orgId: string, documentId: string, filename: string): string {
  return `${orgId}/${documentId}/${sanitizeFilename(filename)}`;
}

export async function putFile(key: string, buf: Buffer, contentType: string): Promise<void> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3();
  await client.send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buf, ContentType: contentType })
  );
}

/** Streams an object body as a web ReadableStream (for proxied serving). */
export async function getFileStream(key: string): Promise<ReadableStream<Uint8Array>> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!res.Body) throw new Error(`s3 object ${key} has no body`);
  return res.Body.transformToWebStream() as ReadableStream<Uint8Array>;
}

/** Fully buffers an object (transcode/ingest paths that need random access). */
export async function getFile(key: string): Promise<Buffer> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!res.Body) throw new Error(`s3 object ${key} has no body`);
  return Buffer.from(await res.Body.transformToByteArray());
}

/** Short-lived inline GET URL; browsers preview/play directly from S3. */
export async function presignedGetUrl(
  key: string,
  opts: { filename: string; contentType?: string },
  ttlSeconds: number = PRESIGN_TTL_SECONDS
): Promise<string> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = await s3();
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ResponseContentDisposition: `inline; filename="${sanitizeFilename(opts.filename)}"`,
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
  });
  return getSignedUrl(client, command, { expiresIn: ttlSeconds });
}

/** Resolves a document's raw bytes from whichever store holds them (S3 when keyed, else bytea). */
export async function documentBytes(doc: {
  s3_key?: string | null;
  data?: Buffer | Uint8Array | null;
}): Promise<Buffer | null> {
  if (doc.s3_key && s3Enabled()) return getFile(doc.s3_key);
  if (doc.data?.length) return Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data);
  return null;
}
