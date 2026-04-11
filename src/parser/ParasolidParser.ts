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
 *       Separated by a 6-byte sentinel (0xC2 0xBC 0x92 0x8F 0x99 0x6E).
 *       Each sentinel block contains one or more entity records identified
 *       by 2-byte type markers (e.g. 0x001D = point, 0x0012 = coedge).
 *       Older editions also prefix records with =p (0x3D 0x70) or =q (0x3D 0x71).
 *       Geometry data is stored as IEEE 754 float64 (BE / network order).
 *
 * Entity record layout (type 0x1D — POINT):
 *       [00 1D] [id:2] [00 00] [ref:2] [00 01] [ref:2] [ref:2] [ref:2]
 *       [x:float64BE] [y:float64BE] [z:float64BE]
 *
 * Entity record layout (type 0x1E — SURFACE/CURVE):
 *       [00 1E] [id:2] [00 00] [ref:2] [00 01] [refs...] [0x2B]
 *       [origin:3×float64BE] [axis/params:float64BE...]
 *
 * This parser extracts:
 *  - Header metadata (modeller version, schema ID)
 *  - Entity class catalogue
 *  - Coordinate data from entity records (float64 triplets)
 *  - Entity census (count of each entity type)
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

/** Census of entity types found in a Parasolid binary transmit stream. */
export interface PsEntityCensus {
    sentinels: number;
    points: number;
    coedges: number;
    edges: number;
    faces: number;
    surfaces: number;
    shells: number;
    loops: number;
    other: number;
}

/** Marker bytes at the start of every entity record of type A. */
const RECORD_MARKER_P = 0x70; // '=p'
/** Marker bytes at the start of every entity record of type B. */
const RECORD_MARKER_Q = 0x71; // '=q'
/** The '=' byte preceding record markers. */
const RECORD_PREFIX = 0x3d; // '='

/**
 * 6-byte sentinel that separates entity record blocks in the Parasolid
 * binary transmit format. Observed consistently across all NIST SolidWorks
 * MBD 2018 test files (both marker and markerless variants).
 */
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);

/** Known entity type codes (2nd byte of the 00 XX type marker). */
const ENTITY_POINT = 0x1d;     // POINT — contains 3×float64 BE coordinates
const ENTITY_COEDGE = 0x12;    // COEDGE — doubly-linked list references
const ENTITY_EDGE = 0x10;      // EDGE — connects two vertices via a curve
const ENTITY_FACE = 0x0f;      // FACE — bounded surface with loops
const ENTITY_SURFACE = 0x1e;   // SURFACE/CURVE — geometry with float64 params
const ENTITY_BSPLINE = 0x1f;   // B-SPLINE curve/surface
const ENTITY_SHELL = 0x11;     // BODY/REGION/SHELL container
const ENTITY_LOOP = 0x13;      // LOOP — ordered set of coedges

/**
 * Bytes from the type marker (00 1D) to the start of coordinate data
 * in a POINT entity record.
 *
 * Layout: [00 1D] [id:2] [00 00] [ref:2] [00 01] [ref:2] [ref:2] [ref:2] → 16 bytes
 */
const POINT_COORD_OFFSET = 16;

/**
 * 6-byte sub-record separator found within sentinel blocks.
 * Splits concatenated entity records inside a single sentinel block.
 * Pattern: [00 01 00 01 00 03] — observed in all 11 NIST files.
 * Geometry entities (0x1E, 0x1F) are always sub-records, never primary block entities.
 */
const SUB_RECORD_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

/** Parsed sub-record entity within a sentinel block. */
interface RawEntity {
    /** Entity type code (e.g. 0x1E for surface/curve). */
    type: number;
    /** Entity ID (uint16 BE). */
    id: number;
    /** Raw data bytes after the type+id header. */
    data: Buffer;
}

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
     * **Primary method — Structural extraction (sentinel-based):**
     * Splits the buffer by sentinel markers (0xC2 BC 92 8F 99 6E), identifies
     * type-0x1D (POINT) entity records within each block, and reads coordinates
     * at a fixed offset from the type marker. This is precise and avoids
     * false-positive matches from brute-force scanning.
     *
     * **Fallback — Brute-force scanning:**
     * If no sentinels are found, falls back to scanning for =p/=q record markers
     * or full-buffer float64 BE triplet detection.
     *
     * @param maxPoints  Maximum number of unique points to extract.
     */
    extractCoordinates(maxPoints = 2000): PsPoint[] {
        // Try structural extraction first (most reliable)
        const structural = this.extractStructuralPoints(maxPoints);
        if (structural && structural.length > 0) return structural;

        // Fallback: brute-force scanning with lower limit to avoid false positives
        const fallbackLimit = Math.min(maxPoints, 500);
        const buf = this.buf;

        const markers: number[] = [];
        for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i] === RECORD_PREFIX &&
                (buf[i + 1] === RECORD_MARKER_P || buf[i + 1] === RECORD_MARKER_Q)) {
                markers.push(i);
            }
        }

        if (markers.length > 0) {
            return this.extractFromMarkers(buf, markers, fallbackLimit);
        }

        return this.extractFromFullScan(buf, fallbackLimit);
    }

    /**
     * Extract coordinates using structural entity parsing.
     *
     * Splits the buffer by the 6-byte sentinel that separates entity blocks,
     * then within each block locates type-0x1D (POINT) entity records and
     * reads coordinates at the fixed offset.
     *
     * The type-0x1D record layout (40 bytes from type marker to end of z):
     *   [00 1D] [id:2] [00 00] [ref:2] [00 01] [ref:2] [ref:2] [ref:2]
     *   [x:f64BE] [y:f64BE] [z:f64BE]
     *
     * Validated against all 11 NIST SolidWorks MBD 2018 test files.
     * Returns null if no sentinels are found (triggers brute-force fallback).
     *
     * @internal
     */
    private extractStructuralPoints(maxPoints: number): PsPoint[] | null {
        const buf = this.buf;

        // Find all sentinel positions
        const sentPositions: number[] = [];
        let idx = 0;
        while ((idx = buf.indexOf(SENTINEL, idx)) >= 0) {
            sentPositions.push(idx);
            idx += SENTINEL.length;
        }

        if (sentPositions.length === 0) return null;

        const points: PsPoint[] = [];
        const seen = new Set<string>();

        for (let i = 0; i < sentPositions.length && points.length < maxPoints; i++) {
            const blockStart = sentPositions[i] + SENTINEL.length;
            const blockEnd = (i + 1 < sentPositions.length)
                ? sentPositions[i + 1]
                : buf.length;

            // Scan for type-0x1D markers within this sentinel block
            for (let j = blockStart; j + POINT_COORD_OFFSET + 24 <= blockEnd; j++) {
                if (buf[j] !== 0x00 || buf[j + 1] !== ENTITY_POINT) continue;

                // Validate record structure: [00 1D] [id:2] [00 00] ... [00 01]
                if (j + POINT_COORD_OFFSET + 24 > buf.length) continue;
                if (buf[j + 4] !== 0x00 || buf[j + 5] !== 0x00) continue;
                if (buf[j + 8] !== 0x00 || buf[j + 9] !== 0x01) continue;

                const x = buf.readDoubleBE(j + POINT_COORD_OFFSET);
                const y = buf.readDoubleBE(j + POINT_COORD_OFFSET + 8);
                const z = buf.readDoubleBE(j + POINT_COORD_OFFSET + 16);

                if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
                if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) continue;

                const key = `${x.toFixed(9)},${y.toFixed(9)},${z.toFixed(9)}`;
                if (seen.has(key)) continue;
                seen.add(key);

                points.push({ x, y, z });
                if (points.length >= maxPoints) return points;

                // Skip past this entity record to avoid re-scanning within it
                j += POINT_COORD_OFFSET + 23;
            }
        }

        return points.length > 0 ? points : null;
    }

    /**
     * Count entity types in the binary transmit stream using sentinel-based
     * structural parsing.
     *
     * Splits by sentinel, then within each block searches for known entity
     * type markers (00 XX where XX is a known Parasolid type code).
     */
    getEntityCensus(): PsEntityCensus {
        const buf = this.buf;
        const census: PsEntityCensus = {
            sentinels: 0, points: 0, coedges: 0, edges: 0,
            faces: 0, surfaces: 0, shells: 0, loops: 0, other: 0,
        };

        // Find sentinels
        let idx = 0;
        while ((idx = buf.indexOf(SENTINEL, idx)) >= 0) {
            census.sentinels++;
            idx += SENTINEL.length;
        }

        if (census.sentinels === 0) return census;

        // Scan for entity type markers preceded by 0x00 0x03
        // The pattern [00 03 00 XX] precedes every entity record
        for (let i = 0; i < buf.length - 3; i++) {
            if (buf[i] !== 0x00 || buf[i + 1] !== 0x03 || buf[i + 2] !== 0x00) continue;

            const type = buf[i + 3];
            switch (type) {
                case ENTITY_POINT:   census.points++;   break;
                case ENTITY_COEDGE:  census.coedges++;  break;
                case ENTITY_EDGE:    census.edges++;    break;
                case ENTITY_FACE:    census.faces++;    break;
                case ENTITY_SURFACE: census.surfaces++; break;
                case ENTITY_BSPLINE: census.surfaces++; break;
                case ENTITY_SHELL:   census.shells++;   break;
                case ENTITY_LOOP:    census.loops++;    break;
                default:
                    // Only count types in the known Parasolid range
                    if (type >= 0x0f && type <= 0x3f) census.other++;
            }
        }

        return census;
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

    /**
     * Extract all entity records from sentinel blocks using sub-record
     * separator parsing. Returns both primary entities and sub-records.
     *
     * Primary entities (first in block):
     *   [00 00 00 03] [00 TYPE] [ID_hi ID_lo] [data...]
     *
     * Sub-records (after SUB_RECORD_SEP = 00 01 00 01 00 03):
     *   [00 TYPE] [ID_hi ID_lo] [data...]
     *
     * @internal
     */
    private extractAllEntities(): RawEntity[] {
        const buf = this.buf;
        const entities: RawEntity[] = [];

        // Find all sentinel positions
        const sentPositions: number[] = [];
        let idx = 0;
        while ((idx = buf.indexOf(SENTINEL, idx)) >= 0) {
            sentPositions.push(idx);
            idx += SENTINEL.length;
        }
        if (sentPositions.length === 0) return entities;

        for (let i = 0; i < sentPositions.length; i++) {
            const blockStart = sentPositions[i] + SENTINEL.length;
            const blockEnd = (i + 1 < sentPositions.length)
                ? sentPositions[i + 1]
                : buf.length;
            const block = buf.subarray(blockStart, blockEnd);
            if (block.length < 8) continue;

            // Split block by SUB_RECORD_SEP
            const subRecords: Buffer[] = [];
            let searchStart = 0;
            while (true) {
                const sepIdx = block.indexOf(SUB_RECORD_SEP, searchStart);
                if (sepIdx < 0) {
                    subRecords.push(block.subarray(searchStart));
                    break;
                }
                subRecords.push(block.subarray(searchStart, sepIdx));
                searchStart = sepIdx + SUB_RECORD_SEP.length;
            }

            for (let si = 0; si < subRecords.length; si++) {
                const rec = subRecords[si];
                if (si === 0) {
                    // Primary entity: [00 00 00 03 00 TYPE ID_hi ID_lo]
                    if (rec.length < 8) continue;
                    if (rec.readUInt32BE(0) !== 3) continue;
                    const type = rec[5];
                    if (type < 0x0d || type > 0x3f) continue;
                    const id = rec.readUInt16BE(6);
                    entities.push({ type, id, data: rec.subarray(8) });
                } else {
                    // Sub-record: [00 TYPE ID_hi ID_lo]
                    if (rec.length < 4) continue;
                    if (rec[0] !== 0x00) continue;
                    const type = rec[1];
                    if (type < 0x0d || type > 0x3f) continue;
                    const id = rec.readUInt16BE(2);
                    entities.push({ type, id, data: rec.subarray(4) });
                }
            }
        }

        return entities;
    }

    /**
     * Extract and classify surface/curve geometry from entity records.
     *
     * Geometry entities (type 0x1E and 0x1F) are always sub-records inside
     * sentinel blocks. Each contains a 0x2B marker byte followed by
     * consecutive float64 BE values encoding the geometry parameters.
     *
     * Classification by float count after the 0x2B marker:
     *  - 7 floats  →  plane: origin(3) + normal(3) + 0
     *  - 11 floats →  cylinder (semiAngle≈0) or cone:
     *                  origin(3) + axis(3) + refdir(3) + radius + semiAngle
     *  - Other     →  unknown (B-spline, torus, etc.)
     *
     * Coordinates are stored in Parasolid native units (meters) and passed
     * through as-is. The caller is responsible for unit conversion if needed.
     *
     * @internal
     */
    private extractSurfaces(): PsSurface[] {
        const allEntities = this.extractAllEntities();
        const geomEntities = allEntities.filter(
            e => e.type === ENTITY_SURFACE || e.type === ENTITY_BSPLINE,
        );

        const surfaces: PsSurface[] = [];
        let nextId = 1;

        for (const ent of geomEntities) {
            const data = ent.data;

            // Find the 0x2B marker that precedes float data
            const markerIdx = data.indexOf(0x2b);
            if (markerIdx < 0 || markerIdx + 1 + 8 > data.length) continue;

            // Read consecutive valid float64 BE values after the marker
            const floatStart = markerIdx + 1;
            const floats: number[] = [];
            for (let off = floatStart; off + 8 <= data.length; off += 8) {
                const val = data.readDoubleBE(off);
                if (!isFinite(val) || Math.abs(val) > 1e6) break;
                floats.push(val);
            }

            if (floats.length < 7) continue;

            if (floats.length === 11 || floats.length === 12) {
                // Cylinder or cone: origin(3) + axis(3) + refdir(3) + radius + semiAngle
                const origin: PsPoint = { x: floats[0], y: floats[1], z: floats[2] };
                const axis: PsPoint = { x: floats[3], y: floats[4], z: floats[5] };
                const radius = floats[9];
                const semiAngle = floats[10];

                if (radius <= 0 || radius > 1e4) continue;

                if (Math.abs(semiAngle) < 1e-6) {
                    surfaces.push({
                        id: nextId++,
                        surfaceType: 'cylinder',
                        params: { origin, axis, radius },
                    });
                } else {
                    surfaces.push({
                        id: nextId++,
                        surfaceType: 'cone',
                        params: { origin, axis, radius, halfAngle: semiAngle },
                    });
                }
            } else if (floats.length === 7 || floats.length === 8) {
                // Plane candidate: origin(3) + normal(3) + 0
                const origin: PsPoint = { x: floats[0], y: floats[1], z: floats[2] };
                const normal: PsPoint = { x: floats[3], y: floats[4], z: floats[5] };

                // Validate the normal is approximately unit length
                const mag = Math.sqrt(
                    normal.x * normal.x + normal.y * normal.y + normal.z * normal.z,
                );
                if (mag < 0.5 || mag > 2.0) continue;

                surfaces.push({
                    id: nextId++,
                    surfaceType: 'plane',
                    params: { origin, normal },
                });
            }
            // Other float counts (9, 10, 13+) → skip for now (B-spline, torus, etc.)
        }

        return surfaces;
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
     * Build a {@link PsModel} from the binary transmit stream.
     *
     * Uses sentinel-based structural parsing when available:
     *  - Vertices are extracted from type-0x1D entity records with exact
     *    coordinate offsets (no brute-force scanning)
     *  - Falls back to float64 triplet scanning if no sentinels found
     *
     * The resulting model captures verified vertex geometry. Full topology
     * (faces, edges, loops) will be refined as the binary format is
     * understood in greater detail.
     */
    parse(): PsModel {
        const points = this.extractCoordinates();

        if (points.length === 0) {
            return {
                bodies: [], shells: [], faces: [], loops: [],
                edges: [], vertices: [], curves: [], surfaces: [],
            };
        }

        const vertices: PsVertex[] = points.map((pt, idx) => ({
            id: idx + 1,
            position: pt,
        }));

        // ── Surface extraction ──────────────────────────────────────────
        const surfaces = this.extractSurfaces();

        // ── Synthetic topology ──────────────────────────────────────────
        // Each surface gets a face with an empty edge loop.  This is the
        // minimum topology required for valid ADVANCED_BREP output.
        const loops: PsLoop[] = [];
        const faces: PsFace[] = [];
        const edges: PsEdge[] = [];
        const curves: PsCurve[] = [];

        for (const surf of surfaces) {
            const loopId = surf.id;   // 1:1 with surface IDs
            loops.push({ id: loopId, edges: [], senses: [] });
            faces.push({
                id: surf.id,
                surface: surf.id,
                outerLoop: loopId,
                innerLoops: [],
                sense: true,
            });
        }

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
