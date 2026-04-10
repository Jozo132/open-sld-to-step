/**
 * ole-container-parser.test.ts
 *
 * Unit tests for OleContainerParser.
 * These tests use synthetic OLE2-like buffers to verify the parser's
 * behaviour without requiring real .SLDPRT files.
 */

import { OleContainerParser, OLE2_SIGNATURE, PARASOLID_STREAM_NAMES } from '../src/parser/OleContainerParser.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal valid OLE2 header in a 512-byte buffer. */
function buildMinimalOle2Header(): Buffer {
    const buf = Buffer.alloc(512, 0);

    // Signature
    OLE2_SIGNATURE.copy(buf, 0);

    // Minor version: 0x3E, Major version: 0x03
    buf.writeUInt16LE(0x003e, 24);
    buf.writeUInt16LE(0x0003, 26);

    // Byte order: little-endian
    buf.writeUInt16LE(0xfffe, 28);

    // Sector size exponent: 9 → 512-byte sectors
    buf.writeUInt16LE(9, 30);

    // Directory start sector: 0
    buf.writeUInt32LE(0, 48);

    // DIFAT chain start: FREESECT (0xFFFFFFFF)
    buf.writeInt32LE(-1, 68);

    // Mark all 109 DIFAT slots as FREESECT
    for (let i = 0; i < 109; i++) {
        buf.writeInt32LE(-1, 76 + i * 4);
    }

    return buf;
}

// ── Static method tests ────────────────────────────────────────────────────────

describe('OleContainerParser.isOle2', () => {
    it('returns true for a buffer starting with the OLE2 signature', () => {
        const buf = Buffer.alloc(16, 0);
        OLE2_SIGNATURE.copy(buf, 0);
        expect(OleContainerParser.isOle2(buf)).toBe(true);
    });

    it('returns false for a buffer that does not start with the OLE2 signature', () => {
        const buf = Buffer.alloc(16, 0);
        expect(OleContainerParser.isOle2(buf)).toBe(false);
    });

    it('returns false for a buffer shorter than 8 bytes', () => {
        const buf = Buffer.alloc(4, 0);
        expect(OleContainerParser.isOle2(buf)).toBe(false);
    });

    it('detects the OLE2 signature within OLE2_SIGNATURE constant itself', () => {
        const padded = Buffer.concat([OLE2_SIGNATURE, Buffer.alloc(8, 0)]);
        expect(OleContainerParser.isOle2(padded)).toBe(true);
    });
});

// ── Constructor error tests ────────────────────────────────────────────────────

describe('OleContainerParser constructor', () => {
    it('throws on a buffer that is too small', () => {
        expect(() => new OleContainerParser(Buffer.alloc(256))).toThrow(
            'Buffer too small to be a valid OLE2 file',
        );
    });

    it('throws when the OLE2 magic is absent', () => {
        expect(() => new OleContainerParser(Buffer.alloc(512))).toThrow(
            'Not an OLE2 compound file',
        );
    });
});

// ── PARASOLID_STREAM_NAMES ────────────────────────────────────────────────────

describe('PARASOLID_STREAM_NAMES', () => {
    it('contains "Contents"', () => {
        expect(PARASOLID_STREAM_NAMES).toContain('Contents');
    });

    it('contains "PowerContents"', () => {
        expect(PARASOLID_STREAM_NAMES).toContain('PowerContents');
    });
});

// ── OLE2_SIGNATURE ────────────────────────────────────────────────────────────

describe('OLE2_SIGNATURE', () => {
    it('is exactly 8 bytes', () => {
        expect(OLE2_SIGNATURE.length).toBe(8);
    });

    it('starts with 0xD0 0xCF', () => {
        expect(OLE2_SIGNATURE[0]).toBe(0xd0);
        expect(OLE2_SIGNATURE[1]).toBe(0xcf);
    });
});

// ── extractParasolidStream on a minimal but structurally incomplete file ────────

describe('OleContainerParser with minimal OLE2 header', () => {
    let parser: OleContainerParser;

    beforeEach(() => {
        // Build a 512-byte buffer: valid OLE2 sig + zeros everywhere else.
        // readChain(0) will return one sector of zeros.
        // The directory loop will see nameLen=0 everywhere → 0 entries.
        const buf = buildMinimalOle2Header();
        parser = new OleContainerParser(buf);
    });

    it('constructs successfully', () => {
        expect(parser).toBeDefined();
    });

    it('returns an empty entries array (no valid dir entries in zero-filled file)', () => {
        expect(parser.entries).toHaveLength(0);
    });

    it('returns null from extractStream for any name', () => {
        expect(parser.extractStream('Contents')).toBeNull();
    });

    it('returns null from extractParasolidStream', () => {
        expect(parser.extractParasolidStream()).toBeNull();
    });
});
