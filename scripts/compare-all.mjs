#!/usr/bin/env node
/**
 * compare-all.mjs — Compare all generated STEP files against references.
 *
 * Output:
 *   1. Summary table — one row per file, columns for each score metric + overall
 *   2. Full detailed comparison for each file below the table
 *
 * Usage:  node scripts/compare-all.mjs
 *         npm run compare-all
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareStepFiles, SCORE_WEIGHTS } from './compare-step.mjs';

const OUTPUT_DIR = path.resolve('output');
const REF_CTC = path.resolve('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/CTC Definitions');
const REF_FTC = path.resolve('downloads/nist/NIST-FTC-CTC-PMI-CAD-models/FTC Definitions');

// Collect all gen ↔ ref pairs
const genFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.stp')).sort();
const pairs = [];
for (const genFile of genFiles) {
    const match = genFile.match(/^(nist_(?:ctc|ftc)_\d+_asme1_r[a-z])_sw\d+\.stp$/);
    if (!match) continue;
    const refBase = match[1] + '.stp';
    const isCtc = genFile.startsWith('nist_ctc');
    const refDir = isCtc ? REF_CTC : REF_FTC;
    const refPath = path.join(refDir, refBase);
    const genPath = path.join(OUTPUT_DIR, genFile);
    if (!fs.existsSync(refPath)) { console.log(`Skipping ${genFile} — no reference`); continue; }
    pairs.push({ genFile, refBase, genPath, refPath });
}

// Run all comparisons
const results = [];
for (const { genFile, refBase, genPath, refPath } of pairs) {
    const genText = fs.readFileSync(genPath, 'utf8');
    const refText = fs.readFileSync(refPath, 'utf8');
    const result = compareStepFiles(genText, refText, genFile, refBase);
    results.push({ genFile, refBase, ...result });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SUMMARY TABLE
// ═══════════════════════════════════════════════════════════════════════════════

const scoreKeys = Object.keys(SCORE_WEIGHTS); // Planes, Cylinders, Cones, Faces, HolesExact, InnerLoops, Vertices, Circles

// Column widths
const nameW = 18;
const colW = 10;
const sepChar = '─';

// Short label for file: nist_ctc_01_asme1_rd_sw1802.stp → CTC_01
function shortName(f) {
    const m = f.match(/nist_(ctc|ftc)_(\d+)/);
    return m ? `${m[1].toUpperCase()}_${m[2]}` : f.slice(0, nameW);
}

// Format percentage cell with matched/total
function fmtCell(data) {
    if (!data) return '  —  '.padStart(colW);
    return `${data.pct.toFixed(0)}%`.padStart(colW);
}

// Format matched/total below the percentage
function fmtRatio(data) {
    if (!data) return ''.padStart(colW);
    return `${data.matched}/${data.total}`.padStart(colW);
}

console.log('\n' + '═'.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));
console.log('  STEP COMPARISON — ALL FILES SUMMARY');
console.log('═'.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));

// Header row
const hdrCols = scoreKeys.map(k => k.padStart(colW)).join(' ');
console.log(`${'File'.padEnd(nameW)}  ${hdrCols} ${'OVERALL'.padStart(colW)}`);
console.log(sepChar.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));

// Accumulators for averages
const sums = {};
const counts = {};
for (const k of scoreKeys) { sums[k] = 0; counts[k] = 0; }
let overallSum = 0;

// Data rows
for (const r of results) {
    const name = shortName(r.genFile).padEnd(nameW);
    const cells = scoreKeys.map(k => {
        const d = r.scores[k];
        if (d) { sums[k] += d.pct; counts[k]++; }
        return fmtCell(d);
    }).join(' ');
    overallSum += parseFloat(r.overall);
    console.log(`${name}  ${cells} ${(r.overall + '%').padStart(colW)}`);
}

// Ratio rows (matched/total)
console.log(sepChar.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));
for (const r of results) {
    const name = shortName(r.genFile).padEnd(nameW);
    const cells = scoreKeys.map(k => fmtRatio(r.scores[k])).join(' ');
    console.log(`${name}  ${cells}`);
}

// Average row
console.log(sepChar.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));
const avgCells = scoreKeys.map(k => {
    const avg = counts[k] > 0 ? sums[k] / counts[k] : 0;
    return `${avg.toFixed(1)}%`.padStart(colW);
}).join(' ');
const avgOverall = results.length > 0 ? (overallSum / results.length).toFixed(1) : '0.0';
console.log(`${'AVERAGE'.padEnd(nameW)}  ${avgCells} ${(avgOverall + '%').padStart(colW)}`);
console.log('═'.repeat(nameW + 2 + (colW + 1) * (scoreKeys.length + 1)));

// ═══════════════════════════════════════════════════════════════════════════════
//  DETAILED OUTPUT PER FILE
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n\n');
for (const r of results) {
    console.log('╔' + '═'.repeat(70) + '╗');
    console.log(`║  ${r.genFile}  ↔  ${r.refBase}`.padEnd(71) + '║');
    console.log('╚' + '═'.repeat(70) + '╝');
    console.log(r.output);
    console.log('\n');
}
