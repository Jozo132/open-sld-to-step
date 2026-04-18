#!/usr/bin/env bun
/**
 * investigate184.mjs — Inspect FTC_07 reachable type-32 records.
 *
 * Goal:
 * 1. Reuse the wrapper-loop reachability result and inspect the reachable
 *    direct type-32 nodes plus downstream type-30 neighbours.
 * 2. Decode all marker payloads from those records and summarize any analytic
 *    interpretations they admit.
 * 3. Compare the decoded placements against the FTC_07 shallow-cone reference
 *    family and the previously observed tiny raw-cylinder family.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSample } from './_payload-gap-lib.mjs';

const ROOT = process.cwd();
const REFERENCE_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
    'nist_ftc_07_asme1_rd.stp',
);
const TARGET_RECORD_IDS = [1597, 1599, 1601];
const SEED_CONE = {
    origin: { x: 139.2, y: 11.4, z: -71.6 },
    axis: { x: 0, y: -1, z: 0 },
    radius: 7.17,
    halfAngleDeg: 2.0,
};
const RAW_CYL_SEED = {
    origin: { x: 139.2, y: -102.616, z: -71.6 },
    axis: { x: 0, y: 1, z: 0 },
    radius: 1.524,
};

const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'parser', 'ParasolidParser.ts')).href,
);

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

function magnitude(vector) {
    return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector) {
    const length = magnitude(vector);
    if (length === 0) return { x: 0, y: 0, z: 0 };
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(left, right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

function classifySurface(floats) {
    if (floats.length === 7 || floats.length === 8) {
        const rawNormal = { x: floats[3], y: floats[4], z: floats[5] };
        const normalMag = magnitude(rawNormal);
        if (normalMag < 0.8 || normalMag > 1.2) return null;
        return {
            surfaceType: 'plane',
            params: {
                origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
                normal: normalize(rawNormal),
            },
        };
    }

    if (floats.length < 10) return null;
    const axis = { x: floats[3], y: floats[4], z: floats[5] };
    const refdir = { x: floats[6], y: floats[7], z: floats[8] };
    const axisMag = magnitude(axis);
    const refdirMag = magnitude(refdir);
    const radius = floats[9];
    if (axisMag < 0.8 || axisMag > 1.2) return null;
    if (refdirMag < 0.8 || refdirMag > 1.2) return null;
    if (!(radius > 0.0005 && radius < 1)) return null;
    const normAxis = normalize(axis);
    const normRefdir = normalize(refdir);
    if (Math.abs(dot(normAxis, normRefdir)) > 0.15) return null;
    const halfAngle = floats.length >= 11 && Number.isFinite(floats[10]) ? floats[10] : 0;
    if (Math.abs(halfAngle) < 0.01) {
        return {
            surfaceType: 'cylinder',
            params: {
                origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
                axis: normAxis,
                radius: radius * 1000,
            },
        };
    }
    return {
        surfaceType: 'cone',
        params: {
            origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
            axis: normAxis,
            radius: radius * 1000,
            halfAngleDeg: halfAngle * 180 / Math.PI,
        },
    };
}

function scanMarkers(buffer) {
    const rows = [];
    for (const marker of [0x2b, 0x2d]) {
        let markerIdx = -1;
        while ((markerIdx = buffer.indexOf(marker, markerIdx + 1)) >= 0) {
            if (markerIdx + 1 + 8 > buffer.length) continue;
            const floats = [];
            for (let offset = markerIdx + 1; offset + 8 <= buffer.length; offset += 8) {
                const value = buffer.readDoubleBE(offset);
                if (!Number.isFinite(value) || Math.abs(value) > 1e6) break;
                floats.push(value);
            }
            if (floats.length < 3) continue;
            rows.push({
                marker,
                markerIdx,
                floatCount: floats.length,
                floats,
                surface: classifySurface(floats),
            });
        }
    }
    return rows;
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatVector(vector) {
    return `(${formatNumber(vector.x)}, ${formatNumber(vector.y)}, ${formatNumber(vector.z)})`;
}

function formatSurface(surface) {
    if (surface.surfaceType === 'plane') {
        return `plane origin=${formatVector(surface.params.origin)} normal=${formatVector(surface.params.normal)}`;
    }
    if (surface.surfaceType === 'cylinder') {
        return `cylinder origin=${formatVector(surface.params.origin)} axis=${formatVector(surface.params.axis)} radius=${formatNumber(surface.params.radius)}`;
    }
    return `cone origin=${formatVector(surface.params.origin)} axis=${formatVector(surface.params.axis)} radius=${formatNumber(surface.params.radius)} halfAngleDeg=${formatNumber(surface.params.halfAngleDeg)}`;
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function axisDistanceToTarget(axis, target) {
    const a = normalize(axis);
    const b = normalize(target);
    return Math.abs(Math.abs(dot(a, b)) - 1);
}

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function entitySignature(entity) {
    return [entity.type, ...(entity.types ?? []), entity.args].join(' ');
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
        if (!entity.types.includes('GLOBAL_UNIT_ASSIGNED_CONTEXT') && !/GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(/i.test(signature)) {
            continue;
        }
        for (const ref of extractRefs(entity.args)) {
            const factor = resolvePlaneAngleUnitFactor(entities, ref);
            if (factor !== null) return factor;
        }
    }
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

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
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
    const planeAngleScale = detectPlaneAngleUnitScale(entities);
    const lengthScale = detectLengthUnitScale(text);
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
            axis: {
                x: placement.axis[0],
                y: placement.axis[1],
                z: placement.axis[2],
            },
            radius: Number(match[2]) * lengthScale,
            halfAngleDeg,
        });
    }
    return cones;
}

const { parser, extraction, fileName } = loadSample(path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ftc_07_asme1_rd_sw1802.SLDPRT',
));
const payload = extraction.data;
const direct = buildDirectRecordMap(parser, payload);
const referenceCones = extractReferenceCones(fs.readFileSync(REFERENCE_PATH, 'utf8'));

console.log('investigate184 — FTC_07 reachable type-32 records');
console.log('Clean-room basis: inspect the reachable type-32 / downstream type-30 payloads and compare them with the shallow-cone reference family.');
console.log(`\n== ${fileName} ==`);
console.log(`reference 2-degree cones: ${referenceCones.length}`);

for (const recordId of TARGET_RECORD_IDS) {
    const record = direct.get(recordId);
    if (!record) {
        console.log(`\nrecord ${recordId}: not found`);
        continue;
    }

    const scanStart = Math.max(record.offset, record.start - 1);
    const window = payload.subarray(scanStart, record.end);
    const markerRows = scanMarkers(window);

    console.log(`\nrecord ${record.id} type=${record.type} bytes=${record.payloadBytes} refs=[${record.refIds.join(', ')}] marker=0x${record.markerByte.toString(16)}`);
    for (const row of markerRows.slice(0, 16)) {
        const leading = row.floats.slice(0, 12).map(formatNumber).join(', ');
        console.log(`  rel=${row.markerIdx} marker=0x${row.marker.toString(16)} floats=${row.floatCount}`);
        console.log(`    leading=${leading}`);
        if (row.surface) {
            const origin = row.surface.params.origin;
            const axis = row.surface.surfaceType === 'plane' ? row.surface.params.normal : row.surface.params.axis;
            const radius = 'radius' in row.surface.params ? row.surface.params.radius : null;
            const coneOriginDistance = distance(origin, SEED_CONE.origin);
            const rawCylOriginDistance = distance(origin, RAW_CYL_SEED.origin);
            const axisToCone = axisDistanceToTarget(axis, SEED_CONE.axis);
            const axisToRawCyl = axisDistanceToTarget(axis, RAW_CYL_SEED.axis);
            const radiusToCone = radius === null ? null : Math.abs(radius - SEED_CONE.radius);
            const radiusToRawCyl = radius === null ? null : Math.abs(radius - RAW_CYL_SEED.radius);
            const nearestReference = referenceCones
                .map((cone) => ({
                    id: cone.id,
                    originDistance: distance(origin, cone.origin),
                    axisDistance: axisDistanceToTarget(axis, cone.axis),
                    radiusDistance: radius === null ? null : Math.abs(radius - cone.radius),
                }))
                .sort((left, right) => left.originDistance - right.originDistance || left.axisDistance - right.axisDistance)[0] ?? null;
            console.log(`    ${formatSurface(row.surface)}`);
            console.log(`    dRefConeOrigin=${formatNumber(coneOriginDistance)} dRawCylOrigin=${formatNumber(rawCylOriginDistance)} axisToCone=${formatNumber(axisToCone)} axisToRawCyl=${formatNumber(axisToRawCyl)} radiusToCone=${radiusToCone === null ? 'n/a' : formatNumber(radiusToCone)} radiusToRawCyl=${radiusToRawCyl === null ? 'n/a' : formatNumber(radiusToRawCyl)}`);
            if (nearestReference) {
                console.log(`    nearestRefCone=#${nearestReference.id} originDistance=${formatNumber(nearestReference.originDistance)} axisDistance=${formatNumber(nearestReference.axisDistance)} radiusDistance=${nearestReference.radiusDistance === null ? 'n/a' : formatNumber(nearestReference.radiusDistance)}`);
            }
        }
    }
}