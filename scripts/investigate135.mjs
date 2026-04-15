#!/usr/bin/env node
/**
 * investigate135.mjs — Summarize reference cone families and coaxial cylinder
 * transition candidates for CTC_05 and FTC_07.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href,
);
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);
const REF_BASE = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
);

const TARGETS = [
    {
        label: 'CTC_05',
        sample: 'nist_ctc_05_asme1_rd_sw1802.SLDPRT',
        ref: path.join(REF_BASE, 'CTC Definitions', 'nist_ctc_05_asme1_rd.stp'),
    },
    {
        label: 'FTC_07',
        sample: 'nist_ftc_07_asme1_rd_sw1802.SLDPRT',
        ref: path.join(REF_BASE, 'FTC Definitions', 'nist_ftc_07_asme1_rd.stp'),
    },
];

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseNumberTuple(str) {
    return str.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
}

function parseStepEntities(text) {
    const entities = new Map();
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;
    const body = normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
    const re = /^#(\d+)\s*=\s*(.+);$/gm;

    let match;
    while ((match = re.exec(body)) !== null) {
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
    const vector = parseNumberTuple(match[1]);
    const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
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

function entitySignature(entity) {
    return [entity.type, ...(entity.types ?? []), entity.args].join(' ');
}

function resolvePlaneAngleMeasureFactor(entities, id, seen = new Set()) {
    if (seen.has(id)) return null;
    seen.add(id);
    const entity = entities.get(id);
    if (!entity) return null;
    const match = entity.args.match(/PLANE_ANGLE_MEASURE\(\s*([0-9.eE+\-]+)\s*\)/);
    if (match) return Number(match[1]);
    for (const ref of extractRefs(entity.args)) {
        const nested = resolvePlaneAngleMeasureFactor(entities, ref, seen);
        if (nested !== null) return nested;
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

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function collectReferenceConeFamilies(refPath) {
    const text = fs.readFileSync(refPath, 'utf8');
    const entities = parseStepEntities(text);
    const angleFactor = detectPlaneAngleUnitScale(entities);
    const lengthScale = detectLengthUnitScale(text);
    const summary = new Map();

    for (const [, entity] of entities) {
        if (!entity.types.includes('CONICAL_SURFACE')) continue;
        const refs = extractRefs(entity.args);
        const numbers = parseNumberTuple(entity.args.replace(/#/g, ''));
        const placement = resolveAxis2Placement(entities, refs[0]);
        if (!placement || numbers.length < 2 || !placement.axis) continue;
        const radius = numbers.at(-2) * lengthScale;
        const semiAngle = numbers.at(-1) * angleFactor;
        const axis = placement.axis.map((value) => {
            if (Math.abs(value) < 0.001) return 0;
            if (Math.abs(value) > 0.999) return Math.sign(value);
            return Number(value.toFixed(3));
        });
        const key = `${radius.toFixed(3)}|${semiAngle.toFixed(6)}|${axis.join(',')}`;
        summary.set(key, (summary.get(key) ?? 0) + 1);
    }

    return [...summary.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function axisKey(axis) {
    return axis.map((value) => {
        if (Math.abs(value) < 0.001) return 0;
        if (Math.abs(value) > 0.999) return Math.sign(value);
        return Number(value.toFixed(3));
    }).join(',');
}

function collectGeneratedConeFamilies(samplePath) {
    const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
    if (!extraction) throw new Error(`Failed to extract Parasolid payload from ${samplePath}`);

    const model = new ParasolidParser(extraction.data).parse();
    const summary = new Map();
    for (const surface of model.surfaces) {
        if (surface.surfaceType !== 'cone') continue;
        const params = surface.params;
        const axis = ParasolidParser.normalizeDirection(params.axis);
        const key = `${params.radius.toFixed(3)}|${Math.abs(params.halfAngle).toFixed(6)}|${axisKey([axis.x, axis.y, axis.z])}`;
        summary.set(key, (summary.get(key) ?? 0) + 1);
    }

    return [...summary.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function summarizePairCandidates(samplePath) {
    const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
    if (!extraction) throw new Error(`Failed to extract Parasolid payload from ${samplePath}`);

    const parser = new ParasolidParser(extraction.data);
    const model = parser.parse();
    const cylinders = model.surfaces.filter((surface) => surface.surfaceType === 'cylinder');
    const assoc = parser.associateVertices(cylinders, model.vertices);

    const summary = new Map();
    for (let i = 0; i < cylinders.length; i++) {
        for (let j = i + 1; j < cylinders.length; j++) {
            const a = cylinders[i];
            const b = cylinders[j];
            const axisA = ParasolidParser.normalizeDirection(a.params.axis);
            const axisB = ParasolidParser.normalizeDirection(b.params.axis);
            const dot = axisA.x * axisB.x + axisA.y * axisB.y + axisA.z * axisB.z;
            if (Math.abs(Math.abs(dot) - 1) > 0.02) continue;

            const axis = dot >= 0 ? axisA : { x: -axisA.x, y: -axisA.y, z: -axisA.z };
            if (ParasolidParser.axisLineDistance(a.params.origin, b.params.origin, axis) > ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) {
                continue;
            }

            const smaller = a.params.radius <= b.params.radius ? a : b;
            const larger = a.params.radius <= b.params.radius ? b : a;
            const dx = larger.params.origin.x - smaller.params.origin.x;
            const dy = larger.params.origin.y - smaller.params.origin.y;
            const dz = larger.params.origin.z - smaller.params.origin.z;
            const gap = Math.abs(dx * axis.x + dy * axis.y + dz * axis.z);
            if (gap < 0.05) continue;

            const deltaRadius = larger.params.radius - smaller.params.radius;
            const angle = Math.atan(deltaRadius / gap);
            const key = [
                `angleDeg=${(angle * 180 / Math.PI).toFixed(3)}`,
                `gap=${gap.toFixed(3)}`,
                `small=${smaller.params.radius.toFixed(3)}`,
                `large=${larger.params.radius.toFixed(3)}`,
                `ratio=${(larger.params.radius / Math.max(smaller.params.radius, 1e-6)).toFixed(3)}`,
                `axis=${[axis.x, axis.y, axis.z].map((value) => {
                    if (Math.abs(value) < 0.001) return 0;
                    if (Math.abs(value) > 0.999) return Math.sign(value);
                    return Number(value.toFixed(3));
                }).join(',')}`,
                `support=${(assoc.get(smaller.id)?.length ?? 0)}:${(assoc.get(larger.id)?.length ?? 0)}`,
            ].join('|');
            const entry = summary.get(key) ?? { count: 0, sample: null };
            entry.count += 1;
            entry.sample ??= {
                smallerId: smaller.id,
                largerId: larger.id,
                smallerOrigin: smaller.params.origin,
                largerOrigin: larger.params.origin,
            };
            summary.set(key, entry);
        }
    }

    return [...summary.entries()]
        .map(([key, value]) => ({ key, count: value.count, sample: value.sample }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 40);
}

const report = TARGETS.map((target) => ({
    label: target.label,
    referenceConeFamilies: collectReferenceConeFamilies(target.ref),
    generatedConeFamilies: collectGeneratedConeFamilies(path.join(SAMPLE_DIR, target.sample)),
    pairCandidates: summarizePairCandidates(path.join(SAMPLE_DIR, target.sample)),
}));

console.log(JSON.stringify(report, null, 2));