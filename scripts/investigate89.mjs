#!/usr/bin/env node
// Clean-room analysis of public-domain NIST test files.
/**
 * investigate89.mjs — Inspect FTC_11 type-0x1F payloads for torus clues.
 *
 * Goal:
 * 1. Dump all FTC_11 type-0x1F payload float arrays.
 * 2. Highlight the non-11-float record.
 * 3. Print reference toroidal surface lines from the STEP file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);

const FILE = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ftc_11_asme1_rb_sw1802.SLDPRT',
);
const REF = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
    'nist_ftc_11_asme1_rb.stp',
);

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

function readGeomFloats(data) {
    for (const marker of [0x2b, 0x2d]) {
        const markerIdx = data.indexOf(marker);
        if (markerIdx < 0 || markerIdx + 1 + 8 > data.length) continue;
        const floats = [];
        for (let off = markerIdx + 1; off + 8 <= data.length; off += 8) {
            const value = data.readDoubleBE(off);
            if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
            floats.push(value);
        }
        if (floats.length >= 3) return { marker, floats };
    }
    return null;
}

function extract1fEntities(ps) {
    const entities = [];
    const sentPositions = [];
    let index = 0;
    while ((index = ps.indexOf(SENTINEL, index)) >= 0) {
        sentPositions.push(index);
        index += SENTINEL.length;
    }

    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + SENTINEL.length;
        const blockEnd = i + 1 < sentPositions.length ? sentPositions[i + 1] : ps.length;
        const block = ps.subarray(blockStart, blockEnd);
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
                if (rec[5] !== 0x1f) continue;
                entities.push({ id: rec.readUInt16BE(6), data: rec.subarray(8) });
            } else {
                if (rec.length < 4 || rec[0] !== 0x00 || rec[1] !== 0x1f) continue;
                entities.push({ id: rec.readUInt16BE(2), data: rec.subarray(4) });
            }
        }
    }

    return entities;
}

const buf = fs.readFileSync(FILE);
const result = SldprtContainerParser.extractParasolid(buf);
if (!result) {
    console.log('No Parasolid data extracted.');
    process.exit(1);
}

const ps = result.data;
const entities = extract1fEntities(ps);

console.log(`PS buffer: ${ps.length} bytes`);
console.log(`type-0x1F entities: ${entities.length}`);

for (const entity of entities) {
    const geom = readGeomFloats(entity.data);
    if (!geom) {
        console.log(`\nid=${entity.id}: no geometry floats`);
        continue;
    }

    const valuesMeters = geom.floats.map(value => Number(value.toPrecision(12)));
    const valuesMm = geom.floats.map(value => Number((value * 1000).toPrecision(10)));
    console.log(`\nid=${entity.id} count=${geom.floats.length} marker=${geom.marker === 0x2b ? '+' : '-'}`);
    console.log(`  meters: ${JSON.stringify(valuesMeters)}`);
    console.log(`  mm:     ${JSON.stringify(valuesMm)}`);
}

const refText = fs.readFileSync(REF, 'utf-8');
const torusLines = refText
    .split(/\r?\n/)
    .filter(line => line.includes('TOROIDAL_SURFACE'));

console.log('\nReference toroidal surfaces:');
for (const line of torusLines) {
    console.log(`  ${line.trim()}`);
}