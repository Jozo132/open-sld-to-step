#!/usr/bin/env bun
/**
 * investigate186.mjs — Profile FTC_07 reachable type-32 scalar pairs.
 *
 * Goal:
 * 1. Walk the FTC_07 wrapper-loop branch and collect reachable type-32 records.
 * 2. Decode their first marker payload and compare floats[9] and floats[10].
 * 3. Test whether the second scalar behaves like a length family rather than a
 *    cone semi-angle, which would rule out direct type-32 -> cone extraction.
 */
import { loadSample } from './_payload-gap-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REFERENCE_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
    'nist_ftc_07_asme1_rd.stp',
);

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

function firstMarkerFloats(payload, record) {
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
            if (floats.length >= 11) return { marker, markerIdx, floats };
        }
    }
    return null;
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function entitySignature(entity) {
    return [entity.type, ...(entity.types ?? []), entity.args].join(' ');
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function parseStepEntities(text) {
    const entities = new Map();
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;
    const joined = normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
    const lineRe = /^#(\d+)\s*=\s*(.+);$/gm;
    let match;
    while ((match = lineRe.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complex = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complex) {
            const types = complex[1].split(',').map((value) => value.trim());
            entities.set(id, { type: types.sort().join(','), types, args: complex[2] });
            continue;
        }
        const simple = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simple) {
            entities.set(id, { type: simple[1], types: [simple[1]], args: simple[2] });
            continue;
        }
        entities.set(id, { type: '???', types: [], args: rest });
    }
    return entities;
}

function resolvePlaneAngleMeasureFactor(entities, id, seen = new Set()) {
    if (seen.has(id)) return null;
    seen.add(id);
    const entity = entities.get(id);
    if (!entity) return null;
    const measureMatch = entity.args.match(/PLANE_ANGLE_MEASURE\(\s*([0-9.eE+\-]+)\s*\)/);
    if (measureMatch) return Number(measureMatch[1]);
    for (const ref of extractRefs(entity.args)) {
        const factor = resolvePlaneAngleMeasureFactor(entities, ref, seen);
        if (factor !== null) return factor;
    }
    return null;
}

function resolvePlaneAngleUnitFactor(entities, id) {
    const entity = entities.get(id);
    if (!entity) return null;
    const signature = entitySignature(entity);
    const hasPlaneAngleUnit = entity.types.includes('PLANE_ANGLE_UNIT') || /PLANE_ANGLE_UNIT\s*\(/i.test(signature);
    if (!hasPlaneAngleUnit) return null;
    if ((entity.types.includes('SI_UNIT') || /SI_UNIT\s*\(/i.test(signature)) && /\.RADIAN\./i.test(signature)) {
        return 1;
    }
    if (entity.types.includes('CONVERSION_BASED_UNIT') || /CONVERSION_BASED_UNIT\s*\(/i.test(signature)) {
        for (const ref of extractRefs(entity.args)) {
            const factor = resolvePlaneAngleMeasureFactor(entities, ref);
            if (factor !== null) return factor;
        }
    }
    return null;
}

function detectPlaneAngleUnitScale(entities) {
    for (const [, entity] of entities) {
        const signature = entitySignature(entity);
        if (!entity.types.includes('GLOBAL_UNIT_ASSIGNED_CONTEXT') && !/GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(/i.test(signature)) continue;
        for (const ref of extractRefs(entity.args)) {
            const factor = resolvePlaneAngleUnitFactor(entities, ref);
            if (factor !== null) return factor;
        }
    }
    return 1;
}

function parseNumberTuple(text) {
    return text.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
}

function resolveCartesianPoint(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('CARTESIAN_POINT')) return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    return match ? parseNumberTuple(match[1]) : null;
}

function resolveDirection(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('DIRECTION')) return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    if (!match) return null;
    const values = parseNumberTuple(match[1]);
    const length = Math.hypot(values[0], values[1], values[2]) || 1;
    return values.map((value) => value / length);
}

function resolveAxis2Placement(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('AXIS2_PLACEMENT_3D')) return null;
    const refs = extractRefs(entity.args);
    return {
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0]) : null,
        axis: refs[1] ? resolveDirection(entities, refs[1]) : null,
    };
}

function extractReferenceCones(text) {
    const entities = parseStepEntities(text);
    const lengthScale = detectLengthUnitScale(text);
    const planeAngleScale = detectPlaneAngleUnitScale(entities);
    const cones = [];
    for (const [id, entity] of entities) {
        if (!entity.types.includes('CONICAL_SURFACE')) continue;
        const match = entity.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
        if (!match) continue;
        const placement = resolveAxis2Placement(entities, Number(match[1]));
        if (!placement?.origin || !placement.axis) continue;
        const halfAngleDeg = Number(match[3]) * planeAngleScale * 180 / Math.PI;
        if (Math.abs(halfAngleDeg - 2) > 0.1) continue;
        cones.push({
            id,
            origin: {
                x: placement.origin[0] * lengthScale,
                y: placement.origin[1] * lengthScale,
                z: placement.origin[2] * lengthScale,
            },
            axis: { x: placement.axis[0], y: placement.axis[1], z: placement.axis[2] },
            radius: Number(match[2]) * lengthScale,
            halfAngleDeg,
        });
    }
    return cones;
}

const { parser, extraction, fileName } = loadSample('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018/nist_ftc_07_asme1_rd_sw1802.SLDPRT');
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const broad = buildBroadEntityMap(payload);
const referenceCones = extractReferenceCones(fs.readFileSync(REFERENCE_PATH, 'utf8'));

const queue = SEED_IDS.map((id) => ({ id, depth: 0 }));
const seen = new Set();
const reachableType32 = [];

while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current.id)) continue;
    seen.add(current.id);

    const directNode = direct.get(current.id);
    const broadNode = broad.get(current.id);
    const refs = directNode ? directNode.refIds : broadNode ? broadNode.refs : [];
    if (directNode?.type === 32) reachableType32.push({ depth: current.depth, record: directNode });
    if (current.depth >= MAX_DEPTH) continue;
    for (const refId of refs) {
        if (!seen.has(refId)) queue.push({ id: refId, depth: current.depth + 1 });
    }
}

const rows = reachableType32
    .map((row) => {
        const decoded = firstMarkerFloats(payload, row.record);
        if (!decoded) return null;
        const scalar9mm = decoded.floats[9] * 1000;
        const scalar10mm = decoded.floats[10] * 1000;
        const scalar10deg = decoded.floats[10] * 180 / Math.PI;
        return {
            depth: row.depth,
            id: row.record.id,
            bytes: row.record.payloadBytes,
            refs: row.record.refIds,
            marker: decoded.marker,
            floatCount: decoded.floats.length,
            origin: {
                x: decoded.floats[0] * 1000,
                y: decoded.floats[1] * 1000,
                z: decoded.floats[2] * 1000,
            },
            axis: {
                x: decoded.floats[3],
                y: decoded.floats[4],
                z: decoded.floats[5],
            },
            scalar9mm,
            scalar10mm,
            scalar10deg,
            deltaMm: scalar9mm - scalar10mm,
            ratio: scalar10mm === 0 ? null : scalar9mm / scalar10mm,
            nearestRef: referenceCones
                .map((cone) => ({ id: cone.id, originDistance: distance({ x: decoded.floats[0] * 1000, y: decoded.floats[1] * 1000, z: decoded.floats[2] * 1000 }, cone.origin) }))
                .sort((left, right) => left.originDistance - right.originDistance)[0] ?? null,
        };
    })
    .filter((row) => row !== null)
    .sort((left, right) => left.depth - right.depth || left.scalar9mm - right.scalar9mm || left.id - right.id);

console.log('investigate186 — FTC_07 reachable type-32 scalar pairs');
console.log('Clean-room basis: compare floats[9] and floats[10] on the reachable FTC_07 type-32 branch.');
console.log(`\n== ${fileName} ==`);
console.log(`reachable type-32 records: ${rows.length}`);

for (const row of rows) {
    console.log(
        `  depth=${row.depth} id=${row.id} bytes=${row.bytes} refs=[${row.refs.join(', ')}] ` +
        `origin=(${formatNumber(row.origin.x)}, ${formatNumber(row.origin.y)}, ${formatNumber(row.origin.z)}) ` +
        `scalar9mm=${formatNumber(row.scalar9mm)} scalar10mm=${formatNumber(row.scalar10mm)} ` +
        `scalar10deg=${formatNumber(row.scalar10deg)} deltaMm=${formatNumber(row.deltaMm)} ratio=${row.ratio === null ? 'n/a' : formatNumber(row.ratio)} ` +
        `nearestRefCone=${row.nearestRef ? `${row.nearestRef.id}@${formatNumber(row.nearestRef.originDistance)}mm` : 'n/a'}`,
    );
}