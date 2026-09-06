import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
console.log('Cloudbreak verification uses actual HTTP on reserved loopback port 5318.');
console.log('Mission timing tests use a controlled clock; they do not replace the real-time playable demonstration.');
const result = spawnSync(process.execPath, ['--test', resolve(root, 'tests/gateway.test.mjs')], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
