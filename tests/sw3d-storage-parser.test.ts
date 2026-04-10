/**
 * sw3d-storage-parser.test.ts
 *
 * Unit tests for Sw3DStorageParser and related helpers.
 * Uses synthetic section buffers to exercise the parsing logic.
 */

import { deflateRawSync } from 'node:zlib';
import {
    Sw3DStorageParser,
    SW3D_SECTION_MARKER,
    SW3D_HEADER_SIZE,
    isParasolidBuffer,
    PARASOLID_MAGIC_SIGNATURES,
} from '../src/parser/Sw3DStorageParser.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a synthetic SW 3D Storage buffer that contains one section whose
 * decompressed payload begins with `magic`.
 */
function buildSyntheticSw3dBuffer(payloadMagic: Buffer): Buffer {
    const uncompressedPayload = Buffer.concat([
        payloadMagic,
        Buffer.alloc(64, 0x41), // padding 'A' bytes
    ]);
    const compressed = deflateRawSync(uncompressedPayload);

    const metadata = Buffer.alloc(10, 0x00); // 10-byte dummy metadata
    const nameLength = metadata.length;

    // Build fixed header fields after the 6-byte marker
    const fieldBuf = Buffer.alloc(20); // 4×u32 after the marker [6 bytes before this]
    fieldBuf.writeUInt32LE(0x12345678, 0);  // typeId
    fieldBuf.writeUInt32LE(0x00000000, 4);  // field1 (reserved)
    fieldBuf.writeUInt32LE(compressed.length, 8);    // compressedSize
    fieldBuf.writeUInt32LE(uncompressedPayload.length, 12); // decompressedSize
    fieldBuf.writeUInt32LE(nameLength, 16); // nameLength

    return Buffer.concat([
        SW3D_SECTION_MARKER,
        fieldBuf,
        metadata,
        compressed,
    ]);
}

// ── isParasolidBuffer ─────────────────────────────────────────────────────────

describe('isParasolidBuffer', () => {
    it('returns false for an empty buffer', () => {
        expect(isParasolidBuffer(Buffer.alloc(0))).toBe(false);
    });

    it('returns false for a buffer shorter than 4 bytes', () => {
        expect(isParasolidBuffer(Buffer.from([0x50, 0x5f]))).toBe(false);
    });

    it('returns true for a buffer starting with P_S_', () => {
        expect(isParasolidBuffer(Buffer.from('P_S_rest', 'ascii'))).toBe(true);
    });

    it('returns true for a buffer starting with PARA', () => {
        expect(isParasolidBuffer(Buffer.from('PARArest', 'ascii'))).toBe(true);
    });

    it('returns true for a buffer starting with PS-P', () => {
        expect(isParasolidBuffer(Buffer.from('PS-PART-1.0', 'ascii'))).toBe(true);
    });

    it('returns false for random non-Parasolid bytes', () => {
        expect(isParasolidBuffer(Buffer.from('PNG\x0d\x0a\x1a\x0a'))).toBe(false);
    });
});

// ── PARASOLID_MAGIC_SIGNATURES ────────────────────────────────────────────────

describe('PARASOLID_MAGIC_SIGNATURES', () => {
    it('contains at least one signature', () => {
        expect(PARASOLID_MAGIC_SIGNATURES.length).toBeGreaterThan(0);
    });

    it('every signature is exactly 4 bytes', () => {
        for (const sig of PARASOLID_MAGIC_SIGNATURES) {
            expect(sig.length).toBe(4);
        }
    });
});

// ── SW3D_SECTION_MARKER / SW3D_HEADER_SIZE constants ─────────────────────────

describe('SW3D constants', () => {
    it('SW3D_SECTION_MARKER is 6 bytes', () => {
        expect(SW3D_SECTION_MARKER.length).toBe(6);
    });

    it('SW3D_HEADER_SIZE is 26', () => {
        expect(SW3D_HEADER_SIZE).toBe(26);
    });
});

// ── extractParasolidSections ──────────────────────────────────────────────────

describe('Sw3DStorageParser.extractParasolidSections', () => {
    it('returns empty array for a random buffer with no section markers', () => {
        const result = Sw3DStorageParser.extractParasolidSections(
            Buffer.alloc(1024, 0xcc),
        );
        expect(result).toHaveLength(0);
    });

    it('returns empty array for a buffer that is too small', () => {
        expect(
            Sw3DStorageParser.extractParasolidSections(Buffer.alloc(10)),
        ).toHaveLength(0);
    });

    it('finds a Parasolid section encoded with P_S_ magic', () => {
        const magic = Buffer.from('P_S_', 'ascii');
        const buf = buildSyntheticSw3dBuffer(magic);
        const results = Sw3DStorageParser.extractParasolidSections(buf);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].data.subarray(0, 4)).toEqual(magic);
    });

    it('finds a Parasolid section encoded with PARA magic', () => {
        const magic = Buffer.from('PARA', 'ascii');
        const buf = buildSyntheticSw3dBuffer(magic);
        const results = Sw3DStorageParser.extractParasolidSections(buf);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].data.subarray(0, 4)).toEqual(magic);
    });

    it('ignores sections whose payload does not start with a Parasolid magic', () => {
        const magic = Buffer.from('\x89PNG', 'ascii'); // PNG magic, not Parasolid
        const buf = buildSyntheticSw3dBuffer(magic);
        const results = Sw3DStorageParser.extractParasolidSections(buf);
        expect(results).toHaveLength(0);
    });
});

// ── extractFirstParasolidSection ─────────────────────────────────────────────

describe('Sw3DStorageParser.extractFirstParasolidSection', () => {
    it('returns null when no Parasolid section exists', () => {
        expect(
            Sw3DStorageParser.extractFirstParasolidSection(Buffer.alloc(512)),
        ).toBeNull();
    });

    it('returns the first section when one exists', () => {
        const magic = Buffer.from('PS-P', 'ascii');
        const buf = buildSyntheticSw3dBuffer(magic);
        const result = Sw3DStorageParser.extractFirstParasolidSection(buf);
        expect(result).not.toBeNull();
        expect(result!.data.subarray(0, 4)).toEqual(magic);
    });
});
