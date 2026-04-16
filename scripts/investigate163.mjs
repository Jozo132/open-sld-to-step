#!/usr/bin/env node
/**
 * investigate163.mjs
 *
 * Benchmark a targeted inferPlanesFromVertices variation that only tightens the
 * duplicate check when an axis-aligned candidate plane is compared against a
 * non-axis validated plane. This tests whether near-axis 0x1E planes are
 * suppressing true axis planes without widening non-axis inference generally.
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate163.mjs
 *   node scripts/investigate163.mjs ctc_01 ftc_07 ftc_08
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareStepFiles } from './compare-step.mjs';

const ROOT = process.cwd();
const SAMPLE_DIR = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const CTC_REF_DIR = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions');
const FTC_REF_DIR = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'FTC Definitions');

const parserModulePath = path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js');
const convertModulePath = path.join(ROOT, 'dist', 'step', 'convertSldprtToStep.js');
if (!fs.existsSync(parserModulePath) || !fs.existsSync(convertModulePath)) {
    throw new Error('Build output not found. Run "npm run build" before investigate163.mjs.');
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { convertSldprtToStep } = await import(pathToFileURL(convertModulePath).href);

const filters = process.argv.slice(2).map((value) => value.toLowerCase());
const thresholdVariants = [0.999, 0.9995, 0.9999];

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

function isAxisAligned(normal) {
    return Math.abs(normal.x) > 0.99 || Math.abs(normal.y) > 0.99 || Math.abs(normal.z) > 0.99;
}

function createVariantInfer(axisVsNonAxisDotMin) {
    return function inferPlanesVariant(vertices, existingSurfaces) {
        if (vertices.length < 3) return [];

        const axisNormals = [
            { x: 1, y: 0, z: 0 },
            { x: 0, y: 1, z: 0 },
            { x: 0, y: 0, z: 1 },
        ];

        const extractedNormals = [];
        for (const surf of existingSurfaces) {
            if (surf.surfaceType !== 'plane') continue;
            const n = surf.params.normal;
            if ((Math.abs(n.x) > 0.99) || (Math.abs(n.y) > 0.99) || (Math.abs(n.z) > 0.99)) continue;
            let isDup = false;
            for (const existing of extractedNormals) {
                const dot = Math.abs(existing.x * n.x + existing.y * n.y + existing.z * n.z);
                if (dot > 0.999) { isDup = true; break; }
            }
            if (!isDup) extractedNormals.push({ x: n.x, y: n.y, z: n.z });
        }

        const existingPlaneEqs = [];
        for (const surf of existingSurfaces) {
            if (surf.surfaceType !== 'plane') continue;
            const params = surf.params;
            existingPlaneEqs.push({
                normal: params.normal,
                d: params.origin.x * params.normal.x + params.origin.y * params.normal.y + params.origin.z * params.normal.z,
            });
        }

        const inferred = [];
        let nextId = existingSurfaces.length + 1000;
        const allNormals = [
            ...axisNormals.map((normal) => ({ normal, minVerts: 3 })),
            ...extractedNormals.map((normal) => ({ normal, minVerts: 5 })),
        ];

        for (const { normal, minVerts } of allNormals) {
            const projections = vertices.map((vertex, idx) => ({
                idx,
                d: vertex.position.x * normal.x + vertex.position.y * normal.y + vertex.position.z * normal.z,
            })).sort((left, right) => left.d - right.d);

            let cursor = 0;
            while (cursor < projections.length) {
                const clusterStart = cursor;
                const d0 = projections[cursor].d;
                while (cursor < projections.length && projections[cursor].d - d0 < 0.1) cursor++;

                const clusterSize = cursor - clusterStart;
                if (clusterSize < minVerts) continue;

                const { uAxis, vAxis } = ParasolidParser.planeBasis(normal);
                let uMin = Infinity;
                let uMax = -Infinity;
                let vMin = Infinity;
                let vMax = -Infinity;
                let dSum = 0;
                for (let index = clusterStart; index < cursor; index++) {
                    const point = vertices[projections[index].idx].position;
                    const u = point.x * uAxis.x + point.y * uAxis.y + point.z * uAxis.z;
                    const v = point.x * vAxis.x + point.y * vAxis.y + point.z * vAxis.z;
                    if (u < uMin) uMin = u;
                    if (u > uMax) uMax = u;
                    if (v < vMin) vMin = v;
                    if (v > vMax) vMax = v;
                    dSum += projections[index].d;
                }
                if ((uMax - uMin) < 1.0 || (vMax - vMin) < 1.0) continue;

                const dAvg = dSum / clusterSize;
                const candidateIsAxis = isAxisAligned(normal);

                let alreadyExists = false;
                for (const eq of existingPlaneEqs) {
                    const signedDot = eq.normal.x * normal.x + eq.normal.y * normal.y + eq.normal.z * normal.z;
                    const dot = Math.abs(signedDot);
                    if (dot < 0.99) continue;
                    const eqIsAxis = isAxisAligned(eq.normal);
                    if (candidateIsAxis !== eqIsAxis && dot < axisVsNonAxisDotMin) continue;
                    const sign = signedDot > 0 ? 1 : -1;
                    if (Math.abs(dAvg - sign * eq.d) < 1.0) {
                        alreadyExists = true;
                        break;
                    }
                }
                if (alreadyExists) continue;

                let alreadyInferred = false;
                for (const inf of inferred) {
                    const ip = inf.params;
                    const signedDot = ip.normal.x * normal.x + ip.normal.y * normal.y + ip.normal.z * normal.z;
                    const dot = Math.abs(signedDot);
                    if (dot < 0.99) continue;
                    const infIsAxis = isAxisAligned(ip.normal);
                    if (candidateIsAxis !== infIsAxis && dot < axisVsNonAxisDotMin) continue;
                    const infD = ip.origin.x * ip.normal.x + ip.origin.y * ip.normal.y + ip.origin.z * ip.normal.z;
                    const sign = signedDot > 0 ? 1 : -1;
                    if (Math.abs(dAvg - sign * infD) < 1.0) {
                        alreadyInferred = true;
                        break;
                    }
                }
                if (alreadyInferred) continue;

                const planeNormal = dAvg >= 0
                    ? { x: normal.x, y: normal.y, z: normal.z }
                    : { x: -normal.x, y: -normal.y, z: -normal.z };
                const planeD = Math.abs(dAvg);
                inferred.push({
                    id: nextId++,
                    surfaceType: 'plane',
                    params: {
                        origin: {
                            x: planeNormal.x * planeD,
                            y: planeNormal.y * planeD,
                            z: planeNormal.z * planeD,
                        },
                        normal: planeNormal,
                    },
                });
            }
        }

        return inferred;
    };
}

function summarize(compare) {
    return {
        overall: Number(compare.overall),
        planes: compare.scores.Planes,
        cylinders: compare.scores.Cylinders,
        faces: compare.scores.Faces,
    };
}

const samplePaths = listSamplePaths();
if (samplePaths.length === 0) {
    throw new Error(`No matching samples under ${SAMPLE_DIR}`);
}

const originalInfer = ParasolidParser.prototype.inferPlanesFromVertices;
const reports = [];

for (const samplePath of samplePaths) {
    const sampleName = path.basename(samplePath);
    const sampleBuffer = fs.readFileSync(samplePath);
    const refText = fs.readFileSync(resolveReferencePath(sampleName), 'utf8');

    ParasolidParser.prototype.inferPlanesFromVertices = originalInfer;
    const baselineResult = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
    if (!baselineResult) throw new Error(`Baseline conversion failed for ${sampleName}`);
    const baselineCompare = compareStepFiles(baselineResult.step, refText, sampleName, sampleName);

    const variants = [];
    for (const threshold of thresholdVariants) {
        ParasolidParser.prototype.inferPlanesFromVertices = createVariantInfer(threshold);
        const variantResult = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
        if (!variantResult) throw new Error(`Variant conversion failed for ${sampleName}`);
        const variantCompare = compareStepFiles(variantResult.step, refText, sampleName, sampleName);
        variants.push({
            threshold,
            summary: summarize(variantCompare),
            delta: {
                overall: Number(variantCompare.overall) - Number(baselineCompare.overall),
                planesMatched: variantCompare.scores.Planes.matched - baselineCompare.scores.Planes.matched,
                cylindersMatched: variantCompare.scores.Cylinders.matched - baselineCompare.scores.Cylinders.matched,
                facesMatched: variantCompare.scores.Faces.matched - baselineCompare.scores.Faces.matched,
            },
        });
    }

    reports.push({
        file: sampleName,
        baseline: summarize(baselineCompare),
        variants,
    });
}

ParasolidParser.prototype.inferPlanesFromVertices = originalInfer;
console.log(JSON.stringify({ sampleCount: reports.length, filters, reports }, null, 2));