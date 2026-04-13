#!/usr/bin/env node
/**
 * investigate121.mjs — Raw face matcher ambiguity report
 * Clean-room analysis of public-domain NIST test files.
 *
 * Goal:
 * 1. Reconstruct the same heuristic boundary candidates used by the parser.
 * 2. Score every public raw face boundary hint against those candidates.
 * 3. Summarize exact/near/cap-only matches, score ties, and weak score gaps.
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

    return { vertices, extractedSurfaces, surfaces, vertexSurfaceMap, candidates };
}

function classifySelection(hint, selected) {
    if (!selected) return 'unmatched';
    if (selected.target.outerSize === undefined && selected.target.totalSize !== undefined) return 'cap-only';
    if (selected.target.outerSize !== undefined && selected.target.totalSize !== undefined) return 'exact+cap';
    if (selected.target.outerSize !== undefined) {
        return selected.candidate.outerSize === hint.primarySize ? 'exact' : 'near';
    }
    return 'unknown';
}

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

const sampleFiles = findSldprtFiles(SAMPLE_DIR).sort();
if (sampleFiles.length === 0) {
    console.log('No samples found. Run `npm run download-samples` first.');
    process.exit(1);
}

console.log('=== RAW FACE MATCHER AMBIGUITY REPORT ===');
for (const filePath of sampleFiles) {
    const fileName = path.basename(filePath);
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) continue;

    const parser = new ParasolidParser(extracted.data);
    const { surfaces, vertices, vertexSurfaceMap, candidates } = buildParserState(parser);
    const hints = parser.parseRawFaceBoundaryHints();
    if (hints.length === 0) continue;

    const targets = parser.planRawFaceBoundaryTargets(surfaces, vertices, vertexSurfaceMap, hints);

    const analyses = hints.map((hint) => {
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
            });

        const selectedEntry = [...targets.entries()].find(([, target]) => target.rawFaceId === hint.faceId);
        const selected = selectedEntry
            ? {
                key: selectedEntry[0],
                target: selectedEntry[1],
                candidate: candidates.find((candidate) => candidate.key === selectedEntry[0]) ?? null,
            }
            : null;

        const bestScore = options[0]?.match.score ?? null;
        const bestTies = bestScore === null ? [] : options.filter((entry) => entry.match.score === bestScore);
        const exactCandidates = options.filter((entry) => entry.candidate.outerSize === hint.primarySize);
        const secondBestScore = options[1]?.match.score ?? null;

        return {
            hint,
            options,
            selected,
            mode: classifySelection(hint, selected),
            bestScore,
            secondBestScore,
            bestTieCount: bestTies.length,
            exactCandidateCount: exactCandidates.length,
        };
    });

    const summary = {
        exact: analyses.filter((entry) => entry.mode === 'exact' || entry.mode === 'exact+cap').length,
        near: analyses.filter((entry) => entry.mode === 'near').length,
        capOnly: analyses.filter((entry) => entry.mode === 'cap-only').length,
        unmatched: analyses.filter((entry) => entry.mode === 'unmatched').length,
        ambiguousBest: analyses.filter((entry) => entry.bestTieCount > 1).length,
        duplicateExact: analyses.filter((entry) => entry.exactCandidateCount > 1).length,
        weakGap: analyses.filter((entry) => entry.bestScore !== null && entry.secondBestScore !== null && entry.secondBestScore - entry.bestScore <= 5).length,
    };

    console.log(`\n${fileName}`);
    console.log(`  hints=${hints.length} exact=${summary.exact} near=${summary.near} capOnly=${summary.capOnly} unmatched=${summary.unmatched} duplicateExact=${summary.duplicateExact} ambiguousBest=${summary.ambiguousBest} weakGap=${summary.weakGap}`);

    const interesting = analyses.filter((entry) => {
        return entry.mode === 'near'
            || entry.mode === 'cap-only'
            || entry.bestTieCount > 1
            || entry.exactCandidateCount > 1
            || (entry.bestScore !== null && entry.secondBestScore !== null && entry.secondBestScore - entry.bestScore <= 5);
    });

    for (const entry of interesting.slice(0, 12)) {
        const topChoices = entry.options.slice(0, 4).map((option) => ({
            key: option.candidate.key,
            surfaceType: option.candidate.surfaceType,
            outerSize: option.candidate.outerSize,
            totalSize: option.candidate.totalSize,
            holeCount: option.candidate.holeCount,
            mappedEdges: option.candidate.mappedEdgeCount,
            anchorMatches: entry.hint.edgeAnchorIds.filter((edgeId) => option.candidate.mappedEdgeIds.includes(edgeId)).length,
            matchedAnchors: entry.hint.edgeAnchorIds.filter((edgeId) => option.candidate.mappedEdgeIds.includes(edgeId)),
            chains: option.candidate.chainCount,
            segments: option.candidate.segmentCount,
            maxSeg: option.candidate.maxSegmentLength,
            maxSpan: option.candidate.maxChainSpan,
            score: option.match.score,
            outerTarget: option.match.outerSize ?? null,
            totalTarget: option.match.totalSize ?? null,
        }));

        console.log(
            `  face=${entry.hint.faceId} mode=${entry.mode} primary=${entry.hint.primarySize} collapsed=${entry.hint.collapsedSize ?? '-'} anchors=${entry.hint.edgeAnchorIds.length ? entry.hint.edgeAnchorIds.join(',') : '-'} resolved=${entry.hint.resolvedSurfaceType ?? '-'} chains=${entry.hint.chainCount} segments=${entry.hint.segmentCount} maxSeg=${entry.hint.maxSegmentLength} maxSpan=${entry.hint.maxChainSpan ?? '-'} exactCandidates=${entry.exactCandidateCount} bestTieCount=${entry.bestTieCount} gap=${entry.bestScore !== null && entry.secondBestScore !== null ? entry.secondBestScore - entry.bestScore : '-'} selected=${entry.selected?.key ?? '-'}`,
        );
        console.log(`    topChoices=${JSON.stringify(topChoices)}`);
    }
}