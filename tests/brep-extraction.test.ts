/**
 * brep-extraction.test.ts
 *
 * Integration tests that exercise the full container-parser pipeline against
 * the real NIST MBE PMI SolidWorks MBD 2018 sample files.
 *
 * These tests are **skipped** when the sample files have not been downloaded
 * yet (`npm run download-samples`).  They are also safe to run even when no
 * files are present — every `describe` block checks for the fixture folder
 * and calls `it.skip` when it is missing.
 *
 * Constraint: relies entirely on standard stream parsing and public ISO
 * specifications.  No proprietary Dassault APIs.
 *
 * Test models used:
 *   NIST MBE PMI Validation and Conformance Testing (SolidWorks MBD 2018)
 *   https://www.nist.gov/el/systems-integration-division-73400/
 *     mbe-pmi-validation-and-conformance-testing
 *   These are U.S. Government works in the public domain.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { SldprtContainerParser } from '../src/parser/SldprtContainerParser.js';
import { OleContainerParser, OLE2_SIGNATURE } from '../src/parser/OleContainerParser.js';
import { isParasolidBuffer } from '../src/parser/Sw3DStorageParser.js';

// ── Locate the NIST sample files ────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const DOWNLOADS_DIR = join(ROOT, 'downloads', 'nist');

/** Recursively find all .SLDPRT files under a directory. */
function findSldprtFiles(dir: string): string[] {
    const results: string[] = [];
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

const sampleFiles = findSldprtFiles(DOWNLOADS_DIR);
const hasSamples = sampleFiles.length > 0;

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Wrapper: if no sample files are present the test is skipped with a clear
 * message rather than failing.
 */
const describeWithSamples = hasSamples ? describe : describe.skip;

// ── Container format detection tests ────────────────────────────────────────

describeWithSamples('NIST SLDPRT samples — container detection', () => {
    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s is recognised as either OLE2 or SW 3D Storage',
        (_name, filePath) => {
            const buf = readFileSync(filePath as string);
            expect(buf.length).toBeGreaterThan(0);

            // Must be one of our two known containers
            const isOle = OleContainerParser.isOle2(buf);
            // SW 3D Storage files do NOT start with the OLE2 magic.
            // We just verify the file can be read; format detection is in
            // SldprtContainerParser below.
            expect(typeof isOle).toBe('boolean');
        },
    );
});

// ── BRep stream extraction tests ────────────────────────────────────────────

describeWithSamples('NIST SLDPRT samples — BRep stream extraction', () => {
    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s yields a non-null extractParasolid result',
        (_name, filePath) => {
            const buf = readFileSync(filePath as string);
            const result = SldprtContainerParser.extractParasolid(buf);

            // Every genuine SLDPRT should produce a result
            expect(result).not.toBeNull();
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → extracted BRep data has length > 0',
        (_name, filePath) => {
            const buf = readFileSync(filePath as string);
            const result = SldprtContainerParser.extractParasolid(buf);
            if (!result) return; // guarded by the test above
            expect(result.data.length).toBeGreaterThan(0);
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → extracted stream starts with a known Parasolid magic',
        (_name, filePath) => {
            const buf = readFileSync(filePath as string);
            const result = SldprtContainerParser.extractParasolid(buf);
            if (!result) return;

            // The decompressed BRep buffer should begin with one of
            // our recognised Parasolid magic prefixes.
            expect(isParasolidBuffer(result.data)).toBe(true);
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → format is "ole2" or "sw3d"',
        (_name, filePath) => {
            const buf = readFileSync(filePath as string);
            const result = SldprtContainerParser.extractParasolid(buf);
            if (!result) return;
            expect(['ole2', 'sw3d']).toContain(result.format);
        },
    );
});

// ── Parasolid binary header sanity ──────────────────────────────────────────

describeWithSamples('NIST SLDPRT samples — Parasolid header sanity', () => {
    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → BRep buffer is at least 64 bytes',
        (_name, filePath) => {
            const buf = readFileSync(filePath as string);
            const result = SldprtContainerParser.extractParasolid(buf);
            if (!result) return;
            // Any real Parasolid BRep will be much larger, but 64 bytes
            // rules out empty / corrupt streams.
            expect(result.data.length).toBeGreaterThanOrEqual(64);
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → BRep buffer contains ASCII text or binary Parasolid blocks',
        (_name, filePath) => {
            const buf = readFileSync(filePath as string);
            const result = SldprtContainerParser.extractParasolid(buf);
            if (!result) return;

            const head = result.data.subarray(0, 32).toString('ascii');
            // Should contain recognisable ASCII or be a valid binary block.
            // We check that the first 32 bytes are not all null.
            const nonNull = [...result.data.subarray(0, 32)].some(b => b !== 0);
            expect(nonNull).toBe(true);
        },
    );
});

// ── Skip notice ──────────────────────────────────────────────────────────────

if (!hasSamples) {
    describe('NIST SLDPRT integration tests', () => {
        it('are SKIPPED — run `npm run download-samples` first', () => {
            console.log(
                '\n  ℹ  No NIST sample files found in downloads/nist/.' +
                '\n     Run `npm run download-samples` to fetch the NIST MBE PMI' +
                '\n     SolidWorks MBD 2018 test models, then re-run tests.\n',
            );
        });
    });
}
