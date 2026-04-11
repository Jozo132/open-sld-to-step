/**
 * investigate50.mjs — Deep topology extraction from Parasolid binary
 *
 * Goal: Extract actual face→loop→edge→vertex→point chains from the
 * binary transmit data by parsing entity cross-references.
 *
 * Entity types:
 *  0x0F = FACE, 0x10 = EDGE, 0x11 = SHELL/BODY, 0x12 = COEDGE,
 *  0x13 = LOOP, 0x1D = POINT, 0x1E = SURFACE/CURVE, 0x1F = B_SPLINE
 *
 * Each entity has an ID (uint16 BE) and references other entities via uint16 IDs.
 * We need to discover the field layout for each entity type.
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

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const sldprtPath = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');
const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const psBuf = result.data;
console.log(`Parasolid buffer: ${psBuf.length} bytes`);

// Find all sentinel positions
const sentPositions = [];
let idx = 0;
while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) {
    sentPositions.push(idx);
    idx += SENTINEL.length;
}
console.log(`Sentinel blocks: ${sentPositions.length}`);

// Extract ALL entities with full raw data
const entities = [];
for (let i = 0; i < sentPositions.length; i++) {
    const blockStart = sentPositions[i] + SENTINEL.length;
    const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    if (block.length < 8) continue;

    // Split by sub-record separator
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
            // Primary: [00 00 00 03 00 TYPE ID_hi ID_lo]
            if (rec.length < 8) continue;
            if (rec.readUInt32BE(0) !== 3) continue;
            const type = rec[5];
            if (type < 0x0d || type > 0x3f) continue;
            const id = rec.readUInt16BE(6);
            entities.push({ type, id, data: rec.subarray(8), blockIdx: i, sub: si });
        } else {
            // Sub-record: [00 TYPE ID_hi ID_lo]
            if (rec.length < 4) continue;
            if (rec[0] !== 0x00) continue;
            const type = rec[1];
            if (type < 0x0d || type > 0x3f) continue;
            const id = rec.readUInt16BE(2);
            entities.push({ type, id, data: rec.subarray(4), blockIdx: i, sub: si });
        }
    }
}

// Census
const typeNames = {
    0x0d: 'BODY/REGION', 0x0e: 'LUMP', 0x0f: 'FACE', 0x10: 'EDGE',
    0x11: 'SHELL', 0x12: 'COEDGE', 0x13: 'LOOP', 0x1d: 'POINT',
    0x1e: 'SURF/CURVE', 0x1f: 'BSPLINE', 0x14: 'FIN', 0x15: 'VERTEX',
};
const census = {};
for (const e of entities) {
    const name = typeNames[e.type] || `0x${e.type.toString(16)}`;
    census[name] = (census[name] || 0) + 1;
}
console.log('\n=== Entity Census ===');
Object.entries(census).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n}: ${c}`));

// Analyze FACE entities (type 0x0F) to discover field layout
const faceEntities = entities.filter(e => e.type === 0x0f);
console.log(`\n=== FACE entities: ${faceEntities.length} ===`);

// Show first 10 FACE records with hex dump
for (let i = 0; i < Math.min(20, faceEntities.length); i++) {
    const f = faceEntities[i];
    const hexBytes = [];
    for (let j = 0; j < Math.min(80, f.data.length); j++) {
        hexBytes.push(f.data[j].toString(16).padStart(2, '0'));
    }
    
    // Try reading uint16 BE values as potential entity references
    const refs = [];
    for (let j = 0; j + 2 <= f.data.length && j < 40; j += 2) {
        refs.push(f.data.readUInt16BE(j));
    }
    
    console.log(`\n  FACE id=${f.id} (${f.data.length} bytes)`);
    console.log(`    hex: ${hexBytes.join(' ')}`);
    console.log(`    u16: ${refs.map(r => r.toString().padStart(4)).join(' ')}`);
}

// Analyze EDGE entities (type 0x10)
const edgeEntities = entities.filter(e => e.type === 0x10);
console.log(`\n=== EDGE entities: ${edgeEntities.length} ===`);
for (let i = 0; i < Math.min(10, edgeEntities.length); i++) {
    const e = edgeEntities[i];
    const refs = [];
    for (let j = 0; j + 2 <= e.data.length && j < 40; j += 2) {
        refs.push(e.data.readUInt16BE(j));
    }
    console.log(`  EDGE id=${e.id} (${e.data.length} bytes): ${refs.map(r => r.toString().padStart(4)).join(' ')}`);
}

// Analyze LOOP entities (type 0x13)
const loopEntities = entities.filter(e => e.type === 0x13);
console.log(`\n=== LOOP entities: ${loopEntities.length} ===`);
for (let i = 0; i < Math.min(10, loopEntities.length); i++) {
    const l = loopEntities[i];
    const refs = [];
    for (let j = 0; j + 2 <= l.data.length && j < 40; j += 2) {
        refs.push(l.data.readUInt16BE(j));
    }
    console.log(`  LOOP id=${l.id} (${l.data.length} bytes): ${refs.map(r => r.toString().padStart(4)).join(' ')}`);
}

// Analyze COEDGE entities (type 0x12)
const coedgeEntities = entities.filter(e => e.type === 0x12);
console.log(`\n=== COEDGE entities: ${coedgeEntities.length} ===`);
for (let i = 0; i < Math.min(10, coedgeEntities.length); i++) {
    const c = coedgeEntities[i];
    const refs = [];
    for (let j = 0; j + 2 <= c.data.length && j < 40; j += 2) {
        refs.push(c.data.readUInt16BE(j));
    }
    console.log(`  COEDGE id=${c.id} (${c.data.length} bytes): ${refs.map(r => r.toString().padStart(4)).join(' ')}`);
}

// Analyze SHELL entities (type 0x11)
const shellEntities = entities.filter(e => e.type === 0x11);
console.log(`\n=== SHELL entities: ${shellEntities.length} ===`);
for (let i = 0; i < Math.min(5, shellEntities.length); i++) {
    const s = shellEntities[i];
    const refs = [];
    for (let j = 0; j + 2 <= s.data.length && j < 60; j += 2) {
        refs.push(s.data.readUInt16BE(j));
    }
    console.log(`  SHELL id=${s.id} (${s.data.length} bytes): ${refs.map(r => r.toString().padStart(4)).join(' ')}`);
}

// Analyze POINT entities (type 0x1D)
const pointEntities = entities.filter(e => e.type === 0x1d);
console.log(`\n=== POINT entities: ${pointEntities.length} ===`);
for (let i = 0; i < Math.min(5, pointEntities.length); i++) {
    const p = pointEntities[i];
    // Try to read coordinates
    const refs = [];
    for (let j = 0; j + 2 <= p.data.length && j < 20; j += 2) {
        refs.push(p.data.readUInt16BE(j));
    }
    // Read float64 at offset 8 (after [00 00 ref:2 00 01 ref:2 ref:2 ref:2] = 16 bytes, minus 8 for data starting after type+id)
    let x, y, z;
    if (p.data.length >= 32) {
        x = p.data.readDoubleBE(8);
        y = p.data.readDoubleBE(16);
        z = p.data.readDoubleBE(24);
    }
    console.log(`  POINT id=${p.id} (${p.data.length} bytes): refs=[${refs.join(',')}] coords=(${x?.toFixed(6)}, ${y?.toFixed(6)}, ${z?.toFixed(6)})`);
}

// Analyze VERTEX entities (type 0x15)
const vertexEntities = entities.filter(e => e.type === 0x15);
console.log(`\n=== VERTEX entities: ${vertexEntities.length} ===`);
for (let i = 0; i < Math.min(10, vertexEntities.length); i++) {
    const v = vertexEntities[i];
    const refs = [];
    for (let j = 0; j + 2 <= v.data.length && j < 20; j += 2) {
        refs.push(v.data.readUInt16BE(j));
    }
    console.log(`  VERTEX id=${v.id} (${v.data.length} bytes): ${refs.map(r => r.toString().padStart(4)).join(' ')}`);
}

// Cross-reference: what IDs appear in FACE data that correspond to other entity types?
const entityById = new Map();
for (const e of entities) {
    entityById.set(e.id, e);
}

console.log('\n=== Cross-reference analysis ===');
// For first few FACE entities, try to identify which fields are refs to other entities
for (let i = 0; i < Math.min(5, faceEntities.length); i++) {
    const f = faceEntities[i];
    console.log(`\n  FACE ${f.id}:`);
    
    // Read uint16 values and check if they reference known entities
    for (let j = 0; j + 2 <= f.data.length && j < 40; j += 2) {
        const val = f.data.readUInt16BE(j);
        const ref = entityById.get(val);
        if (ref && val > 0 && val < 5000) {
            const tname = typeNames[ref.type] || `0x${ref.type.toString(16)}`;
            console.log(`    offset ${j}: ref #${val} → ${tname}`);
        }
    }
}

// Same for COEDGE
for (let i = 0; i < Math.min(5, coedgeEntities.length); i++) {
    const c = coedgeEntities[i];
    console.log(`\n  COEDGE ${c.id}:`);
    for (let j = 0; j + 2 <= c.data.length && j < 40; j += 2) {
        const val = c.data.readUInt16BE(j);
        const ref = entityById.get(val);
        if (ref && val > 0 && val < 5000) {
            const tname = typeNames[ref.type] || `0x${ref.type.toString(16)}`;
            console.log(`    offset ${j}: ref #${val} → ${tname}`);
        }
    }
}

// Same for EDGE
for (let i = 0; i < Math.min(5, edgeEntities.length); i++) {
    const e = edgeEntities[i];
    console.log(`\n  EDGE ${e.id}:`);
    for (let j = 0; j + 2 <= e.data.length && j < 40; j += 2) {
        const val = e.data.readUInt16BE(j);
        const ref = entityById.get(val);
        if (ref && val > 0 && val < 5000) {
            const tname = typeNames[ref.type] || `0x${ref.type.toString(16)}`;
            console.log(`    offset ${j}: ref #${val} → ${tname}`);
        }
    }
}
