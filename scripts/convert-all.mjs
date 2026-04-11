#!/usr/bin/env node
/**
 * convert-all.mjs — Batch-convert all SolidWorks .SLDPRT files to STEP.
 *
 * Usage:
 *   node scripts/convert-all.mjs                     # converts NIST samples
 *   node scripts/convert-all.mjs path/to/files/       # converts custom directory
 *   node scripts/convert-all.mjs file1.SLDPRT file2.SLDPRT  # converts specific files
 *
 * Output is written to ./output/ with the same base name + .stp extension.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Dynamic import of compiled library (pathToFileURL required on Windows)
const { convertSldprtToStep } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'step', 'convertSldprtToStep.js')).href
);

const OUTPUT_DIR = path.join(ROOT, 'output');
const DEFAULT_NIST = path.join(
    ROOT, 'downloads', 'nist',
    'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018',
);

// ── Resolve input files ─────────────────────────────────────────────────────

function collectSldprtFiles(args) {
    if (args.length === 0) {
        // Default: NIST samples
        if (!fs.existsSync(DEFAULT_NIST)) {
            console.error(`NIST sample directory not found: ${DEFAULT_NIST}`);
            console.error('Run: npm run download-samples');
            process.exit(1);
        }
        return fs.readdirSync(DEFAULT_NIST)
            .filter(f => /\.sldprt$/i.test(f))
            .map(f => path.join(DEFAULT_NIST, f));
    }

    const files = [];
    for (const arg of args) {
        const resolved = path.resolve(arg);
        if (fs.statSync(resolved).isDirectory()) {
            const dirFiles = fs.readdirSync(resolved)
                .filter(f => /\.sldprt$/i.test(f))
                .map(f => path.join(resolved, f));
            files.push(...dirFiles);
        } else {
            files.push(resolved);
        }
    }
    return files;
}

// ── Main ────────────────────────────────────────────────────────────────────

const inputArgs = process.argv.slice(2);
const files = collectSldprtFiles(inputArgs);

if (files.length === 0) {
    console.error('No .SLDPRT files found.');
    process.exit(1);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let succeeded = 0;
let failed = 0;

console.log(`Converting ${files.length} file(s) → ${OUTPUT_DIR}\n`);

for (const filePath of files) {
    const baseName = path.basename(filePath, path.extname(filePath));
    const outPath = path.join(OUTPUT_DIR, `${baseName}.stp`);

    try {
        const buf = fs.readFileSync(filePath);
        const result = convertSldprtToStep(buf, `${baseName}.stp`);

        if (!result) {
            console.log(`  SKIP  ${baseName} — no Parasolid data found`);
            failed++;
            continue;
        }

        fs.writeFileSync(outPath, result.step, 'utf-8');

        const sizeKB = (Buffer.byteLength(result.step) / 1024).toFixed(1);
        const v = result.model.vertices.length;
        const s = result.model.surfaces.length;
        const f = result.model.faces.length;
        const fmt = result.containerFormat.toUpperCase();

        console.log(
            `  OK    ${baseName}.stp  (${sizeKB} KB, ${v} vertices, ${s} surfaces, ${f} faces, ${fmt})`,
        );
        succeeded++;
    } catch (err) {
        console.log(`  FAIL  ${baseName} — ${err.message}`);
        failed++;
    }
}

console.log(`\nDone: ${succeeded} converted, ${failed} failed/skipped.`);
