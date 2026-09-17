#!/usr/bin/env node
'use strict';

// Verifies the S3 bucket is reachable, writable, and CORS-enabled for
// presigned uploads. Run locally (or on Render) where the real AWS
// credentials live:  npm run check:s3
//
// It performs a real presigned PUT of a tiny object and deletes it again,
// which is the only way to be sure browser uploads will actually work.

require('dotenv').config();

const {
  S3Client,
  ListObjectsV2Command,
  GetBucketCorsCommand,
  PutObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.S3_BUCKET_NAME || 'retro-capture-videos';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ORIGIN = process.argv[2] || 'https://retro-capture.onrender.com';

const s3 = new S3Client({
  region: REGION,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      : undefined
});

const REQUIRED_CORS = {
  AllowedHeaders: ['*'],
  AllowedMethods: ['PUT', 'GET', 'HEAD'],
  AllowedOrigins: [ORIGIN, 'http://localhost:3000'],
  ExposeHeaders: ['ETag'],
  MaxAgeSeconds: 3000
};

let failures = 0;
const ok = (msg) => console.log(`✅ ${msg}`);
const bad = (msg) => {
  failures += 1;
  console.log(`❌ ${msg}`);
};
const warn = (msg) => console.log(`⚠️  ${msg}`);

async function main() {
  console.log(`Bucket : ${BUCKET}`);
  console.log(`Region : ${REGION}`);
  console.log(`Origin : ${ORIGIN}`);
  console.log('');

  if (!process.env.AWS_ACCESS_KEY_ID) {
    warn('AWS_ACCESS_KEY_ID is not set — falling back to the default credential chain.');
  }

  // 1. Can we read the bucket?
  try {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'captures/',
        Delimiter: '/',
        MaxKeys: 1000
      })
    );
    const folders = (res.CommonPrefixes || []).map((p) =>
      p.Prefix.replace('captures/', '').replace('/', '')
    );
    ok(`Bucket reachable — ${folders.length} capture folder(s) under captures/`);
    folders.slice(-5).forEach((f) => console.log(`     ${f}`));
  } catch (error) {
    bad(`Cannot list the bucket: ${error.name} — ${error.message}`);
    if (error.name === 'InvalidAccessKeyId' || error.name === 'SignatureDoesNotMatch') {
      console.log('     Your AWS credentials are wrong or rotated.');
    }
    if (error.name === 'NoSuchBucket') {
      console.log(`     The bucket "${BUCKET}" does not exist in ${REGION}.`);
    }
    console.log('\nStopping: nothing else can be checked without read access.');
    process.exit(1);
  }

  // 2. Is CORS configured? Presigned browser uploads die without it.
  try {
    const cors = await s3.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
    const rules = cors.CORSRules || [];
    const allowsPut = rules.some((r) => (r.AllowedMethods || []).includes('PUT'));
    const allowsOrigin = rules.some((r) =>
      (r.AllowedOrigins || []).some((o) => o === '*' || o === ORIGIN)
    );

    if (allowsPut && allowsOrigin) {
      ok('CORS allows PUT from the app origin');
    } else {
      bad(
        `CORS exists but is incomplete (PUT: ${allowsPut}, origin ${ORIGIN}: ${allowsOrigin})`
      );
      console.log('     Required rule:\n' + JSON.stringify([REQUIRED_CORS], null, 2));
    }
  } catch (error) {
    if (error.name === 'NoSuchCORSConfiguration') {
      bad('No CORS policy on the bucket — presigned uploads WILL fail in the browser.');
      console.log('     Add this under S3 → Permissions → CORS:\n');
      console.log(JSON.stringify([REQUIRED_CORS], null, 2));
    } else {
      bad(`Could not read CORS config: ${error.name} — ${error.message}`);
    }
  }

  // 3. Can we actually sign and complete a PUT? This is the real test.
  const probeKey = `captures/_healthcheck/probe_${Date.now()}.txt`;
  try {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: probeKey,
        ContentType: 'text/plain'
      }),
      { expiresIn: 300 }
    );
    ok('Presigned URL generated');

    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'retro-capture health probe'
    });

    if (res.ok) {
      ok(`Presigned PUT succeeded (HTTP ${res.status}) — uploads are working`);
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: probeKey }));
      ok('Probe object cleaned up');
    } else {
      bad(`Presigned PUT failed: HTTP ${res.status} ${res.statusText}`);
      console.log('     ' + (await res.text()).slice(0, 400));
    }
  } catch (error) {
    bad(`Presigned upload test failed: ${error.name} — ${error.message}`);
  }

  console.log('');
  if (failures === 0) {
    console.log('🎉 S3 is fully working: read, CORS, and presigned upload all pass.');
  } else {
    console.log(`💥 ${failures} check(s) failed — see above.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
