#!/usr/bin/env node
/**
 * investigate153.mjs
 *
 * Map raw extracted surface ids that appear inside the stable raw FACE 30-69
 * window onto the final deduplicated surface buckets used by boundary-budget
 * candidates. This stays clean-room: it only compares already-decoded surface
 * parameters under the same equivalence rules used by parser deduplication.
 *
 * Usage:
 *   node scripts/investigate153.mjs
 *   node scripts/investigate153.mjs ftc_07 ftc_08
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

const parserModulePath = path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js');
const containerModulePath = path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js');
if (!fs.existsSync(parserModulePath) || !fs.existsSync(containerModulePath)) {
    throw new Error('Build output not found. Run "npm run build" before investigate153.mjs.');
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { SldprtContainerParser } = await import(pathToFileURL(containerModulePath).href);

const PS_TO_MM = 1000;
const filters = process.argv.slice(2);

function listSamplePaths(activeFilters = []) {
    if (!fs.existsSync(SAMPLE_DIR)) {
        throw new Error(`Sample directory not found: ${SAMPLE_DIR}`);
    }

    const sampleNames = fs.readdirSync(SAMPLE_DIR)
        .filter((name) => name.toLowerCase().endsWith('.sldprt'))
        .sort((left, right) => left.localeCompare(right));
    if (activeFilters.length === 0) {
        return sampleNames.map((name) => path.join(SAMPLE_DIR, name));
    }

    const loweredFilters = activeFilters.map((value) => value.toLowerCase());
    return sampleNames
        .filter((name) => loweredFilters.some((value) => name.toLowerCase().includes(value)))
        .map((name) => path.join(SAMPLE_DIR, name));
}

function loadSample(samplePath) {
    const buffer = fs.readFileSync(samplePath);
    const extraction = SldprtContainerParser.extractParasolid(buffer);
    if (!extraction) {
        throw new Error(`Failed to extract Parasolid payload from ${path.basename(samplePath)}`);
    }

    return {
        fileName: path.basename(samplePath),
        parser: new ParasolidParser(extraction.data),
    };
}

function parseCandidateKey(key) {
    const [surfaceType, surfaceIdText, variantText] = key.split(':');
    return {
        surfaceType,
        surfaceId: Number(surfaceIdText),
        variant: variantText === undefined ? null : Number(variantText),
    };
}

function classifyRawSurfaceValidation(rawSurface, vertices) {
    if (!rawSurface) return 'missing';
    if (rawSurface.surfaceType !== 'plane') return 'kept-non-plane';

    const params = rawSurface.params;
    const coplanar = [];
    for (const vertex of vertices) {
        const dx = vertex.position.x - params.origin.x;
        const dy = vertex.position.y - params.origin.y;
        const dz = vertex.position.z - params.origin.z;
        const distance = Math.abs(
            dx * params.normal.x + dy * params.normal.y + dz * params.normal.z,
        );
        if (distance < 0.5) coplanar.push(vertex.position);
    }

    if (coplanar.length < 3) return 'rejected-fewer-than-3';
    const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, params.normal);
    return ratio <= 2.5 ? 'validated-plane' : 'rejected-line-like';
}

function normalizeDirection(direction) {
    const magnitude = Math.hypot(direction.x, direction.y, direction.z);
    if (magnitude < 1e-12) return { x: 0, y: 0, z: 1 };
    return {
        x: direction.x / magnitude,
        y: direction.y / magnitude,
        z: direction.z / magnitude,
    };
}

function coneHalfAngleRadians(halfAngle) {
    return Math.abs(halfAngle) > Math.PI ? (halfAngle * Math.PI / 180) : halfAngle;
}

function coneApex(origin, axis, radius, halfAngle) {
    const radians = coneHalfAngleRadians(halfAngle);
    const tangent = Math.tan(radians);
    if (!isFinite(tangent) || Math.abs(tangent) < 1e-12) return null;

    const offset = radius / tangent;
    return {
        x: origin.x - axis.x * offset,
        y: origin.y - axis.y * offset,
        z: origin.z - axis.z * offset,
    };
}

function matchesSurface(rawSurface, finalSurface) {
    if (!rawSurface || !finalSurface) return false;
    if (rawSurface.surfaceType !== finalSurface.surfaceType) return false;

    const rawParams = rawSurface.params;
    const finalParams = finalSurface.params;
    if (rawSurface.surfaceType === 'plane') {
        const normalA = normalizeDirection(rawParams.normal);
        const normalB = normalizeDirection(finalParams.normal);
        const dot = normalA.x * normalB.x + normalA.y * normalB.y + normalA.z * normalB.z;
        if (Math.abs(Math.abs(dot) - 1) >= ParasolidParser.NORMAL_TOL) return false;

        const originA = rawParams.origin;
        const originB = finalParams.origin;
        const dA = normalA.x * originA.x + normalA.y * originA.y + normalA.z * originA.z;
        const dB = normalB.x * originB.x + normalB.y * originB.y + normalB.z * originB.z;
        const sign = dot > 0 ? 1 : -1;
        return Math.abs(dA - sign * dB) < ParasolidParser.PLANE_DIST_TOL;
    }

    if (rawSurface.surfaceType === 'cylinder') {
        const axisA = normalizeDirection(rawParams.axis);
        const axisB = normalizeDirection(finalParams.axis);
        const dot = axisA.x * axisB.x + axisA.y * axisB.y + axisA.z * axisB.z;
        if (Math.abs(Math.abs(dot) - 1) >= ParasolidParser.CYL_AXIS_TOL) return false;
        if (Math.abs(rawParams.radius - finalParams.radius) >= ParasolidParser.CYL_RADIUS_TOL) return false;

        const dx = rawParams.origin.x - finalParams.origin.x;
        const dy = rawParams.origin.y - finalParams.origin.y;
        const dz = rawParams.origin.z - finalParams.origin.z;
        const projection = dx * axisB.x + dy * axisB.y + dz * axisB.z;
        const px = dx - projection * axisB.x;
        const py = dy - projection * axisB.y;
        const pz = dz - projection * axisB.z;
        return Math.hypot(px, py, pz) < ParasolidParser.CYL_ORIGIN_TOL;
    }

    if (rawSurface.surfaceType === 'cone') {
        const axisA = normalizeDirection(rawParams.axis);
        const axisB = normalizeDirection(finalParams.axis);
        const dot = axisA.x * axisB.x + axisA.y * axisB.y + axisA.z * axisB.z;
        if (Math.abs(Math.abs(dot) - 1) >= ParasolidParser.CYL_AXIS_TOL) return false;

        const halfAngleA = coneHalfAngleRadians(rawParams.halfAngle);
        const halfAngleB = coneHalfAngleRadians(finalParams.halfAngle);
        if (Math.abs(halfAngleA - halfAngleB) >= ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL) return false;

        const apexA = coneApex(rawParams.origin, axisA, rawParams.radius, rawParams.halfAngle);
        const apexB = coneApex(finalParams.origin, axisB, finalParams.radius, finalParams.halfAngle);
        if (!apexA || !apexB) return false;

        return Math.hypot(apexA.x - apexB.x, apexA.y - apexB.y, apexA.z - apexB.z) < ParasolidParser.CYL_ORIGIN_TOL;
    }

    return false;
}

function rebuild(parser) {
    const points = parser.extractCoordinates();
    const vertices = points.map((point, index) => ({
        id: index + 1,
        position: {
            x: point.x * PS_TO_MM,
            y: point.y * PS_TO_MM,
            z: point.z * PS_TO_MM,
        },
    }));

    const extractedSurfaces = parser.extractSurfaces();
    const validated = [];
    for (const surface of extractedSurfaces) {
        if (surface.surfaceType !== 'plane') {
            validated.push(surface);
            continue;
        }

        const params = surface.params;
        const coplanar = [];
        for (const vertex of vertices) {
            const dx = vertex.position.x - params.origin.x;
            const dy = vertex.position.y - params.origin.y;
            const dz = vertex.position.z - params.origin.z;
            const distance = Math.abs(
                dx * params.normal.x + dy * params.normal.y + dz * params.normal.z,
            );
            if (distance < 0.5) coplanar.push(vertex.position);
        }
        if (coplanar.length < 3) continue;

        const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, params.normal);
        if (ratio <= 2.5) validated.push(surface);
    }

    const inferredPlanes = parser.inferPlanesFromVertices(
        ParasolidParser.filterOutlierVertices(vertices),
        validated,
    );
    const merged = ParasolidParser.recoverAxisymmetricWasherSurfaces(
        [...validated, ...inferredPlanes],
        vertices,
    );
    const apexCones = parser.inferApexConesFromCylinderPairs(merged, vertices);
    const drillTipCones = parser.inferDrillTipConesFromRawCylinderSections(validated, vertices, apexCones);
    const halfRadiusCones = parser.inferHalfRadiusDrillTipConesFromRawCylinderSections(validated, vertices);
    const repeatedCenterCones = parser.inferRepeatedCenterCylinderDrillTipCones(
        validated,
        vertices,
        halfRadiusCones,
    );
    const finalSurfaces = parser.deduplicateSurfaces([
        ...merged,
        ...apexCones,
        ...drillTipCones,
        ...halfRadiusCones,
        ...repeatedCenterCones,
    ]);

    finalSurfaces.forEach((surface, index) => {
        surface.id = index + 1;
    });

    const vertexSurfaceMap = parser.associateVertices(finalSurfaces, vertices);
    const candidates = parser.buildBoundaryBudgetCandidates(finalSurfaces, vertices, vertexSurfaceMap);
    const hints = new Map(parser.parseRawFaceBoundaryHints().map((hint) => [hint.faceId, hint]));
    const windows = new Map(parser.parseFaceInlineWindowRecords().map((record) => [record.faceId, record]));
    const faceRecords = new Map(parser.parseFaceRecords().map((record) => [record.id, record]));
    return { extractedSurfaces, finalSurfaces, candidates, hints, windows, faceRecords, vertices };
}

function increment(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

const slotStats = Array.from({ length: 20 }, () => ({
    rawSurfaceHits: 0,
    uniqueFinalMatches: 0,
    ambiguousFinalMatches: 0,
    noFinalMatches: 0,
    bestInside: 0,
    bestOutside: 0,
    changedByFilter: 0,
    typeCounts: new Map(),
    validationCounts: new Map(),
    examples: [],
}));

for (const samplePath of listSamplePaths(filters)) {
    const { fileName, parser } = loadSample(samplePath);
    const { extractedSurfaces, finalSurfaces, candidates, hints, windows, vertices } = rebuild(parser);
    const rawSurfaceById = new Map(extractedSurfaces.map((surface) => [surface.id, surface]));
    const rawToFinalSurfaceIds = new Map();
    const rawValidation = new Map();

    for (const rawSurface of extractedSurfaces) {
        const matchingFinalIds = finalSurfaces
            .filter((finalSurface) => matchesSurface(rawSurface, finalSurface))
            .map((surface) => surface.id)
            .sort((left, right) => left - right);
        rawToFinalSurfaceIds.set(rawSurface.id, matchingFinalIds);
        rawValidation.set(rawSurface.id, classifyRawSurfaceValidation(rawSurface, vertices));
    }

    for (const [faceId, hint] of hints) {
        const window = windows.get(faceId);
        if (!window) continue;

        const options = candidates
            .map((candidate) => {
                const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
                return match ? { candidate, score: match.score } : null;
            })
            .filter(Boolean)
            .sort((left, right) => {
                return left.score - right.score
                    || left.candidate.totalSize - right.candidate.totalSize
                    || left.candidate.outerSize - right.candidate.outerSize
                    || left.candidate.key.localeCompare(right.candidate.key);
            });
        if (options.length === 0) continue;

        const best = options[0];
        const bestInfo = parseCandidateKey(best.candidate.key);

        window.words.forEach((word, slotIndex) => {
            const rawSurface = rawSurfaceById.get(word);
            if (!rawSurface) return;

            const stat = slotStats[slotIndex];
            const matchingFinalIds = rawToFinalSurfaceIds.get(word) ?? [];
            const validation = rawValidation.get(word) ?? 'missing';
            stat.rawSurfaceHits++;
            increment(stat.typeCounts, rawSurface.surfaceType);
            increment(stat.validationCounts, validation);

            if (matchingFinalIds.length === 0) stat.noFinalMatches++;
            else if (matchingFinalIds.length === 1) stat.uniqueFinalMatches++;
            else stat.ambiguousFinalMatches++;

            const bestInside = matchingFinalIds.includes(bestInfo.surfaceId);
            if (bestInside) stat.bestInside++;
            else stat.bestOutside++;

            const filtered = options.find((option) => {
                const info = parseCandidateKey(option.candidate.key);
                return matchingFinalIds.includes(info.surfaceId);
            }) ?? null;
            if (filtered && filtered.candidate.key !== best.candidate.key) stat.changedByFilter++;

            if (stat.examples.length < 8) {
                stat.examples.push({
                    fileName,
                    faceId,
                    rawSurfaceId: word,
                    rawSurfaceType: rawSurface.surfaceType,
                    validation,
                    matchingFinalIds,
                    bestKey: best.candidate.key,
                    bestScore: best.score,
                    filteredKey: filtered?.candidate.key ?? null,
                    filteredScore: filtered?.score ?? null,
                });
            }
        });
    }
}

const summary = slotStats.map((stat, slotIndex) => ({
    slotIndex,
    byteOffset: 30 + slotIndex * 2,
    rawSurfaceHits: stat.rawSurfaceHits,
    uniqueFinalMatches: stat.uniqueFinalMatches,
    ambiguousFinalMatches: stat.ambiguousFinalMatches,
    noFinalMatches: stat.noFinalMatches,
    bestInside: stat.bestInside,
    bestOutside: stat.bestOutside,
    changedByFilter: stat.changedByFilter,
    rawSurfaceTypes: [...stat.typeCounts.entries()].sort((left, right) => right[1] - left[1]),
    validationCounts: [...stat.validationCounts.entries()].sort((left, right) => right[1] - left[1]),
    examples: stat.examples,
})).filter((entry) => entry.rawSurfaceHits > 0);

console.log(JSON.stringify({
    filters,
    summary,
}, null, 2));