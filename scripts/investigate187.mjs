#!/usr/bin/env bun
/**
 * investigate187.mjs — Decode FTC_07 broad type-133/type-134 payloads.
 *
 * Goal:
 * 1. Treat broad type-133/type-134 nodes as short-header records instead of
 *    pure reference tables.
 * 2. Split the layout into header words, four structural refs, and trailing
 *    marker-bearing payload bytes.
 * 3. Check whether those trailing bytes decode into stable analytic rows.
 */
import {
    ParasolidParser,
    loadSample,
} from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const TARGET_TYPES = new Set([133, 134]);

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

function buildBroadEntityMap(payload) {
    const entities = new Map();
    for (let offset = 0; offset < payload.length - 34; offset++) {
        const type = payload.readUInt16BE(offset);
        const id = payload.readUInt16BE(offset + 2);
        const zero = payload.readUInt16BE(offset + 4);
        const headerWord3 = payload.readUInt16BE(offset + 6);
        const one = payload.readUInt16BE(offset + 8);
        if (zero !== 0 || one !== 1 || !TARGET_TYPES.has(type) || id < 1 || id > 11000) continue;
        if (entities.has(id)) continue;

        const words = [];
        for (let index = 0; index < 20 && offset + index * 2 + 2 <= payload.length; index++) {
            words.push(payload.readUInt16BE(offset + index * 2));
        }

        entities.set(id, {
            id,
            type,
            offset,
            headerWord3,
            refs: [
                payload.readUInt16BE(offset + 10),
                payload.readUInt16BE(offset + 12),
                payload.readUInt16BE(offset + 14),
                payload.readUInt16BE(offset + 16),
            ],
            words,
        });
    }
    return entities;
}

function buildNextOffsetMap(payload, direct, broad) {
    const nodes = [
        ...[...direct.values()].map((record) => ({ key: `direct:${record.id}:${record.offset}`, offset: record.offset })),
        ...[...broad.values()].map((record) => ({ key: `broad:${record.id}:${record.offset}`, offset: record.offset })),
    ].sort((left, right) => left.offset - right.offset || left.key.localeCompare(right.key));

    const nextOffsets = new Map();
    for (let index = 0; index < nodes.length; index++) {
        nextOffsets.set(nodes[index].key, nodes[index + 1]?.offset ?? payload.length);
    }
    return nextOffsets;
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function nearestVertex(point, vertices) {
    let best = null;
    for (const vertex of vertices) {
        const d = distance(point, vertex.position);
        if (!best || d < best.distance) best = { id: vertex.id, distance: d, position: vertex.position };
    }
    return best;
}

function vectorMagnitude(vector) {
    return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector) {
    const length = vectorMagnitude(vector) || 1;
    return {
        x: vector.x / length,
        y: vector.y / length,
        z: vector.z / length,
    };
}

function dot(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

function classifyFloats(floats) {
    if (floats.length >= 11) {
        const axis = { x: floats[3], y: floats[4], z: floats[5] };
        const refdir = { x: floats[6], y: floats[7], z: floats[8] };
        const axisMag = vectorMagnitude(axis);
        const refdirMag = vectorMagnitude(refdir);
        if (axisMag >= 0.5 && axisMag <= 1.5 && refdirMag >= 0.5 && refdirMag <= 1.5 && Math.abs(dot(normalize(axis), normalize(refdir))) <= 0.2) {
            return {
                kind: 'rotational',
                origin: {
                    x: floats[0] * 1000,
                    y: floats[1] * 1000,
                    z: floats[2] * 1000,
                },
                axis: normalize(axis),
                refdir: normalize(refdir),
                scalar9mm: floats[9] * 1000,
                scalar10mm: (floats[10] ?? 0) * 1000,
                scalar10deg: (floats[10] ?? 0) * 180 / Math.PI,
            };
        }
    }

    if (floats.length >= 7) {
        const direction = { x: floats[3], y: floats[4], z: floats[5] };
        const directionMag = vectorMagnitude(direction);
        if (directionMag >= 0.5 && directionMag <= 1.5) {
            return {
                kind: 'directed',
                origin: {
                    x: floats[0] * 1000,
                    y: floats[1] * 1000,
                    z: floats[2] * 1000,
                },
                direction: normalize(direction),
                trailing: floats.slice(6).map((value) => formatNumber(value)),
            };
        }
    }

    return {
        kind: 'generic',
        firstPoint: floats.length >= 3
            ? { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 }
            : null,
        secondPoint: floats.length >= 6
            ? { x: floats[3] * 1000, y: floats[4] * 1000, z: floats[5] * 1000 }
            : null,
        leading: floats.slice(0, 12).map((value) => formatNumber(value)),
    };
}

function scanMarkerRows(window) {
    const rows = [];
    for (const marker of [0x2b, 0x2d]) {
        let markerIdx = -1;
        while ((markerIdx = window.indexOf(marker, markerIdx + 1)) >= 0) {
            if (markerIdx + 1 + 8 > window.length) continue;
            const floats = [];
            for (let offset = markerIdx + 1; offset + 8 <= window.length; offset += 8) {
                const value = window.readDoubleBE(offset);
                if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
                floats.push(value);
            }
            if (floats.length < 3) continue;
            rows.push({ marker, markerIdx, floats, classification: classifyFloats(floats) });
        }
    }
    return rows.sort((left, right) => right.floats.length - left.floats.length || left.markerIdx - right.markerIdx);
}

    function scanShiftedMarker(window, markerIdx, maxShift = 6) {
        const rows = [];
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
            rows.push({ shift, floats, classification: classifyFloats(floats) });
        }
        return rows.sort((left, right) => right.floats.length - left.floats.length || left.shift - right.shift);
    }

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function formatClassification(classification, vertices) {
    if (classification.kind === 'rotational') {
        return [
            'rotational',
            `origin=(${formatNumber(classification.origin.x)}, ${formatNumber(classification.origin.y)}, ${formatNumber(classification.origin.z)})`,
            `axis=(${formatNumber(classification.axis.x)}, ${formatNumber(classification.axis.y)}, ${formatNumber(classification.axis.z)})`,
            `refdir=(${formatNumber(classification.refdir.x)}, ${formatNumber(classification.refdir.y)}, ${formatNumber(classification.refdir.z)})`,
            `scalar9mm=${formatNumber(classification.scalar9mm)}`,
            `scalar10mm=${formatNumber(classification.scalar10mm)}`,
            `scalar10deg=${formatNumber(classification.scalar10deg)}`,
        ].join(' ');
    }
    if (classification.kind === 'directed') {
        return [
            'directed',
            `origin=(${formatNumber(classification.origin.x)}, ${formatNumber(classification.origin.y)}, ${formatNumber(classification.origin.z)})`,
            `direction=(${formatNumber(classification.direction.x)}, ${formatNumber(classification.direction.y)}, ${formatNumber(classification.direction.z)})`,
            `trailing=[${classification.trailing.join(', ')}]`,
        ].join(' ');
    }

    const parts = ['generic'];
    if (classification.firstPoint) {
        const nearest = nearestVertex(classification.firstPoint, vertices);
        parts.push(`p1=${formatPoint(classification.firstPoint)}`);
        if (nearest) parts.push(`p1Nearest=v${nearest.id}@${formatNumber(nearest.distance)}mm`);
    }
    if (classification.secondPoint) {
        const nearest = nearestVertex(classification.secondPoint, vertices);
        parts.push(`p2=${formatPoint(classification.secondPoint)}`);
        if (nearest) parts.push(`p2Nearest=v${nearest.id}@${formatNumber(nearest.distance)}mm`);
        if (classification.firstPoint) parts.push(`pairDistance=${formatNumber(distance(classification.firstPoint, classification.secondPoint))}mm`);
    }
    parts.push(`leading=[${classification.leading.join(', ')}]`);
    return parts.join(' ');
}

function formatWord(word) {
    return `0x${word.toString(16).padStart(4, '0')}`;
}

const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const broad = buildBroadEntityMap(payload);
const nextOffsets = buildNextOffsetMap(payload, direct, broad);
const vertices = parser.extractCoordinates().map((point, index) => ({
    id: index + 1,
    position: {
        x: point.x * 1000,
        y: point.y * 1000,
        z: point.z * 1000,
    },
}));

console.log('investigate187 — FTC_07 broad type-133/type-134 decode');
console.log('Clean-room basis: treat broad 133/134 as short-header records and scan the trailing bytes for geometry markers.');
console.log(`\n== ${fileName} ==`);

for (const record of [...broad.values()].sort((left, right) => left.offset - right.offset || left.id - right.id)) {
    const key = `broad:${record.id}:${record.offset}`;
    const nextOffset = nextOffsets.get(key) ?? payload.length;
    const window = payload.subarray(record.offset, nextOffset);
    const markerRows = scanMarkerRows(window);
    const fullBest = ParasolidParser.readGeomFloats(window);
    const payloadMarkerByte = payload[record.offset + 18];

    console.log(`  id=${record.id} type=${record.type} offset=${record.offset} span=${window.length} header3=${formatWord(record.headerWord3)} refs=[${record.refs.join(', ')}] markerByte@18=0x${payloadMarkerByte.toString(16).padStart(2, '0')}`);
    console.log(`    headWords=${record.words.slice(0, 12).map((word) => formatWord(word)).join(' ')}`);
    if (!fullBest) {
        console.log('    bestMarker=none');
    } else {
        console.log(`    bestMarker=0x${fullBest.marker.toString(16)} floats=${fullBest.floats.length} classification=${formatClassification(classifyFloats(fullBest.floats), vertices)}`);
    }

    const shifted = scanShiftedMarker(window, 18);
    if (shifted.length > 0) {
        for (const row of shifted.slice(0, 3)) {
            console.log(`    shiftFrom18=+${row.shift} floats=${row.floats.length} classification=${formatClassification(row.classification, vertices)}`);
        }
    }
    if (markerRows.length === 0) {
        console.log('    markerRows=none');
        continue;
    }

    for (const row of markerRows.slice(0, 3)) {
        console.log(`    marker@${row.markerIdx}=0x${row.marker.toString(16)} floats=${row.floats.length} classification=${formatClassification(row.classification, vertices)}`);
    }
}