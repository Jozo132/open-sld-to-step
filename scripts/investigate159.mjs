#!/usr/bin/env node
/**
 * investigate159.mjs
 *
 * Measure the conservative plane-rescue hypothesis suggested by the FACE
 * byte-54 signal: if a rejected raw extracted plane id is referenced at slot
 * 54 by a raw FACE window, does keeping that plane change the deduplicated
 * surface inventory or the raw-face target assignment?
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate159.mjs
 *   node scripts/investigate159.mjs ftc_07 ftc_08
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
    throw new Error('Build output not found. Run "npm run build" before investigate159.mjs.');
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

function collectSlot54PlaneIds(parser, extractedSurfaces) {
    const planeIds = new Set(
        extractedSurfaces
            .filter((surface) => surface.surfaceType === 'plane')
            .map((surface) => surface.id),
    );

    const slot54PlaneIds = new Set();
    for (const record of parser.parseFaceInlineWindowRecords()) {
        const rawId = record.words[12];
        if (planeIds.has(rawId)) slot54PlaneIds.add(rawId);
    }
    return slot54PlaneIds;
}

function buildState(parser, rescueSlot54RejectedPlanes = false) {
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
    const slot54PlaneIds = collectSlot54PlaneIds(parser, extractedSurfaces);
    const validationAudit = [];
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

        let fate = 'kept';
        if (coplanar.length < 3) {
            fate = 'rejected-fewer-than-3';
            if (rescueSlot54RejectedPlanes && slot54PlaneIds.has(surface.id)) {
                fate = 'rescued-fewer-than-3';
                validated.push(surface);
            }
        } else {
            const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, params.normal);
            if (ratio <= 2.5) {
                validated.push(surface);
            } else {
                fate = 'rejected-line-like';
            }
        }

        validationAudit.push({
            id: surface.id,
            coplanarCount: coplanar.length,
            slot54Referenced: slot54PlaneIds.has(surface.id),
            fate,
        });
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
    const candidates = parser.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap);
    const hints = parser.parseRawFaceBoundaryHints();
    const targets = parser.planRawFaceBoundaryTargets(surfaces, vertices, vertexSurfaceMap, hints);
    const targetByFaceId = new Map();
    for (const [key, target] of targets.entries()) {
        targetByFaceId.set(target.rawFaceId, key);
    }

    return {
        slot54PlaneIds: [...slot54PlaneIds].sort((left, right) => left - right),
        validationAudit,
        surfaces,
        candidates,
        targetByFaceId,
    };
}

const summary = [];

for (const samplePath of listSamplePaths(filters)) {
    const { fileName, parser } = loadSample(samplePath);
    const baseline = buildState(parser, false);
    const rescued = buildState(parser, true);

    const baselinePlaneCount = baseline.surfaces.filter((surface) => surface.surfaceType === 'plane').length;
    const rescuedPlaneCount = rescued.surfaces.filter((surface) => surface.surfaceType === 'plane').length;
    const rescuedValidationRows = rescued.validationAudit.filter((row) => row.fate === 'rescued-fewer-than-3');

    let changedTargets = 0;
    const changedTargetExamples = [];
    const rawFaceIds = new Set([
        ...baseline.targetByFaceId.keys(),
        ...rescued.targetByFaceId.keys(),
    ]);
    for (const faceId of [...rawFaceIds].sort((left, right) => left - right)) {
        const beforeKey = baseline.targetByFaceId.get(faceId) ?? null;
        const afterKey = rescued.targetByFaceId.get(faceId) ?? null;
        if (beforeKey !== afterKey) {
            changedTargets++;
            if (changedTargetExamples.length < 10) {
                changedTargetExamples.push({ faceId, beforeKey, afterKey });
            }
        }
    }

    summary.push({
        fileName,
        slot54PlaneIds: baseline.slot54PlaneIds,
        rescuedRawPlaneCount: rescuedValidationRows.length,
        rescuedRawPlanes: rescuedValidationRows.slice(0, 12),
        dedupedPlaneDelta: rescuedPlaneCount - baselinePlaneCount,
        candidateDelta: rescued.candidates.length - baseline.candidates.length,
        changedTargets,
        changedTargetExamples,
    });
}

console.log(JSON.stringify({
    filters,
    summary,
}, null, 2));