/**
 * sldprt-container-parser.test.ts
 *
 * Unit tests for the high-level SldprtContainerParser.
 */

import { deflateRawSync } from 'node:zlib';
import { SldprtContainerParser } from '../src/parser/SldprtContainerParser.js';
import { OLE2_SIGNATURE } from '../src/parser/OleContainerParser.js';
import { SW3D_SECTION_MARKER } from '../src/parser/Sw3DStorageParser.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildSw3dBuffer(payloadMagic: Buffer): Buffer {
    const payload = Buffer.concat([payloadMagic, Buffer.alloc(64, 0x41)]);
    const compressed = deflateRawSync(payload);
    const metadata = Buffer.alloc(10, 0x00);

    const fields = Buffer.alloc(20);
    fields.writeUInt32LE(0xdeadbeef, 0); // typeId
    fields.writeUInt32LE(0x00000000, 4);
    fields.writeUInt32LE(compressed.length, 8);
    fields.writeUInt32LE(payload.length, 12);
    fields.writeUInt32LE(metadata.length, 16);

    return Buffer.concat([SW3D_SECTION_MARKER, fields, metadata, compressed]);
}

// ── SldprtContainerParser.extractParasolid ────────────────────────────────────

describe('SldprtContainerParser.extractParasolid', () => {
    it('returns null for an empty buffer', () => {
        expect(SldprtContainerParser.extractParasolid(Buffer.alloc(0))).toBeNull();
    });

    it('returns null for a buffer with no recognisable container', () => {
        expect(
            SldprtContainerParser.extractParasolid(Buffer.alloc(512, 0xaa)),
        ).toBeNull();
    });

    it('returns a result with format="sw3d" for a synthetic SW 3D Storage buffer', () => {
        const magic = Buffer.from('P_S_', 'ascii');
        const buf = buildSw3dBuffer(magic);
        const result = SldprtContainerParser.extractParasolid(buf);
        expect(result).not.toBeNull();
        expect(result!.format).toBe('sw3d');
        expect(result!.data.subarray(0, 4)).toEqual(magic);
    });

    it('extracted data is a valid Parasolid buffer for PS-A magic', () => {
        const magic = Buffer.from('PS-A', 'ascii');
        const buf = buildSw3dBuffer(magic);
        const result = SldprtContainerParser.extractParasolid(buf);
        expect(result).not.toBeNull();
        expect(result!.data.subarray(0, 4)).toEqual(magic);
    });

    it('returns null when the buffer starts with OLE2 sig but has no geometry stream', () => {
        // Build a buffer that begins with OLE2 sig but is otherwise empty/zero
        const buf = Buffer.alloc(1024, 0);
        OLE2_SIGNATURE.copy(buf, 0);
        // Should fall through to SW 3D Storage path, which also finds nothing
        const result = SldprtContainerParser.extractParasolid(buf);
        expect(result).toBeNull();
    });
});
