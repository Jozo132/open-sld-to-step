#!/usr/bin/env bun
/**
 * investigate193.mjs — Test wrapper 51 as an entrypoint into the FTC_07 loop.
 *
 * Goal:
 * 1. Start from wrapper 51, which is the only direct type-30 wrapper hit by
 *    broad type-15 FACE-like records.
 * 2. Follow the alternating broad-133/type-30 chain in both directions.
 * 3. Verify whether that single entrypoint reconstructs the full wrapper and
 *    broad-133 loop, including both endcaps.
 */
import { loadSample } from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';
const START_WRAPPER_ID = 51;

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

function walkDirection(startWrapperId, direct, broad, direction) {
    const wrappers = [];
    const segments = [];
    const seenWrappers = new Set();
    let currentWrapperId = startWrapperId;

    while (currentWrapperId && !seenWrappers.has(currentWrapperId)) {
        seenWrappers.add(currentWrapperId);
        const wrapper = direct.get(currentWrapperId);
        if (!wrapper) break;
        wrappers.push(wrapper.id);

        const broadId = direction === 'forward' ? wrapper.refIds[1] : wrapper.refIds[2];
        const segment = broad.get(broadId);
        if (!segment || segment.type !== 133) {
            return {
                wrappers,
                segments,
                terminalWrapperId: wrapper.id,
                terminalBroadId: broadId,
                terminalReason: segment ? `non133:t${segment.type}` : 'missing-broad',
            };
        }
        segments.push(segment.id);
        currentWrapperId = direction === 'forward' ? segment.refs[1] : segment.refs[2];
    }

    return {
        wrappers,
        segments,
        terminalWrapperId: currentWrapperId,
        terminalBroadId: null,
        terminalReason: 'cycle-or-end',
    };
}

const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const broad = buildBroadEntityMap(payload);

const broad15Hits = [...broad.values()]
    .filter((record) => record.type === 15)
    .map((record) => ({
        id: record.id,
        slotHits: record.refs
            .map((refId, slotIndex) => ({ refId, slotIndex }))
            .filter((hit) => hit.refId === START_WRAPPER_ID),
        refs: record.refs,
    }))
    .filter((row) => row.slotHits.length > 0)
    .sort((left, right) => left.id - right.id);

const forward = walkDirection(START_WRAPPER_ID, direct, broad, 'forward');
const backward = walkDirection(START_WRAPPER_ID, direct, broad, 'backward');

const allBroad133 = [...broad.values()].filter((record) => record.type === 133).map((record) => record.id).sort((left, right) => left - right);
const allChainWrappers = [...new Set(allBroad133.flatMap((id) => {
    const record = broad.get(id);
    return [record.refs[1], record.refs[2]].filter((refId) => direct.get(refId)?.type === 30);
}))].sort((left, right) => left - right);

const reachedWrappers = [...new Set([...backward.wrappers].reverse().concat(forward.wrappers.slice(1)))];
const reachedSegments = [...new Set([...backward.segments].reverse().concat(forward.segments))];

console.log('investigate193 — FTC_07 wrapper 51 entrypoint');
console.log('Clean-room basis: test whether the only face-side wrapper hit reconstructs the whole alternating broad-133/type-30 chain.');
console.log(`\n== ${fileName} ==`);
console.log(`entry wrapper=${START_WRAPPER_ID}`);

console.log('\nBroad type-15 face-side hits on wrapper 51:');
for (const hit of broad15Hits) {
    console.log(`  broad15=${hit.id} slots=[${hit.slotHits.map((row) => row.slotIndex).join(', ')}] refs=[${hit.refs.slice(0, 8).join(', ')}]`);
}

console.log('\nBackward walk from wrapper 51:');
console.log(`  wrappers=[${backward.wrappers.join(', ')}]`);
console.log(`  broad133=[${backward.segments.join(', ')}]`);
console.log(`  terminalWrapper=${backward.terminalWrapperId} terminalBroad=${backward.terminalBroadId ?? 'n/a'} reason=${backward.terminalReason}`);

console.log('\nForward walk from wrapper 51:');
console.log(`  wrappers=[${forward.wrappers.join(', ')}]`);
console.log(`  broad133=[${forward.segments.join(', ')}]`);
console.log(`  terminalWrapper=${forward.terminalWrapperId} terminalBroad=${forward.terminalBroadId ?? 'n/a'} reason=${forward.terminalReason}`);

console.log('\nCombined reach from wrapper 51:');
console.log(`  reachedWrappers=[${reachedWrappers.join(', ')}]`);
console.log(`  reachedBroad133=[${reachedSegments.join(', ')}]`);
console.log(`  allChainWrappers=[${allChainWrappers.join(', ')}]`);
console.log(`  allBroad133=[${allBroad133.join(', ')}]`);
console.log(`  coversAllWrappers=${reachedWrappers.length === allChainWrappers.length}`);
console.log(`  coversAllBroad133=${reachedSegments.length === allBroad133.length}`);