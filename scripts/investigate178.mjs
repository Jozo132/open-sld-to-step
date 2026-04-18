#!/usr/bin/env bun
/**
 * investigate178.mjs — Audit remaining face-side opaque channels after direct type-31 rejection.
 *
 * Goal:
 * 1. Count reference B-spline surfaces and curves from the public STEP files.
 * 2. Compare the remaining face-side channels across target and control files:
 *    - raw FACE 30-69 inline windows
 *    - type-0x11 shell payload geometry-like segments (0x2B00/0x2D00)
 *    - full-scan face-linked direct type-30/type-31 records
 * 3. Check whether face-linked direct records still look like short analytic wrappers
 *    instead of hidden B-spline surface payloads.
 * 4. Expose per-file channel signatures so the next decoder target can be chosen
 *    from evidence rather than from one file's local behavior.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    ROOT,
    listSamplePaths,
    loadSample,
    splitShellPayloadSegments,
} from './_payload-gap-lib.mjs';

const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const DEFAULT_FILTERS = ['ctc_01', 'ctc_02', 'ctc_04', 'ctc_05', 'ftc_07', 'ftc_08', 'ftc_10', 'ftc_11'];

function referencePathForSample(fileName) {
    const lower = fileName.toLowerCase();
    const definitionDir = lower.includes('_ctc_') ? 'CTC Definitions' : 'FTC Definitions';
    return path.join(
        REFERENCE_ROOT,
        definitionDir,
        lower.replace('_sw1802.sldprt', '.stp'),
    );
}

function extractJoinedData(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return '';
    return normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
}

function countReferenceBsplines(fileName) {
    const text = fs.readFileSync(referencePathForSample(fileName), 'utf8');
    const joined = extractJoinedData(text);
    return {
        surfaceCount: (joined.match(/B_SPLINE_SURFACE_WITH_KNOTS\s*\(/gi) || []).length,
        curveCount: (joined.match(/B_SPLINE_CURVE_WITH_KNOTS\s*\(/gi) || []).length,
    };
}

function payloadStartOffset(record) {
    return 'trailer' in record ? record.offset + 20 : record.offset + 19;
}

function readLeadingDoubles(payload, record, limit = 10) {
    const start = payloadStartOffset(record);
    const end = Math.min(start + limit * 8, start + record.payloadBytes);
    const values = [];
    for (let offset = start; offset + 8 <= end; offset += 8) {
        values.push(payload.readDoubleBE(offset));
    }
    return values;
}

function buildDirectRecordMap(parser, payload) {
    const direct = [
        ...parser.parseCompactGeometryLikeRecords(),
        ...parser.parsePackedGeometryLikeRecords(),
    ].sort((left, right) => left.offset - right.offset);

    const records = new Map();
    for (let index = 0; index < direct.length; index++) {
        const record = direct[index];
        if (record.type !== 0x1e && record.type !== 0x1f) continue;

        const nextOffset = direct[index + 1]?.offset ?? payload.length;
        const payloadBytes = Math.max(0, nextOffset - payloadStartOffset(record));
        records.set(record.id, {
            ...record,
            payloadBytes,
        });
    }

    return records;
}

function buildBroadEntityMap(payload) {
    const entities = new Map();
    const sentinel = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);
    const sentinelOffsets = [];
    let sentinelIndex = 0;

    while ((sentinelIndex = payload.indexOf(sentinel, sentinelIndex)) >= 0 && sentinelOffsets.length < 10000) {
        sentinelOffsets.push(sentinelIndex);
        sentinelIndex++;
    }

    for (let offset = 0; offset < payload.length - 11; offset++) {
        if (payload[offset + 2] !== 0xff) continue;
        const type = payload.readUInt16BE(offset);
        const id = payload.readUInt16BE(offset + 3);
        const zero = payload.readUInt16BE(offset + 5);
        const one = payload.readUInt16BE(offset + 9);
        if (zero !== 0 || one !== 1 || type < 1 || type > 200 || id < 1 || id > 10000) continue;
        if (entities.has(id)) continue;

        const refs = [];
        for (let index = 0; index < 12; index++) {
            const refOffset = offset + 11 + index * 2;
            if (refOffset + 2 > payload.length) break;
            refs.push(payload.readUInt16BE(refOffset));
        }
        entities.set(id, { type, id, refs });
    }

    for (const sentinelOffset of sentinelOffsets) {
        const coedgeOffset = sentinelOffset - 18;
        if (coedgeOffset >= 0) {
            const type = payload.readUInt16BE(coedgeOffset);
            const id = payload.readUInt16BE(coedgeOffset + 2);
            const zero = payload.readUInt16BE(coedgeOffset + 4);
            const one = payload.readUInt16BE(coedgeOffset + 8);
            if (type === 18 && zero === 0 && one === 1 && id > 0 && id <= 10000 && !entities.has(id)) {
                const refs = [];
                for (let index = 0; index < 4; index++) {
                    refs.push(payload.readUInt16BE(coedgeOffset + 10 + index * 2));
                }
                entities.set(id, { type, id, refs });
            }
        }

        const edgeOffset = sentinelOffset - 10;
        if (edgeOffset >= 0) {
            const type = payload.readUInt16BE(edgeOffset);
            const id = payload.readUInt16BE(edgeOffset + 2);
            const zero = payload.readUInt16BE(edgeOffset + 4);
            const one = payload.readUInt16BE(edgeOffset + 8);
            if (type === 16 && zero === 0 && one === 1 && id > 0 && id <= 10000 && !entities.has(id)) {
                const refs = [];
                const refsStart = sentinelOffset + sentinel.length;
                for (let index = 0; index < 8; index++) {
                    const refOffset = refsStart + index * 2;
                    if (refOffset + 2 > payload.length) break;
                    refs.push(payload.readUInt16BE(refOffset));
                }
                entities.set(id, { type, id, refs });
            }
        }

        const pointOffset = sentinelOffset + sentinel.length;
        if (pointOffset + 42 <= payload.length) {
            const type = payload.readUInt16BE(pointOffset + 2);
            const id = payload.readUInt16BE(pointOffset + 4);
            const zero = payload.readUInt16BE(pointOffset + 6);
            const one = payload.readUInt16BE(pointOffset + 10);
            if (type === 29 && zero === 0 && one === 1 && id > 0 && id <= 10000 && !entities.has(id)) {
                const refs = [];
                for (let index = 0; index < 3; index++) {
                    refs.push(payload.readUInt16BE(pointOffset + 12 + index * 2));
                }
                entities.set(id, { type, id, refs });
            }
        }
    }

    for (let offset = 0; offset < payload.length - 30; offset++) {
        const type = payload.readUInt16BE(offset);
        const id = payload.readUInt16BE(offset + 2);
        const zero = payload.readUInt16BE(offset + 4);
        const one = payload.readUInt16BE(offset + 8);
        if (zero !== 0 || one !== 1 || type < 1 || type > 200 || id < 1 || id > 10000) continue;
        if (entities.has(id)) continue;
        if (![15, 16, 17, 19, 30, 31, 50, 51].includes(type)) continue;

        const refs = [];
        for (let index = 0; index < 12; index++) {
            const refOffset = offset + 10 + index * 2;
            if (refOffset + 2 > payload.length) break;
            refs.push(payload.readUInt16BE(refOffset));
        }
        entities.set(id, { type, id, refs });
    }

    return entities;
}

function vectorMagnitude(x, y, z) {
    return Math.hypot(x, y, z);
}

function dot(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

function hasAnalyticRotationalPrefix(values) {
    if (values.length < 10) return false;

    const axis = { x: values[3], y: values[4], z: values[5] };
    const refdir = { x: values[6], y: values[7], z: values[8] };
    const axisMag = vectorMagnitude(axis.x, axis.y, axis.z);
    const refdirMag = vectorMagnitude(refdir.x, refdir.y, refdir.z);
    const radius = values[9];

    if (axisMag < 0.8 || axisMag > 1.2) return false;
    if (refdirMag < 0.8 || refdirMag > 1.2) return false;
    if (Math.abs(dot(axis, refdir)) > 0.15) return false;
    if (!(radius > 0 && radius < 1)) return false;
    return true;
}

function hasShortAxisLikePrefix(values, payloadBytes) {
    if (payloadBytes > 160 || values.length < 6) return false;
    const axisMag = vectorMagnitude(values[3], values[4], values[5]);
    return axisMag >= 0.8 && axisMag <= 1.2;
}

function summarizeFaceLinkedDirect(parser, payload) {
    const directRecords = buildDirectRecordMap(parser, payload);
    const faceLinkedIds = new Set();
    const slotCounts = new Map();

    for (const entity of buildBroadEntityMap(payload).values()) {
        if (entity.type !== 15) continue;
        entity.refs.forEach((ref, index) => {
            const record = directRecords.get(ref);
            if (!record) return;

            faceLinkedIds.add(ref);
            const sizeClass = record.payloadBytes >= 500 ? 'long' : 'short';
            const slotKey = `slot${index}/type${record.type}/${sizeClass}`;
            slotCounts.set(slotKey, (slotCounts.get(slotKey) ?? 0) + 1);
        });
    }

    const rows = [...faceLinkedIds]
        .map((id) => {
            const record = directRecords.get(id);
            const leading = readLeadingDoubles(payload, record, 10);
            const shape = hasAnalyticRotationalPrefix(leading)
                ? 'analytic-rotational'
                : hasShortAxisLikePrefix(leading, record.payloadBytes)
                    ? 'short-axis-like'
                    : 'other';
            return {
                id: record.id,
                type: record.type,
                payloadBytes: record.payloadBytes,
                markerByte: record.markerByte,
                refIds: record.refIds,
                leading,
                shape,
            };
        })
        .sort((left, right) => right.payloadBytes - left.payloadBytes || left.type - right.type || left.id - right.id);

    const counts = {
        total: rows.length,
        type30: rows.filter((row) => row.type === 0x1e).length,
        type31: rows.filter((row) => row.type === 0x1f).length,
        shortAxisLike: rows.filter((row) => row.shape === 'short-axis-like').length,
        analyticRotational: rows.filter((row) => row.shape === 'analytic-rotational').length,
        other: rows.filter((row) => row.shape === 'other').length,
        longCount: rows.filter((row) => row.payloadBytes >= 500).length,
    };

    return {
        counts,
        slotRows: [...slotCounts.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 8)
            .map(([key, count]) => ({ key, count })),
        sampleRows: rows.slice(0, 8).map((row) => ({
            id: row.id,
            type: row.type,
            bytes: row.payloadBytes,
            markerByte: row.markerByte,
            shape: row.shape,
            refs: row.refIds,
            leading: row.leading.map((value) => Number(value.toPrecision(6))),
        })),
    };
}

function summarizeShellGeomSegments(parser) {
    const anchorKeys = new Set(
        parser.parseShellInlineFaceAnchorRecords().map((record) => `${record.shellId}:${record.segmentIndex}`),
    );
    const familyCounts = new Map();
    const familyExamples = new Map();
    let total = 0;
    let adjacentToAnchor = 0;

    for (const entity of parser.extractAllEntities().filter((candidate) => candidate.type === 0x11)) {
        for (const segment of splitShellPayloadSegments(entity.data)) {
            const firstWord = segment.words[0] ?? -1;
            if (firstWord !== 0x2b00 && firstWord !== 0x2d00) continue;

            total++;
            const familyKey = `0x${firstWord.toString(16)}/len${segment.words.length}`;
            familyCounts.set(familyKey, (familyCounts.get(familyKey) ?? 0) + 1);
            if (!familyExamples.has(familyKey)) {
                familyExamples.set(familyKey, {
                    shellId: entity.id,
                    segmentIndex: segment.segmentIndex,
                    words: segment.words.slice(0, 8),
                });
            }

            const prevKey = `${entity.id}:${segment.segmentIndex - 1}`;
            const nextKey = `${entity.id}:${segment.segmentIndex + 1}`;
            if (anchorKeys.has(prevKey) || anchorKeys.has(nextKey)) adjacentToAnchor++;
        }
    }

    return {
        total,
        adjacentToAnchor,
        familyRows: [...familyCounts.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 8)
            .map(([key, count]) => ({
                key,
                count,
                example: familyExamples.get(key),
            })),
    };
}

function summarizeFaceWindows(parser) {
    const windows = parser.parseFaceInlineWindowRecords();
    const familyCounts = new Map();

    for (const record of windows) {
        const key = [
            `marker=0x${record.markerWord.toString(16)}`,
            `tag=0x${(record.inlineTagWord >> 8).toString(16)}`,
            `selfFace=${record.hasSelfFaceTail ? 1 : 0}`,
            `selfShell=${record.hasSelfShellTail ? 1 : 0}`,
        ].join(' ');
        familyCounts.set(key, (familyCounts.get(key) ?? 0) + 1);
    }

    return {
        count: windows.length,
        familyRows: [...familyCounts.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 8)
            .map(([key, count]) => ({ key, count })),
    };
}

function channelSignature(summary) {
    return [
        summary.shellGeom.total > 0 ? 'S1' : 'S0',
        summary.faceWindows.count > 0 ? 'F1' : 'F0',
        summary.faceLinkedDirect.counts.total > 0 ? 'D1' : 'D0',
    ].join('/');
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);
const summaries = [];

console.log('investigate178 — remaining face-side opaque channels');
console.log('Clean-room basis: compare shell-local segments, raw FACE inline windows, and face-linked direct type-30/type-31 records after the large direct type-31 path failed.');

for (const samplePath of samplePaths) {
    const { fileName, parser, extraction } = loadSample(samplePath);
    const reference = countReferenceBsplines(fileName);
    const shellGeom = summarizeShellGeomSegments(parser);
    const faceWindows = summarizeFaceWindows(parser);
    const faceLinkedDirect = summarizeFaceLinkedDirect(parser, extraction.data);
    const summary = {
        fileName,
        reference,
        shellGeom,
        faceWindows,
        faceLinkedDirect,
        signature: null,
    };
    summary.signature = channelSignature(summary);
    summaries.push(summary);

    console.log(`\n== ${fileName} ==`);
    console.log(`reference bspline surfaces: ${reference.surfaceCount}`);
    console.log(`reference bspline curves: ${reference.curveCount}`);
    console.log(`channel signature: ${summary.signature}`);

    console.log(`shell 0x2B00/0x2D00 segments: total=${shellGeom.total} adjacentToAnchor=${shellGeom.adjacentToAnchor}`);
    if (shellGeom.familyRows.length === 0) console.log('top shell segment families: none');
    else {
        console.log('top shell segment families:');
        for (const row of shellGeom.familyRows) {
            const example = row.example;
            console.log(
                `  - ${row.key} count=${row.count} ` +
                `exampleShell=${example.shellId} seg=${example.segmentIndex} words=${example.words.join(',')}`,
            );
        }
    }

    console.log(`raw FACE inline windows: ${faceWindows.count}`);
    if (faceWindows.familyRows.length === 0) console.log('top FACE window families: none');
    else {
        console.log('top FACE window families:');
        for (const row of faceWindows.familyRows) {
            console.log(`  - ${row.key} count=${row.count}`);
        }
    }

    const directCounts = faceLinkedDirect.counts;
    console.log(
        'face-linked direct records: ' +
        `total=${directCounts.total} type30=${directCounts.type30} type31=${directCounts.type31} ` +
        `shortAxisLike=${directCounts.shortAxisLike} analyticRotational=${directCounts.analyticRotational} ` +
        `long=${directCounts.longCount} other=${directCounts.other}`,
    );
    if (faceLinkedDirect.slotRows.length === 0) console.log('direct face-slot hits: none');
    else {
        console.log('direct face-slot hits:');
        for (const row of faceLinkedDirect.slotRows) {
            console.log(`  - ${row.key} count=${row.count}`);
        }
    }
    if (faceLinkedDirect.sampleRows.length === 0) console.log('sample face-linked direct rows: none');
    else {
        console.log('sample face-linked direct rows:');
        for (const row of faceLinkedDirect.sampleRows) {
            console.log(
                `  - type=${row.type} id=${row.id} bytes=${row.bytes} marker=0x${row.markerByte.toString(16)} ` +
                `shape=${row.shape} refs=${row.refs.join(',')} leading=${row.leading.join(',')}`,
            );
        }
    }
}

const bySignature = new Map();
for (const summary of summaries) {
    const bucket = bySignature.get(summary.signature) ?? [];
    bucket.push(summary);
    bySignature.set(summary.signature, bucket);
}

console.log('\n== channel signature summary ==');
for (const [signature, rows] of [...bySignature.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const fileNames = rows.map((row) => row.fileName).join(', ');
    const targetCount = rows.filter((row) => row.reference.surfaceCount > 0).length;
    console.log(`  - ${signature}: files=${rows.length} targetFiles=${targetCount} -> ${fileNames}`);
}
