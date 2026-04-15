#!/usr/bin/env bun
/**
 * investigate140.mjs — Inspect FTC_07 compact type-134 geometry payloads and
 * the FTC_06 raw cylinder stack behind the 59-degree drill-tip regression.
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

function loadParser(sampleName) {
    const samplePath = path.join(
        ROOT,
        'downloads',
        'nist',
        'NIST-FTC-CTC-PMI-CAD-models',
        'SolidWorks MBD 2018',
        sampleName,
    );
    const extraction = SldprtContainerParser.extractParasolid(fs.readFileSync(samplePath));
    if (!extraction) throw new Error(`Failed to extract Parasolid data from ${sampleName}`);
    return new ParasolidParser(extraction.data);
}

function mmVertices(parser) {
    return parser.extractCoordinates().map((point, index) => ({
        id: index + 1,
        position: {
            x: point.x * 1000,
            y: point.y * 1000,
            z: point.z * 1000,
        },
    }));
}

function normalizeAxis(axis) {
    const normalized = ParasolidParser.normalizeDirection(axis);
    return {
        x: Number(normalized.x.toFixed(6)),
        y: Number(normalized.y.toFixed(6)),
        z: Number(normalized.z.toFixed(6)),
    };
}

function inspectFtc07() {
    const parser = loadParser('nist_ftc_07_asme1_rd_sw1802.SLDPRT');
    const vertices = mmVertices(parser);
    const rawSurfaces = parser.extractSurfaces();
    const rawCylinders = rawSurfaces.filter((surface) => surface.surfaceType === 'cylinder');
    const rawAssoc = parser.associateVertices(rawCylinders, vertices);
    const allCompact = parser.parseCompactGeometryLikeRecords()
        .sort((a, b) => a.offset - b.offset);
    const compact = allCompact
        .filter((record) => record.type === 134)
        .sort((a, b) => a.offset - b.offset);
    const packed = parser.parsePackedGeometryLikeRecords()
        .sort((a, b) => a.offset - b.offset);

    const interestingIds = new Set([1780, 1788, 1836]);
    const report = compact
        .filter((record) => interestingIds.has(record.id))
        .map((record) => {
            const index = compact.findIndex((candidate) => candidate.id === record.id);
            const nextOffset = compact[index + 1]?.offset ?? parser.buf.length;
            const fullSlice = parser.buf.subarray(record.offset, nextOffset);
            const markerSlice = parser.buf.subarray(record.offset + 18, nextOffset);
            const bestFromFull = ParasolidParser.readGeomFloats(fullSlice);
            const bestFromMarker = ParasolidParser.readGeomFloats(markerSlice);
            const allFromFull = ParasolidParser.readAllGeomMarkers(fullSlice);
            const allFromMarker = ParasolidParser.readAllGeomMarkers(markerSlice);

            return {
                id: record.id,
                offset: record.offset,
                nextOffset,
                markerByte: record.markerByte,
                refIds: record.refIds,
                bestFromFull: bestFromFull ? {
                    marker: bestFromFull.marker,
                    length: bestFromFull.floats.length,
                    floats: bestFromFull.floats.slice(0, 14),
                } : null,
                bestFromMarker: bestFromMarker ? {
                    marker: bestFromMarker.marker,
                    length: bestFromMarker.floats.length,
                    floats: bestFromMarker.floats.slice(0, 14),
                } : null,
                allFromFull: allFromFull.map((result) => ({
                    marker: result.marker,
                    length: result.floats.length,
                    floats: result.floats.slice(0, 14),
                })),
                allFromMarker: allFromMarker.map((result) => ({
                    marker: result.marker,
                    length: result.floats.length,
                    floats: result.floats.slice(0, 14),
                })),
            };
        });

    const compactTargetMatches = [];
    for (let i = 0; i < compact.length; i++) {
        const record = compact[i];
        const nextOffset = compact[i + 1]?.offset ?? parser.buf.length;
        const window = parser.buf.subarray(record.offset, nextOffset);
        const markerResults = ParasolidParser.readAllGeomMarkers(window);

        markerResults.forEach((result, resultIndex) => {
            const floats = result.floats;
            if (floats.length < 11) return;

            const origin = {
                x: floats[0] * 1000,
                y: floats[1] * 1000,
                z: floats[2] * 1000,
            };
            const axis = normalizeAxis({ x: floats[3], y: floats[4], z: floats[5] });
            const radius = floats[9] * 1000;
            const semiAngle = floats[10];

            const originDistance = Math.hypot(
                origin.x - 139.2,
                origin.y - 11.4,
                origin.z + 71.6,
            );
            const axisDistance = Math.hypot(axis.x - 0, axis.y - 1, axis.z - 0);
            const radiusDistance = Math.abs(radius - 7.17);
            const angleDistance = Math.abs(semiAngle - (2 * Math.PI / 180));

            if (originDistance < 5 || (axisDistance < 0.1 && radiusDistance < 1 && angleDistance < 0.05)) {
                compactTargetMatches.push({
                    id: record.id,
                    type: record.type,
                    offset: record.offset,
                    resultIndex,
                    marker: result.marker,
                    length: floats.length,
                    origin,
                    axis,
                    radius,
                    semiAngle,
                    originDistance,
                    axisDistance,
                    radiusDistance,
                    angleDistance,
                    floats: floats.slice(0, 14),
                });
            }
        });
    }

    const searchRecords = (records, label) => {
        const matches = [];
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const nextOffset = records[i + 1]?.offset ?? parser.buf.length;
            const window = parser.buf.subarray(record.offset, nextOffset);
            const markerResults = ParasolidParser.readAllGeomMarkers(window);

            markerResults.forEach((result, resultIndex) => {
                const floats = result.floats;
                if (floats.length < 11) return;

                const axisMag = Math.hypot(floats[3], floats[4], floats[5]) || 1;
                const origin = {
                    x: floats[0] * 1000,
                    y: floats[1] * 1000,
                    z: floats[2] * 1000,
                };
                const axis = {
                    x: Number((floats[3] / axisMag).toFixed(6)),
                    y: Number((floats[4] / axisMag).toFixed(6)),
                    z: Number((floats[5] / axisMag).toFixed(6)),
                };
                const radius = floats[9] * 1000;
                const semiAngle = floats[10];
                const originDistance = Math.hypot(origin.x - 139.2, origin.y - 11.4, origin.z + 71.6);
                const radiusDistance = Math.abs(radius - 7.17);
                const angleDistance = Math.abs(semiAngle - (2 * Math.PI / 180));
                const axisDistance = Math.hypot(axis.x, axis.y - 1, axis.z);

                if (originDistance < 20 || (radiusDistance < 2 && angleDistance < 0.05 && axisDistance < 0.2)) {
                    matches.push({
                        label,
                        id: record.id,
                        type: record.type,
                        offset: record.offset,
                        resultIndex,
                        marker: result.marker,
                        length: floats.length,
                        origin,
                        axis,
                        radius,
                        semiAngle,
                        originDistance,
                        radiusDistance,
                        angleDistance,
                        axisDistance,
                        floats: floats.slice(0, 14),
                    });
                }
            });
        }

        return matches;
    };

    const allCompactTargetMatches = searchRecords(allCompact, 'compact');
    const packedTargetMatches = searchRecords(packed, 'packed');

    const nearbyCylinders = rawCylinders
        .filter((surface) => Math.abs(surface.params.origin.x - 139.2) < 1)
        .filter((surface) => Math.abs(surface.params.origin.z + 71.6) < 1)
        .map((surface) => ({
            id: surface.id,
            origin: surface.params.origin,
            axis: normalizeAxis(surface.params.axis),
            radius: Number(surface.params.radius.toFixed(6)),
            support: rawAssoc.get(surface.id)?.length ?? 0,
        }))
        .sort((a, b) => a.origin.y - b.origin.y || a.radius - b.radius);

    const nearbySurfaces = rawSurfaces
        .filter((surface) => {
            const params = surface.params;
            if (!params || typeof params !== 'object' || !('origin' in params)) return false;
            return Math.abs(params.origin.x - 139.2) < 2 && Math.abs(params.origin.z + 71.6) < 2;
        })
        .map((surface) => ({
            id: surface.id,
            surfaceType: surface.surfaceType,
            origin: surface.params.origin,
            axis: 'axis' in surface.params ? normalizeAxis(surface.params.axis) : null,
            radius: 'radius' in surface.params ? Number(surface.params.radius.toFixed(6)) : null,
            halfAngle: 'halfAngle' in surface.params ? surface.params.halfAngle : null,
            support: surface.surfaceType === 'cylinder' ? (rawAssoc.get(surface.id)?.length ?? 0) : null,
        }))
        .sort((a, b) => a.origin.y - b.origin.y || (a.radius ?? 0) - (b.radius ?? 0));

    return {
        report,
        compactTargetMatches,
        allCompactTargetMatches,
        packedTargetMatches,
        nearbyCylinders,
        nearbySurfaces,
    };
}

function inspectFtc06() {
    const parser = loadParser('nist_ftc_06_asme1_rd_sw1802.SLDPRT');
    const vertices = mmVertices(parser);
    const rawSurfaces = parser.extractSurfaces();
    const cylinders = rawSurfaces.filter((surface) => surface.surfaceType === 'cylinder');
    const assoc = parser.associateVertices(cylinders, vertices);
    const zeroSupport = cylinders.filter((surface) => (assoc.get(surface.id)?.length ?? 0) === 0);

    const candidates = zeroSupport.filter((surface) => (
        Math.abs(surface.params.origin.x - 76.2) < 0.2 &&
        Math.abs(surface.params.origin.z + 158.75) < 0.2 &&
        Math.abs(surface.params.radius - 3.175) < 0.2
    ));

    const report = candidates.map((surface) => {
        const axis = ParasolidParser.normalizeDirection(surface.params.axis);
        let nearestAhead = null;
        let nearestAheadGap = Infinity;

        for (const other of zeroSupport) {
            if (other.id === surface.id) continue;
            if (Math.abs(other.params.radius - surface.params.radius) >= ParasolidParser.CYL_RADIUS_TOL) continue;

            const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
            const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
            if (dot < 0.98) continue;
            if (ParasolidParser.axisLineDistance(surface.params.origin, other.params.origin, axis) >
                ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) {
                continue;
            }

            const gap =
                (other.params.origin.x - surface.params.origin.x) * axis.x +
                (other.params.origin.y - surface.params.origin.y) * axis.y +
                (other.params.origin.z - surface.params.origin.z) * axis.z;
            if (gap < ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MIN ||
                gap > ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MAX) {
                continue;
            }

            if (gap < nearestAheadGap) {
                nearestAheadGap = gap;
                nearestAhead = other;
            }
        }

        const coaxialAtAheadOrigin = nearestAhead
            ? cylinders.filter((other) => {
                const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
                const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
                if (Math.abs(Math.abs(dot) - 1) > 0.02) return false;
                if (ParasolidParser.axisLineDistance(nearestAhead.params.origin, other.params.origin, axis) >
                    ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) {
                    return false;
                }

                const dx = nearestAhead.params.origin.x - other.params.origin.x;
                const dy = nearestAhead.params.origin.y - other.params.origin.y;
                const dz = nearestAhead.params.origin.z - other.params.origin.z;
                return Math.sqrt(dx * dx + dy * dy + dz * dz) <= ParasolidParser.CYL_ORIGIN_TOL;
            }).map((other) => ({
                id: other.id,
                origin: other.params.origin,
                axis: normalizeAxis(other.params.axis),
                radius: Number(other.params.radius.toFixed(6)),
                support: assoc.get(other.id)?.length ?? 0,
            }))
            : [];

        return {
            cylinder: {
                id: surface.id,
                origin: surface.params.origin,
                axis: normalizeAxis(surface.params.axis),
                radius: Number(surface.params.radius.toFixed(6)),
            },
            nearestAheadGap,
            nearestAhead: nearestAhead ? {
                id: nearestAhead.id,
                origin: nearestAhead.params.origin,
                axis: normalizeAxis(nearestAhead.params.axis),
                radius: Number(nearestAhead.params.radius.toFixed(6)),
                support: assoc.get(nearestAhead.id)?.length ?? 0,
                hasCompetingLargerAtOrigin: parser.hasCompetingLargerSectionAtOrigin(nearestAhead, cylinders),
            } : null,
            coaxialAtAheadOrigin,
        };
    });

    return report;
}

console.log(JSON.stringify({
    ftc07: inspectFtc07(),
    ftc06: inspectFtc06(),
}, null, 2));