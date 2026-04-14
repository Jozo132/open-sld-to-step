#!/usr/bin/env node
/**
 * investigate127.mjs — Inspect CTC_02 raw/merged cone neighborhoods.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate127.mjs
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

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);

const SAMPLE_NAME = 'nist_ctc_02_asme1_rc_sw1802.SLDPRT';

const PROBES = [
    {
        label: 'z-plus-hole-grid',
        origin: { x: 35, y: 20, z: -31.14868755092 },
        axis: { x: 0, y: 0, z: 1 },
    },
    {
        label: 'z-minus-hole-grid',
        origin: { x: 122, y: 128, z: -331.861737122626 },
        axis: { x: 0, y: 0, z: -1 },
    },
    {
        label: 'x-minus-side-family',
        origin: { x: -241.574122022116, y: 288, z: -185 },
        axis: { x: -1, y: 0, z: 0 },
    },
];

function normalizeAxis(axis) {
    return [axis.x, axis.y, axis.z].map((value) => {
        if (Math.abs(value) < 0.001) return 0;
        if (Math.abs(value) > 0.999) return Math.sign(value);
        return Number(value.toFixed(3));
    });
}

function axisLineDistance(originA, originB, axis) {
    const dx = originA.x - originB.x;
    const dy = originA.y - originB.y;
    const dz = originA.z - originB.z;
    const along = dx * axis.x + dy * axis.y + dz * axis.z;
    const px = dx - along * axis.x;
    const py = dy - along * axis.y;
    const pz = dz - along * axis.z;
    return Math.sqrt(px * px + py * py + pz * pz);
}

function findSample(name) {
    for (const entry of fs.readdirSync(SAMPLE_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name.toLowerCase() === name.toLowerCase()) {
            return path.join(SAMPLE_DIR, entry.name);
        }
    }
    return null;
}

const samplePath = findSample(SAMPLE_NAME);
if (!samplePath) throw new Error(`Sample not found: ${SAMPLE_NAME}`);

const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
if (!extraction) throw new Error('Failed to extract Parasolid stream');

const parser = new ParasolidParser(extraction.data);
const rawSurfaces = parser.extractSurfaces();
const model = parser.parse();

function collectNearby(surfaces, probe, radiusDelta = Infinity) {
    const axis = probe.axis;
    return surfaces
        .filter((surface) => surface.surfaceType === 'cylinder' || surface.surfaceType === 'cone')
        .map((surface) => {
            const params = surface.params;
            const lineDist = axisLineDistance(probe.origin, params.origin, axis);
            const dx = params.origin.x - probe.origin.x;
            const dy = params.origin.y - probe.origin.y;
            const dz = params.origin.z - probe.origin.z;
            const h = dx * axis.x + dy * axis.y + dz * axis.z;
            return {
                id: surface.id,
                surfaceType: surface.surfaceType,
                origin: params.origin,
                axis: normalizeAxis(params.axis),
                radius: params.radius,
                halfAngle: surface.surfaceType === 'cone' ? params.halfAngle : undefined,
                lineDist,
                h,
            };
        })
        .filter((surface) => surface.lineDist < 1)
        .filter((surface) => Number.isFinite(radiusDelta)
            ? Math.abs((surface.radius ?? 0) - radiusDelta) < 3
            : true)
        .sort((left, right) => left.h - right.h || left.radius - right.radius)
        .slice(0, 40);
}

const report = PROBES.map((probe) => ({
    probe: {
        label: probe.label,
        origin: probe.origin,
        axis: normalizeAxis(probe.axis),
    },
    rawNearby: collectNearby(rawSurfaces, probe),
    mergedNearby: collectNearby(model.surfaces, probe),
}));

console.log(JSON.stringify(report, null, 2));