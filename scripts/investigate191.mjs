#!/usr/bin/env bun
/**
 * investigate191.mjs — Check whether the FTC_07 low-id wrapper refs are shell-inline faces.
 *
 * Goal:
 * 1. Collect the low-id non-broad refs carried by the alternating wrapper chain.
 * 2. Resolve those ids against shell-inline face records and anchor records.
 * 3. Determine whether the open broad-133 end closes into shell-inline face
 *    records instead of another global/broad record family.
 */
import { loadSample } from './_payload-gap-lib.mjs';

const SAMPLE_PATH = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT';

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

const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const broad = buildBroadEntityMap(payload);

const broad133 = [...broad.values()].filter((record) => record.type === 133);
const chainDirectIds = new Set();
for (const record of broad133) {
    if (direct.get(record.refs[1])?.type === 30) chainDirectIds.add(record.refs[1]);
    if (direct.get(record.refs[2])?.type === 30) chainDirectIds.add(record.refs[2]);
}

const chainWrappers = [...chainDirectIds]
    .map((id) => direct.get(id))
    .filter((record) => record && record.type === 30)
    .sort((left, right) => left.id - right.id);

const lowIds = new Set();
for (const wrapper of chainWrappers) {
    for (const refId of [wrapper.refIds[2], wrapper.refIds[3]]) {
        if (refId <= 255 && !broad.has(refId) && !direct.has(refId)) lowIds.add(refId);
    }
}

const inlineFaces = parser.parseShellInlineFaceRecords();
const inlineAnchors = parser.parseShellInlineFaceAnchorRecords();

const inlineById = new Map();
for (const record of inlineFaces) {
    const bucket = inlineById.get(record.inlineId) ?? [];
    bucket.push(record);
    inlineById.set(record.inlineId, bucket);
}

const anchorsByInlineId = new Map();
for (const record of inlineAnchors) {
    const bucket = anchorsByInlineId.get(record.inlineId) ?? [];
    bucket.push(record);
    anchorsByInlineId.set(record.inlineId, bucket);
}

console.log('investigate191 — FTC_07 shell-inline companion ids');
console.log('Clean-room basis: test whether the low-id non-broad refs around the wrapper chain resolve as shell-inline face records.');
console.log(`\n== ${fileName} ==`);
console.log(`wrapper count=${chainWrappers.length} low-id candidates=[${[...lowIds].sort((left, right) => left - right).join(', ')}]`);

console.log('\nWrapper low-id refs:');
for (const wrapper of chainWrappers) {
    console.log(`  wrapper=${wrapper.id} prevRef=${wrapper.refIds[2]} tailRef=${wrapper.refIds[3]}`);
}

console.log('\nShell-inline face matches:');
for (const inlineId of [...lowIds].sort((left, right) => left - right)) {
    const rows = inlineById.get(inlineId) ?? [];
    const anchors = anchorsByInlineId.get(inlineId) ?? [];
    if (rows.length === 0 && anchors.length === 0) {
        console.log(`  inlineId=${inlineId} -> none`);
        continue;
    }
    console.log(`  inlineId=${inlineId} faces=${rows.length} anchors=${anchors.length}`);
    for (const row of rows.slice(0, 6)) {
        console.log(`    shell=${row.shellId} seg=${row.segmentIndex} words=${row.wordLength} refs=[${row.refs.join(', ')}]`);
    }
    for (const anchor of anchors.slice(0, 6)) {
        console.log(`    anchor shell=${anchor.shellId} seg=${anchor.segmentIndex} coedge=${anchor.coedgeAnchorId} edge=${anchor.edgeAnchorId} refs=[${anchor.refAId}, ${anchor.refBId}, ${anchor.refCId}]`);
    }
  }

console.log('\nInline records that reference chain ids:');
for (const row of inlineFaces) {
    const hits = row.refs.filter((refId) => chainDirectIds.has(refId) || broad.has(refId));
    if (hits.length === 0) continue;
    console.log(`  inlineId=${row.inlineId} shell=${row.shellId} seg=${row.segmentIndex} refs=[${row.refs.join(', ')}] hits=[${hits.join(', ')}]`);
}