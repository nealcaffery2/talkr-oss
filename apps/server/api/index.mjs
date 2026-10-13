// Placeholder so the host recognises api/index.mjs as a function before
// install runs. The install step (vercel.json) replaces this file with the
// real bundle from scripts/bundle-serverless.mjs --inplace. Do not commit a
// generated bundle over it.
export default function handler(_req, res) {
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'bundle_missing', hint: 'npm run bundle:serverless -- --inplace' }));
}
