#!/usr/bin/env bun
/**
 * investigate148.mjs — Score grouped shell-inline anchor hints against current boundary candidates.
 *
 * Probes whether the stable short type-0x11 inline face-anchor family can be
 * promoted into synthetic face hints that improve candidate selection inside
 * the current bounded-topology scorer.
 *
 * Clean-room scope:
 * - groups only public-NIST shell-inline anchor records recovered from the
 *   parser's structural type-0x11 decoder
 * - rebuilds the parser's current heuristic boundary candidate set
 * - scores synthetic shell hints without changing parse() output
 *
 * The intended outcome is evidence, not a parser change: if grouped shell
 * hints still produce weak or overly ambiguous winners, they should remain
 * investigative only.
 */
import {
    ParasolidParser,
    loadSample,
    listSamplePaths,
} from './_payload-gap-lib.mjs';

const DEFAULT_FILTERS = ['ctc_02', 'ftc_07', 'ftc_08'];
const PS_TO_MM = 1000;

function rebuildBoundaryCandidates(parser) {
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

    const inferVertices = ParasolidParser.filterOutlierVertices(vertices);
    const inferredPlanes = parser.inferPlanesFromVertices(inferVertices, validatedSurfaces);
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
    const candidates = parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap);

    return { candidates };
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
        .filter((hint) => hint.primarySize >= 3)
        .sort((left, right) => right.primarySize - left.primarySize || left.shellId - right.shellId || left.inlineId - right.inlineId);
}

function scoreSyntheticHints(parser) {
    const { candidates } = rebuildBoundaryCandidates(parser);
    const hints = buildSyntheticShellHints(parser);

    return hints.map((hint) => {
        const options = candidates
            .map((candidate) => {
                const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
                if (!match) return null;

                return {
                    key: candidate.key,
                    surfaceType: candidate.surfaceType,
                    outerSize: candidate.outerSize,
                    totalSize: candidate.totalSize,
                    mappedEdgeCount: candidate.mappedEdgeCount,
                    anchorMatches: hint.edgeAnchorIds.filter((id) => candidate.mappedEdgeIds.includes(id)).length,
                    coedgeMatches: hint.coedgeAnchorIds.filter((id) => candidate.mappedCoedgeIds.includes(id)).length,
                    score: match.score,
                };
            })
            .filter((option) => option !== null)
            .sort((left, right) => {
                return left.score - right.score
                    || left.totalSize - right.totalSize
                    || left.key.localeCompare(right.key);
            });

        return {
            shellId: hint.shellId,
            inlineId: hint.inlineId,
            primarySize: hint.primarySize,
            edgeAnchorIds: hint.edgeAnchorIds,
            coedgeAnchorIds: hint.coedgeAnchorIds,
            optionCount: options.length,
            best: options[0] ?? null,
            second: options[1] ?? null,
        };
    });
}

function summarize(results) {
    return {
        syntheticHintCount: results.length,
        uniqueWinners: results.filter((result) => result.best && (!result.second || result.best.score < result.second.score)).length,
        zeroBestEdgeAnchorMatches: results.filter((result) => result.best && result.best.anchorMatches === 0).length,
        zeroBestCoedgeAnchorMatches: results.filter((result) => result.best && result.best.coedgeMatches === 0).length,
        broadCandidateSets: results.filter((result) => result.optionCount >= 25).length,
    };
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters.length > 0 ? filters : DEFAULT_FILTERS);

console.log('investigate148 — grouped shell-inline anchor hints vs current boundary candidates');
console.log('Clean-room basis: structural type-0x11 anchor groups scored against the existing heuristic candidate set without changing parse() output.');

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const results = scoreSyntheticHints(parser);
    if (results.length === 0) continue;

    console.log(`\n== ${fileName} ==`);
    console.log(JSON.stringify(summarize(results), null, 2));
    console.log(JSON.stringify(results.slice(0, 8), null, 2));
}
