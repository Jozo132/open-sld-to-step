#!/usr/bin/env bun
/**
 * investigate145.mjs — Measure FTC_07 plane target coverage from raw face hints.
 *
 * Compares final parser plane surfaces against reference planes, split by
 * whether the surface owns at least one raw-face boundary target. This checks
 * whether zero-target planes are mostly noise and therefore safe to suppress.
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

function parseNumberTuple(str) {
    return str.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
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

function extractReferencePlanes(text) {
    const entities = parseStepEntities(text);
    const lengthScale = detectLengthUnitScale(text);
    const planes = [];

    for (const [id, entity] of entities) {
        if (!entity.types.includes('PLANE')) continue;
        const axisRef = extractRefs(entity.args)[0];
        const placement = axisRef ? resolveAxis2Placement(entities, axisRef) : null;
        if (!placement?.origin || !placement.axis) continue;
        const origin = placement.origin.map((value) => value * lengthScale);
        const normal = placement.axis;
        planes.push({
            id,
            origin,
            normal,
            d: origin[0] * normal[0] + origin[1] * normal[1] + origin[2] * normal[2],
        });
    }

    return planes;
}

function planeDist(left, right) {
    const dot = left.normal[0] * right.normal[0]
        + left.normal[1] * right.normal[1]
        + left.normal[2] * right.normal[2];
    if (Math.abs(Math.abs(dot) - 1) > 0.02) return Infinity;
    const rightD = dot > 0 ? right.d : -right.d;
    return Math.abs(left.d - rightD);
}

function matchPlanes(generated, reference, maxDistance = 1.0) {
    const candidates = [];
    for (let generatedIndex = 0; generatedIndex < generated.length; generatedIndex++) {
        for (let referenceIndex = 0; referenceIndex < reference.length; referenceIndex++) {
            const distance = planeDist(generated[generatedIndex], reference[referenceIndex]);
            if (distance <= maxDistance) {
                candidates.push({ generatedIndex, referenceIndex, distance });
            }
        }
    }

    candidates.sort((left, right) => left.distance - right.distance);

    const usedGenerated = new Set();
    const usedReference = new Set();
    const matched = [];

    for (const candidate of candidates) {
        if (usedGenerated.has(candidate.generatedIndex) || usedReference.has(candidate.referenceIndex)) continue;
        usedGenerated.add(candidate.generatedIndex);
        usedReference.add(candidate.referenceIndex);
        matched.push(generated[candidate.generatedIndex]);
    }

    return {
        matched,
        unmatched: generated.filter((_, index) => !usedGenerated.has(index)),
    };
}

function roundedPlane(plane) {
    return {
        targetedClusters: plane.targetedClusters,
        clusterCount: plane.clusterCount,
        support: plane.support,
        origin: plane.origin.map((value) => Number(value.toFixed(3))),
        normal: plane.normal.map((value) => Number(value.toFixed(6))),
        d: Number(plane.d.toFixed(3)),
    };
}

const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
if (!extraction) throw new Error('Failed to extract Parasolid data');

const parser = new ParasolidParser(extraction.data);
const points = parser.extractCoordinates();
const vertices = points.map((point, index) => ({
    id: index + 1,
    position: { x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 },
}));
const extractedSurfaces = parser.extractSurfaces();

const validatedSurfaces = [];
for (const surface of extractedSurfaces) {
    if (surface.surfaceType !== 'plane') {
        validatedSurfaces.push(surface);
        continue;
    }
    const origin = surface.params.origin;
    const normal = surface.params.normal;
    const coplanar = [];
    for (const vertex of vertices) {
        const dx = vertex.position.x - origin.x;
        const dy = vertex.position.y - origin.y;
        const dz = vertex.position.z - origin.z;
        const distance = Math.abs(dx * normal.x + dy * normal.y + dz * normal.z);
        if (distance < 0.5) coplanar.push(vertex.position);
    }
    if (coplanar.length < 3) continue;
    const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, normal);
    if (ratio <= 2.5) validatedSurfaces.push(surface);
}

const inferVertices = ParasolidParser.filterOutlierVertices(vertices);
let inferredPlanes = parser.inferPlanesFromVertices(inferVertices, validatedSurfaces);
const mergedSurfaces = ParasolidParser.recoverAxisymmetricWasherSurfaces(
    [...validatedSurfaces, ...inferredPlanes],
    vertices,
);
const apexCones = parser.inferApexConesFromCylinderPairs(mergedSurfaces, vertices);
const directDrillTipCones = parser.inferDrillTipConesFromRawCylinderSections(validatedSurfaces, vertices, apexCones);
const halfRadiusDrillTipCones = parser.inferHalfRadiusDrillTipConesFromRawCylinderSections(validatedSurfaces, vertices);
const repeatedCenterDrillTipCones = parser.inferRepeatedCenterCylinderDrillTipCones(
    validatedSurfaces,
    vertices,
    halfRadiusDrillTipCones,
);
const surfaces = parser.deduplicateSurfaces([
    ...mergedSurfaces,
    ...apexCones,
    ...directDrillTipCones,
    ...halfRadiusDrillTipCones,
    ...repeatedCenterDrillTipCones,
]);
surfaces.forEach((surface, index) => {
    surface.id = index + 1;
});

const vertexSurfaceMap = parser.associateVertices(surfaces, vertices);
const rawFaceBoundaryHints = parser.buildRawFaceBoundaryHints(extractedSurfaces);
const boundaryTargets = parser.planRawFaceBoundaryTargets(
    surfaces,
    vertices,
    vertexSurfaceMap,
    rawFaceBoundaryHints,
);

const planeSurfaces = surfaces
    .filter((surface) => surface.surfaceType === 'plane')
    .map((surface) => {
        const origin = surface.params.origin;
        const normal = surface.params.normal;
        const assocIndices = vertexSurfaceMap.get(surface.id) ?? [];
        const clusters = parser.buildPlaneBoundaryClusters(origin, normal, assocIndices, vertices);
        let targetedClusters = 0;
        for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
            const key = ParasolidParser.buildBoundaryBudgetKey('plane', surface.id, clusterIndex);
            if (boundaryTargets.has(key)) targetedClusters++;
        }
        return {
            id: surface.id,
            targetedClusters,
            clusterCount: clusters.length,
            support: assocIndices.length,
            origin: [origin.x, origin.y, origin.z],
            normal: [normal.x, normal.y, normal.z],
            d: origin.x * normal.x + origin.y * normal.y + origin.z * normal.z,
        };
    });

const referencePlanes = extractReferencePlanes(fs.readFileSync(referencePath, 'utf8'));
const targeted = planeSurfaces.filter((plane) => plane.targetedClusters > 0);
const untargeted = planeSurfaces.filter((plane) => plane.targetedClusters === 0);
const targetedMatch = matchPlanes(targeted, referencePlanes);
const untargetedMatch = matchPlanes(untargeted, referencePlanes);

const report = {
    file: 'FTC_07',
    planeSurfaceCount: planeSurfaces.length,
    rawFaceHintCount: rawFaceBoundaryHints.length,
    split: {
        targeted: {
            total: targeted.length,
            matched: targetedMatch.matched.length,
            unmatched: targetedMatch.unmatched.length,
        },
        untargeted: {
            total: untargeted.length,
            matched: untargetedMatch.matched.length,
            unmatched: untargetedMatch.unmatched.length,
        },
    },
    matchedUntargeted: untargetedMatch.matched.slice(0, 10).map(roundedPlane),
    unmatchedUntargeted: untargetedMatch.unmatched.slice(0, 15).map(roundedPlane),
};

console.log(JSON.stringify(report, null, 2));