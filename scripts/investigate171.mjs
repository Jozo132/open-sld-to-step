#!/usr/bin/env bun
/**
 * investigate171.mjs — Profile raw cylinders that coincide with reference spheres.
 *
 * Goal:
 * determine whether sphere-like raw cylinders are separable from real cylinders
 * by support count and axial height span of their associated vertices.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSample, listSamplePaths } from './_payload-gap-lib.mjs';

const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');

function referencePathForSample(fileName) {
    const lower = fileName.toLowerCase();
    const definitionDir = lower.includes('_ctc_') ? 'CTC Definitions' : 'FTC Definitions';
    return path.join(
        REFERENCE_ROOT,
        definitionDir,
        lower.replace('_sw1802.sldprt', '.stp'),
    );
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

function extractReferenceSpheres(stepText) {
    const entities = parseStepEntities(stepText);
    const lengthScale = detectLengthUnitScale(stepText);
    const spheres = [];
    for (const [, entity] of entities) {
        if (!entity.types.includes('SPHERICAL_SURFACE')) continue;
        const match = entity.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)/);
        if (!match) continue;
        const placement = resolveAxis2Placement(entities, Number(match[1]));
        if (!placement?.origin) continue;
        spheres.push({
            origin: {
                x: placement.origin[0] * lengthScale,
                y: placement.origin[1] * lengthScale,
                z: placement.origin[2] * lengthScale,
            },
            radius: Number(match[2]) * lengthScale,
        });
    }
    return spheres;
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function computeHeightSpan(surface, assocIndices, vertices) {
    if (assocIndices.length === 0) return 0;
    const origin = surface.params.origin;
    const axis = surface.params.axis;
    const heights = assocIndices.map((index) => {
        const vertex = vertices[index].position;
        return (vertex.x - origin.x) * axis.x +
            (vertex.y - origin.y) * axis.y +
            (vertex.z - origin.z) * axis.z;
    });
    return Math.max(...heights) - Math.min(...heights);
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters);
const thresholds = [0.1, 0.25, 0.5, 1.0, 2.0];

console.log('investigate171 — sphere-like raw cylinder profile');
console.log('Clean-room basis: compare reference spheres to raw cylinders by support and axial span.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const referenceSpheres = extractReferenceSpheres(fs.readFileSync(referencePathForSample(fileName), 'utf8'));
    if (referenceSpheres.length === 0) continue;

    const vertices = parser.extractCoordinates().map((point, index) => ({
        id: index + 1,
        position: { x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 },
    }));
    const rawCylinders = parser.extractSurfaces().filter((surface) => surface.surfaceType === 'cylinder');
    const assoc = parser.associateVertices(rawCylinders, vertices);

    const profiled = rawCylinders.map((surface) => {
        const assocIndices = assoc.get(surface.id) ?? [];
        const matchedSphere = referenceSpheres.some((sphere) =>
            distance(surface.params.origin, sphere.origin) <= 0.25 &&
            Math.abs(surface.params.radius - sphere.radius) <= 0.1,
        );
        return {
            id: surface.id,
            radius: surface.params.radius,
            support: assocIndices.length,
            hSpan: computeHeightSpan(surface, assocIndices, vertices),
            matchedSphere,
        };
    });

    console.log(`\n== ${fileName.replace('_sw1802.SLDPRT', '')} ==`);
    console.log(`reference spheres=${referenceSpheres.length}`);
    for (const threshold of thresholds) {
        const matched = profiled.filter((entry) => entry.matchedSphere && entry.hSpan <= threshold);
        const total = profiled.filter((entry) => entry.hSpan <= threshold);
        console.log(`  hSpan<=${threshold.toFixed(2)}: matchedSphere=${matched.length} totalCylinders=${total.length}`);
    }

    const examples = profiled
        .filter((entry) => entry.matchedSphere)
        .sort((left, right) => left.hSpan - right.hSpan || left.support - right.support)
        .slice(0, 8);
    for (const example of examples) {
        console.log(`  - cyl#${example.id} r=${example.radius.toFixed(3)} support=${example.support} hSpan=${example.hSpan.toFixed(3)}`);
    }
}