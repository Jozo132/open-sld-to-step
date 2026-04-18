#!/usr/bin/env node
/**
 * investigate208.mjs
 *
 * Measure whether the recovered FTC_07 shallow 2-degree cone centers lie at
 * the expected tangent radii from the recovered profile skeleton loops.
 *
 * Usage:
 *   npm run build
 *   node scripts/investigate208.mjs
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
    throw new Error('Build output not found. Run "npm run build" before investigate208.mjs.');
}
if (!fs.existsSync(SAMPLE_PATH)) {
    throw new Error(`FTC_07 sample not found at ${SAMPLE_PATH}`);
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { SldprtContainerParser } = await import(pathToFileURL(containerModulePath).href);

function formatNumber(value) {
    return Number(value.toFixed(6));
}

function distancePointToSegment2D(point, start, end) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq <= 1e-12) return Math.hypot(point.x - start.x, point.z - start.z);
    const t = ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSq;
    const clamped = Math.max(0, Math.min(1, t));
    const projX = start.x + clamped * dx;
    const projZ = start.z + clamped * dz;
    return Math.hypot(point.x - projX, point.z - projZ);
}

function minDistanceToLoop2D(point, vertices) {
    let best = Infinity;
    for (let index = 0; index < vertices.length; index++) {
        const start = vertices[index];
        const end = vertices[(index + 1) % vertices.length];
        best = Math.min(best, distancePointToSegment2D(point, start, end));
    }
    return best;
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
const components = parser.parseProfileSkeletonComponents()
    .map((component) => ({
        ...component,
        avgRadius: component.vertexPoints.reduce((sum, point) => sum + Math.hypot(point.x, point.z), 0) / component.vertexPoints.length,
    }))
    .sort((left, right) => right.avgRadius - left.avgRadius);

const model = new ParasolidParser(extracted.data).parse();
const targetHalfAngle = 2 * Math.PI / 180;
const centerMap = new Map();

for (const surface of model.surfaces) {
    if (surface.surfaceType !== 'cone') continue;
    const axis = normalize(surface.params.axis);
    if (Math.abs(Math.abs(axis.y) - 1) >= 1e-3 || Math.abs(axis.x) >= 1e-3 || Math.abs(axis.z) >= 1e-3) continue;
    if (Math.abs(Math.abs(surface.params.halfAngle) - targetHalfAngle) >= 0.02) continue;
    if (surface.params.origin.y <= 0 || surface.params.origin.y >= 30) continue;
    if (surface.params.radius <= 5 || surface.params.radius >= 15) continue;

    const key = `${surface.params.origin.x.toFixed(3)}|${surface.params.origin.z.toFixed(3)}`;
    const bucket = centerMap.get(key) ?? {
        origin: surface.params.origin,
        radii: [],
    };
    bucket.radii.push(surface.params.radius);
    centerMap.set(key, bucket);
}

console.log(`profileSkeletonComponents=${components.length}`);
components.forEach((component, index) => {
    console.log(`component[${index}] segments=[${component.segmentIds.join(',')}] avgRadius=${formatNumber(component.avgRadius)} closureWrapper=${component.closureWrapperId ?? 'none'}`);
});

console.log(`shallowConeCenters=${centerMap.size}`);
for (const center of [...centerMap.values()].sort((left, right) => {
    if (left.origin.x !== right.origin.x) return left.origin.x - right.origin.x;
    return left.origin.z - right.origin.z;
})) {
    const distances = components.map((component) => minDistanceToLoop2D(center.origin, component.vertexPoints));
    console.log(
        `center=(${formatNumber(center.origin.x)}, ${formatNumber(center.origin.z)}) radii=[${center.radii.map(formatNumber).join(', ')}] loopDistances=[${distances.map(formatNumber).join(', ')}]`,
    );
}