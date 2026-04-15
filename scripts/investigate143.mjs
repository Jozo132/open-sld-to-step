#!/usr/bin/env bun
/**
 * investigate143.mjs — Compare FTC_07 reference 2-degree cone placements
 * against nearby raw Y-axis cylinders extracted from the Parasolid stream.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'parser', 'ParasolidParser.ts')).href,
);
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'parser', 'SldprtContainerParser.ts')).href,
);

const samplePath = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ftc_07_asme1_rd_sw1802.SLDPRT',
);
const referencePath = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
    'nist_ftc_07_asme1_rd.stp',
);

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function parseStepEntities(text) {
    const entities = new Map();
    const dataSection = text.replace(/\r\n/g, '\n');
    const dataStart = dataSection.indexOf('DATA;');
    const dataEnd = dataSection.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;
    const data = dataSection.slice(dataStart + 5, dataEnd);
    const joined = data.replace(/\n(?!#\d+=)/g, '');
    const reLine = /^#(\d+)\s*=\s*(.+);$/gm;
    let match;
    while ((match = reLine.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complexMatch = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complexMatch) {
            const types = complexMatch[1].split(',').map((value) => value.trim());
            entities.set(id, { type: types.sort().join(','), types, args: complexMatch[2] });
            continue;
        }
        const simpleMatch = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simpleMatch) {
            entities.set(id, { type: simpleMatch[1], types: [simpleMatch[1]], args: simpleMatch[2] });
            continue;
        }
        entities.set(id, { type: '???', types: [], args: rest });
    }
    return entities;
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseNumberTuple(str) {
    return str.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
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

function extractCones(text) {
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
            halfAngleRad: Number(match[3]) * planeAngleScale,
        });
    }
    return cones;
}

function normalizeAxis(axis) {
    const normalized = ParasolidParser.normalizeDirection(axis);
    return {
        x: Number(normalized.x.toFixed(6)),
        y: Number(normalized.y.toFixed(6)),
        z: Number(normalized.z.toFixed(6)),
    };
}

function roundPoint(point) {
    return {
        x: Number(point.x.toFixed(3)),
        y: Number(point.y.toFixed(3)),
        z: Number(point.z.toFixed(3)),
    };
}

const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
if (!extraction) throw new Error('Failed to extract Parasolid data');

const parser = new ParasolidParser(extraction.data);
const rawCylinders = parser.extractSurfaces().filter((surface) => surface.surfaceType === 'cylinder');
const vertices = parser.extractCoordinates().map((point, index) => ({
    id: index + 1,
    position: { x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 },
}));
const assoc = parser.associateVertices(rawCylinders, vertices);

const referenceCones = extractCones(fs.readFileSync(referencePath, 'utf8'))
    .filter((cone) => Math.abs(cone.halfAngleRad - (2 * Math.PI / 180)) < 0.01)
    .map((cone) => ({
        id: cone.id,
        origin: roundPoint(cone.origin),
        axis: normalizeAxis(cone.axis),
        radius: Number(cone.radius.toFixed(6)),
        halfAngleDeg: Number((cone.halfAngleRad * 180 / Math.PI).toFixed(6)),
    }));

const report = referenceCones.map((cone) => {
    const nearby = rawCylinders
        .map((surface) => ({
            id: surface.id,
            origin: roundPoint(surface.params.origin),
            axis: normalizeAxis(surface.params.axis),
            radius: Number(surface.params.radius.toFixed(6)),
            support: assoc.get(surface.id)?.length ?? 0,
            lineDistance: Number(ParasolidParser.axisLineDistance(cone.origin, surface.params.origin, cone.axis).toFixed(6)),
            axialOffset: Number(((surface.params.origin.x - cone.origin.x) * cone.axis.x +
                (surface.params.origin.y - cone.origin.y) * cone.axis.y +
                (surface.params.origin.z - cone.origin.z) * cone.axis.z).toFixed(6)),
        }))
        .filter((surface) => Math.abs(Math.abs(surface.axis.y) - 1) < 0.05)
        .filter((surface) => Math.abs(surface.axis.x) < 0.05 && Math.abs(surface.axis.z) < 0.05)
        .filter((surface) => surface.lineDistance <= 1.0)
        .filter((surface) => surface.radius <= 25)
        .sort((a, b) => a.radius - b.radius || a.axialOffset - b.axialOffset || a.id - b.id);

    return {
        referenceCone: cone,
        nearbyRawCylinders: nearby,
    };
});

console.log(JSON.stringify(report, null, 2));