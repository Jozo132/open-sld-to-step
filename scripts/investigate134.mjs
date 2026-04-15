#!/usr/bin/env node
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

const root = resolve(process.cwd());
const filePath = join(root, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018', 'nist_ctc_02_asme1_rc_sw1802.SLDPRT');
const buffer = readFileSync(filePath);
const extraction = SldprtContainerParser.extractParasolid(buffer);
if (!extraction) throw new Error('Failed to extract Parasolid payload');

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
    const sameLineDifferentRadius = [];
    for (const other of cylinders) {
        if (other.id === cylinder.id) continue;
        const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
        const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
        if (Math.abs(Math.abs(dot) - 1) > 0.02) continue;
        if (ParasolidParser.axisLineDistance(cylinder.params.origin, other.params.origin, axis) > ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) continue;

        const gap =
            (other.params.origin.x - cylinder.params.origin.x) * axis.x +
            (other.params.origin.y - cylinder.params.origin.y) * axis.y +
            (other.params.origin.z - cylinder.params.origin.z) * axis.z;

        if (Math.abs(other.params.radius - cylinder.params.radius) < ParasolidParser.CYL_RADIUS_TOL) {
            if (gap >= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MIN &&
                gap <= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MAX &&
                dot > 0.98 &&
                gap < nearestAheadGap) {
                nearestAheadGap = gap;
            }
            continue;
        }

        sameLineDifferentRadius.push({
            id: other.id,
            gap: Number(gap.toFixed(3)),
            radius: Number(other.params.radius.toFixed(3)),
            support: assoc.get(other.id)?.length ?? 0,
        });
    }

    if (!isFinite(nearestAheadGap)) continue;

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
        sameLineDifferentRadius: sameLineDifferentRadius
            .sort((left, right) => Math.abs(left.gap) - Math.abs(right.gap))
            .slice(0, 8),
    });
}

console.log(JSON.stringify(candidates, null, 2));