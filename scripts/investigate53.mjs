/**
 * investigate53.mjs — Find the actual plane surfaces in the binary data
 * Test hypothesis: 7-float type-0x1E entities include both LINE and PLANE
 * Try vertex association to separate them.
 * Also check 0x2D markers and no-marker entities.
 *
 * NIST test files are US Government works (public domain).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
const PS_TO_MM = 1000;

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const sldBuf = fs.readFileSync(path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
const psResult = SldprtContainerParser.extractParasolid(sldBuf);
const psBuf = psResult.data;

// Extract all entities
const entities = [];
const sentPositions = [];
let idx = 0;
while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) {
    sentPositions.push(idx);
    idx += SENTINEL.length;
}

for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + SENTINEL.length;
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    if (block.length < 8) continue;

    const subRecords = [];
    let searchStart = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_RECORD_SEP, searchStart);
        if (sepIdx < 0) { subRecords.push(block.subarray(searchStart)); break; }
        subRecords.push(block.subarray(searchStart, sepIdx));
        searchStart = sepIdx + SUB_RECORD_SEP.length;
    }

    for (let si = 0; si < subRecords.length; si++) {
        const rec = subRecords[si];
        if (si === 0) {
            if (rec.length < 8 || rec.readUInt32BE(0) !== 3) continue;
            const type = rec[5]; if (type < 0x0d || type > 0x3f) continue;
            entities.push({ type, id: rec.readUInt16BE(6), data: rec.subarray(8) });
        } else {
            if (rec.length < 4 || rec[0] !== 0x00) continue;
            const type = rec[1]; if (type < 0x0d || type > 0x3f) continue;
            entities.push({ type, id: rec.readUInt16BE(2), data: rec.subarray(4) });
        }
    }
}

// Extract POINT positions
const points = entities.filter(e => e.type === 0x1d);
const ptPositions = [];
for (const p of points) {
    if (p.data.length < 32) continue;
    // Based on POINT_COORD_OFFSET formula: data starts after type+id already stripped
    // Layout: [00 00] [ref:2] [00 01] [ref:2] [ref:2] [ref:2] [x:f64] [y:f64] [z:f64]
    // Find coordinates by searching for 0x2B or at fixed offset
    // Try reading at various offsets
    let best = null;
    for (const off of [8, 10, 12, 14, 16]) {
        if (off + 24 > p.data.length) continue;
        const x = p.data.readDoubleBE(off);
        const y = p.data.readDoubleBE(off + 8);
        const z = p.data.readDoubleBE(off + 16);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        if (Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) continue;
        // Check if these look like coordinates (in meters, CTC_01 ≈ 0-0.5m range)
        if (Math.abs(x) + Math.abs(y) + Math.abs(z) > 1e-6) {
            if (!best || off === 8) best = { x: x * PS_TO_MM, y: y * PS_TO_MM, z: z * PS_TO_MM, off };
        }
    }
    if (best) ptPositions.push(best);
}
console.log(`Extracted ${ptPositions.length} point positions`);

// Show a few points
for (let i = 0; i < Math.min(10, ptPositions.length); i++) {
    console.log(`  Point ${i}: (${ptPositions[i].x.toFixed(2)}, ${ptPositions[i].y.toFixed(2)}, ${ptPositions[i].z.toFixed(2)}) [off=${ptPositions[i].off}]`);
}

// Extract 7-float type-0x1E entities as candidate planes
const candidates = [];
for (const e of entities.filter(e => e.type === 0x1e)) {
    const data = e.data;
    // Try both 0x2B and 0x2D markers
    for (const marker of [0x2b, 0x2d]) {
        const mi = data.indexOf(marker);
        if (mi < 0 || mi + 1 + 56 > data.length) continue;
        const floats = [];
        for (let off = mi + 1; off + 8 <= data.length; off += 8) {
            const val = data.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }
        if (floats.length >= 7) {
            candidates.push({
                id: e.id,
                type: e.type,
                marker: marker === 0x2b ? '+' : '-',
                floatCount: floats.length,
                origin: { x: floats[0] * PS_TO_MM, y: floats[1] * PS_TO_MM, z: floats[2] * PS_TO_MM },
                normal: { x: floats[3], y: floats[4], z: floats[5] },
                normalMag: Math.sqrt(floats[3]**2 + floats[4]**2 + floats[5]**2),
            });
        }
    }
}

console.log(`\nCandidate plane/line entities from type 0x1E: ${candidates.length}`);

// For each candidate, count how many POINT entities lie on the plane
function countOnPlane(origin, normal, points, tol) {
    const mag = Math.sqrt(normal.x**2 + normal.y**2 + normal.z**2);
    if (mag < 0.01) return 0;
    const nx = normal.x/mag, ny = normal.y/mag, nz = normal.z/mag;
    let count = 0;
    for (const pt of points) {
        const dx = pt.x - origin.x, dy = pt.y - origin.y, dz = pt.z - origin.z;
        const dist = Math.abs(dx * nx + dy * ny + dz * nz);
        if (dist < tol) count++;
    }
    return count;
}

// Classify candidates: ≥3 coplanar points → likely plane, <3 → likely line
const planes = [];
const lines = [];
for (const c of candidates) {
    const onPlane = countOnPlane(c.origin, c.normal, ptPositions, 0.5);
    if (onPlane >= 3) {
        planes.push({ ...c, vertexCount: onPlane });
    } else {
        lines.push({ ...c, vertexCount: onPlane });
    }
}

console.log(`Classified as PLANE (≥3 pts): ${planes.length}`);
console.log(`Classified as LINE (<3 pts): ${lines.length}`);

// Reference comparison
const refStepPath = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 
    'CTC Definitions', 'nist_ctc_01_asme1_rd.stp');
const refStep = fs.readFileSync(refStepPath, 'utf8');

// Parse reference planes
function parseRefPlanes(text) {
    const entities = new Map();
    const re = /#(\d+)\s*=\s*(\S+?)\s*\((.+)\)\s*;/g;
    let m;
    while ((m = re.exec(text)) !== null) entities.set(parseInt(m[1]), { type: m[2], args: m[3] });
    
    const planes = [];
    for (const [id, e] of entities) {
        if (e.type !== 'PLANE') continue;
        const axRef = e.args.match(/#(\d+)/);
        if (!axRef) continue;
        const ax = entities.get(parseInt(axRef[1]));
        if (!ax) continue;
        const refs = ax.args.match(/#(\d+)/g);
        if (!refs || refs.length < 3) continue;
        const pt = entities.get(parseInt(refs[0].slice(1)));
        const dir = entities.get(parseInt(refs[1].slice(1)));
        if (!pt || !dir) continue;
        const origin = pt.args.match(/-?\d+\.[\dE\+\-]*/g)?.map(Number);
        const normal = dir.args.match(/-?\d+\.[\dE\+\-]*/g)?.map(Number);
        if (!origin || !normal) continue;
        const d = origin[0]*normal[0] + origin[1]*normal[1] + origin[2]*normal[2];
        planes.push({ id, origin, normal, d });
    }
    return planes;
}

const refPlanes = parseRefPlanes(refStep);

// Match our classified planes vs reference
function matchPlane(our, ref) {
    const n1 = our.normal;
    const m1 = Math.sqrt(n1.x**2 + n1.y**2 + n1.z**2);
    const nx1 = n1.x/m1, ny1 = n1.y/m1, nz1 = n1.z/m1;
    const d1 = nx1*our.origin.x + ny1*our.origin.y + nz1*our.origin.z;
    
    for (const rp of ref) {
        const dot = nx1*rp.normal[0] + ny1*rp.normal[1] + nz1*rp.normal[2];
        if (Math.abs(Math.abs(dot) - 1) > 0.01) continue;
        const sign = dot > 0 ? 1 : -1;
        if (Math.abs(d1 - sign * rp.d) < 1.0) return rp;
    }
    return null;
}

let matched = 0;
for (const p of planes) {
    const ref = matchPlane(p, refPlanes);
    if (ref) matched++;
}
console.log(`\nPlanes matching reference (within 1mm): ${matched}/${planes.length} (out of ${refPlanes.length} ref planes)`);

// Show planes that DON'T match reference
console.log('\nPlane candidates NOT matching reference:');
let notMatched = 0;
for (const p of planes) {
    const ref = matchPlane(p, refPlanes);
    if (!ref) {
        notMatched++;
        if (notMatched <= 15) {
            console.log(`  id=${p.id} n=(${(p.normal.x/p.normalMag).toFixed(4)},${(p.normal.y/p.normalMag).toFixed(4)},${(p.normal.z/p.normalMag).toFixed(4)}) mag=${p.normalMag.toFixed(4)} d=${(p.origin.x*(p.normal.x/p.normalMag)+p.origin.y*(p.normal.y/p.normalMag)+p.origin.z*(p.normal.z/p.normalMag)).toFixed(2)} vtx=${p.vertexCount}`);
        }
    }
}

// Show unmatched reference planes
console.log('\nReference planes NOT matched:');
let refUnmatched = 0;
const matchedRefs = new Set();
for (const p of planes) {
    const ref = matchPlane(p, refPlanes);
    if (ref) matchedRefs.add(ref.id);
}
for (const rp of refPlanes) {
    if (!matchedRefs.has(rp.id)) {
        refUnmatched++;
        if (refUnmatched <= 15) {
            console.log(`  ref#${rp.id} n=(${rp.normal.map(v=>v.toFixed(4)).join(',')}) d=${rp.d.toFixed(2)} origin=(${rp.origin.map(v=>v.toFixed(2)).join(',')})`);
        }
    }
}
console.log(`Total unmatched reference: ${refUnmatched}/${refPlanes.length}`);

// Check: which reference plane equations are we missing?
// Normalize refs and check unique equations
const refEqs = new Map();
for (const rp of refPlanes) {
    const n = rp.normal;
    const key = `${n[0].toFixed(4)},${n[1].toFixed(4)},${n[2].toFixed(4)}|${rp.d.toFixed(2)}`;
    if (!refEqs.has(key)) refEqs.set(key, []);
    refEqs.get(key).push(rp.id);
}

// Check which unique equations we're missing
let missingEqs = 0;
for (const [eq, ids] of refEqs) {
    const [normalStr, dStr] = eq.split('|');
    const normal = normalStr.split(',').map(Number);
    const d = parseFloat(dStr);
    
    let found = false;
    for (const p of planes) {
        const m = p.normalMag;
        const nx = p.normal.x/m, ny = p.normal.y/m, nz = p.normal.z/m;
        const dot = nx*normal[0] + ny*normal[1] + nz*normal[2];
        if (Math.abs(Math.abs(dot) - 1) > 0.01) continue;
        const sign = dot > 0 ? 1 : -1;
        const d1 = nx*p.origin.x + ny*p.origin.y + nz*p.origin.z;
        if (Math.abs(d1 - sign * d) < 1.0) { found = true; break; }
    }
    if (!found) {
        missingEqs++;
        console.log(`  MISSING eq: n=(${normalStr}) d=${dStr} [${ids.length} ref planes]`);
    }
}
console.log(`Missing unique equations: ${missingEqs}/${refEqs.size}`);

// Now try also extracting from 0x1F entities with 0x2B marker  
// These might include planes encoded differently
console.log('\n=== Examining type-0x1F no-marker entities ===');
for (const e of entities.filter(e => e.type === 0x1f)) {
    const data = e.data;
    const mi = data.indexOf(0x2b);
    if (mi >= 0) continue; // skip entities WITH marker (already classified as cylinders)
    
    // Try 0x2D marker
    const mi2 = data.indexOf(0x2d);
    if (mi2 >= 0 && mi2 + 1 + 8 <= data.length) {
        const floats = [];
        for (let off = mi2 + 1; off + 8 <= data.length; off += 8) {
            const val = data.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }
        console.log(`  0x1F #${e.id}: 0x2D marker, ${floats.length} floats: [${floats.slice(0,12).map(v=>v.toFixed(6)).join(', ')}]`);
        continue;
    }
    
    // Show hex dump for no-marker entities
    const hexBytes = [];
    for (let j = 0; j < Math.min(80, data.length); j++) {
        hexBytes.push(data[j].toString(16).padStart(2, '0'));
    }
    console.log(`  0x1F #${e.id} (${data.length}B, no marker): ${hexBytes.join(' ')}`);
}

// Also check ALL entities for 7-float data with 0x2D marker
console.log('\n=== All entities with 0x2D marker ===');
let count2d = 0;
for (const e of entities) {
    const mi = e.data.indexOf(0x2d);
    if (mi < 0 || mi + 1 + 8 > e.data.length) continue;
    const floats = [];
    for (let off = mi + 1; off + 8 <= e.data.length; off += 8) {
        const val = e.data.readDoubleBE(off);
        if (!isFinite(val) || Math.abs(val) > 1e6) break;
        floats.push(val);
    }
    if (floats.length >= 3) {
        count2d++;
        if (count2d <= 10) {
            const typeName = {0x1e:'CURVE',0x1f:'SURF'}[e.type] || `0x${e.type.toString(16)}`;
            console.log(`  ${typeName} #${e.id}: ${floats.length} floats: [${floats.slice(0,8).map(v=>v.toFixed(6)).join(', ')}]`);
        }
    }
}
console.log(`Total entities with 0x2D marker + ≥3 floats: ${count2d}`);
