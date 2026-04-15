#!/usr/bin/env node
/**
 * investigate139.mjs — Inspect the raw cylinder stacks behind the extra
 * CTC_05 Z-axis 59-degree drill-tip cones.
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
const targets = [
    { x: -192.474, y: -111.125 },
    { x: -111.113, y: -192.481 },
    { x: 0, y: -222.25 },
    { x: 111.113, y: -192.481 },
    { x: 192.474, y: -111.125 },
    { x: 192.474, y: 111.125 },
    { x: 111.113, y: 192.481 },
    { x: 0, y: 222.25 },
    { x: -111.113, y: 192.481 },
    { x: -192.474, y: 111.125 },
];

function normalizeAxis(axis) {
    const normalized = ParasolidParser.normalizeDirection(axis);
    return {
        x: Number(normalized.x.toFixed(6)),
        y: Number(normalized.y.toFixed(6)),
        z: Number(normalized.z.toFixed(6)),
    };
}

const report = targets.map((target) => ({
    target,
    cylinders: rawCylinders
        .map((surface) => ({
            id: surface.id,
            origin: surface.params.origin,
            axis: normalizeAxis(surface.params.axis),
            radius: Number(surface.params.radius.toFixed(6)),
            support: assoc.get(surface.id)?.length ?? 0,
        }))
        .filter((surface) => Math.abs(surface.axis.x) < 0.01 && Math.abs(surface.axis.y) < 0.01 && Math.abs(Math.abs(surface.axis.z) - 1) < 0.01)
        .filter((surface) => Math.abs(surface.origin.x - target.x) < 0.5)
        .filter((surface) => Math.abs(surface.origin.y - target.y) < 0.5)
        .sort((a, b) => a.origin.z - b.origin.z || a.radius - b.radius),
}));

console.log(JSON.stringify(report, null, 2));