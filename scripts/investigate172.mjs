#!/usr/bin/env bun
/**
 * investigate172.mjs — Profile sphere-support around raw cylinder centers.
 *
 * Goal:
 * measure how many raw vertices lie on a sphere implied by a cylinder's
 * origin/radius, and compare that signal for cylinders that coincide with
 * reference spheres.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSample, listSamplePaths } from './_payload-gap-lib.mjs';

const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const SPHERE_TOL = 0.5;

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

function resolveAxis2Placement(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('AXIS2_PLACEMENT_3D')) return null;
    const refs = extractRefs(entity.args);
    return {
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0]) : null,
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

function sphereSupport(origin, radius, vertices) {
    let count = 0;
    for (const vertex of vertices) {
        const d = distance(origin, vertex.position);
        if (Math.abs(d - radius) <= SPHERE_TOL) count++;
    }
    return count;
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters);

console.log('investigate172 — sphere support around cylinder centers');
console.log('Clean-room basis: reinterpret exact raw-cylinder origin/radius as a sphere and count supporting vertices.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const referenceSpheres = extractReferenceSpheres(fs.readFileSync(referencePathForSample(fileName), 'utf8'));
    if (referenceSpheres.length === 0) continue;

    const vertices = parser.extractCoordinates().map((point, index) => ({
        id: index + 1,
        position: { x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 },
    }));

    const profiled = parser.extractSurfaces()
        .filter((surface) => surface.surfaceType === 'cylinder')
        .map((surface) => {
            const matchedSphere = referenceSpheres.some((sphere) =>
                distance(surface.params.origin, sphere.origin) <= 0.25 &&
                Math.abs(surface.params.radius - sphere.radius) <= 0.1,
            );
            return {
                id: surface.id,
                radius: surface.params.radius,
                matchedSphere,
                sphereSupport: sphereSupport(surface.params.origin, surface.params.radius, vertices),
            };
        });

    const matched = profiled.filter((entry) => entry.matchedSphere);
    const allCounts = profiled.map((entry) => entry.sphereSupport).sort((a, b) => a - b);
    const matchedCounts = matched.map((entry) => entry.sphereSupport).sort((a, b) => a - b);
    console.log(`\n== ${fileName.replace('_sw1802.SLDPRT', '')} ==`);
    console.log(`reference spheres=${referenceSpheres.length} matched raw cylinders=${matched.length}`);
    console.log(`matched sphereSupport values: ${matchedCounts.join(', ')}`);
    console.log(`all cylinder sphereSupport min/median/max: ${allCounts[0] ?? 0}/${allCounts[Math.floor(allCounts.length / 2)] ?? 0}/${allCounts[allCounts.length - 1] ?? 0}`);
    for (const threshold of [3, 4, 5, 6, 8, 10]) {
        const matchedAtThreshold = matched.filter((entry) => entry.sphereSupport >= threshold).length;
        const totalAtThreshold = profiled.filter((entry) => entry.sphereSupport >= threshold).length;
        console.log(`  sphereSupport>=${threshold}: matched=${matchedAtThreshold} total=${totalAtThreshold}`);
    }
}