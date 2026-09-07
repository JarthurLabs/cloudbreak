import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { feederApproach } from '../src/traffic-path.ts';

const curve = () => new THREE.CubicBezierCurve3(...[[.6,.26,9.35],[.25,.26,6.3],[-.2,.26,1],[-.17,.26,-1.4]].map(p=>new THREE.Vector3(...p)));
function cameraFor(width,height) {
 const aspect=width/height, viewHeight=aspect<1.3?26/Math.max(aspect,.25):23;
 const camera=new THREE.OrthographicCamera(-viewHeight*aspect/2,viewHeight*aspect/2,viewHeight/2,-viewHeight/2,.1,200);
 const target=new THREE.Vector3(-.25,-.8,.1);camera.position.copy(target).add(new THREE.Vector3(16,11.5,24));camera.position.addScaledVector(camera.position.clone().sub(target).normalize(),40);camera.lookAt(target);camera.updateMatrixWorld();return camera;
}
test('mobile middle-lane arrivals start beyond the frame on the existing feeder, with the original gate endpoint',()=>{
 for(const [width,height] of [[320,270],[390,546],[430,634],[544,332],[632,372]]) {
  const original=curve(),camera=cameraFor(width,height),path=feederApproach(original,.72,camera,width,height);
  const start=path.getPoint(0),screen=start.clone().add(new THREE.Vector3(0,.32,0)).project(camera);
  assert.ok(screen.z>-1&&screen.z<1,'Feeder must stay within camera depth, not pop through its near plane');
  assert.ok(Math.abs(screen.x)>1||Math.abs(screen.y)>1,`${width}×${height}: origin must be offscreen`);
  const offset=start.clone().sub(original.v0),outward=original.getTangent(0).setY(0).normalize().negate();
  assert.ok(offset.length()>0&&offset.length()<=60,'Use only the existing sixty-unit bridge');
  assert.ok(offset.clone().normalize().distanceTo(outward)<1e-8,'Stay on the built feeder');
  assert.ok(path.getPoint(1).distanceTo(original.getPoint(.72))<1e-8,'The gate must not move');
  assert.ok(path.getTangent(1).dot(original.getTangent(.72))>.999,'Arrive aligned with the original gate');
 }
});
test('feeder join is continuous and does not move the original bridge or an existing actor path',()=>{
 const original=curve(),before=[original.v0,original.v1,original.v2,original.v3].map(p=>p.toArray());
 const first=feederApproach(original,.72,cameraFor(390,546),390,546),position=first.getPoint(.4).clone();
 feederApproach(original,.72,cameraFor(544,332),544,332);
 assert.deepEqual([original.v0,original.v1,original.v2,original.v3].map(p=>p.toArray()),before);
 assert.ok(first.getPoint(.4).distanceTo(position)<1e-10,'A later viewport must not alter a born actor path');
 const split=first.curves[0].getLength()/first.getLength();
 assert.ok(first.getPoint(split).distanceTo(original.v0)<1e-8);
 assert.ok(first.getPoint(split-1e-6).distanceTo(first.getPoint(split+1e-6))<.001,'No jump at the visible uplink');
 assert.ok(first.curves[0].getTangent(1).dot(first.curves[1].getTangent(0))>.999);
});
