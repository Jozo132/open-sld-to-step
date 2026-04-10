/**
 * Sw3DStorageParser.ts
 *
 * Parser for the SolidWorks "3D Storage" v4 container format used by
 * SolidWorks 2015 and later .SLDPRT / .SLDASM files.
 *
 * The format is a proprietary flat-binary container: a sequence of tagged
 * sections, each preceded by a 6-byte marker.  Each section carries a
 * typeId, metadata (XOR-encoded name), compressed size, decompressed size,
 * and a deflate-compressed payload.
 *
 * This parser locates sections whose decompressed payload begins with a
 * recognised Parasolid magic signature ("P_S_U" binary or "P_A_R_A" text).
 *
 * Reference: clean-room analysis of SolidWorks 2015-2024 files.
 */

import { inflateRawSync } from 'node:zlib';

// ── Section layout ────────────────────────────────────────────────────────────

/**
 * 6-byte marker that precedes every section in SW 3D Storage v4.
 * After the marker the layout is:
 *
 *   [4] typeId          – section type identifier
 *   [4] field1          – reserved / unknown
 *   [4] compressedSize  – byte length of the deflate payload
 *   [4] decompressedSize
 *   [4] nameLength      – byte length of the XOR-encoded metadata blob
 *   [nameLength] metadata
 *   [compressedSize] deflate-compressed payload
 */
export const SW3D_SECTION_MARKER = Buffer.from([
    0x14, 0x00, 0x06, 0x00, 0x08, 0x00,
]);

/** Total byte size of the fixed portion of the section header (marker + 5×u32). */
export const SW3D_HEADER_SIZE = 26; // 6 + 4 + 4 + 4 + 4 + 4

// ── Parasolid magic ───────────────────────────────────────────────────────────

/**
 * Known magic values at the very start of a Parasolid stream:
 *
 *  - Binary (.x_b):  begins with P_S_U or P_A_R_A
 *  - Text   (.x_t):  plain ASCII, typically "PS-PART-..." or "PARA-..."
 *
 * We test the first 4 bytes.
 */
export const PARASOLID_MAGIC_SIGNATURES: ReadonlyArray<Buffer> = [
    Buffer.from('P_S_', 'ascii'), // P_S_U … (binary Parasolid)
    Buffer.from('PARA', 'ascii'), // PARA…    (some binary variants)
    Buffer.from('PS-P', 'ascii'), // PS-PART… (text Parasolid .x_t)
    Buffer.from('PS-A', 'ascii'), // PS-ASSEMBLY
    Buffer.from('PS-S', 'ascii'), // PS-SCHEMA
];

/** Returns `true` if the buffer starts with a recognised Parasolid magic. */
export function isParasolidBuffer(buf: Buffer): boolean {
    if (buf.length < 4) return false;
    const head = buf.subarray(0, 4);
    return PARASOLID_MAGIC_SIGNATURES.some(sig => sig.equals(head));
}

// ── Result types ──────────────────────────────────────────────────────────────

/** A single parsed section from the SW 3D Storage stream. */
export interface Sw3DSection {
    /** Byte offset of the section marker inside the source buffer. */
    offset: number;
    typeId: number;
    compressedSize: number;
    decompressedSize: number;
    nameLength: number;
    /** Raw (XOR-encoded) metadata blob. */
    metadata: Buffer;
    /** Decompressed payload bytes. */
    payload: Buffer;
}

/** Result returned when a Parasolid section is found. */
export interface Sw3DParasolidResult {
    /** Byte offset of the section marker inside the source buffer. */
    offset: number;
    typeId: number;
    /** Decompressed Parasolid BRep bytes. */
    data: Buffer;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a raw SolidWorks 3D Storage v4 buffer and extract sections.
 *
 * @param buf   Full contents of a `.SLDPRT` (or other SolidWorks) file.
 * @param opts  Optional tuning parameters.
 */
export class Sw3DStorageParser {
    /**
     * Scan the buffer for all sections and return the ones whose decompressed
     * payload begins with a recognised Parasolid magic signature.
     *
     * Multiple sections may exist (e.g. part + sub-assembly).  They are
     * returned in file order.
     */
    static extractParasolidSections(
        buf: Buffer,
        opts: { maxDecompressedSize?: number } = {},
    ): Sw3DParasolidResult[] {
        const maxDec = opts.maxDecompressedSize ?? 500_000_000; // 500 MB guard
        const results: Sw3DParasolidResult[] = [];
        let idx = 0;

        while ((idx = buf.indexOf(SW3D_SECTION_MARKER, idx)) >= 0) {
            if (idx + SW3D_HEADER_SIZE > buf.length) break;

            const typeId = buf.readUInt32LE(idx + 6);
            const compressedSize = buf.readUInt32LE(idx + 14);
            const decompressedSize = buf.readUInt32LE(idx + 18);
            const nameLength = buf.readUInt32LE(idx + 22);

            // Sanity bounds to ignore false-positive marker hits
            if (
                nameLength > 0 &&
                nameLength < 1024 &&
                compressedSize > 4 &&
                compressedSize < buf.length &&
                decompressedSize > 4 &&
                decompressedSize < maxDec
            ) {
                const payloadOffset = idx + SW3D_HEADER_SIZE + nameLength;
                const payloadEnd = payloadOffset + compressedSize;

                if (payloadEnd <= buf.length) {
                    try {
                        const decompressed = inflateRawSync(
                            buf.subarray(payloadOffset, payloadEnd),
                            { maxOutputLength: decompressedSize + 1024 },
                        );

                        if (isParasolidBuffer(decompressed)) {
                            results.push({
                                offset: idx,
                                typeId,
                                data: decompressed,
                            });
                        }
                    } catch {
                        // Not a valid deflate stream at this position – skip
                    }
                }
            }

            idx++;
        }

        return results;
    }

    /**
     * Convenience method: return only the first Parasolid section found, or
     * `null` if none exists.
     */
    static extractFirstParasolidSection(
        buf: Buffer,
        opts?: { maxDecompressedSize?: number },
    ): Sw3DParasolidResult | null {
        const all = Sw3DStorageParser.extractParasolidSections(buf, opts);
        return all.length > 0 ? all[0] : null;
    }
}
