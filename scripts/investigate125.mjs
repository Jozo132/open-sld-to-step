#!/usr/bin/env node
/**
 * investigate125.mjs — Diagnose remaining 59-degree cone gaps in FTC_06/FTC_10.
 * Clean-room analysis of public-domain NIST test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href,
);

const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);
const REF_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'FTC Definitions',
);

const TARGETS = [
    {
        label: 'FTC_06',
        sldprt: 'nist_ftc_06_asme1_rd_sw1802.SLDPRT',
        ref: 'nist_ftc_06_asme1_rd.stp',
    },
    {
        label: 'FTC_10',
        sldprt: 'nist_ftc_10_asme1_rb_sw1802.SLDPRT',
        ref: 'nist_ftc_10_asme1_rb.stp',
    },
];

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function extractNumbers(args) {
    return [...args.matchAll(/-?\d+(?:\.\d+)?(?:E[+-]?\d+)?/gi)]
        .map((match) => Number(match[0]))
        .filter(Number.isFinite);
}

function parseEntities(stepText) {
    const entities = new Map();
    const normalized = stepText.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;

    const data = normalized.slice(dataStart + 5, dataEnd);
    const joined = data.replace(/\n(?!#\d+=)/g, '');
    const reLine = /^#(\d+)\s*=\s*(.+);$/gm;

    let match;
    while ((match = reLine.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();

        const complex = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complex) {
            const types = complex[1].split(',').map((part) => part.trim());
            entities.set(id, { type: types.sort().join(','), types, args: complex[2] });
            continue;
        }

        const simple = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simple) {
            entities.set(id, { type: simple[1], types: [simple[1]], args: simple[2] });
            continue;
        }

        entities.set(id, { type: '???', types: [], args: rest });
    }

    return entities;
}

function resolveAxisPlacement(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('AXIS2_PLACEMENT_3D')) return null;

    const refs = extractRefs(entity.args);
    const point = entities.get(refs[0]);
    const axis = entities.get(refs[1]);
    if (!point || !axis) return null;

    const pointNums = extractNumbers(point.args);
    const axisNums = extractNumbers(axis.args);
    if (pointNums.length < 3 || axisNums.length < 3) return null;

    return {
        origin: { x: pointNums.at(-3), y: pointNums.at(-2), z: pointNums.at(-1) },
        axis: normalizeDirection({ x: axisNums.at(-3), y: axisNums.at(-2), z: axisNums.at(-1) }),
    };
}

function collectReferenceCones(entities) {
    const cones = [];
    for (const [id, entity] of entities) {
        if (!entity.types.includes('CONICAL_SURFACE')) continue;
        const refs = extractRefs(entity.args);
        const nums = extractNumbers(entity.args);
        const placement = resolveAxisPlacement(entities, refs[0]);
        if (!placement || nums.length < 2) continue;
        cones.push({
            id,
            origin: placement.origin,
            axis: placement.axis,
            radius: nums.at(-2),
            halfAngle: nums.at(-1),
        });
    }
    return cones;
}

function normalizeDirection(direction) {
    const len = Math.hypot(direction.x, direction.y, direction.z);
    if (len < 1e-9) return { x: 0, y: 0, z: 1 };
    return { x: direction.x / len, y: direction.y / len, z: direction.z / len };
}

function canonicalAxis(direction) {
    const axis = normalizeDirection(direction);
    if (axis.x < 0 || (Math.abs(axis.x) < 1e-9 && axis.y < 0) || (Math.abs(axis.x) < 1e-9 && Math.abs(axis.y) < 1e-9 && axis.z < 0)) {
        return { x: -axis.x, y: -axis.y, z: -axis.z };
    }
    return axis;
}

function axisDifference(left, right) {
    const a = canonicalAxis(left);
    const b = canonicalAxis(right);
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function axisLineDistance(originA, originB, axis) {
    const dx = originA.x - originB.x;
    const dy = originA.y - originB.y;
    const dz = originA.z - originB.z;
    const along = dx * axis.x + dy * axis.y + dz * axis.z;
    const px = dx - along * axis.x;
    const py = dy - along * axis.y;
    const pz = dz - along * axis.z;
    return Math.hypot(px, py, pz);
}

function dotAlong(originA, originB, axis) {
    return (originB.x - originA.x) * axis.x
        + (originB.y - originA.y) * axis.y
        + (originB.z - originA.z) * axis.z;
}

function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function round(value, digits = 3) {
    return Number(value.toFixed(digits));
}

function formatPoint(point, digits = 2) {
    return `(${point.x.toFixed(digits)},${point.y.toFixed(digits)},${point.z.toFixed(digits)})`;
}

function formatAxis(axis) {
    return `(${axis.x.toFixed(3)},${axis.y.toFixed(3)},${axis.z.toFixed(3)})`;
}

function buildVertices(parser) {
    return parser.extractCoordinates().map((point, index) => ({
        id: index + 1,
        position: {
            x: point.x * 1000,
            y: point.y * 1000,
            z: point.z * 1000,
        },
    }));
}

function buildValidatedSurfaces(parser, vertices, extractedSurfaces) {
    const validated = [];
    for (const surface of extractedSurfaces) {
        if (surface.surfaceType !== 'plane') {
            validated.push(surface);
            continue;
        }

        const plane = surface.params;
        const coplanar = [];
        for (const vertex of vertices) {
            const dx = vertex.position.x - plane.origin.x;
            const dy = vertex.position.y - plane.origin.y;
            const dz = vertex.position.z - plane.origin.z;
            const dist = Math.abs(dx * plane.normal.x + dy * plane.normal.y + dz * plane.normal.z);
            if (dist < 0.5) coplanar.push(vertex.position);
        }
        if (coplanar.length < 3) continue;
        const ratio = ParasolidParser.computeEigenvalueRatio(coplanar, plane.normal);
        if (ratio <= 2.5) validated.push(surface);
    }

    return validated;
}

function buildParserState(parser) {
    const vertices = buildVertices(parser);
    const extractedSurfaces = parser.extractSurfaces();
    const validatedSurfaces = buildValidatedSurfaces(parser, vertices, extractedSurfaces);
    const inferVertices = ParasolidParser.filterOutlierVertices(vertices);
    const inferredPlanes = parser.inferPlanesFromVertices(inferVertices, validatedSurfaces);
    const mergedSurfaces = ParasolidParser.recoverAxisymmetricWasherSurfaces(
        [...validatedSurfaces, ...inferredPlanes],
        vertices,
    );
    const inferredCones = parser.inferApexConesFromCylinderPairs(mergedSurfaces, vertices);
    return { vertices, mergedSurfaces, inferredCones };
}

function getCylinderExtent(vertices, indices, origin, axis) {
    if (!indices || indices.length === 0) return null;
    const heights = indices.map((index) => {
        const vertex = vertices[index].position;
        const dx = vertex.x - origin.x;
        const dy = vertex.y - origin.y;
        const dz = vertex.z - origin.z;
        return dx * axis.x + dy * axis.y + dz * axis.z;
    });
    return { min: Math.min(...heights), max: Math.max(...heights) };
}

function matchCurrentCone(cone, inferredCones) {
    const targetAngle = cone.halfAngle;
    return inferredCones.some((surface) => {
        if (surface.surfaceType !== 'cone') return false;
        const params = surface.params;
        if (axisDifference(params.axis, cone.axis) > 0.05) return false;
        if (Math.abs(params.radius - cone.radius) > 0.2) return false;
        if (Math.abs(params.halfAngle - targetAngle) > 0.05) return false;
        return pointDistance(params.origin, cone.origin) <= 1.0;
    });
}

function buildPairCandidates(cone, nearby, vertices, assoc) {
    const pairs = [];
    const coneAxis = normalizeDirection(cone.axis);
    const targetAngleDeg = cone.halfAngle > Math.PI ? cone.halfAngle : cone.halfAngle * 180 / Math.PI;

    for (let i = 0; i < nearby.length; i++) {
        for (let j = i + 1; j < nearby.length; j++) {
            const a = nearby[i];
            const b = nearby[j];
            const smaller = a.params.radius <= b.params.radius ? a : b;
            const larger = a.params.radius <= b.params.radius ? b : a;
            const radiusDelta = larger.params.radius - smaller.params.radius;
            if (radiusDelta < 0.1) continue;

            const smallAxis = normalizeDirection(smaller.params.axis);
            const largeAxis = normalizeDirection(larger.params.axis);
            const dot = smallAxis.x * largeAxis.x + smallAxis.y * largeAxis.y + smallAxis.z * largeAxis.z;
            const axis = dot >= 0 ? smallAxis : { x: -smallAxis.x, y: -smallAxis.y, z: -smallAxis.z };

            const smallExtent = getCylinderExtent(vertices, assoc.get(smaller.id), smaller.params.origin, axis);
            const largeExtent = getCylinderExtent(vertices, assoc.get(larger.id), larger.params.origin, axis);

            const endPairs = [];
            if (smallExtent && largeExtent) {
                endPairs.push(
                    { hSmall: smallExtent.min, hLarge: largeExtent.min, mode: 'vertex-vertex' },
                    { hSmall: smallExtent.min, hLarge: largeExtent.max, mode: 'vertex-vertex' },
                    { hSmall: smallExtent.max, hLarge: largeExtent.min, mode: 'vertex-vertex' },
                    { hSmall: smallExtent.max, hLarge: largeExtent.max, mode: 'vertex-vertex' },
                );
            } else if (smallExtent && !largeExtent) {
                endPairs.push(
                    { hSmall: smallExtent.min, hLarge: dotAlong(smaller.params.origin, larger.params.origin, axis), mode: 'vertex-origin' },
                    { hSmall: smallExtent.max, hLarge: dotAlong(smaller.params.origin, larger.params.origin, axis), mode: 'vertex-origin' },
                );
            } else if (!smallExtent && largeExtent) {
                endPairs.push(
                    { hSmall: 0, hLarge: largeExtent.min - dotAlong(smaller.params.origin, larger.params.origin, axis), mode: 'origin-vertex' },
                    { hSmall: 0, hLarge: largeExtent.max - dotAlong(smaller.params.origin, larger.params.origin, axis), mode: 'origin-vertex' },
                );
            } else {
                endPairs.push({
                    hSmall: 0,
                    hLarge: dotAlong(smaller.params.origin, larger.params.origin, axis),
                    mode: 'origin-origin',
                });
            }

            for (const pair of endPairs) {
                const gap = Math.abs(pair.hLarge - pair.hSmall);
                if (gap < 0.1) continue;
                const angleDeg = Math.atan(radiusDelta / gap) * 180 / Math.PI;
                const smallCenter = {
                    x: smaller.params.origin.x + pair.hSmall * axis.x,
                    y: smaller.params.origin.y + pair.hSmall * axis.y,
                    z: smaller.params.origin.z + pair.hSmall * axis.z,
                };
                pairs.push({
                    smallId: smaller.id,
                    largeId: larger.id,
                    smallRadius: smaller.params.radius,
                    largeRadius: larger.params.radius,
                    smallAssoc: assoc.get(smaller.id)?.length ?? 0,
                    largeAssoc: assoc.get(larger.id)?.length ?? 0,
                    mode: pair.mode,
                    gap,
                    angleDeg,
                    angleError: Math.abs(angleDeg - targetAngleDeg),
                    originError: pointDistance(smallCenter, cone.origin),
                    lineError: axisLineDistance(smaller.params.origin, cone.origin, coneAxis),
                    smallCenter,
                    smallOrigin: smaller.params.origin,
                    largeOrigin: larger.params.origin,
                });
            }
        }
    }

    return pairs.sort((left, right) => {
        return left.angleError - right.angleError
            || left.originError - right.originError
            || left.gap - right.gap;
    });
}

for (const target of TARGETS) {
    const sldprtPath = path.join(SAMPLE_DIR, target.sldprt);
    const refPath = path.join(REF_DIR, target.ref);
    if (!fs.existsSync(sldprtPath) || !fs.existsSync(refPath)) {
        console.log(`${target.label}: missing sample files`);
        continue;
    }

    const extracted = SldprtContainerParser.extractParasolid(fs.readFileSync(sldprtPath));
    if (!extracted) {
        console.log(`${target.label}: failed to extract Parasolid`);
        continue;
    }

    const parser = new ParasolidParser(extracted.data);
    const { vertices, mergedSurfaces, inferredCones } = buildParserState(parser);
    const cylinders = mergedSurfaces.filter((surface) => surface.surfaceType === 'cylinder');
    const assoc = parser.associateVertices(cylinders, vertices);

    const refEntities = parseEntities(fs.readFileSync(refPath, 'utf8'));
    const unmatched59Cones = collectReferenceCones(refEntities)
        .filter((cone) => {
            const angleDeg = cone.halfAngle > Math.PI ? cone.halfAngle : cone.halfAngle * 180 / Math.PI;
            return Math.abs(angleDeg - 59) < 0.1 && !matchCurrentCone(cone, inferredCones);
        });

    console.log(`\n=== ${target.label} remaining 59-degree cones ===`);
    console.log(`cylinders=${cylinders.length} inferredCones=${inferredCones.length} unmatched59=${unmatched59Cones.length}`);

    for (const cone of unmatched59Cones) {
        console.log(`\nrefCone #${cone.id} axis=${formatAxis(cone.axis)} r=${cone.radius.toFixed(3)} origin=${formatPoint(cone.origin)}`);

        const nearby = cylinders.filter((cylinder) => {
            if (axisDifference(cylinder.params.axis, cone.axis) > 0.05) return false;
            if (axisLineDistance(cylinder.params.origin, cone.origin, normalizeDirection(cone.axis)) > 2.0) return false;
            const along = Math.abs(dotAlong(cone.origin, cylinder.params.origin, normalizeDirection(cone.axis)));
            return along <= 20;
        });

        console.log(`  nearby cylinders=${nearby.length}`);
        for (const cylinder of nearby) {
            const axis = normalizeDirection(cone.axis);
            const extent = getCylinderExtent(vertices, assoc.get(cylinder.id), cylinder.params.origin, axis);
            const along = dotAlong(cone.origin, cylinder.params.origin, axis);
            console.log(
                `    cyl #${cylinder.id} r=${cylinder.params.radius.toFixed(3)} origin=${formatPoint(cylinder.params.origin)}`
                + ` along=${along.toFixed(3)} assoc=${(assoc.get(cylinder.id)?.length ?? 0)}`
                + ` ext=${extent ? `[${extent.min.toFixed(3)},${extent.max.toFixed(3)}]` : 'none'}`,
            );
        }

        const candidates = buildPairCandidates(cone, nearby, vertices, assoc)
            .filter((candidate) => candidate.angleError <= 8 && candidate.originError <= 5)
            .slice(0, 10);

        console.log('  top pair candidates:');
        if (candidates.length === 0) {
            console.log('    none');
            continue;
        }

        for (const candidate of candidates) {
            console.log(
                `    ${candidate.mode} small=#${candidate.smallId} r=${candidate.smallRadius.toFixed(3)}`
                + ` large=#${candidate.largeId} r=${candidate.largeRadius.toFixed(3)}`
                + ` gap=${round(candidate.gap, 3).toFixed(3)} angle=${round(candidate.angleDeg, 3).toFixed(3)}`
                + ` angleErr=${round(candidate.angleError, 3).toFixed(3)}`
                + ` originErr=${round(candidate.originError, 3).toFixed(3)}`
                + ` smallAssoc=${candidate.smallAssoc} largeAssoc=${candidate.largeAssoc}`
                + ` smallCenter=${formatPoint(candidate.smallCenter)}`,
            );
        }
    }
}