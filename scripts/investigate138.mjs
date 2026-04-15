#!/usr/bin/env node
/**
 * investigate138.mjs — List current unmatched generated CTC_05 cone placements.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const genText = fs.readFileSync(path.join(ROOT, 'output', 'nist_ctc_05_asme1_rd_sw1802.stp'), 'utf8');
const refText = fs.readFileSync(path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'CTC Definitions',
    'nist_ctc_05_asme1_rd.stp',
), 'utf8');

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
            origin: placement.origin.map((value) => value * lengthScale),
            axis: placement.axis,
            radius: Number(match[2]) * lengthScale,
            semiAngle: Number(match[3]) * planeAngleScale,
        });
    }
    return cones;
}

function canonicalizeAxis(axis) {
    const normalized = [...axis];
    for (const component of normalized) {
        if (Math.abs(component) < 1e-9) continue;
        if (component < 0) return normalized.map((value) => -value);
        break;
    }
    return normalized;
}

function canonicalizeCone(cone) {
    const axis = [...cone.axis];
    const tanSemiAngle = Math.tan(cone.semiAngle);
    const offset = !isFinite(tanSemiAngle) || Math.abs(tanSemiAngle) < 1e-9
        ? 0
        : cone.radius / tanSemiAngle;
    return {
        apex: [
            cone.origin[0] - axis[0] * offset,
            cone.origin[1] - axis[1] * offset,
            cone.origin[2] - axis[2] * offset,
        ],
        axis: canonicalizeAxis(axis),
        semiAngle: cone.semiAngle,
        radius: cone.radius,
        origin: cone.origin,
    };
}

function dirMatch(a, b, tol = 0.02) {
    return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] - 1) < tol;
}

function coneDist(a, b) {
    const canonicalA = canonicalizeCone(a);
    const canonicalB = canonicalizeCone(b);
    if (!dirMatch(canonicalA.axis, canonicalB.axis)) return Infinity;
    if (Math.abs(canonicalA.semiAngle - canonicalB.semiAngle) > 0.05) return Infinity;
    const dx = canonicalA.apex[0] - canonicalB.apex[0];
    const dy = canonicalA.apex[1] - canonicalB.apex[1];
    const dz = canonicalA.apex[2] - canonicalB.apex[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const genCones = extractCones(genText);
const refCones = extractCones(refText);
const matchedRef = new Set();
const unmatchedGenerated = [];

for (const gen of genCones) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < refCones.length; index++) {
        if (matchedRef.has(index)) continue;
        const distance = coneDist(gen, refCones[index]);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }
    if (bestIndex >= 0 && bestDistance <= 5) {
        matchedRef.add(bestIndex);
        continue;
    }
    unmatchedGenerated.push(canonicalizeCone(gen));
}

console.log(JSON.stringify(unmatchedGenerated.map((cone) => ({
    apex: cone.apex.map((value) => Number(value.toFixed(3))),
    axis: cone.axis.map((value) => Number(value.toFixed(6))),
    semiAngle: Number(cone.semiAngle.toFixed(6)),
    radius: Number(cone.radius.toFixed(3)),
    origin: cone.origin.map((value) => Number(value.toFixed(3))),
})), null, 2));