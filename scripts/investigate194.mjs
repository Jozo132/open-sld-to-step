#!/usr/bin/env bun
/**
 * investigate194.mjs — Compare wrapper primary-marker rows against broad-133 tangents.
 *
 * Goal:
 * 1. Decode the first marker row from each FTC_07 wrapper in the alternating chain.
 * 2. Compare its point and direction against the adjacent broad-133 segment endpoints.
 * 3. Determine whether wrappers carry traversal orientation for the broad-133 loop.
 */
import { loadSample } from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const POINT_TOL_MM = 0.01;
const DIR_TOL = 0.01;

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
        const one = payload.readUInt16BE(offset + 8);
        if (zero !== 0 || one !== 1 || type < 1 || type > 200 || id < 1 || id > 11000) continue;
        if (entities.has(id)) continue;
        const refs = [];
        for (let index = 0; index < 12; index++) refs.push(payload.readUInt16BE(offset + 10 + index * 2));
        entities.set(id, { id, type, offset, refs });
    }
    return entities;
}

function decodeBroad133Segments(payload, broadRecords) {
    const sorted = [...broadRecords].sort((left, right) => left.offset - right.offset || left.id - right.id);
    const offsets = new Map(sorted.map((record, index) => [record.id, sorted[index + 1]?.offset ?? payload.length]));

    return new Map(sorted.map((record) => {
        const nextOffset = offsets.get(record.id) ?? payload.length;
        const window = payload.subarray(record.offset, nextOffset);
        const markerIdx = window.indexOf(0x2b);
        if (markerIdx < 0 || markerIdx + 3 + 9 * 8 > window.length) return [record.id, null];
        const floats = [];
        for (let offset = markerIdx + 3; offset + 8 <= window.length; offset += 8) {
            const value = window.readDoubleBE(offset);
            if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
            floats.push(value);
        }
        if (floats.length < 9) return [record.id, null];
        const p1 = { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 };
        const p2 = { x: floats[3] * 1000, y: floats[4] * 1000, z: floats[5] * 1000 };
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dz = p2.z - p1.z;
        const length = Math.hypot(dx, dy, dz) || 1;
        return [record.id, {
            id: record.id,
            p1,
            p2,
            dirP1ToP2: { x: dx / length, y: dy / length, z: dz / length },
            dirP2ToP1: { x: -dx / length, y: -dy / length, z: -dz / length },
        }];
    }));
}

function scanFirstMarkerVector(window) {
    const markerIdx = window.indexOf(0x2b);
    if (markerIdx < 0) return null;
    const start = markerIdx + 1;
    if (start + 9 * 8 > window.length) return null;
    const floats = [];
    for (let offset = start; offset + 8 <= window.length; offset += 8) {
        const value = window.readDoubleBE(offset);
        if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
        floats.push(value);
    }
    if (floats.length < 6) return null;

    const point = { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 };
    const vector = { x: floats[3], y: floats[4], z: floats[5] };
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return {
        markerIdx,
        point,
        direction: { x: vector.x / length, y: vector.y / length, z: vector.z / length },
    };
}

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function directionDistance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
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

function matchSegment(wrapperVector, segment, labelBase) {
    if (!wrapperVector || !segment) return [];
    const rows = [];
    const pointMatches = [
        { pointLabel: `${labelBase}.p1`, point: segment.p1, dirLabel: `${labelBase}.p1->p2`, dir: segment.dirP1ToP2 },
        { pointLabel: `${labelBase}.p2`, point: segment.p2, dirLabel: `${labelBase}.p2->p1`, dir: segment.dirP2ToP1 },
    ];
    for (const candidate of pointMatches) {
        const pointDelta = distance(wrapperVector.point, candidate.point);
        const dirDelta = directionDistance(wrapperVector.direction, candidate.dir);
        rows.push({
            pointLabel: candidate.pointLabel,
            dirLabel: candidate.dirLabel,
            pointDelta,
            dirDelta,
            pointMatch: pointDelta <= POINT_TOL_MM,
            dirMatch: dirDelta <= DIR_TOL,
        });
    }
    return rows;
}

const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const broad = buildBroadEntityMap(payload);
const broad133 = [...broad.values()].filter((record) => record.type === 133);
const segments = decodeBroad133Segments(payload, broad133);

const wrapperIds = [...new Set(broad133.flatMap((record) => {
    return [record.refs[1], record.refs[2]].filter((refId) => direct.get(refId)?.type === 30);
}))].sort((left, right) => left - right);

console.log('investigate194 — FTC_07 wrapper primary-marker tangents');
console.log('Clean-room basis: compare each wrapper primary marker row to adjacent broad-133 segment endpoints and tangents.');
console.log(`\n== ${fileName} ==`);

for (const id of wrapperIds) {
    const wrapper = direct.get(id);
    const vector = scanFirstMarkerVector(payload.subarray(wrapper.offset, wrapper.end));
    const prevSegment = segments.get(wrapper.refIds[2]) ?? null;
    const nextSegment = segments.get(wrapper.refIds[1]) ?? null;
    const matches = [
        ...matchSegment(vector, prevSegment, `prev#${wrapper.refIds[2]}`),
        ...matchSegment(vector, nextSegment, `next#${wrapper.refIds[1]}`),
    ].sort((left, right) => Number(right.pointMatch && right.dirMatch) - Number(left.pointMatch && left.dirMatch) || left.pointDelta - right.pointDelta || left.dirDelta - right.dirDelta);

    console.log(`  wrapper=${id} refs=[${wrapper.refIds.join(', ')}] point=${vector ? formatPoint(vector.point) : 'n/a'} dir=${vector ? formatDir(vector.direction) : 'n/a'}`);
    for (const match of matches.slice(0, 4)) {
        console.log(`    ${match.pointLabel} ${match.dirLabel} pointDelta=${formatNumber(match.pointDelta)} dirDelta=${formatNumber(match.dirDelta)} pointMatch=${match.pointMatch ? 1 : 0} dirMatch=${match.dirMatch ? 1 : 0}`);
    }
}