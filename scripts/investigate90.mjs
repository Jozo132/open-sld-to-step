#!/usr/bin/env node
/**
 * investigate90.mjs — Probe shifted geometry starts for missing cone surfaces.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Compare current marker parsing with byte-shifted starts after each marker.
 * 2. Measure whether shifted starts recover plausible cone records.
 * 3. Print semi-angle distributions for cone-heavy files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);

const NIST_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
const TARGETS = [
    { name: 'CTC_02', file: 'nist_ctc_02_asme1_rc_sw1802.SLDPRT' },
    { name: 'CTC_04', file: 'nist_ctc_04_asme1_rd_sw1802.SLDPRT' },
    { name: 'FTC_07', file: 'nist_ftc_07_asme1_rd_sw1802.SLDPRT' },
    { name: 'FTC_11', file: 'nist_ftc_11_asme1_rb_sw1802.SLDPRT' },
];

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

function readFloatRun(data, start) {
    const floats = [];
    for (let off = start; off + 8 <= data.length; off += 8) {
        const value = data.readDoubleBE(off);
        if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
        floats.push(value);
    }
    return floats;
}

function scoreFloats(floats) {
    let score = floats.length;
    if ([7, 8, 11, 12, 13, 14, 15, 16, 17, 20, 22, 24].includes(floats.length)) {
        score += 5;
    }

    const tinyPenalty = floats
        .slice(0, Math.min(floats.length, 12))
        .filter(value => Math.abs(value) > 0 && Math.abs(value) < 1e-100)
        .length;
    score -= tinyPenalty * 3;

    if (floats.length >= 7) {
        const dirMag = Math.hypot(floats[3], floats[4], floats[5]);
        if (dirMag >= 0.5 && dirMag <= 1.5) score += 15;
    }

    if (floats.length >= 11) {
        const refMag = Math.hypot(floats[6], floats[7], floats[8]);
        const axisMag = Math.hypot(floats[3], floats[4], floats[5]);
        const dot = floats[3] * floats[6] + floats[4] * floats[7] + floats[5] * floats[8];
        const radius = floats[9];
        const semiAngle = floats[10];
        if (refMag >= 0.5 && refMag <= 1.5) score += 10;
        if (axisMag >= 0.5 && axisMag <= 1.5 && Math.abs(dot) <= 0.5) score += 10;
        if (radius > 0 && radius < 1e4) score += 10;
        if (Math.abs(semiAngle) < 10) score += 5;
        if (Math.abs(semiAngle) > 1e-6) score += 2;
    }

    return score;
}

function describeCandidate(entity, candidate) {
    const axisMag = candidate.floats.length >= 6
        ? Math.hypot(candidate.floats[3], candidate.floats[4], candidate.floats[5]) : 0;
    const refMag = candidate.floats.length >= 9
        ? Math.hypot(candidate.floats[6], candidate.floats[7], candidate.floats[8]) : 0;
    const radius = candidate.floats.length >= 10 ? candidate.floats[9] * 1000 : null;
    const semiAngle = candidate.floats.length >= 11 ? candidate.floats[10] : null;
    return [
        `type=0x${entity.type.toString(16)}`,
        `id=${entity.id}`,
        `marker=${candidate.marker === 0x2b ? '+' : '-'}`,
        `markerIdx=${candidate.markerIdx}`,
        `shift=${candidate.shift}`,
        `count=${candidate.floats.length}`,
        `score=${candidate.score}`,
        `axisMag=${axisMag.toFixed(3)}`,
        `refMag=${refMag.toFixed(3)}`,
        radius === null ? null : `r=${radius.toFixed(3)}mm`,
        semiAngle === null ? null : `angleDeg=${(semiAngle * 180 / Math.PI).toFixed(3)}`,
    ].filter(Boolean).join(' ');
}

function collectCandidates(data, shifts) {
    const candidates = [];
    for (const marker of [0x2b, 0x2d]) {
        let markerIdx = -1;
        while ((markerIdx = data.indexOf(marker, markerIdx + 1)) >= 0) {
            for (const shift of shifts) {
                const start = markerIdx + shift;
                if (start + 8 > data.length) continue;
                const floats = readFloatRun(data, start);
                if (floats.length < 3) continue;
                candidates.push({
                    marker,
                    markerIdx,
                    shift,
                    floats,
                    score: scoreFloats(floats),
                });
            }
        }
    }

    candidates.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.floats.length !== left.floats.length) return right.floats.length - left.floats.length;
        return right.markerIdx - left.markerIdx;
    });
    return candidates;
}

function isConeCandidate(candidate) {
    if (!candidate || candidate.floats.length < 11) return false;
    const axisMag = Math.hypot(candidate.floats[3], candidate.floats[4], candidate.floats[5]);
    const refMag = Math.hypot(candidate.floats[6], candidate.floats[7], candidate.floats[8]);
    const dot = candidate.floats[3] * candidate.floats[6]
        + candidate.floats[4] * candidate.floats[7]
        + candidate.floats[5] * candidate.floats[8];
    const radius = candidate.floats[9];
    const semiAngle = candidate.floats[10];
    return axisMag >= 0.5
        && axisMag <= 1.5
        && refMag >= 0.5
        && refMag <= 1.5
        && Math.abs(dot) <= 0.5
        && radius > 0
        && radius < 1e4
        && Math.abs(semiAngle) > 1e-6
        && Math.abs(semiAngle) < 2.0;
}

function summarizeAngles(candidates) {
    const bins = new Map();
    for (const candidate of candidates) {
        if (candidate.floats.length < 11) continue;
        const semiAngle = candidate.floats[10];
        const key = Math.abs(semiAngle) < 1e-6
            ? '0'
            : (Math.abs(semiAngle) * 180 / Math.PI).toFixed(3);
        bins.set(key, (bins.get(key) || 0) + 1);
    }
    return [...bins.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([angle, count]) => `${angle}deg:${count}`)
        .join(', ');
}

for (const target of TARGETS) {
    const filePath = path.join(NIST_DIR, target.file);
    const sldprt = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(sldprt);
    if (!extracted) {
        console.log(`SKIP ${target.name}: no Parasolid extracted`);
        continue;
    }

    const entities = extractEntities(extracted.data)
        .filter(entity => entity.type === 0x1e || entity.type === 0x1f);

    let currentCones = 0;
    let shiftedCones = 0;
    let improvedCones = 0;
    let improvedCandidates = 0;
    const examples = [];
    const currentAngles = [];
    const shiftedAngles = [];

    for (const entity of entities) {
        const current = collectCandidates(entity.data, [1])[0] || null;
        const shifted = collectCandidates(entity.data, [1, 2, 3, 4, 5, 6, 7, 8])[0] || null;

        if (current) currentAngles.push(current);
        if (shifted) shiftedAngles.push(shifted);
        if (isConeCandidate(current)) currentCones++;
        if (isConeCandidate(shifted)) shiftedCones++;

        if (shifted && current) {
            const currentCone = isConeCandidate(current);
            const shiftedCone = isConeCandidate(shifted);
            if (!currentCone && shiftedCone) {
                improvedCones++;
                if (examples.length < 8) {
                    examples.push({ entity, current, shifted });
                }
            }
            if (shifted.score > current.score || shifted.floats.length > current.floats.length) {
                improvedCandidates++;
            }
        }
    }

    console.log(`\n═══ ${target.name} ═══`);
    console.log(`geometry entities: ${entities.length}`);
    console.log(`current cone candidates: ${currentCones}`);
    console.log(`shifted cone candidates: ${shiftedCones}`);
    console.log(`entities improved by shifting: ${improvedCandidates}`);
    console.log(`new cones from shifting only: ${improvedCones}`);
    console.log(`current semi-angle bins: ${summarizeAngles(currentAngles) || 'none'}`);
    console.log(`shifted semi-angle bins: ${summarizeAngles(shiftedAngles) || 'none'}`);

    if (examples.length > 0) {
        console.log('examples where shifting unlocks a cone:');
        for (const example of examples) {
            console.log(`  current  ${describeCandidate(example.entity, example.current)}`);
            console.log(`  shifted  ${describeCandidate(example.entity, example.shifted)}`);
        }
    }
}