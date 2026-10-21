import * as THREE from '../vendor/three.module.js';
import { ZONE_COLORS } from './town.js?v=23';

// A modest vertical exaggeration makes 6 km-wide terrain read better from the
// default camera distance without changing the underlying generator.
const VERTICAL_SCALE = 1.45;
const BUILDING_HEIGHT_SCALE = 1.6;

const TYPE_COLORS = {
  commercial: [214, 166, 92],
  apartment: [198, 139, 112],
  house: [214, 190, 156],
  warehouse: [150, 160, 158],
  barn: [166, 104, 74],
  station: [242, 246, 250],
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

const colorScratch = new THREE.Color();

function rgb(r, g, b) {
  // setRGB with an explicit color space keeps vertex/instance colors consistent
  // with the renderer's sRGB output.
  return colorScratch.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

function pseudo(x, y) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export function create3DView(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = 2;
  bgCanvas.height = 512;
  const bgCtx = bgCanvas.getContext('2d');
  const bgGradient = bgCtx.createLinearGradient(0, 0, 0, 512);
  bgGradient.addColorStop(0, '#071017');
  bgGradient.addColorStop(0.55, '#0d1b24');
  bgGradient.addColorStop(0.8, '#1b2b31');
  bgGradient.addColorStop(1, '#35413c');
  bgCtx.fillStyle = bgGradient;
  bgCtx.fillRect(0, 0, 2, 512);
  const bgTexture = new THREE.CanvasTexture(bgCanvas);
  bgTexture.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTexture;

  const camera = new THREE.PerspectiveCamera(45, 1, 5, 50000);
  const target = new THREE.Vector3();
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x2a2a1e, 1.85);
  const sun = new THREE.DirectionalLight(0xffe3b8, 2.45);
  const fill = new THREE.DirectionalLight(0x86b8ff, 0.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.6;
  scene.add(hemi, sun, fill, sun.target);

  let world = null;
  let townGroup = null;
  let field = null;
  let hydro = null;
  let town = null;
  let showTown = true;
  let active = false;
  let frame = 0;
  let needsRender = true;
  let yaw = 0.82;
  let pitch = 0.5;
  let radius = 6000;
  let focusTown = false;
  let heightMin = 0;
  let heightMax = 1;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function resize() {
    const w = Math.max(1, canvas.clientWidth || 512);
    const h = Math.max(1, canvas.clientHeight || 512);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }

  function resetCamera() {
    if (!field) return;

    let c;
    if (focusTown && town && town.buildings.length > 0) {
      let sx = 0;
      let sz = 0;
      for (const b of town.buildings) {
        sx += b.x;
        sz += b.z;
      }
      c = { x: sx / town.buildings.length, z: sz / town.buildings.length };
    } else if (focusTown && town) {
      c = town.center;
    } else {
      c = { x: field.x0 + field.size / 2, z: field.y0 + field.size / 2 };
    }

    const ch = heightAt(c.x, c.z);
    target.set(
      c.x,
      (ch == null ? 0 : ch) + (focusTown ? 35 : field.size * 0.015),
      c.z,
    );
    radius = field.size * (focusTown ? 0.24 : 1.3);
    yaw = 0.82;
    pitch = focusTown ? 0.34 : 0.5;
    needsRender = true;
  }

  function applyCamera() {
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    camera.position.set(
      target.x + radius * cp * Math.sin(yaw),
      target.y + radius * sp,
      target.z + radius * cp * Math.cos(yaw),
    );
    camera.lookAt(target);
  }

  function renderFrame() {
    applyCamera();
    renderer.render(scene, camera);
  }

  function loop() {
    if (!active) {
      frame = 0;
      return;
    }
    frame = requestAnimationFrame(loop);
    if (!needsRender) return;
    needsRender = false;
    renderFrame();
  }

  function setActive(value) {
    active = value;
    if (value) {
      resize();
      needsRender = true;
      if (!frame) frame = requestAnimationFrame(loop);
    } else if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  function heightAt(x, z) {
    if (!field) return null;
    const { n, cell, x0, y0, height } = field;
    const gx = (x - x0) / cell;
    const gy = (z - y0) / cell;
    if (gx < 0 || gy < 0 || gx >= n - 1 || gy >= n - 1) return null;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const i = iy * n + ix;
    return (height[i] * (1 - fx) * (1 - fy)
      + height[i + 1] * fx * (1 - fy)
      + height[i + n] * (1 - fx) * fy
      + height[i + n + 1] * fx * fy) * VERTICAL_SCALE;
  }

  function terrainColor(gx, gy, i) {
    const { n, cell, height } = field;
    const h = height[i];

    if (h <= 0 || hydro.seaMask[i]) {
      const t = clamp(-h / 70, 0, 1);
      return rgb(mix(56, 16, t), mix(132, 54, t), mix(154, 84, t));
    }

    const xl = gx > 0 ? i - 1 : i;
    const xr = gx < n - 1 ? i + 1 : i;
    const yu = gy > 0 ? i - n : i;
    const yd = gy < n - 1 ? i + n : i;
    const dx = (height[xr] - height[xl]) / (2 * cell);
    const dz = (height[yd] - height[yu]) / (2 * cell);
    const slope = Math.hypot(dx, dz);

    const span = Math.max(1, heightMax - heightMin);
    const t = clamp((h - heightMin) / span, 0, 1);
    let r = mix(86, 126, t * 0.8);
    let g = mix(120, 132, t * 0.55);
    let b = mix(68, 94, t * 0.4);

    if (slope > 0.95) {
      r = 124; g = 112; b = 98;
    }

    // Snow and bare rock are relative to this terrain's own vertical range,
    // otherwise a high-elevation valley would be rendered entirely white.
    const snowLine = heightMax - span * 0.2;
    const rockLine = heightMax - span * 0.42;
    if (h > snowLine && slope < 0.95) {
      r = 224; g = 230; b = 228;
    } else if (h > rockLine) {
      r = mix(r, 158, 0.55);
      g = mix(g, 148, 0.5);
      b = mix(b, 130, 0.5);
    }

    // Soften the land/water color boundary; the mesh is sampled more coarsely
    // than the generator grid.
    if (h < 4) {
      const t = h / 4;
      r = mix(64, r, t);
      g = mix(150, g, t);
      b = mix(162, b, t);
    }

    if (hydro.riverMask[i]) {
      r = 62; g = 146; b = 160;
    } else if (hydro.dRiver[i] * cell < 260) {
      const t = 1 - hydro.dRiver[i] * cell / 260;
      r = mix(r, 72, 0.28 * t);
      g = mix(g, 136, 0.28 * t);
      b = mix(b, 82, 0.28 * t);
    } else {
      const shore = hydro.dSea[i] * cell;
      if (shore < 36) {
        const t = 1 - shore / 36;
        r = mix(r, 198, 0.52 * t);
        g = mix(g, 184, 0.48 * t);
        b = mix(b, 142, 0.34 * t);
      }
    }

    const zc = town && town.zones ? ZONE_COLORS[town.zones[i]] : null;
    if (zc) {
      r = mix(r, zc[0], 0.12);
      g = mix(g, zc[1], 0.12);
      b = mix(b, zc[2], 0.12);
    }

    const shade = 0.92 + pseudo(gx, gy) * 0.12;
    return rgb(r * shade, g * shade, b * shade);
  }

  function buildTerrain() {
    const { n, cell, x0, y0, height } = field;
    const step = Math.max(1, Math.ceil(n / 512));
    const cols = Math.floor((n - 1) / step) + 1;
    const rows = cols;
    const positions = new Float32Array(cols * rows * 3);
    const colors = new Float32Array(cols * rows * 3);
    const indices = [];

    let minH = Infinity;
    let maxH = -Infinity;
    heightMin = Infinity;
    heightMax = -Infinity;
    for (let i = 0; i < n * n; i++) {
      const raw = height[i];
      heightMin = Math.min(heightMin, raw);
      heightMax = Math.max(heightMax, raw);
      const hv = raw * VERTICAL_SCALE;
      minH = Math.min(minH, hv);
      maxH = Math.max(maxH, hv);
    }

    for (let j = 0; j < rows; j++) {
      const gy = Math.min(n - 1, j * step);
      for (let i = 0; i < cols; i++) {
        const gx = Math.min(n - 1, i * step);
        const k = j * cols + i;
        const idx = gy * n + gx;
        positions[k * 3] = x0 + gx * cell;
        positions[k * 3 + 1] = height[idx] * VERTICAL_SCALE;
        positions[k * 3 + 2] = y0 + gy * cell;

        const c = terrainColor(gx, gy, idx);
        colors[k * 3] = c.r;
        colors[k * 3 + 1] = c.g;
        colors[k * 3 + 2] = c.b;
      }
    }

    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    world.add(mesh);

    // Solid diorama base hides the open underside of the height field.
    const depth = Math.max(90, maxH - minH + 80);
    const baseGeo = new THREE.BoxGeometry(field.size, depth, field.size);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x1d1f1b, roughness: 1 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(
      x0 + field.size / 2,
      minH - depth / 2 - 1,
      y0 + field.size / 2,
    );
    world.add(base);

    return { minH, maxH };
  }

  function buildWater() {
    let hasWater = false;
    for (let i = 0; i < field.height.length; i++) {
      if (field.height[i] <= 0) {
        hasWater = true;
        break;
      }
    }
    if (!hasWater) return;

    const geo = new THREE.PlaneGeometry(field.size, field.size);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1c6078,
      transparent: true,
      opacity: 0.8,
      roughness: 0.52,
      metalness: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      field.x0 + field.size / 2,
      0.06,
      field.y0 + field.size / 2,
    );
    mesh.renderOrder = 2;
    world.add(mesh);
  }

  function buildRoads() {
    if (!town || !town.roads || town.roads.length === 0) return;

    const positions = [];
    const indices = [];
    let vertex = 0;

    for (const road of town.roads) {
      const pts = road.pts;
      if (pts.length < 2) continue;
      const start = vertex;

      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i];
        const [px, pz] = i === 0 ? pts[1] : pts[i - 1];
        const [nx, nz] = i === pts.length - 1 ? pts[i - 1] : pts[i + 1];
        let tx = nx - px;
        let tz = nz - pz;
        const len = Math.hypot(tx, tz) || 1;
        tx /= len;
        tz /= len;

        const ox = -tz;
        const oz = tx;
        const half = road.width / 2;
        const h = heightAt(x, z);
        const y = Math.max(h == null ? 0 : h, 0.2) + 0.35;

        positions.push(
          x + ox * half, y, z + oz * half,
          x - ox * half, y, z - oz * half,
        );
        vertex += 2;
      }

      for (let i = 0; i < pts.length - 1; i++) {
        const a = start + i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, c, b, b, c, d);
      }
    }

    if (positions.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x363c42,
      roughness: 0.9,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    mesh.receiveShadow = true;
    world.add(mesh);
  }

  function buildRailway() {
    const rail = town && town.railway;
    if (!rail || rail.pts.length < 2) return;

    const ribbon = (pts, width, lift) => {
      const positions = [];
      const indices = [];

      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i];
        const [px, pz] = i === 0 ? pts[1] : pts[i - 1];
        const [nx, nz] = i === pts.length - 1 ? pts[i - 1] : pts[i + 1];
        let tx = nx - px;
        let tz = nz - pz;
        const len = Math.hypot(tx, tz) || 1;
        tx /= len;
        tz /= len;

        const ox = -tz * width / 2;
        const oz = tx * width / 2;
        const h = heightAt(x, z);
        const y = Math.max(h == null ? 0 : h, 0.3) + lift;

        positions.push(x + ox, y, z + oz, x - ox, y, z - oz);
      }

      for (let i = 0; i < pts.length - 1; i++) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, c, b, b, c, d);
      }

      return { positions, indices };
    };

    const makeMesh = (data, mat, overlay = false) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
      geo.setIndex(data.indices);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = !overlay;
      mesh.castShadow = !overlay;
      mesh.renderOrder = overlay ? 20 : 3;
      if (overlay) {
        mat.depthTest = false;
        mat.transparent = true;
      }
      world.add(mesh);
    };

    const ballast = ribbon(rail.pts, 11, 0.45);
    makeMesh(ballast, new THREE.MeshStandardMaterial({
      color: 0x39352e,
      roughness: 0.96,
      metalness: 0,
    }));

    // A dark outline plus a pale spine keeps the line legible over both
    // green terrain and the amber roofs of the town.
    makeMesh(ribbon(rail.pts, 12, 0.60), new THREE.MeshBasicMaterial({
      color: 0x2a2118,
      opacity: 0.5,
    }), true);
    makeMesh(ribbon(rail.pts, 5, 0.63), new THREE.MeshBasicMaterial({
      color: 0xffeec2,
      opacity: 0.95,
    }), true);

    const left = [];
    const right = [];
    const offset = 1.7;
    for (let i = 0; i < rail.pts.length; i++) {
      const [x, z] = rail.pts[i];
      const [px, pz] = i === 0 ? rail.pts[1] : rail.pts[i - 1];
      const [nx, nz] = i === rail.pts.length - 1 ? rail.pts[i - 1] : rail.pts[i + 1];
      let tx = nx - px;
      let tz = nz - pz;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      left.push([x - tz * offset, z + tx * offset]);
      right.push([x + tz * offset, z - tx * offset]);
    }

    const railMat = new THREE.MeshStandardMaterial({
      color: 0xffe0a0,
      emissive: 0x4a2100,
      emissiveIntensity: 0.25,
      roughness: 0.38,
      metalness: 0.35,
    });
    makeMesh(ribbon(left, 1.0, 0.8), railMat);
    makeMesh(ribbon(right, 1.0, 0.8), railMat);

    const tieCount = Math.max(1, Math.min(1200, Math.floor(rail.length / 12)));
    const tieGeo = new THREE.BoxGeometry(1, 1, 1);
    tieGeo.translate(0, 0.5, 0);
    const tieMat = new THREE.MeshStandardMaterial({ color: 0x4b3d2f, roughness: 0.95 });
    const ties = new THREE.InstancedMesh(tieGeo, tieMat, tieCount);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const axisY = new THREE.Vector3(0, 1, 0);

    let travelled = 0;
    let tieIndex = 0;
    let seg = 1;

    while (tieIndex < tieCount && seg < rail.pts.length) {
      const [ax, az] = rail.pts[seg - 1];
      const [bx, bz] = rail.pts[seg];
      const segLen = Math.hypot(bx - ax, bz - az);
      const need = 12 - travelled;

      if (segLen >= need) {
        const t = need / segLen;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const angle = Math.atan2(bz - az, bx - ax);
        const h = heightAt(x, z);
        const y = Math.max(h == null ? 0 : h, 0.3) + 0.68;

        q.setFromAxisAngle(axisY, -angle);
        pos.set(x, y, z);
        scale.set(4.6, 0.22, 0.9);
        m.compose(pos, q, scale);
        ties.setMatrixAt(tieIndex++, m);

        travelled = 0;
      } else {
        travelled += segLen;
        seg++;
      }
    }

    ties.count = tieIndex;
    ties.instanceMatrix.needsUpdate = true;
    ties.castShadow = true;
    ties.receiveShadow = true;
    world.add(ties);

    const station = town.station;
    if (station) {
      const nx = -Math.sin(station.angle);
      const nz = Math.cos(station.angle);
      const off = station.platformD / 2 + 4;
      const px = station.x + nx * (station.side || 1) * off;
      const pz = station.z + nz * (station.side || 1) * off;
      const h = heightAt(px, pz);

      const platformGeo = new THREE.BoxGeometry(1, 1, 1);
      platformGeo.translate(0, 0.5, 0);
      const platformMat = new THREE.MeshStandardMaterial({
        color: 0xd6c6a2,
        roughness: 0.9,
        metalness: 0,
      });
      const platform = new THREE.Mesh(platformGeo, platformMat);
      platform.position.set(
        px,
        Math.max(h == null ? 0 : h, 0.3) + 0.4,
        pz,
      );
      platform.rotation.y = -station.angle;
      platform.scale.set(station.platformW, 0.8, station.platformD);
      platform.receiveShadow = true;
      platform.castShadow = true;
      world.add(platform);

      const markerGeo = new THREE.BoxGeometry(1, 1, 1);
      markerGeo.translate(0, 0.5, 0);
      const marker = new THREE.Mesh(
        markerGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffd27a,
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      marker.position.set(px, platform.position.y + 0.6, pz);
      marker.rotation.y = -station.angle;
      marker.scale.set(4, 14, 4);
      marker.renderOrder = 21;
      world.add(marker);
    }
  }

  function buildBuildings() {
    if (!showTown || !town || town.buildings.length === 0) return;

    const count = town.buildings.length;
    const wallGeo = new THREE.BoxGeometry(1, 1, 1);
    wallGeo.translate(0, 0.5, 0);
    const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0 });
    const walls = new THREE.InstancedMesh(wallGeo, wallMat, count);

    const roofGeo = new THREE.BoxGeometry(1, 1, 1);
    roofGeo.translate(0, 0.5, 0);
    const roofMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    const roofs = new THREE.InstancedMesh(roofGeo, roofMat, count);

    const blobGeo = new THREE.CircleGeometry(1, 10);
    blobGeo.rotateX(-Math.PI / 2);
    const blobMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const blobs = new THREE.InstancedMesh(blobGeo, blobMat, count);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const axisY = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();

    town.buildings.forEach((b, idx) => {
      const a = b.angle;
      const ux = Math.cos(a);
      const uz = Math.sin(a);
      const vx = -Math.sin(a);
      const vz = Math.cos(a);
      const hw = b.w / 2;
      const hd = b.d / 2;
      const corners = [
        heightAt(b.x + ux * hw + vx * hd, b.z + uz * hw + vz * hd),
        heightAt(b.x + ux * hw - vx * hd, b.z + uz * hw - vz * hd),
        heightAt(b.x - ux * hw + vx * hd, b.z - uz * hw + vz * hd),
        heightAt(b.x - ux * hw - vx * hd, b.z - uz * hw - vz * hd),
      ].filter((v) => v != null);

      const centerH = heightAt(b.x, b.z) || 0;
      // The render mesh samples the height field at a coarser step than the
      // generator, so a deep foundation avoids buildings hovering above it.
      const base = Math.min(centerH, ...corners) - 8;
      const top = centerH + b.h * BUILDING_HEIGHT_SCALE;
      const wallH = Math.max(2, top - base);

      q.setFromAxisAngle(axisY, -a);
      pos.set(b.x, base, b.z);
      scale.set(b.w, wallH, b.d);
      m.compose(pos, q, scale);
      walls.setMatrixAt(idx, m);

      const tc = TYPE_COLORS[b.type] || TYPE_COLORS.house;
      color.setRGB(tc[0] / 255, tc[1] / 255, tc[2] / 255, THREE.SRGBColorSpace);
      color.multiplyScalar(0.82);
      walls.setColorAt(idx, color);

      pos.set(b.x, top, b.z);
      scale.set(b.w * 1.04, 0.55, b.d * 1.04);
      m.compose(pos, q, scale);
      roofs.setMatrixAt(idx, m);
      color.multiplyScalar(0.68);
      roofs.setColorAt(idx, color);

      pos.set(b.x + 2.2, centerH + 0.2, b.z + 1.8);
      scale.set(b.w * 0.62, 1, b.d * 0.62);
      m.compose(pos, q, scale);
      blobs.setMatrixAt(idx, m);
    });

    walls.instanceMatrix.needsUpdate = true;
    roofs.instanceMatrix.needsUpdate = true;
    blobs.instanceMatrix.needsUpdate = true;
    if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
    if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
    walls.castShadow = true;
    walls.receiveShadow = true;
    roofs.castShadow = true;
    roofs.receiveShadow = true;
    blobs.renderOrder = 4;

    townGroup = new THREE.Group();
    townGroup.add(walls, roofs, blobs);
    world.add(townGroup);
  }

  function disposeWorld() {
    if (!world) return;
    scene.remove(world);
    const geometries = new Set();
    const materials = new Set();
    world.traverse((obj) => {
      if (obj.geometry) geometries.add(obj.geometry);
      if (obj.material) {
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of list) materials.add(mat);
      }
    });
    for (const geo of geometries) geo.dispose();
    for (const mat of materials) {
      for (const key of Object.keys(mat)) {
        const value = mat[key];
        if (value && value.isTexture) value.dispose();
      }
      mat.dispose();
    }
    world = null;
    townGroup = null;
  }

  function update(f, h, t, visibleTown = true, reset = true) {
    field = f;
    hydro = h;
    town = t;
    showTown = visibleTown;

    disposeWorld();
    world = new THREE.Group();
    scene.add(world);

    const cx = f.x0 + f.size / 2;
    const cz = f.y0 + f.size / 2;
    scene.fog = new THREE.Fog(0x0d1b24, f.size * 1.15, f.size * 2.9);

    // Keep the shadow map concentrated around the built area instead of
    // spreading 2048 texels across the whole 6 km map.
    let focusX = cx;
    let focusZ = cz;
    if (town && town.buildings.length > 0) {
      let sx = 0;
      let sz = 0;
      for (const b of town.buildings) {
        sx += b.x;
        sz += b.z;
      }
      focusX = sx / town.buildings.length;
      focusZ = sz / town.buildings.length;
    }

    sun.target.position.set(focusX, 0, focusZ);
    sun.position.set(focusX + f.size * 0.22, f.size * 0.42, focusZ + f.size * 0.14);
    fill.position.set(cx - f.size * 0.4, f.size * 0.3, cz - f.size * 0.2);

    const shadowExtent = f.size * 0.3;
    sun.shadow.camera.left = -shadowExtent;
    sun.shadow.camera.right = shadowExtent;
    sun.shadow.camera.top = shadowExtent;
    sun.shadow.camera.bottom = -shadowExtent;
    sun.shadow.camera.near = f.size * 0.05;
    sun.shadow.camera.far = f.size * 2.5;
    sun.shadow.camera.updateProjectionMatrix();
    camera.far = f.size * 8;
    camera.updateProjectionMatrix();

    buildTerrain();
    buildWater();
    buildRoads();
    buildRailway();
    buildBuildings();

    if (reset) resetCamera();
    resize();
    needsRender = true;
  }

  function setShowTown(value) {
    showTown = value;
    if (townGroup) {
      townGroup.visible = value;
    } else if (value && town) {
      buildBuildings();
    }
    needsRender = true;
  }

  function capture() {
    applyCamera();
    renderer.render(scene, camera);
    return canvas.toDataURL('image/png');
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!active) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!active || !dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    yaw -= dx * 0.006;
    pitch = clamp(pitch + dy * 0.005, 0.18, 1.32);
    needsRender = true;
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = 'grab';
    if (event && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (event) => {
    if (!active) return;
    event.preventDefault();
    const base = field ? field.size : 6000;
    radius = clamp(radius * Math.exp(event.deltaY * 0.0012), base * 0.22, base * 3.2);
    needsRender = true;
  }, { passive: false });

  canvas.addEventListener('dblclick', () => {
    if (!active || !field) return;
    focusTown = !focusTown;
    resetCamera();
  });

  canvas.style.cursor = 'grab';

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (active) resize();
    }).observe(canvas.parentElement);
  }

  return {
    update,
    setActive,
    setShowTown,
    capture,
    resetCamera,
    resize,
    debug: () => ({
      worldChildren: world ? world.children.length : 0,
      railway: town && town.railway
        ? { points: town.railway.pts.length, station: town.station }
        : null,
      amberMeshes: world
        ? world.children.filter((o) => o.isMesh && o.material
          && o.material.color && o.material.color.getHex() === 0xe09a35).length
        : 0,
    }),
    get ready() { return Boolean(field); },
  };
}
