#!/usr/bin/env bun
/**
 * investigate177.mjs — Audit whether direct type-31 records correlate with B-spline surfaces.
 *
 * Goal:
 * 1. Count reference B-spline surfaces and curves from the public STEP files.
 * 2. Measure large direct type-31 record spans in the extracted Parasolid payload.
 * 3. Check whether those large direct records behave like surface support:
 *    - explicit FACE geometry links
 *    - raw FACE payload hits
 *    - edge-only vs face-side usage
 *    - analytic-looking leading parameter blocks
 * 4. Compare B-spline-bearing files against controls to determine whether direct
 *    type-31 is a credible surface decoder entrypoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    ROOT,
    listSamplePaths,
    loadSample,
} from './_payload-gap-lib.mjs';

const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const LARGE_PAYLOAD_BYTES = 500;
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

function buildDirectType31Records(parser, payload) {
    const direct = [
        ...parser.parseCompactGeometryLikeRecords(),
        ...parser.parsePackedGeometryLikeRecords(),
    ].sort((left, right) => left.offset - right.offset);

    return direct
        .map((record, index) => {
            const nextOffset = direct[index + 1]?.offset ?? payload.length;
            const payloadBytes = Math.max(0, nextOffset - payloadStartOffset(record));
            return {
                ...record,
                payloadBytes,
            };
        })
        .filter((record) => record.type === 0x1f);
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

function computeLargeType31Components(records) {
    const byId = new Map(records.map((record) => [record.id, record]));
    const reverse = new Map();

    for (const record of records) {
        for (const refId of record.refIds) {
            if (!byId.has(refId)) continue;
            const bucket = reverse.get(refId) ?? [];
            bucket.push(record.id);
            reverse.set(refId, bucket);
        }
    }

    const seen = new Set();
    const components = [];

    for (const record of records) {
        if (seen.has(record.id)) continue;

        const stack = [record.id];
        seen.add(record.id);
        const members = [];

        while (stack.length > 0) {
            const currentId = stack.pop();
            members.push(currentId);

            const current = byId.get(currentId);
            if (!current) continue;

            for (const refId of current.refIds) {
                if (!byId.has(refId) || seen.has(refId)) continue;
                seen.add(refId);
                stack.push(refId);
            }

            for (const reverseId of reverse.get(currentId) ?? []) {
                if (seen.has(reverseId)) continue;
                seen.add(reverseId);
                stack.push(reverseId);
            }
        }

        const memberRecords = members
            .map((id) => byId.get(id))
            .filter((candidate) => candidate !== undefined);
        const largeMembers = memberRecords.filter((candidate) => candidate.payloadBytes >= LARGE_PAYLOAD_BYTES).length;
        const maxPayloadBytes = memberRecords.reduce((max, candidate) => Math.max(max, candidate.payloadBytes), 0);
        components.push({
            size: memberRecords.length,
            largeMembers,
            maxPayloadBytes,
        });
    }

    const withLarge = components.filter((component) => component.largeMembers > 0);
    return {
        componentCount: components.length,
        largeComponentCount: withLarge.length,
        largeComponentRows: withLarge
            .sort((left, right) => right.maxPayloadBytes - left.maxPayloadBytes || right.size - left.size)
            .slice(0, 8),
    };
}

function vectorMagnitude(x, y, z) {
    return Math.hypot(x, y, z);
}

function dot(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
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

function hasAnalyticPrefix(values) {
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

function summarizeLeadingValues(values) {
    return values.map((value) => Number(value.toPrecision(6))).join(', ');
}

function buildLargeType31Usage(parser, payload, records) {
    const largeRecords = records.filter((record) => record.payloadBytes >= LARGE_PAYLOAD_BYTES);
    const largeIds = new Set(largeRecords.map((record) => record.id));
    const edgeGeomHits = new Set(
        parser.parseEdgeRecords()
            .map((record) => record.geometryLikeId)
            .filter((id) => largeIds.has(id)),
    );
    const faceGeomHits = new Set(
        parser.parseFaceRecords()
            .map((record) => record.geometryLikeId)
            .filter((id) => largeIds.has(id)),
    );

    const rawFaceHits = new Map();
    const faceEntities = parser.extractAllEntities().filter((entity) => entity.type === 0x0f);
    for (const entity of faceEntities) {
        for (let offset = 0; offset + 2 <= entity.data.length; offset += 2) {
            const id = entity.data.readUInt16BE(offset);
            if (!largeIds.has(id)) continue;
            rawFaceHits.set(id, (rawFaceHits.get(id) ?? 0) + 1);
        }
    }

    const analyticLarge = [];
    const nonAnalyticLarge = [];
    for (const record of largeRecords) {
        const leading = readLeadingDoubles(payload, record);
        const summary = {
            id: record.id,
            payloadBytes: record.payloadBytes,
            refs: record.refIds,
            markerByte: record.markerByte,
            leading,
        };
        if (hasAnalyticPrefix(leading)) analyticLarge.push(summary);
        else nonAnalyticLarge.push(summary);
    }

    return {
        largeCount: largeRecords.length,
        edgeGeomHits: edgeGeomHits.size,
        faceGeomHits: faceGeomHits.size,
        rawFaceHitIds: rawFaceHits.size,
        rawFaceHitCount: [...rawFaceHits.values()].reduce((sum, value) => sum + value, 0),
        analyticLargeCount: analyticLarge.length,
        nonAnalyticLargeCount: nonAnalyticLarge.length,
        sampleFaceHitIds: [...rawFaceHits.keys()].slice(0, 20),
        sampleNonAnalytic: nonAnalyticLarge.slice(0, 6).map((record) => ({
            id: record.id,
            payloadBytes: record.payloadBytes,
            leading: summarizeLeadingValues(record.leading),
        })),
    };
}

function buildFullScanFaceLinkUsage(payload, records) {
    const byId = new Map(records.map((record) => [record.id, record]));
    const broad = buildBroadEntityMap(payload);
    const faceEntities = [...broad.values()].filter((entity) => entity.type === 15);
    const faceLinked = new Map();

    for (const entity of faceEntities) {
        for (const refId of entity.refs) {
            const record = byId.get(refId);
            if (!record) continue;
            const bucket = faceLinked.get(refId) ?? { faceCount: 0, payloadBytes: record.payloadBytes };
            bucket.faceCount++;
            faceLinked.set(refId, bucket);
        }
    }

    const allRows = [...faceLinked.entries()]
        .map(([id, value]) => ({ id, ...value }))
        .sort((left, right) => right.payloadBytes - left.payloadBytes || right.faceCount - left.faceCount || left.id - right.id);
    const largeRows = allRows.filter((row) => row.payloadBytes >= LARGE_PAYLOAD_BYTES);

    return {
        faceLinkedIds: allRows.length,
        largeFaceLinkedIds: largeRows.length,
        sampleFaceLinkedRows: allRows.slice(0, 10),
    };
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate177 — direct type-31 surface-correlation audit');
console.log('Clean-room basis: compare direct type-31 usage against public reference B-spline surfaces and curves.');
console.log(`Large direct type-31 threshold: ${LARGE_PAYLOAD_BYTES} bytes.`);

for (const samplePath of samplePaths) {
    const { fileName, parser, extraction } = loadSample(samplePath);
    const reference = countReferenceBsplines(fileName);
    const type31 = buildDirectType31Records(parser, extraction.data);
    const components = computeLargeType31Components(type31);
    const usage = buildLargeType31Usage(parser, extraction.data, type31);
    const broadFaceLinks = buildFullScanFaceLinkUsage(extraction.data, type31);

    console.log(`\n== ${fileName} ==`);
    console.log(`reference bspline surfaces: ${reference.surfaceCount}`);
    console.log(`reference bspline curves: ${reference.curveCount}`);
    console.log(`direct type-31 records: ${type31.length}`);
    console.log(`large direct type-31 records: ${usage.largeCount}`);
    console.log(`type-31 components: ${components.componentCount}`);
    console.log(`components with large members: ${components.largeComponentCount}`);
    console.log(`large direct ids used by explicit edges: ${usage.edgeGeomHits}`);
    console.log(`large direct ids used by explicit faces: ${usage.faceGeomHits}`);
    console.log(`large direct ids appearing anywhere in raw FACE payloads: ${usage.rawFaceHitIds}`);
    console.log(`total raw FACE payload hits for large direct ids: ${usage.rawFaceHitCount}`);
    console.log(`full-scan face-linked direct type-31 ids: ${broadFaceLinks.faceLinkedIds}`);
    console.log(`full-scan face-linked large direct type-31 ids: ${broadFaceLinks.largeFaceLinkedIds}`);
    console.log(`analytic-prefix large direct ids: ${usage.analyticLargeCount}`);
    console.log(`non-analytic-prefix large direct ids: ${usage.nonAnalyticLargeCount}`);
    if (usage.sampleFaceHitIds.length > 0) {
        console.log(`sample raw FACE hit ids: ${usage.sampleFaceHitIds.join(', ')}`);
    }
    if (components.largeComponentRows.length > 0) {
        console.log('top large components:');
        for (const component of components.largeComponentRows) {
            console.log(
                `  - size=${component.size} largeMembers=${component.largeMembers} maxBytes=${component.maxPayloadBytes}`,
            );
        }
    }
    if (usage.sampleNonAnalytic.length > 0) {
        console.log('sample non-analytic large prefixes:');
        for (const record of usage.sampleNonAnalytic) {
            console.log(`  - id=${record.id} bytes=${record.payloadBytes} leading=${record.leading}`);
        }
    }
    if (broadFaceLinks.sampleFaceLinkedRows.length > 0) {
        console.log('sample full-scan face-linked direct ids:');
        for (const row of broadFaceLinks.sampleFaceLinkedRows) {
            console.log(`  - id=${row.id} bytes=${row.payloadBytes} faceRefs=${row.faceCount}`);
        }
    }
}