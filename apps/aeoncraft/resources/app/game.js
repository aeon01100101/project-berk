'use strict';
/* AeonCraft - original fan-made voxel sandbox.
 * All code, textures and names are original. No Mojang code or assets.
 *
 * This file is split into two parts:
 *  CORE  (between __CORE_BEGIN__ / __CORE_END__): pure logic with no DOM and
 *        no THREE dependency, so it can be unit-tested under Node.
 *  GAME  : renderer, textures, player, input, UI (needs DOM + THREE).
 */

/*__CORE_BEGIN__*/

/* ---------------- deterministic PRNG + noise ---------------- */

function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer lattice hash -> [0,1). Deterministic for any (x,z,seed).
function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^
          Math.imul(iz, 2246822519) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise2(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const ux = smooth(fx), uz = smooth(fz);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}

function fbm2(x, z, seed, oct) {
  let v = 0, amp = 0.5, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * valueNoise2(x * f, z * f, (seed + i * 101) | 0);
    tot += amp; amp *= 0.5; f *= 2.03;
  }
  return v / tot; // [0,1)
}

/* ---------------- world constants + block table ---------------- */

const CHUNK = 16;      // chunk footprint (x,z)
const WORLD_H = 64;    // world height (y)
const SEA = 18;        // at/below this height the surface becomes sand

// Original block set. Tile indices refer to slots in the 4x4 texture atlas.
const BLOCKS = {
  0:  { name: 'Air',       tiles: { top: 0, side: 0, bottom: 0 },  opaque: false },
  1:  { name: 'Grass Block', tiles: { top: 0, side: 1, bottom: 2 }, opaque: true },
  2:  { name: 'Dirt',      tiles: { top: 2, side: 2, bottom: 2 },  opaque: true },
  3:  { name: 'Stone',     tiles: { top: 3, side: 3, bottom: 3 },  opaque: true },
  4:  { name: 'Wood Log',  tiles: { top: 5, side: 4, bottom: 5 },  opaque: true },
  5:  { name: 'Leaves',    tiles: { top: 6, side: 6, bottom: 6 },  opaque: true },
  6:  { name: 'Sand',      tiles: { top: 7, side: 7, bottom: 7 },  opaque: true },
  7:  { name: 'Planks',    tiles: { top: 8, side: 8, bottom: 8 },  opaque: true },
  8:  { name: 'Brick',     tiles: { top: 9, side: 9, bottom: 9 },  opaque: true },
  9:  { name: 'Glass',     tiles: { top: 10, side: 10, bottom: 10 }, opaque: false },
  10: { name: 'Glow Lamp', tiles: { top: 11, side: 11, bottom: 11 }, opaque: true },
  11: { name: 'Stick', tiles: { top: 12, side: 12, bottom: 12 }, opaque: true },
  12: { name: 'Torch', tiles: { top: 13, side: 13, bottom: 13 }, opaque: true },
  13: { name: 'Crafting Table', tiles: { top: 15, side: 14, bottom: 8 }, opaque: true }
};
const MAX_BLOCK_ID = 13;

/* ---------------- inventory + crafting (pure logic) ---------------- */

function invAdd(inv, id, n) {
  inv[id] = (inv[id] || 0) + n;
  if (inv[id] <= 0) delete inv[id];
}
function invTake(inv, id, n) {
  if ((inv[id] || 0) < n) return false;
  inv[id] -= n;
  if (inv[id] <= 0) delete inv[id];
  return true;
}

// All recipes are original. shaped patterns use block ids; 0 = must be empty.
// A shaped pattern may sit at any offset inside the grid; every cell outside
// the pattern must be empty.
const RECIPES = [
  { key: 'planks', shapeless: true, need: { 4: 1 }, out: { id: 7, count: 4 } }, // Wood Log -> 4 Planks
  { key: 'sticks', pattern: [[7], [7]], out: { id: 11, count: 4 } },            // 2 Planks stacked -> 4 Sticks
  { key: 'table', pattern: [[7, 7], [7, 7]], out: { id: 13, count: 1 } },       // 4 Planks -> Crafting Table
  { key: 'glass', pattern: [[6, 6], [6, 6]], out: { id: 9, count: 4 } },        // 4 Sand -> 4 Glass
  { key: 'torch', pattern: [[11], [7]], out: { id: 12, count: 4 } },            // Stick over Planks -> 4 Torches
  { key: 'brick', pattern: [[3, 3], [3, 3]], out: { id: 8, count: 4 } },         // 4 Stone -> 4 Bricks
  // --- tools (3x3, crafting table only) ---
  { key: 'timber_pick',  pattern: [[7,7,7],[0,11,0],[0,11,0]], out: { id: 14, count: 1 } },
  { key: 'timber_axe',   pattern: [[7,7,0],[7,11,0],[0,11,0]], out: { id: 15, count: 1 } },
  { key: 'timber_spade', pattern: [[7],[11],[11]],             out: { id: 16, count: 1 } },
  { key: 'timber_blade', pattern: [[7],[7],[11]],              out: { id: 17, count: 1 } },
  { key: 'rock_pick',    pattern: [[3,3,3],[0,11,0],[0,11,0]], out: { id: 18, count: 1 } },
  { key: 'rock_axe',     pattern: [[3,3,0],[3,11,0],[0,11,0]], out: { id: 19, count: 1 } },
  { key: 'rock_spade',   pattern: [[3],[11],[11]],             out: { id: 20, count: 1 } },
  { key: 'rock_blade',   pattern: [[3],[3],[11]],              out: { id: 21, count: 1 } },
  // --- armor (3x3, crafting table only). M = 4 (Wood Log) for bark, 3 (Stone) for rockplate ---
  { key: 'bark_helm',  pattern: [[4,4,4],[4,0,4]],         out: { id: 22, count: 1 } },
  { key: 'bark_tunic', pattern: [[4,0,4],[4,4,4],[4,4,4]], out: { id: 23, count: 1 } },
  { key: 'bark_legs',  pattern: [[4,4,4],[4,0,4],[4,0,4]], out: { id: 24, count: 1 } },
  { key: 'bark_boots', pattern: [[4,0,4],[4,0,4]],         out: { id: 25, count: 1 } },
  { key: 'rock_helm',  pattern: [[3,3,3],[3,0,3]],         out: { id: 26, count: 1 } },
  { key: 'rock_chest', pattern: [[3,0,3],[3,3,3],[3,3,3]], out: { id: 27, count: 1 } },
  { key: 'rock_legs',  pattern: [[3,3,3],[3,0,3],[3,0,3]], out: { id: 28, count: 1 } },
  { key: 'rock_boots', pattern: [[3,0,3],[3,0,3]],         out: { id: 29, count: 1 } }
];

// cells: flat array of size*size block ids (0 = empty). Returns {id,count} or null.
function matchRecipe(cells, size) {
  for (const r of RECIPES) {
    if (r.shapeless) {
      const counts = {};
      let total = 0;
      for (let i = 0; i < cells.length; i++) {
        const id = cells[i];
        if (id) { counts[id] = (counts[id] || 0) + 1; total++; }
      }
      let needTotal = 0, okm = true;
      for (const k in r.need) {
        needTotal += r.need[k];
        if ((counts[k] || 0) !== r.need[k]) { okm = false; break; }
      }
      if (okm && total === needTotal) return r.out;
    } else {
      const ph = r.pattern.length, pw = r.pattern[0].length;
      for (let oy = 0; oy <= size - ph; oy++) {
        for (let ox = 0; ox <= size - pw; ox++) {
          let okm = true;
          for (let y = 0; y < size && okm; y++) {
            for (let x = 0; x < size; x++) {
              const inPat = x >= ox && x < ox + pw && y >= oy && y < oy + ph;
              const want = inPat ? r.pattern[y - oy][x - ox] : 0;
              if (cells[y * size + x] !== want) { okm = false; break; }
            }
          }
          if (okm) return r.out;
        }
      }
    }
  }
  return null;
}

/* ---------------- tools + armor (pure logic) ---------------- */
// Original gear set. Tool ids 14-21, armor ids 22-29. Blocks stay 1-13.
// Gear items are non-stackable instances {id, dur}; only blocks stack.

// type: pickaxe (stone/brick), axe (log/planks/table), shovel (dirt/grass/sand),
// sword (bonus vs mobs, poor at mining). mult = speed on correct blocks.
const TOOLS = {
  14: { name: 'Timber Pick',  type: 'pickaxe', tier: 'wood',  maxDur: 60,  mult: 2 },
  15: { name: 'Timber Axe',   type: 'axe',     tier: 'wood',  maxDur: 60,  mult: 2 },
  16: { name: 'Timber Spade', type: 'shovel',  tier: 'wood',  maxDur: 60,  mult: 2 },
  17: { name: 'Timber Blade', type: 'sword',   tier: 'wood',  maxDur: 60,  mult: 1, dmg: 2 },
  18: { name: 'Rock Pick',    type: 'pickaxe', tier: 'stone', maxDur: 131, mult: 4 },
  19: { name: 'Rock Axe',     type: 'axe',     tier: 'stone', maxDur: 131, mult: 4 },
  20: { name: 'Rock Spade',   type: 'shovel',  tier: 'stone', maxDur: 131, mult: 4 },
  21: { name: 'Rock Blade',   type: 'sword',   tier: 'stone', maxDur: 131, mult: 1, dmg: 3 }
};
// slot: helm/chest/legs/boots. red = flat damage reduction per piece.
const ARMOR = {
  22: { name: 'Bark Helm',            slot: 'helm',  mat: 'bark', maxDur: 55,  red: 0.04 },
  23: { name: 'Bark Tunic',           slot: 'chest', mat: 'bark', maxDur: 80,  red: 0.04 },
  24: { name: 'Bark Leggings',        slot: 'legs',  mat: 'bark', maxDur: 75,  red: 0.04 },
  25: { name: 'Bark Boots',           slot: 'boots', mat: 'bark', maxDur: 65,  red: 0.04 },
  26: { name: 'Rockplate Helm',       slot: 'helm',  mat: 'rock', maxDur: 165, red: 0.08 },
  27: { name: 'Rockplate Chestplate', slot: 'chest', mat: 'rock', maxDur: 240, red: 0.08 },
  28: { name: 'Rockplate Greaves',    slot: 'legs',  mat: 'rock', maxDur: 225, red: 0.08 },
  29: { name: 'Rockplate Boots',      slot: 'boots', mat: 'rock', maxDur: 195, red: 0.08 }
};
const ARMOR_SLOTS = ['helm', 'chest', 'legs', 'boots'];
const MAX_ITEM_ID = 29;
const ARMOR_CAP = 0.6;

// Seconds to mine one block at 1x speed (hand).
const HARDNESS = {
  1: 0.6, 2: 0.5, 3: 2.0, 4: 2.0, 5: 0.2, 6: 0.5, 7: 2.0,
  8: 2.0, 9: 0.3, 10: 0.5, 11: 0.4, 12: 0.2, 13: 2.5
};
// Which block ids each tool type is effective on.
const TOOL_CLASS = {
  pickaxe: [3, 8],
  axe: [4, 7, 13],
  shovel: [1, 2, 6]
};

// Mining speed multiplier. toolId 0/null = bare hand (1x).
// Correct tool: 2x wooden / 4x stone. Wrong tool or sword: 0.5x (slower than hand).
function toolSpeedMult(toolId, blockId) {
  if (!toolId || !TOOLS[toolId]) return 1;
  const t = TOOLS[toolId];
  if (t.type === 'sword') return 0.5;
  return (TOOL_CLASS[t.type] || []).indexOf(blockId) >= 0 ? t.mult : 0.5;
}

// Seconds to break blockId with the given tool (0 = hand).
function mineTime(blockId, toolId) {
  return (HARDNESS[blockId] || 1) / toolSpeedMult(toolId, blockId);
}

// Mob damage per hit. Hand = 1; swords deal bonus.
function toolDamage(toolId) {
  if (!toolId || !TOOLS[toolId]) return 1;
  const t = TOOLS[toolId];
  return t.type === 'sword' ? (t.dmg || 1) : 1;
}

// Wear one use off a gear instance {id, dur}. Returns true if it broke.
function wearTool(inst) {
  inst.dur -= 1;
  return inst.dur <= 0;
}

// Total flat damage reduction from equipped armor slots ([{id,dur}|null]).
function armorReduction(slots) {
  let r = 0;
  for (const s of slots) {
    if (s && ARMOR[s.id] && s.dur > 0) r += ARMOR[s.id].red;
  }
  return Math.min(ARMOR_CAP, r);
}

// Apply one damage instance through armor. Wears each equipped piece by 1.
// Returns {dmg, broke:[{index,id}]} (broke pieces are removed from slots).
function applyArmorDamage(n, slots) {
  const red = armorReduction(slots);
  const dmg = Math.max(0, Math.round(n * (1 - red)));
  const broke = [];
  if (red > 0 && n > 0) {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s && ARMOR[s.id] && s.dur > 0) {
        s.dur -= 1;
        if (s.dur <= 0) { broke.push({ index: i, id: s.id }); slots[i] = null; }
      }
    }
  }
  return { dmg, broke };
}

/* ---------------- generic AABB body physics (mobs) ---------------- */
// body: {x,y,z,vx,vy,vz,hw,h,onGround}; solid(x,y,z)->bool. No allocation.
function stepBody(b, solid, dt) {
  moveBodyAxis(b, solid, 0, b.vx * dt);
  moveBodyAxis(b, solid, 2, b.vz * dt);
  b.onGround = false;
  moveBodyAxis(b, solid, 1, b.vy * dt);
}
function moveBodyAxis(b, solid, axis, amount) {
  if (amount === 0) return;
  if (axis === 0) b.x += amount; else if (axis === 1) b.y += amount; else b.z += amount;
  const minX = Math.floor(b.x - b.hw), maxX = Math.floor(b.x + b.hw);
  const minY = Math.floor(b.y), maxY = Math.floor(b.y + b.h - 1e-4);
  const minZ = Math.floor(b.z - b.hw), maxZ = Math.floor(b.z + b.hw);
  let hit = false, best = 0;
  for (let bx = minX; bx <= maxX; bx++)
    for (let by = minY; by <= maxY; by++)
      for (let bz = minZ; bz <= maxZ; bz++) {
        if (!solid(bx, by, bz)) continue;
        hit = true;
        if (axis === 0) {
          const edge = amount > 0 ? bx - b.hw - 1e-3 : bx + 1 + b.hw + 1e-3;
          best = amount > 0 ? (best === 0 ? edge : Math.min(best, edge)) : Math.max(best, edge);
        } else if (axis === 1) {
          const edge = amount > 0 ? by - b.h - 1e-3 : by + 1 + 1e-3;
          best = amount > 0 ? (best === 0 ? edge : Math.min(best, edge)) : Math.max(best, edge);
        } else {
          const edge = amount > 0 ? bz - b.hw - 1e-3 : bz + 1 + b.hw + 1e-3;
          best = amount > 0 ? (best === 0 ? edge : Math.min(best, edge)) : Math.max(best, edge);
        }
      }
  if (!hit) return;
  if (axis === 0) { b.x = best; b.vx = 0; }
  else if (axis === 1) { b.y = best; b.vy = 0; if (amount < 0) b.onGround = true; }
  else { b.z = best; b.vz = 0; }
}

// Ray vs AABB slab test. Returns entry distance t, or null. No allocation.
function rayHitBox(ox, oy, oz, dx, dy, dz,
                   minx, miny, minz, maxx, maxy, maxz, maxT) {
  let tmin = 0, tmax = maxT, t1, t2, tmp;
  if (Math.abs(dx) < 1e-9) { if (ox < minx || ox > maxx) return null; }
  else {
    t1 = (minx - ox) / dx; t2 = (maxx - ox) / dx;
    if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (Math.abs(dy) < 1e-9) { if (oy < miny || oy > maxy) return null; }
  else {
    t1 = (miny - oy) / dy; t2 = (maxy - oy) / dy;
    if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (Math.abs(dz) < 1e-9) { if (oz < minz || oz > maxz) return null; }
  else {
    t1 = (minz - oz) / dz; t2 = (maxz - oz) / dz;
    if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

function tileFor(id, kind) {
  const t = BLOCKS[id].tiles;
  return kind === 'top' ? t.top : kind === 'bottom' ? t.bottom : t.side;
}

// tile index -> atlas UV rect [u0,v0,u1,v1] (atlas is 4x4 tiles, 64x64 px)
function tileUV(tile) {
  const col = tile % 4, row = Math.floor(tile / 4);
  const e = 0.5 / 64; // half-texel inset against bleeding
  return [col / 4 + e, 1 - (row + 1) / 4 + e, (col + 1) / 4 - e, 1 - row / 4 - e];
}

// Six faces. Corners are ordered CCW seen from outside (outward normal).
const FACES = [
  { dir: [0, 1, 0],  kind: 'top',    corners: [[0,1,0],[0,1,1],[1,1,1],[1,1,0]] },
  { dir: [0,-1, 0],  kind: 'bottom', corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]] },
  { dir: [1, 0, 0],  kind: 'side',   corners: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]] },
  { dir: [-1,0, 0],  kind: 'side',   corners: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]] },
  { dir: [0, 0, 1],  kind: 'side',   corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]] },
  { dir: [0, 0,-1],  kind: 'side',   corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]] }
];

/* ---------------- terrain generation ---------------- */

function heightAt(wx, wz, seed) {
  const n = fbm2(wx * 0.018, wz * 0.018, seed, 4);
  const d = fbm2(wx * 0.06 + 1000, wz * 0.06 - 1000, seed ^ 0x9e37, 2);
  return Math.floor(24 + (n - 0.5) * 24 + (d - 0.5) * 6); // ~9..39
}

// Generate one 16xWORLD_Hx16 chunk. Deterministic for (cx,cz,seed).
// Trees are placed from trunk positions in [-2,18) so every chunk reproduces
// the same overlapping leaves without needing neighbor data.
function genChunkData(cx, cz, seed) {
  const data = new Uint8Array(CHUNK * WORLD_H * CHUNK);
  const at = (x, y, z) => (y * CHUNK + z) * CHUNK + x;
  const set = (x, y, z, id) => {
    if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK || y < 0 || y >= WORLD_H) return;
    data[at(x, y, z)] = id;
  };
  const get = (x, y, z) => {
    if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK || y < 0 || y >= WORLD_H) return 0;
    return data[at(x, y, z)];
  };

  for (let lx = 0; lx < CHUNK; lx++) for (let lz = 0; lz < CHUNK; lz++) {
    const wx = cx * CHUNK + lx, wz = cz * CHUNK + lz;
    const h = heightAt(wx, wz, seed);
    const beach = h <= SEA + 1;
    for (let y = 0; y <= h; y++) {
      let id;
      if (y === 0) id = 3;
      else if (y < h - 2) id = 3;
      else if (y < h) id = beach ? 6 : 2;
      else id = beach ? 6 : 1;
      set(lx, y, lz, id);
    }
  }

  for (let lx = -2; lx < CHUNK + 2; lx++) for (let lz = -2; lz < CHUNK + 2; lz++) {
    const wx = cx * CHUNK + lx, wz = cz * CHUNK + lz;
    if (hash2(wx, wz, seed ^ 0x51ab) > 0.012) continue;
    const h = heightAt(wx, wz, seed);
    if (h <= SEA + 1 || h + 8 >= WORLD_H) continue;
    if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) continue; // trunk in this chunk
    const trunkH = 4 + Math.floor(hash2(wx ^ 0x123, wz ^ 0x456, seed) * 2);
    for (let i = 1; i <= trunkH; i++) set(lx, h + i, lz, 4);
    for (let dy = trunkH - 2; dy <= trunkH + 1; dy++) {
      const rad = dy <= trunkH - 1 ? 2 : 1;
      for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
        if (dx === 0 && dz === 0 && dy < trunkH) continue;
        if (Math.abs(dx) === rad && Math.abs(dz) === rad &&
            hash3(wx + dx, h + dy, wz + dz, seed ^ 0x77) < 0.6) continue;
        if (get(lx + dx, h + dy, lz + dz) === 0) set(lx + dx, h + dy, lz + dz, 5);
      }
    }
    if (get(lx, h + trunkH + 2, lz) === 0) set(lx, h + trunkH + 2, lz, 5);
  }
  return data;
}

/* ---------------- chunk meshing ---------------- */

// get(x,y,z) -> block id; x,z may be outside [0,16) (caller resolves neighbors).
// Returns plain arrays; the GAME part turns them into THREE geometry.
function buildChunkArrays(get) {
  const O = { pos: [], nor: [], uv: [], idx: [] };
  const G = { pos: [], nor: [], uv: [], idx: [] };
  for (let y = 0; y < WORLD_H; y++) {
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const id = get(x, y, z);
        if (id === 0) continue;
        const glass = id === 9;
        for (const f of FACES) {
          const ny = y + f.dir[1];
          const nb = (ny < 0 || ny >= WORLD_H) ? 0 : get(x + f.dir[0], ny, z + f.dir[2]);
          let draw;
          if (glass) draw = (nb === 0);            // glass: only faces on air
          else draw = (nb === 0 || nb === 9);      // opaque: skip hidden faces
          if (!draw) continue;
          const uv = tileUV(tileFor(id, f.kind));
          const A = glass ? G : O;
          const base = A.pos.length / 3;
          const quadUV = [[uv[0], uv[1]], [uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]]];
          for (let k = 0; k < 4; k++) {
            A.pos.push(x + f.corners[k][0], y + f.corners[k][1], z + f.corners[k][2]);
            A.nor.push(f.dir[0], f.dir[1], f.dir[2]);
            A.uv.push(quadUV[k][0], quadUV[k][1]);
          }
          A.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }
  return { opaque: O, glass: G };
}

/*__CORE_END__*/

/* ================= GAME (needs DOM + THREE) ================= */
(function () {
'use strict';
if (typeof THREE === 'undefined') {
  document.getElementById('title').innerHTML =
    '<div class="panel"><h2>Failed to start</h2><p>3D library (vendor/three.min.js) did not load.</p></div>';
  return;
}

/* ---------------- procedural texture atlas ---------------- */
// 16 original 16x16 tiles on a 4x4 atlas (64x64 px). Tile order matches
// the tile indices in the core block table.

function paintAtlas() {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;

  for (let i = 0; i < 16; i++) {
    const ox = (i % 4) * 16, oy = Math.floor(i / 4) * 16;
    const R = makeRng(i * 7919 + 7);
    const P = (x, y, c) => { g.fillStyle = c; g.fillRect(ox + x, oy + y, 1, 1); };
    const fill = (c) => { g.fillStyle = c; g.fillRect(ox, oy, 16, 16); };
    const speck = (cols, n) => {
      for (let k = 0; k < n; k++) P((R() * 16) | 0, (R() * 16) | 0, cols[(R() * cols.length) | 0]);
    };
    switch (i) {
      case 0: // grass top
        fill('#5fae3f'); speck(['#4c9432', '#6fbf4d', '#579e38'], 70); break;
      case 1: // grass side
        fill('#7a5a36'); speck(['#6b4c2d', '#86663f'], 55);
        for (let x = 0; x < 16; x++) {
          const d = 3 + ((R() * 3) | 0);
          for (let y = 0; y < d; y++) P(x, y, (x + y) % 2 ? '#5fae3f' : '#4c9432');
        }
        break;
      case 2: fill('#7a5a36'); speck(['#6b4c2d', '#86663f', '#5e4225'], 70); break; // dirt
      case 3: fill('#8d8d8d'); speck(['#7c7c7c', '#9c9c9c', '#6e6e6e'], 70); break; // stone
      case 4: // log side
        fill('#5d4226');
        for (let x = 0; x < 16; x += 3)
          for (let y = 0; y < 16; y++) P(x + (R() < 0.5 ? 1 : 0), y, '#4a3319');
        speck(['#6d5130'], 25); break;
      case 5: // log top (rings)
        fill('#a0824a');
        for (let r = 7; r > 0; r -= 2) {
          g.strokeStyle = (r % 4) ? '#7a5f30' : '#c09a58'; g.lineWidth = 1;
          g.strokeRect(ox + 8 - r + 0.5, oy + 8 - r + 0.5, r * 2 - 1, r * 2 - 1);
        }
        speck(['#8a6f3a'], 18); break;
      case 6: fill('#2f6b24'); speck(['#25591c', '#3a7d2d', '#1d4a16'], 90); break; // leaves
      case 7: fill('#d9c27a'); speck(['#cbb26a', '#e5d08a'], 70); break; // sand
      case 8: // planks
        fill('#9c7443');
        for (let y = 3; y < 16; y += 4) for (let x = 0; x < 16; x++) P(x, y, '#6e4f27');
        for (let r = 0; r < 4; r++) {
          const o = (r % 2) ? 8 : 0;
          for (let x = o; x < 16; x += 8) for (let y = r * 4; y < r * 4 + 3; y++) P(x, y, '#6e4f27');
        }
        speck(['#8a6236'], 25); break;
      case 9: // brick
        fill('#a34a3a');
        for (let y = 3; y < 16; y += 4) for (let x = 0; x < 16; x++) P(x, y, '#d8cfc0');
        for (let r = 0; r < 4; r++) {
          const o = (r % 2) ? 4 : 0;
          for (let x = o; x < 16; x += 8) for (let y = r * 4; y < r * 4 + 3; y++) P(x, y, '#d8cfc0');
        }
        speck(['#8f3d30'], 25); break;
      case 10: // glass: transparent middle, pale frame, shine streak
        g.clearRect(ox, oy, 16, 16);
        g.fillStyle = 'rgba(190,225,240,0.30)'; g.fillRect(ox, oy, 16, 16);
        g.fillStyle = 'rgba(240,250,255,0.92)';
        g.fillRect(ox, oy, 16, 1); g.fillRect(ox, oy + 15, 16, 1);
        g.fillRect(ox, oy, 1, 16); g.fillRect(ox + 15, oy, 1, 16);
        P(4, 11, 'rgba(255,255,255,0.85)'); P(5, 10, 'rgba(255,255,255,0.85)');
        P(6, 9, 'rgba(255,255,255,0.85)'); P(7, 8, 'rgba(255,255,255,0.85)');
        break;
      case 11: // glow lamp
        fill('#e8a83c'); speck(['#d1942f', '#f5bd55'], 45);
        g.fillStyle = '#fff3c4'; g.fillRect(ox + 6, oy + 6, 4, 4); break;
      case 12: // stick: wooden post on dark bark
        fill('#5e4a2e');
        for (let y = 0; y < 16; y++)
          for (let x = 6; x <= 9; x++) P(x, y, (x === 6 || x === 9) ? '#7a5f30' : '#a0824f');
        speck(['#4a3820'], 30); break;
      case 13: // torch: stick with a flame on dark backing
        fill('#33291d');
        for (let y = 6; y < 16; y++)
          for (let x = 7; x <= 8; x++) P(x, y, '#8a6b42');
        for (let y = 1; y <= 5; y++)
          for (let x = 6; x <= 9; x++) {
            const edge = (x === 6 || x === 9 || y === 1);
            P(x, y, edge ? '#ff9933' : (y <= 3 ? '#ffe98a' : '#ffcc44'));
          }
        P(7, 2, '#fffbe0'); P(8, 3, '#fffbe0');
        speck(['#241c12'], 20); break;
      case 14: // crafting table side: planks with dark frame + straps
        fill('#9c7443');
        g.fillStyle = '#5e4020';
        g.fillRect(ox, oy, 16, 2); g.fillRect(ox, oy + 14, 16, 2);
        g.fillRect(ox, oy, 2, 16); g.fillRect(ox + 14, oy, 2, 16);
        for (let k = 0; k < 16; k++) { P(k, k, '#6e4f27'); P(15 - k, k, '#6e4f27'); }
        speck(['#8a6236'], 20); break;
      case 15: // crafting table top: plank checkerboard with grid lines
        for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
          g.fillStyle = (tx + ty) % 2 ? '#8a6236' : '#a37c46';
          g.fillRect(ox + tx * 8, oy + ty * 8, 8, 8);
        }
        g.fillStyle = '#5e4020';
        g.fillRect(ox + 7, oy, 2, 16); g.fillRect(ox, oy + 7, 16, 2);
        g.fillRect(ox, oy, 16, 1); g.fillRect(ox, oy + 15, 16, 1);
        g.fillRect(ox, oy, 1, 16); g.fillRect(ox + 15, oy, 1, 16);
        break;
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return { canvas: cv, texture: tex };
}

// Draw one atlas tile into a small canvas (hotbar icons).
function tileIcon(atlasCanvas, tile, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(atlasCanvas, (tile % 4) * 16, Math.floor(tile / 4) * 16, 16, 16,
              0, 0, size, size);
  return c;
}

function scaleCanvas(cv, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(cv, 0, 0, size, size);
  return c;
}

// Original 16x16 tool icons in the same pixel-art style as the blocks.
// Diagonal handle + head shape per type; wood = browns, stone = grays.
function drawToolCanvas(type, tier) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const P = (x, y, c) => { if (x >= 0 && x < 16 && y >= 0 && y < 16) { g.fillStyle = c; g.fillRect(x, y, 1, 1); } };
  const head = tier === 'stone' ? '#9a9a9a' : '#a37c46';
  const headD = tier === 'stone' ? '#6e6e6e' : '#6e4f27';
  const edge = tier === 'stone' ? '#c4c4c4' : '#c09a58';
  // handle: diagonal from bottom-left to top-right
  for (let i = 0; i < 9; i++) {
    P(2 + i, 13 - i, '#7a5a36');
    P(3 + i, 13 - i, '#5e4020');
  }
  if (type === 'pickaxe') {
    for (let x = 4; x <= 12; x++) { P(x, 1, head); P(x, 2, headD); }
    P(3, 2, head); P(3, 3, headD); P(13, 2, head); P(13, 3, headD);
    P(3, 4, headD); P(13, 4, headD);
    for (let x = 5; x <= 11; x++) P(x, 1, edge);
  } else if (type === 'axe') {
    for (let y = 1; y <= 5; y++) for (let x = 9; x <= 13; x++) P(x, y, head);
    for (let y = 1; y <= 5; y++) P(13, y, edge);
    for (let x = 9; x <= 12; x++) { P(x, 5, headD); P(x, 1, headD); }
    P(8, 2, headD); P(8, 3, headD); P(8, 4, headD);
  } else if (type === 'shovel') {
    for (let y = 0; y <= 4; y++) for (let x = 8; x <= 11; x++) P(x, y, head);
    for (let x = 8; x <= 11; x++) { P(x, 0, edge); P(x, 4, headD); }
    P(8, 1, headD); P(11, 1, headD); P(8, 3, headD); P(11, 3, headD);
  } else { // sword: straight blade up, guard, grip
    for (let y = 0; y <= 9; y++) { P(7, y, head); P(8, y, edge); }
    P(7, 0, edge); P(8, 0, '#ffffff');
    for (let x = 4; x <= 10; x++) P(x, 10, headD);
    for (let i = 0; i < 3; i++) { P(6 - i * 0, 11 + i, '#7a5a36'); }
    P(6, 11, '#5e4020'); P(6, 12, '#5e4020'); P(6, 13, '#5e4020');
  }
  return cv;
}

// Original 16x16 armor icons. bark = browns, rock = grays.
function drawArmorCanvas(slot, mat) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const P = (x, y, c) => { if (x >= 0 && x < 16 && y >= 0 && y < 16) { g.fillStyle = c; g.fillRect(x, y, 1, 1); } };
  const base = mat === 'rock' ? '#8d8d8d' : '#7a5a36';
  const dark = mat === 'rock' ? '#5f5f5f' : '#4e3319';
  const lite = mat === 'rock' ? '#b5b5b5' : '#9c7443';
  const R = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) P(x, y, c); };
  if (slot === 'helm') {
    R(4, 5, 11, 10, base); R(4, 5, 11, 6, lite); R(4, 9, 11, 10, dark);
    R(6, 7, 9, 8, '#141a30'); R(4, 4, 11, 4, dark);
  } else if (slot === 'chest') {
    R(4, 2, 11, 12, base); R(1, 2, 3, 9, base); R(12, 2, 14, 9, base);
    R(4, 2, 11, 3, lite); R(7, 4, 8, 12, dark);
    R(1, 8, 3, 9, dark); R(12, 8, 14, 9, dark);
  } else if (slot === 'legs') {
    R(4, 2, 11, 5, base); R(4, 2, 11, 3, lite);
    R(4, 6, 6, 13, base); R(9, 6, 11, 13, base);
    R(4, 12, 6, 13, dark); R(9, 12, 11, 13, dark);
  } else { // boots
    R(4, 8, 6, 12, base); R(9, 8, 11, 12, base);
    R(4, 12, 7, 14, dark); R(9, 12, 12, 14, dark);
    R(4, 8, 6, 9, lite); R(9, 8, 11, 9, lite);
  }
  return cv;
}

// Mining crack overlay stages (4): jagged dark cracks, denser per stage.
function drawCrackCanvas(stage) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const g = cv.getContext('2d');
  const R = makeRng(stage * 131 + 7);
  g.strokeStyle = 'rgba(20,10,5,0.85)';
  g.lineWidth = 1;
  const lines = 3 + stage * 4;
  for (let i = 0; i < lines; i++) {
    let x = R() * 16, y = R() * 16;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 4; k++) { x += (R() - 0.5) * 8; y += (R() - 0.5) * 8; g.lineTo(x, y); }
    g.stroke();
  }
  return cv;
}

// Item icon for any id: blocks use the atlas tile, gear uses its own art.
function itemIcon(id, size) {
  if (id <= MAX_BLOCK_ID) return tileIcon(atlas.canvas, tileFor(id, 'side'), size);
  if (TOOLS[id]) {
    const t = TOOLS[id];
    return scaleCanvas(drawToolCanvas(t.type, t.tier), size);
  }
  if (ARMOR[id]) {
    const a = ARMOR[id];
    return scaleCanvas(drawArmorCanvas(a.slot, a.mat), size);
  }
  return tileIcon(atlas.canvas, 0, size);
}

/* ---------------- world / chunk management ---------------- */

const RENDER_DIST = 4; // chunk radius -> 9x9 = 81 chunks

class World {
  constructor(scene, seed, matOpaque, matGlass) {
    this.scene = scene;
    this.seed = seed;
    this.matOpaque = matOpaque;
    this.matGlass = matGlass;
    this.chunks = new Map(); // "cx,cz" -> {data, group}
    this.diffs = new Map();  // "x,y,z" -> id (player edits)
    this.dirty = new Set();
    this.genQueue = [];
  }
  key(cx, cz) { return cx + ',' + cz; }

  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_H) return 0;
    const cx = Math.floor(wx / CHUNK), cz = Math.floor(wz / CHUNK);
    const c = this.chunks.get(this.key(cx, cz));
    if (!c) return 0;
    return c.data[(wy * CHUNK + (wz - cz * CHUNK)) * CHUNK + (wx - cx * CHUNK)];
  }

  // Record player edits so saves only store diffs vs generated terrain.
  setBlock(wx, wy, wz, id, record) {
    if (wy < 0 || wy >= WORLD_H) return;
    const cx = Math.floor(wx / CHUNK), cz = Math.floor(wz / CHUNK);
    const c = this.chunks.get(this.key(cx, cz));
    if (!c) return;
    const lx = wx - cx * CHUNK, lz = wz - cz * CHUNK;
    c.data[(wy * CHUNK + lz) * CHUNK + lx] = id;
    if (record !== false) this.diffs.set(wx + ',' + wy + ',' + wz, id);
    this.dirty.add(this.key(cx, cz));
    if (lx === 0) this.dirty.add(this.key(cx - 1, cz));
    if (lx === CHUNK - 1) this.dirty.add(this.key(cx + 1, cz));
    if (lz === 0) this.dirty.add(this.key(cx, cz - 1));
    if (lz === CHUNK - 1) this.dirty.add(this.key(cx, cz + 1));
  }

  applyDiffs(cx, cz, data) {
    // diffs are few; scan them instead of the chunk
    for (const [k, id] of this.diffs) {
      const p = k.split(',').map(Number);
      const dx = p[0] - cx * CHUNK, dz = p[2] - cz * CHUNK;
      if (dx >= 0 && dx < CHUNK && dz >= 0 && dz < CHUNK && p[1] >= 0 && p[1] < WORLD_H)
        data[(p[1] * CHUNK + dz) * CHUNK + dx] = id;
    }
  }

  ensureChunk(cx, cz) {
    const k = this.key(cx, cz);
    if (this.chunks.has(k)) return;
    const data = genChunkData(cx, cz, this.seed);
    this.applyDiffs(cx, cz, data);
    const group = new THREE.Group();
    group.position.set(cx * CHUNK, 0, cz * CHUNK);
    this.scene.add(group);
    this.chunks.set(k, { data, group, meshes: [] });
    this.dirty.add(k);
    // neighbors need remesh: their border faces see this chunk now
    this.dirty.add(this.key(cx + 1, cz)); this.dirty.add(this.key(cx - 1, cz));
    this.dirty.add(this.key(cx, cz + 1)); this.dirty.add(this.key(cx, cz - 1));
  }

  disposeChunkMeshes(c) {
    for (const m of c.meshes) {
      c.group.remove(m);
      m.geometry.dispose();
    }
    c.meshes.length = 0;
  }

  remesh(k) {
    const c = this.chunks.get(k);
    if (!c) return;
    this.disposeChunkMeshes(c);
    const parts = k.split(',');
    const cx = +parts[0], cz = +parts[1];
    const self = this;
    const arrays = buildChunkArrays((x, y, z) =>
      self.getBlock(cx * CHUNK + x, y, cz * CHUNK + z));
    for (const [name, arr, mat] of [['o', arrays.opaque, this.matOpaque],
                                    ['g', arrays.glass, this.matGlass]]) {
      if (!arr.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(arr.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
      geo.setIndex(arr.idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      c.group.add(mesh);
      c.meshes.push(mesh);
    }
  }

  unloadChunk(k) {
    const c = this.chunks.get(k);
    if (!c) return;
    this.disposeChunkMeshes(c);
    this.scene.remove(c.group);
    this.chunks.delete(k);
    this.dirty.delete(k);
  }

  // Stream chunks around (pcx,pcz). Budgeted per frame to avoid hitches.
  update(pcx, pcz) {
    // queue missing chunks, nearest first
    const missing = [];
    for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++)
      for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++) {
        const k = this.key(pcx + dx, pcz + dz);
        if (!this.chunks.has(k) && this.genQueue.indexOf(k) < 0)
          missing.push([dx * dx + dz * dz, k]);
      }
    missing.sort((a, b) => a[0] - b[0]);
    for (const m of missing) this.genQueue.push(m[1]);

    let budget = 2;
    while (budget-- > 0 && this.genQueue.length) {
      const k = this.genQueue.shift();
      const p = k.split(',');
      this.ensureChunk(+p[0], +p[1]);
    }
    // remesh dirty (also budgeted)
    budget = 2;
    for (const k of [...this.dirty]) {
      if (budget-- <= 0) break;
      this.dirty.delete(k);
      this.remesh(k);
    }
    // unload far chunks
    for (const k of [...this.chunks.keys()]) {
      const p = k.split(',');
      if (Math.abs(+p[0] - pcx) > RENDER_DIST + 1 || Math.abs(+p[1] - pcz) > RENDER_DIST + 1)
        this.unloadChunk(k);
    }
  }
}

/* ---------------- player ---------------- */

const player = {
  pos: null, vel: null, yaw: 0, pitch: 0,
  onGround: false, fly: false,
  HW: 0.3, H: 1.8, EYE: 1.62
};
let world = null;

function solidAt(wx, wy, wz) {
  return world.getBlock(wx, wy, wz) !== 0;
}

// Move along one axis and clamp against voxel AABBs.
function moveAxis(axis, amount) {
  const p = player.pos;
  if (amount === 0) return;
  if (axis === 0) p.x += amount; else if (axis === 1) p.y += amount; else p.z += amount;

  const minX = Math.floor(p.x - player.HW), maxX = Math.floor(p.x + player.HW);
  const minY = Math.floor(p.y), maxY = Math.floor(p.y + player.H - 1e-4);
  const minZ = Math.floor(p.z - player.HW), maxZ = Math.floor(p.z + player.HW);
  let hit = false, best = 0;

  for (let bx = minX; bx <= maxX; bx++)
    for (let by = minY; by <= maxY; by++)
      for (let bz = minZ; bz <= maxZ; bz++) {
        if (!solidAt(bx, by, bz)) continue;
        hit = true;
        if (axis === 0) {
          const edge = amount > 0 ? bx - player.HW - 1e-3 : bx + 1 + player.HW + 1e-3;
          best = amount > 0 ? (best === 0 ? edge : Math.min(best, edge)) : Math.max(best, edge);
        } else if (axis === 1) {
          const edge = amount > 0 ? by - player.H - 1e-3 : by + 1 + 1e-3;
          best = amount > 0 ? (best === 0 ? edge : Math.min(best, edge)) : Math.max(best, edge);
        } else {
          const edge = amount > 0 ? bz - player.HW - 1e-3 : bz + 1 + player.HW + 1e-3;
          best = amount > 0 ? (best === 0 ? edge : Math.min(best, edge)) : Math.max(best, edge);
        }
      }

  if (!hit) return;
  if (axis === 0) { p.x = best; player.vel.x = 0; }
  else if (axis === 1) {
    p.y = best; player.vel.y = 0;
    if (amount < 0) player.onGround = true;
  } else { p.z = best; player.vel.z = 0; }
}

const keys = {};
function stepPlayer(dt) {
  const p = player.pos, v = player.vel;
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  let ix = 0, iz = 0;
  if (keys.KeyW) iz -= 1;
  if (keys.KeyS) iz += 1;
  if (keys.KeyA) ix -= 1;
  if (keys.KeyD) ix += 1;
  const len = Math.hypot(ix, iz) || 1;
  ix /= len; iz /= len;
  // camera-relative wish direction (yaw=0 faces -z)
  const wx = ix * cos - iz * sin;
  const wz = ix * sin + iz * cos;

  if (player.fly) {
    const sp = 11;
    v.x = wx * sp; v.z = wz * sp;
    v.y = (keys.Space ? sp : 0) + (keys.ShiftLeft || keys.ShiftRight ? -sp : 0);
    if (!ix && !iz && !keys.Space && !(keys.ShiftLeft || keys.ShiftRight)) { v.x = 0; v.z = 0; v.y = 0; }
    player.onGround = false;
  } else {
    const sp = 4.4;
    const accel = player.onGround ? 14 : 5;
    v.x += (wx * sp - v.x) * Math.min(1, accel * dt);
    v.z += (wz * sp - v.z) * Math.min(1, accel * dt);
    v.y -= 28 * dt;
    if (v.y < -40) v.y = -40;
    if (keys.Space && player.onGround) { v.y = 9; player.onGround = false; }
  }

  player.onGround = false;
  moveAxis(0, v.x * dt);
  moveAxis(2, v.z * dt);
  moveAxis(1, v.y * dt);

  // fell out of the world: respawn
  if (p.y < -20) respawn();
}

function respawn() {
  const h = heightAt(8, 8, world.seed);
  player.pos.set(8.5, h + 1.02, 8.5);
  player.vel.set(0, 0, 0);
}

/* ---------------- mobs (original designs, not Minecraft mobs) ---------------- */
// Skitter: small passive hopper; wanders, flees when hit, drops dirt.
// Nipper: slow hostile; approaches the player, deals contact damage, drops sticks.

const MOB_TYPES = {
  skitter: { name: 'Skitter', w: 0.6, h: 0.55, hp: 3, speed: 2.6, hostile: false, drop: { id: 2, count: 2 } },
  nipper:  { name: 'Nipper',  w: 0.7, h: 0.85, hp: 5, speed: 2.3, hostile: true,  drop: { id: 11, count: 2 } }
};
const MAX_MOBS = 8;
const mobs = [];
const pickups = [];
let spawnT = 6, mobAnimT = 0;

function mobSolid(x, y, z) { return world.getBlock(x, y, z) !== 0; }

// Original 16x16 pixel-art critter textures, drawn on canvas like the blocks.
function makeMobTexture(kind) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const R = makeRng(kind === 'skitter' ? 4242 : 777);
  const P = (x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };
  const speck = (cols, n) => {
    for (let k = 0; k < n; k++) P((R() * 16) | 0, (R() * 16) | 0, cols[(R() * cols.length) | 0]);
  };
  if (kind === 'skitter') {
    g.fillStyle = '#3fae9f'; g.fillRect(0, 0, 16, 16);
    speck(['#359082', '#4cc4b4'], 60);
    P(5, 0, '#2a7569'); P(10, 0, '#2a7569'); P(5, 1, '#2a7569'); P(10, 1, '#2a7569');
    for (const ex of [5, 9]) {
      P(ex, 6, '#ffffff'); P(ex + 1, 6, '#ffffff'); P(ex, 7, '#10231f'); P(ex + 1, 7, '#10231f');
    }
    g.fillStyle = '#2a7569'; g.fillRect(0, 14, 16, 2);
  } else { // nipper
    g.fillStyle = '#b0492f'; g.fillRect(0, 0, 16, 16);
    speck(['#93381f', '#c65f3d'], 55);
    for (let x = 1; x < 16; x += 3) { P(x, 0, '#5e2413'); P(x, 1, '#7a2f18'); }
    for (const ex of [4, 10]) {
      P(ex, 6, '#ffd23f'); P(ex + 1, 6, '#ffd23f');
      P(ex, 7, '#3a0d00'); P(ex + 1, 7, '#3a0d00');
      P(ex - 1, 5, '#5e2413'); P(ex + 2, 5, '#5e2413');
    }
    g.fillStyle = '#5e2413'; g.fillRect(0, 14, 16, 2);
  }
  return cv;
}

function makeMobMesh(type) {
  const t = MOB_TYPES[type];
  const tex = new THREE.CanvasTexture(makeMobTexture(type));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(t.w, t.h * 0.62, t.w * 0.9), mat);
  body.position.y = t.h * 0.31;
  const head = new THREE.Mesh(new THREE.BoxGeometry(t.w * 0.7, t.h * 0.45, t.w * 0.45), mat);
  head.position.set(0, t.h * 0.66, t.w * 0.42);
  group.add(body); group.add(head);
  group.position.set(0, -100, 0);
  return { group, mats: [mat] };
}

function spawnMob(type, x, y, z) {
  const t = MOB_TYPES[type];
  const mesh = makeMobMesh(type);
  scene.add(mesh.group);
  mobs.push({
    type, x, y, z, vx: 0, vy: 0, vz: 0,
    hw: t.w / 2, h: t.h, onGround: false,
    yaw: Math.random() * Math.PI * 2, hp: t.hp,
    flashT: 0, thinkT: 0, hopT: Math.random(), atkCd: 0,
    group: mesh.group, mats: mesh.mats
  });
}
function setMobFlash(m, on) {
  for (const mt of m.mats) mt.color.setHex(on ? 0xff5555 : 0xffffff);
}
function removeMob(m) {
  scene.remove(m.group);
  m.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
  const i = mobs.indexOf(m);
  if (i >= 0) mobs.splice(i, 1);
}
function clearMobs() {
  while (mobs.length) removeMob(mobs[0]);
  for (const p of pickups) {
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.map.dispose();
    p.mesh.material.dispose();
  }
  pickups.length = 0;
}

function hitMob(m, dir, dmg) {
  const t = MOB_TYPES[m.type];
  m.hp -= (dmg || 1);
  m.flashT = 0.15;
  setMobFlash(m, true);
  m.vx += dir.x * 6; m.vz += dir.z * 6;
  m.vy = Math.max(m.vy, 3.5);
  m.onGround = false;
  if (m.hp <= 0) {
    spawnPickup(m.x, m.y + 0.5, m.z, t.drop.id, t.drop.count);
    flashHint(t.name + ' defeated!');
    removeMob(m);
  } else {
    flashHint(t.name + ' hit! (' + m.hp + ' left)');
  }
}

function trySpawnMob() {
  if (mobs.length >= MAX_MOBS || !world || !player.pos) return;
  const a = Math.random() * Math.PI * 2;
  const d = 12 + Math.random() * 12;
  const wx = Math.floor(player.pos.x + Math.cos(a) * d);
  const wz = Math.floor(player.pos.z + Math.sin(a) * d);
  let gy = heightAt(wx, wz, world.seed) + 8;
  if (gy >= WORLD_H - 2) return;
  for (; gy > 1; gy--) {
    if (world.getBlock(wx, gy, wz) !== 0) break;
  }
  if (gy <= 1) return;
  if (world.getBlock(wx, gy, wz) !== 1) return; // spawn on grass only
  if (world.getBlock(wx, gy + 1, wz) !== 0 || world.getBlock(wx, gy + 2, wz) !== 0) return;
  spawnMob(Math.random() < 0.6 ? 'skitter' : 'nipper', wx + 0.5, gy + 1.02, wz + 0.5);
}

function updateMob(m, dt) {
  const t = MOB_TYPES[m.type];
  const dx = player.pos.x - m.x, dz = player.pos.z - m.z;
  const dist = Math.hypot(dx, dz);
  let wishX, wishZ, sp;
  if (t.hostile && dist < 14) {
    wishX = dx / (dist || 1); wishZ = dz / (dist || 1); // approach player
    sp = t.speed;
    m.yaw = Math.atan2(wishX, wishZ);
  } else if (!t.hostile && dist < 6 && dist > 0.01) {
    wishX = -dx / dist; wishZ = -dz / dist; // flee
    sp = t.speed * 1.4;
    m.yaw = Math.atan2(wishX, wishZ);
  } else {
    m.thinkT -= dt;
    if (m.thinkT <= 0) {
      m.thinkT = 2 + Math.random() * 3;
      m.yaw = Math.random() * Math.PI * 2;
    }
    wishX = Math.sin(m.yaw); wishZ = Math.cos(m.yaw);
    sp = t.speed * 0.45;
  }
  m.vx = wishX * sp; m.vz = wishZ * sp;

  // hop around; hop higher when blocked so 1-block steps are climbed
  m.hopT -= dt;
  if (m.onGround && m.hopT <= 0) {
    m.vy = 5.5; m.hopT = 0.5 + Math.random() * 0.9; m.onGround = false;
  }
  m.vy -= 22 * dt;
  if (m.vy < -30) m.vy = -30;

  const ox = m.x, oz = m.z;
  stepBody(m, mobSolid, dt);
  const moved = Math.hypot(m.x - ox, m.z - oz);
  const want = Math.hypot(m.vx, m.vz) * dt;
  if (m.onGround && want > 0.01 && moved < want * 0.3) { m.vy = 7.5; m.onGround = false; }

  if (t.hostile) {
    m.atkCd -= dt;
    const dy = Math.abs((m.y + m.h / 2) - (player.pos.y + 0.9));
    if (dist < 1.5 && dy < 1.7 && m.atkCd <= 0) {
      m.atkCd = 1.0;
      damagePlayer(1, m);
    }
  }
  if (dist > 48) { removeMob(m); return; }
  if (m.flashT > 0) {
    m.flashT -= dt;
    if (m.flashT <= 0) setMobFlash(m, false);
  }
  m.group.position.set(m.x, m.y + Math.abs(Math.sin(mobAnimT * 6 + m.x)) * 0.06, m.z);
  m.group.rotation.y = m.yaw;
}

function updateMobs(dt) {
  mobAnimT += dt;
  spawnT -= dt;
  if (spawnT <= 0) { spawnT = 4; trySpawnMob(); }
  for (let i = mobs.length - 1; i >= 0; i--) updateMob(mobs[i], dt);
  updatePickups(dt);
}

/* ---------------- item pickups ---------------- */

function spawnPickup(x, y, z, id, count) {
  const s = 0.35;
  const tex = new THREE.CanvasTexture(tileIcon(atlas.canvas, tileFor(id, 'side'), 32));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(s, s, s),
    new THREE.MeshLambertMaterial({ map: tex }));
  mesh.position.set(x, y, z);
  scene.add(mesh);
  pickups.push({ mesh, id, count, baseY: y, t: Math.random() * 6 });
}
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.t += dt;
    p.mesh.rotation.y += 2.2 * dt;
    p.mesh.position.y = p.baseY + Math.sin(p.t * 3) * 0.12;
    const dx = p.mesh.position.x - player.pos.x;
    const dy = p.mesh.position.y - (player.pos.y + 0.9);
    const dz = p.mesh.position.z - player.pos.z;
    if (dx * dx + dy * dy + dz * dz < 1.7) {
      invAdd(inventory, p.id, p.count);
      refreshHotbarCounts();
      flashHint('Picked up ' + p.count + ' x ' + BLOCKS[p.id].name);
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.map.dispose();
      p.mesh.material.dispose();
      pickups.splice(i, 1);
    }
  }
}

/* ---------------- player health ---------------- */

const MAX_HEALTH = 10;
let health = MAX_HEALTH, dmgCd = 0;

function updateHearts() {
  $('hearts').textContent = '❤'.repeat(health) + '♡'.repeat(MAX_HEALTH - health);
}
function flashDamage() {
  const d = $('dmg');
  d.style.opacity = '0.55';
  clearTimeout(d._t);
  d._t = setTimeout(() => { d.style.opacity = '0'; }, 180);
}
function updateArmorHud() {
  const r = armorReduction(armorSlots);
  const el = $('armor');
  el.classList.toggle('hidden', r <= 0);
  el.textContent = r > 0 ? '🛡 ' + Math.round(r * 100) + '%' : '';
}
function damagePlayer(n, from) {
  if (dmgCd > 0 || !playing || paused || craftingOpen) return;
  dmgCd = 0.6;
  // armor absorbs a flat percent and wears 1 per damage instance
  const res = applyArmorDamage(n, armorSlots);
  for (const b of res.broke) {
    flashHint(ARMOR[b.id].name + ' broke!');
    puffAt(player.pos.x, player.pos.y + 1.2, player.pos.z, 0xffaa33);
  }
  updateArmorHud();
  n = res.dmg;
  health = Math.max(0, health - n);
  updateHearts();
  flashDamage();
  if (from) {
    const dx = player.pos.x - from.x, dz = player.pos.z - from.z;
    const l = Math.hypot(dx, dz) || 1;
    player.vel.x += dx / l * 5;
    player.vel.z += dz / l * 5;
  }
  if (health <= 0) {
    health = MAX_HEALTH;
    updateHearts();
    respawn();
    flashHint('You were nipped! Respawned — inventory kept.');
  }
}

/* ---------------- voxel raycast (Amanatides & Woo DDA) ---------------- */

function raycastVoxel(origin, dir, maxDist) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const sx = dir.x > 0 ? 1 : -1, sy = dir.y > 0 ? 1 : -1, sz = dir.z > 0 ? 1 : -1;
  const tdx = Math.abs(1 / (dir.x || 1e-9)), tdy = Math.abs(1 / (dir.y || 1e-9)), tdz = Math.abs(1 / (dir.z || 1e-9));
  let tmx = (sx > 0 ? (x + 1 - origin.x) : (origin.x - x)) * tdx;
  let tmy = (sy > 0 ? (y + 1 - origin.y) : (origin.y - y)) * tdy;
  let tmz = (sz > 0 ? (z + 1 - origin.z) : (origin.z - z)) * tdz;
  let nx = 0, ny = 0, nz = 0, t = 0;
  for (let i = 0; i < 128; i++) {
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
    else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
    if (t > maxDist) return null;
    if (world.getBlock(x, y, z) !== 0) return { x, y, z, nx, ny, nz };
  }
  return null;
}

function eyePos() {
  return new THREE.Vector3(player.pos.x, player.pos.y + player.EYE, player.pos.z);
}
function lookDir() {
  const d = new THREE.Vector3(0, 0, -1);
  d.applyEuler(new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ'));
  return d;
}

function playerAABBIntersects(bx, by, bz) {
  const p = player.pos;
  return bx + 1 > p.x - player.HW && bx < p.x + player.HW &&
         by + 1 > p.y && by < p.y + player.H &&
         bz + 1 > p.z - player.HW && bz < p.z + player.HW;
}

/* ---------------- mining: hold-to-mine with progress + cracks ---------------- */
// Left click: instant hit on a mob if one is in reach and closer than any
// block (swords deal bonus damage); otherwise hold to mine the targeted
// block. Mining speed depends on block hardness and the selected tool.
// Flying (F) keeps instant-break as a building convenience.

let mining = null; // {x,y,z,id,progress,mouseDown}
let crackMesh = null;
const crackTex = [];

function ensureCrack() {
  if (crackMesh) return;
  for (let s = 0; s < 4; s++) {
    const tex = new THREE.CanvasTexture(drawCrackCanvas(s));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    crackTex.push(tex);
  }
  crackMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.004, 1.004, 1.004),
    new THREE.MeshBasicMaterial({ map: crackTex[0], transparent: true, depthWrite: false }));
  crackMesh.visible = false;
  scene.add(crackMesh);
}
function showCrack(x, y, z, stage) {
  ensureCrack();
  crackMesh.visible = true;
  crackMesh.position.set(x + 0.5, y + 0.5, z + 0.5);
  crackMesh.material.map = crackTex[Math.max(0, Math.min(3, stage))];
  crackMesh.material.needsUpdate = true;
}
function hideCrack() {
  if (crackMesh) crackMesh.visible = false;
}

// Small visual burst when something breaks (no audio system in the game,
// so this is visual-only by design).
const puffs = [];
let puffGeo = null;
function puffAt(x, y, z, color) {
  if (!scene) return;
  if (!puffGeo) puffGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
  for (let i = 0; i < 8 && puffs.length < 60; i++) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const m = new THREE.Mesh(puffGeo, mat);
    m.position.set(x, y, z);
    scene.add(m);
    puffs.push({
      mesh: m,
      vx: (Math.random() - 0.5) * 4, vy: Math.random() * 4 + 1, vz: (Math.random() - 0.5) * 4,
      life: 0.5
    });
  }
}
function updatePuffs(dt) {
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      puffs.splice(i, 1);
      continue;
    }
    p.vy -= 12 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.material.opacity = p.life * 1.8;
  }
}

function breakBlockNow(hit) {
  const id = world.getBlock(hit.x, hit.y, hit.z);
  if (!id) return;
  world.setBlock(hit.x, hit.y, hit.z, 0);
  invAdd(inventory, id, 1);
  const inst = selectedToolInst();
  if (inst && wearTool(inst)) breakSelectedTool();
  refreshHotbarCounts();
  puffAt(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0xbbbbbb);
}

function breakSelectedTool() {
  const inst = selectedToolInst();
  if (!inst) return;
  const nm = TOOLS[inst.id].name;
  const ti = toolbox.indexOf(inst);
  if (ti >= 0) toolbox.splice(ti, 1);
  mining = null;
  hideCrack();
  rebuildHotbar();
  if (selSlot >= hotbarItems.length) selectSlot(0);
  puffAt(player.pos.x, player.pos.y + 1.2, player.pos.z, 0xff5533);
  flashHint(nm + ' broke!');
  refreshHotbarCounts();
  updateSelName();
}

function beginMining(hit) {
  mining = {
    x: hit.x, y: hit.y, z: hit.z,
    id: world.getBlock(hit.x, hit.y, hit.z),
    progress: 0, mouseDown: true
  };
}
function cancelMining() {
  mining = null;
  hideCrack();
}

function updateMining(dt) {
  if (!mining) return;
  if (!mining.mouseDown) { mining = null; hideCrack(); return; }
  const hit = raycastVoxel(eyePos(), lookDir(), 6);
  const id = hit ? world.getBlock(hit.x, hit.y, hit.z) : 0;
  if (!hit || hit.x !== mining.x || hit.y !== mining.y || hit.z !== mining.z ||
      id !== mining.id || id === 0) {
    mining = null;
    hideCrack();
    return;
  }
  mining.progress += dt / mineTime(mining.id, selectedToolId());
  showCrack(mining.x, mining.y, mining.z, Math.min(3, Math.floor(mining.progress * 4)));
  if (mining.progress >= 1) {
    const hx = mining.x, hy = mining.y, hz = mining.z;
    breakBlockNow({ x: hx, y: hy, z: hz });
    // chain into the next block while the button is still held
    const nh = raycastVoxel(eyePos(), lookDir(), 6);
    const nid = nh ? world.getBlock(nh.x, nh.y, nh.z) : 0;
    if (mining && mining.mouseDown && nh && nh.y !== 0 && nid !== 0) beginMining(nh);
    else { mining = null; hideCrack(); }
  }
}

function onAttackStart() {
  // Left click: hit a mob if one is in reach and closer than any block,
  // otherwise (hold to) mine the targeted block.
  const o = eyePos(), d = lookDir();
  let bestMob = null, bestT = 4.5;
  for (let i = 0; i < mobs.length; i++) {
    const m = mobs[i], t = MOB_TYPES[m.type];
    const th = rayHitBox(o.x, o.y, o.z, d.x, d.y, d.z,
      m.x - t.w / 2, m.y, m.z - t.w / 2,
      m.x + t.w / 2, m.y + t.h, m.z + t.w / 2, bestT);
    if (th !== null && th < bestT) { bestT = th; bestMob = m; }
  }
  const hit = raycastVoxel(o, d, 6);
  let blockT = Infinity;
  if (hit) {
    const dx = hit.x + 0.5 - o.x, dy = hit.y + 0.5 - o.y, dz = hit.z + 0.5 - o.z;
    blockT = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  if (bestMob && bestT <= blockT) {
    const inst = selectedToolInst();
    const tid = inst ? inst.id : 0;
    hitMob(bestMob, d, toolDamage(tid));
    // swords wear per mob hit
    if (inst && TOOLS[tid].type === 'sword') {
      if (wearTool(inst)) breakSelectedTool();
      else refreshHotbarCounts();
    }
    return;
  }
  if (!hit) return;
  if (hit.y === 0) { flashHint('Bedrock layer cannot be broken'); return; } // y=0 unbreakable
  if (player.fly) { breakBlockNow(hit); return; } // instant-break while flying
  beginMining(hit);
}

function placeBlock() {
  const hit = raycastVoxel(eyePos(), lookDir(), 6);
  if (!hit) return;
  // Right-clicking a crafting table opens its 3x3 grid instead of placing.
  if (world.getBlock(hit.x, hit.y, hit.z) === 13) { openCrafting(3); return; }
  const bx = hit.x + hit.nx, by = hit.y + hit.ny, bz = hit.z + hit.nz;
  if (by < 0 || by >= WORLD_H) return;
  if (world.getBlock(bx, by, bz) !== 0) return;
  if (playerAABBIntersects(bx, by, bz)) return; // don't place inside player
  const s = selectedItem();
  if (!s || s.kind !== 'block') return; // tools can't place
  const id = s.id;
  if (!invTake(inventory, id, 1)) {
    flashHint('No ' + BLOCKS[id].name + ' left — break blocks to collect');
    return;
  }
  world.setBlock(bx, by, bz, id);
  refreshHotbarCounts();
}

/* ---------------- input ---------------- */

const canvas = document.createElement('canvas');
let locked = false;

function bindInput() {
  document.addEventListener('keydown', (e) => {
    if (e.code === 'F3') { e.preventDefault(); toggleDebug(); return; }
    keys[e.code] = true;
    if (!playing || paused) return;
    if (craftingOpen) {
      if (e.code === 'Escape') closeCrafting();
      return;
    }
    if (e.code === 'KeyF' && !e.repeat) {
      player.fly = !player.fly;
      player.vel.set(0, 0, 0);
      flashHint(player.fly ? 'Fly: ON' : 'Fly: OFF');
    }
    if (e.code === 'KeyH' && !e.repeat) toggleHelp();
    if (e.code === 'KeyE' && !e.repeat) { openCrafting(2); return; }
    if (/^Digit[0-9]$/.test(e.code)) {
      const n = +e.code.slice(5);
      selectSlot(n === 0 ? 9 : n - 1);
    }
    if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  });
  document.addEventListener('keyup', (e) => { keys[e.code] = false; });

  document.addEventListener('mousemove', (e) => {
    if (!locked || !playing) return;
    player.yaw -= e.movementX * 0.0026;
    player.pitch -= e.movementY * 0.0026;
    player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch));
  });

  document.addEventListener('mousedown', (e) => {
    if (!playing || paused || craftingOpen) return;
    if (!locked) { lockPointer(); return; }
    if (e.button === 0) onAttackStart();
    else if (e.button === 2) placeBlock();
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0 && mining) mining.mouseDown = false;
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('wheel', (e) => {
    if (!playing || paused || craftingOpen || !hotbarItems.length) return;
    selectSlot((selSlot + (e.deltaY > 0 ? 1 : hotbarItems.length - 1)) % hotbarItems.length);
  }, { passive: true });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    // Unlocking to use the crafting UI must not trigger the pause menu.
    if (!locked && playing && !paused && !craftingOpen) showPause();
  });
  document.addEventListener('pointerlockerror', () => {
    flashHint('Click the game to capture the mouse');
  });

  canvas.addEventListener('click', () => { if (playing && !paused && !locked) lockPointer(); });
}

function lockPointer() {
  // Re-locking too fast after Esc is rejected by the browser; hint instead of erroring.
  try {
    const r = canvas.requestPointerLock();
    if (r && r.catch) r.catch(() => flashHint('Click again to capture the mouse'));
  } catch (e) { /* ignore */ }
}

/* ---------------- UI: hotbar, hints, debug ---------------- */

const HOTBAR_BLOCKS = [1, 2, 3, 6, 4, 5, 7, 8, 9, 10, 11, 12, 13];
let selSlot = 0;
let atlas = null;

// Survival-lite inventory: block id -> count. Breaking blocks adds;
// placing blocks consumes. New worlds start with a small starter kit.
let inventory = {};
// Gear: non-stackable instances {id, dur}. Tools live in the toolbox and get
// their own hotbar slots; armor is worn in 4 dedicated slots or kept in stash.
let toolbox = [];
let armorStash = [];
let armorSlots = [null, null, null, null]; // helm, chest, legs, boots
const hotbarSlots = []; // slot divs, parallel to hotbarItems
let hotbarItems = [];   // {kind:'block',id} | {kind:'tool',tool}

function selectedItem() {
  return hotbarItems[selSlot] || null;
}
function selectedToolInst() {
  const s = selectedItem();
  return (s && s.kind === 'tool') ? s.tool : null;
}
function selectedToolId() {
  const t = selectedToolInst();
  return t ? t.id : 0;
}

function rebuildHotbar() {
  const keep = selectedItem();
  hotbarItems = HOTBAR_BLOCKS.map((id) => ({ kind: 'block', id }));
  for (const t of toolbox) hotbarItems.push({ kind: 'tool', tool: t });
  // try to keep the same selection by identity
  let idx = 0;
  if (keep) {
    if (keep.kind === 'block') idx = hotbarItems.findIndex((s) => s.kind === 'block' && s.id === keep.id);
    else idx = hotbarItems.findIndex((s) => s.kind === 'tool' && s.tool === keep.tool);
  }
  selSlot = idx >= 0 ? idx : 0;
  buildHotbar();
}

function durColor(frac) {
  return frac > 0.5 ? '#7dd956' : frac > 0.25 ? '#e8c83c' : '#e33f3f';
}

function buildHotbar() {
  const bar = document.getElementById('hotbar');
  bar.innerHTML = '';
  hotbarSlots.length = 0;
  hotbarItems.forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'slot' + (i === selSlot ? ' sel' : '');
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = i < 10 ? ((i + 1) % 10) : '';
    d.appendChild(key);
    if (s.kind === 'block') {
      d.appendChild(tileIcon(atlas.canvas, tileFor(s.id, 'side'), 48));
      const cnt = document.createElement('span');
      cnt.className = 'count';
      d.appendChild(cnt);
      d._count = cnt;
      d.title = BLOCKS[s.id].name;
    } else {
      const t = TOOLS[s.tool.id];
      d.appendChild(itemIcon(s.tool.id, 48));
      const barEl = document.createElement('div');
      barEl.className = 'durbar';
      const fill = document.createElement('div');
      fill.className = 'durfill';
      barEl.appendChild(fill);
      d.appendChild(barEl);
      d._durfill = fill;
      d.title = t.name;
    }
    d.addEventListener('click', () => selectSlot(i));
    bar.appendChild(d);
    hotbarSlots.push(d);
  });
  refreshHotbarCounts();
  updateSelName();
}
function refreshHotbarCounts() {
  for (let i = 0; i < hotbarSlots.length; i++) {
    const d = hotbarSlots[i], s = hotbarItems[i];
    if (!s) continue;
    if (s.kind === 'block') {
      const c = inventory[s.id] || 0;
      d._count.textContent = c > 0 ? String(c) : '';
      d.classList.toggle('empty', c <= 0);
    } else {
      const t = TOOLS[s.tool.id];
      const frac = Math.max(0, s.tool.dur / t.maxDur);
      d._durfill.style.width = (frac * 100).toFixed(1) + '%';
      d._durfill.style.background = durColor(frac);
      d.title = t.name + ' (' + s.tool.dur + '/' + t.maxDur + ')';
    }
  }
}
function selectSlot(i) {
  if (i < 0 || i >= hotbarItems.length) return;
  selSlot = i;
  for (let j = 0; j < hotbarSlots.length; j++)
    hotbarSlots[j].classList.toggle('sel', j === i);
  updateSelName();
}
function updateSelName() {
  const s = selectedItem();
  let name = '';
  if (s) {
    if (s.kind === 'block') name = BLOCKS[s.id].name;
    else {
      const t = TOOLS[s.tool.id];
      name = t.name + '  ' + s.tool.dur + '/' + t.maxDur;
    }
  }
  document.getElementById('selname').textContent = name;
}

let hintTimer = 0;
function flashHint(text) {
  const h = document.getElementById('hint');
  h.textContent = text;
  h.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.add('hidden'), 2200);
}

let showDbg = false, fpsFrames = 0, fpsTime = 0, fps = 0;
function toggleDebug() {
  showDbg = !showDbg;
  document.getElementById('debug').classList.toggle('hidden', !showDbg);
}
function updateDebug() {
  if (!showDbg || !playing) return;
  const p = player.pos;
  document.getElementById('debug').textContent =
    'AeonCraft MVP\n' +
    'XYZ: ' + p.x.toFixed(1) + ' / ' + p.y.toFixed(1) + ' / ' + p.z.toFixed(1) + '\n' +
    'FPS: ' + fps + '  chunks: ' + world.chunks.size +
    '  dirty: ' + world.dirty.size + '\n' +
    'fly: ' + (player.fly ? 'on' : 'off') + '  seed: ' + worldSeed;
}

/* ---------------- crafting UI ---------------- */

let craftingOpen = false, craftSize = 2;
let craftCells = [], craftCellEls = [], heldId = 0;

function openCrafting(size) {
  if (!playing || paused) return;
  cancelMining();
  if (craftingOpen && size === craftSize) return;
  if (craftingOpen) clearCraftGrid(true);
  craftSize = size;
  craftingOpen = true;
  if (document.exitPointerLock) document.exitPointerLock();
  $('craft-title').textContent = size === 3 ? 'Crafting Table' : 'Crafting (2x2)';
  buildCraftGrid();
  refreshCraftUI();
  show($('craft'));
}
function closeCrafting() {
  if (!craftingOpen) return;
  clearCraftGrid(true);
  craftingOpen = false;
  hide($('craft'));
  refreshHotbarCounts();
  lockPointer();
}
function buildCraftGrid() {
  const g = $('craft-grid');
  g.innerHTML = '';
  g.style.gridTemplateColumns = 'repeat(' + craftSize + ', 56px)';
  craftCells = new Array(craftSize * craftSize).fill(0);
  craftCellEls = [];
  heldId = 0;
  for (let i = 0; i < craftCells.length; i++) {
    const d = document.createElement('div');
    d.className = 'cslot';
    const idx = i;
    d.addEventListener('click', () => clickCraftCell(idx));
    g.appendChild(d);
    craftCellEls.push(d);
  }
}
function renderCraftGrid() {
  for (let i = 0; i < craftCells.length; i++) {
    const d = craftCellEls[i];
    d.innerHTML = '';
    if (craftCells[i]) d.appendChild(tileIcon(atlas.canvas, tileFor(craftCells[i], 'side'), 48));
  }
}
// Click an inventory item to hold it, then click grid cells to place one each.
// Clicking a filled cell returns its item to the inventory.
function clickCraftCell(i) {
  if (craftCells[i] === 0 && heldId && (inventory[heldId] || 0) > 0) {
    invTake(inventory, heldId, 1);
    craftCells[i] = heldId;
  } else if (craftCells[i] !== 0) {
    invAdd(inventory, craftCells[i], 1);
    craftCells[i] = 0;
  }
  refreshCraftUI();
}
function clearCraftGrid(returnItems) {
  if (returnItems) for (const id of craftCells) if (id) invAdd(inventory, id, 1);
  craftCells.fill(0);
  heldId = 0;
}
function refreshCraftUI() {
  renderCraftGrid();
  const inv = $('craft-inv');
  inv.innerHTML = '';
  for (let id = 1; id <= MAX_BLOCK_ID; id++) {
    const c = inventory[id] || 0;
    const b = document.createElement('button');
    b.className = 'pal' + (c ? '' : ' zero') + (id === heldId ? ' heldsel' : '');
    b.appendChild(tileIcon(atlas.canvas, tileFor(id, 'side'), 40));
    const s = document.createElement('span');
    s.textContent = c;
    b.appendChild(s);
    b.title = BLOCKS[id].name;
    const pick = id;
    b.addEventListener('click', () => {
      heldId = (inventory[pick] || 0) > 0 ? pick : 0;
      refreshCraftUI();
    });
    inv.appendChild(b);
  }
  $('craft-held').textContent = heldId
    ? 'Holding: ' + BLOCKS[heldId].name + ' — click a grid cell to place'
    : 'Holding: none — click an item above';
  const out = matchRecipe(craftCells, craftSize);
  const r = $('craft-result');
  r.innerHTML = '';
  r.classList.toggle('ready', !!out);
  if (out) {
    r.appendChild(itemIcon(out.id, 48));
    const s = document.createElement('span');
    s.className = 'rcount';
    s.textContent = 'x' + out.count;
    r.appendChild(s);
    r.title = out.id <= MAX_BLOCK_ID ? BLOCKS[out.id].name
      : TOOLS[out.id] ? TOOLS[out.id].name : ARMOR[out.id].name;
  }
  renderGearUI();
}

// ---- gear section of the crafting overlay ----
function durBarEl(dur, max) {
  const bar = document.createElement('div');
  bar.className = 'durbar';
  const fill = document.createElement('div');
  fill.className = 'durfill';
  const frac = Math.max(0, dur / max);
  fill.style.width = (frac * 100).toFixed(1) + '%';
  fill.style.background = durColor(frac);
  bar.appendChild(fill);
  return bar;
}

function renderGearUI() {
  // equipped armor slots
  const ar = $('armor-slots');
  ar.innerHTML = '';
  ARMOR_SLOTS.forEach((slotName, si) => {
    const d = document.createElement('div');
    d.className = 'aslot' + (armorSlots[si] ? ' filled' : '');
    d.title = slotName;
    const lab = document.createElement('span');
    lab.className = 'alab';
    lab.textContent = slotName;
    d.appendChild(lab);
    const p = armorSlots[si];
    if (p) {
      const a = ARMOR[p.id];
      d.appendChild(itemIcon(p.id, 40));
      d.appendChild(durBarEl(p.dur, a.maxDur));
      d.title = a.name + ' (' + p.dur + '/' + a.maxDur + ')';
      d.addEventListener('click', () => unequipArmor(si));
    }
    ar.appendChild(d);
  });
  $('armor-val').textContent = 'Protection: ' + Math.round(armorReduction(armorSlots) * 100) + '%';

  // tools + armor stash list
  const gl = $('gear-list');
  gl.innerHTML = '';
  const addRow = (inst, label, onClick) => {
    const b = document.createElement('button');
    b.className = 'gear';
    b.appendChild(itemIcon(inst.id, 40));
    const tx = document.createElement('span');
    tx.className = 'gname';
    tx.textContent = label;
    b.appendChild(tx);
    const max = TOOLS[inst.id] ? TOOLS[inst.id].maxDur : ARMOR[inst.id].maxDur;
    b.appendChild(durBarEl(inst.dur, max));
    if (onClick) b.addEventListener('click', onClick);
    else b.disabled = true;
    gl.appendChild(b);
  };
  for (const t of toolbox) addRow(t, TOOLS[t.id].name + '  ' + t.dur + '/' + TOOLS[t.id].maxDur, null);
  armorStash.forEach((p, i) => {
    const a = ARMOR[p.id];
    addRow(p, a.name + '  ' + p.dur + '/' + a.maxDur + ' — click to equip', () => equipArmor(i));
  });
  if (!toolbox.length && !armorStash.length) {
    const e = document.createElement('div');
    e.className = 'gear-empty';
    e.textContent = 'No tools or armor yet — craft them at a Crafting Table.';
    gl.appendChild(e);
  }
}

function equipArmor(stashIdx) {
  const piece = armorStash[stashIdx];
  if (!piece || !ARMOR[piece.id]) return;
  const si = ARMOR_SLOTS.indexOf(ARMOR[piece.id].slot);
  const old = armorSlots[si];
  armorSlots[si] = piece;
  armorStash.splice(stashIdx, 1);
  if (old) armorStash.push(old);
  refreshCraftUI();
  updateArmorHud();
  flashHint(ARMOR[piece.id].name + ' equipped');
}
function unequipArmor(si) {
  const p = armorSlots[si];
  if (!p) return;
  armorSlots[si] = null;
  armorStash.push(p);
  refreshCraftUI();
  updateArmorHud();
}
function takeCraftResult() {
  const out = matchRecipe(craftCells, craftSize);
  if (!out) return;
  craftCells.fill(0);
  if (TOOLS[out.id]) {
    const inst = { id: out.id, dur: TOOLS[out.id].maxDur };
    toolbox.push(inst);
    rebuildHotbar();
    refreshHotbarCounts();
    flashHint('Crafted ' + TOOLS[out.id].name + ' — added to the hotbar');
  } else if (ARMOR[out.id]) {
    armorStash.push({ id: out.id, dur: ARMOR[out.id].maxDur });
    flashHint('Crafted ' + ARMOR[out.id].name + ' — equip it below');
  } else {
    invAdd(inventory, out.id, out.count);
    flashHint('Crafted ' + out.count + ' x ' + BLOCKS[out.id].name);
  }
  heldId = 0;
  refreshCraftUI();
}

/* ---------------- save / load ---------------- */

let worldName = 'world', worldSeed = 1;
let pendingDiffs = [], pendingPlayer = null, pendingInventory = null, pendingHealth = null;
let pendingTools = null, pendingArmorStash = null, pendingArmorSlots = null;

// gear instances are plain {id, dur} — JSON-safe. Validate on load.
function validGearList(list, table) {
  if (!Array.isArray(list)) return [];
  return list.filter((g) => g && table[g.id] && typeof g.dur === 'number' && g.dur > 0)
             .map((g) => ({ id: g.id, dur: Math.min(table[g.id].maxDur, g.dur | 0) }));
}

function collectSave() {
  const diffs = [];
  for (const [k, id] of world.diffs) {
    const p = k.split(',');
    diffs.push([+p[0], +p[1], +p[2], id]);
  }
  return JSON.stringify({
    app: 'aeoncraft', version: 3, name: worldName, seed: worldSeed,
    player: { x: +player.pos.x.toFixed(2), y: +player.pos.y.toFixed(2), z: +player.pos.z.toFixed(2),
              yaw: +player.yaw.toFixed(3), pitch: +player.pitch.toFixed(3), fly: player.fly },
    inventory, health, diffs,
    tools: toolbox, armorStash, armorSlots
  });
}
function storageKey(name) { return 'aeoncraft_save_' + name; }
function saveToStorage() {
  if (!playing || !world) return;
  try { localStorage.setItem(storageKey(worldName), collectSave()); } catch (e) { /* ignore */ }
}
function loadFromStorage(name) {
  try {
    const s = localStorage.getItem(storageKey(name));
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}
function validSave(s) {
  return s && s.app === 'aeoncraft' && typeof s.seed === 'number' && Array.isArray(s.diffs);
}

async function exportWorld() {
  if (!window.aeoncraft) { flashHint('Export needs the desktop app'); return; }
  const r = await window.aeoncraft.saveWorldFile(worldName, collectSave());
  document.getElementById('pause-msg').textContent =
    r.ok ? 'Exported.' : (r.canceled ? '' : 'Export failed: ' + (r.error || 'unknown'));
}
async function importWorld() {
  if (!window.aeoncraft) { flashHint('Import needs the desktop app'); return; }
  const r = await window.aeoncraft.openWorldFile();
  if (!r.ok) return;
  try {
    const s = JSON.parse(r.json);
    if (!validSave(s)) { flashHint('Not a valid AeonCraft world file'); return; }
    applySave(s);
  } catch (e) { flashHint('Could not read world file'); }
}
function applySave(s) {
  pendingDiffs = s.diffs || [];
  pendingPlayer = s.player || null;
  pendingInventory = s.inventory || null;
  pendingHealth = (typeof s.health === 'number') ? s.health : null;
  // v3 gear; v1/v2 saves simply have none
  pendingTools = validGearList(s.tools, TOOLS);
  pendingArmorStash = validGearList(s.armorStash, ARMOR);
  const worn = Array.isArray(s.armorSlots) ? s.armorSlots : [];
  pendingArmorSlots = [null, null, null, null];
  for (const g of validGearList(worn, ARMOR)) {
    const si = ARMOR_SLOTS.indexOf(ARMOR[g.id].slot);
    if (!pendingArmorSlots[si]) pendingArmorSlots[si] = g;
    else pendingArmorStash.push(g);
  }
  startWorld(s.name || 'world', s.seed | 0);
}

/* ---------------- screens ---------------- */

let playing = false, paused = false;
const $ = (id) => document.getElementById(id);

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showPause() {
  if (!playing || paused) return;
  paused = true;
  cancelMining();
  saveToStorage();
  $('pause-msg').textContent = '';
  hide($('help'));
  show($('pause'));
}
function resumeGame() {
  hide($('pause'));
  paused = false;
  lockPointer();
}
function toggleHelp() {
  if (!playing) return;
  $('help').classList.toggle('hidden');
}

function parseSeed(str) {
  str = (str || '').trim();
  if (/^-?\d+$/.test(str)) return parseInt(str, 10) | 0;
  if (!str) return (Math.random() * 1e9) | 0;
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h;
}

/* ---------------- renderer / scene ---------------- */

let renderer = null, scene = null, camera = null;
let matOpaque = null, matGlass = null;

function ensureGL() {
  if (renderer) return true;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    $('title').innerHTML = '<div class="panel"><h2>WebGL unavailable</h2>' +
      '<p>AeonCraft needs WebGL. Try updating your graphics drivers.</p></div>';
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  atlas = paintAtlas();
  matOpaque = new THREE.MeshLambertMaterial({ map: atlas.texture });
  matGlass = new THREE.MeshLambertMaterial({ map: atlas.texture, transparent: true, depthWrite: false });

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5e0);
  scene.fog = new THREE.Fog(0x87b5e0, 45, RENDER_DIST * 16 + 40);
  scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x6b5b43, 0.95));
  const sun = new THREE.DirectionalLight(0xfff2d8, 0.75);
  sun.position.set(60, 100, 30);
  scene.add(sun);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.rotation.order = 'YXZ';

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  rebuildHotbar();
  return true;
}

/* ---------------- game flow ---------------- */

function startWorld(name, seed) {
  if (!ensureGL()) return;
  worldName = (name || 'world').slice(0, 40) || 'world';
  worldSeed = seed | 0;

  if (world) {
    for (const k of [...world.chunks.keys()]) world.unloadChunk(k);
  }
  world = new World(scene, worldSeed, matOpaque, matGlass);
  world.diffs = new Map(pendingDiffs.map((d) => [d[0] + ',' + d[1] + ',' + d[2], d[3]]));
  const fresh = pendingDiffs.length === 0 && !pendingPlayer;
  pendingDiffs = [];

  // Inventory: fresh worlds get a small starter kit; loaded worlds restore theirs.
  inventory = pendingInventory || (fresh ? { 7: 8, 10: 4 } : {});
  pendingInventory = null;
  health = pendingHealth != null ? Math.max(1, Math.min(MAX_HEALTH, pendingHealth | 0)) : MAX_HEALTH;
  pendingHealth = null;
  // Gear (v3 saves; older saves start empty-handed).
  toolbox = pendingTools || [];
  armorStash = pendingArmorStash || [];
  armorSlots = pendingArmorSlots || [null, null, null, null];
  pendingTools = pendingArmorStash = pendingArmorSlots = null;
  clearMobs();
  spawnT = 6;

  player.pos = new THREE.Vector3(8.5, 40, 8.5);
  player.vel = new THREE.Vector3();
  if (pendingPlayer) {
    player.pos.set(pendingPlayer.x, pendingPlayer.y, pendingPlayer.z);
    player.yaw = pendingPlayer.yaw || 0;
    player.pitch = pendingPlayer.pitch || 0;
    player.fly = !!pendingPlayer.fly;
  } else {
    const h = heightAt(8, 8, worldSeed);
    player.pos.set(8.5, h + 1.02, 8.5);
    player.yaw = 0; player.pitch = 0; player.fly = false;
  }
  pendingPlayer = null;

  // pre-generate spawn chunks so the player doesn't fall into the void
  const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
    world.ensureChunk(pcx + dx, pcz + dz);
  world.genQueue.length = 0;
  for (const k of [...world.dirty]) { world.dirty.delete(k); world.remesh(k); }

  // safety: if spawn is inside a block, lift up
  let guard = 0;
  while (solidAt(Math.floor(player.pos.x), Math.floor(player.pos.y), Math.floor(player.pos.z)) && guard++ < 40)
    player.pos.y += 1;

  hide($('title')); hide($('pause')); hide($('help'));
  show($('hud'));
  playing = true; paused = false; craftingOpen = false;
  rebuildHotbar();
  selectSlot(0);
  refreshHotbarCounts();
  updateHearts();
  updateArmorHud();
  lockPointer();
  flashHint('WASD move · Hold left-click to mine · Right-click place · E craft · H for help');
}

function quitToTitle() {
  saveToStorage();
  clearMobs();
  cancelMining();
  if (craftingOpen) { craftingOpen = false; hide($('craft')); }
  if (world) for (const k of [...world.chunks.keys()]) world.unloadChunk(k);
  world = null;
  playing = false; paused = false;
  if (document.exitPointerLock) document.exitPointerLock();
  hide($('pause')); hide($('hud')); hide($('help'));
  show($('title'));
}

/* ---------------- main loop ---------------- */

let lastT = 0, autosaveT = 0;
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;

  fpsFrames++; fpsTime += dt;
  if (fpsTime >= 1) { fps = fpsFrames; fpsFrames = 0; fpsTime = 0; }

  if (playing && !paused && !craftingOpen && world) {
    stepPlayer(dt);
    updateMobs(dt);
    updateMining(dt);
    updatePuffs(dt);
    if (dmgCd > 0) dmgCd -= dt;
    const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
    world.update(pcx, pcz);
    camera.position.set(player.pos.x, player.pos.y + player.EYE, player.pos.z);
    camera.rotation.set(player.pitch, player.yaw, 0);
    renderer.render(scene, camera);
    updateDebug();
    autosaveT += dt;
    if (autosaveT > 20) { autosaveT = 0; saveToStorage(); }
  }
}

/* ---------------- boot ---------------- */

function boot() {
  $('game').appendChild(canvas);
  bindInput();

  $('btn-play').addEventListener('click', () => {
    const name = ($('world-name').value || 'My World').trim();
    startWorld(name, parseSeed($('world-seed').value));
  });
  $('world-seed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-play').click();
    e.stopPropagation();
  });
  $('world-name').addEventListener('keydown', (e) => e.stopPropagation());

  $('btn-import-title').addEventListener('click', importWorld);
  $('btn-resume').addEventListener('click', resumeGame);
  $('btn-save').addEventListener('click', () => {
    saveToStorage();
    $('pause-msg').textContent = 'Saved.';
  });
  $('btn-export').addEventListener('click', exportWorld);
  $('btn-import').addEventListener('click', importWorld);
  $('btn-quit').addEventListener('click', quitToTitle);
  $('btn-help-close').addEventListener('click', () => hide($('help')));

  $('craft-result').addEventListener('click', takeCraftResult);
  $('btn-craft-clear').addEventListener('click', () => { clearCraftGrid(true); refreshCraftUI(); });
  $('btn-craft-close').addEventListener('click', closeCrafting);

  requestAnimationFrame(loop);
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', boot);
else
  boot();

})();
