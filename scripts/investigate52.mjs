/**
 * investigate52.mjs — Detailed surface comparison: our surfaces vs reference
 * Identify precisely what's wrong with our plane/cylinder extraction.
 *
 * NIST test files are US Government works (public domain).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

// Parse reference STEP file
const refStep = fs.readFileSync('output/nist_ctc_01_asme1_rd_sw1802.stp', 'utf8');
const refStepPath = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 
    'CTC Definitions', 'nist_ctc_01_asme1_rd.stp');
const refReal = fs.readFileSync(refStepPath, 'utf8');

function parseStep(text) {
    const entities = new Map();
    const re = /#(\d+)\s*=\s*(\S+?)\s*\((.+)\)\s*;/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        entities.set(parseInt(m[1]), { type: m[2], args: m[3] });
    }
    return entities;
}

function resolvePoint(entities, id) {
    const e = entities.get(id);
    if (!e || e.type !== 'CARTESIAN_POINT') return null;
    const nums = e.args.match(/-?\d+\.[\dE\+\-]*/g);
    return nums ? nums.map(Number) : null;
}

function resolveDir(entities, id) {
    const e = entities.get(id);
    if (!e || e.type !== 'DIRECTION') return null;
    const nums = e.args.match(/-?\d+\.[\dE\+\-]*/g);
    return nums ? nums.map(Number) : null;
}

function resolveAxis2(entities, id) {
    const e = entities.get(id);
    if (!e) return null;
    const refs = e.args.match(/#(\d+)/g);
    if (!refs || refs.length < 3) return null;
    return {
        origin: resolvePoint(entities, parseInt(refs[0].slice(1))),
        axis: resolveDir(entities, parseInt(refs[1].slice(1))),
        ref: resolveDir(entities, parseInt(refs[2].slice(1))),
    };
}

function extractPlanes(entities) {
    const planes = [];
    for (const [id, e] of entities) {
        if (e.type !== 'PLANE') continue;
        const axRef = e.args.match(/#(\d+)/);
        if (!axRef) continue;
        const ax = resolveAxis2(entities, parseInt(axRef[1]));
        if (!ax || !ax.origin || !ax.axis) continue;
        const d = ax.origin[0]*ax.axis[0] + ax.origin[1]*ax.axis[1] + ax.origin[2]*ax.axis[2];
        planes.push({ id, origin: ax.origin, normal: ax.axis, d });
    }
    return planes;
}

function extractCylinders(entities) {
    const cyls = [];
    for (const [id, e] of entities) {
        if (e.type !== 'CYLINDRICAL_SURFACE') continue;
        const parts = e.args.match(/#(\d+)/);
        const rMatch = e.args.match(/,\s*([\d.E\+\-]+)\s*$/);
        if (!parts || !rMatch) continue;
        const ax = resolveAxis2(entities, parseInt(parts[1]));
        if (!ax || !ax.origin || !ax.axis) continue;
        cyls.push({ id, origin: ax.origin, axis: ax.axis, radius: parseFloat(rMatch[1]) });
    }
    return cyls;
}

function extractVertices(entities) {
    const verts = [];
    for (const [id, e] of entities) {
        if (e.type !== 'VERTEX_POINT') continue;
        const ptRef = e.args.match(/#(\d+)/);
        if (!ptRef) continue;
        const pt = resolvePoint(entities, parseInt(ptRef[1]));
        if (pt) verts.push({ id, pos: pt });
    }
    return verts;
}

const ourEnts = parseStep(refStep);
const refEnts = parseStep(refReal);

const ourPlanes = extractPlanes(ourEnts);
const refPlanes = extractPlanes(refEnts);
const ourCyls = extractCylinders(ourEnts);
const refCyls = extractCylinders(refEnts);
const ourVerts = extractVertices(ourEnts);
const refVerts = extractVertices(refEnts);

console.log(`Our planes: ${ourPlanes.length}, Reference planes: ${refPlanes.length}`);
console.log(`Our cylinders: ${ourCyls.length}, Reference cylinders: ${refCyls.length}`);
console.log(`Our vertices: ${ourVerts.length}, Reference vertices: ${refVerts.length}`);

// Find reference planes NOT matched by any of our planes
function planeDist(a, b) {
    const dot = a.normal[0]*b.normal[0] + a.normal[1]*b.normal[1] + a.normal[2]*b.normal[2];
    if (Math.abs(Math.abs(dot) - 1) > 0.01) return 999;
    const sign = dot > 0 ? 1 : -1;
    return Math.abs(a.d - sign * b.d);
}

console.log('\n=== UNMATCHED REFERENCE PLANES (no match within 1mm) ===');
let unmatched = 0;
const unmatchedPlanes = [];
for (const rp of refPlanes) {
    let bestDist = 999;
    for (const op of ourPlanes) {
        const d = planeDist(rp, op);
        if (d < bestDist) bestDist = d;
    }
    if (bestDist > 1.0) {
        unmatched++;
        unmatchedPlanes.push(rp);
        if (unmatched <= 30) {
            console.log(`  REF Plane #${rp.id}: n=(${rp.normal.map(v=>v.toFixed(4)).join(',')}), d=${rp.d.toFixed(2)}, origin=(${rp.origin.map(v=>v.toFixed(2)).join(',')}), bestDist=${bestDist.toFixed(2)}`);
        }
    }
}
console.log(`Total unmatched: ${unmatched}/${refPlanes.length}`);

// Unique plane equations in reference
const refPlaneEqs = {};
for (const rp of refPlanes) {
    const nStr = rp.normal.map(v => v.toFixed(6)).join(',');
    const dStr = rp.d.toFixed(3);
    const key = `${nStr}|${dStr}`;
    if (!refPlaneEqs[key]) refPlaneEqs[key] = [];
    refPlaneEqs[key].push(rp.id);
}
console.log(`\nUnique plane equations in reference: ${Object.keys(refPlaneEqs).length}`);
console.log('Plane equations with duplicates:');
for (const [key, ids] of Object.entries(refPlaneEqs)) {
    if (ids.length > 1) {
        console.log(`  eq=${key}: ${ids.length} PLANE entities`);
    }
}

// Unique plane equations in ours
const ourPlaneEqs = {};
for (const op of ourPlanes) {
    const nStr = op.normal.map(v => v.toFixed(6)).join(',');
    const dStr = op.d.toFixed(3);
    const key = `${nStr}|${dStr}`;
    if (!ourPlaneEqs[key]) ourPlaneEqs[key] = [];
    ourPlaneEqs[key].push(op.id);
}
console.log(`\nUnique plane equations in ours: ${Object.keys(ourPlaneEqs).length}`);

// Show first 20 of our plane equations
console.log('\n=== OUR PLANE EQUATIONS ===');
for (const [key, ids] of Object.entries(ourPlaneEqs).slice(0, 30)) {
    console.log(`  eq=${key}: ${ids.length} entities`);
}

// Show first 20 of reference plane equations
console.log('\n=== REFERENCE PLANE EQUATIONS ==='); 
for (const [key, ids] of Object.entries(refPlaneEqs).slice(0, 30)) {
    console.log(`  eq=${key}: ${ids.length} entities`);
}

// Check: which of our plane equations DON'T exist in reference?
console.log('\n=== OUR PLANES NOT IN REFERENCE ===');
let badPlanes = 0;
for (const op of ourPlanes) {
    let bestDist = 999;
    for (const rp of refPlanes) {
        const d = planeDist(op, rp);
        if (d < bestDist) bestDist = d;
    }
    if (bestDist > 1.0) {
        badPlanes++;
        if (badPlanes <= 20) {
            console.log(`  OUR Plane #${op.id}: n=(${op.normal.map(v=>v.toFixed(4)).join(',')}), d=${op.d.toFixed(2)}, bestMatchDist=${bestDist.toFixed(2)}`);
        }
    }
}
console.log(`Total bad planes (not in ref): ${badPlanes}/${ourPlanes.length}`);

// Cylinder comparison
console.log('\n=== UNMATCHED REFERENCE CYLINDERS ===');
let unmatchedCyls = 0;
for (const rc of refCyls) {
    let found = false;
    for (const oc of ourCyls) {
        const dot = rc.axis[0]*oc.axis[0] + rc.axis[1]*oc.axis[1] + rc.axis[2]*oc.axis[2];
        if (Math.abs(Math.abs(dot) - 1) > 0.01) continue;
        if (Math.abs(rc.radius - oc.radius) > 0.5) continue;
        found = true;
        break;
    }
    if (!found) {
        unmatchedCyls++;
        if (unmatchedCyls <= 10) {
            console.log(`  REF Cyl #${rc.id}: axis=(${rc.axis.map(v=>v.toFixed(4)).join(',')}), r=${rc.radius.toFixed(3)}, origin=(${rc.origin.map(v=>v.toFixed(2)).join(',')})`);
        }
    }
}
console.log(`Total unmatched cylinders: ${unmatchedCyls}/${refCyls.length}`);

// Now analyze the raw Parasolid data - what type 0x1F (SURFACE) entities contain
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);
const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const sldBuf = fs.readFileSync(path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'));
const psResult = SldprtContainerParser.extractParasolid(sldBuf);
const psBuf = psResult.data;

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

// Extract entities
const entities = [];
const sentPositions = [];
let idx2 = 0;
while ((idx2 = psBuf.indexOf(SENTINEL, idx2)) >= 0) {
    sentPositions.push(idx2);
    idx2 += SENTINEL.length;
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
        if (sepIdx < 0) {
            subRecords.push(block.subarray(searchStart));
            break;
        }
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

// Separate type 0x1E (CURVE) and 0x1F (SURFACE)
const t1e = entities.filter(e => e.type === 0x1e);
const t1f = entities.filter(e => e.type === 0x1f);

console.log(`\n=== Binary entity analysis ===`);
console.log(`Type 0x1E entities: ${t1e.length}`);
console.log(`Type 0x1F entities: ${t1f.length}`);

// Classify by float count after 0x2B
function classifyFloats(ents, typeName) {
    const countHist = {};
    for (const e of ents) {
        const mi = e.data.indexOf(0x2b);
        if (mi < 0) { countHist['no-marker'] = (countHist['no-marker'] || 0) + 1; continue; }
        const floats = [];
        for (let off = mi + 1; off + 8 <= e.data.length; off += 8) {
            const val = e.data.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }
        const key = `${floats.length}-floats`;
        countHist[key] = (countHist[key] || 0) + 1;
    }
    console.log(`\n  ${typeName} float-count distribution:`);
    Object.entries(countHist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
}

classifyFloats(t1e, 'Type 0x1E (CURVE?)');
classifyFloats(t1f, 'Type 0x1F (SURFACE?)');

// Show 0x1F entities with their float data
console.log('\n=== Type 0x1F entities (first 20) ===');
for (let i = 0; i < Math.min(20, t1f.length); i++) {
    const e = t1f[i];
    const mi = e.data.indexOf(0x2b);
    if (mi < 0) { console.log(`  0x1F #${e.id}: no 0x2B marker`); continue; }
    const floats = [];
    for (let off = mi + 1; off + 8 <= e.data.length; off += 8) {
        const val = e.data.readDoubleBE(off);
        if (!isFinite(val) || Math.abs(val) > 1e6) break;
        floats.push(val);
    }
    console.log(`  0x1F #${e.id}: ${floats.length} floats: [${floats.map(v=>v.toFixed(6)).join(', ')}]`);
}
