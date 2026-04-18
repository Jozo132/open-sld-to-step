#!/usr/bin/env bun
/**
 * investigate174.mjs — Measure plane-side circle radii for reference torus pairs.
 *
 * Goal:
 * check whether the plane vertices already associated with a torus-like
 * plane+cylinder pair expose the torus major radius as a recoverable radial
 * cluster around the cylinder axis line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSample, listSamplePaths } from './_payload-gap-lib.mjs';

const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');
const AXIS_DOT_MIN = 0.98;
const ORIGIN_LINE_TOL = 0.5;
const RADIUS_TOL = 0.5;
const PLANE_OFFSET_TOL = 0.5;
const CLUSTER_TOL = 0.75;

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
    return normalize(parseNumberTuple(match[1]));
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

function extractReferenceTori(stepText) {
    const entities = parseStepEntities(stepText);
    const lengthScale = detectLengthUnitScale(stepText);
    const tori = [];
    for (const [id, entity] of entities) {
        if (!entity.types.includes('TOROIDAL_SURFACE')) continue;
        const match = entity.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
        if (!match) continue;
        const placement = resolveAxis2Placement(entities, Number(match[1]));
        if (!placement?.origin || !placement?.axis) continue;
        tori.push({
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
            majorRadius: Number(match[2]) * lengthScale,
            minorRadius: Number(match[3]) * lengthScale,
        });
    }
    return tori;
}

function normalize(vector) {
    const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function canonicalizeAxis(axis) {
    const normalized = normalize([axis.x, axis.y, axis.z]);
    if (Math.abs(normalized[0]) > 1e-9) {
        return normalized[0] < 0 ? [-normalized[0], -normalized[1], -normalized[2]] : normalized;
    }
    if (Math.abs(normalized[1]) > 1e-9) {
        return normalized[1] < 0 ? [-normalized[0], -normalized[1], -normalized[2]] : normalized;
    }
    return normalized[2] < 0 ? [-normalized[0], -normalized[1], -normalized[2]] : normalized;
}

function axisDot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distanceToAxis(point, axisOrigin, axisDirection) {
    const dx = point.x - axisOrigin.x;
    const dy = point.y - axisOrigin.y;
    const dz = point.z - axisOrigin.z;
    const along = dx * axisDirection[0] + dy * axisDirection[1] + dz * axisDirection[2];
    const px = dx - along * axisDirection[0];
    const py = dy - along * axisDirection[1];
    const pz = dz - along * axisDirection[2];
    return Math.hypot(px, py, pz);
}

function planeOffset(point, planeOrigin, planeNormal) {
    return Math.abs(
        (point.x - planeOrigin.x) * planeNormal[0] +
        (point.y - planeOrigin.y) * planeNormal[1] +
        (point.z - planeOrigin.z) * planeNormal[2],
    );
}

function clusterValues(values, tolerance) {
    if (values.length === 0) return [];
    const sorted = values.slice().sort((a, b) => a - b);
    const groups = [];
    let current = [sorted[0]];
    for (let index = 1; index < sorted.length; index++) {
        if (Math.abs(sorted[index] - current[current.length - 1]) <= tolerance) current.push(sorted[index]);
        else {
            groups.push(current);
            current = [sorted[index]];
        }
    }
    groups.push(current);
    return groups.map((group) => ({
        center: group.reduce((sum, value) => sum + value, 0) / group.length,
        count: group.length,
        min: group[0],
        max: group[group.length - 1],
    }));
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters);

console.log('investigate174 — plane-side radius clusters for torus candidates');
console.log('Clean-room basis: project plane-associated vertices onto the matched cylinder axis line and look for a major-radius cluster.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const referenceTori = extractReferenceTori(fs.readFileSync(referencePathForSample(fileName), 'utf8'));
    if (referenceTori.length === 0) continue;

    const model = parser.parse();
    const assoc = parser.associateVertices(model.surfaces, model.vertices);
    const cylinders = model.surfaces.filter((surface) => surface.surfaceType === 'cylinder');
    const planes = model.surfaces.filter((surface) => surface.surfaceType === 'plane');

    let matchedMajorCluster = 0;
    let matchedExactDifference = 0;
    const examples = [];

    for (const torus of referenceTori) {
        const torusAxis = canonicalizeAxis(torus.axis);
        const outerRadius = torus.majorRadius + torus.minorRadius;
        const innerRadius = Math.max(0, torus.majorRadius - torus.minorRadius);

        const cylinder = cylinders.find((surface) => {
            const params = surface.params;
            const axis = canonicalizeAxis(params.axis);
            return Math.abs(axisDot(axis, torusAxis)) >= AXIS_DOT_MIN &&
                distanceToAxis(params.origin, torus.origin, torusAxis) <= ORIGIN_LINE_TOL &&
                (
                    Math.abs(params.radius - outerRadius) <= RADIUS_TOL ||
                    Math.abs(params.radius - innerRadius) <= RADIUS_TOL
                );
        });
        const plane = planes.find((surface) => {
            const params = surface.params;
            const normal = canonicalizeAxis(params.normal);
            return Math.abs(axisDot(normal, torusAxis)) >= AXIS_DOT_MIN &&
                Math.abs(planeOffset(torus.origin, params.origin, normal) - torus.minorRadius) <= PLANE_OFFSET_TOL;
        });
        if (!cylinder || !plane) continue;

        const planeVertexIndices = assoc.get(plane.id) ?? [];
        const cylinderAxis = canonicalizeAxis(cylinder.params.axis);
        const planeRadii = planeVertexIndices.map((index) => {
            return distanceToAxis(model.vertices[index].position, cylinder.params.origin, cylinderAxis);
        }).filter((radius) => radius > 0.1);
        const clusters = clusterValues(planeRadii, CLUSTER_TOL)
            .sort((left, right) => Math.abs(left.center - torus.majorRadius) - Math.abs(right.center - torus.majorRadius));
        const best = clusters[0] ?? null;
        if (best && Math.abs(best.center - torus.majorRadius) <= CLUSTER_TOL) matchedMajorCluster++;
        if (best && Math.abs(Math.abs(best.center - cylinder.params.radius) - torus.minorRadius) <= CLUSTER_TOL) matchedExactDifference++;

        if (examples.length < 10) {
            examples.push({
                torus,
                cylinderRadius: cylinder.params.radius,
                best,
                clusterPreview: clusters.slice(0, 4),
            });
        }
    }

    console.log(`\n== ${fileName.replace('_sw1802.SLDPRT', '')} ==`);
    console.log(`reference tori=${referenceTori.length}`);
    console.log(`  matched plane major-radius cluster: ${matchedMajorCluster}/${referenceTori.length}`);
    console.log(`  matched |planeRadius - cylinderRadius| = minorRadius: ${matchedExactDifference}/${referenceTori.length}`);
    for (const example of examples) {
        const preview = example.clusterPreview.length === 0
            ? 'none'
            : example.clusterPreview.map((cluster) => `${cluster.center.toFixed(3)}(n=${cluster.count})`).join(', ');
        console.log(
            `  - torus#${example.torus.id} R=${example.torus.majorRadius.toFixed(3)} r=${example.torus.minorRadius.toFixed(3)}` +
            ` cyl=${example.cylinderRadius.toFixed(3)} best=${example.best ? example.best.center.toFixed(3) : 'none'}`,
        );
        console.log(`      clusters: ${preview}`);
    }
}