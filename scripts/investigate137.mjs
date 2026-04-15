#!/usr/bin/env node
/**
 * investigate137.mjs — Dump current CTC_05 generated cone placements.
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

const model = new ParasolidParser(extraction.data).parse();

function canonicalizeCone(params) {
    const axis = ParasolidParser.normalizeDirection(params.axis);
    const halfAngle = Math.abs(params.halfAngle) > Math.PI
        ? (params.halfAngle * Math.PI / 180)
        : params.halfAngle;
    const tanHalfAngle = Math.tan(halfAngle);
    const offset = !isFinite(tanHalfAngle) || Math.abs(tanHalfAngle) < 1e-9
        ? 0
        : params.radius / tanHalfAngle;
    return {
        origin: params.origin,
        axis,
        radius: params.radius,
        halfAngle,
        apex: {
            x: params.origin.x - axis.x * offset,
            y: params.origin.y - axis.y * offset,
            z: params.origin.z - axis.z * offset,
        },
    };
}

const cones = model.surfaces
    .filter((surface) => surface.surfaceType === 'cone')
    .map((surface) => ({ id: surface.id, ...canonicalizeCone(surface.params) }))
    .sort((a, b) => a.apex.z - b.apex.z || a.apex.y - b.apex.y || a.apex.x - b.apex.x);

console.log(JSON.stringify(cones, null, 2));