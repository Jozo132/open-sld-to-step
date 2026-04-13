#!/usr/bin/env node
/**
 * investigate123.mjs — Probe size-3 raw faces for plausible +1 loop candidates.
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

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

function findSldprtFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findSldprtFiles(fullPath));
        else if (/\.sldprt$/i.test(entry.name)) results.push(fullPath);
    }
    return results;
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

function minAnchorEdgeDistance(anchorIds, candidateEdgeIds, edgePositions) {
    if (anchorIds.length === 0 || candidateEdgeIds.length === 0) return null;

    let minDistance = null;
    for (const anchorId of anchorIds) {
        const anchorPos = edgePositions.get(anchorId);
        if (!anchorPos) continue;
        for (const edgeId of candidateEdgeIds) {
            const candidatePos = edgePositions.get(edgeId);
            if (!candidatePos) continue;
            if (candidatePos.chainIndex !== anchorPos.chainIndex) continue;
            const distance = Math.abs(candidatePos.linearIndex - anchorPos.linearIndex);
            if (minDistance === null || distance < minDistance) minDistance = distance;
        }
    }

    return minDistance;
}

function describeOption(hint, candidate, edgePositions) {
    const anchorMatches = hint.edgeAnchorIds.filter((edgeId) => candidate.mappedEdgeIds.includes(edgeId)).length;
    const coedgeMatches = hint.coedgeAnchorIds.filter((coedgeId) => candidate.mappedCoedgeIds.includes(coedgeId)).length;
    return {
        key: candidate.key,
        surfaceType: candidate.surfaceType,
        outerSize: candidate.outerSize,
        totalSize: candidate.totalSize,
        mappedEdges: candidate.mappedEdgeCount,
        mappedCoedges: candidate.mappedCoedgeIds.length,
        anchorMatches,
        coedgeMatches,
        minAnchorDistance: minAnchorEdgeDistance(hint.edgeAnchorIds, candidate.mappedEdgeIds, edgePositions),
        spanDelta: hint.maxChainSpan !== null && candidate.maxChainSpan !== null
            ? Math.abs(hint.maxChainSpan - candidate.maxChainSpan)
            : null,
        chains: candidate.chainCount,
        segments: candidate.segmentCount,
        maxSpan: candidate.maxChainSpan,
    };
}

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

console.log('=== SIZE-3 FACE +1 CANDIDATE PROBE ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const { surfaces, vertices, vertexSurfaceMap, candidates } = buildParserState(parser);
    const hints = parser.parseRawFaceBoundaryHints().filter((hint) => hint.primarySize === 3);
    if (hints.length === 0) continue;

    const targets = parser.planRawFaceBoundaryTargets(surfaces, vertices, vertexSurfaceMap, hints);
    const edgePositions = parser.buildEdgeChainPositionMap();
    const interesting = [];

    for (const hint of hints) {
        const exactOptions = candidates
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
            });
        if (exactOptions.length === 0) continue;

        const plusOneCandidates = candidates
            .filter((candidate) => candidate.outerSize === hint.primarySize + 1)
            .map((candidate) => describeOption(hint, candidate, edgePositions))
            .sort((left, right) => {
                return right.coedgeMatches - left.coedgeMatches
                    || right.anchorMatches - left.anchorMatches
                    || (left.minAnchorDistance ?? Number.MAX_SAFE_INTEGER) - (right.minAnchorDistance ?? Number.MAX_SAFE_INTEGER)
                    || (left.spanDelta ?? Number.MAX_SAFE_INTEGER) - (right.spanDelta ?? Number.MAX_SAFE_INTEGER)
                    || right.mappedEdges - left.mappedEdges
                    || left.key.localeCompare(right.key);
            });
        if (plusOneCandidates.length === 0) continue;

        const bestExact = describeOption(hint, exactOptions[0].candidate, edgePositions);
        const bestPlusOne = plusOneCandidates[0];
        const plusOneLooksStronger = bestPlusOne.coedgeMatches > bestExact.coedgeMatches
            || bestPlusOne.anchorMatches > bestExact.anchorMatches
            || (
                bestPlusOne.coedgeMatches === bestExact.coedgeMatches
                && bestPlusOne.anchorMatches === bestExact.anchorMatches
                && bestPlusOne.minAnchorDistance !== null
                && (bestExact.minAnchorDistance === null || bestPlusOne.minAnchorDistance + 20 < bestExact.minAnchorDistance)
            );
        if (!plusOneLooksStronger) continue;

        const selectedEntry = [...targets.entries()].find(([, target]) => target.rawFaceId === hint.faceId) ?? null;
        interesting.push({
            faceId: hint.faceId,
            hint,
            selected: selectedEntry?.[0] ?? null,
            bestExact,
            bestPlusOne,
        });
    }

    if (interesting.length === 0) continue;
    console.log(`\n${fileName}`);
    for (const entry of interesting) {
        console.log(`  face=${entry.faceId} selected=${entry.selected ?? '-'} edgeAnchors=${entry.hint.edgeAnchorIds.length ? entry.hint.edgeAnchorIds.join(',') : '-'} coedgeAnchors=${entry.hint.coedgeAnchorIds.length ? entry.hint.coedgeAnchorIds.join(',') : '-'}`);
        console.log(`    bestExact=${JSON.stringify(entry.bestExact)}`);
        console.log(`    bestPlusOne=${JSON.stringify(entry.bestPlusOne)}`);
    }
}