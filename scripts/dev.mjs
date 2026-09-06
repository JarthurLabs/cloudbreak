import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
for (const port of [5310,5311]) await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(new Error(`Cloudbreak port ${port} is occupied. No process was stopped. Free this port or run production on 5311 after confirming ownership.`)));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
const children=[spawn(process.execPath,['server/index.mjs'],{cwd:root,stdio:'inherit',env:{...process.env,CLOUDBREAK_DEV:'1'}}),spawn(process.execPath,['node_modules/vite/bin/vite.js'],{cwd:root,stdio:'inherit'})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),150).unref();}
for(const child of children)child.on('exit',code=>stop(code??0));
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
console.log('Cloudbreak UI http://127.0.0.1:5310 · local gateway 5311');
