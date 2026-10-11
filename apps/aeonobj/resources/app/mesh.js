/* AeonObj mesh engine — pure JavaScript port of MeshCore (Kotlin).
 * No DOM dependencies: runs in Node (module.exports) and in the browser (window.MeshCore).
 *
 * Pixel input: Int32Array of ARGB, row-major, top row first.
 * Model space: x right, y up, z toward viewer. Long side of the model = 2 units.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeshCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MeshKind = { FLAT: 'flat', RELIEF: 'relief', EXTRUDE: 'extrude' };

  function defaultOpts() {
    return {
      reliefDetail: 128,      // long side of the heightfield grid (8..256)
      reliefDepth: 0.35,      // max relief height in model units
      reliefInvert: false,
      reliefFromAlpha: false,
      extrudeThickness: 0.25,
      extrudeMaxDim: 160       // mask downscale cap for contour tracing
    };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** Long side of the model is 2 units; the other side follows the aspect ratio. */
  function modelSize(w, h) {
    return w >= h ? [2, 2 * h / w] : [2 * w / h, 2];
  }

  function luminance(argb) {
    const r = (argb >> 16) & 0xff;
    const g = (argb >> 8) & 0xff;
    const b = argb & 0xff;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  function build(pixels, w, h, kind, opts) {
    if (!(w > 0 && h > 0 && pixels.length === w * h)) throw new Error('bad pixel buffer');
    const o = Object.assign(defaultOpts(), opts);
    if (kind === MeshKind.RELIEF) return relief(pixels, w, h, o);
    if (kind === MeshKind.EXTRUDE) return extrude(pixels, w, h, o);
    return flat(w, h);
  }

  // ------------------------------------------------------------------- flat
  function flat(w, h) {
    const [mw, mh] = modelSize(w, h);
    const sx = mw / 2, sy = mh / 2;
    return {
      positions: [-sx, sy, 0, sx, sy, 0, -sx, -sy, 0, sx, -sy, 0],
      uvs: [0, 1, 1, 1, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      // faces: flat [v, vt, vn, ...] 0-based, 9 entries per triangle.
      faces: [0, 0, 0, 2, 2, 2, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3]
    };
  }

  // ----------------------------------------------------------------- relief
  function relief(pixels, w, h, o) {
    const detail = clamp(Math.round(o.reliefDetail), 8, 256);
    const longSide = Math.max(w, h);
    const gw = Math.max(2, Math.round(detail * w / longSide));
    const gh = Math.max(2, Math.round(detail * h / longSide));
    const [mw, mh] = modelSize(w, h);

    const heights = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      const py = clamp(Math.floor(j * h / gh), 0, h - 1);
      for (let i = 0; i < gw; i++) {
        const px = clamp(Math.floor(i * w / gw), 0, w - 1);
        const c = pixels[py * w + px];
        const v = o.reliefFromAlpha ? ((c >>> 24) & 0xff) / 255 : luminance(c);
        heights[j * gw + i] = (o.reliefInvert ? 1 - v : v) * o.reliefDepth;
      }
    }

    const pos = new Float32Array(gw * gh * 3);
    const uv = new Float32Array(gw * gh * 2);
    const nrm = new Float32Array(gw * gh * 3);
    const cellW = mw / (gw - 1), cellH = mh / (gh - 1);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        pos[k * 3] = (i / (gw - 1) - 0.5) * mw;
        pos[k * 3 + 1] = (0.5 - j / (gh - 1)) * mh;
        pos[k * 3 + 2] = heights[k];
        uv[k * 2] = i / (gw - 1);
        uv[k * 2 + 1] = 1 - j / (gh - 1);
        // Smooth normals from central differences (model y decreases as j grows).
        const hl = heights[j * gw + Math.max(0, i - 1)];
        const hr = heights[j * gw + Math.min(gw - 1, i + 1)];
        const hu = heights[Math.max(0, j - 1) * gw + i];
        const hd = heights[Math.min(gh - 1, j + 1) * gw + i];
        const dxSpan = (i === 0 || i === gw - 1) ? cellW : 2 * cellW;
        const dySpan = (j === 0 || j === gh - 1) ? cellH : 2 * cellH;
        let nx = -(hr - hl) / dxSpan;
        let ny = (hd - hu) / dySpan;
        let nz = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nrm[k * 3] = nx / len; nrm[k * 3 + 1] = ny / len; nrm[k * 3 + 2] = nz / len;
      }
    }

    const faces = new Int32Array((gw - 1) * (gh - 1) * 18);
    let t = 0;
    for (let j = 0; j < gh - 1; j++) {
      for (let i = 0; i < gw - 1; i++) {
        const a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
        // (a, c, b) and (b, c, d); v=vt=vn share the index.
        faces[t++] = a; faces[t++] = a; faces[t++] = a;
        faces[t++] = c; faces[t++] = c; faces[t++] = c;
        faces[t++] = b; faces[t++] = b; faces[t++] = b;
        faces[t++] = b; faces[t++] = b; faces[t++] = b;
        faces[t++] = c; faces[t++] = c; faces[t++] = c;
        faces[t++] = d; faces[t++] = d; faces[t++] = d;
      }
    }
    return { positions: pos, uvs: uv, normals: nrm, faces: faces };
  }

  // ---------------------------------------------------------------- extrude
  function extrude(pixels, w, h, o) {
    // 1. Solid mask from the alpha channel.
    let mask = new Uint8Array(w * h);
    let anySolid = false;
    for (let i = 0; i < w * h; i++) {
      const s = (((pixels[i] >>> 24) & 0xff) > 127) ? 1 : 0;
      mask[i] = s;
      if (s) anySolid = true;
    }
    if (!anySolid) mask.fill(1); // fully transparent -> slab
    let mw = w, mh = h;
    const longSide = Math.max(w, h);
    if (longSide > o.extrudeMaxDim) {
      const s = o.extrudeMaxDim / longSide;
      mw = Math.max(2, Math.round(w * s));
      mh = Math.max(2, Math.round(h * s));
      const small = new Uint8Array(mw * mh);
      for (let y = 0; y < mh; y++) {
        const sy = clamp(Math.floor(y * h / mh), 0, h - 1);
        for (let x = 0; x < mw; x++) {
          const sx = clamp(Math.floor(x * w / mw), 0, w - 1);
          small[y * mw + x] = mask[sy * w + sx];
        }
      }
      mask = small;
    }

    // 2. Directed boundary edges on the integer lattice.
    const solid = (x, y) => x >= 0 && y >= 0 && x < mw && y < mh && mask[y * mw + x] === 1;
    const segs = [];
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (!mask[y * mw + x]) continue;
        if (!solid(x - 1, y)) segs.push({ ax: x, ay: y + 1, bx: x, by: y });
        if (!solid(x + 1, y)) segs.push({ ax: x + 1, ay: y, bx: x + 1, by: y + 1 });
        if (!solid(x, y - 1)) segs.push({ ax: x, ay: y, bx: x + 1, by: y });
        if (!solid(x, y + 1)) segs.push({ ax: x + 1, ay: y + 1, bx: x, by: y + 1 });
      }
    }
    if (segs.length === 0) return flat(w, h);

    // 3. Stitch directed edges into closed loops.
    const out = new Map(); // "x,y" -> [segments]
    for (const s of segs) {
      const k = s.ax + ',' + s.ay;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(s);
    }
    const used = new Set();
    const loops = [];
    for (const s of segs) {
      if (used.has(s)) continue;
      used.add(s);
      const loop = [{ x: s.ax, y: s.ay }, { x: s.bx, y: s.by }];
      let cx = s.bx, cy = s.by;
      let guard = 0;
      while (!(cx === s.ax && cy === s.ay) && guard++ < segs.length + 8) {
        const cands = (out.get(cx + ',' + cy) || []).filter(c => !used.has(c));
        if (cands.length === 0) break;
        const prev = loop[loop.length - 2];
        const nxt = cands.find(c => !(c.bx === prev.x && c.by === prev.y)) || cands[0];
        used.add(nxt);
        loop.push({ x: nxt.bx, y: nxt.by });
        cx = nxt.bx; cy = nxt.by;
      }
      if (cx === s.ax && cy === s.ay && loop.length >= 3) {
        loop.pop(); // drop duplicated start point
        loops.push(loop);
      }
    }
    if (loops.length === 0) return flat(w, h);

    // 4. Normalize orientation (shoelace < 0 in mask coords => CCW in model
    // coords, since the y flip reverses orientation), then clean the loops.
    for (const loop of loops) if (shoelace(loop) > 0) loop.reverse();
    for (const loop of loops) cleanLoop(loop);

    // 5. Holes (a loop strictly inside another) are capped, not cut out.
    let kept = loops.filter(loop =>
      !loops.some(other => other !== loop && pointInPolygon(loop[0], other))
    );
    if (kept.length === 0) {
      kept = [loops.reduce((a, b) => Math.abs(shoelace(a)) >= Math.abs(shoelace(b)) ? a : b)];
    }

    // 6. Emit indexed triangles with shared geometric vertices (watertight).
    //    Per-face normals are referenced via separate vn indices, so flat
    //    shading is preserved while the topology stays manifold.
    const [modelW, modelH] = modelSize(mw, mh);
    const tz = o.extrudeThickness / 2;
    const pos = [], uvA = [], nrm = [0, 0, 1, 0, 0, -1], faces = [];
    const mx = x => (x / mw - 0.5) * modelW;
    const my = y => (0.5 - y / mh) * modelH;
    const mu = x => x / mw;
    const mv = y => 1 - y / mh;

    for (const loop of kept) {
      if (loop.length < 3) continue;
      const N = loop.length;
      const vBase = pos.length / 3;
      const vtBase = uvA.length / 2;
      for (const p of loop) { pos.push(mx(p.x), my(p.y), tz); uvA.push(mu(p.x), mv(p.y)); }
      for (const p of loop) { pos.push(mx(p.x), my(p.y), -tz); uvA.push(mu(p.x), mv(p.y)); }
      const F = i => vBase + i;        // front geometric index
      const B = i => vBase + N + i;    // back geometric index
      const T = i => vtBase + i;       // uv index (shared front/back)

      const tris = earClip(loop);
      // A complete triangulation of an N-gon has exactly N-2 triangles;
      // otherwise the caps would not be closed — skip this loop.
      if (tris.length !== N - 2) continue;
      for (const [a, b, c] of tris) {
        faces.push(F(a), T(a), 0, F(b), T(b), 0, F(c), T(c), 0); // front, +z
        faces.push(B(a), T(a), 1, B(c), T(c), 1, B(b), T(b), 1); // back, -z
      }
      for (let e = 0; e < N; e++) {
        const i = e, j = (e + 1) % N;
        const p0 = loop[i], p1 = loop[j];
        let ex = mx(p1.x) - mx(p0.x), ey = my(p1.y) - my(p0.y);
        const el = Math.sqrt(ex * ex + ey * ey);
        if (el < 1e-9) continue;
        ex /= el; ey /= el;
        const wi = nrm.length / 3;
        nrm.push(ey, -ex, 0); // outward for CCW loop (interior on left)
        faces.push(F(i), T(i), wi, B(i), T(i), wi, B(j), T(j), wi);
        faces.push(F(i), T(i), wi, B(j), T(j), wi, F(j), T(j), wi);
      }
    }
    if (faces.length === 0) return flat(w, h);
    return { positions: pos, uvs: uvA, normals: nrm, faces: faces };
  }

  // ------------------------------------------------------- polygon helpers
  function shoelace(loop) {
    let s = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      s += p.x * q.y - q.x * p.y;
    }
    return s / 2;
  }

  function cleanLoop(loop) {
    const dedup = [];
    for (const p of loop) {
      const l = dedup[dedup.length - 1];
      if (!l || l.x !== p.x || l.y !== p.y) dedup.push(p);
    }
    if (dedup.length > 1) {
      const f = dedup[0], l = dedup[dedup.length - 1];
      if (f.x === l.x && f.y === l.y) dedup.pop();
    }
    loop.length = 0;
    for (const p of dedup) loop.push(p);
    stripCollinear(loop);
  }

  function stripCollinear(loop) {
    if (loop.length < 4) return;
    let i = 0, guard = 0;
    const maxGuard = loop.length * 4 + 16; // fixed from initial size
    while (loop.length >= 4 && i < loop.length && guard++ < maxGuard) {
      const a = loop[(i - 1 + loop.length) % loop.length];
      const b = loop[i];
      const c = loop[(i + 1) % loop.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross === 0) loop.splice(i, 1);
      else i++;
    }
  }

  function pointInPolygon(p, poly) {
    let inside = false;
    let j = poly.length - 1;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      j = i;
    }
    return inside;
  }

  function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  /** Ear clipping. Returns triples of indices into loop; winding matches input. */
  function earClip(loop) {
    const n = loop.length;
    if (n < 3) return [];
    if (n === 3) return [[0, 1, 2]];
    const sign = shoelace(loop) * 2 < 0 ? -1 : 1;

    function pointInTri(p, a, b, c) {
      // Non-strict: a vertex ON the triangle boundary also invalidates the ear.
      // (A strict test lets through ears whose edge passes exactly through
      // another vertex, producing degenerate polygons and flipped triangles.)
      const d1 = sign * cross(p, a, b);
      const d2 = sign * cross(p, b, c);
      const d3 = sign * cross(p, c, a);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      return !(hasNeg && hasPos);
    }

    const remaining = [];
    for (let i = 0; i < n; i++) remaining.push(i);
    const tris = [];
    let guard = 0;
    while (remaining.length > 3 && guard++ < n * n * 2) {
      let earFound = false;
      for (let k = 0; k < remaining.length; k++) {
        const prev = remaining[(k - 1 + remaining.length) % remaining.length];
        const cur = remaining[k];
        const next = remaining[(k + 1) % remaining.length];
        const a = loop[prev], b = loop[cur], c = loop[next];
        if (sign * cross(a, b, c) <= 0) continue; // not convex
        let anyInside = false;
        for (const m of remaining) {
          if (m === prev || m === cur || m === next) continue;
          if (pointInTri(loop[m], a, b, c)) { anyInside = true; break; }
        }
        if (anyInside) continue;
        tris.push([prev, cur, next]);
        remaining.splice(k, 1);
        earFound = true;
        break;
      }
      if (!earFound) break; // degenerate; avoid infinite loop
    }
    if (remaining.length === 3) {
      const a = loop[remaining[0]], b = loop[remaining[1]], c = loop[remaining[2]];
      if (cross(a, b, c) !== 0) tris.push([remaining[0], remaining[1], remaining[2]]);
    }
    return tris;
  }

  // ---------------------------------------------------------- serialization
  const f5 = v => {
    const s = Number(v).toFixed(5);
    return s === '-0.00000' ? '0.00000' : s;
  };

  function toObj(mesh, modelName, mtlFile) {
    const safe = (modelName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'model');
    const nv = mesh.positions.length / 3;
    const nt = mesh.uvs.length / 2;
    const nn = mesh.normals.length / 3;
    const L = [];
    L.push('# AeonObj v1.0.0 (Windows)');
    L.push('mtllib ' + mtlFile);
    L.push('o ' + safe);
    for (let i = 0; i < nv; i++)
      L.push('v ' + f5(mesh.positions[i * 3]) + ' ' + f5(mesh.positions[i * 3 + 1]) + ' ' + f5(mesh.positions[i * 3 + 2]));
    for (let i = 0; i < nt; i++)
      L.push('vt ' + f5(mesh.uvs[i * 2]) + ' ' + f5(mesh.uvs[i * 2 + 1]));
    for (let i = 0; i < nn; i++)
      L.push('vn ' + f5(mesh.normals[i * 3]) + ' ' + f5(mesh.normals[i * 3 + 1]) + ' ' + f5(mesh.normals[i * 3 + 2]));
    L.push('usemtl AeonObjMat');
    const F = mesh.faces;
    for (let t = 0; t + 8 < F.length; t += 9) {
      const v = [];
      for (let k = 0; k < 3; k++) {
        const vi = F[t + k * 3] + 1, ti = F[t + k * 3 + 1] + 1, ni = F[t + k * 3 + 2] + 1;
        if (vi < 1 || vi > nv || ti < 1 || ti > nt || ni < 1 || ni > nn)
          throw new Error('face index out of range');
        v.push(vi + '/' + ti + '/' + ni);
      }
      L.push('f ' + v.join(' '));
    }
    return L.join('\n') + '\n';
  }

  function toMtl(texFile) {
    return '# AeonObj v1.0.0 (Windows)\n' +
      'newmtl AeonObjMat\n' +
      'Ka 1.000 1.000 1.000\n' +
      'Kd 1.000 1.000 1.000\n' +
      'Ks 0.000 0.000 0.000\n' +
      'd 1.0\n' +
      'illum 1\n' +
      'map_Kd ' + texFile + '\n';
  }

  // ------------------------------------------------------------ auto-rig
  // Zhang-Suen thinning: reduces a binary mask to its 1px medial skeleton.
  function skeletonize(mask, w, h) {
    const skel = new Uint8Array(mask); // copy
    const N = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? skel[y * w + x] : 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        const remove = [];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!skel[y * w + x]) continue;
            // 8-neighbors: p2..p9 (clockwise from north)
            const p = [
              N(x, y - 1), N(x + 1, y - 1), N(x + 1, y), N(x + 1, y + 1),
              N(x, y + 1), N(x - 1, y + 1), N(x - 1, y), N(x - 1, y - 1)
            ];
            let nz = 0;
            for (const v of p) if (v) nz++;
            if (nz < 2 || nz > 6) continue;
            let transitions = 0;
            for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) transitions++;
            if (transitions !== 1) continue;
            if (step === 0) {
              if (p[0] && p[2] && p[4]) continue;
              if (p[2] && p[4] && p[6]) continue;
            } else {
              if (p[0] && p[2] && p[6]) continue;
              if (p[0] && p[4] && p[6]) continue;
            }
            remove.push(y * w + x);
          }
        }
        if (remove.length) { changed = true; for (const i of remove) skel[i] = 0; }
      }
    }
    return skel;
  }

  // Extract bone segments from a skeleton: trace from endpoints/junctions.
  // Returns [{ax, ay, bx, by}] in mask pixel coords.
  function extractBones(skel, w, h) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? skel[y * w + x] : 0;
    const neighbors = (x, y) => {
      const n = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (at(x + dx, y + dy)) n.push([x + dx, y + dy]);
      }
      return n;
    };
    // Find endpoints (1 neighbor) and junctions (>2 neighbors).
    const keypoints = new Set();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      const n = neighbors(x, y).length;
      if (n === 1 || n > 2) keypoints.add(y * w + x);
    }
    const bones = [];
    const visited = new Set();
    const key = (x, y) => y * w + x;
    // Trace from each keypoint along unvisited skeleton pixels.
    for (const kp of keypoints) {
      const kx = kp % w, ky = Math.floor(kp / w);
      for (const [nx, ny] of neighbors(kx, ky)) {
        if (visited.has(key(nx, ny))) continue;
        // Walk until next keypoint or dead end.
        let cx = nx, cy = ny, px = kx, py = ky;
        visited.add(key(cx, cy));
        while (true) {
          if (keypoints.has(key(cx, cy))) break;
          const nbs = neighbors(cx, cy).filter(([x, y]) => !(x === px && y === py));
          if (!nbs.length) break;
          // Prefer straightest continuation.
          let best = nbs[0], bestDot = -2;
          const dx1 = cx - px, dy1 = cy - py;
          for (const [x, y] of nbs) {
            const dx2 = x - cx, dy2 = y - cy;
            const dot = dx1 * dx2 + dy1 * dy2;
            if (dot > bestDot) { bestDot = dot; best = [x, y]; }
          }
          px = cx; py = cy; cx = best[0]; cy = best[1];
          visited.add(key(cx, cy));
        }
        const ex = cx, ey = cy;
        // Only keep bones of meaningful length.
        const len = Math.hypot(ex - kx, ey - ky);
        if (len >= 3) bones.push({ ax: kx, ay: ky, bx: ex, by: ey });
      }
    }
    return bones;
  }

  // Build a rig (bone list) from image pixels. Returns null if unsuitable.
  // Bones are in model coords: {name, head:[x,y,z], tail:[x,y,z]}.
  function buildRig(pixels, w, h, kind, opts) {
    if (kind !== MeshKind.EXTRUDE) return null; // skeleton rig only for extrudes
    const o = Object.assign(defaultOpts(), opts);
    // Build alpha mask (same downscale as extrude).
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = (((pixels[i] >>> 24) & 0xff) > 127) ? 1 : 0;
    let mw = w, mh = h;
    const longSide = Math.max(w, h);
    if (longSide > o.extrudeMaxDim) {
      const s = o.extrudeMaxDim / longSide;
      mw = Math.max(2, Math.round(w * s));
      mh = Math.max(2, Math.round(h * s));
      const small = new Uint8Array(mw * mh);
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++)
        small[y * mw + x] = mask[Math.floor(y * h / mh) * w + Math.floor(x * w / mw)];
      mask = small;
    }
    if (!mask.some(v => v)) return null;
    const skel = skeletonize(mask, mw, mh);
    const segs = extractBones(skel, mw, mh);
    if (!segs.length) return null;
    // Map mask coords to model coords (same as extrude).
    const [modelW, modelH] = modelSize(mw, mh);
    const mx = x => (x / mw - 0.5) * modelW;
    const my = y => (0.5 - y / mh) * modelH;
    // Prune tiny bones and merge into a clean list.
    const bones = segs
      .filter(s => Math.hypot(s.bx - s.ax, s.by - s.ay) >= 4)
      .map((s, i) => ({
        name: 'Bone_' + String(i).padStart(2, '0'),
        head: [mx(s.ax), my(s.ay), 0],
        tail: [mx(s.bx), my(s.by), 0]
      }));
    return bones.length ? bones : null;
  }

  // Generate a Blender Python script that imports the OBJ and builds the rig.
  function toBlenderRigScript(bones, objFile, modelName) {
    const L = [];
    L.push('# AeonObj auto-rig script v1.0.0');
    L.push('# In Blender: Text Editor > Open this file > Run Script.');
    L.push('# It imports ' + objFile + ' (keep it next to this script)');
    L.push('# and builds an armature with automatic weights.');
    L.push('import bpy, os');
    L.push('');
    L.push('def find_obj(filename):');
    L.push('    for text in bpy.data.texts:');
    L.push('        if text.filepath:');
    L.push('            cand = os.path.join(os.path.dirname(text.filepath), filename)');
    L.push("            if os.path.exists(cand): return cand");
    L.push('    if bpy.data.filepath:');
    L.push('        cand = os.path.join(os.path.dirname(bpy.data.filepath), filename)');
    L.push("        if os.path.exists(cand): return cand");
    L.push('    cand = os.path.join(os.getcwd(), filename)');
    L.push("    if os.path.exists(cand): return cand");
    L.push('    return None');
    L.push('');
    L.push("obj_path = find_obj('" + objFile + "')");
    L.push('if not obj_path:');
    L.push("    raise FileNotFoundError('Could not find " + objFile + " - keep it next to this script')");
    L.push('print(\'AeonObj: importing\', obj_path)');
    L.push('');
    L.push('bpy.ops.wm.obj_import(filepath=obj_path)');
    L.push('mesh_obj = bpy.context.selected_objects[0]');
    L.push('');
    L.push('# Create armature');
    L.push("bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))");
    L.push('arm = bpy.context.active_object');
    L.push("arm.name = '" + (modelName.replace(/[^A-Za-z0-9_]/g, '_') || 'model') + "_Rig'");
    L.push('eb = arm.data.edit_bones');
    L.push('eb.remove(eb[0])  # drop default bone');
    for (const b of bones) {
      const hn = b.name.replace(/[^A-Za-z0-9_]/g, '_');
      L.push("bn = eb.new('" + hn + "')");
      L.push('bn.head = (' + b.head.map(f5).join(', ') + ')');
      L.push('bn.tail = (' + b.tail.map(f5).join(', ') + ')');
    }
    L.push("bpy.ops.object.mode_set(mode='OBJECT')");
    L.push('');
    L.push('# Parent mesh to armature with automatic (heat) weights');
    L.push("bpy.ops.object.select_all(action='DESELECT')");
    L.push('mesh_obj.select_set(True)');
    L.push('arm.select_set(True)');
    L.push('bpy.context.view_layer.objects.active = arm');
    L.push("bpy.ops.object.parent_set(type='ARMATURE_AUTO')");
    L.push("print('AeonObj: rigged', mesh_obj.name, 'with', len(arm.data.bones), 'bones')");
    return L.join('\n') + '\n';
  }

  return { MeshKind, build, toObj, toMtl, defaultOpts, buildRig, toBlenderRigScript };
});
