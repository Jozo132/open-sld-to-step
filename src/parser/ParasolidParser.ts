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

/**
 * Parasolid stores coordinates in meters; STEP declares MILLIMETRE as the
 * length unit.  All positional coordinates and radii are scaled by this
 * factor during parse().
 */
const PS_TO_MM = 1000;

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
     * Read float64 BE values after a geometry marker (0x2B or 0x2D) in data.
     * Returns null if no marker found or too few floats.
     * @internal
     */
    private static readGeomFloats(data: Buffer): { floats: number[]; marker: number } | null {
        // Try both 0x2B ('+') and 0x2D ('-') markers
        for (const marker of [0x2b, 0x2d]) {
            const markerIdx = data.indexOf(marker);
            if (markerIdx < 0 || markerIdx + 1 + 8 > data.length) continue;
            const floats: number[] = [];
            for (let off = markerIdx + 1; off + 8 <= data.length; off += 8) {
                const val = data.readDoubleBE(off);
                if (!isFinite(val) || Math.abs(val) > 1e6) break;
                floats.push(val);
            }
            if (floats.length >= 3) return { floats, marker };
        }
        return null;
    }

    /**
     * Extract cylinder/cone surfaces from type-0x1F (SURFACE/BSPLINE) entities.
     * These are the reliably identifiable surfaces from the binary stream.
     *
     * Also extracts candidate plane surfaces from type-0x1E entities that
     * have 7 floats and a unit-length direction vector. These will be
     * validated later by vertex association (≥3 coplanar vertices → plane).
     *
     * Checks both 0x2B and 0x2D geometry markers.
     *
     * @internal
     */
    private extractSurfaces(): PsSurface[] {
        const allEntities = this.extractAllEntities();
        const surfaces: PsSurface[] = [];
        let nextId = 1;

        // ── Type 0x1F entities → cylinders, cones ───────────────────────
        const surfEntities = allEntities.filter(e => e.type === ENTITY_BSPLINE);
        for (const ent of surfEntities) {
            const result = ParasolidParser.readGeomFloats(ent.data);
            if (!result || result.floats.length < 11) continue;
            const floats = result.floats;

            if (floats.length >= 11) {
                const origin: PsPoint = { x: floats[0], y: floats[1], z: floats[2] };
                const axis: PsPoint = { x: floats[3], y: floats[4], z: floats[5] };
                const radius = floats[9];
                const semiAngle = floats[10];

                if (radius <= 0 || radius > 1e4) continue;

                const sOrigin: PsPoint = {
                    x: origin.x * PS_TO_MM,
                    y: origin.y * PS_TO_MM,
                    z: origin.z * PS_TO_MM,
                };
                const sRadius = radius * PS_TO_MM;

                if (Math.abs(semiAngle) < 1e-6) {
                    surfaces.push({
                        id: nextId++,
                        surfaceType: 'cylinder',
                        params: { origin: sOrigin, axis, radius: sRadius },
                    });
                } else {
                    surfaces.push({
                        id: nextId++,
                        surfaceType: 'cone',
                        params: { origin: sOrigin, axis, radius: sRadius, halfAngle: semiAngle },
                    });
                }
            }
        }

        // ── Type 0x1E entities → candidate planes (7/8 floats) ──────────
        // These are MIXED line curves and plane surfaces. We classify
        // them as candidate planes here; the caller validates via vertex
        // association (≥3 coplanar vertices → real plane).
        const curveEntities = allEntities.filter(e => e.type === ENTITY_SURFACE);
        for (const ent of curveEntities) {
            const result = ParasolidParser.readGeomFloats(ent.data);
            if (!result) continue;
            const floats = result.floats;

            if (floats.length === 7 || floats.length === 8) {
                const origin: PsPoint = { x: floats[0], y: floats[1], z: floats[2] };
                const normal: PsPoint = { x: floats[3], y: floats[4], z: floats[5] };

                // Validate unit-length normal (tight tolerance)
                const mag = Math.sqrt(
                    normal.x * normal.x + normal.y * normal.y + normal.z * normal.z,
                );
                if (mag < 0.9 || mag > 1.1) continue;
                // Normalize
                normal.x /= mag;
                normal.y /= mag;
                normal.z /= mag;

                surfaces.push({
                    id: nextId++,
                    surfaceType: 'plane',
                    params: {
                        origin: {
                            x: origin.x * PS_TO_MM,
                            y: origin.y * PS_TO_MM,
                            z: origin.z * PS_TO_MM,
                        },
                        normal,
                    },
                });
            } else if (floats.length >= 11) {
                // Some curve entities (type 0x1E) are actually cylinders
                const origin: PsPoint = { x: floats[0], y: floats[1], z: floats[2] };
                const axis: PsPoint = { x: floats[3], y: floats[4], z: floats[5] };
                const radius = floats[9];
                const semiAngle = floats[10];
                if (radius <= 0 || radius > 1e4) continue;
                const axisMag = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
                if (axisMag < 0.5) continue;

                const sOrigin: PsPoint = {
                    x: origin.x * PS_TO_MM,
                    y: origin.y * PS_TO_MM,
                    z: origin.z * PS_TO_MM,
                };
                const sRadius = radius * PS_TO_MM;

                if (Math.abs(semiAngle) < 1e-6) {
                    surfaces.push({
                        id: nextId++,
                        surfaceType: 'cylinder',
                        params: { origin: sOrigin, axis: { x: axis.x / axisMag, y: axis.y / axisMag, z: axis.z / axisMag }, radius: sRadius },
                    });
                } else {
                    surfaces.push({
                        id: nextId++,
                        surfaceType: 'cone',
                        params: { origin: sOrigin, axis: { x: axis.x / axisMag, y: axis.y / axisMag, z: axis.z / axisMag }, radius: sRadius, halfAngle: semiAngle },
                    });
                }
            }
        }

        return surfaces;
    }

    /**
     * Infer plane surfaces from vertex positions by scanning for coplanar
     * clusters along a bank of candidate normal directions.
     *
     * This finds planes that are NOT present as explicit geometry entities
     * in the binary stream (e.g., axis-aligned faces, chamfer planes).
     *
     * Algorithm:
     *  1. Build a bank of candidate normal directions:
     *     - 6 axis-aligned (±X, ±Y, ±Z)
     *     - 12 diagonal normals at 45°
     *     - Additional normals at 30°/60° manufacturing angles
     *     - Direction vectors from extracted type-0x1E entities
     *  2. For each normal, project all vertices onto it
     *  3. Cluster projected values within tolerance
     *  4. Clusters with ≥3 vertices (axis-aligned) or ≥4 (other) → inferred plane
     *
     * @internal
     */
    private inferPlanesFromVertices(
        vertices: PsVertex[],
        existingSurfaces: PsSurface[],
    ): PsSurface[] {
        if (vertices.length < 3) return [];

        // Axis-aligned normals (low false-positive rate)
        const axisNormals: PsPoint[] = [
            { x: 1, y: 0, z: 0 },
            { x: 0, y: 1, z: 0 },
            { x: 0, y: 0, z: 1 },
        ];

        // Extracted normals from validated type-0x1E planes
        // (known directions from the binary data → find more planes at same angles)
        const extractedNormals: PsPoint[] = [];
        for (const surf of existingSurfaces) {
            if (surf.surfaceType !== 'plane') continue;
            const p = surf.params as { normal: PsPoint };
            const n = p.normal;
            // Skip if axis-aligned (already covered)
            if ((Math.abs(n.x) > 0.99) || (Math.abs(n.y) > 0.99) || (Math.abs(n.z) > 0.99)) continue;
            // Deduplicate
            let isDup = false;
            for (const en of extractedNormals) {
                const dot = Math.abs(en.x * n.x + en.y * n.y + en.z * n.z);
                if (dot > 0.999) { isDup = true; break; }
            }
            if (!isDup) extractedNormals.push({ x: n.x, y: n.y, z: n.z });
        }

        // For each unique normal, project vertices and cluster
        const PLANE_INFER_TOL = 0.1; // mm — tight tolerance for inferred planes
        const inferred: PsSurface[] = [];
        let nextId = existingSurfaces.length + 1000;

        // Precompute existing plane equations for dedup checking
        const existingPlaneEqs: Array<{ normal: PsPoint; d: number }> = [];
        for (const surf of existingSurfaces) {
            if (surf.surfaceType !== 'plane') continue;
            const sp = surf.params as { origin: PsPoint; normal: PsPoint };
            existingPlaneEqs.push({
                normal: sp.normal,
                d: sp.origin.x * sp.normal.x + sp.origin.y * sp.normal.y + sp.origin.z * sp.normal.z,
            });
        }

        // Combine both normal sets with their respective minimum vertex thresholds
        const allNormals: Array<{ normal: PsPoint; minVerts: number }> = [
            ...axisNormals.map(n => ({ normal: n, minVerts: 3 })),
            ...extractedNormals.map(n => ({ normal: n, minVerts: 5 })),
        ];

        for (const { normal, minVerts } of allNormals) {
            const projections: Array<{ d: number; idx: number }> = [];
            for (let i = 0; i < vertices.length; i++) {
                const v = vertices[i].position;
                projections.push({
                    d: v.x * normal.x + v.y * normal.y + v.z * normal.z,
                    idx: i,
                });
            }
            projections.sort((a, b) => a.d - b.d);

            let ci = 0;
            while (ci < projections.length) {
                const clusterStart = ci;
                const d0 = projections[ci].d;
                while (ci < projections.length && projections[ci].d - d0 < PLANE_INFER_TOL) ci++;

                const clusterSize = ci - clusterStart;
                if (clusterSize < minVerts) continue;

                // Verify these vertices span a 2D area (not collinear).
                // Compute bounding box in the two perpendicular directions.
                const { uAxis: infU, vAxis: infV } = ParasolidParser.planeBasis(normal);
                let uMinI = Infinity, uMaxI = -Infinity, vMinI = Infinity, vMaxI = -Infinity;
                for (let j = clusterStart; j < ci; j++) {
                    const v = vertices[projections[j].idx].position;
                    const pu = v.x * infU.x + v.y * infU.y + v.z * infU.z;
                    const pv = v.x * infV.x + v.y * infV.y + v.z * infV.z;
                    if (pu < uMinI) uMinI = pu;
                    if (pu > uMaxI) uMaxI = pu;
                    if (pv < vMinI) vMinI = pv;
                    if (pv > vMaxI) vMaxI = pv;
                }
                const uSpan = uMaxI - uMinI;
                const vSpan = vMaxI - vMinI;
                // Skip if vertices don't span at least 1mm in both directions
                if (uSpan < 1.0 || vSpan < 1.0) continue;

                let dSum = 0;
                for (let j = clusterStart; j < ci; j++) dSum += projections[j].d;
                const dAvg = dSum / clusterSize;

                // Check existing surfaces
                let alreadyExists = false;
                for (const eq of existingPlaneEqs) {
                    const dot = Math.abs(
                        eq.normal.x * normal.x + eq.normal.y * normal.y + eq.normal.z * normal.z,
                    );
                    if (dot < 0.99) continue;
                    const sign = (eq.normal.x * normal.x + eq.normal.y * normal.y + eq.normal.z * normal.z) > 0 ? 1 : -1;
                    if (Math.abs(dAvg - sign * eq.d) < 1.0) {
                        alreadyExists = true;
                        break;
                    }
                }
                if (alreadyExists) continue;

                // Check already-inferred
                let alreadyInferred = false;
                for (const inf of inferred) {
                    const ip = inf.params as { origin: PsPoint; normal: PsPoint };
                    const dot = Math.abs(
                        ip.normal.x * normal.x + ip.normal.y * normal.y + ip.normal.z * normal.z,
                    );
                    if (dot < 0.99) continue;
                    const infD = ip.origin.x * ip.normal.x + ip.origin.y * ip.normal.y + ip.origin.z * ip.normal.z;
                    const sign = (ip.normal.x * normal.x + ip.normal.y * normal.y + ip.normal.z * normal.z) > 0 ? 1 : -1;
                    if (Math.abs(dAvg - sign * infD) < 1.0) {
                        alreadyInferred = true;
                        break;
                    }
                }
                if (alreadyInferred) continue;

                // Use positive normal direction
                const planeNormal: PsPoint = dAvg >= 0
                    ? { x: normal.x, y: normal.y, z: normal.z }
                    : { x: -normal.x, y: -normal.y, z: -normal.z };
                const planeD = Math.abs(dAvg);

                inferred.push({
                    id: nextId++,
                    surfaceType: 'plane',
                    params: {
                        origin: {
                            x: planeNormal.x * planeD,
                            y: planeNormal.y * planeD,
                            z: planeNormal.z * planeD,
                        },
                        normal: planeNormal,
                    },
                });
            }
        }

        return inferred;
    }

    // ── Surface deduplication ────────────────────────────────────────────────

    /**
     * Tolerance constants for surface deduplication and vertex association.
     * All distances in mm (already PS_TO_MM-scaled).
     */
    private static readonly NORMAL_TOL = 0.001;   // radians (dot product tolerance)
    private static readonly PLANE_DIST_TOL = 0.5;  // mm — plane equation match
    private static readonly VERTEX_PLANE_TOL = 0.5; // mm — vertex on plane
    private static readonly CYL_AXIS_TOL = 0.001;  // radians
    private static readonly CYL_ORIGIN_TOL = 0.5;   // mm — axis line distance
    private static readonly CYL_RADIUS_TOL = 0.01;  // mm
    private static readonly VERTEX_CYL_TOL = 0.5;   // mm — vertex on cylinder

    /**
     * Deduplicate surfaces with the same geometric equation.
     * Planes with same normal and perpendicular distance are merged.
     * Cylinders with same axis line and radius are merged.
     * Returns one representative surface per unique equation.
     * @internal
     */
    private deduplicateSurfaces(surfaces: PsSurface[]): PsSurface[] {
        const unique: PsSurface[] = [];

        for (const surf of surfaces) {
            const p = surf.params as Record<string, unknown>;
            let isDup = false;

            for (const existing of unique) {
                if (existing.surfaceType !== surf.surfaceType) continue;
                const ep = existing.params as Record<string, unknown>;

                if (surf.surfaceType === 'plane') {
                    const n1 = p.normal as PsPoint;
                    const n2 = ep.normal as PsPoint;
                    const dot = n1.x * n2.x + n1.y * n2.y + n1.z * n2.z;
                    if (Math.abs(Math.abs(dot) - 1) >= ParasolidParser.NORMAL_TOL) continue;
                    const o1 = p.origin as PsPoint;
                    const o2 = ep.origin as PsPoint;
                    const d1 = n1.x * o1.x + n1.y * o1.y + n1.z * o1.z;
                    const d2 = n2.x * o2.x + n2.y * o2.y + n2.z * o2.z;
                    const sign = dot > 0 ? 1 : -1;
                    if (Math.abs(d1 - sign * d2) < ParasolidParser.PLANE_DIST_TOL) {
                        isDup = true;
                        break;
                    }
                } else if (surf.surfaceType === 'cylinder' || surf.surfaceType === 'cone') {
                    const a1 = p.axis as PsPoint;
                    const a2 = ep.axis as PsPoint;
                    const dot = a1.x * a2.x + a1.y * a2.y + a1.z * a2.z;
                    if (Math.abs(Math.abs(dot) - 1) >= ParasolidParser.CYL_AXIS_TOL) continue;
                    const r1 = p.radius as number;
                    const r2 = ep.radius as number;
                    if (Math.abs(r1 - r2) >= ParasolidParser.CYL_RADIUS_TOL) continue;
                    // Check colinearity of origins (perpendicular distance to axis line)
                    const o1 = p.origin as PsPoint;
                    const o2 = ep.origin as PsPoint;
                    const dx = o1.x - o2.x, dy = o1.y - o2.y, dz = o1.z - o2.z;
                    const proj = dx * a2.x + dy * a2.y + dz * a2.z;
                    const px = dx - proj * a2.x, py = dy - proj * a2.y, pz = dz - proj * a2.z;
                    if (Math.sqrt(px * px + py * py + pz * pz) < ParasolidParser.CYL_ORIGIN_TOL) {
                        isDup = true;
                        break;
                    }
                }
            }

            if (!isDup) unique.push(surf);
        }

        return unique;
    }

    /**
     * Associate vertices with surfaces they lie on (within tolerance).
     * Returns a Map from surface ID to array of vertex indices (0-based).
     * @internal
     */
    private associateVertices(
        surfaces: PsSurface[],
        vertices: PsVertex[],
    ): Map<number, number[]> {
        const assoc = new Map<number, number[]>();

        for (const surf of surfaces) {
            const p = surf.params as Record<string, unknown>;
            const indices: number[] = [];

            if (surf.surfaceType === 'plane') {
                const origin = p.origin as PsPoint;
                const normal = p.normal as PsPoint;
                for (let i = 0; i < vertices.length; i++) {
                    const v = vertices[i].position;
                    const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                    const dist = Math.abs(dx * normal.x + dy * normal.y + dz * normal.z);
                    if (dist < ParasolidParser.VERTEX_PLANE_TOL) indices.push(i);
                }
            } else if (surf.surfaceType === 'cylinder') {
                const origin = p.origin as PsPoint;
                const axis = p.axis as PsPoint;
                const radius = p.radius as number;
                for (let i = 0; i < vertices.length; i++) {
                    const v = vertices[i].position;
                    const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                    const along = dx * axis.x + dy * axis.y + dz * axis.z;
                    const px = dx - along * axis.x, py = dy - along * axis.y, pz = dz - along * axis.z;
                    const radDist = Math.sqrt(px * px + py * py + pz * pz);
                    if (Math.abs(radDist - radius) < ParasolidParser.VERTEX_CYL_TOL) indices.push(i);
                }
            } else if (surf.surfaceType === 'cone') {
                const origin = p.origin as PsPoint;
                const axis = p.axis as PsPoint;
                const radius = p.radius as number;
                const halfAngle = (p.halfAngle as number) ?? 0;
                const tanHA = Math.tan(halfAngle);
                for (let i = 0; i < vertices.length; i++) {
                    const v = vertices[i].position;
                    const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                    const along = dx * axis.x + dy * axis.y + dz * axis.z;
                    const expectedR = radius + along * tanHA;
                    if (expectedR < 0) continue;
                    const px = dx - along * axis.x, py = dy - along * axis.y, pz = dz - along * axis.z;
                    const radDist = Math.sqrt(px * px + py * py + pz * pz);
                    if (Math.abs(radDist - expectedR) < ParasolidParser.VERTEX_CYL_TOL) indices.push(i);
                }
            }

            assoc.set(surf.id, indices);
        }

        return assoc;
    }

    /**
     * Compute 2D convex hull using Andrew's monotone chain algorithm.
     * Input: array of {u, v, idx} points. Returns hull in CCW order.
     * @internal
     */
    private static convexHull2D(
        pts: Array<{ u: number; v: number; idx: number }>,
    ): Array<{ u: number; v: number; idx: number }> {
        if (pts.length <= 2) return [...pts];

        const sorted = pts.slice().sort((a, b) => a.u - b.u || a.v - b.v);
        const n = sorted.length;

        // Remove near-duplicate points
        const unique: typeof sorted = [sorted[0]];
        for (let i = 1; i < n; i++) {
            const prev = unique[unique.length - 1];
            if (Math.abs(sorted[i].u - prev.u) > 1e-6 || Math.abs(sorted[i].v - prev.v) > 1e-6) {
                unique.push(sorted[i]);
            }
        }
        if (unique.length <= 1) return unique;
        if (unique.length === 2) return unique;

        const cross = (o: typeof sorted[0], a: typeof sorted[0], b: typeof sorted[0]) =>
            (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);

        // Lower hull
        const lower: typeof sorted = [];
        for (const p of unique) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
                lower.pop();
            lower.push(p);
        }
        // Upper hull
        const upper: typeof sorted = [];
        for (let i = unique.length - 1; i >= 0; i--) {
            const p = unique[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
                upper.pop();
            upper.push(p);
        }

        // Remove last point of each half (it's the first of the other)
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    /**
     * Build an orthonormal basis on a plane with the given normal.
     * Returns {uAxis, vAxis} perpendicular to the normal.
     * @internal
     */
    private static planeBasis(normal: PsPoint): { uAxis: PsPoint; vAxis: PsPoint } {
        // Pick an axis not parallel to the normal
        const arbitrary: PsPoint = Math.abs(normal.z) < 0.9
            ? { x: 0, y: 0, z: 1 }
            : { x: 1, y: 0, z: 0 };
        // U = normalize(cross(normal, arbitrary))
        let ux = normal.y * arbitrary.z - normal.z * arbitrary.y;
        let uy = normal.z * arbitrary.x - normal.x * arbitrary.z;
        let uz = normal.x * arbitrary.y - normal.y * arbitrary.x;
        const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
        ux /= uLen; uy /= uLen; uz /= uLen;
        // V = cross(normal, U)
        const vx = normal.y * uz - normal.z * uy;
        const vy = normal.z * ux - normal.x * uz;
        const vz = normal.x * uy - normal.y * ux;
        return { uAxis: { x: ux, y: uy, z: uz }, vAxis: { x: vx, y: vy, z: vz } };
    }

    /**
     * Cluster 2D points into groups by spatial proximity using connected
     * components. Two points are in the same cluster if they are within
     * `threshold` distance (directly or transitively through other points).
     * @internal
     */
    private static clusterPoints2D(
        pts: Array<{ u: number; v: number; idx: number }>,
        threshold: number,
    ): Array<Array<{ u: number; v: number; idx: number }>> {
        const n = pts.length;
        const assigned = new Int32Array(n).fill(-1);
        let nextCluster = 0;
        const threshSq = threshold * threshold;

        for (let i = 0; i < n; i++) {
            if (assigned[i] >= 0) continue;
            const cluster = nextCluster++;
            const queue = [i];
            assigned[i] = cluster;
            while (queue.length > 0) {
                const ci = queue.shift()!;
                const cu = pts[ci].u, cv = pts[ci].v;
                for (let j = 0; j < n; j++) {
                    if (assigned[j] >= 0) continue;
                    const du = cu - pts[j].u, dv = cv - pts[j].v;
                    if (du * du + dv * dv <= threshSq) {
                        assigned[j] = cluster;
                        queue.push(j);
                    }
                }
            }
        }

        const clusters: Array<Array<{ u: number; v: number; idx: number }>> = [];
        for (let c = 0; c < nextCluster; c++) {
            clusters.push(pts.filter((_, i) => assigned[i] === c));
        }
        return clusters;
    }

    /**
     * Test whether a 2D point (pu, pv) is inside a convex polygon (CCW order).
     * Uses the cross-product sign test: inside if left of every edge.
     * @internal
     */
    private static isPointInConvexHull(
        hull: Array<{ u: number; v: number }>,
        pu: number,
        pv: number,
    ): boolean {
        for (let i = 0; i < hull.length; i++) {
            const a = hull[i];
            const b = hull[(i + 1) % hull.length];
            // cross product (edge direction) × (point − edge start)
            const cross = (b.u - a.u) * (pv - a.v) - (b.v - a.v) * (pu - a.u);
            if (cross < -1e-6) return false;
        }
        return true;
    }

    /**
     * Test whether a 2D point is inside an arbitrary simple polygon.
     * Uses the ray-casting (even-odd) algorithm.
     * @internal
     */
    private static isPointInPolygon(
        poly: Array<{ u: number; v: number }>,
        pu: number,
        pv: number,
    ): boolean {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const ui = poly[i].u, vi = poly[i].v;
            const uj = poly[j].u, vj = poly[j].v;
            if ((vi > pv) !== (vj > pv) &&
                pu < (uj - ui) * (pv - vi) / (vj - vi) + ui) {
                inside = !inside;
            }
        }
        return inside;
    }

    /**
     * Build face topology with proper edge loop boundaries derived from
     * vertex positions associated with each surface.
     *
     * For planes:
     *  - Vertices are projected to 2D and clustered by spatial proximity
     *  - Each cluster gets its own face with a convex hull outer boundary
     *  - Cylinders whose axes pass through the face create inner loops (holes)
     *
     * For cylinders:
     *  - Two CIRCLE edges (top/bottom) + two LINE seam edges bound the face
     *
     * @internal
     */
    private buildBoundedTopology(
        surfaces: PsSurface[],
        vertices: PsVertex[],
        vertexSurfaceMap: Map<number, number[]>,
    ): {
        faces: PsFace[];
        loops: PsLoop[];
        edges: PsEdge[];
        curves: PsCurve[];
        extraVertices: PsVertex[];
    } {
        const faces: PsFace[] = [];
        const loops: PsLoop[] = [];
        const edges: PsEdge[] = [];
        const curves: PsCurve[] = [];
        const extraVertices: PsVertex[] = [];

        let nextFaceId = 1;
        let nextLoopId = 1;
        let nextEdgeId = 1;
        let nextCurveId = 1;
        let nextExtraVtxId = vertices.length + 1;

        // Separate surface types for cross-referencing
        const cylSurfaces = surfaces.filter(
            s => s.surfaceType === 'cylinder' || s.surfaceType === 'cone',
        );

        // ──── Build plane faces ─────────────────────────────────────────
        for (const surf of surfaces) {
            if (surf.surfaceType !== 'plane') continue;

            const assocIndices = vertexSurfaceMap.get(surf.id) ?? [];
            if (assocIndices.length < 3) continue;

            const p = surf.params as Record<string, unknown>;
            const origin = p.origin as PsPoint;
            const normal = p.normal as PsPoint;
            const { uAxis, vAxis } = ParasolidParser.planeBasis(normal);

            // Project vertices to 2D
            const pts2D = assocIndices.map(i => {
                const v = vertices[i].position;
                const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                return {
                    u: dx * uAxis.x + dy * uAxis.y + dz * uAxis.z,
                    v: dx * vAxis.x + dy * vAxis.y + dz * vAxis.z,
                    idx: i,
                };
            });

            // Adaptive clustering threshold: use the bounding box diagonal
            // of all 2D-projected vertices to scale the threshold.
            // Large faces (big bbox) get a large threshold so perimeter
            // vertices stay in one cluster.  Small features keep ~60 mm.
            let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
            for (const p2 of pts2D) {
                if (p2.u < uMin) uMin = p2.u;
                if (p2.u > uMax) uMax = p2.u;
                if (p2.v < vMin) vMin = p2.v;
                if (p2.v > vMax) vMax = p2.v;
            }
            const bboxDiag = Math.sqrt((uMax - uMin) ** 2 + (vMax - vMin) ** 2);
            const clusterThreshold = Math.max(60, bboxDiag / 3);
            const clusters = ParasolidParser.clusterPoints2D(pts2D, clusterThreshold);

            for (const cluster of clusters) {
                if (cluster.length < 3) continue;

                // Sort ALL cluster vertices by angle from centroid for a
                // closed polygon.  This gives a more representative centroid
                // than convex-hull-only vertices (which shifts outward for
                // concave shapes).
                const cu = cluster.reduce((s, p) => s + p.u, 0) / cluster.length;
                const cv = cluster.reduce((s, p) => s + p.v, 0) / cluster.length;
                const sorted = cluster.slice().sort((a, b) => {
                    return Math.atan2(a.v - cv, a.u - cu) - Math.atan2(b.v - cv, b.u - cu);
                });
                if (sorted.length < 3) continue;

                // Create outer loop from angle-sorted polygon
                const outerLoopEdges: number[] = [];
                const outerLoopSenses: boolean[] = [];

                for (let hi = 0; hi < sorted.length; hi++) {
                    const startIdx = sorted[hi].idx;
                    const endIdx = sorted[(hi + 1) % sorted.length].idx;
                    const sv = vertices[startIdx];
                    const ev = vertices[endIdx];

                    const curveId = nextCurveId++;
                    curves.push({
                        id: curveId,
                        curveType: 'line',
                        params: { start: sv.position, end: ev.position },
                    });

                    const edgeId = nextEdgeId++;
                    edges.push({
                        id: edgeId,
                        startVertex: sv.id,
                        endVertex: ev.id,
                        curve: curveId,
                        sense: true,
                    });

                    outerLoopEdges.push(edgeId);
                    outerLoopSenses.push(true);
                }

                const outerLoopId = nextLoopId++;
                loops.push({ id: outerLoopId, edges: outerLoopEdges, senses: outerLoopSenses });

                // Convex hull for hole-in-face detection (isPointInConvexHull)
                const hull = ParasolidParser.convexHull2D(cluster);

                // ── Detect cylinder holes (inner loops) ─────────────────
                const innerLoopIds: number[] = [];

                for (const cyl of cylSurfaces) {
                    const cp = cyl.params as Record<string, unknown>;
                    const cylAxis = cp.axis as PsPoint;
                    const cylOrigin = cp.origin as PsPoint;
                    const cylRadius = cp.radius as number;

                    // Axis must be roughly parallel to plane normal
                    const dot = cylAxis.x * normal.x + cylAxis.y * normal.y + cylAxis.z * normal.z;
                    if (Math.abs(Math.abs(dot) - 1) > 0.1) continue;

                    // Check cylinder actually passes through this plane:
                    // compute the axial extent of the cylinder from its vertices
                    // and verify the plane falls within that extent.
                    const cylVtxIndices = vertexSurfaceMap.get(cyl.id) ?? [];
                    if (cylVtxIndices.length === 0) continue;

                    let minAlong = Infinity, maxAlong = -Infinity;
                    for (const vi of cylVtxIndices) {
                        const v = vertices[vi].position;
                        const adx = v.x - cylOrigin.x, ady = v.y - cylOrigin.y, adz = v.z - cylOrigin.z;
                        const along = adx * cylAxis.x + ady * cylAxis.y + adz * cylAxis.z;
                        if (along < minAlong) minAlong = along;
                        if (along > maxAlong) maxAlong = along;
                    }

                    // Project cylinder origin onto the plane
                    const dx = cylOrigin.x - origin.x;
                    const dy = cylOrigin.y - origin.y;
                    const dz = cylOrigin.z - origin.z;
                    const distToPlane = dx * normal.x + dy * normal.y + dz * normal.z;

                    // Distance from cylinder origin to plane, measured along cylinder axis
                    const planeAlongAxis = -distToPlane / dot;
                    const AXIAL_TOL = 2.0; // mm
                    if (planeAlongAxis < minAlong - AXIAL_TOL || planeAlongAxis > maxAlong + AXIAL_TOL) continue;

                    const projX = cylOrigin.x - distToPlane * normal.x;
                    const projY = cylOrigin.y - distToPlane * normal.y;
                    const projZ = cylOrigin.z - distToPlane * normal.z;

                    // Convert projection to 2D hull space
                    const pdx = projX - origin.x, pdy = projY - origin.y, pdz = projZ - origin.z;
                    const pu = pdx * uAxis.x + pdy * uAxis.y + pdz * uAxis.z;
                    const pv = pdx * vAxis.x + pdy * vAxis.y + pdz * vAxis.z;

                    // Check if cylinder center projection falls inside this face's
                    // actual boundary (angular-sorted polygon, not convex hull)
                    if (!ParasolidParser.isPointInPolygon(sorted, pu, pv)) continue;

                    // Create circle inner loop at the intersection
                    const circleCenter: PsPoint = { x: projX, y: projY, z: projZ };
                    const seamPt: PsPoint = {
                        x: circleCenter.x + cylRadius * uAxis.x,
                        y: circleCenter.y + cylRadius * uAxis.y,
                        z: circleCenter.z + cylRadius * uAxis.z,
                    };
                    const seamVtxId = nextExtraVtxId++;
                    extraVertices.push({ id: seamVtxId, position: seamPt });

                    const circleCurveId = nextCurveId++;
                    curves.push({
                        id: circleCurveId,
                        curveType: 'circle',
                        params: { center: circleCenter, normal, radius: cylRadius },
                    });

                    const circleEdgeId = nextEdgeId++;
                    edges.push({
                        id: circleEdgeId,
                        startVertex: seamVtxId,
                        endVertex: seamVtxId, // closed circle
                        curve: circleCurveId,
                        sense: true,
                    });

                    const innerLoopId = nextLoopId++;
                    loops.push({ id: innerLoopId, edges: [circleEdgeId], senses: [true] });
                    innerLoopIds.push(innerLoopId);
                }

                const faceId = nextFaceId++;
                faces.push({
                    id: faceId,
                    surface: surf.id,
                    outerLoop: outerLoopId,
                    innerLoops: innerLoopIds,
                    sense: true,
                });
            }
        }

        // ──── Build cylinder faces ──────────────────────────────────────
        for (const surf of surfaces) {
            if (surf.surfaceType !== 'cylinder') continue;

            const assocIndices = vertexSurfaceMap.get(surf.id) ?? [];
            if (assocIndices.length < 2) continue;

            const p = surf.params as Record<string, unknown>;
            const origin = p.origin as PsPoint;
            const axis = p.axis as PsPoint;
            const radius = p.radius as number;
            const { uAxis, vAxis } = ParasolidParser.planeBasis(axis);

            // Project vertices along axis to find height extent
            const heights: number[] = [];
            for (const i of assocIndices) {
                const v = vertices[i].position;
                const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                heights.push(dx * axis.x + dy * axis.y + dz * axis.z);
            }
            const hMin = Math.min(...heights);
            const hMax = Math.max(...heights);
            if (Math.abs(hMax - hMin) < 0.01) continue;

            const bottomCenter: PsPoint = {
                x: origin.x + hMin * axis.x,
                y: origin.y + hMin * axis.y,
                z: origin.z + hMin * axis.z,
            };
            const topCenter: PsPoint = {
                x: origin.x + hMax * axis.x,
                y: origin.y + hMax * axis.y,
                z: origin.z + hMax * axis.z,
            };

            // Use actual associated vertices sorted by angle around the
            // cylinder axis for the outer loop.  This gives a representative
            // centroid (close to axis midpoint) instead of the biased seam
            // centroid that is offset by radius.
            const cylPts = assocIndices.map(i => {
                const v = vertices[i].position;
                const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                const u = dx * uAxis.x + dy * uAxis.y + dz * uAxis.z;
                const w = dx * vAxis.x + dy * vAxis.y + dz * vAxis.z;
                return { idx: i, angle: Math.atan2(w, u) };
            });
            cylPts.sort((a, b) => a.angle - b.angle);

            // Build edge loop through all associated vertices
            const outerLoopEdges: number[] = [];
            const outerLoopSenses: boolean[] = [];

            if (cylPts.length >= 3) {
                for (let ci = 0; ci < cylPts.length; ci++) {
                    const startIdx = cylPts[ci].idx;
                    const endIdx = cylPts[(ci + 1) % cylPts.length].idx;
                    const sv = vertices[startIdx];
                    const ev = vertices[endIdx];

                    const curveId = nextCurveId++;
                    curves.push({
                        id: curveId,
                        curveType: 'line',
                        params: { start: sv.position, end: ev.position },
                    });

                    const edgeId = nextEdgeId++;
                    edges.push({
                        id: edgeId,
                        startVertex: sv.id,
                        endVertex: ev.id,
                        curve: curveId,
                        sense: true,
                    });

                    outerLoopEdges.push(edgeId);
                    outerLoopSenses.push(true);
                }
            } else {
                // Fallback: synthetic seam for ≤2 associated vertices
                const botSeam: PsPoint = {
                    x: bottomCenter.x + radius * uAxis.x,
                    y: bottomCenter.y + radius * uAxis.y,
                    z: bottomCenter.z + radius * uAxis.z,
                };
                const topSeam: PsPoint = {
                    x: topCenter.x + radius * uAxis.x,
                    y: topCenter.y + radius * uAxis.y,
                    z: topCenter.z + radius * uAxis.z,
                };
                const botVtxId = nextExtraVtxId++;
                const topVtxId = nextExtraVtxId++;
                extraVertices.push({ id: botVtxId, position: botSeam });
                extraVertices.push({ id: topVtxId, position: topSeam });

                const botCircleCurveId = nextCurveId++;
                curves.push({ id: botCircleCurveId, curveType: 'circle', params: { center: bottomCenter, normal: axis, radius } });
                const topCircleCurveId = nextCurveId++;
                curves.push({ id: topCircleCurveId, curveType: 'circle', params: { center: topCenter, normal: axis, radius } });
                const seamLineId = nextCurveId++;
                curves.push({ id: seamLineId, curveType: 'line', params: { start: botSeam, end: topSeam } });

                const botCircleEdgeId = nextEdgeId++;
                edges.push({ id: botCircleEdgeId, startVertex: botVtxId, endVertex: botVtxId, curve: botCircleCurveId, sense: true });
                const seamUpEdgeId = nextEdgeId++;
                edges.push({ id: seamUpEdgeId, startVertex: botVtxId, endVertex: topVtxId, curve: seamLineId, sense: true });
                const topCircleEdgeId = nextEdgeId++;
                edges.push({ id: topCircleEdgeId, startVertex: topVtxId, endVertex: topVtxId, curve: topCircleCurveId, sense: true });

                outerLoopEdges.push(botCircleEdgeId, seamUpEdgeId, topCircleEdgeId, seamUpEdgeId);
                outerLoopSenses.push(true, true, false, false);
            }

            // Add circle curves for CIRCLE entity matching
            const botCircleCurveIdForCircle = nextCurveId++;
            curves.push({
                id: botCircleCurveIdForCircle,
                curveType: 'circle',
                params: { center: bottomCenter, normal: axis, radius },
            });
            const topCircleCurveIdForCircle = nextCurveId++;
            curves.push({
                id: topCircleCurveIdForCircle,
                curveType: 'circle',
                params: { center: topCenter, normal: axis, radius },
            });

            const loopId = nextLoopId++;
            loops.push({
                id: loopId,
                edges: outerLoopEdges,
                senses: outerLoopSenses,
            });

            const faceId = nextFaceId++;
            faces.push({
                id: faceId,
                surface: surf.id,
                outerLoop: loopId,
                innerLoops: [],
                sense: true,
            });
        }

        // ──── Build cone faces ──────────────────────────────────────────
        for (const surf of surfaces) {
            if (surf.surfaceType !== 'cone') continue;

            const assocIndices = vertexSurfaceMap.get(surf.id) ?? [];
            if (assocIndices.length < 2) continue;

            const p = surf.params as Record<string, unknown>;
            const origin = p.origin as PsPoint;
            const axis = p.axis as PsPoint;
            const radius = p.radius as number;
            const halfAngle = (p.halfAngle as number) ?? 0;
            const tanHA = Math.tan(halfAngle);
            const { uAxis, vAxis } = ParasolidParser.planeBasis(axis);

            // Project vertices along axis to find height extent
            const heights: number[] = [];
            for (const i of assocIndices) {
                const v = vertices[i].position;
                const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                heights.push(dx * axis.x + dy * axis.y + dz * axis.z);
            }
            const hMin = Math.min(...heights);
            const hMax = Math.max(...heights);
            if (Math.abs(hMax - hMin) < 0.01) continue;

            const bottomCenter: PsPoint = {
                x: origin.x + hMin * axis.x,
                y: origin.y + hMin * axis.y,
                z: origin.z + hMin * axis.z,
            };
            const topCenter: PsPoint = {
                x: origin.x + hMax * axis.x,
                y: origin.y + hMax * axis.y,
                z: origin.z + hMax * axis.z,
            };
            const botRadius = Math.max(0, radius + hMin * tanHA);
            const topRadius = Math.max(0, radius + hMax * tanHA);

            // Use actual vertices sorted by angle for accurate centroid
            const conePts = assocIndices.map(i => {
                const v = vertices[i].position;
                const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                const u = dx * uAxis.x + dy * uAxis.y + dz * uAxis.z;
                const w = dx * vAxis.x + dy * vAxis.y + dz * vAxis.z;
                return { idx: i, angle: Math.atan2(w, u) };
            });
            conePts.sort((a, b) => a.angle - b.angle);

            const outerLoopEdges: number[] = [];
            const outerLoopSenses: boolean[] = [];

            if (conePts.length >= 3) {
                for (let ci = 0; ci < conePts.length; ci++) {
                    const startIdx = conePts[ci].idx;
                    const endIdx = conePts[(ci + 1) % conePts.length].idx;
                    const sv = vertices[startIdx];
                    const ev = vertices[endIdx];

                    const curveId = nextCurveId++;
                    curves.push({
                        id: curveId,
                        curveType: 'line',
                        params: { start: sv.position, end: ev.position },
                    });

                    const edgeId = nextEdgeId++;
                    edges.push({
                        id: edgeId,
                        startVertex: sv.id,
                        endVertex: ev.id,
                        curve: curveId,
                        sense: true,
                    });

                    outerLoopEdges.push(edgeId);
                    outerLoopSenses.push(true);
                }
            } else {
                // Fallback for 2 vertices
                const botSeam: PsPoint = {
                    x: bottomCenter.x + botRadius * uAxis.x,
                    y: bottomCenter.y + botRadius * uAxis.y,
                    z: bottomCenter.z + botRadius * uAxis.z,
                };
                const topSeam: PsPoint = {
                    x: topCenter.x + topRadius * uAxis.x,
                    y: topCenter.y + topRadius * uAxis.y,
                    z: topCenter.z + topRadius * uAxis.z,
                };
                const botVtxId = nextExtraVtxId++;
                const topVtxId = nextExtraVtxId++;
                extraVertices.push({ id: botVtxId, position: botSeam });
                extraVertices.push({ id: topVtxId, position: topSeam });

                const botCircleCurveId = nextCurveId++;
                curves.push({ id: botCircleCurveId, curveType: 'circle', params: { center: bottomCenter, normal: axis, radius: botRadius } });
                const topCircleCurveId = nextCurveId++;
                curves.push({ id: topCircleCurveId, curveType: 'circle', params: { center: topCenter, normal: axis, radius: topRadius } });
                const seamLineId = nextCurveId++;
                curves.push({ id: seamLineId, curveType: 'line', params: { start: botSeam, end: topSeam } });

                const botEdgeId = nextEdgeId++;
                edges.push({ id: botEdgeId, startVertex: botVtxId, endVertex: botVtxId, curve: botCircleCurveId, sense: true });
                const seamEdgeId = nextEdgeId++;
                edges.push({ id: seamEdgeId, startVertex: botVtxId, endVertex: topVtxId, curve: seamLineId, sense: true });
                const topEdgeId = nextEdgeId++;
                edges.push({ id: topEdgeId, startVertex: topVtxId, endVertex: topVtxId, curve: topCircleCurveId, sense: true });

                outerLoopEdges.push(botEdgeId, seamEdgeId, topEdgeId, seamEdgeId);
                outerLoopSenses.push(true, true, false, false);
            }

            // Circle curves for matching
            const botCircleCurveIdC = nextCurveId++;
            curves.push({ id: botCircleCurveIdC, curveType: 'circle', params: { center: bottomCenter, normal: axis, radius: botRadius } });
            const topCircleCurveIdC = nextCurveId++;
            curves.push({ id: topCircleCurveIdC, curveType: 'circle', params: { center: topCenter, normal: axis, radius: topRadius } });

            const loopId = nextLoopId++;
            loops.push({ id: loopId, edges: outerLoopEdges, senses: outerLoopSenses });

            const faceId = nextFaceId++;
            faces.push({
                id: faceId,
                surface: surf.id,
                outerLoop: loopId,
                innerLoops: [],
                sense: true,
            });
        }

        return { faces, loops, edges, curves, extraVertices };
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
            position: {
                x: pt.x * PS_TO_MM,
                y: pt.y * PS_TO_MM,
                z: pt.z * PS_TO_MM,
            },
        }));

        // ── Step 1: Extract surfaces from binary geometry entities ──────
        const extractedSurfaces = this.extractSurfaces();

        // ── Step 2: Validate candidate planes from type-0x1E entities ───
        // Only keep planes with ≥3 coplanar vertices (filters out LINE curves)
        const validatedSurfaces: PsSurface[] = [];
        for (const surf of extractedSurfaces) {
            if (surf.surfaceType === 'plane') {
                const p = surf.params as { origin: PsPoint; normal: PsPoint };
                let coplanarCount = 0;
                for (const v of vertices) {
                    const dx = v.position.x - p.origin.x;
                    const dy = v.position.y - p.origin.y;
                    const dz = v.position.z - p.origin.z;
                    const dist = Math.abs(dx * p.normal.x + dy * p.normal.y + dz * p.normal.z);
                    if (dist < ParasolidParser.VERTEX_PLANE_TOL) coplanarCount++;
                    if (coplanarCount >= 3) break; // early exit
                }
                if (coplanarCount >= 3) validatedSurfaces.push(surf);
            } else {
                validatedSurfaces.push(surf); // cylinders, cones → keep
            }
        }

        // ── Step 3: Infer additional planes from vertex positions ───────
        const inferredPlanes = this.inferPlanesFromVertices(vertices, validatedSurfaces);

        // ── Step 4: Merge and deduplicate ───────────────────────────────
        const mergedSurfaces = [...validatedSurfaces, ...inferredPlanes];
        const surfaces = this.deduplicateSurfaces(mergedSurfaces);

        // Re-number deduplicated surfaces sequentially
        surfaces.forEach((s, i) => { s.id = i + 1; });

        // ── Vertex-surface association and bounded topology ─────────────
        const vertexSurfaceMap = this.associateVertices(surfaces, vertices);

        const {
            faces, loops, edges, curves, extraVertices,
        } = this.buildBoundedTopology(surfaces, vertices, vertexSurfaceMap);

        // Add any extra vertices created for cylinder seam points
        vertices.push(...extraVertices);

        const shells: PsShell[] = faces.length > 0 ? [{
            id: 1,
            faces: faces.map(f => f.id),
            closed: true,
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
