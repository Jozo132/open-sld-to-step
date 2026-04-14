#!/usr/bin/env node
/**
 * investigate128.mjs — List representative CTC_02 reference cone families.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate128.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const REF_PATH = path.join(
    process.cwd(),
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'CTC Definitions',
    'nist_ctc_02_asme1_rc.stp',
);

function parseStepEntities(text) {
    const data = text.replace(/\r\n/g, '\n');
    const body = data
        .slice(data.indexOf('DATA;') + 5, data.indexOf('ENDSEC;', data.indexOf('DATA;')))
        .replace(/\n(?!#\d+=)/g, '');
    const entities = new Map();
    const re = /^#(\d+)\s*=\s*(.+);$/gm;
    let match;
    while ((match = re.exec(body)) !== null) {
        const rest = match[2].trim();
        const simple = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simple) entities.set(Number(match[1]), { type: simple[1], args: simple[2] });
    }
    return entities;
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseTuple(text) {
    return text.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
}

function resolveCartesianPoint(entities, id) {
    const entity = entities.get(id);
    if (!entity || entity.type !== 'CARTESIAN_POINT') return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    return match ? parseTuple(match[1]) : null;
}

function resolveDirection(entities, id) {
    const entity = entities.get(id);
    if (!entity || entity.type !== 'DIRECTION') return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    if (!match) return null;
    const values = parseTuple(match[1]);
    const length = Math.hypot(values[0], values[1], values[2]) || 1;
    return [values[0] / length, values[1] / length, values[2] / length];
}

function resolveAxis2Placement(entities, id) {
    const entity = entities.get(id);
    if (!entity || entity.type !== 'AXIS2_PLACEMENT_3D') return null;
    const refs = extractRefs(entity.args);
    return {
        origin: resolveCartesianPoint(entities, refs[0]),
        axis: resolveDirection(entities, refs[1]),
    };
}

function resolvePlaneAngleScale(entities) {
    const resolveMeasure = (id, seen = new Set()) => {
        if (seen.has(id)) return null;
        seen.add(id);
        const entity = entities.get(id);
        if (!entity) return null;
        const match = entity.args.match(/PLANE_ANGLE_MEASURE\(\s*([0-9.eE+\-]+)\s*\)/);
        if (match) return Number(match[1]);
        for (const ref of extractRefs(entity.args)) {
            const nested = resolveMeasure(ref, seen);
            if (nested !== null) return nested;
        }
        return null;
    };

    for (const [, entity] of entities) {
        if (entity.type !== 'GLOBAL_UNIT_ASSIGNED_CONTEXT') continue;
        for (const ref of extractRefs(entity.args)) {
            const factor = resolveMeasure(ref);
            if (factor !== null) return factor;
        }
    }
    return 1;
}

function normalizeAxis(axis) {
    return axis.map((value) => {
        if (Math.abs(value) < 0.001) return 0;
        if (Math.abs(value) > 0.999) return Math.sign(value);
        return Number(value.toFixed(3));
    });
}

const entities = parseStepEntities(fs.readFileSync(REF_PATH, 'utf8'));
const angleScale = resolvePlaneAngleScale(entities);

const families = [...entities.entries()]
    .filter(([, entity]) => entity.type === 'CONICAL_SURFACE')
    .map(([id, entity]) => {
        const match = entity.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
        if (!match) return null;
        const placement = resolveAxis2Placement(entities, Number(match[1]));
        if (!placement?.origin || !placement?.axis) return null;
        return {
            id,
            origin: placement.origin,
            axis: normalizeAxis(placement.axis),
            radius: Number(match[2]),
            angle: Number(match[3]) * angleScale,
        };
    })
    .filter((cone) => cone !== null)
    .reduce((acc, cone) => {
        const key = [
            'axis=' + cone.axis.join(','),
            'angle=' + cone.angle.toFixed(3),
            'radius=' + cone.radius.toFixed(3),
        ].join(' ');
        const bucket = acc[key] ?? { count: 0, samples: [] };
        bucket.count++;
        if (bucket.samples.length < 8) {
            bucket.samples.push({ id: cone.id, origin: cone.origin });
        }
        acc[key] = bucket;
        return acc;
    }, {});

console.log(JSON.stringify(families, null, 2));