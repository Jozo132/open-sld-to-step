#!/usr/bin/env bun
/**
 * investigate196.mjs — Map wrapper 90's decoded frame into FTC_07 reference STEP usage.
 *
 * Goal:
 * 1. Parse the FTC_07 reference STEP file.
 * 2. Find AXIS2_PLACEMENT_3D records near the decoded wrapper-90 frame.
 * 3. Report which entities use those placements, and compare them against the
 *    2-degree reference conical surfaces.
 */
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

const TARGET_FRAME = {
    origin: { x: 0, y: -115.57, z: 0 },
    axis: { x: 0, y: 1, z: 0 },
    refdir: { x: 0, y: 0, z: 1 },
};

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
        if (!entity.types.includes('GLOBAL_UNIT_ASSIGNED_CONTEXT') && !/GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(/i.test(signature)) continue;
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
        id,
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0], lengthScale) : null,
        axis: refs[1] ? resolveDirection(entities, refs[1]) : null,
        refdir: refs[2] ? resolveDirection(entities, refs[2]) : null,
    };
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function directionDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function formatNumber(value) {
    return Number(value.toPrecision(6));
}

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function formatDir(direction) {
    return `(${formatNumber(direction.x)}, ${formatNumber(direction.y)}, ${formatNumber(direction.z)})`;
}

function extractReferenceCones(entities, lengthScale, planeAngleScale) {
    const cones = [];
    for (const [id, entity] of entities) {
        if (!entity.types.includes('CONICAL_SURFACE')) continue;
        const match = entity.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
        if (!match) continue;
        const placement = resolveAxis2Placement(entities, Number(match[1]), lengthScale);
        if (!placement?.origin || !placement.axis) continue;
        const halfAngleDeg = Number(match[3]) * planeAngleScale * 180 / Math.PI;
        if (Math.abs(halfAngleDeg - 2) > 0.1) continue;
        cones.push({
            id,
            placementId: Number(match[1]),
            origin: placement.origin,
            axis: placement.axis,
            refdir: placement.refdir,
            radius: Number(match[2]) * lengthScale,
            halfAngleDeg,
        });
    }
    return cones.sort((left, right) => left.origin.y - right.origin.y || left.origin.x - right.origin.x || left.origin.z - right.origin.z);
}

const text = fs.readFileSync(REFERENCE_PATH, 'utf8');
const entities = parseStepEntities(text);
const lengthScale = detectLengthUnitScale(text);
const planeAngleScale = detectPlaneAngleUnitScale(entities);

const placements = [...entities.keys()]
    .map((id) => resolveAxis2Placement(entities, id, lengthScale))
    .filter((placement) => placement && placement.origin && placement.axis && placement.refdir)
    .map((placement) => ({
        ...placement,
        originDelta: distance(placement.origin, TARGET_FRAME.origin),
        axisDelta: directionDistance(placement.axis, TARGET_FRAME.axis),
        refdirDelta: directionDistance(placement.refdir, TARGET_FRAME.refdir),
    }))
    .filter((placement) => placement.originDelta <= 5 || (placement.axisDelta <= 0.01 && placement.refdirDelta <= 0.01 && Math.abs(placement.origin.y - TARGET_FRAME.origin.y) <= 5))
    .sort((left, right) => left.originDelta - right.originDelta || left.axisDelta - right.axisDelta || left.refdirDelta - right.refdirDelta);

const cones = extractReferenceCones(entities, lengthScale, planeAngleScale);

console.log('investigate196 — FTC_07 wrapper90 frame vs reference STEP');
console.log('Clean-room basis: compare the decoded wrapper90 frame with reference STEP placements and 2-degree cone placements.');
console.log(`\nreference path=${REFERENCE_PATH}`);
console.log(`matching placements=${placements.length}`);

for (const placement of placements.slice(0, 8)) {
    console.log(`  placement=#${placement.id} origin=${formatPoint(placement.origin)} axis=${formatDir(placement.axis)} refdir=${formatDir(placement.refdir)} originDelta=${formatNumber(placement.originDelta)} axisDelta=${formatNumber(placement.axisDelta)} refdirDelta=${formatNumber(placement.refdirDelta)}`);
    const uses = [...entities.values()]
        .filter((entity) => extractRefs(entity.args).includes(placement.id))
        .map((entity) => ({ id: entity.id, types: entity.types, raw: entity.raw }))
        .slice(0, 20);
    for (const use of uses) {
        console.log(`    usedBy=#${use.id} types=${use.types.join('|')} raw=${use.raw.slice(0, 160)}`);
    }
}

console.log(`\nreference 2-degree cones=${cones.length}`);
for (const cone of cones.slice(0, 20)) {
    console.log(`  cone=#${cone.id} placement=#${cone.placementId} origin=${formatPoint(cone.origin)} axis=${formatDir(cone.axis)} refdir=${cone.refdir ? formatDir(cone.refdir) : 'n/a'} radius=${formatNumber(cone.radius)} halfAngleDeg=${formatNumber(cone.halfAngleDeg)}`);
}