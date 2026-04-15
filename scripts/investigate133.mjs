#!/usr/bin/env node
/**
 * investigate133.mjs — Inspect same-axis different-radius neighborhoods for
 * direct-drill-tip candidates.
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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

function analyzeFile(filePath, filterFn = () => true) {
    const buffer = readFileSync(filePath);
    const extraction = SldprtContainerParser.extractParasolid(buffer);
    if (!extraction) throw new Error(`Failed to extract Parasolid from ${filePath}`);

    const parser = new ParasolidParser(extraction.data);
    const points = parser.extractCoordinates();
    const vertices = buildVertices(points);
    const rawSurfaces = parser.extractSurfaces();
    const cylinders = rawSurfaces.filter((surface) => surface.surfaceType === 'cylinder');
    const assoc = parser.associateVertices(cylinders, vertices);
    const zeroSupportCylinders = cylinders.filter((surface) => {
        return (assoc.get(surface.id)?.length ?? 0) === 0 &&
            surface.params.radius >= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_RADIUS_MIN &&
            surface.params.radius <= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_RADIUS_MAX;
    });

    const candidates = [];
    for (const cylinder of zeroSupportCylinders) {
        const axis = ParasolidParser.normalizeDirection(cylinder.params.axis);

        let nearestAheadGap = Infinity;
        for (const other of zeroSupportCylinders) {
            if (other.id === cylinder.id) continue;
            if (Math.abs(other.params.radius - cylinder.params.radius) >= ParasolidParser.CYL_RADIUS_TOL) continue;
            const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
            const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
            if (dot < 0.98) continue;
            if (ParasolidParser.axisLineDistance(cylinder.params.origin, other.params.origin, axis) >
                ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) continue;
            const gap =
                (other.params.origin.x - cylinder.params.origin.x) * axis.x +
                (other.params.origin.y - cylinder.params.origin.y) * axis.y +
                (other.params.origin.z - cylinder.params.origin.z) * axis.z;
            if (gap < ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MIN ||
                gap > ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MAX) continue;
            if (gap < nearestAheadGap) nearestAheadGap = gap;
        }

        if (!isFinite(nearestAheadGap)) continue;
        if (!filterFn(cylinder)) continue;

        const sameLineDifferentRadius = cylinders
            .filter((other) => other.id !== cylinder.id)
            .filter((other) => Math.abs(other.params.radius - cylinder.params.radius) >= ParasolidParser.CYL_RADIUS_TOL)
            .map((other) => {
                const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
                const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
                if (Math.abs(Math.abs(dot) - 1) > 0.02) return null;
                if (ParasolidParser.axisLineDistance(cylinder.params.origin, other.params.origin, axis) >
                    ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) return null;
                const gap =
                    (other.params.origin.x - cylinder.params.origin.x) * axis.x +
                    (other.params.origin.y - cylinder.params.origin.y) * axis.y +
                    (other.params.origin.z - cylinder.params.origin.z) * axis.z;
                return {
                    id: other.id,
                    gap: Number(gap.toFixed(3)),
                    radius: Number(other.params.radius.toFixed(3)),
                    support: assoc.get(other.id)?.length ?? 0,
                };
            })
            .filter((item) => item !== null)
            .sort((left, right) => Math.abs(left.gap) - Math.abs(right.gap));

        candidates.push({
            id: cylinder.id,
            origin: {
                x: Number(cylinder.params.origin.x.toFixed(3)),
                y: Number(cylinder.params.origin.y.toFixed(3)),
                z: Number(cylinder.params.origin.z.toFixed(3)),
            },
            axis: {
                x: Number(axis.x.toFixed(3)),
                y: Number(axis.y.toFixed(3)),
                z: Number(axis.z.toFixed(3)),
            },
            radius: Number(cylinder.params.radius.toFixed(3)),
            nearestAheadGap: Number(nearestAheadGap.toFixed(3)),
            sameLineDifferentRadius,
        });
    }

    return {
        file: basename(filePath),
        candidateCount: candidates.length,
        candidates,
    };
}

const root = resolve(process.cwd());
const dir = join(root, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');

const reports = [
    analyzeFile(join(dir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT')),
    analyzeFile(join(dir, 'nist_ftc_06_asme1_rd_sw1802.SLDPRT')),
    analyzeFile(
        join(dir, 'nist_ctc_04_asme1_rd_sw1802.SLDPRT'),
        (cylinder) => Math.abs(cylinder.params.radius - 3.325) < 0.05 &&
            Math.abs(cylinder.params.origin.z + 65) < 0.2 &&
            Math.abs(cylinder.params.axis.z + 1) < 0.01,
    ),
];

console.log(JSON.stringify(reports, null, 2));