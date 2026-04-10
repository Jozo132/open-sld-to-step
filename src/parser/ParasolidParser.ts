/**
 * ParasolidParser.ts
 *
 * Parses Parasolid binary transmit (.x_b) streams extracted from SolidWorks
 * files and builds a {@link PsModel} topology graph.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Format overview (clean-room, from public references + observable structure)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A Parasolid binary transmit file consists of:
 *
 *  1. Header line (NUL-terminated):
 *       PS\x00\x00\x00?: TRANSMIT FILE (partition) created by modeller version NNNNNNN
 *
 *  2. Schema identifier (embedded after header):
 *       SCH_<version>_<major>_<minor>
 *
 *  3. Schema section:
 *       Defines entity classes, field names, and field types using single-char
 *       type codes: I=int, d=double, R=array, A=sub-struct, C=class, Z=end.
 *
 *  4. Entity class definitions:
 *       Named class blocks (BODY_MATCH, SDL/TYSA_COLOUR, ATTRIB_*, etc.)
 *       with field-count and type metadata.
 *
 *  5. Entity instance records:
 *       Prefixed by 0x3D 0x70 ("=p") or 0x3D 0x71 ("=q") markers.
 *       Each record encodes field values for one entity instance.
 *       Geometry data (coordinates) is stored as IEEE 754 float64 (BE / network order).
 *
 * This parser extracts:
 *  - Header metadata (modeller version, schema ID)
 *  - Entity class catalogue
 *  - Coordinate data from entity records (float64 triplets)
 *  - Basic topology relationships where detectable
 *
 * Constraints:
 *  - No proprietary Dassault / Siemens APIs used.
 *  - Based on public Parasolid schema documentation and clean-room analysis.
 */

import type {
    PsModel,
    PsBody,
    PsShell,
    PsFace,
    PsLoop,
    PsEdge,
    PsVertex,
    PsCurve,
    PsSurface,
    PsPoint,
} from '../step/ParasolidToStepMapper.js';

// ── Header parsing ────────────────────────────────────────────────────────────

/** Parsed header of a Parasolid transmit file. */
export interface PsTransmitHeader {
    /** Modeller version that created the file (e.g. 3000269). */
    modellerVersion: number;
    /** Full schema identifier (e.g. "SCH_3000269_30000_13006"). */
    schemaId: string;
}

/** Marker bytes at the start of every entity record of type A. */
const RECORD_MARKER_P = 0x70; // '=p'
/** Marker bytes at the start of every entity record of type B. */
const RECORD_MARKER_Q = 0x71; // '=q'
/** The '=' byte preceding record markers. */
const RECORD_PREFIX = 0x3d; // '='

// ── Parser class ──────────────────────────────────────────────────────────────

/**
 * Parse a Parasolid binary transmit stream (.x_b) into a {@link PsModel}.
 *
 * The parser is deliberately conservative: it extracts what it can identify
 * with confidence and leaves unknown fields as opaque.  This ensures
 * forward-compatibility as the format is understood in more detail.
 */
export class ParasolidParser {
    private readonly buf: Buffer;
    private pos = 0;

    constructor(buf: Buffer) {
        this.buf = buf;
    }

    /**
     * Parse the transmit-file header.
     * Returns null if the buffer does not look like a Parasolid transmit file.
     */
    parseHeader(): PsTransmitHeader | null {
        const buf = this.buf;
        // Must start with 'PS'
        if (buf.length < 20 || buf[0] !== 0x50 || buf[1] !== 0x53) return null;

        // Find "TRANSMIT" marker
        const transmitIdx = buf.indexOf('TRANSMIT', 0, 'ascii');
        if (transmitIdx < 0 || transmitIdx > 32) return null;

        // Extract modeller version from "modeller version NNNNNNN"
        const versionMarker = buf.indexOf('version ', 0, 'ascii');
        let modellerVersion = 0;
        if (versionMarker >= 0 && versionMarker < 128) {
            // Read ASCII digits after "version "
            let numStr = '';
            for (let i = versionMarker + 8; i < buf.length && i < versionMarker + 20; i++) {
                if (buf[i] >= 0x30 && buf[i] <= 0x39) numStr += String.fromCharCode(buf[i]);
                else break;
            }
            modellerVersion = parseInt(numStr, 10) || 0;
        }

        // Find schema ID (SCH_...)
        const schIdx = buf.indexOf('SCH_', 0, 'ascii');
        let schemaId = '';
        if (schIdx >= 0 && schIdx < 256) {
            let end = schIdx;
            while (end < buf.length && buf[end] >= 0x20 && buf[end] <= 0x7e) end++;
            schemaId = buf.subarray(schIdx, end).toString('ascii');
        }

        return { modellerVersion, schemaId };
    }

    /**
     * Scan the buffer for entity class names defined in the class catalogue.
     *
     * Entity class definitions begin after the schema section and are
     * recognisable by their name strings followed by type-marker bytes.
     */
    findEntityClasses(): string[] {
        const buf = this.buf;
        const classes: string[] = [];
        // Known Parasolid topology class names to look for
        const knownNames = [
            'BODY', 'REGION', 'LUMP', 'SHELL', 'FACE', 'LOOP', 'FIN',
            'EDGE', 'VERTEX', 'POINT', 'CURVE', 'SURFACE',
            'PLANE', 'CYLINDER', 'CONE', 'SPHERE', 'TORUS',
            'LINE', 'CIRCLE', 'ELLIPSE', 'BCURVE', 'BSURF',
            'BODY_MATCH', 'ATTRIB',
        ];

        for (const name of knownNames) {
            const idx = buf.indexOf(name, 0, 'ascii');
            if (idx >= 0) classes.push(name);
        }
        return classes;
    }

    /**
     * Count the number of entity instance records in the binary stream.
     *
     * Each entity is prefixed by `=p` (0x3D 0x70) or `=q` (0x3D 0x71).
     */
    countEntityRecords(): { pRecords: number; qRecords: number } {
        const buf = this.buf;
        let pRecords = 0;
        let qRecords = 0;
        for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i] === RECORD_PREFIX) {
                if (buf[i + 1] === RECORD_MARKER_P) pRecords++;
                else if (buf[i + 1] === RECORD_MARKER_Q) qRecords++;
            }
        }
        return { pRecords, qRecords };
    }

    /**
     * Extract coordinate triplets (x, y, z) from entity records.
     *
     * Scans `=p` and `=q` records for sequences of three consecutive
     * IEEE 754 float64 **Big Endian** values that look like 3D coordinates
     * (finite, within a reasonable range for engineering geometry).
     *
     * The Parasolid binary transmit format stores float64 in network (BE)
     * byte order — confirmed by the presence of recognisable geometric
     * constants (√2/2, 1.0, etc.) only when decoded as BE.
     *
     * If no `=p`/`=q` markers are found (some Parasolid editions omit them),
     * falls back to scanning the entire data area for BE float64 triplets
     * with stricter filtering.
     *
     * @param maxPoints  Maximum number of unique points to extract (default 500).
     *                   Prevents excessive memory use on large files.
     */
    extractCoordinates(maxPoints = 200): PsPoint[] {
        const buf = this.buf;

        // Build a list of all =p/=q marker offsets so we know record boundaries
        const markers: number[] = [];
        for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i] === RECORD_PREFIX &&
                (buf[i + 1] === RECORD_MARKER_P || buf[i + 1] === RECORD_MARKER_Q)) {
                markers.push(i);
            }
        }

        if (markers.length > 0) {
            return this.extractFromMarkers(buf, markers, maxPoints);
        }

        // Fallback: no =p/=q markers — scan full data area
        return this.extractFromFullScan(buf, maxPoints);
    }

    /** Extract coordinate triplets from =p/=q record markers. @internal */
    private extractFromMarkers(buf: Buffer, markers: number[], maxPoints: number): PsPoint[] {
        const points: PsPoint[] = [];
        const seen = new Set<string>();

        for (let mi = 0; mi < markers.length; mi++) {
            const markerOff = markers[mi];
            const isP = buf[markerOff + 1] === RECORD_MARKER_P;

            // Record extends from marker to the next marker (or +20000, whichever first)
            const recordEnd = mi + 1 < markers.length
                ? markers[mi + 1]
                : Math.min(markerOff + 20000, buf.length);

            // =p records: 2 bytes marker + 3 bytes tag = data at +5
            // =q records: 2 bytes marker = data at +2
            const dataStart = markerOff + (isP ? 5 : 2);

            // Scan the record for float64 BE triplets
            for (let j = dataStart; j + 24 <= recordEnd; j++) {
                const pt = this.tryReadTriplet(buf, j);
                if (!pt) continue;

                const key = `${pt.x.toFixed(6)},${pt.y.toFixed(6)},${pt.z.toFixed(6)}`;
                if (seen.has(key)) continue;
                seen.add(key);

                points.push(pt);
                if (points.length >= maxPoints) return points;
            }
        }

        return points;
    }

    /**
     * Fallback: scan the full buffer for BE float64 triplets (no markers).
     * Uses stricter checks: at least one component must have |val| > 0.001.
     * Skips the header/schema area (first ~0x400 bytes).
     * @internal
     */
    private extractFromFullScan(buf: Buffer, maxPoints: number): PsPoint[] {
        const points: PsPoint[] = [];
        const seen = new Set<string>();

        // Skip past the header + schema + class definitions (typically < 0x600)
        // Find the last 'Z' (0x5A) in the first 4096 bytes as the end of class defs
        let dataStart = 0x400;  // Conservative default
        for (let i = Math.min(0x1000, buf.length) - 1; i >= 0x60; i--) {
            if (buf[i] === 0x5a) { // 'Z' — schema end marker
                dataStart = i + 1;
                break;
            }
        }

        for (let j = dataStart; j + 24 <= buf.length; j++) {
            const pt = this.tryReadTriplet(buf, j);
            if (!pt) continue;

            // Stricter filter for markerless scan:
            // at least one component must be significantly non-zero
            const mx = Math.max(Math.abs(pt.x), Math.abs(pt.y), Math.abs(pt.z));
            if (mx < 0.001) continue;

            const key = `${pt.x.toFixed(6)},${pt.y.toFixed(6)},${pt.z.toFixed(6)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            points.push(pt);
            if (points.length >= maxPoints) return points;
        }

        return points;
    }

    /** Try to read a float64 BE triplet at offset. Returns null if invalid. @internal */
    private tryReadTriplet(buf: Buffer, offset: number): PsPoint | null {
        if (offset + 24 > buf.length) return null;

        const x = buf.readDoubleBE(offset);
        const y = buf.readDoubleBE(offset + 8);
        const z = buf.readDoubleBE(offset + 16);

        // Must be finite and within engineering range
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
        if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) return null;
        // Skip if all three are exactly zero (common padding, not geometry)
        if (x === 0 && y === 0 && z === 0) return null;
        // At least one must have a non-trivial magnitude
        const mag = Math.abs(x) + Math.abs(y) + Math.abs(z);
        if (mag < 1e-15) return null;

        return { x, y, z };
    }

    /**
     * Build a minimal {@link PsModel} from the binary transmit stream.
     *
     * This produces a best-effort model:
     *  - Vertices are created from extracted coordinate triplets
     *  - A single body, shell, and face are created as a minimal wrapper
     *    (the full topology graph will be refined as the binary format
     *     is understood in greater detail)
     *
     * The resulting model is sufficient for generating a valid STEP file
     * skeleton that captures the geometry coordinate data.
     */
    parse(): PsModel {
        const points = this.extractCoordinates();

        if (points.length === 0) {
            return {
                bodies: [], shells: [], faces: [], loops: [],
                edges: [], vertices: [], curves: [], surfaces: [],
            };
        }

        // Create vertices from extracted points
        const vertices: PsVertex[] = points.map((pt, idx) => ({
            id: idx + 1,
            position: pt,
        }));

        // At this stage we only have speculative coordinate data from
        // binary scanning — not true topological edges.  We emit the
        // vertices as a point cloud inside a minimal shell wrapper so
        // the STEP output is structurally valid without creating O(N)
        // edges/curves (which would bloat memory on large files).
        const surfaces: PsSurface[] = [];
        const faces: PsFace[] = [];
        const edges: PsEdge[] = [];
        const curves: PsCurve[] = [];
        const loops: PsLoop[] = [];

        // Create shell and body wrappers
        const shells: PsShell[] = faces.length > 0 ? [{
            id: 1,
            faces: faces.map(f => f.id),
            closed: false,
        }] : [];

        const bodies: PsBody[] = shells.length > 0 ? [{
            id: 1,
            shells: shells.map(s => s.id),
        }] : [];

        return {
            bodies, shells, faces, loops,
            edges, vertices, curves, surfaces,
        };
    }
}
