#!/usr/bin/env node
/**
 * investigate156.mjs
 *
 * Extend the slot-derived point/coedge probe by measuring coedge-graph
 * distance from FACE-window evidence to candidate.mappedCoedgeIds.
 * This tests the adjacency hypothesis: slot evidence may point to nearby
 * topology on the owning face rather than exact owning-loop membership.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate156.mjs
 *   node scripts/investigate156.mjs ftc_07 ftc_08
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
    throw new Error('Build output not found. Run "npm run build" before investigate156.mjs.');
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
    const surfaces = parser.deduplicateSurfaces([
        ...merged,
        ...apexCones,
        ...drillTipCones,
        ...halfRadiusCones,
        ...repeatedCenterCones,
    ]);

    surfaces.forEach((surface, index) => {
        surface.id = index + 1;
    });

    const vertexSurfaceMap = parser.associateVertices(surfaces, vertices);
    return {
        candidates: parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap),
        hints: new Map(parser.parseRawFaceBoundaryHints().map((hint) => [hint.faceId, hint])),
        windows: new Map(parser.parseFaceInlineWindowRecords().map((record) => [record.faceId, record])),
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

function compareOptions(left, right) {
    return left.score - right.score
        || left.candidate.totalSize - right.candidate.totalSize
        || left.candidate.outerSize - right.candidate.outerSize
        || left.candidate.key.localeCompare(right.candidate.key);
}

function deriveCoedgeEvidence(word, pointById, coedgeIds) {
    if (coedgeIds.has(word)) {
        return { source: 'coedge', coedgeIds: [word] };
    }

    const point = pointById.get(word);
    if (point && coedgeIds.has(point.nextCoedgeId)) {
        return {
            source: 'point',
            coedgeIds: [point.nextCoedgeId],
        };
    }

    return null;
}

function buildCoedgeGraph(parser) {
    const graph = new Map();
    for (const coedge of parser.parseCoedgeRecords()) {
        const neighbors = new Set();
        if (coedge.prevCoedgeId > 0) neighbors.add(coedge.prevCoedgeId);
        if (coedge.nextCoedgeId > 0) neighbors.add(coedge.nextCoedgeId);
        graph.set(coedge.id, neighbors);
    }
    return graph;
}

function shortestDistance(graph, startIds, targetIds) {
    const targetSet = new Set(targetIds);
    if (targetSet.size === 0) return null;

    const queue = [];
    const visited = new Set();
    for (const startId of startIds) {
        if (targetSet.has(startId)) return 0;
        if (visited.has(startId)) continue;
        visited.add(startId);
        queue.push({ id: startId, dist: 0 });
    }

    while (queue.length > 0) {
        const current = queue.shift();
        const neighbors = graph.get(current.id) ?? [];
        for (const neighborId of neighbors) {
            if (visited.has(neighborId)) continue;
            if (targetSet.has(neighborId)) return current.dist + 1;
            visited.add(neighborId);
            queue.push({ id: neighborId, dist: current.dist + 1 });
        }
    }

    return null;
}

function increment(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

const slotStats = Array.from({ length: 20 }, () => ({
    evidenceHits: 0,
    sourceCounts: new Map(),
    unreachable: 0,
    bestReachable: 0,
    bestExact: 0,
    bestWithin1: 0,
    bestWithin2: 0,
    bestAtMinDistance: 0,
    changedByMinDistance: 0,
    variantOnlyChange: 0,
    sameBucketCases: 0,
    sameBucketBestAtMinDistance: 0,
    sameBucketVariantChange: 0,
    examples: [],
}));

for (const samplePath of listSamplePaths(filters)) {
    const { fileName, parser } = loadSample(samplePath);
    const { candidates, hints, windows } = rebuild(parser);
    const pointById = new Map(parser.parsePointRecords().map((record) => [record.id, record]));
    const coedgeIds = new Set(parser.parseCoedgeRecords().map((record) => record.id));
    const coedgeGraph = buildCoedgeGraph(parser);

    for (const [faceId, hint] of hints) {
        const window = windows.get(faceId);
        if (!window) continue;

        const options = candidates
            .map((candidate) => {
                const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
                return match ? { candidate, score: match.score } : null;
            })
            .filter(Boolean)
            .sort(compareOptions);
        if (options.length === 0) continue;

        const best = options[0];
        const bestInfo = parseCandidateKey(best.candidate.key);

        window.words.forEach((word, slotIndex) => {
            const evidence = deriveCoedgeEvidence(word, pointById, coedgeIds);
            if (!evidence) return;

            const stat = slotStats[slotIndex];
            stat.evidenceHits++;
            increment(stat.sourceCounts, evidence.source);

            const optionDistances = options.map((option) => ({
                ...option,
                minDistance: shortestDistance(coedgeGraph, evidence.coedgeIds, option.candidate.mappedCoedgeIds),
            }));
            const reachable = optionDistances.filter((option) => option.minDistance !== null);
            if (reachable.length === 0) {
                stat.unreachable++;
                if (stat.examples.length < 8) {
                    stat.examples.push({
                        fileName,
                        faceId,
                        word,
                        source: evidence.source,
                        evidenceCoedgeIds: evidence.coedgeIds,
                        bestKey: best.candidate.key,
                        bestScore: best.score,
                        bestMinDistance: null,
                        distanceWinner: null,
                    });
                }
                return;
            }

            const bestDistance = optionDistances[0].minDistance;
            if (bestDistance !== null) {
                stat.bestReachable++;
                if (bestDistance === 0) stat.bestExact++;
                if (bestDistance <= 1) stat.bestWithin1++;
                if (bestDistance <= 2) stat.bestWithin2++;
            }

            const minDistance = Math.min(...reachable.map((option) => option.minDistance));
            if (bestDistance === minDistance) stat.bestAtMinDistance++;

            const distanceWinners = reachable
                .filter((option) => option.minDistance === minDistance)
                .sort(compareOptions);
            const distanceWinner = distanceWinners[0];

            if (distanceWinner.candidate.key !== best.candidate.key) {
                stat.changedByMinDistance++;

                const distanceInfo = parseCandidateKey(distanceWinner.candidate.key);
                if (distanceInfo.surfaceType === bestInfo.surfaceType && distanceInfo.surfaceId === bestInfo.surfaceId) {
                    stat.variantOnlyChange++;
                }
            }

            const sameBucket = reachable
                .filter((option) => {
                    const info = parseCandidateKey(option.candidate.key);
                    return info.surfaceType === bestInfo.surfaceType && info.surfaceId === bestInfo.surfaceId;
                })
                .sort(compareOptions);
            if (sameBucket.length > 1) {
                stat.sameBucketCases++;
                const sameBucketMinDistance = Math.min(...sameBucket.map((option) => option.minDistance));
                const sameBucketWinner = sameBucket
                    .filter((option) => option.minDistance === sameBucketMinDistance)
                    .sort(compareOptions)[0];
                if (sameBucketWinner.candidate.key === best.candidate.key) {
                    stat.sameBucketBestAtMinDistance++;
                } else {
                    stat.sameBucketVariantChange++;
                }
            }

            if (stat.examples.length < 8) {
                stat.examples.push({
                    fileName,
                    faceId,
                    word,
                    source: evidence.source,
                    evidenceCoedgeIds: evidence.coedgeIds,
                    bestKey: best.candidate.key,
                    bestScore: best.score,
                    bestMinDistance: bestDistance,
                    distanceWinner: {
                        key: distanceWinner.candidate.key,
                        score: distanceWinner.score,
                        minDistance: distanceWinner.minDistance,
                    },
                });
            }
        });
    }
}

const summary = slotStats.map((stat, slotIndex) => ({
    slotIndex,
    byteOffset: 30 + slotIndex * 2,
    evidenceHits: stat.evidenceHits,
    sourceCounts: [...stat.sourceCounts.entries()].sort((left, right) => right[1] - left[1]),
    unreachable: stat.unreachable,
    bestReachable: stat.bestReachable,
    bestExact: stat.bestExact,
    bestWithin1: stat.bestWithin1,
    bestWithin2: stat.bestWithin2,
    bestAtMinDistance: stat.bestAtMinDistance,
    changedByMinDistance: stat.changedByMinDistance,
    variantOnlyChange: stat.variantOnlyChange,
    sameBucketCases: stat.sameBucketCases,
    sameBucketBestAtMinDistance: stat.sameBucketBestAtMinDistance,
    sameBucketVariantChange: stat.sameBucketVariantChange,
    examples: stat.examples,
})).filter((entry) => entry.evidenceHits > 0);

console.log(JSON.stringify({
    filters,
    summary,
}, null, 2));