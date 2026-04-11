/**
 * investigate44.mjs — Deep-dive: why are we missing surfaces?
 *
 * 55 unique planes vs 80 reference, 42 cylinders vs 57.
 * Possible reasons:
 * 1. Raw extraction misses some (floats < 7 or > 12 after 0x2B)
 * 2. Deduplication is too aggressive (tolerance merges distinct surfaces)
 * 3. Some surfaces are B-spline type (0x1F) that we skip
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
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const sldprtPath = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');

const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const psData = result.data;

// Manually run extractAllEntities to get raw counts
const parser = new ParasolidParser(psData);
const model = parser.parse();

// Count raw surfaces by accessing the internal method via parse result
console.log(`Model surfaces: ${model.surfaces.length}`);
console.log(`  planes: ${model.surfaces.filter(s => s.surfaceType === 'plane').length}`);
console.log(`  cylinders: ${model.surfaces.filter(s => s.surfaceType === 'cylinder').length}`);
console.log(`  cones: ${model.surfaces.filter(s => s.surfaceType === 'cone').length}`);

// Now manually scan the PS data for ALL 0x2B markers and classify
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

// Find all sentinel positions
const sentPositions = [];
let idx = 0;
while ((idx = psData.indexOf(SENTINEL, idx)) >= 0) {
    sentPositions.push(idx);
    idx += SENTINEL.length;
}

// Extract all entities (same logic as ParasolidParser)
const entities = [];
for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + SENTINEL.length;
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : psData.length;
    const block = psData.subarray(blockStart, blockEnd);
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
            const type = rec[5];
            if (type < 0x0d || type > 0x3f) continue;
            entities.push({ type, id: rec.readUInt16BE(6), data: rec.subarray(8) });
        } else {
            if (rec.length < 4 || rec[0] !== 0x00) continue;
            const type = rec[1];
            if (type < 0x0d || type > 0x3f) continue;
            entities.push({ type, id: rec.readUInt16BE(2), data: rec.subarray(4) });
        }
    }
}

// Filter geometry entities (0x1E and 0x1F)
const geomEntities = entities.filter(e => e.type === 0x1e || e.type === 0x1f);
console.log(`\nTotal geometry entities (0x1E + 0x1F): ${geomEntities.length}`);
console.log(`  type 0x1E: ${geomEntities.filter(e => e.type === 0x1e).length}`);
console.log(`  type 0x1F: ${geomEntities.filter(e => e.type === 0x1f).length}`);

// For each, find 0x2B marker and count floats
const floatCounts = {};
let noMarker = 0;
const rawSurfaces = { plane: 0, cylinder: 0, cone: 0, unknown: 0 };
const surfacesByFloatCount = {};

for (const ent of geomEntities) {
    const data = ent.data;
    const markerIdx = data.indexOf(0x2b);
    if (markerIdx < 0) {
        noMarker++;
        continue;
    }
    
    const floatStart = markerIdx + 1;
    const floats = [];
    for (let off = floatStart; off + 8 <= data.length; off += 8) {
        const val = data.readDoubleBE(off);
        if (!isFinite(val) || Math.abs(val) > 1e6) break;
        floats.push(val);
    }
    
    const count = floats.length;
    floatCounts[count] = (floatCounts[count] || 0) + 1;
    surfacesByFloatCount[count] = surfacesByFloatCount[count] || [];
    
    if (count >= 7 && count <= 8) {
        // Check normal magnitude
        const nx = floats[3], ny = floats[4], nz = floats[5];
        const mag = Math.sqrt(nx*nx + ny*ny + nz*nz);
        if (mag >= 0.5 && mag <= 2.0) {
            rawSurfaces.plane++;
            surfacesByFloatCount[count].push('plane');
        } else {
            rawSurfaces.unknown++;
            surfacesByFloatCount[count].push(`unknown(mag=${mag.toFixed(3)})`);
        }
    } else if (count >= 11 && count <= 12) {
        const radius = floats[9];
        const semiAngle = floats[10];
        if (radius > 0 && radius < 1e4) {
            if (Math.abs(semiAngle) < 1e-6) {
                rawSurfaces.cylinder++;
                surfacesByFloatCount[count].push('cylinder');
            } else {
                rawSurfaces.cone++;
                surfacesByFloatCount[count].push('cone');
            }
        } else {
            rawSurfaces.unknown++;
            surfacesByFloatCount[count].push(`unknown(r=${radius})`);
        }
    } else {
        rawSurfaces.unknown++;
        surfacesByFloatCount[count].push('unknown');
    }
}

console.log(`\nFloat count distribution after 0x2B:`);
for (const [count, n] of Object.entries(floatCounts).sort((a,b) => parseInt(a[0]) - parseInt(b[0]))) {
    const types = surfacesByFloatCount[count] || [];
    const typeSummary = {};
    for (const t of types) typeSummary[t] = (typeSummary[t] || 0) + 1;
    const summary = Object.entries(typeSummary).map(([t, c]) => `${t}:${c}`).join(', ');
    console.log(`  ${count} floats: ${n} entities  [${summary}]`);
}

console.log(`\nEntities with no 0x2B marker: ${noMarker}`);
console.log(`\nRaw surface classification (before dedup):`);
console.log(`  planes: ${rawSurfaces.plane}`);
console.log(`  cylinders: ${rawSurfaces.cylinder}`);
console.log(`  cones: ${rawSurfaces.cone}`);
console.log(`  unknown: ${rawSurfaces.unknown}`);

// Check the "unknown" entities more carefully
console.log(`\n=== Unknown geometry entities (not 7/8/11/12 floats) ===`);
for (const ent of geomEntities) {
    const data = ent.data;
    const markerIdx = data.indexOf(0x2b);
    if (markerIdx < 0) continue;
    
    const floatStart = markerIdx + 1;
    const floats = [];
    for (let off = floatStart; off + 8 <= data.length; off += 8) {
        const val = data.readDoubleBE(off);
        if (!isFinite(val) || Math.abs(val) > 1e6) break;
        floats.push(val);
    }
    
    if (floats.length >= 7 && floats.length <= 8) continue;
    if (floats.length >= 11 && floats.length <= 12) continue;
    
    console.log(`  type=0x${ent.type.toString(16)} id=${ent.id} floats=${floats.length}: [${floats.slice(0, 6).map(f => f.toFixed(4)).join(', ')}${floats.length > 6 ? '...' : ''}]`);
}

// Now check: how many of the "dedupped away" surfaces matched distinct reference planes?
// The dedup reduces 214 → 55 planes. But reference has 80 planes (with 57 unique equations).
// So we're losing surfaces that the reference keeps separate.
console.log(`\n=== Deduplication analysis ===`);
console.log(`Raw planes: ${rawSurfaces.plane}`);
console.log(`After dedup: ${model.surfaces.filter(s => s.surfaceType === 'plane').length}`);
console.log(`Reference unique plane equations: 57`);
console.log(`Reference total planes: 80`);
console.log(`\nDifference: Reference has 57 unique plane equations, we have 55.`);
console.log(`The 25 missing planes (80 ref minus 55 ours) include:`);
console.log(`  - ~2 lost in dedup (55 vs 57 unique equations)`);
console.log(`  - ~23 are multiple faces on the same plane equation (ref has 79 plane faces from 57 equations)`);
