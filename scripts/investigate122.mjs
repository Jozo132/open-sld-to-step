#!/usr/bin/env node
/**
 * investigate122.mjs — Probe raw anchor neighborhood signals for ambiguous faces.
 * Clean-room analysis of public-domain NIST test files.
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

const TARGETS = [
    { file: 'nist_ftc_08_asme1_rc_sw1802.SLDPRT', faceId: 5251 },
    { file: 'nist_ftc_10_asme1_rb_sw1802.SLDPRT', faceId: 4284 },
    { file: 'nist_ftc_08_asme1_rc_sw1802.SLDPRT', faceId: 4836 },
    { file: 'nist_ftc_08_asme1_rc_sw1802.SLDPRT', faceId: 5016 },
    { file: 'nist_ftc_08_asme1_rc_sw1802.SLDPRT', faceId: 4668 },
    { file: 'nist_ftc_09_asme1_rd_sw1802.SLDPRT', faceId: 1464 },
    { file: 'nist_ftc_09_asme1_rd_sw1802.SLDPRT', faceId: 2982 },
    { file: 'nist_ftc_10_asme1_rb_sw1802.SLDPRT', faceId: 4282 },
];

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

function findFile(name) {
    const queue = [SAMPLE_DIR];
    while (queue.length > 0) {
        const dir = queue.shift();
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
                continue;
            }
            if (entry.name === name) return fullPath;
        }
    }
    return null;
}

function buildVertices(parser) {
    const points = parser.extractCoordinates();
    return points.map((pt, index) => ({
        id: index + 1,
        position: {
            x: pt.x * 1000,
            y: pt.y * 1000,
            z: pt.z * 1000,
        },
    }));
}

function buildValidatedSurfaces(parser, vertices, extractedSurfaces) {
    const validated = [];
    for (const surface of extractedSurfaces) {
        if (surface.surfaceType === 'plane') {
            const plane = surface.params;
            const coplanar = [];
            for (const vertex of vertices) {
                const dx = vertex.position.x - plane.origin.x;
                const dy = vertex.position.y - plane.origin.y;
                const dz = vertex.position.z - plane.origin.z;
                const dist = Math.abs(dx * plane.normal.x + dy * plane.normal.y + dz * plane.normal.z);
                if (dist < 0.5) coplanar.push(vertex.position);
            }
            if (coplanar.length < 3) continue;
            const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, plane.normal);
            if (ratio <= 2.5) validated.push(surface);
            continue;
        }

        validated.push(surface);
    }

    return validated;
}

function buildParserState(parser) {
    const vertices = buildVertices(parser);
    const extractedSurfaces = parser.extractSurfaces();
    const validatedSurfaces = buildValidatedSurfaces(parser, vertices, extractedSurfaces);
    const inferVertices = ParasolidParser.filterOutlierVertices(vertices);
    const inferredPlanes = parser.inferPlanesFromVertices(inferVertices, validatedSurfaces);
    const mergedSurfaces = ParasolidParser.recoverAxisymmetricWasherSurfaces(
        [...validatedSurfaces, ...inferredPlanes],
        vertices,
    );
    const inferredCones = parser.inferApexConesFromCylinderPairs(mergedSurfaces, vertices);
    const surfaces = parser.deduplicateSurfaces([...mergedSurfaces, ...inferredCones]);
    surfaces.forEach((surface, index) => { surface.id = index + 1; });

    const vertexSurfaceMap = parser.associateVertices(surfaces, vertices);
    const candidates = parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap);

    return { surfaces, vertices, vertexSurfaceMap, candidates };
}

function buildUniqueEdgeByFirstRef(parser) {
    const buckets = new Map();
    for (const edge of parser.parseEdgeRecords()) {
        const bucket = buckets.get(edge.firstRefId) ?? [];
        bucket.push(edge);
        buckets.set(edge.firstRefId, bucket);
    }

    const unique = new Map();
    for (const [firstRefId, bucket] of buckets) {
        if (bucket.length === 1) unique.set(firstRefId, bucket[0]);
    }
    return unique;
}

function buildCoedgeToEdge(parser) {
    const coedgeToEdge = new Map();
    const uniqueEdgeByFirstRef = buildUniqueEdgeByFirstRef(parser);
    for (const coedge of parser.parseCoedgeRecords()) {
        const edge = uniqueEdgeByFirstRef.get(coedge.curveLikeId);
        if (edge) coedgeToEdge.set(coedge.id, edge.id);
    }
    return coedgeToEdge;
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

function shortestCoedgeDistance(graph, startId, targetIds) {
    if (targetIds.has(startId)) return 0;
    const visited = new Set([startId]);
    const queue = [{ id: startId, dist: 0 }];

    while (queue.length > 0) {
        const current = queue.shift();
        const neighbors = graph.get(current.id) ?? [];
        for (const neighborId of neighbors) {
            if (visited.has(neighborId)) continue;
            if (targetIds.has(neighborId)) return current.dist + 1;
            visited.add(neighborId);
            queue.push({ id: neighborId, dist: current.dist + 1 });
        }
    }

    return null;
}

function minAnchorEdgeDistance(anchorIds, candidateEdgeIds, edgePositions) {
    const distances = [];
    for (const anchorId of anchorIds) {
        const anchorPos = edgePositions.get(anchorId);
        if (!anchorPos) {
            distances.push({ anchorId, minDistance: null, nearest: [] });
            continue;
        }

        let minDistance = null;
        let nearest = [];
        for (const edgeId of candidateEdgeIds) {
            const candidatePos = edgePositions.get(edgeId);
            if (!candidatePos) continue;
            if (candidatePos.chainIndex !== anchorPos.chainIndex) continue;

            const distance = Math.abs(candidatePos.linearIndex - anchorPos.linearIndex);
            if (minDistance === null || distance < minDistance) {
                minDistance = distance;
                nearest = [{ edgeId, distance, linearIndex: candidatePos.linearIndex }];
            } else if (distance === minDistance) {
                nearest.push({ edgeId, distance, linearIndex: candidatePos.linearIndex });
            }
        }

        distances.push({
            anchorId,
            minDistance,
            anchorLinearIndex: anchorPos.linearIndex,
            anchorChainIndex: anchorPos.chainIndex,
            nearest,
        });
    }
    return distances;
}

function analyzeTarget(fileName, faceId) {
    const filePath = findFile(fileName);
    if (!filePath) {
        console.log(`Missing sample ${fileName}`);
        return;
    }

    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) {
        console.log(`Unable to extract Parasolid from ${fileName}`);
        return;
    }

    const parser = new ParasolidParser(extracted.data);
    const { surfaces, vertices, vertexSurfaceMap, candidates } = buildParserState(parser);
    const hints = parser.parseRawFaceBoundaryHints();
    const hint = hints.find((entry) => entry.faceId === faceId);
    if (!hint) {
        console.log(`Missing hint for ${fileName} face ${faceId}`);
        return;
    }

    const targets = parser.planRawFaceBoundaryTargets(surfaces, vertices, vertexSurfaceMap, hints);
    const selectedEntry = [...targets.entries()].find(([, target]) => target.rawFaceId === faceId) ?? null;
    const edgePositions = parser.buildEdgeChainPositionMap();
    const coedgeToEdge = buildCoedgeToEdge(parser);
    const coedgeGraph = buildCoedgeGraph(parser);
    const faceRecord = parser.parseFaceRecords().find((entry) => entry.id === faceId) ?? null;
    const faceHits = parser.parseFaceEdgeHits()
        .filter((entry) => entry.faceId === faceId)
        .sort((left, right) => left.byteOffset - right.byteOffset);
    const faceHitCounts = new Map();
    for (const hit of faceHits) {
        faceHitCounts.set(hit.edgeId, (faceHitCounts.get(hit.edgeId) ?? 0) + 1);
    }
    const repeatedRawEdgeIds = [...faceHitCounts.entries()]
        .filter(([, count]) => count >= 2)
        .map(([edgeId]) => edgeId)
        .sort((left, right) => left - right);
    const options = candidates
        .map((candidate) => {
            const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
            if (!match) return null;
            return { candidate, match };
        })
        .filter((entry) => entry !== null)
        .sort((left, right) => {
            return left.match.score - right.match.score
                || left.candidate.totalSize - right.candidate.totalSize
                || left.candidate.outerSize - right.candidate.outerSize
                || left.candidate.key.localeCompare(right.candidate.key);
        })
        .slice(0, 8);

    console.log(`\n=== ${fileName} face=${faceId} ===`);
    console.log('hint', JSON.stringify(hint));
    console.log('faceRecord', JSON.stringify(faceRecord));
    console.log('rawFaceHits', JSON.stringify(faceHits));
    console.log('repeatedRawEdgeIds', JSON.stringify(repeatedRawEdgeIds));
    if (selectedEntry) console.log(`selected=${selectedEntry[0]}`);

    for (const option of options) {
        const candidateEdgeIds = option.candidate.mappedEdgeIds;
        const candidateCoedgeIds = option.candidate.mappedCoedgeIds;
        const anchorEdgeDistances = minAnchorEdgeDistance(hint.edgeAnchorIds, candidateEdgeIds, edgePositions);
        const anchorCoedgeDistances = hint.coedgeAnchorIds.map((coedgeId) => ({
            coedgeId,
            graphDistance: shortestCoedgeDistance(coedgeGraph, coedgeId, new Set(candidateCoedgeIds)),
            mappedEdgeId: coedgeToEdge.get(coedgeId) ?? null,
        }));
        const neighborEdgeIds = [...new Set(anchorCoedgeDistances.map((entry) => entry.mappedEdgeId).filter((edgeId) => typeof edgeId === 'number'))];
        const coedgeMappedEdgeDistances = minAnchorEdgeDistance(neighborEdgeIds, candidateEdgeIds, edgePositions);
        const repeatedRawEdgeOverlap = repeatedRawEdgeIds.filter((edgeId) => candidateEdgeIds.includes(edgeId));

        console.log(`  ${option.candidate.key} score=${option.match.score}`);
        console.log(`    mappedEdges=${JSON.stringify(candidateEdgeIds)} mappedCoedges=${JSON.stringify(candidateCoedgeIds)}`);
        console.log(`    repeatedRawEdgeOverlap=${JSON.stringify(repeatedRawEdgeOverlap)}`);
        console.log(`    anchorEdgeDistances=${JSON.stringify(anchorEdgeDistances)}`);
        console.log(`    anchorCoedgeDistances=${JSON.stringify(anchorCoedgeDistances)}`);
        console.log(`    anchorCoedgeEdgeDistances=${JSON.stringify(coedgeMappedEdgeDistances)}`);
    }
}

for (const target of TARGETS) {
    analyzeTarget(target.file, target.faceId);
}