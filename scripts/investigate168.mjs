#!/usr/bin/env node
/**
 * investigate168.mjs
 *
 * Benchmark selective plane-hole support thresholds that only apply to larger
 * hole radii, using the real conversion pipeline via an in-process monkeypatch
 * of ParasolidParser.collectPlaneHoleCandidates.
 *
 * Clean-room analysis of public-domain NIST test files.
 *
 * Usage:
 *   node scripts/investigate168.mjs
 *   node scripts/investigate168.mjs ctc_02 ctc_04 ftc_10
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
    throw new Error('Build output not found. Run "npm run build" before investigate168.mjs.');
}

const { ParasolidParser } = await import(pathToFileURL(parserModulePath).href);
const { convertSldprtToStep } = await import(pathToFileURL(convertModulePath).href);

const filters = process.argv.slice(2).map((value) => value.toLowerCase());
const VARIANTS = [
    { id: 'support4_r5', minSupport: 4, radiusMin: 5 },
    { id: 'support4_r8', minSupport: 4, radiusMin: 8 },
    { id: 'support4_r10', minSupport: 4, radiusMin: 10 },
    { id: 'support4_r12', minSupport: 4, radiusMin: 12 },
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

function summarize(compare) {
    return {
        overall: Number(compare.overall),
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

const originalCollect = ParasolidParser.prototype.collectPlaneHoleCandidates;
const reports = [];

for (const samplePath of samplePaths) {
    const sampleName = path.basename(samplePath);
    const sampleBuffer = fs.readFileSync(samplePath);
    const refPath = resolveReferencePath(sampleName);
    const refText = fs.readFileSync(refPath, 'utf8');

    ParasolidParser.prototype.collectPlaneHoleCandidates = originalCollect;
    const baseline = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
    if (!baseline) throw new Error(`Baseline conversion failed for ${sampleName}`);
    const baselineCompare = compareStepFiles(baseline.step, refText, sampleName, path.basename(refPath));

    const variants = [];
    for (const variant of VARIANTS) {
        ParasolidParser.prototype.collectPlaneHoleCandidates = function patchedCollect(...args) {
            const candidates = originalCollect.apply(this, args);
            return candidates.filter((candidate) => {
                if (candidate.radius < variant.radiusMin) return true;
                return candidate.support >= variant.minSupport;
            });
        };
        const generated = convertSldprtToStep(sampleBuffer, sampleName.replace(/\.SLDPRT$/i, '.stp'));
        if (!generated) throw new Error(`${variant.id} conversion failed for ${sampleName}`);
        const compared = compareStepFiles(generated.step, refText, sampleName, path.basename(refPath));
        variants.push({
            id: variant.id,
            ...summarize(compared),
            delta: {
                overall: Number(compared.overall) - Number(baselineCompare.overall),
                facesMatched: compared.scores.Faces.matched - baselineCompare.scores.Faces.matched,
                holesMatched: compared.scores.HolesExact.matched - baselineCompare.scores.HolesExact.matched,
                innerLoopsMatched: compared.scores.InnerLoops.matched - baselineCompare.scores.InnerLoops.matched,
                circlesMatched: compared.scores.Circles.matched - baselineCompare.scores.Circles.matched,
            },
        });
    }

    reports.push({
        file: sampleName,
        baseline: summarize(baselineCompare),
        variants,
    });
}

ParasolidParser.prototype.collectPlaneHoleCandidates = originalCollect;
console.log(JSON.stringify({ sampleCount: reports.length, filters, reports }, null, 2));