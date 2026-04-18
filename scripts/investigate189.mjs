#!/usr/bin/env bun
/**
 * investigate189.mjs — Resolve the non-133 closure around the FTC_07 broad-133 loop.
 *
 * Goal:
 * 1. Walk the alternating direct type-30 / broad type-133 chain.
 * 2. Identify the non-133 neighbors at each open end.
 * 3. Resolve those neighbors against direct records, broad records, and raw
 *    sentinel entities to expose the companion record family.
 */
import {
    getAllEntities,
    loadSample,
} from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const TARGET_BROAD_TYPE = 133;
const TARGET_DIRECT_TYPE = 30;

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

function buildRawEntityMap(parser) {
    const raw = new Map();
    for (const entity of getAllEntities(parser)) {
        if (!raw.has(entity.id)) raw.set(entity.id, []);
        raw.get(entity.id).push({
            type: entity.type,
            offset: entity.offset,
            primary: entity.primary,
            dataLength: entity.data.length,
        });
    }
    return raw;
}

function decodeBroad133Segments(payload, broadRecords) {
    const sorted = [...broadRecords].sort((left, right) => left.offset - right.offset || left.id - right.id);
    const offsets = new Map(sorted.map((record, index) => [record.id, sorted[index + 1]?.offset ?? payload.length]));

    return sorted.map((record) => {
        const nextOffset = offsets.get(record.id) ?? payload.length;
        const window = payload.subarray(record.offset, nextOffset);
        const markerIdx = window.indexOf(0x2b);
        if (markerIdx < 0 || markerIdx + 3 + 9 * 8 > window.length) {
            return { id: record.id, p1: null, p2: null };
        }
        const floats = [];
        for (let offset = markerIdx + 3; offset + 8 <= window.length; offset += 8) {
            const value = window.readDoubleBE(offset);
            if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
            floats.push(value);
        }
        if (floats.length < 9) return { id: record.id, p1: null, p2: null };
        return {
            id: record.id,
            p1: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
            p2: { x: floats[3] * 1000, y: floats[4] * 1000, z: floats[5] * 1000 },
            encodedLength: floats[7] * 1000,
        };
    });
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatPoint(point) {
    if (!point) return 'n/a';
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function describeId(id, direct, broad, raw) {
    const directRecord = direct.get(id);
    if (directRecord) return `direct(t${directRecord.type},bytes=${directRecord.payloadBytes},offset=${directRecord.offset})`;
    const broadRecord = broad.get(id);
    if (broadRecord) return `broad(t${broadRecord.type},offset=${broadRecord.offset})`;
    const rawRecords = raw.get(id);
    if (rawRecords?.length) {
        return rawRecords
            .map((record) => `raw(t${record.type},offset=${record.offset},bytes=${record.dataLength},primary=${record.primary ? 1 : 0})`)
            .join(' | ');
    }
    return 'none';
}

const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const broad = buildBroadEntityMap(payload);
const raw = buildRawEntityMap(parser);

const broad133 = [...broad.values()].filter((record) => record.type === TARGET_BROAD_TYPE);
const segments = decodeBroad133Segments(payload, broad133);

const directIds = new Set();
for (const record of broad133) {
    directIds.add(record.refs[1]);
    directIds.add(record.refs[2]);
}

const direct30 = [...directIds]
    .map((id) => direct.get(id))
    .filter((record) => record && record.type === TARGET_DIRECT_TYPE)
    .sort((left, right) => left.id - right.id);

const startWrapper = direct30.find((record) => !broad.has(record.refIds[2])) ?? null;
const endWrapper = direct30.find((record) => !broad.has(record.refIds[1])) ?? null;

console.log('investigate189 — FTC_07 broad-133 non-133 closure');
console.log('Clean-room basis: resolve the alternating type-30/type-133 chain ends against direct, broad, and raw entity maps.');
console.log(`\n== ${fileName} ==`);
console.log(`broad133 count=${broad133.length} alternating direct30 count=${direct30.length}`);

console.log('\nBroad-133 segments:');
for (const segment of segments.sort((left, right) => left.id - right.id)) {
    console.log(`  id=${segment.id} p1=${formatPoint(segment.p1)} p2=${formatPoint(segment.p2)} encodedLength=${segment.encodedLength === undefined ? 'n/a' : formatNumber(segment.encodedLength)}`);
}

console.log('\nAlternating direct type-30 wrappers:');
for (const record of direct30) {
    console.log(`  id=${record.id} offset=${record.offset} bytes=${record.payloadBytes} refs=[${record.refIds.join(', ')}]`);
    console.log(`    ref1=${record.refIds[1]} -> ${describeId(record.refIds[1], direct, broad, raw)}`);
    console.log(`    ref2=${record.refIds[2]} -> ${describeId(record.refIds[2], direct, broad, raw)}`);
    console.log(`    ref3=${record.refIds[3]} -> ${describeId(record.refIds[3], direct, broad, raw)}`);
}

if (startWrapper) {
    console.log('\nStart-side non-133 closure candidate:');
    console.log(`  wrapper=${startWrapper.id} prevRef=${startWrapper.refIds[2]} -> ${describeId(startWrapper.refIds[2], direct, broad, raw)}`);
    console.log(`  broad=${startWrapper.refIds[1]} -> ${describeId(startWrapper.refIds[1], direct, broad, raw)}`);
}

if (endWrapper) {
    console.log('\nEnd-side non-133 closure candidate:');
    console.log(`  wrapper=${endWrapper.id} nextRef=${endWrapper.refIds[1]} -> ${describeId(endWrapper.refIds[1], direct, broad, raw)}`);
    console.log(`  broad=${endWrapper.refIds[2]} -> ${describeId(endWrapper.refIds[2], direct, broad, raw)}`);
}

const companionIds = new Set();
if (startWrapper) companionIds.add(startWrapper.refIds[2]);
if (endWrapper) companionIds.add(endWrapper.refIds[1]);

if (companionIds.size > 0) {
    console.log('\nCompanion id detail:');
    for (const id of [...companionIds].sort((left, right) => left - right)) {
        console.log(`  id=${id} -> ${describeId(id, direct, broad, raw)}`);
    }
}