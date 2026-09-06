import { createCloudbreakServer } from './app.mjs';

// Only this explicit entrypoint opens a public listener. The normal local
// entrypoint retains ports 5310–5319 and its loopback-only behavior.
const publicOrigin = process.env.CLOUDBREAK_PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL;
if (!publicOrigin) throw new Error('Set CLOUDBREAK_PUBLIC_ORIGIN to the exact public HTTPS origin.');
const app = createCloudbreakServer({ port: Number(process.env.PORT ?? 10000), publicOrigin });
await app.listen();
console.log(`Cloudbreak public server ready for ${publicOrigin}.`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 25_000).unref();
  await app.close();
  clearTimeout(timeout);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
