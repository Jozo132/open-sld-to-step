#!/usr/bin/env bun
/**
 * investigate182.mjs — Trace FTC_07 broad-133 wrapper targets.
 *
 * Goal:
 * 1. Identify the broad type-133 records reached by FTC_07's slot-3 type-30
 *    face-linked wrapper.
 * 2. Expand those nodes one and two hops through the broad-entity and direct
 *    geometry-like maps.
 * 3. Determine whether the FTC_07 wrapper leads into the previously observed
 *    type-134/type-32 branch or into a distinct unresolved structure.
 */
import {
    ENTITY_FACE,
    ENTITY_SURFACE,
    ENTITY_BSPLINE,
    loadSample,
    listSamplePaths,
} from './_payload-gap-lib.mjs';

const DEFAULT_FILTERS = ['ftc_07', 'ctc_02', 'ctc_04', 'ctc_05', 'ftc_10'];
const MAX_SHORT_PAYLOAD_BYTES = 180;

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

function buildBroadFaces(payload) {
    return [...buildBroadEntityMap(payload).values()].filter((entity) => entity.type === ENTITY_FACE);
}

function describeId(id, direct, broad) {
    const directRecord = direct.get(id);
    if (directRecord) return `direct(t${directRecord.type},bytes=${directRecord.payloadBytes})`;
    const broadRecord = broad.get(id);
    if (broadRecord) return `broad(t${broadRecord.type})`;
    return 'none';
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate182 — FTC_07 broad-133 wrapper targets');
console.log('Clean-room basis: trace the broad-entity branch reached by FTC_07 slot-3 type-30 wrapper refs.');

for (const samplePath of samplePaths) {
    const { fileName, parser, extraction } = loadSample(samplePath);
    const payload = extraction.data;
    const direct = buildDirectRecordMap(parser, payload);
    const broad = buildBroadEntityMap(payload);
    const faces = buildBroadFaces(payload);

    const wrappers = [];
    for (const face of faces) {
        face.refs.forEach((refId, slotIndex) => {
            const record = direct.get(refId);
            if (!record) return;
            if (record.type !== ENTITY_SURFACE && record.type !== ENTITY_BSPLINE) return;
            if (record.payloadBytes > MAX_SHORT_PAYLOAD_BYTES) return;
            wrappers.push({ faceId: face.id, slotIndex, record });
        });
    }

    const broad133 = [...broad.values()].filter((entity) => entity.type === 133);
    const broad134 = [...broad.values()].filter((entity) => entity.type === 134);
    const direct32 = [...direct.values()].filter((record) => record.type === 32);
    const direct134 = [...direct.values()].filter((record) => record.type === 134);

    console.log(`\n== ${fileName} ==`);
    console.log(`broad type133 count=${broad133.length} broad type134 count=${broad134.length} direct type32 count=${direct32.length} direct type134 count=${direct134.length}`);

    const targetWrappers = wrappers.filter((wrapper) => wrapper.slotIndex === 3 && wrapper.record.type === ENTITY_SURFACE);
    if (targetWrappers.length === 0) {
        console.log('  no slot-3 type-30 wrappers');
        continue;
    }

    for (const wrapper of targetWrappers) {
        console.log(`  wrapper face=${wrapper.faceId} rec=${wrapper.record.id} bytes=${wrapper.record.payloadBytes} refs=[${wrapper.record.refIds.join(', ')}]`);
        wrapper.record.refIds.forEach((targetId, refIndex) => {
            console.log(`    ref${refIndex} id=${targetId} -> ${describeId(targetId, direct, broad)}`);
            const broadTarget = broad.get(targetId);
            if (broadTarget) {
                console.log(`      broad target refs=[${broadTarget.refs.join(', ')}]`);
                broadTarget.refs.slice(0, 8).forEach((childId, childIndex) => {
                    console.log(`        child${childIndex} id=${childId} -> ${describeId(childId, direct, broad)}`);
                });
            }
            const directTarget = direct.get(targetId);
            if (directTarget) {
                console.log(`      direct target type=${directTarget.type} bytes=${directTarget.payloadBytes} refs=[${directTarget.refIds.join(', ')}]`);
            }
        });
    }
}