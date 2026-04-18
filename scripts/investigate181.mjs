#!/usr/bin/env bun
/**
 * investigate181.mjs — Audit face-linked wrapper dependency graphs.
 *
 * Goal:
 * 1. Collect short face-linked direct type-30/type-31 records by broad FACE slot.
 * 2. Summarize the direct-record types reached through each wrapper's refIds.
 * 3. Test whether the FTC_07 slot-3 type-30 family consistently routes into the
 *    unresolved type-32/type-134 branch, distinguishing it from the slot-6
 *    analytic-wrapper regimes used by CTC_02/04/05/10.
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
        faces.push({ id, refs, offset });
    }
    return faces;
}

function buildBroadEntityMap(payload) {
    const entities = new Map();
    for (let offset = 0; offset < payload.length - 34; offset++) {
        const type = payload.readUInt16BE(offset);
        const id = payload.readUInt16BE(offset + 2);
        const zero = payload.readUInt16BE(offset + 4);
        const one = payload.readUInt16BE(offset + 8);
        if (zero !== 0 || one !== 1 || type < 1 || type > 200 || id < 1 || id > 11000) continue;
        if (!entities.has(id)) entities.set(id, type);
    }
    return entities;
}

function typeLabel(record) {
    if (!record) return 'none';
    return `t${record.type}/${record.payloadBytes}`;
}

function generalTypeLabel(type) {
    return type === null ? 'none' : `raw${type}`;
}

function sizeClass(payloadBytes) {
    return payloadBytes > MAX_SHORT_PAYLOAD_BYTES ? 'long' : 'short';
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate181 — face-linked wrapper dependency graphs');
console.log('Clean-room basis: compare the direct-record dependency signatures reached through short broad-face wrappers.');

for (const samplePath of samplePaths) {
    const { fileName, parser, extraction } = loadSample(samplePath);
    const payload = extraction.data;
    const direct = buildDirectRecordMap(parser, payload);
    const faces = buildBroadFaces(payload);
    const rawEntities = new Map(parser.extractAllEntities().map((entity) => [entity.id, entity.type]));
    const broadEntities = buildBroadEntityMap(payload);
    const rows = [];

    for (const face of faces) {
        face.refs.forEach((refId, slotIndex) => {
            const record = direct.get(refId);
            if (!record) return;
            if (record.type !== ENTITY_SURFACE && record.type !== ENTITY_BSPLINE) return;
            if (record.payloadBytes > MAX_SHORT_PAYLOAD_BYTES) return;

            const targets = record.refIds.map((targetId) => ({
                id: targetId,
                record: direct.get(targetId) ?? null,
                rawType: rawEntities.get(targetId) ?? null,
                broadType: broadEntities.get(targetId) ?? null,
            }));
            rows.push({
                faceId: face.id,
                slotIndex,
                record,
                targets,
                signature: targets.map((target) => typeLabel(target.record)).join('|'),
                rawSignature: targets.map((target) => {
                    if (target.record) return typeLabel(target.record);
                    if (target.rawType !== null) return generalTypeLabel(target.rawType);
                    if (target.broadType !== null) return `broad${target.broadType}`;
                    return 'none';
                }).join('|'),
            });
        });
    }

    const summary = new Map();
    for (const row of rows) {
        const key = `slot${row.slotIndex}/type${row.record.type}/${sizeClass(row.record.payloadBytes)}/${row.rawSignature}`;
        const entry = summary.get(key) ?? { count: 0, samples: [] };
        entry.count++;
        if (entry.samples.length < 6) {
            entry.samples.push({
                faceId: row.faceId,
                recordId: row.record.id,
                payloadBytes: row.record.payloadBytes,
                refIds: row.record.refIds,
                targetTypes: row.targets.map((target) => target.record ? target.record.type : null),
                targetSizes: row.targets.map((target) => target.record ? target.record.payloadBytes : null),
                rawTargetTypes: row.targets.map((target) => target.rawType),
                broadTargetTypes: row.targets.map((target) => target.broadType),
            });
        }
        summary.set(key, entry);
    }

    console.log(`\n== ${fileName} ==`);
    console.log(`short face-linked type30/type31 rows: ${rows.length}`);
    if (summary.size === 0) {
        console.log('  none');
        continue;
    }

    for (const [key, value] of [...summary.entries()].sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))) {
        console.log(`  ${key} count=${value.count}`);
        for (const sample of value.samples) {
            console.log(
                `    face=${sample.faceId} rec=${sample.recordId} bytes=${sample.payloadBytes} ` +
                `refs=[${sample.refIds.join(', ')}] targetTypes=[${sample.targetTypes.join(', ')}] targetSizes=[${sample.targetSizes.join(', ')}] ` +
                `rawTargetTypes=[${sample.rawTargetTypes.join(', ')}] broadTargetTypes=[${sample.broadTargetTypes.join(', ')}]`,
            );
        }
    }
}