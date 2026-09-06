// Small native-resolution attachment; never overwrites the high-quality master.
import{spawn}from'node:child_process';import{resolve}from'node:path';import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import assert from'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),ffmpeg=resolve(root,'.cloudbreak-runtime/media/node_modules/ffmpeg-static/ffmpeg');
const source=resolve(root,'captures/release/Cloudbreak-4k-Demo.mp4'),output=resolve(root,'captures/release/Cloudbreak-4k-README.mp4'),passLog=resolve(root,'captures/release/raw/readme-4k-pass');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),before=hash(await readFile(source));
const run=args=>new Promise((done,reject)=>{const child=spawn(ffmpeg,['-nostdin','-y','-hide_banner','-loglevel','warning',...args],{cwd:root,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',data=>errors=(errors+data).slice(-20000));child.once('error',reject);child.once('close',code=>code===0?done():reject(new Error(errors)))});
const video=['-c:v','libx264','-preset','slow','-b:v','750k','-maxrate','1100k','-bufsize','2200k','-threads','4','-pix_fmt','yuv420p','-level:v','5.1','-g','96'];
await run(['-i',source,'-map','0:v:0',...video,'-pass','1','-passlogfile',passLog,'-an','-f','mp4','/dev/null']);
await run(['-i',source,'-map','0:v:0','-map','0:a:0',...video,'-pass','2','-passlogfile',passLog,'-c:a','aac','-b:a','64k','-ar','48000','-ac','2','-movflags','+faststart',output]);
assert.equal(hash(await readFile(source)),before);const bytes=await readFile(output);assert.ok(bytes.length<9900000);console.log(JSON.stringify({output,bytes:bytes.length,sha256:hash(bytes),masterUnchanged:true}));
