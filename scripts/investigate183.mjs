#!/usr/bin/env bun
/**
 * investigate183.mjs — Walk the FTC_07 wrapper-loop graph.
 *
 * Goal:
 * 1. Start from the FTC_07 slot-3 wrapper loop ids (48, 49, 51, 52, 54).
 * 2. Traverse broad-entity and direct geometry-like refs for a few hops.
 * 3. Check whether that local graph reaches direct type-32/type-134 records or
 *    remains an isolated type-30/type-133 loop.
 */
import { loadSample, listSamplePaths } from './_payload-gap-lib.mjs';

const DEFAULT_FILTERS = ['ftc_07'];
const SEED_IDS = [48, 49, 51, 52, 54];
const MAX_DEPTH = 3;

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

function describeNode(id, direct, broad) {
    const directNode = direct.get(id);
    if (directNode) return { kind: 'direct', type: directNode.type, offset: directNode.offset, payloadBytes: directNode.payloadBytes, refs: directNode.refIds };
    const broadNode = broad.get(id);
    if (broadNode) return { kind: 'broad', type: broadNode.type, offset: broadNode.offset, payloadBytes: null, refs: broadNode.refs };
    return null;
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate183 — FTC_07 wrapper-loop graph');
console.log('Clean-room basis: breadth-first walk from the FTC_07 slot-3 wrapper-loop ids through broad and direct references.');

for (const samplePath of samplePaths) {
    const { fileName, parser, extraction } = loadSample(samplePath);
    const payload = extraction.data;
    const direct = buildDirectRecordMap(parser, payload);
    const broad = buildBroadEntityMap(payload);

    console.log(`\n== ${fileName} ==`);
    const queue = SEED_IDS.map((id) => ({ id, depth: 0 }));
    const seen = new Set();
    const reached = [];

    while (queue.length > 0) {
        const current = queue.shift();
        if (seen.has(current.id)) continue;
        seen.add(current.id);

        const node = describeNode(current.id, direct, broad);
        reached.push({ id: current.id, depth: current.depth, node });
        if (!node || current.depth >= MAX_DEPTH) continue;

        for (const refId of node.refs) {
            if (!seen.has(refId)) queue.push({ id: refId, depth: current.depth + 1 });
        }
    }

    for (const row of reached.sort((left, right) => left.depth - right.depth || left.id - right.id)) {
        if (!row.node) {
            console.log(`  depth=${row.depth} id=${row.id} -> none`);
            continue;
        }
        const refs = row.node.refs.slice(0, 8).join(', ');
        const extra = row.node.kind === 'direct' ? ` bytes=${row.node.payloadBytes}` : '';
        console.log(`  depth=${row.depth} id=${row.id} -> ${row.node.kind}(t${row.node.type}) offset=${row.node.offset}${extra} refs=[${refs}]`);
    }

    const reachedType32 = reached.filter((row) => row.node?.kind === 'direct' && row.node.type === 32);
    const reachedType134 = reached.filter((row) => row.node?.kind === 'direct' && row.node.type === 134);
    const reachedBroad133 = reached.filter((row) => row.node?.kind === 'broad' && row.node.type === 133);
    const reachedBroad134 = reached.filter((row) => row.node?.kind === 'broad' && row.node.type === 134);

    console.log(`  reached broad133=${reachedBroad133.length} broad134=${reachedBroad134.length} direct32=${reachedType32.length} direct134=${reachedType134.length}`);
}