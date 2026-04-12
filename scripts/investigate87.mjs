#!/usr/bin/env node
// Clean-room analysis of public-domain NIST test files.
/**
 * investigate87.mjs — Probe packed pre-sentinel POINT records in FTC_11.
 *
 * Goal:
 * 1. Find pre-sentinel 0x1D candidates in FTC_11.
 * 2. Test nearby coordinate offsets around each candidate header.
 * 3. Cross-match the decoded triplets against the reference STEP points.
 *
 * This avoids shell-escaping problems while debugging the packed-point layout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
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
const OFFSETS_TO_TEST = [14, 15, 16, 17, 18, 19, 20];

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
        const key = toKey(point, 9);
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(point);
    }
    return points;
}

function toKey(point, digits = 6) {
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

function findSentinels(buf) {
    const positions = [];
    let index = 0;
    while ((index = buf.indexOf(SENTINEL, index)) >= 0) {
        positions.push(index);
        index += SENTINEL.length;
    }
    return positions;
}

function findPackedPointCandidates(buf, end) {
    const candidates = [];
    for (let offset = 0; offset + 24 <= end; offset++) {
        if (buf[offset] !== 0x00 || buf[offset + 1] !== 0x1d || buf[offset + 2] !== 0xff) continue;
        candidates.push(offset);
    }
    return candidates;
}

function scoreOffsets(buf, candidates, referenceSet) {
    const scores = [];
    for (const delta of OFFSETS_TO_TEST) {
        const exactMatches = new Set();
        const decoded = [];
        for (const candidate of candidates) {
            const point = tryReadTriplet(buf, candidate + delta);
            if (!point) continue;
            decoded.push({ candidate, point });
            const key = toKey(point, 9);
            if (referenceSet.has(key)) exactMatches.add(key);
        }
        scores.push({ delta, decoded, exactMatches });
    }
    scores.sort((a, b) => b.exactMatches.size - a.exactMatches.size || b.decoded.length - a.decoded.length);
    return scores;
}

const buf = fs.readFileSync(FILE);
const result = SldprtContainerParser.extractParasolid(buf);
if (!result) {
    console.log('No Parasolid data extracted.');
    process.exit(1);
}

const ps = result.data;
const sentinels = findSentinels(ps);
const preSentinelEnd = sentinels[0] >= 0 ? sentinels[0] : ps.length;
const referencePoints = loadReferencePoints(REF);
const referenceSet = new Set(referencePoints.map(point => toKey(point, 9)));
const candidates = findPackedPointCandidates(ps, preSentinelEnd);
const scores = scoreOffsets(ps, candidates, referenceSet);

console.log(`PS buffer: ${ps.length} bytes`);
console.log(`First sentinel: 0x${preSentinelEnd.toString(16)} (${preSentinelEnd} bytes pre-sentinel)`);
console.log(`Reference points: ${referencePoints.length}`);
console.log(`Packed 0x1D candidates before first sentinel: ${candidates.length}`);

console.log('\n=== Offset scorecard ===');
for (const score of scores) {
    console.log(
        `  +${score.delta}: exact reference matches=${score.exactMatches.size}, decoded triplets=${score.decoded.length}`,
    );
}

console.log('\n=== Candidate detail (first 20) ===');
for (const candidate of candidates.slice(0, 20)) {
    const header = [...ps.subarray(candidate, Math.min(candidate + 24, preSentinelEnd))]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join(' ');
    console.log(`\n0x${candidate.toString(16)}: ${header}`);
    for (const delta of OFFSETS_TO_TEST) {
        const point = tryReadTriplet(ps, candidate + delta);
        if (!point) continue;
        const key = toKey(point, 9);
        const match = referenceSet.has(key) ? 'MATCH' : '';
        console.log(`  +${delta}: ${formatMm(point)} ${match}`.trimEnd());
    }
}

const best = scores[0];
console.log('\n=== Best offset detail ===');
console.log(`Best delta: +${best.delta}`);
console.log(`Exact reference matches: ${best.exactMatches.size}/${referencePoints.length}`);
for (const matchKey of [...best.exactMatches].sort()) {
    const [x, y, z] = matchKey.split(',').map(Number);
    console.log(`  ${formatMm({ x, y, z })}`);
}