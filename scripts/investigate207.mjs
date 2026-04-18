#!/usr/bin/env node
/**
 * investigate207.mjs
 *
 * Compare the FTC_07 profile skeleton components against the currently
 * recovered shallow 2-degree cone families from the production parser.
 *
 * Goal:
 * 1. Compute the XZ centroid of each profile skeleton component.
 * 2. Extract the recovered 2-degree cone family from parser.parse().
 * 3. Measure whether the cone centers cluster on those skeleton centroids.
 *
 * Usage:
 *   npm run build
 *   node scripts/investigate207.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SAMPLE_PATH = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ftc_07_asme1_rd_sw1802.SLDPRT',
);
const parserModulePath = path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js');
const containerModulePath = path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js');

if (!fs.existsSync(parserModulePath) || !fs.existsSync(containerModulePath)) {
    throw new Error('Build output not found. Run "npm run build" before investigate207.mjs.');
}
if (!fs.existsSync(SAMPLE_PATH)) {
    throw new Error(`FTC_07 sample not found at ${SAMPLE_PATH}`);
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { SldprtContainerParser } = await import(pathToFileURL(containerModulePath).href);

function formatNumber(value) {
    return Number(value.toFixed(6));
}

function formatPoint(point) {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

function lateralDistanceXZ(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

function normalize(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return {
        x: vector.x / length,
        y: vector.y / length,
        z: vector.z / length,
    };
}

const extracted = SldprtContainerParser.extractParasolid(fs.readFileSync(SAMPLE_PATH));
if (!extracted) {
    throw new Error('Failed to extract FTC_07 Parasolid stream.');
}

const parser = new ParasolidParser(extracted.data);
const components = parser.parseProfileSkeletonComponents().map((component) => {
    const centroid = component.vertexPoints.reduce((acc, point) => {
        acc.x += point.x;
        acc.y += point.y;
        acc.z += point.z;
        return acc;
    }, { x: 0, y: 0, z: 0 });
    centroid.x /= component.vertexPoints.length || 1;
    centroid.y /= component.vertexPoints.length || 1;
    centroid.z /= component.vertexPoints.length || 1;
    return {
        ...component,
        centroid,
    };
});

const model = new ParasolidParser(extracted.data).parse();
const targetHalfAngle = 2 * Math.PI / 180;
const shallowCones = model.surfaces
    .filter((surface) => surface.surfaceType === 'cone')
    .map((surface) => ({
        params: surface.params,
        axis: normalize(surface.params.axis),
    }))
    .filter(({ params, axis }) => {
        return Math.abs(Math.abs(axis.y) - 1) < 1e-3 &&
            Math.abs(axis.x) < 1e-3 &&
            Math.abs(axis.z) < 1e-3 &&
            Math.abs(Math.abs(params.halfAngle) - targetHalfAngle) < 0.02 &&
            params.origin.y > 0 &&
            params.origin.y < 30 &&
            params.radius > 5 &&
            params.radius < 15;
    })
    .map(({ params, axis }) => ({
        origin: params.origin,
        axis,
        radius: params.radius,
        halfAngle: params.halfAngle,
    }));

console.log(`profileSkeletonComponents=${components.length}`);
for (const component of components) {
    console.log(`component segments=[${component.segmentIds.join(',')}] closed=${component.closed} closureWrapper=${component.closureWrapperId ?? 'none'}`);
    console.log(`  centroid=${formatPoint(component.centroid)}`);

    const matches = shallowCones
        .map((cone) => ({
            cone,
            lateral: lateralDistanceXZ(component.centroid, cone.origin),
        }))
        .filter(({ lateral }) => lateral < 5)
        .sort((left, right) => left.lateral - right.lateral);

    console.log(`  matchedShallowCones=${matches.length}`);
    for (const { cone, lateral } of matches) {
        console.log(
            `    lateral=${formatNumber(lateral)} origin=${formatPoint(cone.origin)} axis=${formatPoint(cone.axis)} radius=${formatNumber(cone.radius)} halfAngle=${formatNumber(cone.halfAngle)}`,
        );
    }
}

const grouped = new Map();
for (const cone of shallowCones) {
    const key = `${cone.origin.x.toFixed(3)}|${cone.origin.z.toFixed(3)}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(cone);
    grouped.set(key, bucket);
}

console.log(`shallowConeCenters=${grouped.size}`);
for (const [key, bucket] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const centroid = {
        x: bucket.reduce((sum, cone) => sum + cone.origin.x, 0) / bucket.length,
        y: bucket.reduce((sum, cone) => sum + cone.origin.y, 0) / bucket.length,
        z: bucket.reduce((sum, cone) => sum + cone.origin.z, 0) / bucket.length,
    };
    console.log(`center ${key} count=${bucket.length} centroid=${formatPoint(centroid)}`);
}