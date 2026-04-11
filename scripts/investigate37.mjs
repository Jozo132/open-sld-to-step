/**
 * investigate37.mjs — Deep analysis of Parasolid entity relationships
 * 
 * Goal: Understand how face/loop/edge/surface cross-references work
 * to extract real topology instead of synthetic.
 *
 * All observations derived from publicly available NIST MBE PMI test files
 * (U.S. Government works, public domain).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const sldprtPath = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');

const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const psBuf = result.data;

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

// Parse all entities
const sents = [];
let idx = 0;
while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) { sents.push(idx); idx += 6; }

const entities = [];
for (let i = 0; i < sents.length; i++) {
    const blockStart = sents[i] + 6;
    const blockEnd = (i + 1 < sents.length) ? sents[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    if (block.length < 8) continue;

    const recs = [];
    let ss = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_SEP, ss);
        if (sepIdx < 0) { recs.push(block.subarray(ss)); break; }
        recs.push(block.subarray(ss, sepIdx));
        ss = sepIdx + 6;
    }

    for (let si = 0; si < recs.length; si++) {
        const rec = recs[si];
        let type, id, data;
        if (si === 0) {
            if (rec.length < 8 || rec.readUInt32BE(0) !== 3) continue;
            type = rec[5]; id = rec.readUInt16BE(6); data = rec.subarray(8);
        } else {
            if (rec.length < 4 || rec[0] !== 0x00) continue;
            type = rec[1]; id = rec.readUInt16BE(2); data = rec.subarray(4);
        }
        if (type < 0x0d || type > 0x3f) continue;
        entities.push({ type, id, data, isPrimary: si === 0 });
    }
}

const TYPE_NAMES = {
    0x0d: 'ATTRIB_DEF', 0x0e: 'ATTRIB', 0x0f: 'FACE', 0x10: 'EDGE',
    0x11: 'SHELL/BODY/REGION', 0x12: 'COEDGE', 0x13: 'LOOP',
    0x14: 'FIN', 0x15: 'VERTEX',
    0x1d: 'POINT', 0x1e: 'SURFACE/CURVE', 0x1f: 'BSPLINE',
};

// Census
const census = {};
for (const e of entities) {
    const name = TYPE_NAMES[e.type] || `0x${e.type.toString(16)}`;
    census[name] = (census[name] || 0) + 1;
}
console.log('Entity census:', census);

// ── Analyze FACE entities (type 0x0F) ──
const faces = entities.filter(e => e.type === 0x0f);
console.log(`\n--- FACE entities: ${faces.length} ---`);
console.log('First 5 face data (hex):');
for (const f of faces.slice(0, 5)) {
    const hex = [...f.data.subarray(0, Math.min(40, f.data.length))]
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  id=${f.id} [${hex}]`);
    // Try reading uint16 BE references
    const refs = [];
    for (let off = 0; off + 2 <= f.data.length && off < 30; off += 2) {
        refs.push(f.data.readUInt16BE(off));
    }
    console.log(`    u16 refs: ${refs.join(', ')}`);
}

// ── Analyze EDGE entities (type 0x10) ──
const edges = entities.filter(e => e.type === 0x10);
console.log(`\n--- EDGE entities: ${edges.length} ---`);
for (const e of edges.slice(0, 5)) {
    const hex = [...e.data.subarray(0, Math.min(40, e.data.length))]
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  id=${e.id} len=${e.data.length} [${hex}]`);
    const refs = [];
    for (let off = 0; off + 2 <= e.data.length && off < 30; off += 2) {
        refs.push(e.data.readUInt16BE(off));
    }
    console.log(`    u16 refs: ${refs.join(', ')}`);
}

// ── Analyze LOOP entities (type 0x13) ──
const loops = entities.filter(e => e.type === 0x13);
console.log(`\n--- LOOP entities: ${loops.length} ---`);
for (const l of loops.slice(0, 5)) {
    const hex = [...l.data.subarray(0, Math.min(40, l.data.length))]
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  id=${l.id} len=${l.data.length} [${hex}]`);
    const refs = [];
    for (let off = 0; off + 2 <= l.data.length && off < 30; off += 2) {
        refs.push(l.data.readUInt16BE(off));
    }
    console.log(`    u16 refs: ${refs.join(', ')}`);
}

// ── Analyze COEDGE entities (type 0x12) ──
const coedges = entities.filter(e => e.type === 0x12);
console.log(`\n--- COEDGE entities: ${coedges.length} ---`);
for (const ce of coedges.slice(0, 5)) {
    const hex = [...ce.data.subarray(0, Math.min(40, ce.data.length))]
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  id=${ce.id} len=${ce.data.length} [${hex}]`);
    const refs = [];
    for (let off = 0; off + 2 <= ce.data.length && off < 30; off += 2) {
        refs.push(ce.data.readUInt16BE(off));
    }
    console.log(`    u16 refs: ${refs.join(', ')}`);
}

// ── Analyze SHELL/BODY/REGION entities (type 0x11) ──
const shells = entities.filter(e => e.type === 0x11);
console.log(`\n--- SHELL/BODY/REGION entities: ${shells.length} ---`);
for (const s of shells.slice(0, 5)) {
    const hex = [...s.data.subarray(0, Math.min(40, s.data.length))]
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  id=${s.id} len=${s.data.length} isPrimary=${s.isPrimary} [${hex}]`);
}

// ── Check if primary entities of type 0x11 can be BODY vs SHELL ──
console.log('\n--- Primary vs sub-record type 0x11 ---');
const primary11 = shells.filter(e => e.isPrimary);
const sub11 = shells.filter(e => !e.isPrimary);
console.log(`Primary: ${primary11.length}, Sub-record: ${sub11.length}`);

// ── VERTEX entities (type 0x15) ──
const vertices = entities.filter(e => e.type === 0x15);
console.log(`\n--- VERTEX entities: ${vertices.length} ---`);
for (const v of vertices.slice(0, 5)) {
    const hex = [...v.data.subarray(0, Math.min(20, v.data.length))]
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  id=${v.id} len=${v.data.length} [${hex}]`);
    const refs = [];
    for (let off = 0; off + 2 <= v.data.length && off < 20; off += 2) {
        refs.push(v.data.readUInt16BE(off));
    }
    console.log(`    u16 refs: ${refs.join(', ')}`);
}

// ── Surface/Curve entity analysis: distinguish LINE from PLANE ──
console.log('\n--- SURFACE/CURVE (0x1E) analysis: LINE vs PLANE ---');
const geom = entities.filter(e => e.type === 0x1e);
console.log(`Total type-0x1E: ${geom.length}`);

// Check what type the parent block entity is for each geometry sub-record
// Group by parent entity type
const parentCheck = {};
for (let i = 0; i < sents.length; i++) {
    const blockStart = sents[i] + 6;
    const blockEnd = (i + 1 < sents.length) ? sents[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    if (block.length < 8 || block.readUInt32BE(0) !== 3) continue;
    
    const primaryType = block[5];
    
    // Check if block has sub-records with 0x1E or 0x1F
    let pos = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_SEP, pos + 1);
        if (sepIdx < 0) break;
        const after = sepIdx + 6;
        if (after + 2 > block.length) break;
        if (block[after] === 0x00 && (block[after + 1] === 0x1e || block[after + 1] === 0x1f)) {
            const pName = TYPE_NAMES[primaryType] || `0x${primaryType.toString(16)}`;
            parentCheck[pName] = (parentCheck[pName] || 0) + 1;
        }
        pos = after;
    }
}
console.log('Parent types of geometry sub-records:', parentCheck);

// ── KEY: check which geometry entities are under FACE vs EDGE parent blocks ──
console.log('\n--- Geometry sub-record parents per entity type ---');
for (let i = 0; i < sents.length; i++) {
    const blockStart = sents[i] + 6;
    const blockEnd = (i + 1 < sents.length) ? sents[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    if (block.length < 8 || block.readUInt32BE(0) !== 3) continue;
    
    const primaryType = block[5];
    if (primaryType !== 0x10 && primaryType !== 0x0f) continue; // Only EDGE and FACE
    const primaryId = block.readUInt16BE(6);
    
    // Find sub-records
    const recs = [];
    let ss = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_SEP, ss);
        if (sepIdx < 0) break;
        ss = sepIdx + 6;
        if (ss + 2 > block.length) break;
        if (block[ss] === 0x00 && (block[ss + 1] === 0x1e || block[ss + 1] === 0x1f)) {
            const subType = block[ss + 1];
            const subId = block.readUInt16BE(ss + 2);
            // Find 0x2B marker and count floats
            const subData = block.subarray(ss + 4);
            const markerIdx = subData.indexOf(0x2b);
            let nFloats = 0;
            if (markerIdx >= 0) {
                for (let off = markerIdx + 1; off + 8 <= subData.length; off += 8) {
                    const val = subData.readDoubleBE(off);
                    if (!isFinite(val) || Math.abs(val) > 1e6) break;
                    nFloats++;
                }
            }
            const pName = TYPE_NAMES[primaryType];
            if (i < sents.length && recs.length < 100) {
                recs.push({ pName, primaryId, subType, subId, nFloats });
            }
        }
    }
    
    // Print first few interesting blocks
    if (recs.length > 0) {
        for (const r of recs.slice(0, 2)) {
            console.log(`  Parent: ${r.pName}#${r.primaryId} → sub 0x${r.subType.toString(16)}#${r.subId} (${r.nFloats} floats)`);
        }
    }
}
