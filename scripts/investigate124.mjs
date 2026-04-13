#!/usr/bin/env node
/**
 * investigate124.mjs — Audit the type-0x1E extraction path.
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate124.mjs
 *   node scripts/investigate124.mjs ftc_06 ctc_01
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

const ENTITY_0X1E = 0x1e;
const PS_TO_MM = 1000;
const VERTEX_PLANE_TOL = 0.5;
const VERTEX_CYL_TOL = 0.5;
const PLANE_EIGEN_RATIO_MAX = 2.5;

function findSldprtFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findSldprtFiles(fullPath));
        else if (/\.sldprt$/i.test(entry.name)) results.push(fullPath);
    }

    return results;
}

function normalizeDirection(dir) {
    const mag = Math.hypot(dir.x, dir.y, dir.z);
    if (mag < 1e-12) return { x: 0, y: 0, z: 1 };
    return { x: dir.x / mag, y: dir.y / mag, z: dir.z / mag };
}

function planeBasis(normal) {
    const arbitrary = Math.abs(normal.z) < 0.9
        ? { x: 0, y: 0, z: 1 }
        : { x: 1, y: 0, z: 0 };

    let ux = normal.y * arbitrary.z - normal.z * arbitrary.y;
    let uy = normal.z * arbitrary.x - normal.x * arbitrary.z;
    let uz = normal.x * arbitrary.y - normal.y * arbitrary.x;
    const uLen = Math.hypot(ux, uy, uz) || 1;
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;

    const vx = normal.y * uz - normal.z * uy;
    const vy = normal.z * ux - normal.x * uz;
    const vz = normal.x * uy - normal.y * ux;
    return {
        uAxis: { x: ux, y: uy, z: uz },
        vAxis: { x: vx, y: vy, z: vz },
    };
}

function computeEigenvalueRatio(points, normal) {
    if (points.length < 3) return null;

    const { uAxis, vAxis } = planeBasis(normal);
    const projected = points.map((point) => ({
        u: point.x * uAxis.x + point.y * uAxis.y + point.z * uAxis.z,
        v: point.x * vAxis.x + point.y * vAxis.y + point.z * vAxis.z,
    }));

    const meanU = projected.reduce((sum, point) => sum + point.u, 0) / projected.length;
    const meanV = projected.reduce((sum, point) => sum + point.v, 0) / projected.length;

    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const point of projected) {
        const du = point.u - meanU;
        const dv = point.v - meanV;
        sxx += du * du;
        sxy += du * dv;
        syy += dv * dv;
    }

    const inv = 1 / projected.length;
    sxx *= inv;
    sxy *= inv;
    syy *= inv;

    const trace = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const disc = Math.max(0, trace * trace - 4 * det);
    const sqrtDisc = Math.sqrt(disc);
    const lambda1 = (trace + sqrtDisc) / 2;
    const lambda2 = (trace - sqrtDisc) / 2;
    if (lambda2 < 1e-10) return Infinity;
    return lambda1 / lambda2;
}

function formatPoint(point, digits = 1) {
    return `(${point.x.toFixed(digits)}, ${point.y.toFixed(digits)}, ${point.z.toFixed(digits)})`;
}

function radiansToDegrees(angle) {
    return (angle * 180) / Math.PI;
}

function buildVertices(parser) {
    const points = parser.extractCoordinates();
    const vertices = points.map((point, index) => ({
        id: index + 1,
        position: {
            x: point.x * PS_TO_MM,
            y: point.y * PS_TO_MM,
            z: point.z * PS_TO_MM,
        },
    }));

    return ParasolidParser.filterOutlierVertices(vertices);
}

function classify0x1EPath(floats, markerByte) {
    if (!floats) return null;

    if (floats.length === 7 || floats.length === 8) {
        const normal = normalizeDirection({ x: floats[3], y: floats[4], z: floats[5] });
        const rawMag = Math.hypot(floats[3], floats[4], floats[5]);
        if (rawMag < 0.5 || rawMag > 1.5) return null;

        return {
            kind: 'plane-like',
            markerByte,
            floatLength: floats.length,
            origin: {
                x: floats[0] * PS_TO_MM,
                y: floats[1] * PS_TO_MM,
                z: floats[2] * PS_TO_MM,
            },
            normal,
        };
    }

    if (floats.length >= 11) {
        const axisMag = Math.hypot(floats[3], floats[4], floats[5]);
        const radius = floats[9];
        if (axisMag < 0.5 || axisMag > 1.5 || radius <= 0 || radius > 1e4) return null;

        const axis = {
            x: floats[3] / axisMag,
            y: floats[4] / axisMag,
            z: floats[5] / axisMag,
        };
        const halfAngle = floats[10];

        return {
            kind: Math.abs(halfAngle) < 1e-6 ? 'cylinder-like' : 'cone-like',
            markerByte,
            floatLength: floats.length,
            origin: {
                x: floats[0] * PS_TO_MM,
                y: floats[1] * PS_TO_MM,
                z: floats[2] * PS_TO_MM,
            },
            axis,
            radius: radius * PS_TO_MM,
            halfAngle,
        };
    }

    return null;
}

function planeSupport(vertices, origin, normal) {
    const support = [];
    for (const vertex of vertices) {
        const dx = vertex.position.x - origin.x;
        const dy = vertex.position.y - origin.y;
        const dz = vertex.position.z - origin.z;
        const dist = Math.abs(dx * normal.x + dy * normal.y + dz * normal.z);
        if (dist < VERTEX_PLANE_TOL) support.push(vertex.position);
    }

    const ratio = support.length >= 3 ? computeEigenvalueRatio(support, normal) : null;
    return {
        count: support.length,
        ratio,
        accepted: support.length >= 3 && ratio !== null && ratio <= PLANE_EIGEN_RATIO_MAX,
    };
}

function rotationalSupport(vertices, origin, axis, radius, halfAngle) {
    const matches = [];
    const tanHalfAngle = Math.tan(halfAngle);

    for (const vertex of vertices) {
        const dx = vertex.position.x - origin.x;
        const dy = vertex.position.y - origin.y;
        const dz = vertex.position.z - origin.z;
        const along = dx * axis.x + dy * axis.y + dz * axis.z;
        const expectedRadius = Math.abs(halfAngle) < 1e-6
            ? radius
            : radius + along * tanHalfAngle;
        if (expectedRadius < 0) continue;

        const px = dx - along * axis.x;
        const py = dy - along * axis.y;
        const pz = dz - along * axis.z;
        const radialDistance = Math.hypot(px, py, pz);
        if (Math.abs(radialDistance - expectedRadius) < VERTEX_CYL_TOL) {
            matches.push({ along, point: vertex.position });
        }
    }

    const minAlong = matches.length > 0
        ? Math.min(...matches.map((match) => match.along))
        : null;
    const maxAlong = matches.length > 0
        ? Math.max(...matches.map((match) => match.along))
        : null;

    return {
        count: matches.length,
        minAlong,
        maxAlong,
    };
}

function formatMarker(markerByte) {
    return `0x${markerByte.toString(16).padStart(2, '0')}`;
}

function printTopRecords(label, records, formatter, limit = 8) {
    console.log(`  ${label}:`);
    if (records.length === 0) {
        console.log('    (none)');
        return;
    }

    for (const record of records.slice(0, limit)) {
        console.log(`    ${formatter(record)}`);
    }
}

function analyzeFile(filePath) {
    const source = fs.readFileSync(filePath);
    const extracted = SldprtContainerParser.extractParasolid(source);
    if (!extracted) return null;

    const parser = new ParasolidParser(extracted.data);
    const vertices = buildVertices(parser);
    const entities = parser.extractAllEntities().filter((entity) => entity.type === ENTITY_0X1E);

    const summary = {
        entityCount: entities.length,
        noBestMarker: 0,
        planeLike: 0,
        planeAccepted: 0,
        planeRejected: 0,
        planeSparse: 0,
        cylinderLike: 0,
        coneLike: 0,
        multiMarkerEntities: 0,
        extraRotationalMarkers: 0,
        extraConeMarkers: 0,
    };

    const bestCones = [];
    const rejectedPlanes = [];
    const acceptedPlanes = [];
    const multiMarkerEntities = [];

    for (const entity of entities) {
        const best = ParasolidParser.readGeomFloats(entity.data);
        const allMarkers = ParasolidParser.readAllGeomMarkers(entity.data)
            .map((result) => ({
                marker: result.marker,
                floats: result.floats,
                classification: classify0x1EPath(result.floats, result.marker),
            }))
            .filter((entry) => entry.classification !== null);

        if (allMarkers.length > 1) {
            summary.multiMarkerEntities++;
            const rotational = allMarkers.filter((entry) => entry.classification.kind !== 'plane-like');
            if (rotational.length > 1) summary.extraRotationalMarkers += rotational.length - 1;
            const cones = rotational.filter((entry) => entry.classification.kind === 'cone-like');
            summary.extraConeMarkers += cones.length;
            multiMarkerEntities.push({
                id: entity.id,
                offset: entity.offset,
                markers: allMarkers.map((entry) => ({
                    kind: entry.classification.kind,
                    marker: formatMarker(entry.marker),
                    floatLength: entry.classification.floatLength,
                    radius: entry.classification.radius ?? null,
                    halfAngleDeg: entry.classification.halfAngle !== undefined
                        ? radiansToDegrees(entry.classification.halfAngle)
                        : null,
                })),
            });
        }

        if (!best) {
            summary.noBestMarker++;
            continue;
        }

        const classification = classify0x1EPath(best.floats, best.marker);
        if (!classification) {
            summary.noBestMarker++;
            continue;
        }

        if (classification.kind === 'plane-like') {
            summary.planeLike++;
            const support = planeSupport(vertices, classification.origin, classification.normal);
            const entry = {
                id: entity.id,
                offset: entity.offset,
                marker: formatMarker(classification.markerByte),
                floatLength: classification.floatLength,
                origin: classification.origin,
                normal: classification.normal,
                supportCount: support.count,
                ratio: support.ratio,
            };

            if (support.count < 3) {
                summary.planeSparse++;
            } else if (support.accepted) {
                summary.planeAccepted++;
                acceptedPlanes.push(entry);
            } else {
                summary.planeRejected++;
                rejectedPlanes.push(entry);
            }
            continue;
        }

        const support = rotationalSupport(
            vertices,
            classification.origin,
            classification.axis,
            classification.radius,
            classification.halfAngle ?? 0,
        );

        if (classification.kind === 'cylinder-like') {
            summary.cylinderLike++;
            continue;
        }

        summary.coneLike++;
        bestCones.push({
            id: entity.id,
            offset: entity.offset,
            marker: formatMarker(classification.markerByte),
            floatLength: classification.floatLength,
            origin: classification.origin,
            axis: classification.axis,
            radius: classification.radius,
            halfAngle: classification.halfAngle,
            supportCount: support.count,
            minAlong: support.minAlong,
            maxAlong: support.maxAlong,
        });
    }

    acceptedPlanes.sort((left, right) => {
        return right.supportCount - left.supportCount
            || (left.ratio ?? Infinity) - (right.ratio ?? Infinity)
            || left.id - right.id;
    });
    rejectedPlanes.sort((left, right) => {
        return right.supportCount - left.supportCount
            || (right.ratio ?? -Infinity) - (left.ratio ?? -Infinity)
            || left.id - right.id;
    });
    bestCones.sort((left, right) => {
        return right.supportCount - left.supportCount
            || Math.abs(right.halfAngle) - Math.abs(left.halfAngle)
            || left.id - right.id;
    });
    multiMarkerEntities.sort((left, right) => left.id - right.id);

    return {
        fileName: path.basename(filePath),
        vertexCount: vertices.length,
        summary,
        acceptedPlanes,
        rejectedPlanes,
        bestCones,
        multiMarkerEntities,
    };
}

const filters = process.argv.slice(2).map((value) => value.toLowerCase());
const sampleFiles = findSldprtFiles(SAMPLE_DIR)
    .filter((filePath) => {
        if (filters.length === 0) return true;
        const fileName = path.basename(filePath).toLowerCase();
        return filters.some((filter) => fileName.includes(filter));
    })
    .sort();

if (sampleFiles.length === 0) {
    console.log('No matching samples found. Run `npm run download-samples` first or pass a broader filter.');
    process.exit(1);
}

console.log('=== TYPE-0x1E PATH AUDIT ===');
console.log(`Samples: ${sampleFiles.length}`);
if (filters.length > 0) console.log(`Filters: ${filters.join(', ')}`);

for (const filePath of sampleFiles) {
    const analysis = analyzeFile(filePath);
    if (!analysis) continue;

    console.log(`\n${analysis.fileName}`);
    console.log(`  vertices=${analysis.vertexCount} 0x1E_entities=${analysis.summary.entityCount}`);
    console.log(
        '  bestPath:'
        + ` noMarker=${analysis.summary.noBestMarker}`
        + ` planeLike=${analysis.summary.planeLike}`
        + ` accepted=${analysis.summary.planeAccepted}`
        + ` rejected=${analysis.summary.planeRejected}`
        + ` sparse=${analysis.summary.planeSparse}`
        + ` cylinders=${analysis.summary.cylinderLike}`
        + ` cones=${analysis.summary.coneLike}`,
    );
    console.log(
        '  multiMarker:'
        + ` entities=${analysis.summary.multiMarkerEntities}`
        + ` extraRotationalMarkers=${analysis.summary.extraRotationalMarkers}`
        + ` extraConeMarkers=${analysis.summary.extraConeMarkers}`,
    );

    printTopRecords(
        'top accepted plane-like payloads',
        analysis.acceptedPlanes,
        (record) => `id=${record.id} off=${record.offset} marker=${record.marker} len=${record.floatLength} support=${record.supportCount} ratio=${record.ratio?.toFixed(3) ?? 'n/a'} origin=${formatPoint(record.origin)} normal=${formatPoint(record.normal, 3)}`,
    );
    printTopRecords(
        'top rejected line-like payloads',
        analysis.rejectedPlanes,
        (record) => `id=${record.id} off=${record.offset} marker=${record.marker} len=${record.floatLength} support=${record.supportCount} ratio=${record.ratio?.toFixed(3) ?? 'n/a'} origin=${formatPoint(record.origin)} normal=${formatPoint(record.normal, 3)}`,
    );
    printTopRecords(
        'top cone-like best markers',
        analysis.bestCones,
        (record) => `id=${record.id} off=${record.offset} marker=${record.marker} len=${record.floatLength} support=${record.supportCount} radius=${record.radius.toFixed(3)}mm halfAngle=${radiansToDegrees(record.halfAngle).toFixed(3)}deg span=${record.minAlong !== null ? `${record.minAlong.toFixed(3)}..${record.maxAlong.toFixed(3)}` : 'n/a'} origin=${formatPoint(record.origin)} axis=${formatPoint(record.axis, 3)}`,
    );
    printTopRecords(
        'multi-marker 0x1E entities',
        analysis.multiMarkerEntities,
        (record) => `id=${record.id} off=${record.offset} markers=${record.markers.map((marker) => `${marker.kind}@${marker.marker}/len${marker.floatLength}${marker.radius !== null ? `/r${marker.radius.toFixed(3)}` : ''}${marker.halfAngleDeg !== null ? `/a${marker.halfAngleDeg.toFixed(3)}` : ''}`).join(', ')}`,
    );
}