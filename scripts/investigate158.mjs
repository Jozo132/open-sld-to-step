#!/usr/bin/env node
/**
 * investigate158.mjs
 *
 * Test whether a raw FACE can be uniquely matched to a grouped shell-inline
 * anchor family under the same shell by shared edge/coedge anchors, then use
 * that family to augment the FACE hint with extra anchors.
 *
 * The score-facing question is whether these conservative augmentations change
 * local best candidates or global raw-face target assignments enough to justify
 * a parser experiment.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate158.mjs
 *   node scripts/investigate158.mjs ftc_07 ftc_08
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
    throw new Error('Build output not found. Run "npm run build" before investigate158.mjs.');
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
    const hints = parser.parseRawFaceBoundaryHints();

    return {
        surfaces,
        vertices,
        vertexSurfaceMap,
        candidates: parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap),
        hints,
        faceRecords: new Map(parser.parseFaceRecords().map((record) => [record.id, record])),
    };
}

function compareOptions(left, right) {
    return left.score - right.score
        || left.candidate.totalSize - right.candidate.totalSize
        || left.candidate.outerSize - right.candidate.outerSize
        || left.candidate.key.localeCompare(right.candidate.key);
}

function groupShellInlineAnchorFamilies(parser) {
    const groups = new Map();

    for (const record of parser.parseShellInlineFaceAnchorRecords()) {
        const key = `${record.shellId}:${record.inlineId}`;
        const group = groups.get(key) ?? {
            shellId: record.shellId,
            inlineId: record.inlineId,
            edgeAnchorIds: new Set(),
            coedgeAnchorIds: new Set(),
            recordCount: 0,
        };
        group.edgeAnchorIds.add(record.edgeAnchorId);
        group.coedgeAnchorIds.add(record.coedgeAnchorId);
        group.recordCount++;
        groups.set(key, group);
    }

    const byShell = new Map();
    for (const group of groups.values()) {
        const bucket = byShell.get(group.shellId) ?? [];
        bucket.push({
            shellId: group.shellId,
            inlineId: group.inlineId,
            edgeAnchorIds: [...group.edgeAnchorIds].sort((left, right) => left - right),
            coedgeAnchorIds: [...group.coedgeAnchorIds].sort((left, right) => left - right),
            recordCount: group.recordCount,
        });
        byShell.set(group.shellId, bucket);
    }

    return byShell;
}

function hasIntersection(leftValues, rightSet) {
    for (const value of leftValues) {
        if (rightSet.has(value)) return true;
    }
    return false;
}

function unionSorted(leftValues, rightValues) {
    return [...new Set([...leftValues, ...rightValues])].sort((left, right) => left - right);
}

function scoreOptions(parser, hint, candidates) {
    return candidates
        .map((candidate) => {
            const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
            return match ? { candidate, score: match.score } : null;
        })
        .filter(Boolean)
        .sort(compareOptions);
}

function invertTargets(targets) {
    const byFaceId = new Map();
    for (const [key, target] of targets.entries()) {
        byFaceId.set(target.rawFaceId, key);
    }
    return byFaceId;
}

const summary = [];

for (const samplePath of listSamplePaths(filters)) {
    const { fileName, parser } = loadSample(samplePath);
    const { surfaces, vertices, vertexSurfaceMap, candidates, hints, faceRecords } = rebuild(parser);
    const shellGroupsByShell = groupShellInlineAnchorFamilies(parser);
    const baseTargets = invertTargets(parser.planRawFaceBoundaryTargets(surfaces, vertices, vertexSurfaceMap, hints));

    let anchoredFaces = 0;
    let uniqueGroupMatches = 0;
    let augmentableFaces = 0;
    let localBestChanged = 0;
    let localVariantOnlyChange = 0;
    let localBestScoreImproved = 0;
    let globalTargetChanged = 0;
    const augmentedHints = [];
    const examples = [];

    for (const hint of hints) {
        const faceRecord = faceRecords.get(hint.faceId);
        const shellId = faceRecord?.shellId ?? null;
        const edgeAnchorSet = new Set(hint.edgeAnchorIds);
        const coedgeAnchorSet = new Set(hint.coedgeAnchorIds);

        if (edgeAnchorSet.size === 0 && coedgeAnchorSet.size === 0) {
            augmentedHints.push(hint);
            continue;
        }

        anchoredFaces++;
        const shellGroups = shellId === null ? [] : (shellGroupsByShell.get(shellId) ?? []);
        const matchingGroups = shellGroups.filter((group) => {
            return hasIntersection(group.edgeAnchorIds, edgeAnchorSet)
                || hasIntersection(group.coedgeAnchorIds, coedgeAnchorSet);
        });

        if (matchingGroups.length !== 1) {
            augmentedHints.push(hint);
            continue;
        }

        uniqueGroupMatches++;
        const group = matchingGroups[0];
        const augmentedEdgeAnchorIds = unionSorted(hint.edgeAnchorIds, group.edgeAnchorIds);
        const augmentedCoedgeAnchorIds = unionSorted(hint.coedgeAnchorIds, group.coedgeAnchorIds);
        const addedEdgeAnchors = augmentedEdgeAnchorIds.filter((id) => !edgeAnchorSet.has(id));
        const addedCoedgeAnchors = augmentedCoedgeAnchorIds.filter((id) => !coedgeAnchorSet.has(id));

        if (addedEdgeAnchors.length === 0 && addedCoedgeAnchors.length === 0) {
            augmentedHints.push(hint);
            continue;
        }

        augmentableFaces++;
        const augmentedHint = {
            ...hint,
            edgeAnchorCount: augmentedEdgeAnchorIds.length,
            edgeAnchorIds: augmentedEdgeAnchorIds,
            coedgeAnchorIds: augmentedCoedgeAnchorIds,
        };
        augmentedHints.push(augmentedHint);

        const beforeOptions = scoreOptions(parser, hint, candidates);
        const afterOptions = scoreOptions(parser, augmentedHint, candidates);
        const beforeBest = beforeOptions[0] ?? null;
        const afterBest = afterOptions[0] ?? null;

        if (beforeBest && afterBest) {
            if (afterBest.candidate.key !== beforeBest.candidate.key) {
                localBestChanged++;
                const [beforeType, beforeSurfaceId] = beforeBest.candidate.key.split(':');
                const [afterType, afterSurfaceId] = afterBest.candidate.key.split(':');
                if (beforeType === afterType && beforeSurfaceId === afterSurfaceId) {
                    localVariantOnlyChange++;
                }
            }
            if (afterBest.score < beforeBest.score) {
                localBestScoreImproved++;
            }
        }

        if (examples.length < 12) {
            examples.push({
                faceId: hint.faceId,
                shellId,
                baseTarget: baseTargets.get(hint.faceId) ?? null,
                matchingGroup: {
                    inlineId: group.inlineId,
                    recordCount: group.recordCount,
                    edgeAnchorIds: group.edgeAnchorIds,
                    coedgeAnchorIds: group.coedgeAnchorIds,
                },
                addedEdgeAnchors,
                addedCoedgeAnchors,
                beforeBest: beforeBest ? { key: beforeBest.candidate.key, score: beforeBest.score } : null,
                afterBest: afterBest ? { key: afterBest.candidate.key, score: afterBest.score } : null,
            });
        }
    }

    const afterTargets = invertTargets(parser.planRawFaceBoundaryTargets(surfaces, vertices, vertexSurfaceMap, augmentedHints));
    for (const [faceId, beforeKey] of baseTargets.entries()) {
        const afterKey = afterTargets.get(faceId) ?? null;
        if (afterKey !== beforeKey) globalTargetChanged++;
    }

    summary.push({
        fileName,
        totalHints: hints.length,
        anchoredFaces,
        uniqueGroupMatches,
        augmentableFaces,
        localBestChanged,
        localVariantOnlyChange,
        localBestScoreImproved,
        globalTargetChanged,
        examples,
    });
}

console.log(JSON.stringify({
    filters,
    summary,
}, null, 2));