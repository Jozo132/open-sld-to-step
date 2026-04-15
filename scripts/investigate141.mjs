#!/usr/bin/env bun
/**
 * investigate141.mjs — Inspect FTC_07 final cone/cylinder surfaces and nearby
 * compact geometry-like Y-axis records around the missing shallow-cone family.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'parser', 'ParasolidParser.ts')).href,
);
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'parser', 'SldprtContainerParser.ts')).href,
);

const samplePath = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ftc_07_asme1_rd_sw1802.SLDPRT',
);

const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
if (!extraction) throw new Error('Failed to extract Parasolid data');

const parser = new ParasolidParser(extraction.data);
const model = parser.parse();
const rawSurfaces = parser.extractSurfaces();

function normalizeAxis(axis) {
    const normalized = ParasolidParser.normalizeDirection(axis);
    return {
        x: Number(normalized.x.toFixed(6)),
        y: Number(normalized.y.toFixed(6)),
        z: Number(normalized.z.toFixed(6)),
    };
}

function roundPoint(point) {
    return {
        x: Number(point.x.toFixed(3)),
        y: Number(point.y.toFixed(3)),
        z: Number(point.z.toFixed(3)),
    };
}

function coneSummary(surface) {
    return {
        id: surface.id,
        origin: roundPoint(surface.params.origin),
        axis: normalizeAxis(surface.params.axis),
        radius: Number(surface.params.radius.toFixed(6)),
        halfAngleDeg: Number((ParasolidParser.coneHalfAngleRadians(surface.params.halfAngle) * 180 / Math.PI).toFixed(6)),
    };
}

function cylinderSummary(surface) {
    return {
        id: surface.id,
        origin: roundPoint(surface.params.origin),
        axis: normalizeAxis(surface.params.axis),
        radius: Number(surface.params.radius.toFixed(6)),
    };
}

function decodeGeomRecords(records, label) {
    const matches = [];

    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const nextOffset = records[index + 1]?.offset ?? parser.buf.length;
        const window = parser.buf.subarray(record.offset, nextOffset);
        const markerResults = ParasolidParser.readAllGeomMarkers(window);

        for (const result of markerResults) {
            const floats = result.floats;
            if (floats.length < 11) continue;

            const axis = normalizeAxis({ x: floats[3], y: floats[4], z: floats[5] });
            const origin = {
                x: floats[0] * 1000,
                y: floats[1] * 1000,
                z: floats[2] * 1000,
            };
            const radius = floats[9] * 1000;
            const halfAngleDeg = floats[10] * 180 / Math.PI;
            const axisDistanceToY = Math.hypot(axis.x, Math.abs(axis.y) - 1, axis.z);

            if (axisDistanceToY > 0.05) continue;
            if (origin.y < 8 || origin.y > 14) continue;
            if (Math.abs(origin.x) < 90 || Math.abs(origin.z) < 60) continue;

            matches.push({
                label,
                id: record.id,
                type: record.type,
                marker: result.marker,
                length: floats.length,
                origin: roundPoint(origin),
                axis,
                radius: Number(radius.toFixed(6)),
                halfAngleDeg: Number(halfAngleDeg.toFixed(6)),
            });
        }
    }

    return matches.sort((a, b) =>
        a.origin.x - b.origin.x || a.origin.z - b.origin.z || a.radius - b.radius || a.id - b.id,
    );
}

const finalCones = model.surfaces
    .filter((surface) => surface.surfaceType === 'cone')
    .map((surface) => coneSummary(surface));

const finalTinyCylinders = model.surfaces
    .filter((surface) => surface.surfaceType === 'cylinder')
    .map((surface) => cylinderSummary(surface))
    .filter((surface) => surface.radius <= 0.01);

const rawTinyCylinders = rawSurfaces
    .filter((surface) => surface.surfaceType === 'cylinder')
    .map((surface) => cylinderSummary(surface))
    .filter((surface) => surface.radius <= 0.01);

const compact = parser.parseCompactGeometryLikeRecords().sort((a, b) => a.offset - b.offset);
const packed = parser.parsePackedGeometryLikeRecords().sort((a, b) => a.offset - b.offset);

const compactYAxisCandidates = decodeGeomRecords(compact, 'compact');
const packedYAxisCandidates = decodeGeomRecords(packed, 'packed');

console.log(JSON.stringify({
    finalCones,
    finalTinyCylinders,
    rawTinyCylinders,
    compactYAxisCandidates,
    packedYAxisCandidates,
}, null, 2));