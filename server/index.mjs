import { createCloudbreakServer } from './app.mjs';

const port = process.env.CLOUDBREAK_PORT ? Number(process.env.CLOUDBREAK_PORT) : 5311;
const app = createCloudbreakServer({ port });
try {
  await app.listen();
  console.log(`Cloudbreak local gateway and production preview: ${app.url}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
