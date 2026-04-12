#!/usr/bin/env node
/**
 * investigate73.mjs — Why does cone extraction code find 0 cones?
 * Clean-room analysis of public-domain NIST test files.
 *
 * The ParasolidParser has cone extraction code (semiAngle != 0 for 11-float entities)
 * but finds 0 cones across all 11 NIST files. CTC_02 reference has 158 cones.
 * This script diagnoses: are there 11-float entities? What are their semiAngle values?
 * Do the sub-records contain entities with different float counts we're missing?
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

function extractEntities(buf) {
    const sentPositions = [];
    let idx = 0;
    while ((idx = buf.indexOf(SENTINEL, idx)) >= 0) {
        sentPositions.push(idx);
        idx += SENTINEL.length;
    }
    const entities = [];
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + SENTINEL.length;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : buf.length;
        const block = buf.subarray(blockStart, blockEnd);
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
                entities.push({ type: rec[5], id: rec.readUInt16BE(6), data: rec.subarray(8) });
            } else {
                if (rec.length < 4 || rec[0] !== 0x00) continue;
                entities.push({ type: rec[1], id: rec.readUInt16BE(2), data: rec.subarray(4) });
            }
        }
    }
    return entities;
}

function readGeomFloats(data) {
    for (const marker of [0x2b, 0x2d]) {
        const markerIdx = data.indexOf(marker);
        if (markerIdx < 0 || markerIdx + 1 + 8 > data.length) continue;
        const floats = [];
        for (let off = markerIdx + 1; off + 8 <= data.length; off += 8) {
            const val = data.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }
        if (floats.length >= 3) return { floats, marker, markerIdx };
    }
    return null;
}

// Also try reading ALL float64 from entity data without marker dependency
function readAllFloats(data) {
    const floats = [];
    for (let off = 0; off + 8 <= data.length; off += 8) {
        const val = data.readDoubleBE(off);
        if (isFinite(val) && Math.abs(val) < 1e6) {
            floats.push({ offset: off, value: val });
        }
    }
    return floats;
}

// Files with most cones in reference
const targetFiles = [
    { name: 'CTC_02', file: 'nist_ctc_02_asme1_rc_sw1802.SLDPRT', refCones: 158 },
    { name: 'CTC_04', file: 'nist_ctc_04_asme1_rd_sw1802.SLDPRT', refCones: 64 },
    { name: 'CTC_01', file: 'nist_ctc_01_asme1_rd_sw1802.SLDPRT', refCones: 2 },
    { name: 'FTC_07', file: 'nist_ftc_07_asme1_rd_sw1802.SLDPRT', refCones: 28 },
];

for (const file of targetFiles) {
    const filePath = path.join(NIST_DIR, file.file);
    if (!fs.existsSync(filePath)) { console.log(`SKIP ${file.name}: file not found at ${filePath}`); continue; }
    const sldprt = fs.readFileSync(filePath);
    const result = SldprtContainerParser.extractParasolid(sldprt);
    if (!result) { console.log(`SKIP ${file.name}: no Parasolid extracted`); continue; }
    const psBuf = result.data;
    
    const ents = extractEntities(psBuf);
    
    const type1E = ents.filter(e => e.type === 0x1e);
    const type1F = ents.filter(e => e.type === 0x1f);
    
    console.log(`\n═══ ${file.name} (ref cones: ${file.refCones}) ═══`);
    console.log(`  Type 0x1E entities: ${type1E.length}`);
    console.log(`  Type 0x1F entities: ${type1F.length}`);
    
    // Analyze float counts for both entity types
    const floatHistogram1E = {};
    const floatHistogram1F = {};
    
    let cones1E = 0, cones1F = 0;
    let cyls1E = 0, cyls1F = 0;
    
    for (const ent of type1E) {
        const result = readGeomFloats(ent.data);
        if (!result) { floatHistogram1E['no-marker'] = (floatHistogram1E['no-marker'] || 0) + 1; continue; }
        const key = result.floats.length;
        floatHistogram1E[key] = (floatHistogram1E[key] || 0) + 1;
        
        if (result.floats.length >= 11) {
            const semiAngle = result.floats[10];
            const radius = result.floats[9];
            if (Math.abs(semiAngle) < 1e-6) cyls1E++;
            else {
                cones1E++;
                console.log(`  0x1E CONE: id=${ent.id}, r=${(radius*1000).toFixed(2)}mm, angle=${(semiAngle*180/Math.PI).toFixed(2)}°, marker=0x${result.marker.toString(16)}`);
            }
        }
    }
    
    for (const ent of type1F) {
        const result = readGeomFloats(ent.data);
        if (!result) { floatHistogram1F['no-marker'] = (floatHistogram1F['no-marker'] || 0) + 1; continue; }
        const key = result.floats.length;
        floatHistogram1F[key] = (floatHistogram1F[key] || 0) + 1;
        
        if (result.floats.length >= 11) {
            const semiAngle = result.floats[10];
            const radius = result.floats[9];
            if (Math.abs(semiAngle) < 1e-6) cyls1F++;
            else {
                cones1F++;
                if (cones1F <= 5) {
                    console.log(`  0x1F CONE: id=${ent.id}, r=${(radius*1000).toFixed(2)}mm, angle=${(semiAngle*180/Math.PI).toFixed(2)}°, data[0..20]=${ent.data.subarray(0,20).toString('hex')}`);
                }
            }
        }
    }
    
    console.log(`  0x1E float histogram: ${JSON.stringify(floatHistogram1E)}`);
    console.log(`  0x1F float histogram: ${JSON.stringify(floatHistogram1F)}`);
    console.log(`  0x1E: ${cyls1E} cylinders, ${cones1E} cones`);
    console.log(`  0x1F: ${cyls1F} cylinders, ${cones1F} cones`);
    console.log(`  TOTAL cones found: ${cones1E + cones1F} (reference: ${file.refCones})`);
    
    // For entities without markers, try scanning all float64 values
    if (floatHistogram1E['no-marker'] || floatHistogram1F['no-marker']) {
        console.log(`\n  --- Entities WITHOUT 0x2B/0x2D marker ---`);
        let noMarkerCount = 0;
        for (const ent of [...type1E, ...type1F]) {
            const result = readGeomFloats(ent.data);
            if (result) continue;
            noMarkerCount++;
            if (noMarkerCount <= 3) {
                const allF = readAllFloats(ent.data);
                console.log(`  type=0x${ent.type.toString(16)} id=${ent.id} dataLen=${ent.data.length} floats(${allF.length}): ${allF.slice(0,15).map(f => f.value.toFixed(4)).join(', ')}`);
                console.log(`    hex[0..40]: ${ent.data.subarray(0, Math.min(40, ent.data.length)).toString('hex')}`);
            }
        }
        console.log(`  Total entities without markers: ${noMarkerCount}`);
    }
    
    // Also: look for 11-float entities where we break early due to >1e6 threshold
    console.log(`\n  --- Checking for premature float truncation ---`);
    let truncCount = 0;
    for (const ent of [...type1E, ...type1F]) {
        for (const marker of [0x2b, 0x2d]) {
            const markerIdx = ent.data.indexOf(marker);
            if (markerIdx < 0) continue;
            let count = 0;
            for (let off = markerIdx + 1; off + 8 <= ent.data.length; off += 8) {
                const val = ent.data.readDoubleBE(off);
                if (!isFinite(val) || Math.abs(val) > 1e6) {
                    if (count >= 3 && count < 11) {
                        truncCount++;
                        if (truncCount <= 5) {
                            // Read what WOULD have been the remaining floats
                            const remaining = [];
                            for (let off2 = off; off2 + 8 <= ent.data.length && remaining.length < 5; off2 += 8) {
                                remaining.push(ent.data.readDoubleBE(off2));
                            }
                            console.log(`  TRUNCATED at float[${count}]: type=0x${ent.type.toString(16)} id=${ent.id}, val=${val}, remaining: [${remaining.map(v => v.toExponential(3)).join(', ')}]`);
                        }
                    }
                    break;
                }
                count++;
            }
        }
    }
    console.log(`  Truncated entities (3-10 floats, stopped by >1e6 or !finite): ${truncCount}`);
}
