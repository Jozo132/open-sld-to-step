#!/usr/bin/env bun
/**
 * investigate195.mjs — Classify frame-like payload rows in FTC_07 wrappers.
 *
 * Goal:
 * 1. Scan the marker regions in selected wrappers for structured rows.
 * 2. Distinguish segment-like rows from frame-like rows.
 * 3. Determine whether wrapper 90 carries a unique local-frame transition.
 */
import { loadSample } from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const TARGET_IDS = [16, 51, 90];

function payloadStartOffset(record) {
    return 'trailer' in record ? record.offset + 20 : record.offset + 19;
}

function buildDirectRecordMap(parser, payload) {
    const direct = [
        ...parser.parseCompactGeometryLikeRecords(),
        ...parser.parsePackedGeometryLikeRecords(),
    ].sort((left, right) => left.offset - right.offset);

    const records = new Map();
    for (let index = 0; index < direct.length; index++) {
        const record = direct[index];
        const start = payloadStartOffset(record);
        const end = direct[index + 1]?.offset ?? payload.length;
        records.set(record.id, {
            ...record,
            start,
            end,
            payloadBytes: Math.max(0, end - start),
        });
    }
    return records;
}

function magnitude(vector) {
    return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector) {
    const length = magnitude(vector) || 1;
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function formatDir(direction) {
    return `(${formatNumber(direction.x)}, ${formatNumber(direction.y)}, ${formatNumber(direction.z)})`;
}

function classifyFloats(floats) {
    const origin = { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 };
    const v1 = { x: floats[3] ?? 0, y: floats[4] ?? 0, z: floats[5] ?? 0 };
    const v2 = { x: floats[6] ?? 0, y: floats[7] ?? 0, z: floats[8] ?? 0 };
    const mag1 = magnitude(v1);
    const mag2 = magnitude(v2);

    if (floats.length >= 9 && mag1 >= 0.8 && mag1 <= 1.2 && mag2 >= 0.8 && mag2 <= 1.2 && Math.abs(dot(normalize(v1), normalize(v2))) < 0.1) {
        return {
            kind: 'frame-like',
            origin,
            axis: normalize(v1),
            refdir: normalize(v2),
            tail: floats.slice(9).map((value) => formatNumber(value)),
        };
    }

    if (floats.length >= 9 && mag1 >= 0.8 && mag1 <= 1.2 && Math.abs(floats[6] ?? 0) < 1e-6) {
        const p2 = { x: floats[3] * 1000, y: floats[4] * 1000, z: floats[5] * 1000 };
        const actualDistance = Math.hypot(p2.x - origin.x, p2.y - origin.y, p2.z - origin.z);
        return {
            kind: 'segment-like',
            p1: origin,
            p2,
            scalar6mm: formatNumber((floats[6] ?? 0) * 1000),
            scalar7mm: formatNumber((floats[7] ?? 0) * 1000),
            actualDistance: formatNumber(actualDistance),
        };
    }

    if (floats.length >= 6 && mag1 >= 0.8 && mag1 <= 1.2) {
        return {
            kind: 'point+tangent',
            point: origin,
            direction: normalize(v1),
            tail: floats.slice(6).map((value) => formatNumber(value)),
        };
    }

    return {
        kind: 'generic',
        preview: floats.slice(0, 12).map((value) => formatNumber(value)),
    };
}

function scanMarkerRows(window, maxShift = 8) {
    const rows = [];
    for (let markerIdx = 0; markerIdx < window.length; markerIdx++) {
        const marker = window[markerIdx];
        if (marker !== 0x2b && marker !== 0x2d) continue;
        for (let shift = 1; shift <= maxShift; shift++) {
            const start = markerIdx + shift;
            if (start + 8 > window.length) continue;
            const floats = [];
            for (let offset = start; offset + 8 <= window.length; offset += 8) {
                const value = window.readDoubleBE(offset);
                if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
                floats.push(value);
            }
            if (floats.length < 3) continue;
            rows.push({ markerIdx, marker, shift, floats, classification: classifyFloats(floats) });
        }
    }
    return rows.sort((left, right) => left.markerIdx - right.markerIdx || left.shift - right.shift || right.floats.length - left.floats.length);
}

const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);

console.log('investigate195 — FTC_07 wrapper frame-like payloads');
console.log('Clean-room basis: classify wrapper marker rows as segment-like, frame-like, or point+tangent to isolate endcap-specific payload.');
console.log(`\n== ${fileName} ==`);

for (const id of TARGET_IDS) {
    const record = direct.get(id);
    if (!record) continue;
    const window = payload.subarray(record.offset, record.end);
    const rows = scanMarkerRows(window)
        .filter((row) => row.classification.kind !== 'generic')
        .slice(0, 12);

    console.log(`\nwrapper=${id} span=${window.length} refs=[${record.refIds.join(', ')}]`);
    if (rows.length === 0) {
        console.log('  structuredRows=none');
        continue;
    }

    for (const row of rows) {
        const kind = row.classification.kind;
        if (kind === 'frame-like') {
            console.log(`  marker@${row.markerIdx} shift=+${row.shift} ${kind} origin=${formatPoint(row.classification.origin)} axis=${formatDir(row.classification.axis)} refdir=${formatDir(row.classification.refdir)} tail=[${row.classification.tail.join(', ')}]`);
            continue;
        }
        if (kind === 'segment-like') {
            console.log(`  marker@${row.markerIdx} shift=+${row.shift} ${kind} p1=${formatPoint(row.classification.p1)} p2=${formatPoint(row.classification.p2)} scalar6mm=${row.classification.scalar6mm} scalar7mm=${row.classification.scalar7mm} actualDistance=${row.classification.actualDistance}`);
            continue;
        }
        if (kind === 'point+tangent') {
            console.log(`  marker@${row.markerIdx} shift=+${row.shift} ${kind} point=${formatPoint(row.classification.point)} dir=${formatDir(row.classification.direction)} tail=[${row.classification.tail.join(', ')}]`);
            continue;
        }
    }
}