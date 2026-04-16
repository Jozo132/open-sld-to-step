#!/usr/bin/env node
/**
 * investigate165.mjs
 *
 * Benchmark convex-hull plane boundary clusters against the real conversion
 * pipeline by monkeypatching ParasolidParser.buildPlaneBoundaryClusters
 * in-process, then scoring the generated STEP with compare-step.mjs.
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate165.mjs
 *   node scripts/investigate165.mjs ctc_02 ftc_07
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
    throw new Error('Build output not found. Run "npm run build" before investigate165.mjs.');
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

function buildHullClusterer() {
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
            .map((cluster) => ParasolidParser.convexHull2D(cluster))
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
const hullClusterer = buildHullClusterer();
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

    ParasolidParser.prototype.buildPlaneBoundaryClusters = hullClusterer;
    const hull = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
    if (!hull) throw new Error(`Convex-hull conversion failed for ${sampleName}`);
    const hullCompare = compareStepFiles(hull.step, refText, sampleName, path.basename(refPath));

    reports.push({
        file: sampleName,
        baseline: summarize(baselineCompare),
        convexHull: summarize(hullCompare),
        delta: {
            overall: Number(hullCompare.overall) - Number(baselineCompare.overall),
            planesMatched: hullCompare.scores.Planes.matched - baselineCompare.scores.Planes.matched,
            cylindersMatched: hullCompare.scores.Cylinders.matched - baselineCompare.scores.Cylinders.matched,
            facesMatched: hullCompare.scores.Faces.matched - baselineCompare.scores.Faces.matched,
            holesMatched: hullCompare.scores.HolesExact.matched - baselineCompare.scores.HolesExact.matched,
            innerLoopsMatched: hullCompare.scores.InnerLoops.matched - baselineCompare.scores.InnerLoops.matched,
            circlesMatched: hullCompare.scores.Circles.matched - baselineCompare.scores.Circles.matched,
        },
    });
}

ParasolidParser.prototype.buildPlaneBoundaryClusters = originalClusterer;
console.log(JSON.stringify({ sampleCount: reports.length, filters, reports }, null, 2));