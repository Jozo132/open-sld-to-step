#!/usr/bin/env node
/**
 * investigate75.mjs — Examine type 0x20 entities + FTC_11 diagnosis
 * Clean-room analysis of public-domain NIST test files.
 *
 * Type 0x20: 88 entities in CTC_02, all with geometry markers — unknown entity type
 * FTC_11: 27.4% score (worst performer), all planes+cylinders, ceiling 100%
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
const REF_DIR_CTC = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions');
const REF_DIR_FTC = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'FTC Definitions');
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

// ═══════════════════════════════════════════════════════════════
// Part 1: Examine type 0x20 entities in CTC_02
// ═══════════════════════════════════════════════════════════════
console.log('═══ PART 1: Type 0x20 entities in CTC_02 ═══\n');

const ctc02 = fs.readFileSync(path.join(NIST_DIR, 'nist_ctc_02_asme1_rc_sw1802.SLDPRT'));
const ctc02result = SldprtContainerParser.extractParasolid(ctc02);
const ents02 = extractEntities(ctc02result.data);
const type20 = ents02.filter(e => e.type === 0x20);

console.log(`Type 0x20 entity count: ${type20.length}`);

// Float histogram
const floatHist = {};
for (const ent of type20) {
    const result = readGeomFloats(ent.data);
    const key = result ? result.floats.length : 'no-marker';
    floatHist[key] = (floatHist[key] || 0) + 1;
}
console.log(`Float histogram: ${JSON.stringify(floatHist)}`);

// Print first 5 entities with all float values
for (let i = 0; i < Math.min(5, type20.length); i++) {
    const ent = type20[i];
    const result = readGeomFloats(ent.data);
    console.log(`\n  Entity id=${ent.id}, dataLen=${ent.data.length}`);
    console.log(`    hex[0..60]: ${ent.data.subarray(0, Math.min(60, ent.data.length)).toString('hex')}`);
    if (result) {
        console.log(`    marker=0x${result.marker.toString(16)} at offset ${result.markerIdx}`);
        console.log(`    floats (${result.floats.length}): ${result.floats.map(f => f.toFixed(6)).join(', ')}`);
        console.log(`    floats×1000(mm): ${result.floats.map(f => (f*1000).toFixed(2)).join(', ')}`);
    }
}

// Check if any could be cones (11+ floats with non-zero float[10])
let potentialCones = 0;
for (const ent of type20) {
    const result = readGeomFloats(ent.data);
    if (result && result.floats.length >= 11 && Math.abs(result.floats[10]) > 1e-6) {
        potentialCones++;
        if (potentialCones <= 3) {
            console.log(`\n  POTENTIAL CONE 0x20 id=${ent.id}: float[10]=${result.floats[10]} (${(result.floats[10]*180/Math.PI).toFixed(2)}°)`);
            console.log(`    all floats: ${result.floats.map(f => f.toFixed(6)).join(', ')}`);
        }
    }
}
console.log(`\nPotential cones in 0x20: ${potentialCones}`);

// ═══════════════════════════════════════════════════════════════
// Part 2: Type 0x20 across ALL files
// ═══════════════════════════════════════════════════════════════
console.log('\n\n═══ PART 2: Type 0x20 across all files ═══\n');

const allFiles = fs.readdirSync(NIST_DIR).filter(f => f.endsWith('.SLDPRT')).sort();
for (const file of allFiles) {
    const buf = fs.readFileSync(path.join(NIST_DIR, file));
    const result = SldprtContainerParser.extractParasolid(buf);
    const ents = extractEntities(result.data);
    const t20 = ents.filter(e => e.type === 0x20);
    const t26 = ents.filter(e => e.type === 0x26);
    const t33 = ents.filter(e => e.type === 0x33);
    const name = file.replace('nist_', '').replace('_asme1_rd_sw1802.SLDPRT', '').replace('_asme1_rc_sw1802.SLDPRT', '').replace('_asme1_rb_sw1802.SLDPRT', '').toUpperCase();
    console.log(`  ${name}: 0x20=${t20.length}, 0x26=${t26.length}, 0x33=${t33.length}`);
}

// ═══════════════════════════════════════════════════════════════
// Part 3: FTC_11 deep diagnosis
// ═══════════════════════════════════════════════════════════════
console.log('\n\n═══ PART 3: FTC_11 diagnosis ═══\n');

const ftc11 = fs.readFileSync(path.join(NIST_DIR, 'nist_ftc_11_asme1_rb_sw1802.SLDPRT'));
const ftc11result = SldprtContainerParser.extractParasolid(ftc11);
const psBuf = ftc11result.data;
console.log(`FTC_11 PS buffer: ${psBuf.length} bytes, format: ${ftc11result.format}`);

const ents11 = extractEntities(psBuf);
const typeHist = {};
for (const e of ents11) {
    const key = `0x${e.type.toString(16).padStart(2, '0')}`;
    typeHist[key] = (typeHist[key] || 0) + 1;
}
console.log(`Entity types: ${JSON.stringify(typeHist)}`);

const type1E = ents11.filter(e => e.type === 0x1e);
const type1F = ents11.filter(e => e.type === 0x1f);
console.log(`0x1E: ${type1E.length}, 0x1F: ${type1F.length}`);

// Float histograms for 0x1E and 0x1F
const hist1E = {}, hist1F = {};
for (const ent of type1E) {
    const r = readGeomFloats(ent.data);
    const key = r ? r.floats.length : 'none';
    hist1E[key] = (hist1E[key] || 0) + 1;
}
for (const ent of type1F) {
    const r = readGeomFloats(ent.data);
    const key = r ? r.floats.length : 'none';
    hist1F[key] = (hist1F[key] || 0) + 1;
}
console.log(`0x1E floats: ${JSON.stringify(hist1E)}`);
console.log(`0x1F floats: ${JSON.stringify(hist1F)}`);

// Use production parser
const parser = new ParasolidParser(psBuf);
const model = parser.parse();
console.log(`\nProduction parser output:`);
console.log(`  Vertices: ${model.vertices.length}`);
console.log(`  Surfaces: ${model.surfaces.length}`);
for (const s of model.surfaces) {
    console.log(`    id=${s.id} type=${s.surfaceType} ${JSON.stringify(s.params)}`);
}

// Parse reference
const refPath11 = path.join(REF_DIR_FTC, 'nist_ftc_11_asme1_rb.stp');
const refText = fs.readFileSync(refPath11, 'utf-8');
const refLines = refText.split('\n');
const planes = refLines.filter(l => l.includes('PLANE(')).length;
const cyls = refLines.filter(l => l.includes('CYLINDRICAL_SURFACE(')).length;
const cones = refLines.filter(l => l.includes('CONICAL_SURFACE(')).length;
const faces = refLines.filter(l => l.includes('ADVANCED_FACE(')).length;
console.log(`\nReference: ${planes} planes, ${cyls} cylinders, ${cones} cones, ${faces} faces`);

// Print all 0x1E entities with their floats
console.log(`\n0x1E entities detail:`);
for (const ent of type1E) {
    const r = readGeomFloats(ent.data);
    if (r) {
        const mm = r.floats.map(f => (f * 1000).toFixed(2));
        console.log(`  id=${ent.id} marker=0x${r.marker.toString(16)} floats[${r.floats.length}]: ${mm.join(', ')}`);
    } else {
        console.log(`  id=${ent.id} no-marker dataLen=${ent.data.length}`);
    }
}
console.log(`\n0x1F entities detail:`);
for (const ent of type1F) {
    const r = readGeomFloats(ent.data);
    if (r) {
        const mm = r.floats.map(f => (f * 1000).toFixed(2));
        console.log(`  id=${ent.id} marker=0x${r.marker.toString(16)} floats[${r.floats.length}]: ${mm.join(', ')}`);
    } else {
        console.log(`  id=${ent.id} no-marker dataLen=${ent.data.length}`);
    }
}
