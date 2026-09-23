import { AwsClient } from "aws4fetch";

// Token profile storage on S3, served through CloudFront. Each object's key is
// the SHA-256 of its content (tokens/<hash>/<name>), so anyone can check that a
// file behind a token's metadata URI is the one that was uploaded. The upload
// key can only PutObject under tokens/ (see deploy/lightsail/README.md).
export type S3Config = {
  region: string;
  bucket: string;
  cdn: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function s3Config(env: Record<string, string | undefined> = process.env): S3Config | null {
  const region = env.AWS_REGION,
    bucket = env.SONATA_ASSETS_BUCKET,
    cdn = env.SONATA_ASSETS_CDN,
    accessKeyId = env.AWS_ACCESS_KEY_ID,
    secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!region || !bucket || !cdn || !accessKeyId || !secretAccessKey) return null;
  return { region, bucket, cdn: cdn.replace(/\/+$/, ""), accessKeyId, secretAccessKey };
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function objectKey(bytes: Uint8Array, name: string) {
  if (!/^(logo\.(webp|png|jpg|gif)|metadata\.json)$/.test(name)) throw Error("Unexpected object name.");
  return `tokens/${await sha256Hex(bytes)}/${name}`;
}

export async function uploadToS3(cfg: S3Config, bytes: Uint8Array, contentType: string, name: string) {
  const key = await objectKey(bytes, name);
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: cfg.region,
  });
  const r = await client.fetch(`https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key}`, {
    method: "PUT",
    body: bytes as BodyInit,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
  if (!r.ok) throw Error(`Image storage refused the upload (${r.status}).`);
  return `${cfg.cdn}/${key}`;
}
