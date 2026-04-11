/**
 * investigate24.mjs — Deep analysis of markerless Parasolid encoding (ctc_03)
 *
 * The markerless files have NO exact-match for vertex coordinates at any scale.
 * Strategy:
 *   1. Search for DIRECTION vectors (unit length, scale-independent)
 *   2. Try float32 instead of float64
 *   3. Try Little Endian float64
 *   4. Analyze actual float64 BE values in the data area
 *   5. See if computed vertex coords match with tolerance
 * 
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');

const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
function isParasolid(buf) {
    if (buf.length < 20 || buf[0] !== 0x50 || buf[1] !== 0x53) return false;
    return buf.indexOf('TRANSMIT', 0, 'ascii') >= 0 && buf.indexOf('TRANSMIT', 0, 'ascii') < 32;
}
function getLargestPS(filePath) {
    const buf = readFileSync(filePath);
    let best = null, idx = 0;
    while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
        if (idx + 26 > buf.length) break;
        const cs = buf.readUInt32LE(idx + 14), ds = buf.readUInt32LE(idx + 18), nl = buf.readUInt32LE(idx + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50_000_000) {
            const po = idx + 26 + nl, pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const nested = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (isParasolid(nested) && (!best || nested.length > best.length)) best = nested;
                        } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

function float64BEbytes(val) {
    const b = Buffer.alloc(8); b.writeDoubleBE(val); return b;
}
function float64LEbytes(val) {
    const b = Buffer.alloc(8); b.writeDoubleLE(val); return b;
}
function float32BEbytes(val) {
    const b = Buffer.alloc(4); b.writeFloatBE(val); return b;
}

function parseStepDirections(filePath) {
    const text = readFileSync(filePath, 'utf8');
    const joined = text.replace(/\r\n/g, '\n').replace(/\n(?!#)/g, '');
    const dirs = [];
    const re = /#(\d+)\s*=\s*DIRECTION\s*\('[^']*'\s*,\s*\(([^)]+)\)\s*\)\s*;/g;
    let m;
    while ((m = re.exec(joined)) !== null) {
        const vals = m[2].split(',').map(Number);
        if (vals.length >= 3 && vals.every(isFinite)) {
            dirs.push({ id: parseInt(m[1]), dx: vals[0], dy: vals[1], dz: vals[2] });
        }
    }
    return dirs;
}

function parseStepVertexCoords(filePath) {
    const text = readFileSync(filePath, 'utf8');
    const joined = text.replace(/\r\n/g, '\n').replace(/\n(?!#)/g, '');
    const entities = new Map();
    const re = /#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([^;]*)\)\s*;/g;
    let mm;
    while ((mm = re.exec(joined)) !== null) {
        entities.set(parseInt(mm[1]), { type: mm[2], args: mm[3].trim() });
    }

    const points = new Map();
    for (const [id, ent] of entities) {
        if (ent.type === 'CARTESIAN_POINT') {
            const match = ent.args.match(/\(([^)]+)\)/);
            if (match) {
                const c = match[1].split(',').map(Number);
                if (c.length >= 3 && c.every(isFinite)) points.set(id, { x: c[0], y: c[1], z: c[2] });
            }
        }
    }

    const vertices = [];
    for (const [id, ent] of entities) {
        if (ent.type === 'VERTEX_POINT') {
            const refs = [...ent.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
            const pt = points.get(refs[refs.length - 1]);
            if (pt) vertices.push({ id, ...pt });
        }
    }
    return { vertices, points, entities };
}

// ── Test ctc_03 (markerless) ────────────────────────────────────────────────

const ps03 = getLargestPS(join(sldDir, 'nist_ctc_03_asme1_rc_sw1802.SLDPRT'));
const dirs03 = parseStepDirections(join(stpDir, 'CTC Definitions', 'nist_ctc_03_asme1_rc.stp'));
const step03 = parseStepVertexCoords(join(stpDir, 'CTC Definitions', 'nist_ctc_03_asme1_rc.stp'));

console.log(`PS buffer: ${ps03.length} bytes`);
console.log(`STEP directions: ${dirs03.length}`);
console.log(`STEP vertices: ${step03.vertices.length}\n`);

// ── 1. Search for DIRECTION vectors as float64 BE triplets ──────────────────

console.log('=== DIRECTION VECTOR SEARCH (float64 BE) ===\n');
let foundDirs = 0;
for (const d of dirs03.slice(0, 30)) {
    const xNeedle = float64BEbytes(d.dx);
    let idx = 0;
    while ((idx = ps03.indexOf(xNeedle, idx)) >= 0) {
        if (idx + 24 <= ps03.length) {
            const y = ps03.readDoubleBE(idx + 8);
            const z = ps03.readDoubleBE(idx + 16);
            if (Math.abs(y - d.dy) < 1e-10 && Math.abs(z - d.dz) < 1e-10) {
                foundDirs++;
                console.log(`  DIR #${d.id} (${d.dx.toFixed(6)}, ${d.dy.toFixed(6)}, ${d.dz.toFixed(6)}) → PS @0x${idx.toString(16)}`);
                break;
            }
        }
        idx++;
    }
}
console.log(`\n  Found: ${foundDirs} / ${Math.min(30, dirs03.length)}\n`);

// ── 2. Search for DIRECTION vectors as float64 LE ───────────────────────────

console.log('=== DIRECTION VECTOR SEARCH (float64 LE) ===\n');
let foundDirsLE = 0;
for (const d of dirs03.slice(0, 30)) {
    const xNeedle = float64LEbytes(d.dx);
    let idx = 0;
    while ((idx = ps03.indexOf(xNeedle, idx)) >= 0) {
        if (idx + 24 <= ps03.length) {
            const y = ps03.readDoubleLE(idx + 8);
            const z = ps03.readDoubleLE(idx + 16);
            if (Math.abs(y - d.dy) < 1e-10 && Math.abs(z - d.dz) < 1e-10) {
                foundDirsLE++;
                console.log(`  DIR #${d.id} (${d.dx.toFixed(6)}, ${d.dy.toFixed(6)}, ${d.dz.toFixed(6)}) → PS @0x${idx.toString(16)}`);
                break;
            }
        }
        idx++;
    }
}
console.log(`\n  Found: ${foundDirsLE} / ${Math.min(30, dirs03.length)}\n`);

// ── 3. Search for DIRECTION vectors as float32 BE ───────────────────────────

console.log('=== DIRECTION VECTOR SEARCH (float32 BE) ===\n');
let foundDirs32 = 0;
for (const d of dirs03.slice(0, 30)) {
    const xNeedle = float32BEbytes(d.dx);
    let idx = 0;
    while ((idx = ps03.indexOf(xNeedle, idx)) >= 0) {
        if (idx + 12 <= ps03.length) {
            const y = ps03.readFloatBE(idx + 4);
            const z = ps03.readFloatBE(idx + 8);
            if (Math.abs(y - d.dy) < 0.001 && Math.abs(z - d.dz) < 0.001) {
                foundDirs32++;
                console.log(`  DIR #${d.id} (${d.dx.toFixed(6)}, ${d.dy.toFixed(6)}, ${d.dz.toFixed(6)}) → PS @0x${idx.toString(16)} (f32)`);
                break;
            }
        }
        idx++;
    }
}
console.log(`\n  Found: ${foundDirs32} / ${Math.min(30, dirs03.length)}\n`);

// ── 4. Search vertex coords with tolerance (fuzzy match) ────────────────────

console.log('=== FUZZY VERTEX SEARCH (float64 BE, tolerance=0.001) ===\n');

// Read ALL float64 BE values from data area
const dataStart = 0x400;
const allBEvals = [];
for (let i = dataStart; i + 8 <= ps03.length; i += 8) {
    const v = ps03.readDoubleBE(i);
    if (isFinite(v) && Math.abs(v) < 1e4) {
        allBEvals.push({ val: v, off: i });
    }
}
console.log(`  Total valid float64 BE values (8-aligned): ${allBEvals.length}`);

// For each scale factor, count how many STEP vertex x-values have a near-match
for (const [label, scale] of [
    ['÷1 (mm)', 1], ['÷1000 (m)', 1000], ['÷25.4 (in)', 25.4], ['÷25400 (m-from-in)', 25400]
]) {
    let matched = 0;
    for (const v of step03.vertices) {
        const target = v.x / scale;
        const found = allBEvals.some(bv => Math.abs(bv.val - target) < 0.001);
        if (found) matched++;
    }
    console.log(`  ${label}: ${matched} / ${step03.vertices.length} vertex x-coords have near-match`);
}

// ── 5. Dump unique float64 BE values in a range that looks like coordinates ──

console.log('\n=== UNIQUE FLOAT64 BE VALUES IN DATA AREA ===\n');
// Focus on values in a range that could be mm coordinates for ctc_03
// ctc_03 STEP range: X: [-9.825, 2.102], Y: [-0, 19.112], Z: [0, 6.405]
// In meters: X[-0.009825, 0.002102], Y[0, 0.019112], Z[0, 0.006405]
// In inches: X[-0.3868, 0.0828], Y[0, 0.7525], Z[0, 0.2522]

const uniqVals = new Map(); // value → [offsets]
for (const { val, off } of allBEvals) {
    if (Math.abs(val) > 0.0001 && Math.abs(val) < 1.0) {
        const key = val.toFixed(8);
        if (!uniqVals.has(key)) uniqVals.set(key, []);
        uniqVals.get(key).push(off);
    }
}

const sorted = [...uniqVals.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
console.log(`  Values in range [0.0001, 1.0]: ${sorted.length} unique`);
console.log(`  First 50 (ascending):`);
for (const [val, offs] of sorted.slice(0, 50)) {
    const v = parseFloat(val);
    const mm = v * 1000;
    const inch = v * 25.4;
    console.log(`    ${v.toFixed(8)} → ${mm.toFixed(3)}mm / ${(v*39.3701).toFixed(4)}in  (×${offs.length} @${offs.slice(0, 3).map(o => '0x' + o.toString(16)).join(',')})`);
}

// ── 6. Check if ctc_03 STEP coordinates match inch→meter conversion ─────────

console.log('\n=== STEP→PS MATCH ANALYSIS ===\n');
// ctc_03 reference STEP has coordinates in mm. The CTC Definitions says "rc" (reduced complexity).
// SolidWorks internally stores in meters. The reference STEP may use different dimensions!

// Let's look at what the PS file's coordinates actually cluster around
const allTriplets = [];
for (let i = dataStart; i + 24 <= ps03.length; i += 8) {
    const x = ps03.readDoubleBE(i);
    const y = ps03.readDoubleBE(i + 8);
    const z = ps03.readDoubleBE(i + 16);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) continue;
    if (x === 0 && y === 0 && z === 0) continue;
    const mag = Math.abs(x) + Math.abs(y) + Math.abs(z);
    if (mag < 1e-8) continue;
    allTriplets.push({ x, y, z, off: i });
}
console.log(`  Valid triplets in [0, 1.0] range: ${allTriplets.length}`);

// Convert to mm and see if any match STEP vertices
const stepVset = new Set(step03.vertices.map(v => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`));
for (const scale of [1, 1000, 25.4]) {
    let hits = 0;
    for (const t of allTriplets) {
        const key = `${(t.x * scale).toFixed(3)},${(t.y * scale).toFixed(3)},${(t.z * scale).toFixed(3)}`;
        if (stepVset.has(key)) hits++;
    }
    console.log(`  ×${scale}: ${hits} triplets match STEP vertices (3dp tolerance)`);
}

// ── 7. Compare with ctc_01 (marker file) as sanity check ───────────────────

console.log('\n=== SANITY CHECK: ctc_01 marker file ===\n');
const ps01 = getLargestPS(join(sldDir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
const dirs01 = parseStepDirections(join(stpDir, 'CTC Definitions', 'nist_ctc_01_asme1_rd.stp'));

let found01BE = 0;
for (const d of dirs01.slice(0, 30)) {
    const xNeedle = float64BEbytes(d.dx);
    let idx = 0;
    while ((idx = ps01.indexOf(xNeedle, idx)) >= 0) {
        if (idx + 24 <= ps01.length) {
            const y = ps01.readDoubleBE(idx + 8);
            const z = ps01.readDoubleBE(idx + 16);
            if (Math.abs(y - d.dy) < 1e-10 && Math.abs(z - d.dz) < 1e-10) {
                found01BE++; break;
            }
        }
        idx++;
    }
}
console.log(`  ctc_01 float64 BE directions found: ${found01BE} / ${Math.min(30, dirs01.length)}`);

// ── 8. Byte-level comparison between marker and markerless headers ──────────

console.log('\n=== HEADER COMPARISON: marker vs markerless ===\n');
const h01 = ps01.subarray(0, 100).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
const h03 = ps03.subarray(0, 100).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
console.log('  ctc_01:', h01);
console.log('  ctc_03:', h03);

// Check if the markerless file has different byte patterns for its records
console.log('\n=== DATA AREA BYTE PATTERNS (ctc_03, first 200 bytes from 0x600) ===\n');
for (let off = 0x600; off < Math.min(0x6c8, ps03.length); off += 32) {
    const slice = ps03.subarray(off, Math.min(off + 32, ps03.length));
    const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
    console.log(`  ${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
}

// Check if we can find any known value patterns
console.log('\n=== KNOWN VALUE PATTERNS IN ctc_03 ===\n');
// Search for 1.0 as float64 BE
const oneBE = float64BEbytes(1.0);
let oneCount = 0, onePositions = [];
let idx = 0;
while ((idx = ps03.indexOf(oneBE, idx)) >= 0) {
    oneCount++;
    if (onePositions.length < 10) onePositions.push(idx);
    idx++;
}
console.log(`  1.0 as float64 BE: ${oneCount} occurrences at ${onePositions.map(p => '0x' + p.toString(16)).join(', ')}`);

// Search for -1.0
const negOneBE = float64BEbytes(-1.0);
let negOneCount = 0;
idx = 0;
while ((idx = ps03.indexOf(negOneBE, idx)) >= 0) { negOneCount++; idx++; }
console.log(`  -1.0 as float64 BE: ${negOneCount} occurrences`);

// Search for 0.707107 (sqrt2/2)
const sqrt2half = float64BEbytes(Math.SQRT1_2);
let sqrtCount = 0;
idx = 0;
while ((idx = ps03.indexOf(sqrt2half, idx)) >= 0) { sqrtCount++; idx++; }
console.log(`  √2/2 as float64 BE: ${sqrtCount} occurrences`);

// Search for model-specific values
// ctc_03 has dimensions in inches: 0.25in = 6.35mm, 0.75in = 19.05mm
// In meters: 0.00635, 0.01905
for (const [label, val] of [
    ['0.00635 (0.25in in m)', 0.00635],
    ['0.25 (0.25 raw)', 0.25],
    ['0.006350 (6.35mm→m)', 0.006350],
    ['6.35 (6.35mm)', 6.35],
    ['0.19050 (19.05mm→m)', 0.01905],
]) {
    const needle = float64BEbytes(val);
    let count = 0;
    idx = 0;
    while ((idx = ps03.indexOf(needle, idx)) >= 0) { count++; idx++; }
    if (count > 0) console.log(`  ${label}: ${count} occurrences`);
}
