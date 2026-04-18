#!/usr/bin/env bun
/**
 * investigate180.mjs — Audit short face-linked type-30/type-31 wrappers.
 *
 * Goal:
 * 1. Walk broad FACE-like entities and collect short direct type-30/type-31
 *    records referenced in each face slot.
 * 2. Decode the best analytic marker candidate from each short payload.
 * 3. Compare each candidate against the parser's current extracted surfaces and
 *    report only novel candidates with real vertex support, with emphasis on
 *    FTC_07 slot-3 type-30 wrappers and the already-known slot-6 family.
 */
import {
    ENTITY_FACE,
    ENTITY_SURFACE,
    ENTITY_BSPLINE,
    loadSample,
    listSamplePaths,
} from './_payload-gap-lib.mjs';

const DEFAULT_FILTERS = ['ctc_02', 'ctc_04', 'ctc_05', 'ftc_07', 'ftc_10', 'ctc_01', 'ftc_08', 'ftc_11'];
const MAX_SHORT_PAYLOAD_BYTES = 180;
const MAX_RESULTS_PER_FILE = 12;

function payloadStartOffset(record) {
    return 'trailer' in record ? record.offset + 20 : record.offset + 19;
}

function magnitude(vector) {
    return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector) {
    const length = magnitude(vector);
    if (length === 0) return { x: 0, y: 0, z: 0 };
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

function axisLineDistance(originA, originB, axis) {
    const dx = originA.x - originB.x;
    const dy = originA.y - originB.y;
    const dz = originA.z - originB.z;
    const along = dx * axis.x + dy * axis.y + dz * axis.z;
    const px = dx - along * axis.x;
    const py = dy - along * axis.y;
    const pz = dz - along * axis.z;
    return Math.hypot(px, py, pz);
}

function surfacesMatch(left, right) {
    if (left.surfaceType !== right.surfaceType) return false;

    if (left.surfaceType === 'plane') {
        const leftNormal = left.params.normal;
        const rightNormal = right.params.normal;
        const normalDot = dot(leftNormal, rightNormal);
        if (Math.abs(Math.abs(normalDot) - 1) >= 0.001) return false;
        const leftDistance = dot(leftNormal, left.params.origin);
        const rightDistance = dot(rightNormal, right.params.origin);
        const sign = normalDot > 0 ? 1 : -1;
        return Math.abs(leftDistance - sign * rightDistance) < 0.1;
    }

    if (left.surfaceType === 'cylinder') {
        const leftAxis = left.params.axis;
        const rightAxis = right.params.axis;
        const axisDot = dot(leftAxis, rightAxis);
        if (Math.abs(Math.abs(axisDot) - 1) >= 0.02) return false;
        if (Math.abs(left.params.radius - right.params.radius) >= 0.5) return false;
        return axisLineDistance(left.params.origin, right.params.origin, rightAxis) < 0.5;
    }

    if (left.surfaceType === 'cone') {
        const leftAxis = left.params.axis;
        const rightAxis = right.params.axis;
        const axisDot = dot(leftAxis, rightAxis);
        if (Math.abs(Math.abs(axisDot) - 1) >= 0.02) return false;
        if (Math.abs(left.params.radius - right.params.radius) >= 0.5) return false;
        if (Math.abs(left.params.halfAngle - right.params.halfAngle) >= 0.01) return false;
        return axisLineDistance(left.params.origin, right.params.origin, rightAxis) < 0.5;
    }

    return false;
}

function scoreGeomFloats(floats) {
    let score = floats.length;
    if ([7, 8, 11, 12, 13, 14, 15, 16, 17, 20, 22, 24].includes(floats.length)) score += 5;

    if (floats.length >= 7) {
        const dirMag = Math.hypot(floats[3], floats[4], floats[5]);
        if (dirMag >= 0.5 && dirMag <= 1.5) score += 15;
    }

    if (floats.length >= 11) {
        const radius = floats[9];
        if (radius > 0 && radius < 1e4) score += 10;
        if (Math.abs(floats[10]) < 10) score += 5;
    }

    return score;
}

function classifyAnalyticSurface(floats) {
    if (floats.length === 7 || floats.length === 8) {
        const rawNormal = { x: floats[3], y: floats[4], z: floats[5] };
        const normalMag = magnitude(rawNormal);
        if (normalMag < 0.8 || normalMag > 1.2) return null;
        const normal = normalize(rawNormal);
        return {
            surfaceType: 'plane',
            params: {
                origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
                normal,
            },
        };
    }

    if (floats.length < 10) return null;

    const axis = { x: floats[3], y: floats[4], z: floats[5] };
    const refdir = { x: floats[6], y: floats[7], z: floats[8] };
    const axisMag = magnitude(axis);
    const refdirMag = magnitude(refdir);
    const radius = floats[9];

    if (axisMag < 0.8 || axisMag > 1.2) return null;
    if (refdirMag < 0.8 || refdirMag > 1.2) return null;
    if (!(radius > 0.0005 && radius < 1)) return null;

    const normalizedAxis = normalize(axis);
    const normalizedRefdir = normalize(refdir);
    if (Math.abs(dot(normalizedAxis, normalizedRefdir)) > 0.15) return null;

    const halfAngle = floats.length >= 11 && Number.isFinite(floats[10]) ? floats[10] : 0;
    if (Math.abs(halfAngle) < 0.01) {
        return {
            surfaceType: 'cylinder',
            params: {
                origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
                axis: normalizedAxis,
                radius: radius * 1000,
            },
        };
    }

    return {
        surfaceType: 'cone',
        params: {
            origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
            axis: normalizedAxis,
            radius: radius * 1000,
            halfAngle,
        },
    };
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatVector(vector) {
    return `(${formatNumber(vector.x)}, ${formatNumber(vector.y)}, ${formatNumber(vector.z)})`;
}

function formatSurface(surface) {
    if (surface.surfaceType === 'plane') {
        return `plane origin=${formatVector(surface.params.origin)} normal=${formatVector(surface.params.normal)}`;
    }
    if (surface.surfaceType === 'cylinder') {
        return `cylinder origin=${formatVector(surface.params.origin)} axis=${formatVector(surface.params.axis)} radius=${formatNumber(surface.params.radius)}`;
    }
    return `cone origin=${formatVector(surface.params.origin)} axis=${formatVector(surface.params.axis)} radius=${formatNumber(surface.params.radius)} halfAngle=${formatNumber(surface.params.halfAngle)}`;
}

function buildDirectRecordMap(parser, payload) {
    const direct = [
        ...parser.parseCompactGeometryLikeRecords(),
        ...parser.parsePackedGeometryLikeRecords(),
    ].sort((left, right) => left.offset - right.offset);

    const records = new Map();
    for (let index = 0; index < direct.length; index++) {
        const record = direct[index];
        if (record.type !== ENTITY_SURFACE && record.type !== ENTITY_BSPLINE) continue;
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

function buildBroadFaces(payload) {
    const faces = [];
    for (let offset = 0; offset < payload.length - 34; offset++) {
        const type = payload.readUInt16BE(offset);
        const id = payload.readUInt16BE(offset + 2);
        const zero = payload.readUInt16BE(offset + 4);
        const one = payload.readUInt16BE(offset + 8);
        if (type !== ENTITY_FACE || zero !== 0 || one !== 1 || id < 1 || id > 11000) continue;
        const refs = [];
        for (let index = 0; index < 12; index++) refs.push(payload.readUInt16BE(offset + 10 + index * 2));
        faces.push({ id, offset, refs });
    }
    return faces;
}

function bestAnalyticMarker(window) {
    let best = null;

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

            const surface = classifyAnalyticSurface(floats);
            if (!surface) continue;

            const row = { marker, markerIdx, floatCount: floats.length, score: scoreGeomFloats(floats), floats, surface };
            if (!best || row.score > best.score || (row.score === best.score && row.floatCount > best.floatCount)) {
                best = row;
            }
        }
    }

    return best;
}

function supportThreshold(surfaceType) {
    if (surfaceType === 'plane') return 4;
    if (surfaceType === 'cylinder') return 3;
    return 3;
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate180 — short face-linked type-30/type-31 wrappers');
console.log('Clean-room basis: decode short broad-face wrapper payloads as analytic surfaces and keep only novel vertex-supported candidates.');

for (const samplePath of samplePaths) {
    const { fileName, parser, extraction } = loadSample(samplePath);
    const payload = extraction.data;
    const direct = buildDirectRecordMap(parser, payload);
    const broadFaces = buildBroadFaces(payload);
    const extractedSurfaces = parser.extractSurfaces();
    const vertices = parser.extractCoordinates().map((point, index) => ({
        id: index + 1,
        position: { x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 },
    }));

    const candidates = [];
    const seen = new Set();

    for (const face of broadFaces) {
        face.refs.forEach((refId, slotIndex) => {
            const record = direct.get(refId);
            if (!record || record.payloadBytes > MAX_SHORT_PAYLOAD_BYTES) return;

            const seenKey = `${record.id}@${slotIndex}`;
            if (seen.has(seenKey)) return;
            seen.add(seenKey);

            const scanStart = Math.max(record.offset, record.start - 1);
            const best = bestAnalyticMarker(payload.subarray(scanStart, record.end));
            if (!best) return;

            const synthetic = { id: 1, surfaceType: best.surface.surfaceType, params: best.surface.params };
            const support = parser.associateVertices([synthetic], vertices).get(1)?.length ?? 0;
            const duplicate = extractedSurfaces.some((existing) => surfacesMatch(best.surface, existing));

            candidates.push({
                faceId: face.id,
                slotIndex,
                recordId: record.id,
                recordType: record.type,
                payloadBytes: record.payloadBytes,
                markerIdx: best.markerIdx,
                floatCount: best.floatCount,
                score: best.score,
                support,
                duplicate,
                surface: best.surface,
            });
        });
    }

    const novelSupported = candidates
        .filter((row) => !row.duplicate && row.support >= supportThreshold(row.surface.surfaceType))
        .sort((left, right) => {
            return right.support - left.support || left.slotIndex - right.slotIndex || left.recordId - right.recordId;
        });

    console.log(`\n== ${fileName} ==`);
    console.log(`short broad-face wrapper candidates: ${candidates.length}`);
    if (novelSupported.length === 0) {
        console.log('  no novel supported analytic candidates');
        continue;
    }

    for (const row of novelSupported.slice(0, MAX_RESULTS_PER_FILE)) {
        console.log(
            `  face=${row.faceId} slot=${row.slotIndex} rec=${row.recordId} type=${row.recordType} bytes=${row.payloadBytes} ` +
            `support=${row.support} score=${row.score} floats=${row.floatCount} rel=${row.markerIdx}`,
        );
        console.log(`    ${formatSurface(row.surface)}`);
    }
}