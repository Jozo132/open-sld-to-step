#!/usr/bin/env node
/**
 * investigate160.mjs
 *
 * Test the conservative shell-inline integration path: keep the existing raw
 * FACE boundary targets, then let grouped shell-inline anchor hints claim only
 * candidates that the raw FACE layer did not already target.
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate160.mjs
 *   node scripts/investigate160.mjs ftc_07 ftc_08
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
    throw new Error('Build output not found. Run "npm run build" before investigate160.mjs.');
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
    const validatedSurfaces = [];
    for (const surface of extractedSurfaces) {
        if (surface.surfaceType !== 'plane') {
            validatedSurfaces.push(surface);
            continue;
        }

        const params = surface.params;
        const coplanarVertices = [];
        for (const vertex of vertices) {
            const dx = vertex.position.x - params.origin.x;
            const dy = vertex.position.y - params.origin.y;
            const dz = vertex.position.z - params.origin.z;
            const distance = Math.abs(dx * params.normal.x + dy * params.normal.y + dz * params.normal.z);
            if (distance < 0.5) coplanarVertices.push(vertex.position);
        }
        if (coplanarVertices.length < 3) continue;

        const ratio = ParasolidParser.computeEigenvalueRatio(coplanarVertices, params.normal);
        if (ratio <= 2.5) validatedSurfaces.push(surface);
    }

    const inferredPlanes = parser.inferPlanesFromVertices(
        ParasolidParser.filterOutlierVertices(vertices),
        validatedSurfaces,
    );
    const mergedSurfaces = ParasolidParser.recoverAxisymmetricWasherSurfaces(
        [...validatedSurfaces, ...inferredPlanes],
        vertices,
    );
    const apexCones = parser.inferApexConesFromCylinderPairs(mergedSurfaces, vertices);
    const directDrillTipCones = parser.inferDrillTipConesFromRawCylinderSections(
        validatedSurfaces,
        vertices,
        apexCones,
    );
    const halfRadiusDrillTipCones = parser.inferHalfRadiusDrillTipConesFromRawCylinderSections(
        validatedSurfaces,
        vertices,
    );
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
    return {
        surfaces,
        vertices,
        vertexSurfaceMap,
        candidates: parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap),
        rawFaceHints: parser.parseRawFaceBoundaryHints(),
    };
}

function compareOptions(left, right) {
    return left.score - right.score
        || left.totalSize - right.totalSize
        || left.key.localeCompare(right.key);
}

function buildSyntheticShellHints(parser) {
    const edgePositions = parser.buildEdgeChainPositionMap();
    const groups = new Map();

    for (const record of parser.parseShellInlineFaceAnchorRecords()) {
        const key = `${record.shellId}:${record.inlineId}`;
        const group = groups.get(key) ?? {
            shellId: record.shellId,
            inlineId: record.inlineId,
            edgeIds: new Set(),
            coedgeIds: new Set(),
        };
        group.edgeIds.add(record.edgeAnchorId);
        group.coedgeIds.add(record.coedgeAnchorId);
        groups.set(key, group);
    }

    return [...groups.values()]
        .map((group) => {
            const orderedEdgePositions = [...group.edgeIds]
                .map((edgeId) => edgePositions.get(edgeId))
                .filter((position) => position !== undefined)
                .map((position) => ({
                    chainIndex: position.chainIndex,
                    linearIndex: position.linearIndex,
                }))
                .sort((left, right) => left.chainIndex - right.chainIndex || left.linearIndex - right.linearIndex);
            const spread = ParasolidParser.buildBoundarySpreadMetrics(orderedEdgePositions);

            return {
                shellId: group.shellId,
                inlineId: group.inlineId,
                faceId: -(group.shellId * 1000 + group.inlineId),
                primarySize: group.edgeIds.size,
                collapsedSize: spread.segmentCount >= 3 ? spread.segmentCount : null,
                edgeAnchorCount: group.edgeIds.size,
                edgeAnchorIds: [...group.edgeIds].sort((left, right) => left - right),
                coedgeAnchorIds: [...group.coedgeIds].sort((left, right) => left - right),
                repeatedEdgeIds: [],
                resolvedSurfaceType: null,
                chainCount: spread.chainCount,
                segmentCount: spread.segmentCount,
                maxSegmentLength: spread.maxSegmentLength,
                maxChainSpan: spread.maxChainSpan,
            };
        })
        .filter((hint) => hint.primarySize >= 3);
}

function scoreSyntheticHint(hint, candidates) {
    return candidates
        .map((candidate) => {
            const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
            if (!match) return null;
            return {
                key: candidate.key,
                outerSize: candidate.outerSize,
                totalSize: candidate.totalSize,
                anchorMatches: hint.edgeAnchorIds.filter((id) => candidate.mappedEdgeIds.includes(id)).length,
                coedgeMatches: hint.coedgeAnchorIds.filter((id) => candidate.mappedCoedgeIds.includes(id)).length,
                score: match.score,
            };
        })
        .filter(Boolean)
        .sort(compareOptions);
}

const summary = [];

for (const samplePath of listSamplePaths(filters)) {
    const { fileName, parser } = loadSample(samplePath);
    const { surfaces, vertices, vertexSurfaceMap, candidates, rawFaceHints } = rebuild(parser);
    const rawTargets = parser.planRawFaceBoundaryTargets(surfaces, vertices, vertexSurfaceMap, rawFaceHints);
    const claimedKeys = new Set(rawTargets.keys());
    const addedShellTargets = [];

    for (const hint of buildSyntheticShellHints(parser)) {
        const options = scoreSyntheticHint(hint, candidates);
        if (options.length === 0) continue;

        const best = options[0];
        const second = options[1] ?? null;
        const hasUniqueWinner = second === null || best.score < second.score;
        const hasAnchorSupport = best.anchorMatches > 0 || best.coedgeMatches > 0;
        if (!hasUniqueWinner || !hasAnchorSupport) continue;
        if (claimedKeys.has(best.key)) continue;
        if (addedShellTargets.some((entry) => entry.key === best.key)) continue;

        addedShellTargets.push({
            shellId: hint.shellId,
            inlineId: hint.inlineId,
            key: best.key,
            score: best.score,
            outerSize: best.outerSize,
            totalSize: best.totalSize,
            anchorMatches: best.anchorMatches,
            coedgeMatches: best.coedgeMatches,
            secondKey: second?.key ?? null,
            secondScore: second?.score ?? null,
        });
    }

    summary.push({
        fileName,
        rawTargetCount: rawTargets.size,
        addedShellTargetCount: addedShellTargets.length,
        addedShellTargets,
    });
}

console.log(JSON.stringify({
    filters,
    summary,
}, null, 2));