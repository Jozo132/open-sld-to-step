#!/usr/bin/env node
/**
 * investigate91.mjs — Compare unknown geometry-entity float slots to
 * reference cone radii and angles in CTC_02.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Parse reference cone radii and semi-angles from the STEP file.
 * 2. Inspect type-0x20/0x26/0x33 float payloads from the Parasolid binary.
 * 3. Report which float positions, if any, align with reference cone data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);

const PART = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ctc_02_asme1_rc_sw1802.SLDPRT',
);
const REF = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'CTC Definitions',
    'nist_ctc_02_asme1_rc.stp',
);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
const TARGET_TYPES = [0x20, 0x26, 0x33];

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
        const blockEnd = i + 1 < sentPositions.length ? sentPositions[i + 1] : buf.length;
        const block = buf.subarray(blockStart, blockEnd);

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
                entities.push({ type: rec[5], id: rec.readUInt16BE(6), data: rec.subarray(8) });
            } else {
                if (rec.length < 4 || rec[0] !== 0x00) continue;
                entities.push({ type: rec[1], id: rec.readUInt16BE(2), data: rec.subarray(4) });
            }
        }
    }

    return entities;
}

function scoreFloats(floats) {
    let score = floats.length;
    if ([7, 8, 11, 12, 13, 14, 15, 16, 17, 20, 22, 24].includes(floats.length)) {
        score += 5;
    }
    if (floats.length >= 7) {
        const dirMag = Math.hypot(floats[3], floats[4], floats[5]);
        if (dirMag >= 0.5 && dirMag <= 1.5) score += 15;
    }
    if (floats.length >= 11) {
        const refMag = Math.hypot(floats[6], floats[7], floats[8]);
        const axisMag = Math.hypot(floats[3], floats[4], floats[5]);
        const dot = floats[3] * floats[6] + floats[4] * floats[7] + floats[5] * floats[8];
        if (refMag >= 0.5 && refMag <= 1.5) score += 10;
        if (axisMag >= 0.5 && axisMag <= 1.5 && Math.abs(dot) <= 0.5) score += 10;
    }
    return score;
}

function readGeomFloats(data) {
    let best = null;
    for (const marker of [0x2b, 0x2d]) {
        let markerIdx = -1;
        while ((markerIdx = data.indexOf(marker, markerIdx + 1)) >= 0) {
            if (markerIdx + 1 + 8 > data.length) continue;
            const floats = [];
            for (let off = markerIdx + 1; off + 8 <= data.length; off += 8) {
                const value = data.readDoubleBE(off);
                if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
                floats.push(value);
            }
            if (floats.length < 3) continue;
            const score = scoreFloats(floats);
            if (!best || score > best.score || (score === best.score && floats.length > best.floats.length)) {
                best = { marker, markerIdx, floats, score };
            }
        }
    }
    return best;
}

function parseReferenceCones(text) {
    const cones = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/CONICAL_SURFACE\('',#\d+,([0-9.+\-Ee]+),([0-9.+\-Ee]+)\)/);
        if (!match) continue;
        cones.push({
            radiusMm: Number.parseFloat(match[1]),
            angleRad: Number.parseFloat(match[2]),
        });
    }
    return cones;
}

function nearestMatches(value, referenceValues, tolerance) {
    return referenceValues.filter(ref => Math.abs(ref - value) <= tolerance).length;
}

const buf = fs.readFileSync(PART);
const extracted = SldprtContainerParser.extractParasolid(buf);
if (!extracted) {
    console.log('No Parasolid extracted.');
    process.exit(1);
}

const entities = extractEntities(extracted.data);
const refCones = parseReferenceCones(fs.readFileSync(REF, 'utf-8'));
const refAngles = [...new Set(refCones.map(cone => Number(cone.angleRad.toFixed(9))))].sort((a, b) => a - b);
const refRadiiM = [...new Set(refCones.map(cone => Number((cone.radiusMm / 1000).toFixed(9))))].sort((a, b) => a - b);

console.log(`Reference cones: ${refCones.length}`);
console.log(`Reference angle set (rad): ${refAngles.join(', ')}`);
console.log(`Reference radius set (m): ${refRadiiM.join(', ')}`);

for (const type of TARGET_TYPES) {
    const items = entities
        .filter(entity => entity.type === type)
        .map(entity => ({ entity, geom: readGeomFloats(entity.data) }))
        .filter(item => item.geom && item.geom.floats.length >= 11);

    console.log(`\n=== type=0x${type.toString(16)} (${items.length} entities with geometry) ===`);
    if (items.length === 0) continue;

    const maxSlots = Math.max(...items.map(item => item.geom.floats.length));
    for (let slot = 9; slot < Math.min(maxSlots, 18); slot++) {
        let angleHits = 0;
        let radiusHits = 0;
        const sampleValues = [];

        for (const item of items) {
            const value = item.geom.floats[slot];
            if (value === undefined) continue;
            if (sampleValues.length < 6) sampleValues.push(value);
            angleHits += nearestMatches(value, refAngles, 0.002);
            radiusHits += nearestMatches(value, refRadiiM, 0.0025);
        }

        if (angleHits === 0 && radiusHits === 0) continue;
        console.log(
            `slot[${slot}] angleHits=${angleHits} radiusHits=${radiusHits} samples=${sampleValues.map(v => v.toFixed(6)).join(', ')}`,
        );
    }

    console.log('first 5 payload tails:');
    for (const item of items.slice(0, 5)) {
        const tail = item.geom.floats.slice(9).map(value => Number(value.toFixed(9)));
        console.log(`  id=${item.entity.id} count=${item.geom.floats.length} tail=${JSON.stringify(tail)}`);
    }
}