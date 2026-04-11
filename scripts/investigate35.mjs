/**
 * investigate35.mjs — Compare cylinder radii between PS extraction and reference STEP
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

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const sldprtPath = path.join(NIST_DIR, 'SolidWorks MBD 2018', 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');
const refStepPath = path.join(NIST_DIR, 'CTC Definitions', 'nist_ctc_01_asme1_rd.stp');

// ── Extract reference cylinder radii from STEP
const refStep = fs.readFileSync(refStepPath, 'utf-8');
const refRadii = [];
for (const m of refStep.matchAll(/CYLINDRICAL_SURFACE\('',#\d+,([\d.eE+-]+)\)/g)) {
    refRadii.push(parseFloat(m[1]));
}
console.log(`Reference STEP: ${refRadii.length} cylinders`);
const uniqueRefRadii = [...new Set(refRadii.map(r => r.toFixed(4)))].sort();
console.log(`  Unique radii (mm): ${uniqueRefRadii.join(', ')}`);

// ── Extract raw geometry from Parasolid
const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const psBuf = result.data;

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

// Find all sentinel positions
const sents = [];
let idx = 0;
while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) {
    sents.push(idx);
    idx += SENTINEL.length;
}

// Collect all 11-float entities
const cylEntities = [];
for (let i = 0; i < sents.length; i++) {
    const blockStart = sents[i] + SENTINEL.length;
    const blockEnd = (i + 1 < sents.length) ? sents[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);

    // Split by sub-record separator
    const recs = [];
    let ss = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_SEP, ss);
        if (sepIdx < 0) { recs.push(block.subarray(ss)); break; }
        recs.push(block.subarray(ss, sepIdx));
        ss = sepIdx + SUB_SEP.length;
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

        if (type !== 0x1e && type !== 0x1f) continue;

        const markerIdx = data.indexOf(0x2b);
        if (markerIdx < 0) continue;

        const floatStart = markerIdx + 1;
        const floats = [];
        for (let off = floatStart; off + 8 <= data.length; off += 8) {
            const val = data.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }

        if (floats.length === 11 || floats.length === 12) {
            cylEntities.push({ id, floatCount: floats.length, floats });
        }
    }
}

console.log(`\nParasolid: ${cylEntities.length} entities with 11-12 floats`);

// Print first few with all float values
console.log('\nFirst 10 entities (raw meter values):');
for (const e of cylEntities.slice(0, 10)) {
    const origin = `(${e.floats[0].toFixed(6)}, ${e.floats[1].toFixed(6)}, ${e.floats[2].toFixed(6)})`;
    const axis = `(${e.floats[3].toFixed(6)}, ${e.floats[4].toFixed(6)}, ${e.floats[5].toFixed(6)})`;
    const refdir = `(${e.floats[6].toFixed(6)}, ${e.floats[7].toFixed(6)}, ${e.floats[8].toFixed(6)})`;
    const f9 = e.floats[9];
    const f10 = e.floats[10];
    console.log(`  id=${e.id} nf=${e.floatCount}: origin=${origin} axis=${axis} refdir=${refdir} f9=${f9.toFixed(6)} f10=${f10.toFixed(6)}`);
}

// Collect all unique f9 values (×1000 for mm) and compare to reference
const psRadii_f9 = cylEntities.map(e => e.floats[9] * 1000);
const uniquePS_f9 = [...new Set(psRadii_f9.map(r => r.toFixed(4)))].sort();
console.log(`\nPS floats[9] × 1000 (unique): ${uniquePS_f9.join(', ')}`);

// Try other float positions for radius
for (let fi = 6; fi < 12; fi++) {
    const vals = cylEntities.map(e => e.floats[fi] !== undefined ? e.floats[fi] * 1000 : NaN).filter(v => isFinite(v));
    const uniqueVals = [...new Set(vals.map(r => r.toFixed(2)))].sort();
    // Check overlap with reference
    const refSet = new Set(uniqueRefRadii);
    const overlap = uniqueVals.filter(v => refSet.has(parseFloat(v).toFixed(4)));
    console.log(`  floats[${fi}] × 1000: ${uniqueVals.length} unique, ${overlap.length} match ref  [${uniqueVals.slice(0, 8).join(', ')}${uniqueVals.length > 8 ? '...' : ''}]`);
}
