import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { feederApproach } from './traffic-path';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameState, IncomingRequest, RequestRecord, RouteId, ThreatType } from './types';

type Props = {
  state: GameState | null;
  selected: RouteId;
  onSelect: (id: RouteId) => void;
  reducedMotion: boolean;
  titleMode: boolean;
};
type Materials = Record<string, THREE.MeshStandardMaterial>;
type District = {
  id: RouteId;
  group: THREE.Group;
  center: THREE.Vector3;
  label: THREE.Vector3;
  entrance: THREE.Vector3;
  windows: THREE.MeshStandardMaterial;
  selection: THREE.Mesh;
  crown: THREE.Group;
  hitGroup: THREE.Group;
  hitGlow: THREE.MeshBasicMaterial;
  hitAge: number;
  hitRecord: RequestRecord | null;
  damage: number;
  damageColor: THREE.Color;
};
type DistrictWarning = { group: THREE.Group; line: THREE.MeshBasicMaterial; glow: THREE.MeshBasicMaterial; age: number; active: boolean; threatType: ThreatType | null };
type GateMotion = {
  policyKey: string | null;
  mode: 'open' | 'key-check' | 'slow-flow' | 'combined' | 'closed';
  actualShield: number;
  desiredShield: number;
  fromShield: number;
  desiredIsolation: number;
  fromIsolation: number;
  observedAtMs: number;
  visibleAtMs: number | null;
  convergedAtMs: number | null;
  frames: number;
  revision: number;
};
type Route = {
  id: RouteId;
  curve: THREE.CubicBezierCurve3;
  uplinkLabel: THREE.Vector3;
  retract: THREE.Group;
  shield: THREE.Group;
  shieldDisc: THREE.MeshBasicMaterial;
  shieldRim: THREE.MeshBasicMaterial;
  isolation: number;
  flash: number;
  gate: GateMotion;
};
type PendingTraveler = { request: IncomingRequest; record: RequestRecord | null; source: 'incoming' | 'record-replay'; queuedAt: number };
type Traveler = PendingTraveler & { object: THREE.Group; age: number; duration: number; reacted: boolean; phase: 'approach' | 'waiting' | 'accepted' | 'rejected' | 'arrival'; phaseAge: number; progress: number; visualApproachStartedAt: number; hasRendered: boolean; approachPath: THREE.CurvePath<THREE.Vector3> | null };
type Particle = { position: THREE.Vector3; velocity: THREE.Vector3; age: number; life: number; color: THREE.Color };

const IDS: RouteId[] = ['storefront', 'accounts', 'dispatch'];
const NAMES = ['STOREFRONT', 'ACCOUNTS', 'DISPATCH'];
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const THREAT_COLORS: Record<ThreatType, string> = { 'bad-login': '#ff5c69', swarm: '#ffb637', breach: '#bd5eff' };
const WINDOW_COLOR = new THREE.Color('#438d9b');
const GATE_TRANSITION_MS = 180;
const MAX_QUEUED_AGE_SECONDS = .5;
const GATE_PROGRESS = .72;
const MAX_CLOCK_EXTRAPOLATION_SECONDS = .5;
const MIN_VISUAL_APPROACH_SECONDS = .5;
const LOCAL_JOLT_SECONDS = .28;

function initialGateMotion(): GateMotion {
  return { policyKey: null, mode: 'open', actualShield: 0, desiredShield: 0, fromShield: 0, desiredIsolation: 0, fromIsolation: 0, observedAtMs: 0, visibleAtMs: null, convergedAtMs: null, frames: 0, revision: 0 };
}

/** Static architecture is batched by material, so a thousand windows cost three draws. */
class Architecture {
  private pieces = new Map<THREE.Material, THREE.BufferGeometry[]>();
  constructor(private parent: THREE.Group) {}
  add(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, rotation?: THREE.Euler) {
    // RoundedBoxGeometry is non-indexed; standard cylinders and spheres are indexed.
    // Normalize that representation before merging different architectural shapes.
    if (geometry.index) {
      const original = geometry;
      geometry = original.toNonIndexed();
      original.dispose();
    }
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(rotation ?? new THREE.Euler()), new THREE.Vector3(1, 1, 1));
    geometry.applyMatrix4(matrix);
    const parts = this.pieces.get(material) ?? [];
    parts.push(geometry);
    this.pieces.set(material, parts);
  }
  box(material: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number, radius = .07, rotation?: THREE.Euler) {
    this.add(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2, h / 2, d / 2)), material, x, y, z, rotation);
  }
  tapered(material: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number, topScale = .76, lean = 0) {
    const geometry = new RoundedBoxGeometry(w, h, d, 2, Math.min(.13, w / 4, d / 4));
    const positions = geometry.attributes.position;
    const normals = geometry.attributes.normal;
    const normal = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      const fraction = (positions.getY(i) + h / 2) / h;
      const scale = THREE.MathUtils.lerp(1, topScale, fraction);
      const oldX = positions.getX(i), oldZ = positions.getZ(i);
      const nx = normals.getX(i) / scale, nz = normals.getZ(i) / scale;
      normal.set(nx, normals.getY(i) - ((topScale - 1) * oldX + lean) / h * nx - (topScale - 1) * oldZ / h * nz, nz).normalize();
      normals.setXYZ(i, normal.x, normal.y, normal.z);
      positions.setX(i, oldX * scale + lean * fraction);
      positions.setZ(i, oldZ * scale);
    }
    this.add(geometry, material, x, y, z);
  }
  channel(material: THREE.Material, start: THREE.Vector3, end: THREE.Vector3, width: number, depth = .035) {
    const direction = end.clone().sub(start);
    const middle = start.clone().add(end).multiplyScalar(.5);
    const rotation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_AXIS, direction.clone().normalize()));
    this.box(material, middle.x, middle.y, middle.z, width, direction.length(), depth, .014, rotation);
  }
  cylinder(material: THREE.Material, x: number, y: number, z: number, r: number, h: number, top = r, segments = 32) {
    this.add(new THREE.CylinderGeometry(top, r, h, segments), material, x, y, z);
  }
  ring(material: THREE.Material, x: number, y: number, z: number, radius: number, thickness: number, rotation = new THREE.Euler(Math.PI / 2, 0, 0), arc = TAU) {
    this.add(new THREE.TorusGeometry(radius, thickness, 8, 48, arc), material, x, y, z, rotation);
  }
  finish() {
    for (const [material, pieces] of this.pieces) {
      const merged = mergeGeometries(pieces, false);
      pieces.forEach(p => p.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = !material.transparent;
      mesh.receiveShadow = true;
      this.parent.add(mesh);
    }
    this.pieces.clear();
  }
}

function metalTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const pixels = context.createImageData(256, 256);
  let seed = 613;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const value = 184 + (seed >>> 26) + Math.sin(x * .27) * 9 - (x % 51 < 2 ? 38 : 0);
    const i = (y * 256 + x) * 4;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  context.fillStyle = '#323a40';
  for (let i = 0; i < 32; i++) context.fillRect((i * 47) % 256, (i * 71) % 256, 1, 9 + i % 21);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function palette(): Materials {
  const weathering = metalTexture();
  const make = (color: string, roughness = .7, metalness = .22) => new THREE.MeshStandardMaterial({ color, roughness, metalness, map: weathering });
  const neon = (color: string, intensity = 1.3) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: .27, metalness: .25 });
  return {
    cream: make('#3b4850'), edge: make('#697779', .5), stone: make('#242f36', .85),
    navy: make('#2b4552', .54), blue: make('#4b6876', .65), deep: make('#182831', .8),
    trim: make('#727976', .55), cyan: neon('#438d9b', .45), energy: neon('#43eaff', 1.65),
    white: make('#bad1d1', .37, .6), coral: neon('#ff5c69', 1.35), brass: make('#ac754b', .68),
    coralArmor: make('#331b2d', .43), amber: neon('#ffb637', 1.5), amberCore: make('#4a321f', .48),
    violet: neon('#bd5eff', 1.15), violetArmor: make('#201831', .42), violetLight: neon('#d884ff', 1.9),
    windowAmber: neon('#b88859', .42), rust: make('#6f4434', .95, .2),
    glass: new THREE.MeshStandardMaterial({ color: '#163b4b', transparent: true, opacity: .72, roughness: .34, metalness: .4, depthWrite: false, side: THREE.DoubleSide }),
  };
}

function slit(a: Architecture, material: THREE.Material, x: number, y: number, z: number, w: number, h: number, d = .025, rotation?: THREE.Euler) {
  a.add(new THREE.BoxGeometry(w, h, d), material, x, y, z, rotation);
}

function relayDish(parent: THREE.Group, m: Materials, position: THREE.Vector3, radius: number, direction: THREE.Vector3) {
  const mount = new THREE.Group();
  mount.position.copy(position);
  mount.quaternion.setFromUnitVectors(Y_AXIS, direction.normalize());
  parent.add(mount);
  const a = new Architecture(mount);
  const bowlMaterial = m.trim.clone();
  bowlMaterial.side = THREE.DoubleSide;
  const profile = Array.from({ length: 13 }, (_, i) => {
    const r = radius * i / 12;
    return new THREE.Vector2(Math.max(.015, r), (r / radius) ** 2 * radius * .36);
  });
  a.add(new THREE.LatheGeometry(profile, 40), bowlMaterial);
  a.ring(m.blue, 0, radius * .36, 0, radius, .06);
  a.ring(m.energy, 0, radius * .36 + .055, 0, radius - .017, .022);
  a.cylinder(m.deep, 0, -.2, 0, radius * .22, .42, radius * .17, 12);
  for (let i = 0; i < 3; i++) {
    const angle = i / 3 * TAU;
    a.channel(m.blue, new THREE.Vector3(Math.sin(angle) * radius * .88, radius * .29, Math.cos(angle) * radius * .88), new THREE.Vector3(0, radius * .76, 0), .042, .042);
  }
  a.cylinder(m.brass, 0, radius * .75, 0, radius * .095, radius * .3, radius * .07, 10);
  a.finish();
}

function lattice(a: Architecture, m: Materials, x: number, y: number, z: number, w: number, h: number) {
  for (const sign of [-1, 1]) a.box(m.trim, x + sign * w / 2, y, z, .08, h, .1, .015);
  for (let i = 0; i < 4; i++) {
    const low = y - h / 2 + i * h / 4;
    a.channel(m.blue, new THREE.Vector3(x - w / 2, low, z), new THREE.Vector3(x + w / 2, low + h / 4, z), .065, .075);
    a.channel(m.blue, new THREE.Vector3(x + w / 2, low, z), new THREE.Vector3(x - w / 2, low + h / 4, z), .065, .075);
  }
}

function createDistrict(id: RouteId, index: number, position: THREE.Vector3, materials: Materials, scene: THREE.Scene): District {
  const group = new THREE.Group();
  group.position.copy(position);
  group.userData.route = id;
  scene.add(group);
  const m = materials, windows = m.cyan.clone();
  let a = new Architecture(group);
  const crown = new THREE.Group();
  group.add(crown);
  // These transfer decks are the exposed shoulders of twenty-storey service cores.
  // Their foundations continue through the haze, rather than ending as floating islands.
  a.cylinder(m.deep, 0, -10.2, 0, 1.84, 20, 2.07, 32);
  for (let j = 0; j < 16; j++) {
    const angle = j / 16 * TAU;
    const x = Math.sin(angle) * 2.12, z = Math.cos(angle) * 2.12;
    a.box(j % 4 ? m.blue : m.trim, x, -9.2, z, j % 4 ? .13 : .22, 18.4, .21, .02, new THREE.Euler(0, angle, 0));
    for (let floor = 0; floor < 24; floor++) if ((floor + j * 3 + index) % 4 !== 0) {
      slit(a, (floor + j) % 5 ? m.windowAmber : windows, x * .977, -.7 - floor * .68, z * .977, .17, .044, .028, new THREE.Euler(0, angle, 0));
    }
  }
  for (const y of [-1.2, -4.4, -8.1, -12.4, -16.8]) {
    a.cylinder(m.stone, 0, y, 0, 2.19, .22, 2.13, 32);
    a.ring(m.trim, 0, y + .12, 0, 2.19, .035);
  }
  for (const sign of [-1, 1]) {
    lattice(a, m, sign * 1.35, -6, 1.76, .7, 10.8);
    const pipe = new THREE.CylinderGeometry(.095, .095, 13, 8);
    a.add(pipe, m.rust, sign * 1.93, -6.7, .87);
  }
  const deck = new THREE.CylinderGeometry(2.71, 2.42, .4, 48);
  deck.scale(1, 1, .84);
  a.add(deck, m.stone, 0, 0, 0);
  const shoulder = new THREE.CylinderGeometry(2.42, 2.14, .65, 32);
  shoulder.scale(1, 1, .84);
  a.add(shoulder, m.blue, 0, -.48, 0);
  for (let j = 0; j < 32; j++) {
    const angle = j / 32 * TAU;
    const x = Math.sin(angle) * 2.6, z = Math.cos(angle) * 2.18;
    a.box(m.trim, x, .17, z, .22, .08, .12, .015, new THREE.Euler(0, angle, 0));
    if (j % 2 === 0) slit(a, windows, x, -.16, z, .17, .035, .028, new THREE.Euler(0, angle, 0));
  }
  // Dense mechanical shoulders, ventilation banks and maintenance gantries set the scale.
  for (const side of [-1, 1]) {
    a.box(m.deep, side * 1.65, .52, -.15, .53, .65, 1.45, .04);
    for (let j = 0; j < 9; j++) a.box(m.trim, side * 1.65, .87, -.74 + j * .15, .46, .045, .055, .008);
    a.box(m.brass, side * 2.18, .39, .33, .18, .55, .23, .015);
  }
  a.finish();
  // Only the hero architecture can respond to damage. Foundations and route landings stay fixed.
  const hitGroup = new THREE.Group();
  group.add(hitGroup);
  a = new Architecture(hitGroup);
  if (index === 0) {
    // DATA EXCHANGE: a broad faceted body with a segmented orbital bus, supported at both sides.
    a.tapered(m.navy, -.2, 1.32, -.21, 3.72, 2.17, 2.83, .63, .18);
    a.tapered(m.blue, -.04, 2.77, -.39, 2.37, .83, 1.83, .7, -.17);
    a.tapered(m.deep, -.14, 3.47, -.49, 1.42, .75, 1.16, .66, .09);
    for (let tier = 0; tier < 4; tier++) {
      const y = .72 + tier * .42;
      const width = 3.28 - tier * .28;
      const front = 1.17 - tier * .105;
      a.box(m.blue, -.13, y, front, width, .12, .11, .02);
      for (let segment = 0; segment < 5; segment++) slit(a, windows, -.13 - width * .4 + segment * width * .2, y + .084, front + .066, width * .15, .052);
    }
    for (const side of [-1, 1]) {
      const low = new THREE.Vector3(side * 1.48, .36, -.31);
      const high = new THREE.Vector3(side * 2.06, 4.43, -.31);
      a.channel(m.deep, low, high, .34, .39);
      a.channel(m.trim, low.clone().add(new THREE.Vector3(0, 0, .2)), high.clone().add(new THREE.Vector3(0, 0, .2)), .11, .065);
      a.box(m.blue, side * 2.06, 4.43, -.31, .4, .31, .45, .04);
    }
    const haloHeight = 4.43, haloTilt = Math.PI / 2 - .21;
    const haloLightOffset = new THREE.Vector3(0, Math.sin(haloTilt), -Math.cos(haloTilt)).multiplyScalar(.16);
    for (let segment = 0; segment < 8; segment++) {
      const start = segment / 8 * TAU + .055;
      const shell = new THREE.TorusGeometry(2.06, .15, 10, 20, TAU / 8 - .11);
      shell.rotateZ(start); shell.rotateX(haloTilt);
      a.add(shell, m.blue, 0, haloHeight, -.31);
      const seam = new THREE.TorusGeometry(2.063, .034, 6, 20, TAU / 8 - .17);
      seam.rotateZ(start + .03); seam.rotateX(haloTilt);
      // Offset along the tilted ring's upper normal; the light still intersects its steel housing.
      a.add(seam, m.energy, haloLightOffset.x, haloHeight + haloLightOffset.y, -.31 + haloLightOffset.z);
    }
    a.tapered(m.energy, -.08, 3.93, -.46, .17, .7, .19, .43);
    a.box(m.trim, -.08, 3.59, -.46, .67, .09, .57, .018);
  } else if (index === 1) {
    // SECURE VAULT: two heavy outward-leaning armor blades protect one luminous vertical core.
    a.tapered(m.deep, 0, .79, -.21, 3.73, 1.08, 2.83, .85);
    a.tapered(m.blue, 0, 1.33, -.21, 2.88, .23, 2.23, .92);
    for (const side of [-1, 1]) {
      const x = side * .8;
      a.tapered(m.navy, x, 4.28, -.39, 1.17, 6.16, 1.67, .72, side * .44);
      a.tapered(m.blue, x + side * .48, 4.29, -.39, .27, 6.22, 1.87, .81, side * .44);
      a.channel(m.trim, new THREE.Vector3(x - side * .49, 1.23, .46), new THREE.Vector3(x + side * .12, 7.37, .22), .075, .085);
      for (let panel = 0; panel < 5; panel++) {
        const y = 1.86 + panel * 1.06, lean = side * .44 * (y - 1.2) / 6.16;
        a.box(m.deep, x + lean, y, .425 - panel * .043, .91 - panel * .042, .14, .15, .025);
        slit(a, windows, x + lean + side * .19, y + .19, .515 - panel * .043, .13, .24);
      }
    }
    a.cylinder(m.energy, 0, 4.07, -.08, .185, 5.48, .125, 6);
    a.cylinder(m.blue, 0, 1.42, -.08, .48, .26, .4, 12);
    a.cylinder(m.trim, 0, 6.86, -.08, .4, .21, .31, 12);
    for (const y of [2.04, 4.33, 6.64]) {
      a.box(m.blue, 0, y, -.2, 2.3 + (y - 2) * .11, .23, .71, .027);
      a.box(m.energy, 0, y + .14, .18, .53, .04, .045, .01);
    }
    a.box(m.deep, 0, 7.19, -.28, .82, .38, .71, .04);
    a.box(m.trim, 0, 7.43, -.28, 1.05, .12, .86, .025);
  } else {
    // RELAY INTERCHANGE: a lateral body, raked mast and two large aimed arrays form an asymmetric profile.
    a.tapered(m.navy, -.04, 1.11, -.18, 3.81, 1.71, 2.77, .73, -.18);
    a.box(m.blue, -.1, 1.92, -.19, 3.47, .2, 2.42, .06);
    for (let i = 0; i < 7; i++) slit(a, windows, -1.48 + i * .45, 1.19, 1.19, .28, .21);
    a.tapered(m.deep, -.94, 3.41, -.55, 1.03, 3.36, 1.15, .62, -.49);
    a.tapered(m.blue, -1.48, 3.46, -.55, .3, 3.54, 1.31, .76, -.38);
    a.channel(m.energy, new THREE.Vector3(-.73, 1.88, .08), new THREE.Vector3(-1.11, 5.08, -.08), .042, .039);
    a.channel(m.blue, new THREE.Vector3(1.37, .25, -.48), new THREE.Vector3(1.82, 4.22, -.48), .3, .35);
    a.channel(m.trim, new THREE.Vector3(1.52, .25, -.24), new THREE.Vector3(1.97, 4.22, -.24), .07, .08);
    a.channel(m.blue, new THREE.Vector3(-1.31, 3.82, -.49), new THREE.Vector3(1.81, 3.72, -.47), .23, .37);
    a.box(m.brass, .31, 3.83, -.47, 3.13, .075, .2, .015);
    const largeArray = new THREE.Vector3(.94, 3.91, -.05);
    const smallArray = new THREE.Vector3(.55, 2.63, .81);
    a.channel(m.deep, new THREE.Vector3(1.69, 3.72, -.47), largeArray, .19, .23);
    a.channel(m.deep, new THREE.Vector3(.69, 1.97, .37), smallArray, .17, .19);
    relayDish(hitGroup, m, largeArray, .87, new THREE.Vector3(.18, .75, .64));
    relayDish(hitGroup, m, smallArray, .57, new THREE.Vector3(-.29, .56, .83));
    a.box(m.trim, -1.4, 5.18, -.55, .8, .1, .73, .025);
    a.box(m.blue, -1.4, 5.43, -.55, .31, .46, .36, .025);
  }
  a.finish();
  a = new Architecture(group);
  const entranceX = index === 1 ? .13 : index === 0 ? -.54 : -.68;
  a.box(m.deep, entranceX, .7, 1.42, .75, .91, .33, .025);
  for (const side of [-1, 1]) a.box(windows, entranceX + side * .37, .72, 1.605, .044, .87, .055, .008);
  a.box(windows, entranceX, 1.17, 1.605, .78, .04, .055, .008);
  a.box(m.trim, entranceX, 1.26, 1.56, 1.08, .12, .54, .022);
  a.box(m.blue, entranceX, .27, 1.84, 1.03, .12, .75, .025);
  // The route's existing endpoint sits inside this vestibule, rather than against an exposed deck edge.
  a.box(m.blue, entranceX, 1.29, 1.89, 1.17, .15, 1.03, .03);
  for (const side of [-1, 1]) {
    a.box(m.stone, entranceX + side * .52, .75, 1.89, .13, 1.05, 1.02, .025);
    a.box(m.trim, entranceX + side * .54, .29, 1.93, .2, .17, 1.18, .025);
  }
  const hitGlow = new THREE.MeshBasicMaterial({ color: THREAT_COLORS['bad-login'], transparent: true, opacity: 0, depthWrite: false });
  for (const side of [-1, 1]) a.box(hitGlow, entranceX + side * .37, .72, 1.643, .055, .87, .023, .008);
  a.box(hitGlow, entranceX, 1.17, 1.643, .78, .055, .023, .008);
  a.finish();
  const selection = new THREE.Mesh(new THREE.TorusGeometry(.47, .018, 6, 48), new THREE.MeshBasicMaterial({ color: '#52def0', transparent: true, opacity: .8, depthWrite: false }));
  selection.rotation.x = -Math.PI / 2;
  selection.position.set(entranceX, .34, 1.94);
  group.add(selection);
  const entrance = new THREE.Vector3(entranceX, .7, 1.63).add(position);
  return { id, group, center: position.clone(), label: position.clone().add(new THREE.Vector3(0, -.4, 2.55)), entrance, windows, selection, crown, hitGroup, hitGlow, hitAge: LOCAL_JOLT_SECONDS, hitRecord: null, damage: 0, damageColor: new THREE.Color(THREAT_COLORS['bad-login']) };
}

function createDistrictWarning(district: District, _index: number, scene: THREE.Scene): DistrictWarning {
  const group = new THREE.Group();
  group.position.copy(district.center);
  group.visible = false;
  scene.add(group);
  const halfWidth = 2.72, halfDepth = 2.3;
  const contour = new THREE.CatmullRomCurve3(Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.sin(i / 96 * TAU) * halfWidth, .23, Math.cos(i / 96 * TAU) * halfDepth)), true);
  const line = new THREE.MeshBasicMaterial({ color: THREAT_COLORS['bad-login'], transparent: true, opacity: .58, depthWrite: false });
  const glow = new THREE.MeshBasicMaterial({ color: THREAT_COLORS['bad-login'], transparent: true, opacity: .085, depthWrite: false });
  const geometry = new Architecture(group);
  geometry.add(new THREE.TubeGeometry(contour, 104, .035, 6, true), line);
  geometry.add(new THREE.TubeGeometry(contour, 104, .11, 6, true), glow);
  // Fixed beacons are city infrastructure, never ornamental request traffic.
  for (const side of [-1, 1]) {
    geometry.box(line, side * 1.9, .68, 1.63, .055, .58, .055, .02);
    geometry.box(glow, side * 1.9, .68, 1.63, .14, .69, .14, .05);
  }
  geometry.finish();
  return { group, line, glow, age: 0, active: false, threatType: null };
}

function ribbon(curve: THREE.CubicBezierCurve3, from: number, to: number, width: number, height: number, pivot: THREE.Vector3) {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const steps = 36;
  for (let i = 0; i <= steps; i++) {
    const t = THREE.MathUtils.lerp(from, to, i / steps);
    const point = curve.getPoint(t).sub(pivot);
    const tangent = curve.getTangent(t);
    const right = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize().multiplyScalar(width / 2);
    positions.push(point.x + right.x, point.y + height, point.z + right.z, point.x - right.x, point.y + height, point.z - right.z);
    uvs.push(0, i / steps, 1, i / steps);
    if (i < steps) { const n = i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createRoute(id: RouteId, index: number, m: Materials, scene: THREE.Scene): Route {
  const paths = [
    [[-10, .26, 7.5], [-9, .26, 5.4], [-5.35, .26, 4.9], [-4.84, .26, 3.4]],
    [[.6, .26, 9.35], [.25, .26, 6.3], [-.2, .26, 1.0], [-.17, .26, -1.4]],
    [[13.2, 2.4, -.5], [11.2, 2.3, 1.4], [5.6, .65, 5.15], [3.97, .26, 2.8]],
  ];
  const ps = paths[index].map(p => new THREE.Vector3(...p));
  const curve = new THREE.CubicBezierCurve3(ps[0], ps[1], ps[2], ps[3]);
  const createSegment = (from: number, to: number, pivot: THREE.Vector3) => {
    const group = new THREE.Group();
    group.position.copy(pivot);
    const floor = new THREE.Mesh(ribbon(curve, from, to, .91, 0, pivot), m.deep);
    floor.receiveShadow = true;
    group.add(floor);
    const architecture = new Architecture(group);
    for (const side of [-1, 1]) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= 32; i++) {
        const t = THREE.MathUtils.lerp(from, to, i / 32);
        const point = curve.getPoint(t).sub(pivot);
        const tangent = curve.getTangent(t);
        point.add(new THREE.Vector3(tangent.z, 0, -tangent.x).normalize().multiplyScalar(side * .48));
        point.y += .025;
        points.push(point);
      }
      architecture.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 40, .028, 5, false), m.energy);
      const upper = points.map(p => p.clone().add(new THREE.Vector3(0, .19, 0)));
      architecture.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(upper), 40, .018, 5, false), m.trim);
      const lower = points.map(p => p.clone().add(new THREE.Vector3(0, -.43, 0)));
      architecture.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lower), 40, .058, 6, false), m.blue);
      for (let span = 0; span < 8; span++) {
        const first = span * 4, last = first + 4;
        architecture.channel(m.trim, points[first], lower[last], .042, .048);
        architecture.channel(m.blue, lower[first], points[last], .047, .052);
      }
    }
    for (let t = Math.ceil(from * 12) / 12; t <= to; t += 1 / 12) {
      const point = curve.getPoint(t).sub(pivot);
      const tangent = curve.getTangent(t);
      const angle = Math.atan2(tangent.x, tangent.z);
      architecture.box(m.blue, point.x, point.y - .065, point.z, 1.06, .14, .14, .015, new THREE.Euler(0, angle, 0));
      architecture.box(m.cyan, point.x, point.y + .015, point.z, .09, .018, .27, .015, new THREE.Euler(0, angle, 0));
    }
    architecture.finish();
    scene.add(group);
    return group;
  };
  createSegment(0, .73, new THREE.Vector3());
  const retract = createSegment(.73, 1, curve.getPoint(.73));
  const source = curve.getPoint(0);
  const outward = curve.getTangent(0).setY(0).normalize().negate();
  const arterialStart = source.clone().addScaledVector(outward, index === 1 ? 60 : 19);
  const feed = new THREE.CubicBezierCurve3(arterialStart, arterialStart.clone().lerp(source, .33), arterialStart.clone().lerp(source, .67), source);
  const infrastructure = new THREE.Group();
  scene.add(infrastructure);
  const support = new Architecture(infrastructure);
  support.add(ribbon(feed, 0, 1, 1.06, -.025, new THREE.Vector3()), m.stone);
  for (const side of [-1, 1]) {
    const edge = new THREE.Vector3(outward.z, 0, -outward.x).multiplyScalar(side * .53);
    const start = arterialStart.clone().add(edge), end = source.clone().add(edge);
    support.channel(m.blue, start.clone().add(new THREE.Vector3(0, -.18, 0)), end.clone().add(new THREE.Vector3(0, -.18, 0)), .11, .15);
    support.channel(m.cyan, start, end, .018, .022);
  }
  // Internet uplinks join the city artery to a fixed request exit. Their wire globes are neutral
  // network infrastructure, with no shield surface, interaction or policy state.
  const terminal = new THREE.Group();
  terminal.position.copy(source);
  terminal.rotation.y = Math.atan2(-outward.x, -outward.z);
  infrastructure.add(terminal);
  const terminalBody = new Architecture(terminal);
  terminalBody.box(m.deep, 0, -12.3, 0, 1.04, 24.4, 1.37, .055);
  for (const side of [-1, 1]) {
    terminalBody.box(m.blue, side * .51, -12.3, .46, .12, 24.4, .21, .02);
    terminalBody.box(m.blue, side * .76, .18, -.25, .44, .48, 1.41, .03);
    for (let vent = 0; vent < 5; vent++) terminalBody.box(m.trim, side * .76, .433, -.76 + vent * .24, .34, .031, .061, .009);
    terminalBody.box(m.windowAmber, side * .76, .2, .475, .12, .055, .024, .005);
  }
  terminalBody.box(m.stone, 0, -.18, -.18, 2.04, .32, 2.11, .045);
  terminalBody.box(m.blue, 0, -.49, -.18, 1.49, .32, 1.74, .04);
  const globe = new THREE.Vector3(-.83, 1.33, -.28), globeRadius = .53;
  terminalBody.cylinder(m.blue, globe.x, .55, globe.z, .19, .37, .25, 12);
  terminalBody.channel(m.trim, new THREE.Vector3(globe.x, .52, globe.z), globe.clone().add(new THREE.Vector3(0, -.38, 0)), .12, .13);
  for (const tilt of [0, Math.PI / 3, Math.PI * 2 / 3]) terminalBody.ring(m.energy, globe.x, globe.y, globe.z, globeRadius, .021, new THREE.Euler(0, tilt, 0));
  terminalBody.ring(m.cyan, globe.x, globe.y, globe.z, globeRadius, .023);
  for (const latitude of [-.28, .28]) terminalBody.ring(m.cyan, globe.x, globe.y + latitude, globe.z, Math.sqrt(globeRadius ** 2 - latitude ** 2), .014);
  for (let node = 0; node < 6; node++) {
    const angle = node / 6 * TAU;
    terminalBody.add(new THREE.SphereGeometry(.043, 8, 6), m.energy, globe.x + Math.sin(angle) * globeRadius, globe.y, globe.z + Math.cos(angle) * globeRadius);
  }
  for (const side of [-1, 1]) {
    terminalBody.channel(m.blue, new THREE.Vector3(side * .8, .43, -.56), new THREE.Vector3(side * .56, .47, .15), .075, .085);
    terminalBody.box(m.cyan, side * .52, .04, 0, .085, .065, .48, .018);
  }
  terminalBody.box(m.energy, 0, .025, -.025, .91, .025, .075, .012);
  terminalBody.finish();
  const uplinkLabel = new THREE.Vector3(globe.x, index === 1 ? -.7 : 2.15, globe.z).applyAxisAngle(Y_AXIS, terminal.rotation.y).add(source);
  const anchor = [new THREE.Vector3(-4.3, -3.1, 1.25), new THREE.Vector3(-.3, -3.1, -3.55), new THREE.Vector3(4.65, -3.1, .65)][index];
  const bearing = curve.getPoint(.72).add(new THREE.Vector3(0, -.46, 0));
  const across = curve.getTangent(.72);
  const lateral = new THREE.Vector3(across.z, 0, -across.x).normalize();
  for (const side of [-1, 1]) support.channel(m.blue, anchor.clone().addScaledVector(lateral, side * .53), bearing.clone().addScaledVector(lateral, side * .39), .17, .21);
  support.finish();
  const shield = new THREE.Group();
  shield.position.copy(curve.getPoint(.72)).add(new THREE.Vector3(0, .53, 0));
  shield.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangent(.72));
  const shieldDisc = new THREE.MeshBasicMaterial({ color: '#7ae6ef', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const shieldRim = new THREE.MeshBasicMaterial({ color: '#81f0f3', transparent: true, opacity: 0, depthWrite: false });
  shield.add(new THREE.Mesh(new THREE.CircleGeometry(.65, 48), shieldDisc));
  shield.add(new THREE.Mesh(new THREE.TorusGeometry(.65, .033, 8, 56), shieldRim));
  const inner = new THREE.Mesh(new THREE.TorusGeometry(.53, .009, 6, 48), shieldRim);
  shield.add(inner);
  if (index === 0) {
    // This route is nearly edge-on from the fixed camera. A shallow lens retains
    // the cross-route barrier while giving its side profile a readable width.
    const lens = new THREE.SphereGeometry(.65, 32, 16);
    lens.scale(1, 1, .42);
    shield.add(new THREE.Mesh(lens, shieldDisc));
    const profile = new THREE.TorusGeometry(.65, .025, 6, 48);
    profile.rotateY(Math.PI / 2);
    profile.scale(1, 1, .42);
    shield.add(new THREE.Mesh(profile, shieldRim));
  }
  const glyph = new THREE.Group();
  const glyphBuilder = new Architecture(glyph);
  glyphBuilder.box(shieldRim, 0, -.02, .012, .24, .23, .028, .03);
  glyphBuilder.ring(shieldRim, 0, .13, .012, .094, .026, new THREE.Euler(), Math.PI);
  glyphBuilder.finish();
  shield.add(glyph);
  scene.add(shield);
  // Arrival gates read as real pieces of infrastructure even before a policy is enabled.
  const gate = new THREE.Group();
  gate.position.copy(shield.position);
  gate.quaternion.copy(shield.quaternion);
  const a = new Architecture(gate);
  for (const side of [-1, 1]) {
    a.box(m.cream, side * .57, -.38, 0, .15, .47, .25, .045);
    a.box(m.blue, side * .57, -.12, 0, .115, .18, .2, .025);
    a.box(m.cyan, side * .57, -.015, 0, .09, .055, .16, .02);
  }
  a.finish();
  scene.add(gate);
  return { id, curve, uplinkLabel, retract, shield, shieldDisc, shieldRim, isolation: 0, flash: 0, gate: initialGateMotion() };
}

function createUndercity(scene: THREE.Scene, m: Materials) {
  const city = new THREE.Group();
  scene.add(city);
  const backSteel = m.deep.clone();
  backSteel.color.set('#28363c');
  const backTrim = m.blue.clone();
  backTrim.color.set('#455259');
  const dimWindows = m.windowAmber.clone();
  dimWindows.emissiveIntensity = .28;
  dimWindows.color.set('#947451');
  const coolWindows = m.cyan.clone();
  coolWindows.emissiveIntensity = .18;
  const a = new Architecture(city);
  let seed = 8102;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // Sparse intermediate structures connect the distant environment matte to the playable city.
  // Keep the central sky canyon open; the background must not become a repetitive opaque wall.
  for (const [col, [x, z]] of [[-38, -20], [16, -20]].entries()) {
    const height = 12 + random() * 8;
    const w = 1.5 + random() * .4, d = 1.7 + random() * .5;
    const top = -18 + height;
    a.add(new THREE.BoxGeometry(w, height, d), backSteel, x, -18 + height / 2, z);
    for (let rib = 0; rib < 4; rib++) a.add(new THREE.BoxGeometry(.085, height + .2, d + .1), backTrim, x - w * .4 + rib * w * .267, -18 + height / 2, z);
    for (let level = 0; level < height / .57; level++) for (let lane = 0; lane < 4; lane++) {
      if (random() < .48) continue;
      slit(a, random() > .83 ? coolWindows : dimWindows, x - w * .36 + lane * w * .24, -17.6 + level * .57, z + d / 2 + .02, .08 + random() * .12, .045);
    }
    a.add(new THREE.BoxGeometry(w * .72, .45 + random(), d * .68), backTrim, x, top + .12, z);
    if (col % 3 === 0) a.cylinder(backTrim, x, top + 1.1, z, .03, 2.2, .018, 6);
  }
  // Lower industrial terraces fill the canyon; large cropped structures imply a city beyond the frame.
  // Keep this authored lower layer stable when the distant silhouettes change.
  seed = 1665247480;
  for (let i = 0; i < 15; i++) {
    const x = -24 + i % 5 * 11 + random() * 4;
    const z = -4 + Math.floor(i / 5) * 8 + random() * 4;
    const top = -7.5 - random() * 7;
    const h = 19 + top, w = 1.7 + random() * 2.4, d = 2 + random() * 2.5;
    a.add(new THREE.BoxGeometry(w, h, d), backSteel, x, top - h / 2, z);
    for (let j = 0; j < 4; j++) {
      a.add(new THREE.BoxGeometry(w + .22, .12, d + .2), backTrim, x, top - j * 2.2, z);
      for (let k = 0; k < 5; k++) slit(a, dimWindows, x - w * .37 + k * w * .18, top - .47 - j * 2.2, z + d / 2 + .015, .18, .045);
    }
    if (i % 3 === 0) {
      a.add(new THREE.BoxGeometry(w * .6, .62, d * .4), backTrim, x, top + .31, z);
      for (let j = 0; j < 6; j++) slit(a, backSteel, x - w * .22 + j * w * .09, top + .63, z, .06, .015, d * .35);
    } else if (i % 3 === 1) {
      a.cylinder(backTrim, x - w * .2, top + .27, z, .24, .54, .24, 12);
      a.cylinder(backTrim, x + w * .2, top + .44, z, .15, .88, .15, 8);
    } else {
      a.add(new THREE.BoxGeometry(.16, 1.05, .2), backTrim, x, top + .52, z);
      a.add(new THREE.BoxGeometry(w * .83, .1, .18), backTrim, x, top + 1.02, z);
    }
  }
  a.finish();
  city.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = false; object.receiveShadow = false; } });

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(128, 128, 9, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(116,124,123,.9)');
  gradient.addColorStop(.52, 'rgba(95,111,118,.55)');
  gradient.addColorStop(1, 'rgba(74,93,102,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const haze = new THREE.Group();
  scene.add(haze);
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(56 + i * 10, 43 + i * 8), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: .12 + i * .035, depthWrite: false, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(i % 2 ? -3 : 4, -3.7 - i * 4, -2);
    haze.add(mesh);
  }
  return haze;
}

function travelerTemplates(m: Materials) {
  const customer = new THREE.Group();
  const ca = new Architecture(customer);
  // A directional luminous courier: a long cyan keel under one swept ivory shell.
  // There are no cubic bodies, faces, dots, pips, or ornamental request records.
  const keel = new THREE.CapsuleGeometry(.126, .35, 4, 12);
  keel.rotateX(Math.PI / 2);
  keel.scale(1, .82, 1);
  ca.add(keel, m.energy);
  const shell = new THREE.CapsuleGeometry(.105, .27, 4, 12);
  shell.rotateX(Math.PI / 2);
  shell.scale(1.04, .54, 1);
  ca.add(shell, m.white, 0, .076, .016);
  const wake = new THREE.ConeGeometry(.069, .24, 12);
  wake.rotateX(-Math.PI / 2);
  wake.scale(1, .56, 1);
  ca.add(wake, m.energy, 0, -.014, -.364);
  ca.finish();
  const badLogin = new THREE.Group();
  const probe = new Architecture(badLogin);
  const dart = new THREE.OctahedronGeometry(.24, 0);
  dart.scale(.72, .58, 1.2);
  probe.add(dart, m.coral, 0, .015, .11);
  probe.box(m.coral, 0, -.01, -.17, .077, .1, .4, .018);
  probe.box(m.coralArmor, .105, -.01, -.19, .2, .1, .063, .008);
  probe.box(m.coralArmor, .105, -.01, -.33, .2, .1, .063, .008);
  probe.finish();

  const swarm = new THREE.Group();
  const spinner = new Architecture(swarm);
  // Three linked prongs are a single silhouette for a single recorded swarm request.
  spinner.add(new THREE.OctahedronGeometry(.12, 0), m.amberCore);
  spinner.ring(m.amberCore, 0, -.015, 0, .17, .025);
  for (let i = 0; i < 3; i++) {
    const angle = i / 3 * TAU;
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const lobe = direction.clone().multiplyScalar(.18);
    spinner.add(new THREE.IcosahedronGeometry(.105, 0), m.amber, lobe.x, .01, lobe.z);
    const tip = direction.clone().multiplyScalar(.28);
    const rotation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_AXIS, direction));
    spinner.add(new THREE.ConeGeometry(.075, .19, 3), m.amber, tip.x, .01, tip.z, rotation);
  }
  spinner.finish();

  const breach = new THREE.Group();
  const carrier = new Architecture(breach);
  // A wide armored carrier overhangs the narrow bridge; it cannot read as a tiny probe.
  carrier.box(m.violetArmor, 0, 0, 0, .6, .28, .82, .085);
  const prow = new THREE.OctahedronGeometry(.24, 0);
  prow.scale(1.2, .58, 1.18);
  carrier.add(prow, m.violet, 0, -.005, .35);
  carrier.tapered(m.violetArmor, 0, .185, -.035, .47, .15, .58, .76);
  carrier.box(m.violetLight, 0, .273, -.02, .12, .034, .4, .017);
  for (const side of [-1, 1]) {
    carrier.tapered(m.violetArmor, side * .44, -.015, -.08, .34, .18, .72, .64, side * .025);
    carrier.box(m.violet, side * .57, .047, -.08, .035, .034, .61, .012);
    carrier.box(m.violet, side * .39, .091, .24, .3, .032, .038, .012);
    carrier.box(m.violetArmor, side * .43, .1, -.13, .22, .065, .42, .026);
    carrier.box(m.violetLight, side * .52, -.11, -.09, .062, .045, .47, .018);
    carrier.box(m.violetLight, side * .19, -.055, -.45, .075, .056, .16, .024);
  }
  carrier.finish();
  return { customer, badLogin, swarm, breach };
}

export default function CityScene(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const uplinkRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const current = useRef(props);
  current.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog('#697b82', 29, 82);
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }); }
    catch {
      const warning = document.createElement('p');
      warning.textContent = 'This city needs WebGL. Enable hardware acceleration, then reload.';
      warning.style.cssText = 'position:absolute;top:42%;left:30%;color:#c4d6dc;max-width:24rem';
      host.appendChild(warning);
      return () => warning.remove();
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
    renderer.setClearColor('#192b36', 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none';
    renderer.domElement.setAttribute('aria-label', 'Industrial server city above a deep urban canyon. Select a district, or use number keys one through three.');
    host.prepend(renderer.domElement);

    const camera = new THREE.OrthographicCamera(-15, 15, 9, -9, .1, 160);
    const light = new THREE.DirectionalLight('#ffd09a', 3.25);
    light.position.set(-10, 18, -13);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    Object.assign(light.shadow.camera, { left: -19, right: 19, top: 19, bottom: -19, near: .5, far: 80 });
    light.shadow.normalBias = .035;
    light.shadow.bias = -.00025;
    light.shadow.radius = 4;
    scene.add(light);
    scene.add(new THREE.HemisphereLight('#acd8e5', '#3a3029', 1.65));
    const fill = new THREE.DirectionalLight('#9bd9ed', 3.3);
    fill.position.set(8, 8, 15);
    scene.add(fill);

    const materials = palette();
    const positions = [new THREE.Vector3(-4.3, 0, 1.25), new THREE.Vector3(-.3, 0, -3.55), new THREE.Vector3(4.65, 0, .65)];
    const districts = IDS.map((id, i) => createDistrict(id, i, positions[i], materials, scene));
    const warnings = districts.map((district, i) => createDistrictWarning(district, i, scene));
    const routes = IDS.map((id, i) => createRoute(id, i, materials, scene));
    const clouds = createUndercity(scene, materials);
    // Two short civic links make this a connected city without crowding its arrival lanes.
    const civic = new THREE.Group();
    const civicArchitecture = new Architecture(civic);
    for (const [a, b] of [[new THREE.Vector3(-2.1, .24, -.55), new THREE.Vector3(-1.7, .24, -1.65)], [new THREE.Vector3(1.75, .24, -1.95), new THREE.Vector3(2.5, .24, -1.1)]]) {
      const delta = b.clone().sub(a), mid = a.clone().add(b).multiplyScalar(.5), angle = Math.atan2(delta.x, delta.z);
      civicArchitecture.box(materials.cream, mid.x, mid.y, mid.z, .71, .14, delta.length() + .2, .07, new THREE.Euler(0, angle, 0));
      civicArchitecture.box(materials.cyan, mid.x, mid.y + .08, mid.z, .39, .025, delta.length(), .025, new THREE.Euler(0, angle, 0));
    }
    civicArchitecture.finish();
    scene.add(civic);

    const templates = travelerTemplates(materials);
    const travelers: Traveler[] = [];
    const activeById = new Map<string, Traveler>();
    const pending: PendingTraveler[] = [];
    const seen = new Set<string>();
    const completedSeen = new Set<string>();
    let lastState: GameState | null = null, sessionId = '', lastPhase = '', spawnTimer = 0, celebration = 0;
    let missionTime = 0, observedMissionTime = 0, observedMissionAtMs = performance.now();
    const continuityCounts = { spawned: 0, joinedOutcomes: 0, completed: 0, cancelled: 0, discardedStale: 0, discardedCapacity: 0, sessionResets: 0, lateOmitted: 0 };
    const recentBirths: { id: string; uuid: string; route: RouteId; role: IncomingRequest['role']; threatType: ThreatType | null; source: Traveler['source']; firstProgress: number; sourcePosition: number[]; firstPosition: number[]; rawCurveOrigin: number[]; screenPosition: number[]; visualBornAt: number; decisionAt: number }[] = [];
    const lateOmissions: { id: string; route: RouteId; reason: 'late-admission' | 'missed-approach'; missionTime: number; decisionAt: number; remaining: number }[] = [];
    const recentHits: { route: RouteId; recordId: string; actualStatus: number; damage: number; missionTime: number }[] = [];
    const omitLate = (request: { id: string; route: RouteId; decisionAt: number }, reason: 'late-admission' | 'missed-approach') => {
      continuityCounts.lateOmitted++;
      lateOmissions.push({ id: request.id, route: request.route, reason, missionTime, decisionAt: request.decisionAt, remaining: request.decisionAt - missionTime });
      if (lateOmissions.length > 64) lateOmissions.shift();
    };
    const recentRemovals: { id: string; uuid: string; reason: 'completed' | 'incoming-cancelled' | 'session-reset'; progress: number; measuredStatus: number | null }[] = [];
    const recentPolicyChanges: { route: RouteId; revision: number; actorIds: string[] }[] = [];
    const removeTraveler = (traveler: Traveler, reason: 'completed' | 'incoming-cancelled' | 'session-reset') => {
      scene.remove(traveler.object);
      activeById.delete(traveler.request.id);
      recentRemovals.push({ id: traveler.request.id, uuid: traveler.object.uuid, reason, progress: traveler.progress, measuredStatus: traveler.record?.status ?? null });
      if (recentRemovals.length > 32) recentRemovals.shift();
      if (reason === 'completed') continuityCounts.completed++;
      if (reason === 'incoming-cancelled') continuityCounts.cancelled++;
    };
    const particles: Particle[] = [];
    const particlePositions = new Float32Array(96 * 3);
    const particleColors = new Float32Array(96 * 3);
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3).setUsage(THREE.DynamicDrawUsage));
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3).setUsage(THREE.DynamicDrawUsage));
    particleGeometry.setDrawRange(0, 0);
    const particlePoints = new THREE.Points(particleGeometry, new THREE.PointsMaterial({ size: 4.0, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: .85, depthWrite: false }));
    particlePoints.frustumCulled = false;
    scene.add(particlePoints);
    const burst = (origin: THREE.Vector3, color: string, count: number, power = 1) => {
      if (current.current.reducedMotion) return;
      for (let i = 0; i < count && particles.length < 96; i++) {
        const angle = Math.random() * TAU;
        particles.push({ position: origin.clone(), velocity: new THREE.Vector3(Math.cos(angle) * power * (.3 + Math.random()), .8 + Math.random() * power, Math.sin(angle) * power * (.3 + Math.random())), age: 0, life: .55 + Math.random() * .6, color: new THREE.Color(color) });
      }
    };

    const compactLayout = matchMedia('(max-width:850px), (max-width:1000px) and (max-height:600px)');
    let width = 1, height = 1, zoom = 1, desiredZoom = 1, time = 0, previousTime = performance.now(), raf = 0, disposed = false;
    const cameraTarget = new THREE.Vector3(-.5, .8, .3);
    const ambientCameraPosition = new THREE.Vector3();
    const cameraDamageOffset = new THREE.Vector3();
    const projected = new THREE.Vector3();
    const uplinkLabelWidths = [0, 0, 0];
    const resize = () => {
      width = Math.max(host.clientWidth, 1);
      height = Math.max(host.clientHeight, 1);
      uplinkRefs.current.forEach((label, i) => { uplinkLabelWidths[i] = Math.ceil(label?.getBoundingClientRect().width ?? 0); });
      renderer.setSize(width, height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    uplinkRefs.current.forEach(label => { if (label) observer.observe(label); });
    resize();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hitAt = (event: PointerEvent) => {
      const box = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(districts.map(d => d.group), true);
      if (!hits.length) return null;
      let item: THREE.Object3D | null = hits[0].object;
      while (item && !item.userData.route) item = item.parent;
      return item?.userData.route as RouteId | undefined;
    };
    const click = (event: PointerEvent) => { const hit = hitAt(event); if (hit) current.current.onSelect(hit); };
    const move = (event: PointerEvent) => { renderer.domElement.style.cursor = hitAt(event) ? 'pointer' : 'default'; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); desiredZoom = THREE.MathUtils.clamp(desiredZoom - event.deltaY * .00055, .84, 1.17); };
    renderer.domElement.addEventListener('pointerup', click);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('wheel', wheel, { passive: false });

    let measuredFrames = 0, measuredTime = 0, perfTime = 0;
    const context = renderer.getContext();
    const extension = context.getExtension('WEBGL_debug_renderer_info');
    const rendererName = extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
    const performanceData: Record<string, unknown> = {};
    (window as Window & { __cloudbreakPerf?: unknown }).__cloudbreakPerf = performanceData;
    const draw = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(draw);
      const rawDt = Math.max(0, (now - previousTime) / 1000);
      const dt = Math.min(rawDt, .045);
      previousTime = now;
      const { state, selected, reducedMotion, titleMode } = current.current;
      const paused = state?.phase === 'paused';
      const simulationDt = paused ? 0 : dt;
      time += simulationDt;
      const aspect = width / height;
      const selectedCenter = districts[IDS.indexOf(selected)].center;
      const target = new THREE.Vector3(titleMode && aspect > 1.25 ? -5.1 : -.25, titleMode ? -.35 : -.8, titleMode ? .05 : .1);
      if (!titleMode) target.addScaledVector(selectedCenter, .018);
      cameraTarget.lerp(target, reducedMotion ? 1 : 1 - Math.exp(-dt * 3));
      zoom = THREE.MathUtils.damp(zoom, desiredZoom, 7, dt);
      const baseHeight = aspect < 1.3 ? 26 / Math.max(aspect, .25) : 23;
      const arrival = reducedMotion ? 1 : Math.min(time / 1.6, 1);
      const arrivalEase = 1 - Math.pow(1 - arrival, 3);
      const viewHeight = baseHeight / zoom * (1.055 - arrivalEase * .055);
      camera.left = -viewHeight * aspect / 2;
      camera.right = viewHeight * aspect / 2;
      camera.top = viewHeight / 2;
      camera.bottom = -viewHeight / 2;
      const depthOffset = compactLayout.matches ? 40 : 0;
      camera.far = 160 + depthOffset;
      camera.updateProjectionMatrix();
      const drift = reducedMotion ? 0 : Math.sin(time * .13) * .15;
      ambientCameraPosition.copy(cameraTarget).add(new THREE.Vector3(16 + drift, 11.5 + (1 - arrivalEase) * 1.6, 24 - drift));
      // Orthographic framing is unchanged; move the near clip behind the mobile feeder.
      // Offset fog distances equally so the accepted city haze remains the same.
      ambientCameraPosition.addScaledVector(ambientCameraPosition.clone().sub(cameraTarget).normalize(), depthOffset);
      (scene.fog as THREE.Fog).near = 29 + depthOffset;
      (scene.fog as THREE.Fog).far = 82 + depthOffset;
      camera.position.copy(ambientCameraPosition);
      camera.lookAt(cameraTarget);
      camera.updateMatrixWorld(true);
      if (state && state !== lastState) {
        if (state.sessionId !== sessionId || (lastState !== null && (state.logFile !== lastState.logFile || state.elapsed < lastState.elapsed || state.totalRequests < lastState.totalRequests))) {
          travelers.splice(0).forEach(traveler => removeTraveler(traveler, 'session-reset'));
          pending.length = 0;
          particles.length = 0;
          seen.clear();
          completedSeen.clear();
          if (sessionId) continuityCounts.sessionResets++;
          sessionId = state.sessionId;
          districts.forEach(d => { d.damage = 0; d.hitAge = LOCAL_JOLT_SECONDS; d.hitRecord = null; d.hitGroup.position.set(0, 0, 0); d.hitGlow.opacity = 0; });
          recentBirths.length = lateOmissions.length = recentHits.length = 0;
          routes.forEach(route => { route.flash = 0; route.isolation = 0; route.gate = initialGateMotion(); });
          warnings.forEach(warning => { warning.active = false; warning.age = 0; warning.threatType = null; });
          missionTime = state.elapsed;
          observedMissionTime = state.elapsed;
          observedMissionAtMs = now;
          celebration = spawnTimer = 0;
        }
        if (state.elapsed !== observedMissionTime || state.phase !== lastPhase) {
          observedMissionTime = state.elapsed;
          observedMissionAtMs = now;
          if (!paused) missionTime = Math.max(missionTime, state.elapsed);
        }
        for (const route of routes) {
          const policy = state.routes.find(item => item.id === route.id)?.policy;
          const key = `${Number(!!policy?.auth)}:${policy?.rate ?? 0}:${Number(!!policy?.isolated)}`;
          const gate = route.gate;
          if (key !== gate.policyKey) {
            const changed = gate.policyKey !== null;
            gate.policyKey = key;
            gate.mode = policy?.isolated ? 'closed' : policy?.auth && policy.rate ? 'combined' : policy?.auth ? 'key-check' : policy?.rate ? 'slow-flow' : 'open';
            gate.fromShield = gate.actualShield;
            gate.fromIsolation = route.isolation;
            gate.desiredShield = Number(!!(policy?.auth || policy?.rate || policy?.isolated));
            gate.desiredIsolation = Number(!!policy?.isolated);
            gate.observedAtMs = now;
            gate.frames = 0;
            gate.revision++;
            gate.visibleAtMs = gate.fromShield === gate.desiredShield ? now : null;
            gate.convergedAtMs = gate.fromShield === gate.desiredShield && gate.fromIsolation === gate.desiredIsolation ? now : null;
            route.flash = 0;
            if (changed) {
              // Policy confirmation changes only the gate. Each request keeps its actor and measured outcome.
              recentPolicyChanges.push({ route: route.id, revision: gate.revision, actorIds: travelers.filter(traveler => traveler.request.route === route.id).map(traveler => traveler.request.id) });
              if (recentPolicyChanges.length > 32) recentPolicyChanges.shift();
            }
          }
        }
        const activeThreats = state.phase === 'running' || state.phase === 'paused' ? state.wave.threats ?? [] : [];
        warnings.forEach((warning, i) => {
          const kind = activeThreats.find(threat => threat.route === IDS[i])?.threatType ?? ((state.phase === 'running' || state.phase === 'paused') ? state.incoming?.find(request => request.route === IDS[i] && request.role === 'hostile')?.threatType : null) ?? null;
          if (!kind) { warning.active = false; warning.age = 0; warning.threatType = null; return; }
          if (!warning.active || warning.threatType !== kind) {
            warning.age = 0;
            warning.threatType = kind;
            warning.line.color.set(THREAT_COLORS[kind]);
            warning.glow.color.set(THREAT_COLORS[kind]);
          }
          warning.active = true;
        });
        for (const request of state.incoming ?? []) {
          if (seen.has(request.id)) continue;
          seen.add(request.id);
          if (state.phase === 'running' || state.phase === 'paused') pending.push({ request, record: null, source: 'incoming', queuedAt: state.elapsed });
        }
        for (const event of [...state.events].sort((a, b) => a.missionTime - b.missionTime)) {
          if (completedSeen.has(event.id)) continue;
          completedSeen.add(event.id);
          const existing = activeById.get(event.id) ?? pending.find(item => item.request.id === event.id);
          if (existing) {
            existing.record = event;
            continuityCounts.joinedOutcomes++;
            continue;
          }
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          if (event.approachStartedAt !== undefined || event.decisionAt !== undefined) {
            // A missed generated approach stays omitted. Its measured result is never replayed as a new actor.
            omitLate({ id: event.id, route: event.route, decisionAt: event.decisionAt ?? event.missionTime }, 'missed-approach');
            continue;
          }
          if (state.elapsed - event.missionTime > MAX_QUEUED_AGE_SECONDS) { continuityCounts.discardedStale++; continue; }
          // Explicit direct dispatch has no scheduled approach; replay only its real result.
          if (state.phase === 'running' || state.phase === 'paused') pending.push({ request: { id: event.id, route: event.route, role: event.role, threatType: event.threatType, approachStartedAt: event.approachStartedAt ?? event.missionTime, decisionAt: event.decisionAt ?? event.missionTime }, record: event, source: 'record-replay', queuedAt: event.missionTime });
        }
        if (state.incoming !== undefined) {
          const incomingIds = new Set(state.incoming.map(request => request.id));
          // Only a genuine backend cancellation may remove an undecided request. Outcomes joined above win.
          for (let i = travelers.length - 1; i >= 0; i--) {
            const traveler = travelers[i];
            if (traveler.source === 'incoming' && !traveler.record && !incomingIds.has(traveler.request.id)) {
              removeTraveler(traveler, 'incoming-cancelled');
              travelers.splice(i, 1);
            }
          }
          for (let i = pending.length - 1; i >= 0; i--) if (pending[i].source === 'incoming' && !pending[i].record && !incomingIds.has(pending[i].request.id)) pending.splice(i, 1);
        }
        // Every visual has a real scheduled request or completed record. Sampling never responds to policy.
        if (pending.length > 72) continuityCounts.discardedCapacity += pending.splice(0, pending.length - 72).length;
        if (seen.size > 16000) { const recent = [...seen].slice(-8000); seen.clear(); recent.forEach(id => seen.add(id)); }
        if (completedSeen.size > 16000) { const recent = [...completedSeen].slice(-8000); completedSeen.clear(); recent.forEach(id => completedSeen.add(id)); }
        if (state.phase === 'won' && lastPhase !== 'won') celebration = 4;
        lastPhase = state.phase;
        lastState = state;
      }
      if (!paused && state?.phase === 'running') {
        missionTime = Math.max(missionTime, Math.min(state.duration, observedMissionTime + Math.min((now - observedMissionAtMs) / 1000, MAX_CLOCK_EXTRAPOLATION_SECONDS)));
        for (let i = pending.length - 1; i >= 0; i--) if (state.elapsed - pending[i].queuedAt > MAX_QUEUED_AGE_SECONDS) { pending.splice(i, 1); continuityCounts.discardedStale++; }
        // Idle time cannot accumulate a debt that dumps a returning batch onto one exit frame.
        spawnTimer = Math.max(-dt, spawnTimer - dt);
        while (pending.length && travelers.length < 54 && spawnTimer <= 0) {
          const entry = pending.shift()!;
          const request = entry.request;
          // Recheck on actual admission, including time spent waiting in the bounded visual queue.
          // The server deadline and measured outcome are unchanged; late samples remain in seen.
          if (entry.source === 'incoming' && request.decisionAt - missionTime < MIN_VISUAL_APPROACH_SECONDS) {
            omitLate(request, 'late-admission');
            continue;
          }
          const kind = request.threatType ?? 'bad-login';
          const template = request.role === 'legitimate' ? templates.customer : kind === 'breach' ? templates.breach : kind === 'swarm' ? templates.swarm : templates.badLogin;
          const object = template.clone();
          object.visible = false;
          scene.add(object);
          const duration = request.role === 'hostile' && kind === 'breach' ? 3.25 : 2.1;
          const approachPath = request.route === 'accounts' && compactLayout.matches
            ? feederApproach(routes[1].curve, GATE_PROGRESS, camera, width, height) : null;
          const traveler: Traveler = { ...entry, approachPath, object, age: 0, duration: duration + (request.id.charCodeAt(request.id.length - 1) % 6) * .07, reacted: false, phase: 'approach', phaseAge: 0, progress: 0, visualApproachStartedAt: missionTime, hasRendered: false };
          travelers.push(traveler);
          activeById.set(request.id, traveler);
          continuityCounts.spawned++;
          spawnTimer += .075;
        }
      }
      for (let i = travelers.length - 1; i >= 0; i--) {
        const traveler = travelers[i];
        const firstAppearance = !traveler.hasRendered;
        if (!firstAppearance) traveler.age += simulationDt;
        const index = IDS.indexOf(traveler.request.route), route = routes[index], district = districts[index];
        const kind = traveler.request.threatType ?? 'bad-login';
        const carrier = traveler.request.role === 'hostile' && kind === 'breach';
        if (!paused && !firstAppearance) {
          if (traveler.phase === 'approach') {
            const approach = traveler.source === 'incoming'
              ? (missionTime - traveler.visualApproachStartedAt) / Math.max(MIN_VISUAL_APPROACH_SECONDS, traveler.request.decisionAt - traveler.visualApproachStartedAt)
              : traveler.age / traveler.duration;
            traveler.progress = Math.max(traveler.progress, THREE.MathUtils.clamp(approach, 0, 1) * GATE_PROGRESS);
            if (traveler.progress >= GATE_PROGRESS) traveler.phase = 'waiting';
          }
          // A scheduled request cannot cross the gate until its own real HTTP result is available.
          if (traveler.phase === 'waiting' && traveler.record) {
            traveler.phase = traveler.record.status < 400 ? 'accepted' : 'rejected';
            traveler.phaseAge = 0;
          }
          if (traveler.phase === 'accepted') {
            traveler.phaseAge += simulationDt;
            traveler.progress = GATE_PROGRESS + (1 - GATE_PROGRESS) * Math.min(1, traveler.phaseAge / (carrier ? 1 : .72));
            if (traveler.progress >= 1) { traveler.phase = 'arrival'; traveler.phaseAge = 0; }
          } else if (traveler.phase === 'arrival' || traveler.phase === 'rejected') traveler.phaseAge += simulationDt;
        }
        traveler.object.visible = true;
        const onFeeder = traveler.approachPath && traveler.progress <= GATE_PROGRESS;
        const visualPath = onFeeder ? traveler.approachPath! : route.curve;
        const visualProgress = onFeeder ? traveler.progress / GATE_PROGRESS : traveler.progress;
        traveler.object.position.copy(visualPath.getPoint(visualProgress));
        traveler.object.position.y += carrier ? .32 : .25;
        const heading = visualPath.getTangent(visualProgress);
        traveler.object.rotation.y = Math.atan2(heading.x, heading.z);
        if (!reducedMotion && !firstAppearance) {
          traveler.object.position.y += Math.sin(traveler.age * (carrier ? 1.25 : 4)) * (carrier ? .013 : .022);
          if (traveler.request.role === 'hostile' && kind === 'swarm') traveler.object.rotation.y += traveler.age * 1.9;
        }
        if (firstAppearance) {
          const rawCurveOrigin = (traveler.approachPath ?? route.curve).getPoint(0);
          const sourcePosition = rawCurveOrigin.clone().add(new THREE.Vector3(0, carrier ? .32 : .25, 0));
          recentBirths.push({ id: traveler.request.id, uuid: traveler.object.uuid, route: traveler.request.route, role: traveler.request.role, threatType: traveler.request.threatType, source: traveler.source, firstProgress: traveler.progress, sourcePosition: sourcePosition.toArray(), firstPosition: traveler.object.position.toArray(), rawCurveOrigin: rawCurveOrigin.toArray(), screenPosition: traveler.object.position.clone().project(camera).toArray(), visualBornAt: traveler.visualApproachStartedAt, decisionAt: traveler.request.decisionAt });
          if (recentBirths.length > 64) recentBirths.shift();
          traveler.hasRendered = true;
        }
        if (!paused && (traveler.phase === 'arrival' || traveler.phase === 'rejected') && !traveler.reacted) {
          traveler.reacted = true;
          if (traveler.phase === 'rejected') {
            route.flash = 1;
            burst(traveler.object.position, '#8bedf1', 7, .8);
          } else if (traveler.record?.status === 200 && traveler.record.damage > 0) {
            district.damage = 1;
            district.hitAge = 0;
            district.hitRecord = traveler.record;
            district.damageColor.set(THREAT_COLORS[kind]);
            recentHits.push({ route: traveler.record.route, recordId: traveler.record.id, actualStatus: traveler.record.status, damage: traveler.record.damage, missionTime });
            if (recentHits.length > 32) recentHits.shift();
            burst(district.entrance, THREAT_COLORS[kind], 5, .7);
          } else burst(district.entrance, '#b0f2ea', 3, .5);
        }
        if (traveler.phase === 'arrival' || traveler.phase === 'rejected') {
          const arrival = Math.min(traveler.phaseAge / .48, 1);
          if (traveler.phase === 'arrival') {
            traveler.object.position.lerp(district.entrance, arrival);
            if (!reducedMotion) traveler.object.position.y += Math.sin(arrival * Math.PI) * .38;
            traveler.object.scale.setScalar(Math.max(.01, 1 - arrival * .9));
          } else {
            const tangent = route.curve.getTangent(GATE_PROGRESS);
            traveler.object.position.addScaledVector(tangent, -arrival * .48);
            traveler.object.scale.setScalar(Math.max(.01, 1 - arrival));
          }
          if (arrival >= 1) { removeTraveler(traveler, 'completed'); travelers.splice(i, 1); }
        }
      }
      for (let i = 0; i < districts.length; i++) {
        const district = districts[i], route = routes[i], warning = warnings[i];
        warning.group.visible = warning.active && !titleMode;
        if (warning.active) {
          warning.age += simulationDt;
          // Two 1.6-second soft pulses, followed by a steady colored edge. Never strobe.
          const pulse = !reducedMotion && warning.age < 3.2 ? Math.sin(Math.PI * (warning.age % 1.6) / 1.6) ** 2 : 0;
          warning.line.opacity = .58 + pulse * .35;
          warning.glow.opacity = .085 + pulse * .13;
        }
        const policy = state?.routes.find(r => r.id === district.id)?.policy;
        district.selection.visible = selected === district.id && !titleMode;
        district.damage = Math.max(0, district.damage - simulationDt * 1.8);
        district.hitAge = Math.min(2, district.hitAge + simulationDt);
        const joltProgress = Math.min(1, district.hitAge / LOCAL_JOLT_SECONDS);
        // Restarting a hit uses the same fixed base; repeated hits can never accumulate movement.
        const jolt = !reducedMotion && district.hitRecord ? (1 - joltProgress) * .032 : 0;
        district.hitGroup.position.set(Math.sin(joltProgress * TAU) * jolt, 0, Math.sin(joltProgress * Math.PI) * jolt * .45);
        district.hitGlow.color.copy(district.damageColor);
        // Fast repeated hits sustain this restrained glow instead of producing bright flashes.
        district.hitGlow.opacity = THREE.MathUtils.damp(district.hitGlow.opacity, district.damage * .66, 12, simulationDt);
        district.windows.color.copy(WINDOW_COLOR).lerp(district.damageColor, district.damage * .78);
        district.windows.emissiveIntensity = .32 + district.damage * .15;
        const gate = route.gate;
        if (gate.policyKey !== null && gate.convergedAtMs === null) {
          gate.frames++;
          const progress = reducedMotion ? 1 : Math.min(1, (now - gate.observedAtMs) / GATE_TRANSITION_MS);
          const eased = 1 - (1 - progress) ** 3;
          gate.actualShield = THREE.MathUtils.lerp(gate.fromShield, gate.desiredShield, eased);
          route.isolation = THREE.MathUtils.lerp(gate.fromIsolation, gate.desiredIsolation, eased);
          if (gate.visibleAtMs === null && Math.abs(gate.actualShield - gate.desiredShield) <= .2) gate.visibleAtMs = now;
          if (progress >= 1) {
            gate.actualShield = gate.desiredShield;
            route.isolation = gate.desiredIsolation;
            gate.convergedAtMs = now;
          }
        }
        route.retract.scale.set(1 - route.isolation * .94, 1, 1 - route.isolation * .94);
        route.flash = Math.max(0, route.flash - simulationDt * 2.1);
        route.shieldDisc.opacity = Math.min(.72, (policy?.isolated ? .48 : .25) * gate.actualShield + route.flash * .3);
        route.shieldRim.opacity = Math.min(1, .9 * gate.actualShield + route.flash);
        route.shield.scale.setScalar(1 + (reducedMotion ? 0 : route.flash * .1));
        if (!paused && !reducedMotion) {
          if (i === 1) district.crown.rotation.y = Math.sin(time * .35) * .22;
          if (i === 2) district.crown.rotation.y = Math.sin(time * .22) * .16;
        }
        const label = labelRefs.current[i];
        if (label) {
          projected.copy(district.label).project(camera);
          label.style.transform = `translate(-50%, -50%) translate(${((projected.x + 1) / 2 * width).toFixed(1)}px, ${((-projected.y + 1) / 2 * height).toFixed(1)}px)`;
          label.style.opacity = titleMode ? '0' : '1';
          label.style.pointerEvents = titleMode ? 'none' : 'auto';
        }
        const uplinkLabel = uplinkRefs.current[i];
        if (uplinkLabel) {
          projected.copy(route.uplinkLabel).project(camera);
          const inset = 8 + uplinkLabelWidths[i] / 2;
          const labelX = THREE.MathUtils.clamp((projected.x + 1) / 2 * width, inset, width - inset);
          uplinkLabel.style.transform = `translate(-50%, -50%) translate(${labelX.toFixed(1)}px, ${((-projected.y + 1) / 2 * height).toFixed(1)}px)`;
          uplinkLabel.style.opacity = titleMode ? '0' : '1';
        }
      }
      if (celebration > 0 && !paused && !reducedMotion) {
        const previousBurst = Math.floor(celebration * 8);
        celebration = Math.max(0, celebration - dt);
        const burstIndex = Math.max(0, Math.floor(celebration * 8));
        if (burstIndex !== previousBurst) {
          const district = districts[burstIndex % districts.length];
          burst(district.center.clone().add(new THREE.Vector3(0, 4, 0)), burstIndex % 2 ? '#f0cf88' : '#8ee6e5', 7, 1.5);
        }
      }
      if (reducedMotion) particles.length = 0;
      for (let i = particles.length - 1; i >= 0; i--) {
        const particle = particles[i];
        particle.age += simulationDt;
        particle.velocity.y -= simulationDt * 2;
        particle.position.addScaledVector(particle.velocity, simulationDt);
        if (particle.age >= particle.life) particles.splice(i, 1);
      }
      particles.forEach((particle, i) => {
        particle.position.toArray(particlePositions, i * 3);
        particle.color.toArray(particleColors, i * 3);
      });
      particleGeometry.attributes.position.needsUpdate = true;
      particleGeometry.attributes.color.needsUpdate = true;
      particleGeometry.setDrawRange(0, particles.length);

      clouds.position.y = reducedMotion ? 0 : Math.sin(time * .22) * .055;
      renderer.render(scene, camera);
      // Read-only, per-render diagnostics let tests measure confirmed-state-to-visible latency.
      performanceData.gateEngagement = routes.map(route => {
        const gate = route.gate;
        return {
          route: route.id, mode: gate.mode, policyKey: gate.policyKey, revision: gate.revision,
          desiredShieldLevel: gate.desiredShield, actualShieldLevel: Math.round(gate.actualShield * 1000) / 1000,
          desiredIsolationLevel: gate.desiredIsolation, actualIsolationLevel: Math.round(route.isolation * 1000) / 1000,
          actualDiscOpacity: Math.round(route.shieldDisc.opacity * 1000) / 1000,
          actualRimOpacity: Math.round(route.shieldRim.opacity * 1000) / 1000,
          confirmedStateObservedAtMs: Math.round(gate.observedAtMs * 10) / 10,
          visibleAtMs: gate.visibleAtMs === null ? null : Math.round(gate.visibleAtMs * 10) / 10,
          visibleAfterMs: gate.visibleAtMs === null ? null : Math.round((gate.visibleAtMs - gate.observedAtMs) * 10) / 10,
          convergedAtMs: gate.convergedAtMs === null ? null : Math.round(gate.convergedAtMs * 10) / 10,
          convergedAfterMs: gate.convergedAtMs === null ? null : Math.round((gate.convergedAtMs - gate.observedAtMs) * 10) / 10,
          transitionFrames: gate.frames, targetTransitionMs: GATE_TRANSITION_MS,
        };
      });
      performanceData.visualSampling = { discardedStale: continuityCounts.discardedStale, discardedCapacity: continuityCounts.discardedCapacity, maximumQueuedMissionAgeSeconds: MAX_QUEUED_AGE_SECONDS };
      performanceData.trafficContinuity = {
        missionTime, phase: state?.phase ?? 'ready',
        active: travelers.map(traveler => ({
          id: traveler.request.id, uuid: traveler.object.uuid, route: traveler.request.route,
          role: traveler.request.role, threatType: traveler.request.threatType,
          source: traveler.source, phase: traveler.phase, progress: traveler.progress,
          position: traveler.object.position.toArray(), screenPosition: traveler.object.position.clone().project(camera).toArray(), extendedApproach: !!traveler.approachPath, measuredStatus: traveler.record?.status ?? null,
          approachStartedAt: traveler.request.approachStartedAt, visualApproachStartedAt: traveler.visualApproachStartedAt, decisionAt: traveler.request.decisionAt,
        })),
        pending: pending.map(item => ({ id: item.request.id, route: item.request.route, queuedAt: item.queuedAt, decisionAt: item.request.decisionAt })),
        minimumVisualApproachSeconds: MIN_VISUAL_APPROACH_SECONDS,
        counts: { ...continuityCounts },
        recentBirths: recentBirths.map(birth => ({ ...birth, sourcePosition: [...birth.sourcePosition], firstPosition: [...birth.firstPosition], rawCurveOrigin: [...birth.rawCurveOrigin] })),
        lateOmissions: lateOmissions.map(omission => ({ ...omission })),
        recentRemovals: recentRemovals.map(removal => ({ ...removal })),
        recentPolicyChanges: recentPolicyChanges.map(change => ({ ...change, actorIds: [...change.actorIds] })),
      };
      cameraDamageOffset.copy(camera.position).sub(ambientCameraPosition);
      performanceData.localDamageFeedback = {
        cameraPosition: camera.position.toArray(), ambientCameraPosition: ambientCameraPosition.toArray(),
        cameraDamageOffset: cameraDamageOffset.toArray(), cameraDamageImpulse: cameraDamageOffset.length(),
        districts: districts.map(district => ({
          route: district.id, recordId: district.hitRecord?.id ?? null, actualStatus: district.hitRecord?.status ?? null,
          damage: district.hitRecord?.damage ?? 0, offset: district.hitGroup.position.toArray(), intensity: district.damage, age: district.hitAge,
        })),
        recentHits: recentHits.map(hit => ({ ...hit })),
      };
      measuredFrames++;
      measuredTime += rawDt;
      perfTime += rawDt;
      if (perfTime >= 2) {
        Object.assign(performanceData, {
          averageFps: Math.round(measuredFrames / measuredTime * 10) / 10,
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          renderer: rendererName,
          pixelRatio: renderer.getPixelRatio(),
          viewport: `${width}×${height}`,
          activeRequestAnimations: travelers.length,
          queuedRequestAnimations: pending.length,
          activeThreatWarnings: warnings.flatMap((warning, i) => warning.active ? [{ route: IDS[i], threatType: warning.threatType, age: Math.round(warning.age * 10) / 10, appearance: reducedMotion || warning.age >= 3.2 ? 'steady' : 'two-soft-pulses' }] : []),
          animationCap: 54,
          particleCap: 96,
        });
        perfTime = 0;
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerup', click);
      renderer.domElement.removeEventListener('pointermove', move);
      renderer.domElement.removeEventListener('wheel', wheel);
      const geometries = new Set<THREE.BufferGeometry>();
      const mats = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      for (const root of [scene, ...Object.values(templates)]) root.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            mats.add(material);
            for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
          }
        }
      });
      Object.values(materials).forEach(m => mats.add(m));
      geometries.forEach(g => g.dispose());
      textures.forEach(t => t.dispose());
      mats.forEach(m => m.dispose());
      light.shadow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={hostRef} className="city-scene" style={{ background: 'linear-gradient(180deg, #11293918 0%, #1226340a 48%, #09182055 100%), url(/art/industrial-dusk-city.png) center center / cover no-repeat, #253b48' }}>
    <div aria-label="City districts" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {IDS.map((id, i) => <button key={id} ref={element => { labelRefs.current[i] = element; }} onClick={() => props.onSelect(id)} aria-pressed={props.selected === id} aria-label={`Select ${NAMES[i].toLowerCase()}`} tabIndex={props.titleMode ? -1 : 0} style={{ position: 'absolute', top: 0, left: 0, opacity: 0, border: props.selected === id ? '1px solid #51d9e9' : '1px solid #617079', borderRadius: 5, padding: '7px 10px', background: props.selected === id ? '#123441f5' : '#13232def', color: props.selected === id ? '#d9f8fa' : '#b8cdd4', fontFamily: 'inherit', fontSize: 10, letterSpacing: '1.25px', fontWeight: 750, whiteSpace: 'nowrap', boxShadow: '0 4px 16px #02090e66', cursor: 'pointer' }}><span style={{ color: props.selected === id ? '#61eaff' : '#7797a4', marginRight: 7, fontWeight: 500 }}>{String(i + 1).padStart(2, '0')}</span>{NAMES[i]}</button>)}
      {IDS.map((id, i) => <span key={`uplink-${id}`} ref={element => { uplinkRefs.current[i] = element; }} className="uplink-label" data-route={id} aria-label={`Internet uplink for ${NAMES[i].toLowerCase()}`} style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}>INTERNET UPLINK</span>)}
    </div>
  </div>;
}
