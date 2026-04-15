#!/usr/bin/env node
/**
 * investigate132.mjs — Compare direct-drill-tip candidate metrics across
 * CTC_01, FTC_06, and CTC_04.
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

function analyzeFile(filePath) {
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
        const sameLineSameRadius = [];
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
            sameLineSameRadius.push({ id: other.id, gap: Number(gap.toFixed(3)) });
        }

        const qualifyingAhead = sameLineSameRadius
            .filter(({ gap }) => gap >= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MIN &&
                gap <= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MAX)
            .sort((left, right) => left.gap - right.gap);
        if (qualifyingAhead.length === 0) continue;

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
            zeroSupportSameRadiusCount: sameLineSameRadius.length,
            qualifyingAheadCount: qualifyingAhead.length,
            nearestAheadGap: qualifyingAhead[0].gap,
            sameLineGaps: sameLineSameRadius.map(({ gap }) => gap).sort((left, right) => left - right),
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
const files = [
    join(dir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'),
    join(dir, 'nist_ftc_06_asme1_rd_sw1802.SLDPRT'),
    join(dir, 'nist_ctc_04_asme1_rd_sw1802.SLDPRT'),
];

console.log(JSON.stringify(files.map(analyzeFile), null, 2));