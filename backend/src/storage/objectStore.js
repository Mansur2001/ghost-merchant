// Object storage adapter. Talks the S3 API but points at self-hosted MinIO — no AWS,
// no lock-in. To migrate to real S3 later, only the endpoint/credentials change.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
});

// Create the bucket on boot if it doesn't exist (MinIO starts empty).
export async function ensureBucket() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
    console.log(`Created bucket ${config.s3.bucket}`);
  }
}

export async function putObject(key, body, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return key;
}

// Time-limited download URL so the frontend never sees storage credentials. Used for real
// deploys where MinIO is reachable from the browser (behind Caddy). Locally, minio:9000 is
// only resolvable inside the docker network, so the browser-facing path streams via
// getObject() through the backend instead (see routes) — creds still never reach the client.
export function presignGet(key, expiresInSeconds = 300) {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

// Fetch an object's bytes as a Node Readable stream + its content type, for backend-mediated
// download (the browser hits /api/... and never talks to MinIO directly).
export async function getObject(key) {
  const out = await client.send(
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key })
  );
  return { body: out.Body, contentType: out.ContentType };
}

// Delete an object. Used to honour retention promises — an ID document is destroyed once the
// decision it supports has been made, because keeping it afterwards is pure liability.
export async function deleteObject(key) {
  await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}
