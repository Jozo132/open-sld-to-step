#!/usr/bin/env node
/**
 * investigate209.mjs
 *
 * Inspect the remaining unmatched FTC_07 cone families against the current
 * parser output, nearby raw cylinders, and nearby compact geometry-like rows.
 *
 * Goal:
 * 1. Recompute which FTC_07 reference cones are still unmatched by the current
 *    parser output using apex-aware matching.
 * 2. Group those misses into repeated families.
 * 3. For each miss, summarize nearby raw cylinders and nearby compact/packed
 *    rotational rows on the same axis line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSample } from './_payload-gap-lib.mjs';

const ROOT = process.cwd();
const SAMPLE_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ftc_07_asme1_rd_sw1802.SLDPRT',
);
const REFERENCE_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
    'nist_ftc_07_asme1_rd.stp',
);

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function extractJoinedData(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return '';
    return normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
}

function parseStepEntities(text) {
    const entities = new Map();
    const joined = extractJoinedData(text);
    const lineRe = /^#(\d+)\s*=\s*(.+);$/gm;
    let match;
    while ((match = lineRe.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complex = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complex) {
            const types = complex[1].split(',').map((value) => value.trim());
            entities.set(id, { id, type: types.sort().join(','), types, args: complex[2], raw: rest });
            continue;
        }
        const simple = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simple) {
            entities.set(id, { id, type: simple[1], types: [simple[1]], args: simple[2], raw: rest });
            continue;
        }
        entities.set(id, { id, type: '???', types: [], args: rest, raw: rest });
    }
    return entities;
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseNumberTuple(text) {
    return text.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
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

function resolveCartesianPoint(entities, id, lengthScale) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('CARTESIAN_POINT')) return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    if (!match) return null;
    const values = parseNumberTuple(match[1]);
    return { x: values[0] * lengthScale, y: values[1] * lengthScale, z: values[2] * lengthScale };
}

function resolveDirection(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('DIRECTION')) return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    if (!match) return null;
    const values = parseNumberTuple(match[1]);
    const length = Math.hypot(values[0], values[1], values[2]) || 1;
    return { x: values[0] / length, y: values[1] / length, z: values[2] / length };
}

function resolveAxis2Placement(entities, id, lengthScale) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('AXIS2_PLACEMENT_3D')) return null;
    const refs = extractRefs(entity.args);
    return {
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0], lengthScale) : null,
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
        const placement = resolveAxis2Placement(entities, Number(match[1]), lengthScale);
        if (!placement?.origin || !placement.axis) continue;
        cones.push({
            id,
            origin: placement.origin,
            axis: placement.axis,
            radius: Number(match[2]) * lengthScale,
            halfAngle: Number(match[3]) * planeAngleScale,
        });
    }
    return cones;
}

function payloadStartOffset(record) {
    return 'trailer' in record ? record.offset + 20 : record.offset + 19;
}

function coneApex(parserClass, cone) {
    const axis = parserClass.normalizeDirection(cone.axis);
    const halfAngle = cone.halfAngle;
    const tanHalfAngle = Math.tan(halfAngle);
    if (!isFinite(tanHalfAngle) || Math.abs(tanHalfAngle) < 1e-9) return null;
    const offset = cone.radius / tanHalfAngle;
    return {
        x: cone.origin.x - axis.x * offset,
        y: cone.origin.y - axis.y * offset,
        z: cone.origin.z - axis.z * offset,
    };
}

function conesMatch(parserClass, left, right) {
    const leftAxis = parserClass.normalizeDirection(left.axis);
    const rightAxis = parserClass.normalizeDirection(right.axis);
    const axisDot = leftAxis.x * rightAxis.x + leftAxis.y * rightAxis.y + leftAxis.z * rightAxis.z;
    if (Math.abs(Math.abs(axisDot) - 1) >= 0.02) return false;
    if (Math.abs(left.halfAngle - right.halfAngle) >= 0.02) return false;
    const leftApex = coneApex(parserClass, left);
    const rightApex = coneApex(parserClass, right);
    if (!leftApex || !rightApex) return false;
    return distance(leftApex, rightApex) < 0.75;
}

function decodeGeomRecords(parser, payload, records, label) {
    const sorted = [...records].sort((left, right) => left.offset - right.offset);
    const decoded = [];
    for (let index = 0; index < sorted.length; index++) {
        const record = sorted[index];
        const start = payloadStartOffset(record);
        const end = sorted[index + 1]?.offset ?? payload.length;
        const window = payload.subarray(record.offset, end);
        for (const result of parser.constructor.readAllGeomMarkers(window)) {
            const floats = result.floats;
            if (floats.length < 11) continue;
            const axis = parser.constructor.normalizeDirection({ x: floats[3], y: floats[4], z: floats[5] });
            decoded.push({
                label,
                id: record.id,
                type: record.type,
                marker: result.marker,
                markerOffset: result.offset ?? null,
                payloadBytes: Math.max(0, end - start),
                origin: { x: floats[0] * 1000, y: floats[1] * 1000, z: floats[2] * 1000 },
                axis,
                radius: floats[9] * 1000,
                halfAngle: Math.abs(floats[10]),
                floatCount: floats.length,
            });
        }
    }
    return decoded;
}

const referenceText = fs.readFileSync(REFERENCE_PATH, 'utf8');
const referenceCones = extractReferenceCones(referenceText);
const { parser, extraction, fileName } = loadSample(SAMPLE_PATH);
const payload = extraction.data;
const model = parser.parse();
const generatedCones = model.surfaces
    .filter((surface) => surface.surfaceType === 'cone')
    .map((surface) => ({
        id: surface.id,
        origin: surface.params.origin,
        axis: surface.params.axis,
        radius: surface.params.radius,
        halfAngle: parser.constructor.coneHalfAngleRadians(surface.params.halfAngle),
    }));

const unmatchedReference = referenceCones.filter((referenceCone) => {
    return !generatedCones.some((generatedCone) => conesMatch(parser.constructor, generatedCone, referenceCone));
});

const vertices = parser.extractCoordinates().map((point, index) => ({
    id: index + 1,
    position: { x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 },
}));
const rawCylinders = parser.extractSurfaces().filter((surface) => surface.surfaceType === 'cylinder');
const rawAssoc = parser.associateVertices(rawCylinders, vertices);
const compactRecords = parser.parseCompactGeometryLikeRecords();
const packedRecords = parser.parsePackedGeometryLikeRecords();
const decodedCompact = decodeGeomRecords(parser, payload, compactRecords, 'compact');
const decodedPacked = decodeGeomRecords(parser, payload, packedRecords, 'packed');

const familyMap = new Map();
for (const cone of unmatchedReference) {
    const key = `${(cone.halfAngle * 180 / Math.PI).toFixed(3)}deg|r=${cone.radius.toFixed(3)}`;
    const bucket = familyMap.get(key) ?? [];
    bucket.push(cone);
    familyMap.set(key, bucket);
}

console.log('investigate209 — FTC_07 remaining unmatched cone families');
console.log('Clean-room basis: compare still-unmatched reference cones against nearby raw cylinders and compact/packed rotational rows.');
console.log(`\nfile=${fileName}`);
console.log(`generatedCones=${generatedCones.length} referenceCones=${referenceCones.length} unmatchedReferenceCones=${unmatchedReference.length}`);

for (const [family, cones] of [...familyMap.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    console.log(`\nfamily ${family} count=${cones.length}`);
    for (const cone of cones.sort((left, right) => left.origin.x - right.origin.x || left.origin.y - right.origin.y || left.origin.z - right.origin.z)) {
        console.log(`  ref#${cone.id} origin=${formatPoint(cone.origin)} axis=${formatPoint(cone.axis)} radius=${formatNumber(cone.radius)} halfAngleDeg=${formatNumber(cone.halfAngle * 180 / Math.PI)}`);

        const nearbyRawCylinders = rawCylinders
            .map((surface) => ({
                id: surface.id,
                origin: surface.params.origin,
                axis: parser.constructor.normalizeDirection(surface.params.axis),
                radius: surface.params.radius,
                support: rawAssoc.get(surface.id)?.length ?? 0,
                lineDistance: parser.constructor.axisLineDistance(cone.origin, surface.params.origin, cone.axis),
                axialOffset:
                    (surface.params.origin.x - cone.origin.x) * cone.axis.x +
                    (surface.params.origin.y - cone.origin.y) * cone.axis.y +
                    (surface.params.origin.z - cone.origin.z) * cone.axis.z,
            }))
            .filter((surface) => surface.lineDistance <= 1.25)
            .sort((left, right) => Math.abs(left.axialOffset) - Math.abs(right.axialOffset) || left.lineDistance - right.lineDistance)
            .slice(0, 8);
        for (const surface of nearbyRawCylinders) {
            console.log(`    rawCylinder#${surface.id} origin=${formatPoint(surface.origin)} axis=${formatPoint(surface.axis)} radius=${formatNumber(surface.radius)} support=${surface.support} lineDistance=${formatNumber(surface.lineDistance)} axialOffset=${formatNumber(surface.axialOffset)}`);
        }

        const nearbyGeomRows = [...decodedCompact, ...decodedPacked]
            .map((row) => ({
                ...row,
                lineDistance: parser.constructor.axisLineDistance(cone.origin, row.origin, cone.axis),
                axialOffset:
                    (row.origin.x - cone.origin.x) * cone.axis.x +
                    (row.origin.y - cone.origin.y) * cone.axis.y +
                    (row.origin.z - cone.origin.z) * cone.axis.z,
                axisDelta: Math.hypot(row.axis.x - cone.axis.x, row.axis.y - cone.axis.y, row.axis.z - cone.axis.z),
            }))
            .filter((row) => row.lineDistance <= 1.25)
            .filter((row) => Math.abs(Math.abs(row.axis.y) - Math.abs(cone.axis.y)) <= 0.05)
            .sort((left, right) => Math.abs(left.axialOffset) - Math.abs(right.axialOffset) || left.lineDistance - right.lineDistance)
            .slice(0, 10);
        for (const row of nearbyGeomRows) {
            console.log(`    ${row.label}#${row.id} type=${row.type} origin=${formatPoint(row.origin)} axis=${formatPoint(row.axis)} radius=${formatNumber(row.radius)} halfAngleDeg=${formatNumber(row.halfAngle * 180 / Math.PI)} lineDistance=${formatNumber(row.lineDistance)} axialOffset=${formatNumber(row.axialOffset)} floats=${row.floatCount}`);
        }
    }
}