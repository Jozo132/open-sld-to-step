#!/usr/bin/env node
/**
 * investigate164.mjs
 *
 * Benchmark plane boundary clustering thresholds against the real conversion
 * pipeline by monkeypatching ParasolidParser.buildPlaneBoundaryClusters
 * in-process, then scoring the generated STEP with compare-step.mjs.
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate164.mjs
 *   node scripts/investigate164.mjs ctc_02 ftc_07
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
    throw new Error('Build output not found. Run "npm run build" before investigate164.mjs.');
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { convertSldprtToStep } = await import(pathToFileURL(convertModulePath).href);

const filters = process.argv.slice(2).map((value) => value.toLowerCase());

const VARIANTS = [
    {
        id: 'tighter_q4_min45',
        minThreshold: 45,
        divisor: 4,
    },
    {
        id: 'tighter_q5_min30',
        minThreshold: 30,
        divisor: 5,
    },
    {
        id: 'capped80_q4_min35',
        minThreshold: 35,
        divisor: 4,
        maxThreshold: 80,
    },
    {
        id: 'capped60_q5_min25',
        minThreshold: 25,
        divisor: 5,
        maxThreshold: 60,
    },
];

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

function buildClusterer({ minThreshold, divisor, maxThreshold = Infinity }) {
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
        const clusterThreshold = Math.min(maxThreshold, Math.max(minThreshold, bboxDiag / divisor));
        const clusters = ParasolidParser.clusterPoints2D(pts2D, clusterThreshold);

        return clusters
            .map((cluster) => {
                if (cluster.length < 3) return [];
                const centroidU = cluster.reduce((sum, point) => sum + point.u, 0) / cluster.length;
                const centroidV = cluster.reduce((sum, point) => sum + point.v, 0) / cluster.length;
                return cluster.slice().sort((left, right) => {
                    return Math.atan2(left.v - centroidV, left.u - centroidU)
                        - Math.atan2(right.v - centroidV, right.u - centroidU);
                });
            })
            .filter((cluster) => cluster.length >= 3);
    };
}

function summarize(compare) {
    return {
        overall: Number(compare.overall),
        planes: compare.scores.Planes,
        faces: compare.scores.Faces,
        holesExact: compare.scores.HolesExact,
        innerLoops: compare.scores.InnerLoops,
    };
}

const samplePaths = listSamplePaths();
if (samplePaths.length === 0) {
    throw new Error(`No matching samples under ${SAMPLE_DIR}`);
}

const originalClusterer = ParasolidParser.prototype.buildPlaneBoundaryClusters;
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

    const variants = [];
    for (const variant of VARIANTS) {
        ParasolidParser.prototype.buildPlaneBoundaryClusters = buildClusterer(variant);
        const generated = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
        if (!generated) throw new Error(`${variant.id} conversion failed for ${sampleName}`);
        const compared = compareStepFiles(generated.step, refText, sampleName, path.basename(refPath));
        variants.push({
            id: variant.id,
            ...summarize(compared),
            delta: {
                overall: Number(compared.overall) - Number(baselineCompare.overall),
                planesMatched: compared.scores.Planes.matched - baselineCompare.scores.Planes.matched,
                facesMatched: compared.scores.Faces.matched - baselineCompare.scores.Faces.matched,
                holesMatched: compared.scores.HolesExact.matched - baselineCompare.scores.HolesExact.matched,
                innerLoopsMatched: compared.scores.InnerLoops.matched - baselineCompare.scores.InnerLoops.matched,
            },
        });
    }

    reports.push({
        file: sampleName,
        baseline: summarize(baselineCompare),
        variants,
    });
}

ParasolidParser.prototype.buildPlaneBoundaryClusters = originalClusterer;
console.log(JSON.stringify({ sampleCount: reports.length, filters, reports }, null, 2));