#!/usr/bin/env bun
/**
 * investigate188.mjs — Summarize the decoded FTC_07 broad-133 segment loop.
 *
 * Goal:
 * 1. Use the shifted broad-133 decode discovered in investigate187.
 * 2. Verify that the resulting rows behave like line segments on a constant
 *    plane rather than random float noise.
 * 3. Measure loop closure by matching p2 of one segment to p1 of another.
 */
import { loadSample } from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const TARGET_TYPE = 133;
const SHIFT = 3;
const POINT_TOL_MM = 0.01;

function buildBroadEntityMap(payload) {
    const entities = [];
    for (let offset = 0; offset < payload.length - 34; offset++) {
        const type = payload.readUInt16BE(offset);
        const id = payload.readUInt16BE(offset + 2);
        const zero = payload.readUInt16BE(offset + 4);
        const one = payload.readUInt16BE(offset + 8);
        if (zero !== 0 || one !== 1 || type !== TARGET_TYPE || id < 1 || id > 11000) continue;
        if (entities.some((entity) => entity.id === id)) continue;
        entities.push({
            id,
            type,
            offset,
            refs: [
                payload.readUInt16BE(offset + 10),
                payload.readUInt16BE(offset + 12),
                payload.readUInt16BE(offset + 14),
                payload.readUInt16BE(offset + 16),
            ],
        });
    }
    return entities.sort((left, right) => left.offset - right.offset || left.id - right.id);
}

function buildNodeOffsets(payload, broad) {
    const offsets = broad.map((entity) => entity.offset);
    return new Map(broad.map((entity, index) => [entity.id, offsets[index + 1] ?? payload.length]));
}

function decodeShiftedSegment(window, markerIdx, shift) {
    const start = markerIdx + shift;
    const floats = [];
    for (let offset = start; offset + 8 <= window.length; offset += 8) {
        const value = window.readDoubleBE(offset);
        if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
        floats.push(value);
    }
    if (floats.length < 9) return null;
    return {
        p1: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
        p2: { x: floats[3] * 1000, y: floats[4] * 1000, z: floats[5] * 1000 },
        zeroish: floats[6] * 1000,
        encodedLength: floats[7] * 1000,
        tail: floats[8],
    };
}

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function samePoint(left, right, tol = POINT_TOL_MM) {
    return distance(left, right) <= tol;
}

const { extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const broad = buildBroadEntityMap(payload);
const nextOffsets = buildNodeOffsets(payload, broad);

const segments = broad
    .map((record) => {
        const nextOffset = nextOffsets.get(record.id) ?? payload.length;
        const window = payload.subarray(record.offset, nextOffset);
        const markerIdx = window.indexOf(0x2b);
        if (markerIdx < 0) return null;
        const decoded = decodeShiftedSegment(window, markerIdx, SHIFT);
        if (!decoded) return null;
        const actualLength = distance(decoded.p1, decoded.p2);
        return {
            id: record.id,
            refs: record.refs,
            ...decoded,
            actualLength,
            lengthDelta: actualLength - decoded.encodedLength,
        };
    })
    .filter((row) => row !== null)
    .sort((left, right) => left.id - right.id);

const yValues = [...new Set(segments.map((segment) => segment.p1.y.toFixed(6)).concat(segments.map((segment) => segment.p2.y.toFixed(6))))];

const nextLinks = [];
for (const segment of segments) {
    const next = segments.find((candidate) => candidate.id !== segment.id && samePoint(segment.p2, candidate.p1));
    nextLinks.push({ id: segment.id, nextId: next?.id ?? null });
}

console.log('investigate188 — FTC_07 broad-133 shifted segment loop');
console.log('Clean-room basis: verify whether the shifted broad-133 decode forms a coherent constant-plane segment chain.');
console.log(`\n== ${fileName} ==`);
console.log(`decoded segments: ${segments.length}`);
console.log(`unique Y levels: ${yValues.join(', ')}`);
console.log(`closed links: ${nextLinks.filter((row) => row.nextId !== null).length}/${nextLinks.length}`);

for (const segment of segments) {
    const link = nextLinks.find((row) => row.id === segment.id);
    console.log(
        `  id=${segment.id} refs=[${segment.refs.join(', ')}] ` +
        `p1=${formatPoint(segment.p1)} p2=${formatPoint(segment.p2)} ` +
        `encodedLength=${formatNumber(segment.encodedLength)} actualLength=${formatNumber(segment.actualLength)} ` +
        `lengthDelta=${formatNumber(segment.lengthDelta)} nextByPoint=${link?.nextId ?? 'none'}`,
    );
}