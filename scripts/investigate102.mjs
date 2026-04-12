#!/usr/bin/env node
/**
 * investigate102.mjs — CTC_04 surface inventory and missing-pattern analysis
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Compare generated vs reference cylinder/cone inventories for CTC_04.
 * 2. Bucket surfaces by axis/radius/angle to identify repeated missing patterns.
 * 3. Print the most actionable gaps for reusable parser heuristics.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href,
);

const SLDPRT_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ctc_04_asme1_rd_sw1802.SLDPRT',
);
const REF_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'CTC Definitions',
    'nist_ctc_04_asme1_rd.stp',
);

function normalizeAxis(axis) {
    const rounded = {
        x: Number(axis.x.toFixed(3)),
        y: Number(axis.y.toFixed(3)),
        z: Number(axis.z.toFixed(3)),
    };
    const sign = rounded.x < 0 || (rounded.x === 0 && rounded.y < 0) || (rounded.x === 0 && rounded.y === 0 && rounded.z < 0)
        ? -1
        : 1;
    return {
        x: Number((rounded.x * sign).toFixed(3)),
        y: Number((rounded.y * sign).toFixed(3)),
        z: Number((rounded.z * sign).toFixed(3)),
    };
}

function axisKey(axis) {
    const n = normalizeAxis(axis);
    return `(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)})`;
}

function round(value, digits = 1) {
    return Number(value.toFixed(digits));
}

function parseEntities(stepText) {
    const entities = new Map();
    const normalized = stepText.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;

    const data = normalized.slice(dataStart + 5, dataEnd);
    const joined = data.replace(/\n(?!#\d+=)/g, '');
    const lineRegex = /^#(\d+)\s*=\s*(.+);$/gm;

    let match;
    while ((match = lineRegex.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complex = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complex) {
            const types = complex[1].split(',').map(part => part.trim());
            entities.set(id, {
                type: types.sort().join(','),
                types,
                args: complex[2],
            });
            continue;
        }

        const simple = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simple) {
            entities.set(id, {
                type: simple[1],
                types: [simple[1]],
                args: simple[2],
            });
            continue;
        }

        entities.set(id, { type: '???', types: [], args: rest });
    }

    return entities;
}

function extractNumbers(args) {
    return [...args.matchAll(/-?\d+(?:\.\d+)?(?:E[+-]?\d+)?/gi)]
        .map(match => Number(match[0]))
        .filter(Number.isFinite);
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map(match => Number(match[1]));
}

function resolveAxisPlacement(entityMap, axisPlacementId) {
    const axisPlacement = entityMap.get(axisPlacementId);
    if (!axisPlacement || !axisPlacement.types?.includes('AXIS2_PLACEMENT_3D')) return null;
    const [pointId, axisId] = extractRefs(axisPlacement.args);
    const point = entityMap.get(pointId);
    const axis = entityMap.get(axisId);
    if (!point || !axis) return null;
    const pointNums = extractNumbers(point.args);
    const axisNums = extractNumbers(axis.args);
    if (pointNums.length < 3 || axisNums.length < 3) return null;
    return {
        origin: { x: pointNums.at(-3), y: pointNums.at(-2), z: pointNums.at(-1) },
        axis: { x: axisNums.at(-3), y: axisNums.at(-2), z: axisNums.at(-1) },
    };
}

function collectReferenceSurfaces(entityMap, typeName) {
    const surfaces = [];
    for (const [id, entity] of entityMap) {
        if (!entity.types?.includes(typeName)) continue;
        const refs = extractRefs(entity.args);
        const nums = extractNumbers(entity.args);
        const placement = resolveAxisPlacement(entityMap, refs[0]);
        if (!placement) continue;
        if (typeName === 'CYLINDRICAL_SURFACE') {
            surfaces.push({
                id,
                type: 'cylinder',
                origin: placement.origin,
                axis: placement.axis,
                radius: nums.at(-1),
            });
        } else if (typeName === 'CONICAL_SURFACE') {
            surfaces.push({
                id,
                type: 'cone',
                origin: placement.origin,
                axis: placement.axis,
                radius: nums.at(-2),
                halfAngle: nums.at(-1),
            });
        }
    }
    return surfaces;
}

function bucketSurfaces(surfaces, kind) {
    const buckets = new Map();
    for (const surface of surfaces) {
        const key = kind === 'cone'
            ? `${axisKey(surface.axis)} r=${round(surface.radius, 2).toFixed(2)} a=${round(surface.halfAngle * 180 / Math.PI, 2).toFixed(2)}`
            : `${axisKey(surface.axis)} r=${round(surface.radius, 2).toFixed(2)}`;
        buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return [...buckets.entries()].sort((a, b) => b[1] - a[1]);
}

function matchSurface(surface, refs, kind) {
    const tolRadius = kind === 'cone' ? 0.25 : 0.15;
    const tolOrigin = kind === 'cone' ? 1.0 : 0.5;
    const tolAngle = 0.03;

    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const axisA = normalizeAxis(surface.axis);
        const axisB = normalizeAxis(ref.axis);
        const axisDiff = Math.hypot(axisA.x - axisB.x, axisA.y - axisB.y, axisA.z - axisB.z);
        if (axisDiff > 0.05) continue;
        if (Math.abs(surface.radius - ref.radius) > tolRadius) continue;
        const originDiff = Math.hypot(surface.origin.x - ref.origin.x, surface.origin.y - ref.origin.y, surface.origin.z - ref.origin.z);
        if (originDiff > tolOrigin) continue;
        if (kind === 'cone' && Math.abs(surface.halfAngle - ref.halfAngle) > tolAngle) continue;
        refs.splice(i, 1);
        return true;
    }
    return false;
}

const sldprt = fs.readFileSync(SLDPRT_PATH);
const extracted = SldprtContainerParser.extractParasolid(sldprt);
const model = new ParasolidParser(extracted.data).parse();

const generatedCylinders = model.surfaces
    .filter(surface => surface.surfaceType === 'cylinder')
    .map(surface => ({ ...surface.params, id: surface.id }));
const generatedCones = model.surfaces
    .filter(surface => surface.surfaceType === 'cone')
    .map(surface => ({ ...surface.params, id: surface.id }));

const referenceEntities = parseEntities(fs.readFileSync(REF_PATH, 'utf8'));
const referenceCylinders = collectReferenceSurfaces(referenceEntities, 'CYLINDRICAL_SURFACE');
const referenceCones = collectReferenceSurfaces(referenceEntities, 'CONICAL_SURFACE');

console.log('=== CTC_04 surface inventory ===');
console.log(`Generated surfaces: ${model.surfaces.length}`);
console.log(`Generated cylinders: ${generatedCylinders.length}`);
console.log(`Generated cones: ${generatedCones.length}`);
console.log(`Reference cylinders: ${referenceCylinders.length}`);
console.log(`Reference cones: ${referenceCones.length}`);

console.log('\n=== Generated cylinder buckets (top 25) ===');
for (const [key, count] of bucketSurfaces(generatedCylinders, 'cylinder').slice(0, 25)) {
    console.log(`${count.toString().padStart(3)}  ${key}`);
}

console.log('\n=== Reference cylinder buckets (top 25) ===');
for (const [key, count] of bucketSurfaces(referenceCylinders, 'cylinder').slice(0, 25)) {
    console.log(`${count.toString().padStart(3)}  ${key}`);
}

console.log('\n=== Reference cone buckets (all) ===');
for (const [key, count] of bucketSurfaces(referenceCones, 'cone')) {
    console.log(`${count.toString().padStart(3)}  ${key}`);
}

const unmatchedRefCylinders = [...referenceCylinders];
for (const surface of generatedCylinders) {
    matchSurface(surface, unmatchedRefCylinders, 'cylinder');
}

const unmatchedRefCones = [...referenceCones];
for (const surface of generatedCones) {
    matchSurface(surface, unmatchedRefCones, 'cone');
}

console.log('\n=== Unmatched reference cylinder buckets ===');
for (const [key, count] of bucketSurfaces(unmatchedRefCylinders, 'cylinder')) {
    console.log(`${count.toString().padStart(3)}  ${key}`);
}

console.log('\n=== Unmatched reference cones (all) ===');
for (const cone of unmatchedRefCones) {
    console.log(
        `${axisKey(cone.axis)} origin=(${cone.origin.x.toFixed(1)},${cone.origin.y.toFixed(1)},${cone.origin.z.toFixed(1)}) ` +
        `r=${cone.radius.toFixed(2)} aDeg=${(cone.halfAngle * 180 / Math.PI).toFixed(2)}`,
    );
}

function dedupeByAngle(values, tolerance = 0.2) {
    const sorted = values.slice().sort((a, b) => a - b);
    const unique = [];
    for (const value of sorted) {
        if (unique.length === 0 || Math.abs(value - unique[unique.length - 1]) > tolerance) {
            unique.push(value);
        }
    }
    return unique;
}

function clusterScalarValues(items, getValue, tolerance) {
    const sorted = items
        .map(item => ({ item, value: getValue(item) }))
        .sort((a, b) => a.value - b.value);
    const clusters = [];
    let current = [];
    for (const entry of sorted) {
        if (current.length === 0 || Math.abs(entry.value - current[current.length - 1].value) <= tolerance) {
            current.push(entry);
        } else {
            clusters.push(current);
            current = [entry];
        }
    }
    if (current.length > 0) clusters.push(current);
    return clusters;
}

function analyzeCandidateCones(vertices, cylinders) {
    const angleCandidates = [45, 59].map(deg => ({ deg, slope: Math.tan(deg * Math.PI / 180) }));
    const candidates = [];

    for (const cylinder of cylinders) {
        const axis = normalizeAxis(cylinder.axis);
        const maxRadius = Math.max(cylinder.radius + 20, 25);
        const nearby = [];
        for (const vertex of vertices) {
            const dx = vertex.position.x - cylinder.origin.x;
            const dy = vertex.position.y - cylinder.origin.y;
            const dz = vertex.position.z - cylinder.origin.z;
            const along = dx * axis.x + dy * axis.y + dz * axis.z;
            const px = dx - along * axis.x;
            const py = dy - along * axis.y;
            const pz = dz - along * axis.z;
            const radial = Math.sqrt(px * px + py * py + pz * pz);
            if (radial > maxRadius || radial < 0.01) continue;
            const angle = Math.atan2(py, px);
            nearby.push({ vertex, along, radial, angle });
        }

        if (nearby.length < 8) continue;

        for (const angleCandidate of angleCandidates) {
            for (const sign of [-1, 1]) {
                const slope = angleCandidate.slope * sign;
                const clusters = clusterScalarValues(nearby, point => point.radial - point.along * slope, 0.75);
                for (const cluster of clusters) {
                    if (cluster.length < 8) continue;

                    const rows = cluster.map(entry => entry.item);
                    const heights = rows.map(row => row.along);
                    const hMin = Math.min(...heights);
                    const hMax = Math.max(...heights);
                    if (hMax - hMin < 2.0) continue;

                    const radiusAtStart = rows.reduce((sum, row) => sum + (row.radial - (row.along - hMin) * slope), 0) / rows.length;
                    if (radiusAtStart < -0.5 || radiusAtStart > cylinder.radius + 1.0) continue;

                    const residual = rows.reduce((sum, row) => {
                        const expected = radiusAtStart + (row.along - hMin) * slope;
                        return sum + Math.abs(row.radial - expected);
                    }, 0) / rows.length;
                    if (residual > 0.4) continue;

                    const uniqueAngles = dedupeByAngle(rows.map(row => row.angle), 0.25).length;
                    if (uniqueAngles < 4) continue;

                    candidates.push({
                        axis: axisKey(axis),
                        cylinderRadius: cylinder.radius,
                        angleDeg: angleCandidate.deg,
                        sign,
                        count: rows.length,
                        hMin: round(hMin, 2),
                        hMax: round(hMax, 2),
                        radiusAtStart: round(Math.max(0, radiusAtStart), 2),
                        residual: round(residual, 3),
                        uniqueAngles,
                        origin: {
                            x: round(cylinder.origin.x + hMin * axis.x, 1),
                            y: round(cylinder.origin.y + hMin * axis.y, 1),
                            z: round(cylinder.origin.z + hMin * axis.z, 1),
                        },
                    });
                }
            }
        }
    }

    candidates.sort((a, b) => b.count - a.count || a.residual - b.residual);
    return candidates;
}

console.log('\n=== Prototype vertex-fit cone candidates (top 30) ===');
for (const candidate of analyzeCandidateCones(model.vertices, generatedCylinders).slice(0, 30)) {
    console.log(
        `${candidate.axis} cylR=${candidate.cylinderRadius.toFixed(2)} angle=${candidate.angleDeg} ` +
        `sign=${candidate.sign} fitCount=${candidate.count} startR=${candidate.radiusAtStart.toFixed(2)} ` +
        `h=[${candidate.hMin.toFixed(2)},${candidate.hMax.toFixed(2)}] residual=${candidate.residual.toFixed(3)} ` +
        `angles=${candidate.uniqueAngles} origin=(${candidate.origin.x.toFixed(1)},${candidate.origin.y.toFixed(1)},${candidate.origin.z.toFixed(1)})`,
    );
}

function associateCylinderVertices(vertices, cylinders) {
    const associations = new Map();
    for (const cylinder of cylinders) {
        const axis = normalizeAxis(cylinder.axis);
        const indices = [];
        for (let i = 0; i < vertices.length; i++) {
            const vertex = vertices[i].position;
            const dx = vertex.x - cylinder.origin.x;
            const dy = vertex.y - cylinder.origin.y;
            const dz = vertex.z - cylinder.origin.z;
            const along = dx * axis.x + dy * axis.y + dz * axis.z;
            const px = dx - along * axis.x;
            const py = dy - along * axis.y;
            const pz = dz - along * axis.z;
            const radial = Math.sqrt(px * px + py * py + pz * pz);
            if (Math.abs(radial - cylinder.radius) < 0.5) indices.push(i);
        }
        associations.set(cylinder.id, indices);
    }
    return associations;
}

function cylinderExtents(cylinder, vertices, assocIndices, refOrigin, refAxis) {
    if (!assocIndices || assocIndices.length === 0) return null;
    const heights = assocIndices.map(index => {
        const vertex = vertices[index].position;
        const dx = vertex.x - refOrigin.x;
        const dy = vertex.y - refOrigin.y;
        const dz = vertex.z - refOrigin.z;
        return dx * refAxis.x + dy * refAxis.y + dz * refAxis.z;
    });
    return { min: Math.min(...heights), max: Math.max(...heights) };
}

function lineDistance(originA, originB, axis) {
    const dx = originA.x - originB.x;
    const dy = originA.y - originB.y;
    const dz = originA.z - originB.z;
    const along = dx * axis.x + dy * axis.y + dz * axis.z;
    const px = dx - along * axis.x;
    const py = dy - along * axis.y;
    const pz = dz - along * axis.z;
    return Math.sqrt(px * px + py * py + pz * pz);
}

function analyzeCoaxialCylinderPairs(vertices, cylinders) {
    const angleTargets = [45, 59];
    const assoc = associateCylinderVertices(vertices, cylinders);
    const candidates = [];

    for (let i = 0; i < cylinders.length; i++) {
        for (let j = i + 1; j < cylinders.length; j++) {
            const a = cylinders[i];
            const b = cylinders[j];
            const axis = normalizeAxis(a.axis);
            const otherAxis = normalizeAxis(b.axis);
            const axisDiff = Math.hypot(axis.x - otherAxis.x, axis.y - otherAxis.y, axis.z - otherAxis.z);
            if (axisDiff > 0.02) continue;
            if (lineDistance(a.origin, b.origin, axis) > 0.75) continue;

            const extentA = cylinderExtents(a, vertices, assoc.get(a.id), a.origin, axis);
            const extentB = cylinderExtents(b, vertices, assoc.get(b.id), a.origin, axis);
            if (!extentA || !extentB) continue;

            const radiusDiff = Math.abs(a.radius - b.radius);
            if (radiusDiff < 0.75) continue;

            const endPairs = [
                { ha: extentA.min, hb: extentB.min },
                { ha: extentA.min, hb: extentB.max },
                { ha: extentA.max, hb: extentB.min },
                { ha: extentA.max, hb: extentB.max },
            ];

            for (const pair of endPairs) {
                const gap = Math.abs(pair.ha - pair.hb);
                if (gap < 0.5 || gap > 10) continue;
                const angle = Math.atan(radiusDiff / gap) * 180 / Math.PI;
                const snapped = angleTargets.find(target => Math.abs(angle - target) <= 4);
                if (!snapped) continue;

                const smaller = a.radius <= b.radius ? a : b;
                const larger = a.radius <= b.radius ? b : a;
                const hSmall = a.radius <= b.radius ? pair.ha : pair.hb;
                const hLarge = a.radius <= b.radius ? pair.hb : pair.ha;
                const growthSign = hLarge >= hSmall ? 1 : -1;
                const smallCenter = {
                    x: a.origin.x + hSmall * axis.x,
                    y: a.origin.y + hSmall * axis.y,
                    z: a.origin.z + hSmall * axis.z,
                };
                const apexOffset = smaller.radius / Math.tan(snapped * Math.PI / 180);
                const apex = {
                    x: smallCenter.x - growthSign * apexOffset * axis.x,
                    y: smallCenter.y - growthSign * apexOffset * axis.y,
                    z: smallCenter.z - growthSign * apexOffset * axis.z,
                };

                candidates.push({
                    axis: axisKey(axis),
                    radii: `${Math.min(a.radius, b.radius).toFixed(2)} -> ${Math.max(a.radius, b.radius).toFixed(2)}`,
                    angle: round(angle, 2),
                    snapped,
                    gap: round(gap, 2),
                    axisVector: axis,
                    smallerRadius: smaller.radius,
                    largerRadius: larger.radius,
                    smallCenter,
                    apex,
                    centers: `(${round(a.origin.x, 1)},${round(a.origin.y, 1)},${round(a.origin.z, 1)}) <-> (${round(b.origin.x, 1)},${round(b.origin.y, 1)},${round(b.origin.z, 1)})`,
                });
            }
        }
    }

    const bucket = new Map();
    for (const candidate of candidates) {
        const key = `${candidate.axis} ${candidate.radii} angle~${candidate.snapped}`;
        bucket.set(key, (bucket.get(key) || 0) + 1);
    }

    return {
        counts: [...bucket.entries()].sort((a, b) => b[1] - a[1]),
        all: candidates,
        examples: candidates.slice(0, 30),
    };
}

function matchApexCones(candidates, referenceCones) {
    const refs = referenceCones.filter(cone => Math.abs(cone.radius) < 0.25).map(cone => ({ ...cone }));
    const matches = [];
    for (const candidate of candidates) {
        if (candidate.smallerRadius > 5.0) continue;
        const angleRad = candidate.snapped * Math.PI / 180;
        const index = refs.findIndex(ref => {
            const refAxis = normalizeAxis(ref.axis);
            const candAxis = normalizeAxis(candidate.axisVector);
            const axisDiff = Math.hypot(refAxis.x - candAxis.x, refAxis.y - candAxis.y, refAxis.z - candAxis.z);
            if (axisDiff > 0.05) return false;
            if (Math.abs(ref.halfAngle - angleRad) > 0.05) return false;
            const dx = ref.origin.x - candidate.apex.x;
            const dy = ref.origin.y - candidate.apex.y;
            const dz = ref.origin.z - candidate.apex.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz) <= 5.0;
        });
        if (index < 0) continue;
        matches.push({ candidate, reference: refs[index] });
        refs.splice(index, 1);
    }
    return { matches, unmatched: refs };
}

function countConeSupport(vertices, candidate, halfAngleDeg) {
    const axis = normalizeAxis(candidate.axisVector);
    const halfAngle = halfAngleDeg * Math.PI / 180;
    const tanHalfAngle = Math.tan(halfAngle);
    let count = 0;
    let hMin = Infinity;
    let hMax = -Infinity;
    for (const vertex of vertices) {
        const dx = vertex.position.x - candidate.apex.x;
        const dy = vertex.position.y - candidate.apex.y;
        const dz = vertex.position.z - candidate.apex.z;
        const along = dx * axis.x + dy * axis.y + dz * axis.z;
        if (along < 0) continue;
        const px = dx - along * axis.x;
        const py = dy - along * axis.y;
        const pz = dz - along * axis.z;
        const radial = Math.sqrt(px * px + py * py + pz * pz);
        const expected = along * tanHalfAngle;
        if (Math.abs(radial - expected) > 0.5) continue;
        count++;
        if (along < hMin) hMin = along;
        if (along > hMax) hMax = along;
    }
    return { count, span: count > 0 ? hMax - hMin : 0 };
}

const pairAnalysis = analyzeCoaxialCylinderPairs(model.vertices, generatedCylinders);
console.log('\n=== Coaxial cylinder frustum candidates ===');
for (const [key, count] of pairAnalysis.counts.slice(0, 20)) {
    console.log(`${count.toString().padStart(3)}  ${key}`);
}

console.log('\n=== Coaxial cylinder frustum examples (top 30) ===');
for (const example of pairAnalysis.examples) {
    console.log(`${example.axis} radii=${example.radii} gap=${example.gap.toFixed(2)} angle=${example.angle.toFixed(2)} snap=${example.snapped} centers=${example.centers}`);
}

const apexMatch = matchApexCones(pairAnalysis.all, referenceCones);
console.log('\n=== Apex cone matches from cylinder pairs ===');
console.log(`Matched reference radius-0 cones: ${apexMatch.matches.length}`);
for (const match of apexMatch.matches.slice(0, 20)) {
    const support = countConeSupport(model.vertices, match.candidate, match.candidate.snapped);
    console.log(
        `${axisKey(match.reference.axis)} angle=${(match.reference.halfAngle * 180 / Math.PI).toFixed(2)} ` +
        `ref=(${match.reference.origin.x.toFixed(1)},${match.reference.origin.y.toFixed(1)},${match.reference.origin.z.toFixed(1)}) ` +
        `cand=(${match.candidate.apex.x.toFixed(1)},${match.candidate.apex.y.toFixed(1)},${match.candidate.apex.z.toFixed(1)}) ` +
        `radii=${match.candidate.radii} support=${support.count} span=${support.span.toFixed(2)}`,
    );
}