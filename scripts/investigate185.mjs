#!/usr/bin/env bun
/**
 * investigate185.mjs — Deep walk from the FTC_07 wrapper-loop seeds.
 *
 * Goal:
 * 1. Traverse the FTC_07 seed loop {48,49,51,52,54} to greater depth.
 * 2. Collect every reachable direct type-32/type-134/type-30 record.
 * 3. Check whether the branch eventually reaches the previously observed
 *    11.47 mm / 11.90 mm type-32 family or remains confined to the small
 *    3.22 mm / 25.20 mm placements seen at shallow depth.
 */
import { loadSample } from './_payload-gap-lib.mjs';

const SEED_IDS = [48, 49, 51, 52, 54];
const MAX_DEPTH = 8;

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

function classifySurface(floats) {
    if (floats.length < 10) return null;
    const axis = { x: floats[3], y: floats[4], z: floats[5] };
    const refdir = { x: floats[6], y: floats[7], z: floats[8] };
    const axisMag = magnitude(axis);
    const refdirMag = magnitude(refdir);
    const radius = floats[9];
    if (axisMag < 0.8 || axisMag > 1.2) return null;
    if (refdirMag < 0.8 || refdirMag > 1.2) return null;
    if (!(radius > 0.0005 && radius < 1)) return null;
    const normAxis = normalize(axis);
    const normRefdir = normalize(refdir);
    if (Math.abs(dot(normAxis, normRefdir)) > 0.15) return null;
    return {
        origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
        axis: normAxis,
        radius: radius * 1000,
        halfAngleDeg: (floats[10] ?? 0) * 180 / Math.PI,
    };
}

function firstAnalyticMarker(payload, record) {
    const scanStart = Math.max(record.offset, record.start - 1);
    const window = payload.subarray(scanStart, record.end);
    for (const marker of [0x2b, 0x2d]) {
        let markerIdx = -1;
        while ((markerIdx = window.indexOf(marker, markerIdx + 1)) >= 0) {
            const floats = [];
            for (let offset = markerIdx + 1; offset + 8 <= window.length; offset += 8) {
                const value = window.readDoubleBE(offset);
                if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
                floats.push(value);
            }
            const analytic = classifySurface(floats);
            if (analytic) return { marker, markerIdx, floatCount: floats.length, ...analytic };
        }
    }
    return null;
}

const { parser, extraction, fileName } = loadSample('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT');
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const broad = buildBroadEntityMap(payload);

const queue = SEED_IDS.map((id) => ({ id, depth: 0 }));
const seen = new Set();
const reachedDirect = [];

while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current.id)) continue;
    seen.add(current.id);

    const directNode = direct.get(current.id);
    const broadNode = broad.get(current.id);
    const refs = directNode ? directNode.refIds : broadNode ? broadNode.refs : [];

    if (directNode) reachedDirect.push({ depth: current.depth, record: directNode });
    if (current.depth >= MAX_DEPTH) continue;
    for (const refId of refs) {
        if (!seen.has(refId)) queue.push({ id: refId, depth: current.depth + 1 });
    }
}

const interesting = reachedDirect
    .filter((row) => row.record.type === 30 || row.record.type === 32 || row.record.type === 134)
    .sort((left, right) => left.depth - right.depth || left.record.type - right.record.type || left.record.id - right.record.id);

console.log('investigate185 — deep FTC_07 wrapper-loop walk');
console.log('Clean-room basis: follow the wrapper-loop branch to greater depth and summarize every reachable direct type-30/type-32/type-134 record.');
console.log(`\n== ${fileName} ==`);
console.log(`reachable direct records of interest: ${interesting.length}`);

for (const row of interesting) {
    const analytic = firstAnalyticMarker(payload, row.record);
    const analyticText = analytic
        ? `analytic origin=(${analytic.origin.x.toFixed(3)}, ${analytic.origin.y.toFixed(3)}, ${analytic.origin.z.toFixed(3)}) axis=(${analytic.axis.x.toFixed(6)}, ${analytic.axis.y.toFixed(6)}, ${analytic.axis.z.toFixed(6)}) radius=${analytic.radius.toFixed(6)} halfAngleDeg=${analytic.halfAngleDeg.toFixed(6)}`
        : 'analytic none';
    console.log(`  depth=${row.depth} id=${row.record.id} type=${row.record.type} bytes=${row.record.payloadBytes} refs=[${row.record.refIds.join(', ')}] ${analyticText}`);
}