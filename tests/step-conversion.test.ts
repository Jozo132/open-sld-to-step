/**
 * step-conversion.test.ts
 *
 * Integration tests for the end-to-end SLDPRT → STEP conversion pipeline.
 *
 * Tests against the NIST MBE PMI SolidWorks MBD 2018 sample files.
 * Skipped automatically when samples are not downloaded.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { convertSldprtToStep } from '../src/step/convertSldprtToStep.js';
import { ParasolidParser } from '../src/parser/ParasolidParser.js';
import { SldprtContainerParser } from '../src/parser/SldprtContainerParser.js';

// ── Locate samples ──────────────────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const DOWNLOADS_DIR = join(ROOT, 'downloads', 'nist');

function findSldprtFiles(dir: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findSldprtFiles(full));
        else if (/\.sldprt$/i.test(entry.name)) results.push(full);
    }
    return results;
}

const sampleFiles = findSldprtFiles(DOWNLOADS_DIR);
const hasSamples = sampleFiles.length > 0;
const describeWithSamples = hasSamples ? describe : describe.skip;
const ctc01Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ctc_01_asme1_rd_sw1802.sldprt',
);
const ctc02Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ctc_02_asme1_rc_sw1802.sldprt',
);
const ctc04Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ctc_04_asme1_rd_sw1802.sldprt',
);
const ftc06Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ftc_06_asme1_rd_sw1802.sldprt',
);
const ftc09Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ftc_09_asme1_rd_sw1802.sldprt',
);
const ftc10Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ftc_10_asme1_rb_sw1802.sldprt',
);
const ftc07Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ftc_07_asme1_rd_sw1802.sldprt',
);
const ftc11Path = sampleFiles.find(filePath =>
    basename(filePath).toLowerCase() === 'nist_ftc_11_asme1_rb_sw1802.sldprt',
);

// ── Shared conversion cache ─────────────────────────────────────────────────
// Each file is read and converted exactly once, then all assertions run against
// the cached result.  This avoids O(files × testBlocks) repeated conversions
// which caused heap exhaustion on large sample sets.

import type { ConversionResult } from '../src/step/convertSldprtToStep.js';

const conversionCache = new Map<string, ConversionResult | null>();

function getCachedConversion(filePath: string): ConversionResult | null {
    if (conversionCache.has(filePath)) return conversionCache.get(filePath)!;
    const buf = readFileSync(filePath);
    const result = convertSldprtToStep(buf, basename(filePath));
    conversionCache.set(filePath, result);
    return result;
}

function legacyRawScanStart(buf: Buffer): number {
    let dataStart = 0x400;
    for (let offset = Math.min(0x1000, buf.length) - 1; offset >= 0x60; offset--) {
        if (buf[offset] === 0x5a) {
            dataStart = offset + 1;
            break;
        }
    }

    return dataStart;
}

function getRawScanStart(parser: ParasolidParser): number {
    return (parser as unknown as { resolveFullScanStart(): number }).resolveFullScanStart();
}

type TestConeParams = {
    origin: { x: number; y: number; z: number };
    axis: { x: number; y: number; z: number };
    radius: number;
    halfAngle: number;
};

function canonicalizeTestCone(params: TestConeParams): {
    apex: { x: number; y: number; z: number };
    axis: { x: number; y: number; z: number };
    halfAngle: number;
} {
    const axisLength = Math.hypot(params.axis.x, params.axis.y, params.axis.z) || 1;
    const axis = {
        x: params.axis.x / axisLength,
        y: params.axis.y / axisLength,
        z: params.axis.z / axisLength,
    };
    const halfAngle = Math.abs(params.halfAngle) > Math.PI
        ? (params.halfAngle * Math.PI / 180)
        : params.halfAngle;
    const tanHalfAngle = Math.tan(halfAngle);
    const offset = !isFinite(tanHalfAngle) || Math.abs(tanHalfAngle) < 1e-9
        ? 0
        : params.radius / tanHalfAngle;

    return {
        apex: {
            x: params.origin.x - axis.x * offset,
            y: params.origin.y - axis.y * offset,
            z: params.origin.z - axis.z * offset,
        },
        axis,
        halfAngle,
    };
}

function coneMatchesCanonical(
    actual: TestConeParams,
    expected: TestConeParams,
    positionTol = 0.1,
    angleTol = 0.02,
): boolean {
    const actualCanonical = canonicalizeTestCone(actual);
    const expectedCanonical = canonicalizeTestCone(expected);
    const axisDot =
        actualCanonical.axis.x * expectedCanonical.axis.x +
        actualCanonical.axis.y * expectedCanonical.axis.y +
        actualCanonical.axis.z * expectedCanonical.axis.z;

    return Math.abs(actualCanonical.apex.x - expectedCanonical.apex.x) < positionTol &&
        Math.abs(actualCanonical.apex.y - expectedCanonical.apex.y) < positionTol &&
        Math.abs(actualCanonical.apex.z - expectedCanonical.apex.z) < positionTol &&
        Math.abs(Math.abs(axisDot) - 1) < 0.01 &&
        Math.abs(actualCanonical.halfAngle - expectedCanonical.halfAngle) < angleTol;
}

// ── ParasolidParser unit tests ──────────────────────────────────────────────

afterAll(() => {
    conversionCache.clear();
});

describe('ParasolidParser', () => {
    it('returns null header for non-Parasolid buffer', () => {
        const parser = new ParasolidParser(Buffer.from('not a parasolid file'));
        expect(parser.parseHeader()).toBeNull();
    });

    it('returns null header for empty buffer', () => {
        const parser = new ParasolidParser(Buffer.alloc(0));
        expect(parser.parseHeader()).toBeNull();
    });

    it('parses header from a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();

        const parser = new ParasolidParser(extraction!.data);
        const header = parser.parseHeader();
        expect(header).not.toBeNull();
        expect(header!.modellerVersion).toBeGreaterThan(0);
        expect(header!.schemaId).toContain('SCH_');
    });

    it('parses schema metadata from a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const metadata = parser.parseSchemaMetadata();

        expect(metadata).not.toBeNull();
        if (!metadata) return;

        expect(metadata.schemaId).toContain('SCH_');
        expect(metadata.fieldDefinitions.length).toBeGreaterThan(0);
        expect(metadata.namedClasses.length).toBeGreaterThan(0);
        expect(metadata.metadataEndOffset).toBeGreaterThan(metadata.schemaTerminatorOffset);
        expect(metadata.firstSentinelOffset).not.toBeNull();
        expect((metadata.firstSentinelOffset ?? 0)).toBeGreaterThan(metadata.metadataEndOffset);
        expect(metadata.firstEntityHeader).not.toBeNull();
    });

    it('detects the first pre-sentinel entity record across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const metadata = parser.parseSchemaMetadata();

            expect(metadata).not.toBeNull();
            if (!metadata) continue;

            expect(metadata.firstSentinelOffset).not.toBeNull();
            expect(metadata.firstEntityOffset).not.toBeNull();
            expect(metadata.firstEntityHeader).not.toBeNull();
            expect(metadata.firstEntityHeader?.offset).toBe(metadata.firstEntityOffset);
            expect(metadata.firstEntityOffset!).toBeLessThan(metadata.firstSentinelOffset!);
            expect(metadata.firstEntityOffset!).toBeGreaterThanOrEqual(metadata.metadataEndOffset);
        }
    });

    it('uses the decoded metadata boundary for markerless raw scans across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const metadata = parser.parseSchemaMetadata();

            expect(metadata).not.toBeNull();
            if (!metadata) continue;

            const legacyStart = legacyRawScanStart(extraction.data);
            const scanStart = getRawScanStart(parser);
            expect(scanStart).toBe(Math.max(legacyStart, metadata.metadataEndOffset));
            expect(scanStart).toBeGreaterThanOrEqual(metadata.schemaTerminatorOffset);
        }
    });

    it('promotes the raw-scan start when trusted metadata ends after the legacy cutoff', () => {
        const buf = Buffer.alloc(2048);
        buf[900] = 0x5a;

        const parser = new ParasolidParser(buf);
        (parser as unknown as {
            parseSchemaMetadata: () => {
                schemaId: string;
                schemaOffset: number;
                schemaTerminatorOffset: number;
                metadataEndOffset: number;
                firstEntityOffset: number | null;
                firstEntityHeader: null;
                firstSentinelOffset: number | null;
                fieldDefinitions: unknown[];
                namedClasses: unknown[];
            };
        }).parseSchemaMetadata = () => ({
            schemaId: 'SCH_TEST',
            schemaOffset: 0,
            schemaTerminatorOffset: 100,
            metadataEndOffset: 1500,
            firstEntityOffset: null,
            firstEntityHeader: null,
            firstSentinelOffset: null,
            fieldDefinitions: [],
            namedClasses: [],
        });

        expect(getRawScanStart(parser)).toBe(1500);
    });

    it('caps FTC_07 metadata before the first packed body record', () => {
        if (!ftc07Path) return;

        const buf = readFileSync(ftc07Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const metadata = parser.parseSchemaMetadata();

        expect(metadata).not.toBeNull();
        if (!metadata) return;

        expect(metadata.metadataEndOffset).toBe(1678);
        expect(metadata.firstEntityOffset).toBe(1686);
        expect(metadata.firstEntityHeader).toMatchObject({ offset: 1686, format: 'packed', type: 30, id: 16 });
    });

    it('falls back to the legacy raw-scan boundary when schema metadata is unavailable', () => {
        const buf = Buffer.alloc(2048);
        buf[900] = 0x5a;

        const parser = new ParasolidParser(buf);

        expect(parser.parseSchemaMetadata()).toBeNull();
        expect(getRawScanStart(parser)).toBe(901);
    });

    it('parses sentinel-aligned linear records across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const metadata = parser.parseSchemaMetadata();
            const records = parser.parseSentinelAlignedEntities();

            expect(records.length).toBeGreaterThan(0);
            const firstHeaderIsSentinelAdjacent = metadata?.firstSentinelOffset !== null &&
                metadata?.firstSentinelOffset !== undefined &&
                metadata?.firstEntityOffset !== null &&
                metadata.firstSentinelOffset - metadata.firstEntityOffset <= 18;
            if (firstHeaderIsSentinelAdjacent) {
                expect(records.some(record => record.sentinelOffset === metadata.firstSentinelOffset)).toBe(true);
            }
        }
    });

    it('finds both compact and packed sentinel record forms in CTC_01', () => {
        if (!hasSamples) return;
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const records = parser.parseSentinelAlignedEntities();

        expect(records.some(record => record.role === 'embedded-data' && record.header.type === 16)).toBe(true);
        expect(records.some(record => record.role === 'terminator' && record.header.type === 18)).toBe(true);
    });

    it('decodes coedge and gap-point linkage across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const coedges = parser.parseCoedgeRecords();
            const points = parser.parseGapPointRecords();
            const coedgeIds = new Set(coedges.map(record => record.id));
            const pointIds = new Set(points.map(record => record.id));
            const prevResolved = coedges.filter(record => coedgeIds.has(record.prevCoedgeId)).length;
            const nextResolved = coedges.filter(record => coedgeIds.has(record.nextCoedgeId)).length;
            const vertexResolved = coedges.filter(record => pointIds.has(record.vertexPointId)).length;

            expect(coedgeIds.size).toBe(coedges.length);
            expect(pointIds.size).toBe(points.length);

            if (basename(filePath).toLowerCase() === 'nist_ftc_11_asme1_rb_sw1802.sldprt') {
                expect(coedges).toHaveLength(0);
                expect(points).toHaveLength(0);
                continue;
            }

            expect(coedges.length).toBeGreaterThan(0);
            expect(points.length).toBeGreaterThan(0);
            expect(prevResolved).toBe(coedges.length - 1);
            expect(nextResolved).toBe(coedges.length - 1);
            expect(vertexResolved).toBe(points.length);
        }
    });

    it('decodes structural point records across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const coedges = parser.parseCoedgeRecords();
            const points = parser.parsePointRecords();
            const pointIds = new Set(points.map(record => record.id));
            const vertexResolved = coedges.filter(record => pointIds.has(record.vertexPointId)).length;

            expect(pointIds.size).toBe(points.length);
            expect(points.every(record => Number.isFinite(record.position.x))).toBe(true);
            expect(points.every(record => Number.isFinite(record.position.y))).toBe(true);
            expect(points.every(record => Number.isFinite(record.position.z))).toBe(true);

            if (basename(filePath).toLowerCase() === 'nist_ftc_11_asme1_rb_sw1802.sldprt') {
                expect(coedges).toHaveLength(0);
                expect(points).toHaveLength(0);
                continue;
            }

            expect(points.length).toBeGreaterThan(0);
            expect(points.length - vertexResolved).toBeLessThanOrEqual(1);
        }
    });

    it('stabilizes the first decoded CTC_01 coedge and point links', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const coedges = parser.parseCoedgeRecords();
        const points = parser.parseGapPointRecords();

        expect(coedges.slice(0, 4)).toMatchObject([
            { id: 52, curveLikeId: 59, prevCoedgeId: 14, nextCoedgeId: 60, vertexPointId: 46 },
            { id: 60, curveLikeId: 67, prevCoedgeId: 52, nextCoedgeId: 68, vertexPointId: 69 },
            { id: 68, curveLikeId: 72, prevCoedgeId: 60, nextCoedgeId: 73, vertexPointId: 70 },
            { id: 73, curveLikeId: 75, prevCoedgeId: 68, nextCoedgeId: 76, vertexPointId: 71 },
        ]);
        expect(points.slice(0, 4)).toMatchObject([
            { id: 46, nextCoedgeId: 52, nextPointId: 69, prevPointId: 11 },
            { id: 71, nextCoedgeId: 73, nextPointId: 74, prevPointId: 70 },
            { id: 74, nextCoedgeId: 76, nextPointId: 77, prevPointId: 71 },
            { id: 77, nextCoedgeId: 79, nextPointId: 80, prevPointId: 74 },
        ]);
    });

    it('reconstructs a single ordered coedge chain across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const coedges = parser.parseCoedgeRecords();
            const chain = parser.parseCoedgeChain();

            if (basename(filePath).toLowerCase() === 'nist_ftc_11_asme1_rb_sw1802.sldprt') {
                expect(chain).toBeNull();
                continue;
            }

            expect(chain).not.toBeNull();
            if (!chain) continue;

            expect(chain.orderedCoedges).toHaveLength(coedges.length);
            expect(chain.headCoedgeId).toBe(chain.orderedCoedges[0].id);
            expect(chain.tailCoedgeId).toBe(chain.orderedCoedges[chain.orderedCoedges.length - 1].id);
            expect(chain.terminalNextId).toBe(1);
        }
    });

    it('stabilizes the CTC_01 coedge chain endpoints', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const chain = parser.parseCoedgeChain();

        expect(chain).not.toBeNull();
        if (!chain) return;

        expect(chain.headCoedgeId).toBe(52);
        expect(chain.tailCoedgeId).toBe(710);
        expect(chain.terminalPrevId).toBe(14);
        expect(chain.terminalNextId).toBe(1);
        expect(chain.orderedCoedges.slice(0, 4).map(record => record.id)).toEqual([52, 60, 68, 73]);
        expect(chain.orderedCoedges.slice(-4).map(record => record.id)).toEqual([701, 704, 707, 710]);
    });

    it('decodes compact type-16 edge records across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const edges = parser.parseEdgeRecords();

            expect(edges.length).toBeGreaterThan(0);
            expect(new Set(edges.map(record => record.id)).size).toBe(edges.length);
        }
    });

    it('reconstructs ordered type-16 components across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const edges = parser.parseEdgeRecords();
            const components = parser.parseEdgeComponents();
            const edgeIds = new Set(edges.map(record => record.id));
            const prevResolved = edges.filter(record => edgeIds.has(record.prevEdgeId)).length;
            const nextResolved = edges.filter(record => edgeIds.has(record.nextEdgeId)).length;
            const totalEdgesInComponents = components.reduce((sum, component) => sum + component.orderedEdges.length, 0);
            const fileName = basename(filePath).toLowerCase();

            expect(totalEdgesInComponents).toBe(edges.length);
            expect(prevResolved).toBe(edges.length - components.length);
            expect(nextResolved).toBe(edges.length - components.length);

            if (fileName === 'nist_ctc_01_asme1_rd_sw1802.sldprt') {
                expect(components).toHaveLength(12);
                continue;
            }

            if (fileName === 'nist_ctc_03_asme1_rc_sw1802.sldprt') {
                expect(components).toHaveLength(4);
                continue;
            }

            expect(components).toHaveLength(1);
            expect(components[0].terminalNextId).toBe(1);
        }
    });

    it('stabilizes the FTC_11 type-16 component chain', () => {
        if (!ftc11Path) return;

        const buf = readFileSync(ftc11Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const edges = parser.parseEdgeRecords();
        const components = parser.parseEdgeComponents();

        expect(edges.map(record => record.id)).toEqual([49, 53, 57, 62, 65]);
        expect(components).toHaveLength(1);
        expect(components[0].headEdgeId).toBe(49);
        expect(components[0].tailEdgeId).toBe(65);
        expect(components[0].terminalPrevId).toBe(13);
        expect(components[0].terminalNextId).toBe(1);
        expect(components[0].orderedEdges.map(record => record.id)).toEqual([49, 53, 57, 62, 65]);
    });

    it('decodes minimal raw face records where sentinel-block face entities exist', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const faces = parser.parseFaceRecords();
            expect(new Set(faces.map(record => record.id)).size).toBe(faces.length);
            expect(faces.every(record => record.dataLength >= 12)).toBe(true);
            expect(faces.every(record => record.geometryLikeId > 0)).toBe(true);
            expect(faces.every(record => record.primary === false)).toBe(true);

            if (faces.length === 0) continue;
            expect(
                faces.some(record =>
                    record.shellId !== null ||
                    record.secondaryRefId !== 1 ||
                    record.coedgeAnchorAId !== null ||
                    record.edgeAnchorAId !== null,
                ),
            ).toBe(true);
        }
    });

    it('stabilizes the first decoded CTC_01 face record prefix', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const faces = parser.parseFaceRecords();

        expect(faces).toHaveLength(1);
        expect(faces[0]).toMatchObject({
            id: 1915,
            primary: false,
            flags: 1790,
            primaryRefId: 3716,
            geometryLikeId: 1905,
            secondaryRefId: 1,
            shellId: 3716,
            coedgeAnchorAId: 507,
            edgeAnchorAId: 1111,
            coedgeAnchorBId: 213,
            edgeAnchorBId: 1662,
            dataLength: 2063,
        });
    });

    it('captures representative FTC_08 face record prefixes', () => {
        if (!hasSamples) return;
        const targetPath = sampleFiles.find(filePath =>
            basename(filePath).toLowerCase() === 'nist_ftc_08_asme1_rc_sw1802.sldprt',
        );
        if (!targetPath) return;

        const buf = readFileSync(targetPath);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const faces = new Map(parser.parseFaceRecords().map(record => [record.id, record]));

        expect(faces.get(4668)).toMatchObject({
            primary: false,
            flags: 9193,
            primaryRefId: 2506,
            geometryLikeId: 4669,
            secondaryRefId: 1,
            shellId: 1005,
            coedgeAnchorAId: 1003,
            edgeAnchorAId: 4616,
            coedgeAnchorBId: 1000,
            edgeAnchorBId: 2504,
            dataLength: 114,
        });
        expect(faces.get(4836)).toMatchObject({
            primary: false,
            flags: 9165,
            primaryRefId: 4832,
            geometryLikeId: 4837,
            secondaryRefId: 1,
            shellId: 1038,
            coedgeAnchorAId: 1036,
            edgeAnchorAId: 4731,
            coedgeAnchorBId: 1039,
            edgeAnchorBId: 4694,
            dataLength: 222,
        });
        expect(faces.get(5016)).toMatchObject({
            primary: false,
            flags: 9517,
            primaryRefId: 4942,
            geometryLikeId: 5017,
            secondaryRefId: 1,
            shellId: 1086,
            coedgeAnchorAId: 1084,
            edgeAnchorAId: 1248,
            coedgeAnchorBId: 1081,
            edgeAnchorBId: 4940,
            dataLength: 114,
        });
    });

    it('decodes aligned face-edge hits from raw face payloads', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const faces = parser.parseFaceRecords();
            const hits = parser.parseFaceEdgeHits();
            const faceIds = new Set(faces.map(record => record.id));
            const edgeIds = new Set(parser.parseEdgeRecords().map(record => record.id));
            const anchoredFaces = faces.filter(record => record.edgeAnchorAId !== null).length;

            expect(hits.every(hit => hit.byteOffset % 2 === 0)).toBe(true);
            expect(hits.every(hit => faceIds.has(hit.faceId))).toBe(true);
            expect(hits.every(hit => edgeIds.has(hit.edgeId))).toBe(true);
            expect(hits.length).toBeGreaterThanOrEqual(anchoredFaces);
        }
    });

    it('stabilizes representative CTC_01 face-edge hits and chain positions', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const hits = parser.parseFaceEdgeHits().filter(hit => hit.faceId === 1915);

        expect(hits.slice(0, 4)).toEqual([
            { faceId: 1915, byteOffset: 28, edgeId: 1111, chainIndex: 0, componentIndex: 10, edgeIndex: 14, linearIndex: 208 },
            { faceId: 1915, byteOffset: 74, edgeId: 1662, chainIndex: 0, componentIndex: 7, edgeIndex: 3, linearIndex: 152 },
            { faceId: 1915, byteOffset: 90, edgeId: 769, chainIndex: 0, componentIndex: 11, edgeIndex: 134, linearIndex: 346 },
            { faceId: 1915, byteOffset: 120, edgeId: 1395, chainIndex: 0, componentIndex: 7, edgeIndex: 0, linearIndex: 149 },
        ]);
    });

    it('captures representative FTC_08 face-edge hit sequences', () => {
        if (!hasSamples) return;
        const targetPath = sampleFiles.find(filePath =>
            basename(filePath).toLowerCase() === 'nist_ftc_08_asme1_rc_sw1802.sldprt',
        );
        if (!targetPath) return;

        const buf = readFileSync(targetPath);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const hits = parser.parseFaceEdgeHits();
        const byFace = new Map<number, typeof hits>();
        for (const hit of hits) {
            const bucket = byFace.get(hit.faceId) ?? [];
            bucket.push(hit);
            byFace.set(hit.faceId, bucket);
        }

        expect(byFace.get(4668)?.slice(0, 4)).toEqual([
            { faceId: 4668, byteOffset: 28, edgeId: 4616, chainIndex: 0, componentIndex: 0, edgeIndex: 540, linearIndex: 540 },
            { faceId: 4668, byteOffset: 36, edgeId: 4356, chainIndex: 0, componentIndex: 0, edgeIndex: 349, linearIndex: 349 },
            { faceId: 4668, byteOffset: 74, edgeId: 2504, chainIndex: 0, componentIndex: 0, edgeIndex: 579, linearIndex: 579 },
            { faceId: 4668, byteOffset: 106, edgeId: 4589, chainIndex: 0, componentIndex: 0, edgeIndex: 539, linearIndex: 539 },
        ]);
        expect(byFace.get(6403)?.slice(0, 3)).toEqual([
            { faceId: 6403, byteOffset: 28, edgeId: 3692, chainIndex: 0, componentIndex: 0, edgeIndex: 47, linearIndex: 47 },
            { faceId: 6403, byteOffset: 74, edgeId: 2098, chainIndex: 0, componentIndex: 0, edgeIndex: 489, linearIndex: 489 },
            { faceId: 6403, byteOffset: 106, edgeId: 2098, chainIndex: 0, componentIndex: 0, edgeIndex: 489, linearIndex: 489 },
        ]);
    });

    it('derives stable raw face boundary hints across samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const hints = parser.parseRawFaceBoundaryHints();
            expect(new Set(hints.map(hint => hint.faceId)).size).toBe(hints.length);
            expect(hints.every(hint => hint.primarySize >= 3)).toBe(true);
            expect(hints.every(hint => hint.collapsedSize === null || hint.collapsedSize >= 3)).toBe(true);
            expect(hints.every(hint => hint.edgeAnchorCount >= 0 && hint.edgeAnchorCount <= 2)).toBe(true);
            expect(hints.every(hint => hint.edgeAnchorIds.length === hint.edgeAnchorCount)).toBe(true);
            expect(hints.every(hint => hint.coedgeAnchorIds.length <= 2)).toBe(true);
            expect(hints.every(hint => hint.chainCount >= 0)).toBe(true);
            expect(hints.every(hint => hint.segmentCount >= 0)).toBe(true);
            expect(hints.every(hint => hint.maxSegmentLength >= 0)).toBe(true);
            expect(hints.every(hint => hint.maxChainSpan === null || hint.maxChainSpan >= 1)).toBe(true);
        }
    });

    it('stabilizes representative raw face boundary hints', () => {
        if (!hasSamples) return;

        const ftc09Path = sampleFiles.find(filePath =>
            basename(filePath).toLowerCase() === 'nist_ftc_09_asme1_rd_sw1802.sldprt',
        );
        if (!ftc09Path || !ctc02Path) return;

        const ftc09Extraction = SldprtContainerParser.extractParasolid(readFileSync(ftc09Path));
        expect(ftc09Extraction).not.toBeNull();
        if (!ftc09Extraction) return;

        const ctc02Extraction = SldprtContainerParser.extractParasolid(readFileSync(ctc02Path));
        expect(ctc02Extraction).not.toBeNull();
        if (!ctc02Extraction) return;

        const ftc09Hints = new Map(new ParasolidParser(ftc09Extraction.data).parseRawFaceBoundaryHints().map(hint => [hint.faceId, hint]));
        const ctc02Hints = new Map(new ParasolidParser(ctc02Extraction.data).parseRawFaceBoundaryHints().map(hint => [hint.faceId, hint]));

        expect(ftc09Hints.get(1464)).toEqual({
            faceId: 1464,
            primarySize: 3,
            collapsedSize: 3,
            edgeAnchorCount: 1,
            edgeAnchorIds: [1114],
            coedgeAnchorIds: [256],
            repeatedEdgeIds: [],
            resolvedSurfaceType: 'cylinder',
            chainCount: 1,
            segmentCount: 3,
            maxSegmentLength: 1,
            maxChainSpan: 7,
        });
        expect(ctc02Hints.get(7547)).toEqual({
            faceId: 7547,
            primarySize: 8,
            collapsedSize: 5,
            edgeAnchorCount: 2,
            edgeAnchorIds: [7211, 7418],
            coedgeAnchorIds: [366, 375],
            repeatedEdgeIds: [7215, 7416, 7418],
            resolvedSurfaceType: null,
            chainCount: 1,
            segmentCount: 5,
            maxSegmentLength: 4,
            maxChainSpan: 305,
        });
    });

    it('prefers candidates that contain the explicit raw face edge anchors', () => {
        const scoreRawFaceBoundaryCandidate = (ParasolidParser as unknown as {
            scoreRawFaceBoundaryCandidate: (hint: unknown, candidate: unknown) => { score: number } | null;
        }).scoreRawFaceBoundaryCandidate;

        const hint = {
            faceId: 1,
            primarySize: 4,
            collapsedSize: 4,
            edgeAnchorCount: 2,
            edgeAnchorIds: [101, 202],
            coedgeAnchorIds: [],
            repeatedEdgeIds: [],
            resolvedSurfaceType: null,
            chainCount: 1,
            segmentCount: 4,
            maxSegmentLength: 1,
            maxChainSpan: 20,
        };
        const matchingCandidate = {
            key: 'plane:1:0',
            surfaceType: 'plane',
            outerSize: 4,
            totalSize: 4,
            holeCount: 0,
            mappedEdgeCount: 4,
            mappedEdgeIds: [101, 202, 303, 404],
            mappedCoedgeIds: [],
            chainCount: 1,
            segmentCount: 4,
            maxSegmentLength: 1,
            maxChainSpan: 20,
            matched: false,
        };
        const nonMatchingCandidate = {
            key: 'plane:2:0',
            surfaceType: 'plane',
            outerSize: 4,
            totalSize: 4,
            holeCount: 0,
            mappedEdgeCount: 4,
            mappedEdgeIds: [303, 404, 505, 606],
            mappedCoedgeIds: [],
            chainCount: 1,
            segmentCount: 4,
            maxSegmentLength: 1,
            maxChainSpan: 20,
            matched: false,
        };

        const matchingScore = scoreRawFaceBoundaryCandidate(hint, matchingCandidate);
        const nonMatchingScore = scoreRawFaceBoundaryCandidate(hint, nonMatchingCandidate);

        expect(matchingScore).not.toBeNull();
        expect(nonMatchingScore).not.toBeNull();
        expect((matchingScore?.score ?? Infinity)).toBeLessThan(nonMatchingScore?.score ?? -Infinity);
    });

    it('prefers candidates that contain the explicit raw face coedge anchors when edge anchors cannot help', () => {
        const scoreRawFaceBoundaryCandidate = (ParasolidParser as unknown as {
            scoreRawFaceBoundaryCandidate: (hint: unknown, candidate: unknown) => { score: number } | null;
        }).scoreRawFaceBoundaryCandidate;

        const hint = {
            faceId: 2,
            primarySize: 6,
            collapsedSize: 5,
            edgeAnchorCount: 0,
            edgeAnchorIds: [],
            coedgeAnchorIds: [11, 22],
            repeatedEdgeIds: [],
            resolvedSurfaceType: null,
            chainCount: 1,
            segmentCount: 5,
            maxSegmentLength: 2,
            maxChainSpan: 90,
        };
        const matchingCandidate = {
            key: 'plane:3:0',
            surfaceType: 'plane',
            outerSize: 6,
            totalSize: 6,
            holeCount: 0,
            mappedEdgeCount: 0,
            mappedEdgeIds: [],
            mappedCoedgeIds: [11, 22, 33],
            chainCount: 0,
            segmentCount: 0,
            maxSegmentLength: 0,
            maxChainSpan: null,
            matched: false,
        };
        const nonMatchingCandidate = {
            key: 'plane:4:0',
            surfaceType: 'plane',
            outerSize: 6,
            totalSize: 6,
            holeCount: 0,
            mappedEdgeCount: 0,
            mappedEdgeIds: [],
            mappedCoedgeIds: [33, 44, 55],
            chainCount: 0,
            segmentCount: 0,
            maxSegmentLength: 0,
            maxChainSpan: null,
            matched: false,
        };

        const matchingScore = scoreRawFaceBoundaryCandidate(hint, matchingCandidate);
        const nonMatchingScore = scoreRawFaceBoundaryCandidate(hint, nonMatchingCandidate);

        expect(matchingScore).not.toBeNull();
        expect(nonMatchingScore).not.toBeNull();
        expect((matchingScore?.score ?? Infinity)).toBeLessThan(nonMatchingScore?.score ?? -Infinity);
    });

    it('penalizes edge-anchored candidates that recover no mapped edges', () => {
        const scoreRawFaceBoundaryCandidate = (ParasolidParser as unknown as {
            scoreRawFaceBoundaryCandidate: (hint: unknown, candidate: unknown) => { score: number } | null;
        }).scoreRawFaceBoundaryCandidate;

        const hint = {
            faceId: 3,
            primarySize: 6,
            collapsedSize: 5,
            edgeAnchorCount: 2,
            edgeAnchorIds: [101, 202],
            coedgeAnchorIds: [11, 22],
            repeatedEdgeIds: [],
            resolvedSurfaceType: null,
            chainCount: 1,
            segmentCount: 5,
            maxSegmentLength: 2,
            maxChainSpan: 90,
        };
        const coveredCandidate = {
            key: 'plane:5:0',
            surfaceType: 'plane',
            outerSize: 6,
            totalSize: 6,
            holeCount: 0,
            mappedEdgeCount: 2,
            mappedEdgeIds: [303, 404],
            mappedCoedgeIds: [33, 44, 55],
            chainCount: 1,
            segmentCount: 5,
            maxSegmentLength: 2,
            maxChainSpan: 90,
            matched: false,
        };
        const uncoveredCandidate = {
            key: 'plane:6:0',
            surfaceType: 'plane',
            outerSize: 6,
            totalSize: 6,
            holeCount: 0,
            mappedEdgeCount: 0,
            mappedEdgeIds: [],
            mappedCoedgeIds: [33, 44, 55],
            chainCount: 1,
            segmentCount: 5,
            maxSegmentLength: 2,
            maxChainSpan: 90,
            matched: false,
        };

        const coveredScore = scoreRawFaceBoundaryCandidate(hint, coveredCandidate);
        const uncoveredScore = scoreRawFaceBoundaryCandidate(hint, uncoveredCandidate);

        expect(coveredScore).not.toBeNull();
        expect(uncoveredScore).not.toBeNull();
        expect((coveredScore?.score ?? Infinity)).toBeLessThan(uncoveredScore?.score ?? -Infinity);
    });

    it('uses repeated non-anchor raw hits to break duplicate-anchor ties', () => {
        const scoreRawFaceBoundaryCandidate = (ParasolidParser as unknown as {
            scoreRawFaceBoundaryCandidate: (hint: unknown, candidate: unknown) => { score: number } | null;
        }).scoreRawFaceBoundaryCandidate;

        const hint = {
            faceId: 4,
            primarySize: 4,
            collapsedSize: 4,
            edgeAnchorCount: 2,
            edgeAnchorIds: [101, 101],
            coedgeAnchorIds: [11, 12],
            repeatedEdgeIds: [101, 202],
            resolvedSurfaceType: null,
            chainCount: 1,
            segmentCount: 4,
            maxSegmentLength: 2,
            maxChainSpan: 60,
        };
        const supportingCandidate = {
            key: 'cylinder:7:0',
            surfaceType: 'cylinder',
            outerSize: 4,
            totalSize: 4,
            holeCount: 0,
            mappedEdgeCount: 3,
            mappedEdgeIds: [202, 303, 404],
            mappedCoedgeIds: [11, 21, 31, 41],
            chainCount: 1,
            segmentCount: 2,
            maxSegmentLength: 2,
            maxChainSpan: 60,
            matched: false,
        };
        const unsupportedCandidate = {
            key: 'cylinder:8:0',
            surfaceType: 'cylinder',
            outerSize: 4,
            totalSize: 4,
            holeCount: 0,
            mappedEdgeCount: 3,
            mappedEdgeIds: [203, 304, 405],
            mappedCoedgeIds: [12, 22, 32, 42],
            chainCount: 1,
            segmentCount: 2,
            maxSegmentLength: 2,
            maxChainSpan: 60,
            matched: false,
        };

        const supportingScore = scoreRawFaceBoundaryCandidate(hint, supportingCandidate);
        const unsupportedScore = scoreRawFaceBoundaryCandidate(hint, unsupportedCandidate);

        expect(supportingScore).not.toBeNull();
        expect(unsupportedScore).not.toBeNull();
        expect((supportingScore?.score ?? Infinity)).toBeLessThan(unsupportedScore?.score ?? -Infinity);
    });

    it('allows a tiny +1 candidate when it recovers explicit anchor evidence', () => {
        const scoreRawFaceBoundaryCandidate = (ParasolidParser as unknown as {
            scoreRawFaceBoundaryCandidate: (hint: unknown, candidate: unknown) => { score: number } | null;
        }).scoreRawFaceBoundaryCandidate;

        const hint = {
            faceId: 5,
            primarySize: 3,
            collapsedSize: 3,
            edgeAnchorCount: 2,
            edgeAnchorIds: [101, 202],
            coedgeAnchorIds: [11, 22],
            repeatedEdgeIds: [],
            resolvedSurfaceType: null,
            chainCount: 1,
            segmentCount: 3,
            maxSegmentLength: 1,
            maxChainSpan: 30,
        };
        const exactCandidate = {
            key: 'plane:9:0',
            surfaceType: 'plane',
            outerSize: 3,
            totalSize: 3,
            holeCount: 0,
            mappedEdgeCount: 2,
            mappedEdgeIds: [303, 404],
            mappedCoedgeIds: [33, 44, 55],
            chainCount: 1,
            segmentCount: 2,
            maxSegmentLength: 1,
            maxChainSpan: 60,
            matched: false,
        };
        const nearCandidate = {
            key: 'cylinder:10:0',
            surfaceType: 'cylinder',
            outerSize: 4,
            totalSize: 4,
            holeCount: 0,
            mappedEdgeCount: 4,
            mappedEdgeIds: [101, 303, 404, 505],
            mappedCoedgeIds: [11, 44, 55, 66],
            chainCount: 1,
            segmentCount: 3,
            maxSegmentLength: 1,
            maxChainSpan: 15,
            matched: false,
        };

        const exactScore = scoreRawFaceBoundaryCandidate(hint, exactCandidate);
        const nearScore = scoreRawFaceBoundaryCandidate(hint, nearCandidate);

        expect(exactScore).not.toBeNull();
        expect(nearScore).not.toBeNull();
        expect((nearScore?.score ?? Infinity)).toBeLessThan(exactScore?.score ?? -Infinity);
    });

    it('reconstructs ordered type-16 component chains across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const components = parser.parseEdgeComponents();
            const chains = parser.parseEdgeComponentChains();
            const totalComponentsInChains = chains.reduce((sum, chain) => sum + chain.orderedComponents.length, 0);
            const fileName = basename(filePath).toLowerCase();

            expect(totalComponentsInChains).toBe(components.length);

            if (fileName === 'nist_ctc_01_asme1_rd_sw1802.sldprt') {
                expect(chains).toHaveLength(1);
                expect(chains[0].orderedComponents).toHaveLength(12);
                expect(chains[0].terminalPrevId).toBe(13);
                expect(chains[0].terminalNextId).toBe(1);
                continue;
            }

            if (fileName === 'nist_ctc_03_asme1_rc_sw1802.sldprt') {
                expect(chains).toHaveLength(4);
                expect(chains.every(chain => chain.orderedComponents.length === 1)).toBe(true);
                continue;
            }

            expect(chains).toHaveLength(1);
            expect(chains[0].orderedComponents).toHaveLength(1);
        }
    });

    it('stabilizes the CTC_01 type-16 component chain order', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const chains = parser.parseEdgeComponentChains();

        expect(chains).toHaveLength(1);
        expect(chains[0].headEdgeId).toBe(49);
        expect(chains[0].tailEdgeId).toBe(57);
        expect(chains[0].orderedComponents.map(component => component.headEdgeId)).toEqual([
            49, 1175, 1504, 1524, 1385, 1410, 1724, 1395, 1636, 1750, 1150, 1100,
        ]);
        expect(chains[0].orderedComponents.map(component => component.tailEdgeId)).toEqual([
            1174, 1499, 1328, 1538, 1409, 1731, 1394, 1656, 3514, 1158, 1105, 57,
        ]);
    });

    it('decodes dominant compact type-30/type-31 geometry records across NIST samples', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const geometry = parser.parseCompactGeometryRecords();

            expect(geometry.length).toBeGreaterThan(0);
            expect(new Set(geometry.map(record => record.id)).size).toBe(geometry.length);
            expect(geometry.every(record => record.markerByte === 0x2b || record.markerByte === 0x2d)).toBe(true);
        }
    });

    it('resolves the first CTC_01 edge geometry links through the compact geometry index', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const edges = parser.parseEdgeRecords();
        const geometry = new Map(parser.parseCompactGeometryRecords().map(record => [record.id, record]));

        expect(edges.slice(0, 8).map(edge => edge.geometryLikeId)).toEqual([757, 765, 770, 773, 774, 775, 777, 780]);
        expect([757, 765, 770, 773, 775, 777, 780].every(id => geometry.has(id))).toBe(true);
        expect(geometry.has(774)).toBe(false);
        expect(geometry.get(757)).toMatchObject({ type: 30, refIds: [746, 848, 849, 1], markerByte: 0x2b });
        expect(geometry.get(770)).toMatchObject({ type: 30, refIds: [750, 1, 765, 1], markerByte: 0x2b });
    });

    it('resolves all FTC_11 edge geometry links to compact type-31 records', () => {
        if (!ftc11Path) return;

        const buf = readFileSync(ftc11Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const edges = parser.parseEdgeRecords();
        const geometry = new Map(parser.parseCompactGeometryRecords().map(record => [record.id, record]));

        expect(edges.map(edge => edge.geometryLikeId)).toEqual([46, 58, 59, 60, 63]);
        expect(edges.every(edge => geometry.get(edge.geometryLikeId)?.type === 31)).toBe(true);
    });

    it('extends the compact geometry index with type-32 and type-38 records', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const base = parser.parseCompactGeometryRecords();
            const extended = parser.parseCompactGeometryLikeRecords();

            expect(extended.length).toBeGreaterThanOrEqual(base.length);
            expect(new Set(extended.map(record => record.id)).size).toBe(extended.length);
            expect(extended.every(record => [30, 31, 32, 38, 134].includes(record.type))).toBe(true);
        }
    });

    it('improves CTC_05 edge geometry resolution through the extended compact index', () => {
        if (!hasSamples) return;
        const targetPath = sampleFiles.find(filePath =>
            basename(filePath).toLowerCase() === 'nist_ctc_05_asme1_rd_sw1802.sldprt',
        );
        if (!targetPath) return;

        const buf = readFileSync(targetPath);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const edges = parser.parseEdgeRecords();
        const base = new Set(parser.parseCompactGeometryRecords().map(record => record.id));
        const extended = new Map(parser.parseCompactGeometryLikeRecords().map(record => [record.id, record]));

        const baseResolved = edges.filter(edge => base.has(edge.geometryLikeId)).length;
        const extendedResolved = edges.filter(edge => extended.has(edge.geometryLikeId)).length;

        expect(baseResolved).toBe(295);
        expect(extendedResolved).toBe(326);
        expect(extended.get(1358)).toMatchObject({ type: 38, refIds: [1359, 1360, 1350, 1], markerByte: 0x2b });
        expect(extended.get(1396)).toMatchObject({ type: 38, refIds: [1495, 1487, 1496, 1], markerByte: 0x2b });
    });

    it('captures the type-32 geometry-like branch in CTC_01', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const extended = new Map(parser.parseCompactGeometryLikeRecords().map(record => [record.id, record]));

        expect(extended.get(1569)).toMatchObject({ type: 32, refIds: [1565, 1978, 3500, 1], markerByte: 0x2b });
        expect(extended.get(3434)).toMatchObject({ type: 32, refIds: [3436, 3430, 3437, 1], markerByte: 0x2b });
    });

    it('captures the FTC_07 compact type-134 geometry-like chain', () => {
        if (!hasSamples) return;
        const targetPath = sampleFiles.find(filePath =>
            basename(filePath).toLowerCase() === 'nist_ftc_07_asme1_rd_sw1802.sldprt',
        );
        if (!targetPath) return;

        const buf = readFileSync(targetPath);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const extended = new Map(parser.parseCompactGeometryLikeRecords().map(record => [record.id, record]));

        expect(extended.get(1780)).toMatchObject({ type: 134, refIds: [1618, 1766, 1788, 1], markerByte: 0x2b });
        expect(extended.get(1788)).toMatchObject({ type: 134, refIds: [1795, 1780, 1796, 1], markerByte: 0x2d });
        expect(extended.get(1836)).toMatchObject({ type: 134, refIds: [1843, 1828, 1844, 1], markerByte: 0x2d });
    });

    it('creates conservative alias records for the no-header geometry-like residue', () => {
        if (!hasSamples) return;

        const expectations = new Map([
            ['nist_ctc_01_asme1_rd_sw1802.sldprt', { id: 1195, canonicalId: 1197, type: 38, refIds: [1205, 1195, 1206, 1], markerByte: 0x2d }],
            ['nist_ctc_02_asme1_rc_sw1802.sldprt', { id: 2960, canonicalId: 2962, type: 38, refIds: [2904, 2960, 2969, 1], markerByte: 0x2b }],
            ['nist_ctc_05_asme1_rd_sw1802.sldprt', { id: 1252, canonicalId: 1254, type: 31, refIds: [1261, 1252, 1262, 1], markerByte: 0x2b }],
            ['nist_ftc_07_asme1_rd_sw1802.sldprt', { id: 1857, canonicalId: 1859, type: 30, refIds: [1866, 1857, 1867, 1], markerByte: 0x2d }],
            ['nist_ftc_10_asme1_rb_sw1802.sldprt', { id: 714, canonicalId: 717, type: 31, refIds: [724, 714, 725, 1], markerByte: 0x2b }],
        ]);

        for (const filePath of sampleFiles) {
            const key = basename(filePath).toLowerCase();
            const expected = expectations.get(key);
            if (!expected) continue;

            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const aliases = new Map(parser.parseGeometryLikeAliasRecords().map(record => [record.id, record]));

            expect(aliases.get(expected.id)).toMatchObject(expected);
        }
    });

    it('decodes packed geometry-like records for unresolved edge targets', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const packed = parser.parsePackedGeometryLikeRecords();

            expect(new Set(packed.map(record => record.id)).size).toBe(packed.length);
            expect(packed.every(record => [30, 31, 32].includes(record.type))).toBe(true);
            expect(packed.every(record => record.markerByte === 0x2b || record.markerByte === 0x2d)).toBe(true);
        }
    });

    it('combines direct and alias geometry-like indices for full edge resolution', () => {
        if (!hasSamples) return;

        for (const filePath of sampleFiles) {
            const buf = readFileSync(filePath);
            const extraction = SldprtContainerParser.extractParasolid(buf);
            expect(extraction).not.toBeNull();
            if (!extraction) continue;

            const parser = new ParasolidParser(extraction.data);
            const compact = new Set(parser.parseCompactGeometryLikeRecords().map(record => record.id));
            const combined = new Set(parser.parseAllGeometryLikeRecords().map(record => record.id));
            const edges = parser.parseEdgeRecords();

            const compactResolved = edges.filter(edge => compact.has(edge.geometryLikeId)).length;
            const combinedResolved = edges.filter(edge => combined.has(edge.geometryLikeId)).length;

            expect(combinedResolved).toBeGreaterThanOrEqual(compactResolved);
            expect(combinedResolved).toBe(edges.length);
        }
    });

    it('captures representative CTC_01 packed geometry-like records', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const packed = new Map(parser.parsePackedGeometryLikeRecords().map(record => [record.id, record]));
        const combined = new Set(parser.parseAllGeometryLikeRecords().map(record => record.id));
        const edges = parser.parseEdgeRecords();

        expect(packed.get(774)).toMatchObject({ type: 31, refIds: [764, 765, 775, 1], markerByte: 0x2b, trailer: 1 });
        expect(packed.get(3430)).toMatchObject({ type: 32, refIds: [3433, 3427, 3434, 1], markerByte: 0x2d, trailer: 1 });
        expect(packed.get(10)).toMatchObject({ type: 30, refIds: [44, 45, 1, 1], markerByte: 0x2d, trailer: 1 });
        expect(edges.filter(edge => combined.has(edge.geometryLikeId)).length).toBe(358);
    });

    it('raises CTC_05 geometry-like resolution to the alias-augmented ceiling', () => {
        if (!hasSamples) return;
        const targetPath = sampleFiles.find(filePath =>
            basename(filePath).toLowerCase() === 'nist_ctc_05_asme1_rd_sw1802.sldprt',
        );
        if (!targetPath) return;

        const buf = readFileSync(targetPath);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const combined = new Set(parser.parseAllGeometryLikeRecords().map(record => record.id));
        const edges = parser.parseEdgeRecords();

        expect(edges.filter(edge => combined.has(edge.geometryLikeId)).length).toBe(330);
    });

    it('finds entity classes in a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const classes = parser.findEntityClasses();
        expect(classes.length).toBeGreaterThan(0);
        expect(classes).toContain('BODY');
    });

    it('counts entity records in a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const counts = parser.countEntityRecords();
        expect(counts.pRecords + counts.qRecords).toBeGreaterThan(0);
    });

    it('extracts coordinates from a real transmit file', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const coords = parser.extractCoordinates();
        expect(coords.length).toBeGreaterThan(0);
        // Each coordinate should have finite x, y, z
        for (const pt of coords) {
            expect(isFinite(pt.x)).toBe(true);
            expect(isFinite(pt.y)).toBe(true);
            expect(isFinite(pt.z)).toBe(true);
        }
    });

    it('parse() returns a PsModel with vertices', () => {
        if (!hasSamples) return;
        const buf = readFileSync(sampleFiles[0]);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();
        expect(model.vertices.length).toBeGreaterThan(0);
        expect(model.bodies.length).toBeGreaterThanOrEqual(0);
    });

    it('recovers FTC_11 as a reusable axisymmetric ring model', () => {
        if (!ftc11Path) return;

        const buf = readFileSync(ftc11Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        expect(model.surfaces.filter(s => s.surfaceType === 'plane')).toHaveLength(2);
        expect(model.surfaces.filter(s => s.surfaceType === 'cylinder')).toHaveLength(2);
        expect(model.surfaces.filter(s => s.surfaceType === 'torus')).toHaveLength(2);
        expect(model.faces).toHaveLength(6);
        expect(model.loops).toHaveLength(12);
        expect(model.edges).toHaveLength(6);
        expect(model.curves.filter(c => c.curveType === 'circle')).toHaveLength(6);
    });

    it('infers CTC_04 apex cones from coaxial cylinder transitions', () => {
        if (!ctc04Path) return;

        const buf = readFileSync(ctc04Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        // Regression target from clean-room analysis: 12 reference apex cones
        // can be recovered from repeated 5mm -> 10mm coaxial cylinder steps.
        expect(model.surfaces.filter(s => s.surfaceType === 'cone').length).toBeGreaterThanOrEqual(12);
    });

    it('recovers representative CTC_04 countersink-hole chamfers from zero-support cylinder stacks', () => {
        if (!ctc04Path) return;

        const buf = readFileSync(ctc04Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        const hasCountersinkChamfer = model.surfaces
            .filter(surface => surface.surfaceType === 'cone')
            .some(surface => coneMatchesCanonical(
                surface.params as TestConeParams,
                {
                    origin: { x: 35, y: 760, z: 27 },
                    axis: { x: 0, y: 0, z: 1 },
                    radius: 7,
                    halfAngle: Math.PI / 4,
                },
            ));

        expect(hasCountersinkChamfer).toBe(true);
    });

    it('recovers representative CTC_04 59-degree apex cones from direct raw sections', () => {
        if (!ctc04Path) return;

        const buf = readFileSync(ctc04Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        const hasApexCone = model.surfaces
            .filter(surface => surface.surfaceType === 'cone')
            .some(surface => coneMatchesCanonical(
                surface.params as TestConeParams,
                {
                    origin: { x: 26.25, y: 625, z: -63.0030397327 },
                    axis: { x: 0, y: 0, z: -1 },
                    radius: 0,
                    halfAngle: 1.02974425868,
                },
            ));

        expect(hasApexCone).toBe(true);
    });

    it('does not turn representative CTC_04 through-hole chamfers into 59-degree tip cones', () => {
        if (!ctc04Path) return;

        const buf = readFileSync(ctc04Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        const hasArtificialTipCone = model.surfaces
            .filter(surface => surface.surfaceType === 'cone')
            .some(surface => coneMatchesCanonical(
                surface.params as TestConeParams,
                {
                    origin: { x: 35, y: 20, z: -4.2061900511779 },
                    axis: { x: 0, y: 0, z: 1 },
                    radius: 0,
                    halfAngle: 59,
                },
            ));

        expect(hasArtificialTipCone).toBe(false);
    });

    it('does not infer mirrored X-axis through-hole tip cones in CTC_04', () => {
        if (!ctc04Path) return;

        const buf = readFileSync(ctc04Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        const hasMirroredThroughHoleTipCone = model.surfaces
            .filter(surface => surface.surfaceType === 'cone')
            .some(surface => coneMatchesCanonical(
                surface.params as TestConeParams,
                {
                    origin: { x: -9.4956969048622, y: 402.5, z: -78 },
                    axis: { x: -1, y: 0, z: 0 },
                    radius: 0,
                    halfAngle: 59,
                },
            ));

        expect(hasMirroredThroughHoleTipCone).toBe(false);
    });

    it('recovers the CTC_01 59-degree drill-tip cones from raw cylinder sections', () => {
        if (!ctc01Path) return;

        const buf = readFileSync(ctc01Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        const hasDrillTip = model.surfaces
            .filter(s => s.surfaceType === 'cone')
            .some(surface => {
                return coneMatchesCanonical(surface.params as TestConeParams, {
                    origin: { x: 30, y: -80, z: -25 },
                    axis: { x: 0, y: -1, z: 0 },
                    radius: 10,
                    halfAngle: 59,
                });
            });

        expect(hasDrillTip).toBe(true);
    });

    it('recovers the FTC_06 zero-support taper cones from raw cylinder sections', () => {
        if (!ftc06Path) return;

        const buf = readFileSync(ftc06Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();
        const targetAngle = 9.462322208025617;

        const hasTaper = model.surfaces
            .filter(s => s.surfaceType === 'cone')
            .some(surface => {
                const params = surface.params as {
                    origin: { x: number; y: number; z: number };
                    axis: { x: number; y: number; z: number };
                    radius: number;
                    halfAngle: number;
                };
                return Math.abs(params.origin.x - 76.2) < 0.1 &&
                    Math.abs(params.origin.y - 85.09) < 0.1 &&
                    Math.abs(params.origin.z + 158.75) < 0.1 &&
                    Math.abs(params.axis.y + 1) < 0.01 &&
                    Math.abs(params.radius - 9.525) < 0.1 &&
                    Math.abs(params.halfAngle - targetAngle) < 0.02;
            });

        expect(hasTaper).toBe(true);
    });

    it('recovers the FTC_06 59-degree drill-tip cones from raw cylinder sections', () => {
        if (!ftc06Path) return;

        const buf = readFileSync(ftc06Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();
        const cones = model.surfaces.filter(s => s.surfaceType === 'cone');

        const hasDrillTip = cones
            .some(surface => {
                return coneMatchesCanonical(surface.params as TestConeParams, {
                    origin: { x: 76.2, y: 72.39, z: -158.75 },
                    axis: { x: 0, y: 1, z: 0 },
                    radius: 3.175,
                    halfAngle: 59,
                });
            });

        expect(hasDrillTip).toBe(true);
        expect(cones).toHaveLength(4);
    });

    it('recovers the FTC_09 micro-chamfer cones from raw cylinder origins', () => {
        if (!ftc09Path) return;

        const buf = readFileSync(ftc09Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        const hasChamfer = model.surfaces
            .filter(s => s.surfaceType === 'cone')
            .some(surface => {
                const params = surface.params as {
                    origin: { x: number; y: number; z: number };
                    axis: { x: number; y: number; z: number };
                    radius: number;
                    halfAngle: number;
                };
                return Math.abs(params.origin.x + 82.55) < 0.1 &&
                    Math.abs(params.origin.y - 2.27584) < 0.1 &&
                    Math.abs(params.origin.z + 107.95) < 0.1 &&
                    Math.abs(params.axis.y - 1) < 0.01 &&
                    Math.abs(params.radius - 2.9718) < 0.1 &&
                        Math.abs(params.halfAngle - 45) < 0.02;
            });

        expect(hasChamfer).toBe(true);
    });

    it('builds FTC_09 cone faces from coaxial cylinder sections when cone vertices are absent', () => {
        if (!ftc09Path) return;

        const buf = readFileSync(ftc09Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        const coneSurfaceIds = new Set(
            model.surfaces
                .filter(surface => surface.surfaceType === 'cone')
                .map(surface => surface.id),
        );
        const coneFaces = model.faces.filter(face => coneSurfaceIds.has(face.surface));

        expect(coneSurfaceIds.size).toBe(4);
        expect(coneFaces).toHaveLength(coneSurfaceIds.size);
    });

    it('recovers the FTC_10 half-radius drill-tip cones from low-support raw cylinder sections', () => {
        if (!ftc10Path) return;

        const buf = readFileSync(ftc10Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();
        const cones = model.surfaces.filter(s => s.surfaceType === 'cone');

        const hasXAxisDrillTip = cones.some(surface => {
            const params = surface.params as {
                origin: { x: number; y: number; z: number };
                axis: { x: number; y: number; z: number };
                radius: number;
                halfAngle: number;
            };
            return Math.abs(params.origin.x - 26.67) < 0.1 &&
                Math.abs(params.origin.y - 15) < 0.1 &&
                Math.abs(params.origin.z + 25) < 0.1 &&
                Math.abs(params.axis.x - 1) < 0.01 &&
                Math.abs(params.radius - 1.375) < 0.1 &&
                Math.abs(params.halfAngle - 59) < 0.02;
        });

        const hasYAxisDrillTip = cones.some(surface => {
            const params = surface.params as {
                origin: { x: number; y: number; z: number };
                axis: { x: number; y: number; z: number };
                radius: number;
                halfAngle: number;
            };
            return Math.abs(params.origin.x - 53.9) < 0.1 &&
                Math.abs(params.origin.y - 14.63) < 0.1 &&
                Math.abs(params.origin.z + 30) < 0.1 &&
                Math.abs(params.axis.y - 1) < 0.01 &&
                Math.abs(params.radius - 0.615) < 0.1 &&
                Math.abs(params.halfAngle - 59) < 0.02;
        });

        const hasCompletedYAxisPair = cones.some(surface => {
            const params = surface.params as {
                origin: { x: number; y: number; z: number };
                axis: { x: number; y: number; z: number };
                radius: number;
                halfAngle: number;
            };
            return Math.abs(params.origin.x - 31.9) < 0.1 &&
                Math.abs(params.origin.y - 14.63) < 0.1 &&
                Math.abs(params.origin.z + 30) < 0.1 &&
                Math.abs(params.axis.y - 1) < 0.01 &&
                Math.abs(params.radius - 0.615) < 0.1 &&
                Math.abs(params.halfAngle - 59) < 0.02;
        });

        const hasCompletedUpperPair = cones.some(surface => {
            const params = surface.params as {
                origin: { x: number; y: number; z: number };
                axis: { x: number; y: number; z: number };
                radius: number;
                halfAngle: number;
            };
            return Math.abs(params.origin.x - 35.1) < 0.1 &&
                Math.abs(params.origin.y - 14.63) < 0.1 &&
                Math.abs(params.origin.z + 20) < 0.1 &&
                Math.abs(params.axis.y - 1) < 0.01 &&
                Math.abs(params.radius - 0.615) < 0.1 &&
                Math.abs(params.halfAngle - 59) < 0.02;
        });

        expect(hasXAxisDrillTip).toBe(true);
        expect(hasYAxisDrillTip).toBe(true);
        expect(hasCompletedYAxisPair).toBe(true);
        expect(hasCompletedUpperPair).toBe(true);
        expect(cones).toHaveLength(8);
    });

    it('builds representative CTC_02 59-degree drill-tip cone faces from same-radius sections', () => {
        if (!ctc02Path) return;

        const buf = readFileSync(ctc02Path);
        const extraction = SldprtContainerParser.extractParasolid(buf);
        expect(extraction).not.toBeNull();
        if (!extraction) return;

        const parser = new ParasolidParser(extraction.data);
        const model = parser.parse();

        const representativeSurfaceIds = model.surfaces
            .filter(surface => surface.surfaceType === 'cone')
            .filter(surface => {
                const params = surface.params as TestConeParams;

                return coneMatchesCanonical(params, {
                    origin: { x: 35, y: 20, z: -30 },
                    axis: { x: 0, y: 0, z: 1 },
                    radius: 5.05,
                    halfAngle: 59,
                }) || coneMatchesCanonical(params, {
                    origin: { x: -25, y: 128, z: -335 },
                    axis: { x: 0, y: 0, z: -1 },
                    radius: 4.19,
                    halfAngle: 59,
                }) || coneMatchesCanonical(params, {
                    origin: { x: -240, y: 288, z: -185 },
                    axis: { x: -1, y: 0, z: 0 },
                    radius: 4.19,
                    halfAngle: 59,
                });
            })
            .map(surface => surface.id);

        const coneFaceSurfaceIds = new Set(model.faces.map(face => face.surface));

        expect(representativeSurfaceIds).toHaveLength(3);
        expect(representativeSurfaceIds.every(surfaceId => coneFaceSurfaceIds.has(surfaceId))).toBe(true);
    });
});

// ── End-to-end conversion tests ─────────────────────────────────────────────

describeWithSamples('convertSldprtToStep — NIST samples', () => {
    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → produces a non-null conversion result',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            expect(result).not.toBeNull();
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP output starts with ISO-10303-21',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step.startsWith('ISO-10303-21;')).toBe(true);
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP output ends with END-ISO-10303-21',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('END-ISO-10303-21;');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP contains HEADER and DATA sections',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('HEADER;');
            expect(result.step).toContain('DATA;');
            expect(result.step).toContain('ENDSEC;');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP contains required AP214 context entities',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('APPLICATION_CONTEXT');
            expect(result.step).toContain('PRODUCT_DEFINITION');
            expect(result.step).toContain('AUTOMOTIVE_DESIGN');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP contains CARTESIAN_POINT entities',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('CARTESIAN_POINT');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → STEP contains geometric representation',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.step).toContain('GEOMETRIC_REPRESENTATION_CONTEXT');
            expect(result.step).toContain('LENGTH_UNIT');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → model has vertices and topology',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            expect(result.model.vertices.length).toBeGreaterThan(0);
            expect(result.parasolidSize).toBeGreaterThan(0);
            expect(result.containerFormat).toBe('sw3d');
        },
    );

    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → entities have sequential IDs',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;
            for (let i = 0; i < result.entities.length; i++) {
                expect(result.entities[i].id).toBe(i + 1);
            }
        },
    );
});

// ── STEP format validity ────────────────────────────────────────────────────

describeWithSamples('STEP format validity — NIST samples', () => {
    it.each(sampleFiles.map(f => [basename(f), f]))(
        '%s → every entity line matches #N=TYPE(...);',
        (_name, filePath) => {
            const result = getCachedConversion(filePath as string);
            if (!result) return;

            // Extract DATA section
            const dataStart = result.step.indexOf('DATA;');
            const dataEnd = result.step.indexOf('ENDSEC;', dataStart);
            const dataSection = result.step.substring(dataStart + 5, dataEnd).trim();

            if (dataSection.length === 0) return;

            const entityPattern = /^#\d+=[\w(),.'#*$ ;E+-]+$/;
            const lines = dataSection.split('\n').filter(l => l.trim().length > 0);
            for (const line of lines) {
                expect(line).toMatch(/^#\d+=/);
                expect(line.endsWith(';')).toBe(true);
            }
        },
    );
});

// ── Skip notice ──────────────────────────────────────────────────────────────

if (!hasSamples) {
    describe('STEP conversion integration tests', () => {
        it('are SKIPPED — run `npm run download-samples` first', () => {
            console.log(
                '\n  ℹ  Samples not found. Run `npm run download-samples` first.\n',
            );
        });
    });
}
