#!/usr/bin/env node
/**
 * investigate57.mjs — Check actual semiAngle values in type-0x1F 11-float entities
 * NIST test files are US Government works (public domain).
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
const PS_TO_MM = 1000;

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');

function extractEntities(psBuf) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx += 6; }
    
    const entities = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + 6;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : psBuf.length;
        const block = psBuf.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        const subRecords = [];
        let searchStart = 0;
        while (true) {
            const sepIdx = block.indexOf(SUB_RECORD_SEP, searchStart);
            if (sepIdx < 0) { subRecords.push(block.subarray(searchStart)); break; }
            subRecords.push(block.subarray(searchStart, sepIdx));
            searchStart = sepIdx + 6;
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
    return entities;
}

function readGeomFloats(data) {
    for (const marker of [0x2b, 0x2d]) {
        const mIdx = data.indexOf(marker);
        if (mIdx < 0) continue;
        const start = mIdx + 1;
        const maxFloats = Math.floor((data.length - start) / 8);
        const floats = [];
        for (let i = 0; i < maxFloats; i++) {
            const v = data.readDoubleBE(start + i * 8);
            if (!isFinite(v) || Math.abs(v) > 1e6) break;
            floats.push(v);
        }
        if (floats.length >= 7) return { floats, marker };
    }
    return null;
}

// Check CTC_02 semiAngle distribution
for (const base of ['nist_ctc_02_asme1_rc_sw1802', 'nist_ctc_04_asme1_rd_sw1802']) {
    const sldprtPath = path.join(NIST_DIR, base + '.SLDPRT');
    if (!fs.existsSync(sldprtPath)) continue;
    
    const buf = fs.readFileSync(sldprtPath);
    const result = SldprtContainerParser.extractParasolid(buf);
    const allEntities = extractEntities(result.data);
    
    const type1F = allEntities.filter(e => e.type === 0x1f);
    console.log(`\n=== ${base} ===`);
    console.log(`Type 0x1F: ${type1F.length}`);
    
    // Show semiAngle distribution for 11-float entities
    const semiAngles = new Map();
    let count11 = 0;
    for (const ent of type1F) {
        const g = readGeomFloats(ent.data);
        if (!g || g.floats.length !== 11) continue;
        count11++;
        const sa = g.floats[10];
        const key = sa.toExponential(3);
        semiAngles.set(key, (semiAngles.get(key) || 0) + 1);
    }
    console.log(`11-float entities: ${count11}`);
    console.log('semiAngle distribution:');
    [...semiAngles.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v} entities`));
    
    // Show first few with details
    console.log('\nFirst 5 detailed:');
    let shown = 0;
    for (const ent of type1F) {
        const g = readGeomFloats(ent.data);
        if (!g || g.floats.length !== 11) continue;
        if (shown++ >= 5) break;
        const f = g.floats;
        // origin(3) + axis(3) + refdir(3) + radius + semiAngle
        console.log(`  id=${ent.id} origin=(${(f[0]*PS_TO_MM).toFixed(1)}, ${(f[1]*PS_TO_MM).toFixed(1)}, ${(f[2]*PS_TO_MM).toFixed(1)}) axis=(${f[3].toFixed(3)}, ${f[4].toFixed(3)}, ${f[5].toFixed(3)}) refdir=(${f[6].toFixed(3)}, ${f[7].toFixed(3)}, ${f[8].toFixed(3)}) r=${(f[9]*PS_TO_MM).toFixed(3)} sa=${f[10].toExponential(6)}`);
    }
    
    // Now check: what about entities with marker-less data? Or different float layouts?
    // Check raw byte patterns after known markers 
    console.log('\n=== Check type-0x1F entities for alternate cone encoding ===');
    let altCones = 0;
    for (const ent of type1F) {
        // Skip entities already handled
        const g = readGeomFloats(ent.data);
        if (g && g.floats.length >= 11) continue;
        
        // Check if there are floats that have cone-like values
        // Try reading floats at various offsets
        for (let off = 0; off + 88 <= ent.data.length; off += 2) {
            const vals = [];
            for (let i = 0; i < 11; i++) {
                const v = ent.data.readDoubleBE(off + i * 8);
                if (!isFinite(v) || Math.abs(v) > 1e6) break;
                vals.push(v);
            }
            if (vals.length < 11) continue;
            const sa = vals[10];
            if (Math.abs(sa) > 0.01 && Math.abs(sa) < 2.0) {
                altCones++;
                if (altCones <= 3) {
                    console.log(`  id=${ent.id} off=${off} sa=${sa.toFixed(4)} r=${(vals[9]*PS_TO_MM).toFixed(2)} origin=(${(vals[0]*PS_TO_MM).toFixed(1)},${(vals[1]*PS_TO_MM).toFixed(1)},${(vals[2]*PS_TO_MM).toFixed(1)})`);
                }
            }
        }
    }
    console.log(`Alternate cone-like patterns: ${altCones}`);
    
    // Also check ALL entity types for cone-like 11-float patterns
    console.log('\n=== ALL entity types with 11-float cone-like patterns ===');
    for (const type of [0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x20, 0x26, 0x32, 0x33]) {
        const ents = allEntities.filter(e => e.type === type);
        let cones = 0;
        for (const ent of ents) {
            const g = readGeomFloats(ent.data);
            if (!g || g.floats.length !== 11) continue;
            if (Math.abs(g.floats[10]) > 0.01) cones++;
        }
        if (cones > 0) {
            const name = { 0x32: 'type50', 0x33: 'type51' }[type] || `type0x${type.toString(16)}`;
            console.log(`  ${name}: ${cones} cone-like entities`);
        }
    }
}
