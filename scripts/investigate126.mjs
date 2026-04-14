#!/usr/bin/env node
/**
 * investigate126.mjs — Classify CTC_02 cone families and face support.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate126.mjs
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

function walkSldprtFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walkSldprtFiles(full);
        return /\.sldprt$/i.test(entry.name) ? [full] : [];
    });
}

function normalizeAxis(axis) {
    return axis.map((value) => {
        if (Math.abs(value) < 0.001) return 0;
        if (Math.abs(value) > 0.999) return Math.sign(value);
        return Number(value.toFixed(3));
    });
}

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
        if (simple) {
            entities.set(Number(match[1]), { type: simple[1], args: simple[2] });
        }
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

function detectLengthScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function extractCones(text) {
    const entities = parseStepEntities(text);
    const lengthScale = detectLengthScale(text);
    const angleScale = resolvePlaneAngleScale(entities);

    return [...entities.entries()]
        .filter(([, entity]) => entity.type === 'CONICAL_SURFACE')
        .map(([id, entity]) => {
            const match = entity.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
            if (!match) return null;
            const placement = resolveAxis2Placement(entities, Number(match[1]));
            if (!placement?.origin || !placement?.axis) return null;
            return {
                id,
                origin: placement.origin.map((value) => value * lengthScale),
                axis: placement.axis,
                radius: Number(match[2]) * lengthScale,
                angle: Number(match[3]) * angleScale,
            };
        })
        .filter((cone) => cone !== null);
}

function summarizeCones(cones) {
    return cones.reduce((acc, cone) => {
        const key = [
            'axis=' + normalizeAxis(cone.axis).join(','),
            'angle=' + cone.angle.toFixed(3),
            'radius=' + cone.radius.toFixed(2),
        ].join(' ');
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
    }, {});
}

const downloadsRoot = path.resolve(ROOT, 'downloads', 'nist');
const samplePath = walkSldprtFiles(downloadsRoot)
    .find((filePath) => path.basename(filePath).toLowerCase() === 'nist_ctc_02_asme1_rc_sw1802.sldprt');

if (!samplePath) {
    throw new Error('CTC_02 sample not found');
}

const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
if (!extraction) {
    throw new Error('Failed to extract Parasolid stream');
}

const parser = new ParasolidParser(extraction.data);
const model = parser.parse();
const assoc = parser.associateVertices(model.surfaces, model.vertices);

const parsedCones = model.surfaces
    .filter((surface) => surface.surfaceType === 'cone')
    .map((surface) => {
        const assocCount = (assoc.get(surface.id) ?? []).length;
        return {
            id: surface.id,
            radius: surface.params.radius,
            angle: surface.params.halfAngle,
            axis: [surface.params.axis.x, surface.params.axis.y, surface.params.axis.z],
            origin: surface.params.origin,
            assocCount,
            hasFace: model.faces.some((face) => face.surface === surface.id),
        };
    });

const parsedFamilies = parsedCones.reduce((acc, cone) => {
    const key = [
        'axis=' + normalizeAxis(cone.axis).join(','),
        'angle=' + cone.angle.toFixed(3),
        'radius=' + cone.radius.toFixed(2),
    ].join(' ');
    const bucket = acc[key] ?? {
        count: 0,
        withFace: 0,
        assoc0: 0,
        assoc1: 0,
        assoc2plus: 0,
        samples: [],
    };
    bucket.count++;
    if (cone.hasFace) bucket.withFace++;
    if (cone.assocCount === 0) bucket.assoc0++;
    else if (cone.assocCount === 1) bucket.assoc1++;
    else bucket.assoc2plus++;
    if (bucket.samples.length < 5) {
        bucket.samples.push({ id: cone.id, origin: cone.origin, assocCount: cone.assocCount, hasFace: cone.hasFace });
    }
    acc[key] = bucket;
    return acc;
}, {});

const generatedStepText = fs.readFileSync('output/nist_ctc_02_asme1_rc_sw1802.stp', 'utf8');
const referenceStepText = fs.readFileSync('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions/nist_ctc_02_asme1_rc.stp', 'utf8');

const generatedCones = extractCones(generatedStepText);
const referenceCones = extractCones(referenceStepText);

console.log(JSON.stringify({
    parsedConeCount: parsedCones.length,
    parsedFamilies,
    generatedConeSummary: summarizeCones(generatedCones),
    referenceConeSummary: summarizeCones(referenceCones),
    generatedConeSamples: generatedCones.slice(0, 20),
    referenceConeSamples: referenceCones.slice(0, 20),
}, null, 2));