/**
 * SldprtContainerParser.ts
 *
 * High-level parser that abstracts over both the legacy OLE2/CFB format
 * (SolidWorks < 2015) and the modern SW 3D Storage v4 format (SolidWorks
 * 2015+).
 *
 * Primary goal: locate and return the raw Parasolid BRep geometry stream.
 * The caller can then optionally Zlib-decompress (if still packed) or pass
 * the buffer directly to the Parasolid-to-STEP mapper.
 */

import { inflateRawSync } from 'node:zlib';
import {
    OleContainerParser,
    OleStreamResult,
} from './OleContainerParser.js';
import {
    Sw3DStorageParser,
    Sw3DParasolidResult,
    isParasolidBuffer,
} from './Sw3DStorageParser.js';

// ── Result types ──────────────────────────────────────────────────────────────

/** Discriminated union – which code path found the Parasolid data. */
export type ContainerFormat = 'ole2' | 'sw3d';

/** Result returned by {@link SldprtContainerParser.extractParasolid}. */
export interface ParasolidExtractResult {
    /** Which container format was detected and parsed. */
    format: ContainerFormat;
    /**
     * For OLE2: the directory entry name of the stream that was read.
     * For SW 3D Storage: the decimal typeId of the section, as a string.
     */
    streamName: string;
    /** Fully decompressed Parasolid BRep buffer. */
    data: Buffer;
}

// ── Parasolid binary signatures ───────────────────────────────────────────────

/**
 * If an OLE2 stream has been extracted but has NOT yet been zlib-decompressed
 * (some SolidWorks versions store it compressed inside the OLE), we attempt
 * one additional round of inflateRawSync.
 *
 * @internal
 */
function maybeDecompress(raw: Buffer): Buffer {
    // Already a valid Parasolid buffer? Return as-is.
    if (isParasolidBuffer(raw)) return raw;

    // Try raw-deflate decompression
    try {
        const decompressed = inflateRawSync(raw);
        if (isParasolidBuffer(decompressed)) return decompressed;
    } catch {
        // Not a deflate stream
    }

    // Return original – the caller can decide what to do
    return raw;
}

// ── Main parser class ─────────────────────────────────────────────────────────

/**
 * Detect the container format of a SolidWorks file buffer and extract the
 * embedded Parasolid geometry stream.
 *
 * Parsing strategy:
 *  1. If the buffer starts with the OLE2 magic, try the OLE2/CFB path first.
 *  2. Regardless of OLE2 match, also try the SW 3D Storage scanner.
 *  3. The first path that yields a valid Parasolid buffer wins.
 *
 * This mirrors the real-world observation that some SolidWorks 2015+ files
 * carry an OLE2 wrapper around the 3D Storage container.
 */
export class SldprtContainerParser {
    /**
     * Extract the Parasolid BRep geometry stream from a SolidWorks file buffer.
     *
     * @param buf  Full file contents, e.g. from `fs.readFileSync(path)`.
     * @returns    Parsed result, or `null` if no geometry stream was found.
     */
    static extractParasolid(buf: Buffer): ParasolidExtractResult | null {
        // ── Path 1: OLE2 / CFB ──────────────────────────────────────────────
        if (OleContainerParser.isOle2(buf)) {
            try {
                const parser = new OleContainerParser(buf);
                const stream: OleStreamResult | null =
                    parser.extractParasolidStream();

                if (stream) {
                    const data = maybeDecompress(stream.data);
                    return {
                        format: 'ole2',
                        streamName: stream.streamName,
                        data,
                    };
                }
            } catch {
                // OLE2 parse failed – fall through to SW 3D Storage path
            }
        }

        // ── Path 2: SW 3D Storage (SolidWorks 2015+) ────────────────────────
        const sw3d: Sw3DParasolidResult | null =
            Sw3DStorageParser.extractFirstParasolidSection(buf);

        if (sw3d) {
            return {
                format: 'sw3d',
                streamName: String(sw3d.typeId),
                data: sw3d.data,
            };
        }

        return null;
    }
}
