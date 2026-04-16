#!/usr/bin/env node
/**
 * investigate166.mjs
 *
 * Benchmark a selective convex-hull fallback for self-intersecting planar
 * boundary polygons against the real conversion pipeline by monkeypatching
 * ParasolidParser.buildPlaneBoundaryClusters in-process.
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate166.mjs
 *   node scripts/investigate166.mjs ctc_01 ctc_02
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareStepFiles } from './compare-step.mjs';

const ROOT = process.cwd();
const SAMPLE_DIR = path.join(
    ROOT,
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
);
const CTC_REF_DIR = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions');
const FTC_REF_DIR = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'FTC Definitions');

const parserModulePath = path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js');
const convertModulePath = path.join(ROOT, 'dist', 'step', 'convertSldprtToStep.js');
if (!fs.existsSync(parserModulePath) || !fs.existsSync(convertModulePath)) {
    throw new Error('Build output not found. Run "npm run build" before investigate166.mjs.');
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { convertSldprtToStep } = await import(pathToFileURL(convertModulePath).href);

const filters = process.argv.slice(2).map((value) => value.toLowerCase());

function listSamplePaths() {
    const names = fs.readdirSync(SAMPLE_DIR)
        .filter((name) => name.toLowerCase().endsWith('.sldprt'))
        .sort((left, right) => left.localeCompare(right));
    if (filters.length === 0) return names.map((name) => path.join(SAMPLE_DIR, name));
    return names
        .filter((name) => filters.some((value) => name.toLowerCase().includes(value)))
        .map((name) => path.join(SAMPLE_DIR, name));
}

function resolveReferencePath(sampleName) {
    const refName = sampleName.replace(/_sw1802\.sldprt$/i, '.stp');
    const refDir = sampleName.includes('_ctc_') ? CTC_REF_DIR : FTC_REF_DIR;
    return path.join(refDir, refName);
}

function orientation(a, b, c) {
    const value = (b.v - a.v) * (c.u - b.u) - (b.u - a.u) * (c.v - b.v);
    if (Math.abs(value) < 1e-9) return 0;
    return value > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
    return b.u <= Math.max(a.u, c.u) + 1e-9 && b.u + 1e-9 >= Math.min(a.u, c.u)
        && b.v <= Math.max(a.v, c.v) + 1e-9 && b.v + 1e-9 >= Math.min(a.v, c.v);
}

function segmentsIntersect(a1, a2, b1, b2) {
    const o1 = orientation(a1, a2, b1);
    const o2 = orientation(a1, a2, b2);
    const o3 = orientation(b1, b2, a1);
    const o4 = orientation(b1, b2, a2);

    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(a1, b1, a2)) return true;
    if (o2 === 0 && onSegment(a1, b2, a2)) return true;
    if (o3 === 0 && onSegment(b1, a1, b2)) return true;
    if (o4 === 0 && onSegment(b1, a2, b2)) return true;
    return false;
}

function polygonSelfIntersects(points) {
    if (points.length < 4) return false;
    for (let i = 0; i < points.length; i++) {
        const a1 = points[i];
        const a2 = points[(i + 1) % points.length];
        for (let j = i + 1; j < points.length; j++) {
            const b1 = points[j];
            const b2 = points[(j + 1) % points.length];
            if (i === j) continue;
            if ((i + 1) % points.length === j) continue;
            if (i === (j + 1) % points.length) continue;
            if (i === 0 && (j + 1) % points.length === 0) continue;
            if (segmentsIntersect(a1, a2, b1, b2)) return true;
        }
    }
    return false;
}

function buildSelectiveHullClusterer() {
    return function buildPlaneBoundaryClusters(origin, normal, assocIndices, vertices) {
        if (assocIndices.length < 3) return [];

        const { uAxis, vAxis } = ParasolidParser.planeBasis(normal);
        const pts2D = assocIndices.map((index) => {
            const vertex = vertices[index].position;
            const dx = vertex.x - origin.x;
            const dy = vertex.y - origin.y;
            const dz = vertex.z - origin.z;
            return {
                u: dx * uAxis.x + dy * uAxis.y + dz * uAxis.z,
                v: dx * vAxis.x + dy * vAxis.y + dz * vAxis.z,
                idx: index,
            };
        });

        let uMin = Infinity;
        let uMax = -Infinity;
        let vMin = Infinity;
        let vMax = -Infinity;
        for (const point of pts2D) {
            if (point.u < uMin) uMin = point.u;
            if (point.u > uMax) uMax = point.u;
            if (point.v < vMin) vMin = point.v;
            if (point.v > vMax) vMax = point.v;
        }

        const bboxDiag = Math.sqrt((uMax - uMin) ** 2 + (vMax - vMin) ** 2);
        const clusterThreshold = Math.max(60, bboxDiag / 3);
        const clusters = ParasolidParser.clusterPoints2D(pts2D, clusterThreshold);

        return clusters
            .map((cluster) => {
                if (cluster.length < 3) return [];
                const centroidU = cluster.reduce((sum, point) => sum + point.u, 0) / cluster.length;
                const centroidV = cluster.reduce((sum, point) => sum + point.v, 0) / cluster.length;
                const ordered = cluster.slice().sort((left, right) => {
                    return Math.atan2(left.v - centroidV, left.u - centroidU)
                        - Math.atan2(right.v - centroidV, right.u - centroidU);
                });
                if (!polygonSelfIntersects(ordered)) return ordered;
                return ParasolidParser.convexHull2D(cluster);
            })
            .filter((cluster) => cluster.length >= 3);
    };
}

function summarize(compare) {
    return {
        overall: Number(compare.overall),
        planes: compare.scores.Planes,
        cylinders: compare.scores.Cylinders,
        faces: compare.scores.Faces,
        holesExact: compare.scores.HolesExact,
        innerLoops: compare.scores.InnerLoops,
        circles: compare.scores.Circles,
    };
}

const samplePaths = listSamplePaths();
if (samplePaths.length === 0) {
    throw new Error(`No matching samples under ${SAMPLE_DIR}`);
}

const originalClusterer = ParasolidParser.prototype.buildPlaneBoundaryClusters;
const selectiveHullClusterer = buildSelectiveHullClusterer();
const reports = [];

for (const samplePath of samplePaths) {
    const sampleName = path.basename(samplePath);
    const sampleBuffer = fs.readFileSync(samplePath);
    const refPath = resolveReferencePath(sampleName);
    const refText = fs.readFileSync(refPath, 'utf8');

    ParasolidParser.prototype.buildPlaneBoundaryClusters = originalClusterer;
    const baseline = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
    if (!baseline) throw new Error(`Baseline conversion failed for ${sampleName}`);
    const baselineCompare = compareStepFiles(baseline.step, refText, sampleName, path.basename(refPath));

    ParasolidParser.prototype.buildPlaneBoundaryClusters = selectiveHullClusterer;
    const selectiveHull = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
    if (!selectiveHull) throw new Error(`Selective-hull conversion failed for ${sampleName}`);
    const selectiveCompare = compareStepFiles(selectiveHull.step, refText, sampleName, path.basename(refPath));

    reports.push({
        file: sampleName,
        baseline: summarize(baselineCompare),
        selectiveHull: summarize(selectiveCompare),
        delta: {
            overall: Number(selectiveCompare.overall) - Number(baselineCompare.overall),
            planesMatched: selectiveCompare.scores.Planes.matched - baselineCompare.scores.Planes.matched,
            cylindersMatched: selectiveCompare.scores.Cylinders.matched - baselineCompare.scores.Cylinders.matched,
            facesMatched: selectiveCompare.scores.Faces.matched - baselineCompare.scores.Faces.matched,
            holesMatched: selectiveCompare.scores.HolesExact.matched - baselineCompare.scores.HolesExact.matched,
            innerLoopsMatched: selectiveCompare.scores.InnerLoops.matched - baselineCompare.scores.InnerLoops.matched,
            circlesMatched: selectiveCompare.scores.Circles.matched - baselineCompare.scores.Circles.matched,
        },
    });
}

ParasolidParser.prototype.buildPlaneBoundaryClusters = originalClusterer;
console.log(JSON.stringify({ sampleCount: reports.length, filters, reports }, null, 2));