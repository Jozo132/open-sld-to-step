#!/usr/bin/env node
/**
 * download-nist-samples.mjs
 *
 * Downloads and extracts the public-domain NIST MBE PMI CAD test models
 * (SolidWorks MBD 2018 series) for use as integration-test fixtures.
 *
 * The NIST CAD models are U.S. Government works and are not subject to
 * copyright in the United States (17 U.S.C. §105).
 *
 * Source:
 *   https://www.nist.gov/ctl/smart-connected-systems-division/
 *     smart-connected-manufacturing-systems-group/mbe-pmi-validation
 *
 * Usage:
 *   node scripts/download-nist-samples.mjs
 *
 * Files are placed in:
 *   <project-root>/downloads/nist/
 */

import { existsSync, mkdirSync, createWriteStream, readdirSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnzip } from 'node:zlib';
import { createReadStream, unlinkSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DOWNLOADS = join(ROOT, 'downloads');
const NIST_DIR = join(DOWNLOADS, 'nist');

// ── NIST MBE PMI test-model ZIP URL ──────────────────────────────────────
// The NIST MBE PMI Validation project provides CAD models as individual
// downloads on https://www.nist.gov/... .  The full SolidWorks MBD 2018
// dataset is distributed as a single ZIP from the NIST document server.
//
// The URL below points to the publicly-hosted ZIP archive that aggregates
// all SolidWorks MBD 2018 test-case SLDPRT files.
//
// If NIST changes the URL, set the environment variable
//   NIST_ZIP_URL=<new-url>
// before running this script.
const NIST_ZIP_URL = process.env.NIST_ZIP_URL ||
    'https://www.nist.gov/system/files/documents/noindex/2024/05/07/NIST-FTC-CTC-PMI-CAD-models.zip';

// Fallback URL if the primary is unavailable
const NIST_ZIP_URL_FALLBACK =
    'https://s3.amazonaws.com/nist-el/mfg_digitalthread/NIST_CTC_FTC_PMI_Models-SolidWorks_MBD_2018.zip';

const ZIP_FILENAME = 'NIST-FTC-CTC-PMI-CAD-models.zip';
const ZIP_PATH = join(DOWNLOADS, ZIP_FILENAME);

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Download a URL to a local file path.
 * Uses the built-in `fetch` API (Node 18+).
 */
async function downloadFile(url, destPath) {
    console.log(`  ↓  Downloading: ${url}`);
    console.log(`     →  ${destPath}`);

    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);
    }

    const totalBytes = Number(resp.headers.get('content-length') || 0);
    let received = 0;

    const dest = createWriteStream(destPath);

    // Stream body to file, showing progress
    const reader = resp.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        dest.write(value);
        received += value.length;
        if (totalBytes > 0) {
            const pct = ((received / totalBytes) * 100).toFixed(1);
            process.stdout.write(`\r     ${pct}%  (${(received / 1_048_576).toFixed(1)} MB)`);
        }
    }
    dest.end();
    console.log('\n     ✓  Download complete.');
}

/**
 * Extract a ZIP archive using the `unzip` CLI tool (widely available on
 * Linux / macOS / CI runners).  Falls back to a manual approach using
 * Node's built-in `node:child_process`.
 */
async function extractZip(zipPath, destDir) {
    console.log(`  📦 Extracting: ${zipPath}`);
    console.log(`     →  ${destDir}`);

    const { execSync } = await import('node:child_process');
    try {
        execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, {
            stdio: 'inherit',
        });
    } catch {
        // If `unzip` is unavailable, try `python3 -m zipfile`
        try {
            execSync(
                `python3 -m zipfile -e "${zipPath}" "${destDir}"`,
                { stdio: 'inherit' },
            );
        } catch {
            console.error(
                '\n  ✗  Neither `unzip` nor `python3` found on PATH.\n' +
                '     Please install one of them or manually extract:\n' +
                `     ${zipPath}  →  ${destDir}\n`,
            );
            process.exit(1);
        }
    }
    console.log('     ✓  Extraction complete.');
}

/**
 * Recursively find all .SLDPRT files under a directory.
 */
function findSldprtFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findSldprtFiles(full));
        } else if (/\.sldprt$/i.test(entry.name)) {
            results.push(full);
        }
    }
    return results;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    console.log('┌─────────────────────────────────────────────────────┐');
    console.log('│  NIST MBE PMI CAD Test-Model Downloader             │');
    console.log('│  (SolidWorks MBD 2018 — public domain)              │');
    console.log('└─────────────────────────────────────────────────────┘');
    console.log();

    // Check if we already have SLDPRT files
    const existing = findSldprtFiles(NIST_DIR);
    if (existing.length > 0) {
        console.log(`  ✓  Found ${existing.length} .SLDPRT file(s) in ${NIST_DIR}`);
        console.log('     Skipping download.  Delete the downloads/ folder to re-fetch.');
        console.log();
        existing.forEach(f => console.log(`     • ${f.replace(ROOT + '/', '')}`));
        return;
    }

    // Ensure directories exist
    mkdirSync(NIST_DIR, { recursive: true });

    // Download ZIP if not already cached
    if (!existsSync(ZIP_PATH)) {
        try {
            await downloadFile(NIST_ZIP_URL, ZIP_PATH);
        } catch (err) {
            console.warn(`\n  ⚠  Primary URL failed: ${err.message}`);
            console.warn('     Trying fallback URL...\n');
            try {
                await downloadFile(NIST_ZIP_URL_FALLBACK, ZIP_PATH);
            } catch (err2) {
                console.error(`\n  ✗  Fallback also failed: ${err2.message}`);
                console.error(
                    '\n  Please download the NIST SolidWorks MBD 2018 models manually from:' +
                    '\n  https://www.nist.gov/ctl/smart-connected-systems-division/' +
                    '\n    smart-connected-manufacturing-systems-group/mbe-pmi-0' +
                    '\n' +
                    `\n  Save the ZIP to: ${ZIP_PATH}` +
                    '\n  Then re-run:  npm run download-samples\n',
                );
                process.exit(1);
            }
        }
    } else {
        console.log(`  ✓  ZIP already cached at ${ZIP_PATH}`);
    }

    // Extract
    await extractZip(ZIP_PATH, NIST_DIR);

    // Verify
    const files = findSldprtFiles(NIST_DIR);
    console.log();
    if (files.length > 0) {
        console.log(`  ✓  ${files.length} .SLDPRT file(s) ready for testing:`);
        files.forEach(f => console.log(`     • ${f.replace(ROOT + '/', '')}`));
    } else {
        console.log('  ⚠  No .SLDPRT files found after extraction.');
        console.log('     The ZIP may contain a different folder structure.');
        console.log(`     Check: ${NIST_DIR}`);
    }
    console.log();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
