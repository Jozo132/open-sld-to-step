#!/usr/bin/env bun
/**
 * investigate169.mjs — Census unsupported surface-like geometry payloads.
 *
 * Goal:
 * 1. Scan public NIST samples for 4-float, 8-float, and long geometry-marker
 *    payloads in the same raw channels already used for cylinders/cones.
 * 2. Compare those candidate payload counts against reference sphere, torus,
 *    and B-spline surface counts from the STEP definitions.
 * 3. Identify whether spheres, direct tori, or B-spline surfaces have a stable
 *    clean-room marker signature worth implementing next.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    ENTITY_BSPLINE,
    ENTITY_SURFACE,
    ROOT,
    getAllEntities,
    listSamplePaths,
    loadSample,
} from './_payload-gap-lib.mjs';

const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const FLOAT_SCAN_LIMIT = 32;
const MIN_RADIUS_METERS = 0.0005;
const MAX_RADIUS_METERS = 1;

function referencePathForSample(fileName) {
    const lower = fileName.toLowerCase();
    const definitionDir = lower.includes('_ctc_') ? 'CTC Definitions' : 'FTC Definitions';
    return path.join(
        REFERENCE_ROOT,
        definitionDir,
        lower.replace('_sw1802.sldprt', '.stp'),
    );
}

function extractJoinedData(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return '';
    return normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
}

function countStepEntities(text) {
    const counts = {};
    const joined = extractJoinedData(text);
    for (const type of ['SPHERICAL_SURFACE', 'TOROIDAL_SURFACE', 'B_SPLINE_SURFACE_WITH_KNOTS']) {
        const matches = joined.match(new RegExp(`${type}\\s*\\(`, 'gi'));
        counts[type] = matches ? matches.length : 0;
    }
    return counts;
}

function readAllMarkerPayloads(data) {
    const results = [];

    for (const marker of [0x2b, 0x2d]) {
        let markerIdx = -1;
        while ((markerIdx = data.indexOf(marker, markerIdx + 1)) >= 0) {
            if (markerIdx + 1 + 8 > data.length) continue;

            const floats = [];
            for (
                let offset = markerIdx + 1;
                offset + 8 <= data.length && floats.length < FLOAT_SCAN_LIMIT;
                offset += 8
            ) {
                const value = data.readDoubleBE(offset);
                if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
                floats.push(value);
            }

            if (floats.length >= 4) {
                results.push({
                    marker,
                    markerIdx,
                    floats,
                });
            }
        }
    }

    return results;
}

function axisMagnitude(floats) {
    return Math.hypot(floats[3] ?? 0, floats[4] ?? 0, floats[5] ?? 0);
}

function roundKey(value, digits = 3) {
    return Number(value.toFixed(digits));
}

function incrementSignature(map, key, payload) {
    const existing = map.get(key) ?? { count: 0, example: payload };
    existing.count++;
    map.set(key, existing);
}

function summarizeSignatures(map, limit = 5) {
    return [...map.entries()]
        .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([key, value]) => ({ key, count: value.count, example: value.example }));
}

function makePayloadSummary() {
    return {
        sphere4: 0,
        torus8: 0,
        bsplineLike: 0,
        lengths: new Map(),
        sphereSignatures: new Map(),
        torusSignatures: new Map(),
        bsplineSignatures: new Map(),
    };
}

function recordPayload(summary, payload) {
    const length = payload.floats.length;
    summary.lengths.set(length, (summary.lengths.get(length) ?? 0) + 1);

    if (length === 4) {
        const radius = payload.floats[3];
        if (radius >= MIN_RADIUS_METERS && radius < MAX_RADIUS_METERS) {
            summary.sphere4++;
            const key = [
                roundKey(payload.floats[0] * 1000, 1),
                roundKey(payload.floats[1] * 1000, 1),
                roundKey(payload.floats[2] * 1000, 1),
                roundKey(radius * 1000, 3),
            ].join('|');
            incrementSignature(summary.sphereSignatures, key, payload);
        }
    }

    if (length === 8) {
        const axisMag = axisMagnitude(payload.floats);
        const majorRadius = payload.floats[6];
        const minorRadius = payload.floats[7];
        if (axisMag >= 0.5 && axisMag <= 1.5 &&
            majorRadius >= MIN_RADIUS_METERS && minorRadius >= MIN_RADIUS_METERS &&
            majorRadius < MAX_RADIUS_METERS && minorRadius < MAX_RADIUS_METERS &&
            majorRadius > minorRadius) {
            summary.torus8++;
            const key = [
                roundKey(payload.floats[0] * 1000, 1),
                roundKey(payload.floats[1] * 1000, 1),
                roundKey(payload.floats[2] * 1000, 1),
                roundKey(majorRadius * 1000, 3),
                roundKey(minorRadius * 1000, 3),
            ].join('|');
            incrementSignature(summary.torusSignatures, key, payload);
        }
    }

    if (length >= 13) {
        summary.bsplineLike++;
        const key = `${length}|${payload.marker}`;
        incrementSignature(summary.bsplineSignatures, key, payload);
    }
}

function scanEntityPayloads(parser) {
    const entitySummary = makePayloadSummary();
    const entities = getAllEntities(parser)
        .filter((entity) => entity.type === ENTITY_SURFACE || entity.type === ENTITY_BSPLINE);

    for (const entity of entities) {
        for (const payload of readAllMarkerPayloads(entity.data)) {
            recordPayload(entitySummary, payload);
        }
    }

    return entitySummary;
}

function scanLinearRecordWindows(parser, records) {
    const summary = makePayloadSummary();
    const ordered = records.slice().sort((left, right) => left.offset - right.offset);

    for (let index = 0; index < ordered.length; index++) {
        const record = ordered[index];
        const nextOffset = ordered[index + 1]?.offset ?? parser.buf.length;
        const window = parser.buf.subarray(record.offset, nextOffset);
        for (const payload of readAllMarkerPayloads(window)) {
            recordPayload(summary, payload);
        }
    }

    return summary;
}

function dominantLengths(summary, limit = 4) {
    return [...summary.lengths.entries()]
        .sort((left, right) => right[1] - left[1] || left[0] - right[0])
        .slice(0, limit)
        .map(([length, count]) => `${length}:${count}`)
        .join(', ');
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters);

console.log('investigate169 — unsupported-surface marker census');
console.log('Clean-room basis: scan raw geometry marker payload lengths in the public NIST corpus.');
console.log('Columns: reference sphere/torus/bspline counts vs candidate 4-float / 8-float / long payload counts.');

let totalRefSphere = 0;
let totalRefTorus = 0;
let totalRefBspline = 0;
let totalEntitySphere = 0;
let totalCompactSphere = 0;
let totalPackedSphere = 0;
let totalEntityTorus = 0;
let totalCompactTorus = 0;
let totalPackedTorus = 0;
let totalEntityBspline = 0;
let totalCompactBspline = 0;
let totalPackedBspline = 0;

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const referenceCounts = countStepEntities(fs.readFileSync(referencePathForSample(fileName), 'utf8'));
    const refSphere = referenceCounts.SPHERICAL_SURFACE || 0;
    const refTorus = referenceCounts.TOROIDAL_SURFACE || 0;
    const refBspline = referenceCounts.B_SPLINE_SURFACE_WITH_KNOTS || 0;
    const entitySummary = scanEntityPayloads(parser);
    const compactSummary = scanLinearRecordWindows(parser, parser.parseCompactGeometryLikeRecords());
    const packedSummary = scanLinearRecordWindows(parser, parser.parsePackedGeometryLikeRecords());

    totalRefSphere += refSphere;
    totalRefTorus += refTorus;
    totalRefBspline += refBspline;
    totalEntitySphere += entitySummary.sphere4;
    totalCompactSphere += compactSummary.sphere4;
    totalPackedSphere += packedSummary.sphere4;
    totalEntityTorus += entitySummary.torus8;
    totalCompactTorus += compactSummary.torus8;
    totalPackedTorus += packedSummary.torus8;
    totalEntityBspline += entitySummary.bsplineLike;
    totalCompactBspline += compactSummary.bsplineLike;
    totalPackedBspline += packedSummary.bsplineLike;

    const shortName = fileName.replace('_sw1802.SLDPRT', '');
    console.log(`\n== ${shortName} ==`);
    console.log(`ref sphere=${refSphere} torus=${refTorus} bspline=${refBspline}`);
    console.log(`entity candidates: sphere4=${entitySummary.sphere4} torus8=${entitySummary.torus8} long=${entitySummary.bsplineLike} lengths=[${dominantLengths(entitySummary)}]`);
    console.log(`compact candidates: sphere4=${compactSummary.sphere4} torus8=${compactSummary.torus8} long=${compactSummary.bsplineLike} lengths=[${dominantLengths(compactSummary)}]`);
    console.log(`packed candidates: sphere4=${packedSummary.sphere4} torus8=${packedSummary.torus8} long=${packedSummary.bsplineLike} lengths=[${dominantLengths(packedSummary)}]`);

    if (refSphere > 0 || entitySummary.sphere4 > 0 || compactSummary.sphere4 > 0 || packedSummary.sphere4 > 0) {
        const sphereLeaders = [
            ...summarizeSignatures(entitySummary.sphereSignatures, 2).map((entry) => ({ source: 'entity', ...entry })),
            ...summarizeSignatures(compactSummary.sphereSignatures, 2).map((entry) => ({ source: 'compact', ...entry })),
            ...summarizeSignatures(packedSummary.sphereSignatures, 2).map((entry) => ({ source: 'packed', ...entry })),
        ].slice(0, 4);
        if (sphereLeaders.length > 0) {
            console.log('top sphere-like signatures:');
            for (const leader of sphereLeaders) {
                console.log(`  - ${leader.source} x${leader.count}: ${leader.key}`);
            }
        }
    }

    if (refTorus > 0 || entitySummary.torus8 > 0 || compactSummary.torus8 > 0 || packedSummary.torus8 > 0) {
        const torusLeaders = [
            ...summarizeSignatures(entitySummary.torusSignatures, 2).map((entry) => ({ source: 'entity', ...entry })),
            ...summarizeSignatures(compactSummary.torusSignatures, 2).map((entry) => ({ source: 'compact', ...entry })),
            ...summarizeSignatures(packedSummary.torusSignatures, 2).map((entry) => ({ source: 'packed', ...entry })),
        ].slice(0, 4);
        if (torusLeaders.length > 0) {
            console.log('top torus-like signatures:');
            for (const leader of torusLeaders) {
                console.log(`  - ${leader.source} x${leader.count}: ${leader.key}`);
            }
        }
    }

    if (refBspline > 0) {
        const bsplineLeaders = [
            ...summarizeSignatures(entitySummary.bsplineSignatures, 2).map((entry) => ({ source: 'entity', ...entry })),
            ...summarizeSignatures(compactSummary.bsplineSignatures, 2).map((entry) => ({ source: 'compact', ...entry })),
            ...summarizeSignatures(packedSummary.bsplineSignatures, 2).map((entry) => ({ source: 'packed', ...entry })),
        ].slice(0, 4);
        if (bsplineLeaders.length > 0) {
            console.log('top long-payload signatures:');
            for (const leader of bsplineLeaders) {
                console.log(`  - ${leader.source} x${leader.count}: ${leader.key}`);
            }
        }
    }
}

console.log('\n== corpus totals ==');
console.log(`reference: sphere=${totalRefSphere} torus=${totalRefTorus} bspline=${totalRefBspline}`);
console.log(`entity candidates: sphere4=${totalEntitySphere} torus8=${totalEntityTorus} long=${totalEntityBspline}`);
console.log(`compact candidates: sphere4=${totalCompactSphere} torus8=${totalCompactTorus} long=${totalCompactBspline}`);
console.log(`packed candidates: sphere4=${totalPackedSphere} torus8=${totalPackedTorus} long=${totalPackedBspline}`);