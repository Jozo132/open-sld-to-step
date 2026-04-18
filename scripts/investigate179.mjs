#!/usr/bin/env bun
/**
 * investigate179.mjs — Inspect long face-linked direct geometry payloads.
 *
 * Goal:
 * 1. Find direct type-30/type-31 records that are referenced by broad FACE-like
 *    entities and whose payload spans are much longer than the short analytic
 *    wrapper family already integrated into the parser.
 * 2. Audit their reference context (broad face slots, explicit edges/faces,
 *    aliases) and scan the full payload for internal 0x2B/0x2D marker regions.
 * 3. Check whether any internal marker yields a defensible analytic surface
 *    candidate that is both novel relative to current extraction and supported
 *    by nearby vertices.
 */
import {
    ENTITY_EDGE,
    ENTITY_FACE,
    ENTITY_SURFACE,
    ENTITY_BSPLINE,
    loadSample,
    listSamplePaths,
} from './_payload-gap-lib.mjs';

const LONG_PAYLOAD_BYTES = 500;
const MAX_MARKER_RESULTS = 12;
const MAX_FACE_ROWS = 8;
const MAX_SUPPORT_ROWS = 8;

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
    const tinyPenalty = floats
        .slice(0, Math.min(floats.length, 12))
        .filter((value) => Math.abs(value) > 0 && Math.abs(value) < 1e-100)
        .length;
    score -= tinyPenalty * 3;

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
        const normal = normalize({ x: floats[3], y: floats[4], z: floats[5] });
        const normalMag = magnitude(normal);
        if (normalMag === 0) return null;
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
    if (!(radius > 0 && radius < 1)) return null;

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
    if (!Number.isFinite(value)) return String(value);
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

function scanMarkerPayloads(buffer) {
    const results = [];

    for (const marker of [0x2b, 0x2d]) {
        let markerIdx = -1;
        while ((markerIdx = buffer.indexOf(marker, markerIdx + 1)) >= 0) {
            if (markerIdx + 1 + 8 > buffer.length) continue;

            const floats = [];
            for (let offset = markerIdx + 1; offset + 8 <= buffer.length; offset += 8) {
                const value = buffer.readDoubleBE(offset);
                if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
                floats.push(value);
            }
            if (floats.length < 3) continue;

            const surface = classifyAnalyticSurface(floats);
            results.push({
                marker,
                markerIdx,
                floatCount: floats.length,
                score: scoreGeomFloats(floats),
                floats,
                surface,
            });
        }
    }

    return results.sort((left, right) => {
        return right.score - left.score || right.floatCount - left.floatCount || right.markerIdx - left.markerIdx;
    });
}

function summarizeSupport(parser, surface, extractedSurfaces, vertices) {
    const synthetic = { id: 1, surfaceType: surface.surfaceType, params: surface.params };
    const support = parser.associateVertices([synthetic], vertices).get(1)?.length ?? 0;
    const duplicate = extractedSurfaces.some((existing) => surfacesMatch(surface, existing));
    return { support, duplicate };
}

function broadFaceRefsForRecord(faces, recordId) {
    const rows = [];
    for (const face of faces) {
        face.refs.forEach((refId, slotIndex) => {
            if (refId === recordId) rows.push({ faceId: face.id, slotIndex, refs: face.refs, offset: face.offset });
        });
    }
    return rows;
}

function summarizeWordUsage(buffer) {
    const counts = new Map();
    for (let offset = 0; offset + 2 <= buffer.length; offset += 2) {
        const word = buffer.readUInt16BE(offset);
        counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0] - right[0])
        .slice(0, 12)
        .map(([word, count]) => ({ word, count }));
}

function summarizeEntityHits(buffer, entityMaps) {
    const totals = new Map();
    for (let offset = 0; offset + 2 <= buffer.length; offset += 2) {
        const word = buffer.readUInt16BE(offset);
        for (const [label, ids] of entityMaps) {
            if (!ids.has(word)) continue;
            totals.set(label, (totals.get(label) ?? 0) + 1);
        }
    }
    return [...totals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : ['ctc_02']);

console.log('investigate179 — long face-linked direct geometry payloads');
console.log('Clean-room basis: inspect long face-linked direct type-30/type-31 payloads for embedded analytic markers and local structural context.');

for (const samplePath of samplePaths) {
    const { fileName, parser, extraction } = loadSample(samplePath);
    const payload = extraction.data;
    const direct = buildDirectRecordMap(parser, payload);
    const broadFaces = buildBroadFaces(payload);
    const explicitFaces = parser.parseFaceRecords();
    const edges = parser.parseEdgeRecords();
    const aliases = parser.parseGeometryLikeAliasRecords();
    const extractedSurfaces = parser.extractSurfaces();
    const vertices = parser.extractCoordinates().map((point, index) => ({
        id: index + 1,
        position: { x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 },
    }));
    const allEntities = parser.extractAllEntities();

    const entityMaps = [
        ['faces', new Set(allEntities.filter((entity) => entity.type === ENTITY_FACE).map((entity) => entity.id))],
        ['edges', new Set(allEntities.filter((entity) => entity.type === ENTITY_EDGE).map((entity) => entity.id))],
        ['type30', new Set(allEntities.filter((entity) => entity.type === ENTITY_SURFACE).map((entity) => entity.id))],
        ['type31', new Set(allEntities.filter((entity) => entity.type === ENTITY_BSPLINE).map((entity) => entity.id))],
    ];

    const targets = [...direct.values()]
        .filter((record) => record.payloadBytes >= LONG_PAYLOAD_BYTES)
        .map((record) => ({ record, faceRefs: broadFaceRefsForRecord(broadFaces, record.id) }))
        .filter((entry) => entry.faceRefs.length > 0)
        .sort((left, right) => right.record.payloadBytes - left.record.payloadBytes || left.record.id - right.record.id);

    console.log(`\n== ${fileName} ==`);
    console.log(`long face-linked direct records: ${targets.length}`);
    if (targets.length === 0) {
        console.log('  none');
        continue;
    }

    for (const { record, faceRefs } of targets) {
        const scanStart = Math.max(record.offset, record.start - 1);
        const window = payload.subarray(scanStart, record.end);
        const markerRows = scanMarkerPayloads(window);
        const edgeRefs = edges.filter((edge) => edge.geometryLikeId === record.id);
        const faceRecordRefs = explicitFaces.filter((face) => face.geometryLikeId === record.id);
        const aliasRefs = aliases.filter((alias) => alias.canonicalId === record.id || alias.id === record.id);
        const supportRows = markerRows
            .filter((row) => row.surface)
            .map((row) => ({
                ...row,
                ...summarizeSupport(parser, row.surface, extractedSurfaces, vertices),
            }))
            .sort((left, right) => {
                return right.support - left.support || Number(left.duplicate) - Number(right.duplicate) || right.score - left.score;
            });

        console.log(`  id=${record.id} type=${record.type} bytes=${record.payloadBytes} marker=0x${record.markerByte.toString(16)} offset=${record.offset} refs=[${record.refIds.join(', ')}]`);
        console.log(`    broad faces: ${faceRefs.slice(0, MAX_FACE_ROWS).map((row) => `face${row.faceId}@slot${row.slotIndex}`).join(', ')}`);
        if (faceRefs.length > MAX_FACE_ROWS) console.log(`    broad faces (+${faceRefs.length - MAX_FACE_ROWS} more)`);
        console.log(`    explicit edge refs=${edgeRefs.length} explicit face refs=${faceRecordRefs.length} aliases=${aliasRefs.length}`);
        console.log(`    payload word leaders: ${summarizeWordUsage(window).map((row) => `${row.word}:${row.count}`).join(' ')}`);
        const entityHits = summarizeEntityHits(window, entityMaps);
        if (entityHits.length > 0) {
            console.log(`    payload entity-word hits: ${entityHits.map(([label, count]) => `${label}=${count}`).join(' ')}`);
        }
        console.log(`    marker scans=${markerRows.length}`);
        for (const row of markerRows.slice(0, MAX_MARKER_RESULTS)) {
            const preview = row.floats.slice(0, 12).map(formatNumber).join(', ');
            const surfaceText = row.surface ? ` ${formatSurface(row.surface)}` : '';
            console.log(`      rel=${row.markerIdx} marker=0x${row.marker.toString(16)} floats=${row.floatCount} score=${row.score}${surfaceText}`);
            console.log(`        leading=${preview}`);
        }
        if (supportRows.length > 0) {
            console.log('    analytic support rows:');
            for (const row of supportRows.slice(0, MAX_SUPPORT_ROWS)) {
                console.log(`      rel=${row.markerIdx} support=${row.support} duplicate=${row.duplicate ? 1 : 0} ${formatSurface(row.surface)}`);
            }
        }
    }
}