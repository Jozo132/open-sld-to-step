#!/usr/bin/env bun
/**
 * investigate144.mjs — Profile FTC_07 plane provenance and PCA ratios.
 *
 * Quantifies how many final-ish plane candidates come from extracted
 * type-0x1E records versus inferred vertex clustering, then compares their
 * support and PCA eigenvalue ratios against reference STEP plane matches.
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

const VERTEX_PLANE_TOL = 0.5;
const CURRENT_RATIO_MAX = 2.5;

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

function entitySignature(entity) {
    return [entity.type, ...(entity.types ?? []), entity.args].join(' ');
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
        matched.push({
            plane: generated[candidate.generatedIndex],
            reference: reference[candidate.referenceIndex],
            distance: candidate.distance,
        });
    }

    return {
        matched,
        unmatched: generated.filter((_, index) => !usedGenerated.has(index)),
    };
}

function collectCoplanarVertices(surface, vertices) {
    const origin = surface.params.origin;
    const normal = surface.params.normal;
    const coplanar = [];

    for (const vertex of vertices) {
        const dx = vertex.position.x - origin.x;
        const dy = vertex.position.y - origin.y;
        const dz = vertex.position.z - origin.z;
        const distance = Math.abs(dx * normal.x + dy * normal.y + dz * normal.z);
        if (distance < VERTEX_PLANE_TOL) coplanar.push(vertex.position);
    }

    return coplanar;
}

function planeSpan(points, normal) {
    if (points.length === 0) return { uSpan: 0, vSpan: 0 };

    const { uAxis, vAxis } = ParasolidParser.planeBasis(normal);
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;

    for (const point of points) {
        const u = point.x * uAxis.x + point.y * uAxis.y + point.z * uAxis.z;
        const v = point.x * vAxis.x + point.y * vAxis.y + point.z * vAxis.z;
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
    }

    return {
        uSpan: uMax - uMin,
        vSpan: vMax - vMin,
    };
}

function enrichPlanes(planes, vertices, source) {
    return planes.map((surface, index) => {
        const coplanar = collectCoplanarVertices(surface, vertices);
        const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, surface.params.normal);
        const span = planeSpan(coplanar, surface.params.normal);
        const origin = surface.params.origin;
        const normal = surface.params.normal;
        return {
            source,
            sourceIndex: index,
            surface,
            normal: [normal.x, normal.y, normal.z],
            d: origin.x * normal.x + origin.y * normal.y + origin.z * normal.z,
            support: coplanar.length,
            ratio,
            uSpan: span.uSpan,
            vSpan: span.vSpan,
            origin: [origin.x, origin.y, origin.z],
        };
    });
}

function summarizeRatios(label, planes) {
    const finiteRatios = planes.map((plane) => plane.ratio).filter((ratio) => Number.isFinite(ratio));
    finiteRatios.sort((left, right) => left - right);
    const median = finiteRatios.length === 0
        ? null
        : finiteRatios[Math.floor(finiteRatios.length / 2)];
    return {
        label,
        count: planes.length,
        medianRatio: median,
        maxRatio: finiteRatios.length === 0 ? null : finiteRatios[finiteRatios.length - 1],
        minRatio: finiteRatios.length === 0 ? null : finiteRatios[0],
    };
}

function ratioSweep(planes, reference, ratios) {
    return ratios.map((ratioMax) => {
        const kept = planes.filter((plane) => plane.ratio <= ratioMax);
        const matchResult = matchPlanes(kept, reference);
        return {
            ratioMax,
            kept: kept.length,
            matched: matchResult.matched.length,
            unmatched: matchResult.unmatched.length,
        };
    });
}

function minSpanSweep(planes, reference, thresholds) {
    return thresholds.map((minSpan) => {
        const kept = planes.filter((plane) => Math.min(plane.uSpan, plane.vSpan) >= minSpan);
        const matchResult = matchPlanes(kept, reference);
        return {
            minSpan,
            kept: kept.length,
            matched: matchResult.matched.length,
            unmatched: matchResult.unmatched.length,
        };
    });
}

function roundedPlane(plane) {
    return {
        source: plane.source,
        support: plane.support,
        ratio: Number.isFinite(plane.ratio) ? Number(plane.ratio.toFixed(3)) : 'Infinity',
        uSpan: Number(plane.uSpan.toFixed(3)),
        vSpan: Number(plane.vSpan.toFixed(3)),
        minSpan: Number(Math.min(plane.uSpan, plane.vSpan).toFixed(3)),
        origin: plane.origin.map((value) => Number(value.toFixed(3))),
        normal: plane.normal.map((value) => Number(value.toFixed(6))),
        d: Number(plane.d.toFixed(3)),
    };
}

const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
if (!extraction) throw new Error('Failed to extract Parasolid data');

const parser = new ParasolidParser(extraction.data);
const vertices = parser.extractCoordinates().map((point, index) => ({
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

    const coplanar = collectCoplanarVertices(surface, vertices);
    if (coplanar.length < 3) continue;

    const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, surface.params.normal);
    if (ratio <= CURRENT_RATIO_MAX) validatedSurfaces.push(surface);
}

const validatedPlanes = parser.deduplicateSurfaces(
    validatedSurfaces.filter((surface) => surface.surfaceType === 'plane'),
);
const inferVertices = ParasolidParser.filterOutlierVertices(vertices);
const inferredPlanes = parser.deduplicateSurfaces(
    parser.inferPlanesFromVertices(inferVertices, validatedSurfaces),
);

const referencePlanes = extractReferencePlanes(fs.readFileSync(referencePath, 'utf8'));
const enrichedValidated = enrichPlanes(validatedPlanes, vertices, 'validated');
const enrichedInferred = enrichPlanes(inferredPlanes, vertices, 'inferred');

const validatedMatches = matchPlanes(enrichedValidated, referencePlanes);
const inferredMatches = matchPlanes(enrichedInferred, referencePlanes);

const report = {
    file: 'FTC_07',
    referencePlaneCount: referencePlanes.length,
    validated: {
        summary: {
            total: enrichedValidated.length,
            matched: validatedMatches.matched.length,
            unmatched: validatedMatches.unmatched.length,
        },
        ratios: {
            matched: summarizeRatios('validated-matched', validatedMatches.matched.map((entry) => entry.plane)),
            unmatched: summarizeRatios('validated-unmatched', validatedMatches.unmatched),
            sweep: ratioSweep(enrichedValidated, referencePlanes, [1.5, 1.75, 2.0, 2.25, 2.5]),
        },
        worstUnmatched: validatedMatches.unmatched
            .sort((left, right) => right.ratio - left.ratio || left.support - right.support)
            .slice(0, 10)
            .map(roundedPlane),
    },
    inferred: {
        summary: {
            total: enrichedInferred.length,
            matched: inferredMatches.matched.length,
            unmatched: inferredMatches.unmatched.length,
        },
        ratios: {
            matched: summarizeRatios('inferred-matched', inferredMatches.matched.map((entry) => entry.plane)),
            unmatched: summarizeRatios('inferred-unmatched', inferredMatches.unmatched),
            sweep: ratioSweep(enrichedInferred, referencePlanes, [1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 4.0]),
            minSpanSweep: minSpanSweep(enrichedInferred, referencePlanes, [2, 3, 4, 5, 6, 8, 10]),
        },
        smallestSpanMatched: inferredMatches.matched
            .map((entry) => entry.plane)
            .sort((left, right) => Math.min(left.uSpan, left.vSpan) - Math.min(right.uSpan, right.vSpan))
            .slice(0, 10)
            .map(roundedPlane),
        smallestSupportUnmatched: inferredMatches.unmatched
            .sort((left, right) => left.support - right.support || right.ratio - left.ratio)
            .slice(0, 10)
            .map(roundedPlane),
        highestRatioUnmatched: inferredMatches.unmatched
            .sort((left, right) => right.ratio - left.ratio || left.support - right.support)
            .slice(0, 10)
            .map(roundedPlane),
    },
};

console.log(JSON.stringify(report, null, 2));