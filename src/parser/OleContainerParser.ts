/**
 * OleContainerParser.ts
 *
 * Minimal OLE2 / Compound File Binary (CFB) parser.
 *
 * Parses the Microsoft Compound Document File Format (OLE2) used by
 * pre-2015 SolidWorks .SLDPRT files to locate and extract streams.
 * The primary goal is to find the Parasolid BRep geometry stream
 * (usually named "Contents" or "PowerContents").
 *
 * References:
 *  - [MS-CFB] Compound File Binary File Format specification
 *    https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb
 *  - OpenMcdf / libgsf open-source implementations used as cross-reference
 */

/** A single directory entry inside an OLE2 compound file. */
export interface OleDirectoryEntry {
    name: string;
    /** Entry type: 0=empty, 1=storage, 2=stream, 5=root */
    type: number;
    startSector: number;
    size: number;
}

/** Result of extracting a stream from an OLE2 file. */
export interface OleStreamResult {
    /** Name of the OLE directory entry. */
    streamName: string;
    /** Raw stream bytes (already trimmed to `entry.size`). */
    data: Buffer;
    /** Byte offset of the entry's first sector within the file (informational). */
    offset: number;
}

/**
 * Names of OLE directory entries that may contain Parasolid BRep geometry.
 *
 * "Contents"      - standard SolidWorks Parasolid stream name
 * "PowerContents" - alternate name used in some SolidWorks versions
 */
export const PARASOLID_STREAM_NAMES: ReadonlyArray<string> = [
    'Contents',
    'PowerContents',
];

/** Magic signature at byte 0 of every valid OLE2 file. */
export const OLE2_SIGNATURE = Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

/**
 * Parse an OLE2/CFB binary buffer and return all directory entries together
 * with a sector-chain reader function.
 */
export class OleContainerParser {
    private readonly buf: Buffer;
    private readonly sectorSize: number;
    private readonly fat: number[];
    readonly entries: OleDirectoryEntry[];

    constructor(buf: Buffer) {
        if (buf.length < 512) {
            throw new Error('Buffer too small to be a valid OLE2 file');
        }
        if (!buf.subarray(0, 8).equals(OLE2_SIGNATURE)) {
            throw new Error('Not an OLE2 compound file (wrong magic bytes)');
        }

        this.buf = buf;
        this.sectorSize = 1 << buf.readUInt16LE(30);
        this.fat = this.buildFAT();
        this.entries = this.readDirectory();
    }

    /** Build the File Allocation Table from DIFAT entries. */
    private buildFAT(): number[] {
        const buf = this.buf;
        const ss = this.sectorSize;
        const difatStartSector = buf.readInt32LE(68);

        // Collect FAT sector numbers from the 109 header DIFAT slots
        const difat: number[] = [];
        for (let i = 0; i < 109; i++) {
            const sector = buf.readInt32LE(76 + i * 4);
            if (sector >= 0) difat.push(sector);
        }

        // Follow the DIFAT chain for files with > 109 FAT sectors
        let difatSec = difatStartSector;
        while (difatSec >= 0 && difatSec < 0xfffe_fffe) {
            const off = (difatSec + 1) * ss;
            const entriesPerSec = ss / 4 - 1; // last slot is next-chain pointer
            for (let i = 0; i < entriesPerSec; i++) {
                const sector = buf.readInt32LE(off + i * 4);
                if (sector >= 0) difat.push(sector);
            }
            difatSec = buf.readInt32LE(off + ss - 4);
        }

        // Read every FAT sector into a flat array
        const fat: number[] = [];
        for (const sec of difat) {
            const off = (sec + 1) * ss;
            for (let i = 0; i < ss / 4; i++) {
                fat.push(buf.readInt32LE(off + i * 4));
            }
        }
        return fat;
    }

    /**
     * Follow a sector chain and concatenate all sector payloads into one Buffer.
     * Cyclic chains are detected and aborted to avoid infinite loops.
     */
    readChain(startSector: number): Buffer {
        const chunks: Buffer[] = [];
        let sec = startSector;
        const visited = new Set<number>();
        while (sec >= 0 && sec < 0xfffe_fffe) {
            if (visited.has(sec)) break; // cycle guard
            visited.add(sec);
            const off = (sec + 1) * this.sectorSize;
            if (off + this.sectorSize > this.buf.length) break;
            chunks.push(this.buf.subarray(off, off + this.sectorSize));
            sec = this.fat[sec] ?? -1;
        }
        return Buffer.concat(chunks);
    }

    /** Parse the directory stream and return all directory entries. */
    private readDirectory(): OleDirectoryEntry[] {
        const dirStartSector = this.buf.readUInt32LE(48);
        const dirData = this.readChain(dirStartSector);
        const entries: OleDirectoryEntry[] = [];

        for (let i = 0; i + 128 <= dirData.length; i += 128) {
            const nameLen = dirData.readUInt16LE(i + 64);
            if (nameLen === 0) continue;
            // Name is stored as UTF-16LE, nameLen includes the null terminator
            const name = dirData
                .subarray(i, i + Math.max(0, nameLen - 2))
                .toString('utf16le');
            const type = dirData[i + 66];
            const startSector = dirData.readInt32LE(i + 116);
            const size = dirData.readUInt32LE(i + 120);
            entries.push({ name, type, startSector, size });
        }
        return entries;
    }

    /**
     * Extract a named stream from the compound file.
     *
     * @param streamName  Case-sensitive stream name to look for.
     * @returns           The raw stream bytes, or `null` if not found.
     */
    extractStream(streamName: string): OleStreamResult | null {
        const entry = this.entries.find(
            e => e.type === 2 && e.name === streamName && e.startSector >= 0,
        );
        if (!entry) return null;

        const data = this.readChain(entry.startSector).subarray(0, entry.size);
        return {
            streamName: entry.name,
            data,
            offset: (entry.startSector + 1) * this.sectorSize,
        };
    }

    /**
     * Attempt to extract the first Parasolid BRep stream found in the file.
     *
     * Searches for streams named in {@link PARASOLID_STREAM_NAMES} in priority
     * order.  Returns `null` if none are present.
     */
    extractParasolidStream(): OleStreamResult | null {
        for (const name of PARASOLID_STREAM_NAMES) {
            const result = this.extractStream(name);
            if (result) return result;
        }
        return null;
    }

    /**
     * Check the signature at byte 0 to determine if a buffer is an OLE2 file.
     */
    static isOle2(buf: Buffer): boolean {
        return buf.length >= 8 && buf.subarray(0, 8).equals(OLE2_SIGNATURE);
    }
}
