#!/usr/bin/env node
/**
 * investigate131.mjs — Identify which cone-inference stage produces the
 * repeated CTC_04 59-degree cone family around z = -65.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate131.mjs
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ParasolidParser } from '../dist/parser/ParasolidParser.js';
import { SldprtContainerParser } from '../dist/parser/SldprtContainerParser.js';

const PS_TO_MM = 1000;

function buildVertices(points) {
    return points.map((pt, index) => ({
        id: index + 1,
        position: {
            x: pt.x * PS_TO_MM,
            y: pt.y * PS_TO_MM,
            z: pt.z * PS_TO_MM,
        },
    }));
}

function validateSurfaces(parser, extractedSurfaces, vertices) {
    const validated = [];
    for (const surface of extractedSurfaces) {
        if (surface.surfaceType !== 'plane') {
            validated.push(surface);
            continue;
        }

        const coplanar = [];
        const plane = surface.params;
        for (const vertex of vertices) {
            const dx = vertex.position.x - plane.origin.x;
            const dy = vertex.position.y - plane.origin.y;
            const dz = vertex.position.z - plane.origin.z;
            const dist = Math.abs(dx * plane.normal.x + dy * plane.normal.y + dz * plane.normal.z);
            if (dist < ParasolidParser.VERTEX_PLANE_TOL) coplanar.push(vertex.position);
        }
        if (coplanar.length < 3) continue;

        const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, plane.normal);
        if (ratio <= ParasolidParser.PLANE_EIGEN_RATIO_MAX) validated.push(surface);
    }

    return validated;
}

function summarizeCone(surface) {
    return {
        id: surface.id,
        origin: {
            x: Number(surface.params.origin.x.toFixed(3)),
            y: Number(surface.params.origin.y.toFixed(3)),
            z: Number(surface.params.origin.z.toFixed(3)),
        },
        axis: {
            x: Number(surface.params.axis.x.toFixed(6)),
            y: Number(surface.params.axis.y.toFixed(6)),
            z: Number(surface.params.axis.z.toFixed(6)),
        },
        radius: Number(surface.params.radius.toFixed(3)),
        halfAngle: Number(surface.params.halfAngle.toFixed(6)),
    };
}

function filterProblemFamily(cones) {
    return cones
        .filter((surface) => surface.surfaceType === 'cone')
        .filter((surface) => Math.abs(surface.params.origin.z + 65) < 0.2)
        .filter((surface) => Math.abs(Math.abs(surface.params.axis.z) - 1) < 0.01)
        .filter((surface) => Math.abs(surface.params.radius - 3.325) < 0.05)
        .filter((surface) => Math.abs(surface.params.halfAngle - 59) < 0.05 || Math.abs(surface.params.halfAngle - 1.02974425867665) < 0.05)
        .map(summarizeCone)
        .sort((left, right) => left.origin.y - right.origin.y || left.origin.x - right.origin.x);
}

const root = resolve(process.cwd());
const filePath = join(root, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018', 'nist_ctc_04_asme1_rd_sw1802.SLDPRT');
const buffer = readFileSync(filePath);
const extraction = SldprtContainerParser.extractParasolid(buffer);
if (!extraction) throw new Error('Failed to extract Parasolid payload');

const parser = new ParasolidParser(extraction.data);
const points = parser.extractCoordinates();
const vertices = buildVertices(points);
const extractedSurfaces = parser.extractSurfaces();
const validatedSurfaces = validateSurfaces(parser, extractedSurfaces, vertices);
const inferVertices = ParasolidParser.filterOutlierVertices(vertices);
const inferredPlanes = parser.inferPlanesFromVertices(inferVertices, validatedSurfaces);
const mergedSurfaces = ParasolidParser.recoverAxisymmetricWasherSurfaces(
    [...validatedSurfaces, ...inferredPlanes],
    vertices,
);
const apexCones = parser.inferApexConesFromCylinderPairs(mergedSurfaces, vertices);
const directDrillTipCones = parser.inferDrillTipConesFromRawCylinderSections(validatedSurfaces, vertices);
const halfRadiusDrillTipCones = parser.inferHalfRadiusDrillTipConesFromRawCylinderSections(validatedSurfaces, vertices);
const repeatedCenterDrillTipCones = parser.inferRepeatedCenterCylinderDrillTipCones(
    validatedSurfaces,
    vertices,
    halfRadiusDrillTipCones,
);

const report = {
    extracted: filterProblemFamily(extractedSurfaces),
    apexCones: filterProblemFamily(apexCones),
    directDrillTipCones: filterProblemFamily(directDrillTipCones),
    halfRadiusDrillTipCones: filterProblemFamily(halfRadiusDrillTipCones),
    repeatedCenterDrillTipCones: filterProblemFamily(repeatedCenterDrillTipCones),
};

console.log(JSON.stringify(report, null, 2));