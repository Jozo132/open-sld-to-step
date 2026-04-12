#!/usr/bin/env node
// Clean-room analysis of public-domain NIST test files.
/**
 * investigate88.mjs — Compare FTC_11 point extraction methods.
 *
 * Goal:
 * 1. Compare the current parser output with structural/full-scan methods.
 * 2. Measure exact matches against FTC_11 reference STEP points.
 * 3. Provide a repeatable harness while iterating on ParasolidParser.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href,
);

const NIST_DIR = path.join(
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);
const STEP_DIR = path.join(
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
);
const FILE = path.join(NIST_DIR, 'nist_ftc_11_asme1_rb_sw1802.SLDPRT');
const REF = path.join(STEP_DIR, 'nist_ftc_11_asme1_rb.stp');
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);

function toKey(point, digits = 9) {
    return `${point.x.toFixed(digits)},${point.y.toFixed(digits)},${point.z.toFixed(digits)}`;
}

function toMm(point) {
    return {
        x: point.x * 1000,
        y: point.y * 1000,
        z: point.z * 1000,
    };
}

function formatMm(point) {
    const mm = toMm(point);
    return `(${mm.x.toFixed(3)}, ${mm.y.toFixed(3)}, ${mm.z.toFixed(3)}) mm`;
}

function tryReadTriplet(buf, offset) {
    if (offset + 24 > buf.length) return null;
    const x = buf.readDoubleBE(offset);
    const y = buf.readDoubleBE(offset + 8);
    const z = buf.readDoubleBE(offset + 16);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) return null;
    if (x === 0 && y === 0 && z === 0) return null;
    return { x, y, z };
}

function loadReferencePoints(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8');
    const regex = /CARTESIAN_POINT\([^,]*,\(([^)]+)\)\)/g;
    const points = [];
    const seen = new Set();
    let match;
    while ((match = regex.exec(text)) !== null) {
        const values = match[1].split(',').map(Number);
        if (values.length !== 3 || values.some(Number.isNaN)) continue;
        const point = { x: values[0] / 1000, y: values[1] / 1000, z: values[2] / 1000 };
        const key = toKey(point);
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(point);
    }
    return points;
}

function dedupe(points) {
    const unique = [];
    const seen = new Set();
    for (const point of points) {
        const key = toKey(point);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(point);
    }
    return unique;
}

function findFirstSentinel(buf) {
    const index = buf.indexOf(SENTINEL);
    return index >= 0 ? index : buf.length;
}

function extractPackedCandidates(buf, end, coordinateOffset) {
    const points = [];
    const seen = new Set();
    for (let offset = 0; offset + coordinateOffset + 24 <= end; offset++) {
        if (buf[offset] !== 0x00 || buf[offset + 1] !== 0x1d || buf[offset + 2] !== 0xff) continue;
        const point = tryReadTriplet(buf, offset + coordinateOffset);
        if (!point) continue;
        const key = toKey(point);
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(point);
    }
    return points;
}

function compare(label, points, referenceSet) {
    const unique = dedupe(points);
    const matches = new Set();
    for (const point of unique) {
        const key = toKey(point);
        if (referenceSet.has(key)) matches.add(key);
    }
    console.log(`\n=== ${label} ===`);
    console.log(`Generated unique points: ${unique.length}`);
    console.log(`Exact reference matches: ${matches.size}`);
    console.log('First 12 points:');
    for (const point of unique.slice(0, 12)) {
        const tag = referenceSet.has(toKey(point)) ? ' MATCH' : '';
        console.log(`  ${formatMm(point)}${tag}`);
    }
}

const buf = fs.readFileSync(FILE);
const result = SldprtContainerParser.extractParasolid(buf);
if (!result) {
    console.log('No Parasolid data extracted.');
    process.exit(1);
}

const ps = result.data;
const parser = new ParasolidParser(ps);
const referencePoints = loadReferencePoints(REF);
const referenceSet = new Set(referencePoints.map(point => toKey(point)));
const firstSentinel = findFirstSentinel(ps);

const structural = parser.extractStructuralPoints(2000) ?? [];
const extracted = parser.extractCoordinates(2000);
const fullScan = parser.extractFromFullScan(ps, 500);
const packed16 = extractPackedCandidates(ps, firstSentinel, 16);
const packed17 = extractPackedCandidates(ps, firstSentinel, 17);
const packed18 = extractPackedCandidates(ps, firstSentinel, 18);

console.log(`PS buffer: ${ps.length} bytes`);
console.log(`First sentinel: 0x${firstSentinel.toString(16)}`);
console.log(`Reference points: ${referencePoints.length}`);

compare('Current extractCoordinates()', extracted, referenceSet);
compare('extractStructuralPoints()', structural, referenceSet);
compare('extractFromFullScan()', fullScan, referenceSet);
compare('Packed candidates @ +16', packed16, referenceSet);
compare('Packed candidates @ +17', packed17, referenceSet);
compare('Packed candidates @ +18', packed18, referenceSet);