#!/usr/bin/env node
/**
 * investigate162.mjs
 *
 * Benchmark a narrow 45-degree-only plane inference bank against the real
 * conversion pipeline by monkeypatching ParasolidParser.inferPlanesFromVertices
 * in-process, then scoring the generated STEP with compare-step.mjs.
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate162.mjs
 *   node scripts/investigate162.mjs ctc_01 ftc_07 ftc_08
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
    throw new Error('Build output not found. Run "npm run build" before investigate162.mjs.');
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

function normalizeDirection(direction) {
    const mag = Math.hypot(direction.x, direction.y, direction.z);
    if (mag < 1e-12) return null;
    const unit = { x: direction.x / mag, y: direction.y / mag, z: direction.z / mag };
    for (const component of [unit.x, unit.y, unit.z]) {
        if (Math.abs(component) < 1e-9) continue;
        if (component < 0) {
            return { x: -unit.x, y: -unit.y, z: -unit.z };
        }
        break;
    }
    return unit;
}

function addUniqueNormal(target, normal, dotMin = 0.999) {
    for (const existing of target) {
        const dot = Math.abs(existing.x * normal.x + existing.y * normal.y + existing.z * normal.z);
        if (dot > dotMin) return false;
    }
    target.push(normal);
    return true;
}

function diagonal45Normals() {
    const result = [];
    for (const direction of [
        { x: 1, y: 1, z: 0 },
        { x: 1, y: -1, z: 0 },
        { x: 1, y: 0, z: 1 },
        { x: 1, y: 0, z: -1 },
        { x: 0, y: 1, z: 1 },
        { x: 0, y: 1, z: -1 },
    ]) {
        const normal = normalizeDirection(direction);
        if (normal) addUniqueNormal(result, normal);
    }
    return result;
}

function inferWith45DegreeBank(vertices, existingSurfaces) {
    if (vertices.length < 3) return [];

    const axisNormals = [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
    ];
    const extractedNormals = [];
    for (const surface of existingSurfaces) {
        if (surface.surfaceType !== 'plane') continue;
        const n = surface.params.normal;
        if ((Math.abs(n.x) > 0.99) || (Math.abs(n.y) > 0.99) || (Math.abs(n.z) > 0.99)) continue;
        addUniqueNormal(extractedNormals, { x: n.x, y: n.y, z: n.z });
    }
    for (const normal of diagonal45Normals()) addUniqueNormal(extractedNormals, normal);

    const existingPlaneEqs = [];
    for (const surface of existingSurfaces) {
        if (surface.surfaceType !== 'plane') continue;
        const params = surface.params;
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
            const start = cursor;
            const d0 = projections[cursor].d;
            while (cursor < projections.length && projections[cursor].d - d0 < 0.1) cursor++;

            const clusterSize = cursor - start;
            if (clusterSize < minVerts) continue;

            const { uAxis, vAxis } = ParasolidParser.planeBasis(normal);
            let uMin = Infinity;
            let uMax = -Infinity;
            let vMin = Infinity;
            let vMax = -Infinity;
            let dSum = 0;
            for (let index = start; index < cursor; index++) {
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
            let alreadyExists = false;
            for (const eq of existingPlaneEqs) {
                const dot = Math.abs(eq.normal.x * normal.x + eq.normal.y * normal.y + eq.normal.z * normal.z);
                if (dot < 0.99) continue;
                const sign = (eq.normal.x * normal.x + eq.normal.y * normal.y + eq.normal.z * normal.z) > 0 ? 1 : -1;
                if (Math.abs(dAvg - sign * eq.d) < 1.0) {
                    alreadyExists = true;
                    break;
                }
            }
            if (alreadyExists) continue;

            for (const surface of inferred) {
                const ip = surface.params;
                const dot = Math.abs(ip.normal.x * normal.x + ip.normal.y * normal.y + ip.normal.z * normal.z);
                if (dot < 0.99) continue;
                const infD = ip.origin.x * ip.normal.x + ip.origin.y * ip.normal.y + ip.origin.z * ip.normal.z;
                const sign = (ip.normal.x * normal.x + ip.normal.y * normal.y + ip.normal.z * normal.z) > 0 ? 1 : -1;
                if (Math.abs(dAvg - sign * infD) < 1.0) {
                    alreadyExists = true;
                    break;
                }
            }
            if (alreadyExists) continue;

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
    const refPath = resolveReferencePath(sampleName);
    const refText = fs.readFileSync(refPath, 'utf8');

    ParasolidParser.prototype.inferPlanesFromVertices = originalInfer;
    const baseline = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
    if (!baseline) throw new Error(`Baseline conversion failed for ${sampleName}`);
    const baselineCompare = compareStepFiles(baseline.step, refText, sampleName, path.basename(refPath));

    ParasolidParser.prototype.inferPlanesFromVertices = inferWith45DegreeBank;
    const diagonal45 = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
    if (!diagonal45) throw new Error(`45-degree conversion failed for ${sampleName}`);
    const diagonal45Compare = compareStepFiles(diagonal45.step, refText, sampleName, path.basename(refPath));

    reports.push({
        file: sampleName,
        baseline: {
            overall: Number(baselineCompare.overall),
            planes: baselineCompare.scores.Planes,
            cylinders: baselineCompare.scores.Cylinders,
            faces: baselineCompare.scores.Faces,
        },
        diagonal45: {
            overall: Number(diagonal45Compare.overall),
            planes: diagonal45Compare.scores.Planes,
            cylinders: diagonal45Compare.scores.Cylinders,
            faces: diagonal45Compare.scores.Faces,
        },
        delta: {
            overall: Number(diagonal45Compare.overall) - Number(baselineCompare.overall),
            planesMatched: diagonal45Compare.scores.Planes.matched - baselineCompare.scores.Planes.matched,
            cylindersMatched: diagonal45Compare.scores.Cylinders.matched - baselineCompare.scores.Cylinders.matched,
            facesMatched: diagonal45Compare.scores.Faces.matched - baselineCompare.scores.Faces.matched,
        },
    });
}

ParasolidParser.prototype.inferPlanesFromVertices = originalInfer;
console.log(JSON.stringify({ sampleCount: reports.length, filters, reports }, null, 2));