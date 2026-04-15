#!/usr/bin/env node
/**
 * investigate136.mjs — Inspect the raw CTC_05 cylinder stacks behind the
 * remaining unmatched +X 59° drill-tip cones and large Z-axis 45° frusta.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href,
);
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);

const samplePath = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ctc_05_asme1_rd_sw1802.SLDPRT',
);

const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
if (!extraction) throw new Error('Failed to extract Parasolid data');

const parser = new ParasolidParser(extraction.data);
const vertices = parser.extractCoordinates().map((point, index) => ({
    id: index + 1,
    position: {
        x: point.x * 1000,
        y: point.y * 1000,
        z: point.z * 1000,
    },
}));
const rawCylinders = parser.extractSurfaces().filter((surface) => surface.surfaceType === 'cylinder');
const assoc = parser.associateVertices(rawCylinders, vertices);
const xReferenceNeighborhoods = [
    { y: -33.2, z: 241.3 },
    { y: -41.0, z: 206.4 },
    { y: -48.7, z: 171.4 },
];

function normalizeAxis(axis) {
    const normalized = ParasolidParser.normalizeDirection(axis);
    return {
        x: Math.abs(normalized.x) < 0.001 ? 0 : Number(normalized.x.toFixed(6)),
        y: Math.abs(normalized.y) < 0.001 ? 0 : Number(normalized.y.toFixed(6)),
        z: Math.abs(normalized.z) < 0.001 ? 0 : Number(normalized.z.toFixed(6)),
    };
}

function supportCount(surfaceId) {
    return assoc.get(surfaceId)?.length ?? 0;
}

function lineDistance(a, b, axis) {
    return ParasolidParser.axisLineDistance(a, b, axis);
}

function sameDirectionGap(a, b, axis) {
    return (
        (b.x - a.x) * axis.x +
        (b.y - a.y) * axis.y +
        (b.z - a.z) * axis.z
    );
}

const xCandidates = rawCylinders
    .map((surface) => ({
        id: surface.id,
        origin: surface.params.origin,
        axis: normalizeAxis(surface.params.axis),
        radius: surface.params.radius,
        support: supportCount(surface.id),
    }))
    .filter((surface) => Math.abs(Math.abs(surface.axis.x) - 1) < 0.01)
    .filter((surface) => surface.radius >= 5.8 && surface.radius <= 6.6)
    .sort((a, b) => a.origin.x - b.origin.x || a.origin.y - b.origin.y || a.origin.z - b.origin.z);

const xPairs = [];
for (const a of xCandidates) {
    for (const b of xCandidates) {
        if (a.id === b.id) continue;
        const dot = a.axis.x * b.axis.x + a.axis.y * b.axis.y + a.axis.z * b.axis.z;
        if (dot < 0.98) continue;
        if (Math.abs(a.radius - b.radius) > 0.02) continue;
        const gap = sameDirectionGap(a.origin, b.origin, a.axis);
        if (gap <= 0) continue;
        if (gap < 2 || gap > 20) continue;
        if (lineDistance(a.origin, b.origin, a.axis) > 0.75) continue;
        xPairs.push({
            fromId: a.id,
            toId: b.id,
            axis: a.axis,
            radius: Number(a.radius.toFixed(6)),
            gap: Number(gap.toFixed(6)),
            support: [a.support, b.support],
            fromOrigin: a.origin,
            toOrigin: b.origin,
        });
    }
}

const zCandidates = rawCylinders
    .map((surface) => ({
        id: surface.id,
        origin: surface.params.origin,
        axis: normalizeAxis(surface.params.axis),
        radius: surface.params.radius,
        support: supportCount(surface.id),
    }))
    .filter((surface) => Math.abs(Math.abs(surface.axis.z) - 1) < 0.01)
    .filter((surface) => surface.radius >= 20 && surface.radius <= 160)
    .sort((a, b) => a.radius - b.radius || a.origin.z - b.origin.z);

const zPairs = [];
for (let i = 0; i < zCandidates.length; i++) {
    for (let j = i + 1; j < zCandidates.length; j++) {
        const a = zCandidates[i];
        const b = zCandidates[j];
        const axis = a.axis;
        const dot = axis.x * b.axis.x + axis.y * b.axis.y + axis.z * b.axis.z;
        if (Math.abs(Math.abs(dot) - 1) > 0.02) continue;
        if (lineDistance(a.origin, b.origin, axis) > 0.75) continue;
        const gap = Math.abs(sameDirectionGap(a.origin, b.origin, axis));
        if (gap <= 0) continue;
        const deltaRadius = Math.abs(b.radius - a.radius);
        const angleDeg = Math.atan(deltaRadius / gap) * 180 / Math.PI;
        if (Math.abs(angleDeg - 45) > 1) continue;
        zPairs.push({
            aId: a.id,
            bId: b.id,
            axis,
            smallRadius: Number(Math.min(a.radius, b.radius).toFixed(6)),
            largeRadius: Number(Math.max(a.radius, b.radius).toFixed(6)),
            gap: Number(gap.toFixed(6)),
            angleDeg: Number(angleDeg.toFixed(6)),
            support: [a.support, b.support],
            aOrigin: a.origin,
            bOrigin: b.origin,
        });
    }
}

const xNeighborhoods = xReferenceNeighborhoods.map((target) => ({
    target,
    cylinders: rawCylinders
        .map((surface) => ({
            id: surface.id,
            origin: surface.params.origin,
            axis: normalizeAxis(surface.params.axis),
            radius: surface.params.radius,
            support: supportCount(surface.id),
        }))
        .filter((surface) => Math.abs(Math.abs(surface.axis.x) - 1) < 0.01)
        .filter((surface) => Math.abs(surface.origin.y - target.y) <= 20)
        .filter((surface) => Math.abs(surface.origin.z - target.z) <= 20)
        .sort((a, b) => a.origin.x - b.origin.x || a.radius - b.radius),
}));

console.log(JSON.stringify({ xCandidates, xPairs, zPairs, xNeighborhoods }, null, 2));