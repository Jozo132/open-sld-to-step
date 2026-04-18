#!/usr/bin/env bun
/**
 * investigate190.mjs — Map FTC_07 broad-133 loop usage into wrappers and faces.
 *
 * Goal:
 * 1. Build the alternating direct type-30 / broad type-133 chain.
 * 2. Find raw FACE records and broad type-15 records that reference that chain.
 * 3. Summarize wrapper-by-wrapper face usage so the decoded segment loop can be
 *    placed in topology instead of treated as isolated geometry.
 */
import { loadSample } from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const TARGET_DIRECT_TYPE = 30;
const TARGET_BROAD_TYPE = 133;

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

function buildChainIds(direct, broad) {
    const broad133 = [...broad.values()].filter((record) => record.type === TARGET_BROAD_TYPE);
    const broadIds = new Set(broad133.map((record) => record.id));
    const directIds = new Set();

    for (const record of broad133) {
        if (direct.get(record.refs[1])?.type === TARGET_DIRECT_TYPE) directIds.add(record.refs[1]);
        if (direct.get(record.refs[2])?.type === TARGET_DIRECT_TYPE) directIds.add(record.refs[2]);
    }

    return {
        broad133: broad133.sort((left, right) => left.id - right.id),
        broadIds,
        directIds,
    };
}

function groupBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
        const key = keyFn(item);
        const bucket = map.get(key) ?? [];
        bucket.push(item);
        map.set(key, bucket);
    }
    return map;
}

const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const broad = buildBroadEntityMap(payload);
const { broad133, broadIds, directIds } = buildChainIds(direct, broad);

const chainWrappers = [...directIds]
    .map((id) => direct.get(id))
    .filter((record) => record && record.type === TARGET_DIRECT_TYPE)
    .sort((left, right) => left.id - right.id);

const rawFaces = parser.parseFaceRecords()
    .map((face) => {
        const hits = [];
        if (directIds.has(face.geometryLikeId)) hits.push({ kind: 'geometryLikeId', id: face.geometryLikeId });
        if (directIds.has(face.primaryRefId)) hits.push({ kind: 'primaryRefId', id: face.primaryRefId });
        if (directIds.has(face.secondaryRefId)) hits.push({ kind: 'secondaryRefId', id: face.secondaryRefId });
        if (broadIds.has(face.geometryLikeId)) hits.push({ kind: 'geometryLikeBroad', id: face.geometryLikeId });
        if (broadIds.has(face.primaryRefId)) hits.push({ kind: 'primaryBroad', id: face.primaryRefId });
        if (broadIds.has(face.secondaryRefId)) hits.push({ kind: 'secondaryBroad', id: face.secondaryRefId });
        return { face, hits };
    })
    .filter((row) => row.hits.length > 0)
    .sort((left, right) => left.face.id - right.face.id);

const broad15Hits = [...broad.values()]
    .filter((record) => record.type === 15)
    .map((record) => ({
        record,
        hits: record.refs
            .map((refId, slotIndex) => {
                if (directIds.has(refId)) return { slotIndex, refId, kind: 'direct30' };
                if (broadIds.has(refId)) return { slotIndex, refId, kind: 'broad133' };
                return null;
            })
            .filter((hit) => hit !== null),
    }))
    .filter((row) => row.hits.length > 0)
    .sort((left, right) => left.record.id - right.record.id);

const rawFacesByWrapper = groupBy(
    rawFaces.flatMap((row) => row.hits.filter((hit) => hit.kind === 'geometryLikeId').map((hit) => ({ wrapperId: hit.id, faceId: row.face.id }))),
    (row) => row.wrapperId,
);

const broad15ByWrapper = groupBy(
    broad15Hits.flatMap((row) => row.hits.filter((hit) => hit.kind === 'direct30').map((hit) => ({ wrapperId: hit.refId, faceId: row.record.id, slotIndex: hit.slotIndex }))),
    (row) => row.wrapperId,
);

console.log('investigate190 — FTC_07 broad-133 loop usage');
console.log('Clean-room basis: map the decoded broad-133 loop into adjacent direct type-30 wrappers and face-side records.');
console.log(`\n== ${fileName} ==`);
console.log(`broad133 segments=${broad133.length} wrappers=${chainWrappers.length}`);
console.log(`raw face hits=${rawFaces.length} broad type15 hits=${broad15Hits.length}`);

console.log('\nWrapper usage summary:');
for (const wrapper of chainWrappers) {
    const nextBroad = broad.get(wrapper.refIds[1]);
    const prevBroad = broad.get(wrapper.refIds[2]);
    const rawFaceList = (rawFacesByWrapper.get(wrapper.id) ?? []).map((row) => row.faceId).sort((left, right) => left - right);
    const broad15List = (broad15ByWrapper.get(wrapper.id) ?? [])
        .sort((left, right) => left.faceId - right.faceId || left.slotIndex - right.slotIndex)
        .map((row) => `#${row.faceId}@slot${row.slotIndex}`);
    console.log(
        `  wrapper=${wrapper.id} refs=[${wrapper.refIds.join(', ')}] ` +
        `prevBroad=${prevBroad?.id ?? 'none'} nextBroad=${nextBroad?.id ?? 'none'} ` +
        `rawFaces=[${rawFaceList.join(', ')}] broad15=[${broad15List.join(', ')}]`,
    );
}

console.log('\nRaw face records touching the chain:');
for (const row of rawFaces) {
    console.log(
        `  face=${row.face.id} geomLike=${row.face.geometryLikeId} primary=${row.face.primaryRefId} secondary=${row.face.secondaryRefId} ` +
        `shell=${row.face.shellId ?? 'n/a'} anchors=[${row.face.coedgeAnchorAId ?? 'n/a'}, ${row.face.edgeAnchorAId ?? 'n/a'}, ${row.face.coedgeAnchorBId ?? 'n/a'}, ${row.face.edgeAnchorBId ?? 'n/a'}] ` +
        `hits=${row.hits.map((hit) => `${hit.kind}:${hit.id}`).join(',')}`,
    );
}

console.log('\nBroad type-15 records touching the chain:');
for (const row of broad15Hits) {
    console.log(`  broad15=${row.record.id} refs=[${row.record.refs.slice(0, 8).join(', ')}] hits=${row.hits.map((hit) => `${hit.kind}:${hit.refId}@slot${hit.slotIndex}`).join(', ')}`);
}