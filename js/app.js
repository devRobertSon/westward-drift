// ============================================================================
//  인공위성 서편현상 3D 뷰어  (Satellite Westward-Drift / Ground-Track Viewer)
//
//  물리 모델
//  --------
//  · 궤도면은 관성계(우주)에 대해 거의 고정되어 있고, 지구가 그 안에서
//    서→동으로 자전한다.
//  · 위성이 궤도를 한 바퀴 도는 동안 지구가 동쪽으로 돌아버리므로,
//    다음 궤도의 지상 궤적이 앞 궤도보다 서쪽으로 밀려난다(서편현상).
//  · 1궤도당 서편 이동량 = 360° × (궤도주기 T ÷ 항성일 86164초)
//  · 좌표계: 장면(scene) = 관성계(ECI). Y축 = 지구 자전축(북극),
//    적도면 = XZ평면. (동, 북, 상)이 오른손계가 되도록 동쪽(경도 +) = -Z 방향.
//    → 지구는 +Y(북극) 둘레로 반시계(서→동)로 자전한다.
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

// ---------- 물리 상수 ----------
const R_EARTH = 6371;               // km
const MU = 398600.4418;             // km^3/s^2  (지구 표준중력상수)
const SIDEREAL_DAY = 86164;         // s  (항성일 = 지구 1회전)
const OMEGA_E = (2 * Math.PI) / SIDEREAL_DAY; // rad/s  지구 자전 각속도
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

// ---------- 시뮬레이션 상태 ----------
const state = {
  altKm: 420, incDeg: 51.6, speed: 500,
  playing: true, showTrack: true, showOrbit: true, showGrid: true, spin: true,
  simTime: 0,
  // 파생값 (computeOrbit에서 갱신)
  aScaled: 1, T: 0, n: 0, shiftDeg: 0,
  recordInterval: 0, lastRecord: -1e9, revCount: 0,
};

// 지상궤적 점 저장
const track = [];          // { lon, lat }  (Earth-fixed, deg)
const TRACK_MAX = 4000;

// ============================================================================
//  Three.js 장면
// ============================================================================
const view3d = document.getElementById('view3d');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view3d.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b16);

const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 4000);
camera.position.set(2.6, 1.7, 3.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.35;
controls.maxDistance = 600;

// ---------- 조명 ----------
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.set(5, 2.2, 3);
scene.add(sun);

// ---------- 별 배경 (결정적 배치) ----------
(function addStars() {
  const N = 1600, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const phi = Math.acos(1 - 2 * ((i + 0.5) / N));
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const r = 200;
    pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi);
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fa4c8, size: 1.4, sizeAttenuation: false })));
})();

// ---------- 지구 (자전 그룹) ----------
const earthGroup = new THREE.Group();
scene.add(earthGroup);

const earthMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 64, 48),
  new THREE.MeshPhongMaterial({ color: 0x16406e, emissive: 0x061426, shininess: 18, specular: 0x224466 })
);
earthGroup.add(earthMesh);

const graticule = buildGraticule();
const primeMeridian = buildMeridian(0, 0xffd24d);   // 본초자오선 0°
const equator = buildParallel(0, 0xff9a3c);          // 적도
earthGroup.add(graticule, primeMeridian, equator);

// 극(N/S) 라벨 + 자전축
scene.add(makeTextSprite('N', 0xbfe0ff, new THREE.Vector3(0, 1.28, 0)));
scene.add(makeTextSprite('S', 0xbfe0ff, new THREE.Vector3(0, -1.28, 0)));
{
  const g = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -1.22, 0), new THREE.Vector3(0, 1.22, 0),
  ]);
  scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x3a4a6a })));
}

// ---------- 지상궤적 (지구에 붙어 함께 회전) ----------
const trackPositions = new Float32Array(TRACK_MAX * 3);
const trackGeom = new THREE.BufferGeometry();
trackGeom.setAttribute('position', new THREE.BufferAttribute(trackPositions, 3));
trackGeom.setDrawRange(0, 0);
const trackLine = new THREE.Line(trackGeom, new THREE.LineBasicMaterial({ color: 0xff4d6d }));
trackLine.frustumCulled = false;
earthGroup.add(trackLine);

// 현재 서브위성점 마커 (지구 표면)
const subPoint = new THREE.Mesh(
  new THREE.SphereGeometry(0.03, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff4d6d })
);
earthGroup.add(subPoint);

// ---------- 궤도면 & 위성 (관성계, 회전하지 않음) ----------
let orbitLine = null;
const satellite = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffffff })
);
scene.add(satellite);
const satLabel = makeTextSprite('🛰', 0xffffff, new THREE.Vector3());
scene.add(satLabel);

// 지구중심 → 위성 반경선
const radiusGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const radiusLine = new THREE.Line(radiusGeom, new THREE.LineBasicMaterial({ color: 0x35507f }));
scene.add(radiusLine);

// ============================================================================
//  기하 헬퍼
// ============================================================================
// Earth-fixed 경도(λ)·위도(φ) → 단위벡터 (동쪽 = -Z, 오른손계)
function llToVec(lonDeg, latDeg, r = 1) {
  const la = lonDeg * RAD, ph = latDeg * RAD;
  return new THREE.Vector3(
    r * Math.cos(ph) * Math.cos(la),
    r * Math.sin(ph),
    -r * Math.cos(ph) * Math.sin(la),
  );
}

function buildParallel(latDeg, color, r = 1.003) {
  const pts = [];
  for (let lon = 0; lon <= 360; lon += 3) pts.push(llToVec(lon, latDeg, r));
  return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color }));
}

function buildMeridian(lonDeg, color, r = 1.003) {
  const pts = [];
  for (let lat = -90; lat <= 90; lat += 3) pts.push(llToVec(lonDeg, lat, r));
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color }));
}

function buildGraticule() {
  const g = new THREE.Group();
  for (let lat = -60; lat <= 60; lat += 30) if (lat !== 0) g.add(buildParallel(lat, 0x2c67a6));
  for (let lon = 0; lon < 360; lon += 30) if (lon !== 0) g.add(buildMeridian(lon, 0x264a72));
  return g;
}

function makeTextSprite(text, color, position) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  ctx.font = 'bold 84px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(0.16, 0.16, 0.16);
  sp.position.copy(position);
  return sp;
}

// ============================================================================
//  궤도 계산 — 고도·경사각 변경 시 호출
// ============================================================================
function computeOrbit() {
  const a = R_EARTH + state.altKm;                 // km
  state.aScaled = a / R_EARTH;                      // 지구반경 단위
  state.T = 2 * Math.PI * Math.sqrt((a * a * a) / MU);   // s
  state.n = (2 * Math.PI) / state.T;                // rad/s
  state.shiftDeg = 360 * (state.T / SIDEREAL_DAY);  // 서편 이동/궤도
  state.recordInterval = state.T / 220;             // 궤도당 약 220점 기록

  // 위성 크기: 시야에 맞게
  const s = Math.max(0.028, state.aScaled * 0.022);
  satellite.scale.setScalar(s);
  satLabel.scale.setScalar(Math.max(0.14, state.aScaled * 0.11));

  rebuildOrbitLine();
  clearTrack();
  updateReadout();
}

function rebuildOrbitLine() {
  if (orbitLine) { scene.remove(orbitLine); orbitLine.geometry.dispose(); }
  const i = state.incDeg * RAD, a = state.aScaled, pts = [];
  for (let u = 0; u <= 360; u += 2) {
    const ur = u * RAD;
    pts.push(new THREE.Vector3(
      a * Math.cos(ur),
      a * Math.sin(ur) * Math.sin(i),
      -a * Math.sin(ur) * Math.cos(i),   // 동쪽 = -Z (prograde, 순행)
    ));
  }
  orbitLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x5aa0ff, transparent: true, opacity: 0.85 }));
  orbitLine.visible = state.showOrbit;
  scene.add(orbitLine);
}

// ============================================================================
//  지상궤적 관리
// ============================================================================
function clearTrack() {
  track.length = 0;
  state.lastRecord = -1e9;
  trackGeom.setDrawRange(0, 0);
  redraw2D();
}

function recordTrackPoint(lonDeg, latDeg) {
  track.push({ lon: lonDeg, lat: latDeg });
  if (track.length > TRACK_MAX) track.shift();

  // 3D 라인 재구성 (경도 wrap 시 원점으로 튀지 않도록 큰 점프는 건너뜀)
  let k = 0;
  for (let idx = 0; idx < track.length; idx++) {
    const p = track[idx];
    const v = llToVec(p.lon, p.lat, 1.01);
    trackPositions[k++] = v.x; trackPositions[k++] = v.y; trackPositions[k++] = v.z;
  }
  trackGeom.attributes.position.needsUpdate = true;
  trackGeom.setDrawRange(0, track.length);
  trackGeom.computeBoundingSphere();
}

// ============================================================================
//  위성 위치 갱신 (매 프레임)
// ============================================================================
function updateSatellite() {
  const i = state.incDeg * RAD, a = state.aScaled;
  const u = state.n * state.simTime;                 // 위도인수(argument of latitude)
  const thetaE = state.spin ? OMEGA_E * state.simTime : 0;  // 지구 자전각

  // 관성계 위성 좌표 (동쪽 = -Z 이므로 z에 음부호 → 순행 궤도)
  const x = a * Math.cos(u);
  const y = a * Math.sin(u) * Math.sin(i);
  const z = -a * Math.sin(u) * Math.cos(i);
  satellite.position.set(x, y, z);
  satLabel.position.set(x, y + 0.12 * a, z);

  // 반경선
  radiusGeom.attributes.position.setXYZ(1, x, y, z);
  radiusGeom.attributes.position.needsUpdate = true;

  // 서브위성점 (관성 경도 φ_i, 위도 ψ). 동쪽=-Z 이므로 경도 = atan2(-z, x)
  const phiI = Math.atan2(-z, x);                    // 적도면 투영 방위각(동쪽 +)
  const lat = Math.asin(Math.max(-1, Math.min(1, y / a))) * DEG;
  let lonEF = (phiI - thetaE) * DEG;                 // Earth-fixed 경도
  lonEF = ((lonEF + 180) % 360 + 360) % 360 - 180;   // [-180,180]

  // 서브위성 마커 위치 (Earth-fixed 프레임, earthGroup의 자식)
  subPoint.position.copy(llToVec(lonEF, lat, 1.015));

  // 지상궤적 기록
  if (state.showTrack && state.playing &&
      state.simTime - state.lastRecord >= state.recordInterval) {
    state.lastRecord = state.simTime;
    recordTrackPoint(lonEF, lat);
    draw2Dincremental();
  }

  // readout
  document.getElementById('roLat').textContent = fmtLat(lat);
  document.getElementById('roLon').textContent = fmtLon(lonEF);
  state.revCount = state.simTime / state.T;
  document.getElementById('roTime').textContent =
    `${fmtDuration(state.simTime)} · ${state.revCount.toFixed(2)}바퀴`;
}

// ============================================================================
//  2D 지상궤적 지도
// ============================================================================
const map = document.getElementById('map2d');
const mctx = map.getContext('2d');
let mapW = 0, mapH = 0;

function resizeMap() {
  const rect = map.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio, 2);
  map.width = Math.round(rect.width * dpr);
  map.height = Math.round(rect.height * dpr);
  mapW = map.width; mapH = map.height;
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw2D();
}

const lon2x = (lon, w) => (lon + 180) / 360 * w;
const lat2y = (lat, h) => (90 - lat) / 180 * h;

function drawMapGrid(w, h) {
  mctx.clearRect(0, 0, w, h);
  mctx.fillStyle = '#0a1220';
  mctx.fillRect(0, 0, w, h);
  mctx.lineWidth = 1;
  mctx.strokeStyle = '#1c2c48';
  mctx.fillStyle = '#5b6f92';
  mctx.font = '10px sans-serif';
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = lon2x(lon, w);
    mctx.beginPath(); mctx.moveTo(x, 0); mctx.lineTo(x, h); mctx.stroke();
    if (lon % 60 === 0) mctx.fillText((lon > 0 ? '+' : '') + lon + '°', x + 2, h - 3);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = lat2y(lat, h);
    mctx.beginPath(); mctx.moveTo(0, y); mctx.lineTo(w, y); mctx.stroke();
  }
  // 적도 / 본초자오선 강조
  mctx.strokeStyle = '#ff9a3c'; mctx.beginPath();
  mctx.moveTo(0, lat2y(0, h)); mctx.lineTo(w, lat2y(0, h)); mctx.stroke();
  mctx.strokeStyle = '#ffd24d'; mctx.beginPath();
  mctx.moveTo(lon2x(0, w), 0); mctx.lineTo(lon2x(0, w), h); mctx.stroke();
}

function drawTrackPath(w, h) {
  if (track.length < 2) return;
  mctx.strokeStyle = '#ff4d6d';
  mctx.lineWidth = 1.6;
  mctx.lineJoin = 'round';
  mctx.beginPath();
  let started = false;
  for (let i = 0; i < track.length; i++) {
    const p = track[i];
    const x = lon2x(p.lon, w), y = lat2y(p.lat, h);
    if (!started) { mctx.moveTo(x, y); started = true; continue; }
    // 경도 wrap(±180 경계) 이면 선을 끊음
    if (Math.abs(p.lon - track[i - 1].lon) > 180) { mctx.stroke(); mctx.beginPath(); mctx.moveTo(x, y); }
    else mctx.lineTo(x, y);
  }
  mctx.stroke();
}

function drawCurrentDot(w, h) {
  if (!track.length) return;
  const p = track[track.length - 1];
  const x = lon2x(p.lon, w), y = lat2y(p.lat, h);
  mctx.fillStyle = '#ffffff';
  mctx.strokeStyle = '#ff4d6d';
  mctx.lineWidth = 2;
  mctx.beginPath(); mctx.arc(x, y, 3.5, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
}

function cssSize() {
  const rect = map.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}
function redraw2D() {
  const { w, h } = cssSize();
  drawMapGrid(w, h); drawTrackPath(w, h); drawCurrentDot(w, h);
}
// 매 프레임 전체 재도색이 부담될 정도는 아니므로 동일 함수 사용
function draw2Dincremental() { redraw2D(); }

// ============================================================================
//  Readout / 포맷
// ============================================================================
function fmtLat(v) { return `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'N' : 'S'}`; }
function fmtLon(v) { return `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'E' : 'W'}`; }
function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분 ${Math.floor(s % 60)}초`;
}
function updateReadout() {
  document.getElementById('roPeriod').textContent = `${(state.T / 60).toFixed(1)} 분`;
  document.getElementById('roRevs').textContent = `${(SIDEREAL_DAY / state.T).toFixed(2)} 회`;
  const sh = state.shiftDeg;
  document.getElementById('roShift').textContent =
    sh >= 359.9 ? '≈ 0° (정지궤도)' : `${sh.toFixed(1)}° 서쪽`;
}

// ============================================================================
//  애니메이션 루프
// ============================================================================
let last = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dtReal = Math.min((now - last) / 1000, 0.05); // s (탭 비활성 대비 상한)
  last = now;

  if (state.playing) state.simTime += dtReal * state.speed;

  // 지구는 +Y(북극) 둘레로 서→동(동쪽=-Z)으로 자전한다.
  // 오른손계 지리좌표(동=-Z)에서 rotation.y = +thetaE 이면
  //  ① 자전축 각속도가 +Y(북극) 방향 → 실제와 같은 서→동 자전
  //  ② earthGroup 자식인 지상궤적/마커가 위성 바로 아래에 정확히 위치
  //     (R_y(+thetaE)·(경도 phiI-thetaE) = 위성 경도 phiI)
  const thetaE = state.spin ? OMEGA_E * state.simTime : 0;
  earthGroup.rotation.y = thetaE;

  updateSatellite();
  controls.update();
  renderer.render(scene, camera);
}

// ============================================================================
//  리사이즈
// ============================================================================
function resize() {
  const w = view3d.clientWidth, h = view3d.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h || 1;
  camera.updateProjectionMatrix();
  resizeMap();
}
window.addEventListener('resize', resize);

function fitView() {
  const d = state.aScaled * 2.6 + 0.5;
  camera.position.set(d * 0.62, d * 0.42, d * 0.82);
  controls.target.set(0, 0, 0);
  controls.update();
}

// ============================================================================
//  UI 바인딩
// ============================================================================
const $ = (id) => document.getElementById(id);

$('btnPlay').addEventListener('click', () => {
  state.playing = !state.playing;
  $('btnPlay').textContent = state.playing ? '⏸ 일시정지' : '▶ 재생';
  $('btnPlay').classList.toggle('primary', state.playing);
});
$('btnReset').addEventListener('click', () => {
  state.simTime = 0; state.revCount = 0; clearTrack();
});
$('btnFit').addEventListener('click', fitView);

$('rngSpeed').addEventListener('input', (e) => {
  state.speed = +e.target.value;
  $('valSpeed').textContent = state.speed + '×';
});
$('rngAlt').addEventListener('input', (e) => {
  state.altKm = +e.target.value;
  $('valAlt').textContent = state.altKm.toLocaleString() + ' km';
  computeOrbit();
});
$('rngInc').addEventListener('input', (e) => {
  state.incDeg = +e.target.value;
  $('valInc').textContent = state.incDeg.toFixed(1) + '°';
  computeOrbit();
});

$('chkTrack').addEventListener('change', (e) => {
  state.showTrack = e.target.checked;
  trackLine.visible = state.showTrack;
  subPoint.visible = state.showTrack;
  if (!state.showTrack) clearTrack();
});
$('chkOrbit').addEventListener('change', (e) => {
  state.showOrbit = e.target.checked;
  if (orbitLine) orbitLine.visible = state.showOrbit;
  radiusLine.visible = state.showOrbit;
});
$('chkGrid').addEventListener('change', (e) => {
  state.showGrid = e.target.checked;
  graticule.visible = state.showGrid;
  primeMeridian.visible = state.showGrid;
  equator.visible = state.showGrid;
});
$('chkSpin').addEventListener('change', (e) => {
  state.spin = e.target.checked;
  clearTrack();
});

document.querySelectorAll('.preset').forEach((b) => {
  b.addEventListener('click', () => {
    const alt = +b.dataset.alt, inc = +b.dataset.inc;
    state.altKm = alt; state.incDeg = inc;
    $('rngAlt').value = alt; $('valAlt').textContent = alt.toLocaleString() + ' km';
    $('rngInc').value = inc; $('valInc').textContent = inc.toFixed(1) + '°';
    state.simTime = 0;
    computeOrbit();
    fitView();
  });
});

// ============================================================================
//  시작
// ============================================================================
resize();
computeOrbit();
fitView();
requestAnimationFrame(animate);
