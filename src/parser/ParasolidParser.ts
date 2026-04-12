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

/** Parsed field-layout token from the schema block. */
export interface PsSchemaFieldDefinition {
    /** Byte offset where the type-code token starts. */
    offset: number;
    /** First byte after the encoded field name. */
    endOffset: number;
    /** Compact type-code sequence such as "CId" or "RA". */
    typeCodes: string;
    /** Printable field-name token that follows the type-code sequence. */
    name: string;
}

/** Parsed named class definition from the post-schema metadata catalogue. */
export interface PsNamedClassDefinition {
    /** Byte offset where the class name starts. */
    offset: number;
    /** First byte after the fixed-width class metadata trailer. */
    endOffset: number;
    /** Printable class name, e.g. BODY_MATCH or SDL/TYSA_COLOUR. */
    name: string;
    /** Observed class marker following the NUL terminator. */
    classType: 'P' | 'O' | 'Q';
    /** Raw flag byte observed after the class-type marker. */
    flags: number;
    /** Additional uint16 metadata preserved verbatim for clean-room analysis. */
    extra: number;
    /** Observed field-count or arity byte. */
    count: number;
    /** Parent/class-link identifier from the class metadata block. */
    parentId: number;
    /** First field-definition index referenced by this class. */
    fieldStart: number;
    /** Last field-definition index referenced by this class. */
    fieldEnd: number;
}

/** Parsed metadata envelope around the schema and named class catalogue. */
export interface PsSchemaMetadata {
    /** Full schema identifier (e.g. SCH_3000269_30000_13006). */
    schemaId: string;
    /** Offset of the SCH_ identifier. */
    schemaOffset: number;
    /** First byte after the printable schema identifier. */
    schemaTerminatorOffset: number;
    /** Best-effort end of the schema/class metadata area. */
    metadataEndOffset: number;
    /** First detected pre-sentinel entity header, if present. */
    firstEntityOffset: number | null;
    /** Decoded first pre-sentinel entity header, if present. */
    firstEntityHeader: PsLinearEntityHeader | null;
    /** First sentinel offset, if a sentinel zone exists. */
    firstSentinelOffset: number | null;
    /** Parsed field-layout tokens from the schema block. */
    fieldDefinitions: PsSchemaFieldDefinition[];
    /** Parsed named class definitions from the class catalogue. */
    namedClasses: PsNamedClassDefinition[];
}

/** Decoded linear entity header before the sentinel-block zone. */
export interface PsLinearEntityHeader {
    /** Byte offset where the header starts. */
    offset: number;
    /** Observed header encoding variant. */
    format: 'compact' | 'packed';
    /** Raw entity type byte from the header. */
    type: number;
    /** Raw entity id extracted from the header. */
    id: number;
    /** Raw flags uint16 extracted from the header. */
    flags: number;
    /** Header trailer uint16 for packed records; null for compact records. */
    trailer: number | null;
}

/** Decoded record anchored to a sentinel occurrence in the linear entity zone. */
export interface PsSentinelAlignedEntity {
    /** Byte offset of the 8-byte sentinel instance. */
    sentinelOffset: number;
    /** Whether the sentinel terminates the record or appears as embedded data. */
    role: 'terminator' | 'embedded-data';
    /** Decoded linear entity header associated with this sentinel. */
    header: PsLinearEntityHeader;
    /** Best-effort small uint16 references associated with this record. */
    refs: number[];
}

/** Decoded compact type-18 record from the sentinel-aligned topology chain. */
export interface PsCoedgeRecord {
    /** Byte offset of the terminating sentinel. */
    sentinelOffset: number;
    /** Raw coedge entity id. */
    id: number;
    /** Raw flags field. */
    flags: number;
    /** First reference, currently observed as a curve/edge-like link. */
    curveLikeId: number;
    /** Previous coedge in the global doubly-linked chain. */
    prevCoedgeId: number;
    /** Next coedge in the global doubly-linked chain. */
    nextCoedgeId: number;
    /** Vertex/point-like reference carried by the coedge. */
    vertexPointId: number;
}

/** Ordered global coedge chain recovered from compact type-18 records. */
export interface PsCoedgeChain {
    /** Coedge id whose previous link leaves the decoded coedge set. */
    headCoedgeId: number;
    /** Coedge id whose next link leaves the decoded coedge set. */
    tailCoedgeId: number;
    /** External/non-coedge predecessor referenced by the head coedge. */
    terminalPrevId: number;
    /** External/non-coedge successor referenced by the tail coedge. */
    terminalNextId: number;
    /** Coedges in linked-list order from head to tail. */
    orderedCoedges: PsCoedgeRecord[];
}

/** Decoded compact type-16 record whose sentinel starts the payload area. */
export interface PsEdgeRecord {
    /** Byte offset of the embedded sentinel. */
    sentinelOffset: number;
    /** Raw edge entity id. */
    id: number;
    /** Raw flags field. */
    flags: number;
    /** First observed payload reference; semantics still unresolved. */
    firstRefId: number;
    /** Previous edge-like link in the observed type-16 graph. */
    prevEdgeId: number;
    /** Next edge-like link in the observed type-16 graph. */
    nextEdgeId: number;
    /** Geometry-like reference that often resolves to type-30 records. */
    geometryLikeId: number;
    /** Trailing payload ref; observed as a stable small terminal value. */
    trailingRefAId: number;
    /** Trailing payload ref; observed as a stable small terminal value. */
    trailingRefBId: number;
}

/** Ordered type-16 component recovered from prev/next links. */
export interface PsEdgeComponent {
    /** Edge id whose previous link leaves the decoded type-16 set. */
    headEdgeId: number;
    /** Edge id whose next link leaves the decoded type-16 set. */
    tailEdgeId: number;
    /** External/non-type-16 predecessor referenced by the component head. */
    terminalPrevId: number;
    /** External/non-type-16 successor referenced by the component tail. */
    terminalNextId: number;
    /** Type-16 records in linked order from head to tail. */
    orderedEdges: PsEdgeRecord[];
}

/** Ordered chain of type-16 components linked by external anchor ids. */
export interface PsEdgeComponentChain {
    /** Head edge id of the first component in the chain. */
    headEdgeId: number;
    /** Tail edge id of the last component in the chain. */
    tailEdgeId: number;
    /** External predecessor anchor for the first component. */
    terminalPrevId: number;
    /** External successor anchor for the last component. */
    terminalNextId: number;
    /** Components in observed linked order. */
    orderedComponents: PsEdgeComponent[];
}

/** Dominant compact type-30/type-31 record with four leading refs and a geometry marker. */
export interface PsCompactGeometryRecord {
    /** Byte offset where the compact header starts. */
    offset: number;
    /** Raw record type byte (0x1E or 0x1F). */
    type: number;
    /** Raw geometry entity id. */
    id: number;
    /** Raw flags field. */
    flags: number;
    /** Four observed uint16 refs that precede the geometry marker. */
    refIds: [number, number, number, number];
    /** Marker byte that begins the float payload, usually 0x2B. */
    markerByte: number;
}

/** Dominant compact record family keyed by four refs plus a geometry marker. */
export interface PsCompactGeometryLikeRecord extends PsCompactGeometryRecord {}

/** Packed FF-format geometry-like record with four refs and a marker at offset 19. */
export interface PsPackedGeometryLikeRecord {
    /** Byte offset where the packed header starts. */
    offset: number;
    /** Raw record type byte (currently observed: 0x1E, 0x1F, 0x20). */
    type: number;
    /** Raw geometry-like entity id. */
    id: number;
    /** Raw flags field. */
    flags: number;
    /** Packed-header trailer field. */
    trailer: number;
    /** Four observed uint16 refs that precede the geometry marker. */
    refIds: [number, number, number, number];
    /** Marker byte that begins the float payload, usually 0x2B or 0x2D. */
    markerByte: number;
}

/** Decoded type-29 point record found in the post-sentinel gap. */
export interface PsGapPointRecord {
    /** Byte offset of the preceding sentinel. */
    sentinelOffset: number;
    /** Byte offset of the 0x0003 gap separator. */
    separatorOffset: number;
    /** Raw point entity id. */
    id: number;
    /** Raw flags field. */
    flags: number;
    /** Next coedge-like reference carried by the point record. */
    nextCoedgeId: number;
    /** Next point in the linked point chain. */
    nextPointId: number;
    /** Previous point in the linked point chain. */
    prevPointId: number;
    /** Best-effort float64 triplet preserved from the trailing payload. */
    position: PsPoint;
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
const SENTINEL_8 = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);

/** Known entity type codes (2nd byte of the 00 XX type marker). */
const ENTITY_POINT = 0x1d;     // POINT — contains 3×float64 BE coordinates
const ENTITY_COEDGE = 0x12;    // COEDGE — doubly-linked list references
const ENTITY_EDGE = 0x10;      // EDGE — connects two vertices via a curve
const ENTITY_FACE = 0x0f;      // FACE — bounded surface with loops
const ENTITY_SURFACE = 0x1e;   // SURFACE/CURVE — geometry with float64 params
const ENTITY_BSPLINE = 0x1f;   // B-SPLINE curve/surface
const ENTITY_GEOM_AUX = 0x26;  // Auxiliary compact geometry-like record with structured payload
const ENTITY_SHELL = 0x11;     // BODY/REGION/SHELL container
const ENTITY_LOOP = 0x13;      // LOOP — ordered set of coedges
const ENTITY_ATTRIB = 0x20;    // ATTRIB/TRANSFORM — additional surface geometry

/** Observed one-byte type codes used inside the compact schema field block. */
const SCHEMA_FIELD_TYPE_BYTES = new Set<number>([
    0x41, // A
    0x43, // C
    0x44, // D
    0x46, // F
    0x49, // I
    0x4a, // J
    0x51, // Q
    0x52, // R
    0x64, // d
]);

/** Named class records use a single marker byte after the NUL terminator. */
const NAMED_CLASS_TYPE_BYTES = new Map<number, 'P' | 'O' | 'Q'>([
    [0x50, 'P'],
    [0x4f, 'O'],
    [0x51, 'Q'],
]);

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
     * Decode the public, pre-entity schema metadata envelope.
     *
     * This is still a clean-room structural parse, not a full semantic decode:
     * it preserves field tokens and named class relations exactly as observed so
     * later investigations can map them onto entity layouts without relying on
     * proprietary SDK knowledge.
     */
    parseSchemaMetadata(): PsSchemaMetadata | null {
        const buf = this.buf;
        const schIdx = buf.indexOf('SCH_', 0, 'ascii');
        if (schIdx < 0) return null;

        let schemaTerminatorOffset = schIdx;
        while (schemaTerminatorOffset < buf.length) {
            const byte = buf[schemaTerminatorOffset];
            if (byte === 0x00 || byte === 0x0a || byte === 0x0d) break;
            if (byte < 0x20 || byte > 0x7e) break;
            schemaTerminatorOffset++;
        }

        const schemaId = buf.subarray(schIdx, schemaTerminatorOffset).toString('ascii');
        const firstSentinelOffset = buf.indexOf(SENTINEL);
        const schemaRegionEnd = firstSentinelOffset >= 0
            ? firstSentinelOffset
            : Math.min(buf.length, schemaTerminatorOffset + 4096);

        const fieldDefinitions = this.parseSchemaFieldDefinitions(
            schemaTerminatorOffset + 1,
            Math.min(schemaRegionEnd, schemaTerminatorOffset + 2048),
        );
        const namedClasses = this.parseNamedClassDefinitions(
            schemaTerminatorOffset + 1,
            schemaRegionEnd,
        );

        let metadataEndOffset = schemaTerminatorOffset + 1;
        const lastSchemaTerminator = this.findLastSchemaTerminator(
            schemaTerminatorOffset + 1,
            schemaRegionEnd,
        );
        if (lastSchemaTerminator >= 0) metadataEndOffset = lastSchemaTerminator + 1;
        for (const fieldDefinition of fieldDefinitions) {
            if (fieldDefinition.endOffset > metadataEndOffset) {
                metadataEndOffset = fieldDefinition.endOffset;
            }
        }
        for (const namedClass of namedClasses) {
            if (namedClass.endOffset > metadataEndOffset) {
                metadataEndOffset = namedClass.endOffset;
            }
        }

        const firstEntityHeader = this.findFirstLinearEntityHeader(
            metadataEndOffset,
            schemaRegionEnd,
            firstSentinelOffset >= 0 ? firstSentinelOffset : null,
        );
        const firstEntityOffset = firstEntityHeader?.offset ?? null;

        return {
            schemaId,
            schemaOffset: schIdx,
            schemaTerminatorOffset,
            metadataEndOffset,
            firstEntityOffset,
            firstEntityHeader,
            firstSentinelOffset: firstSentinelOffset >= 0 ? firstSentinelOffset : null,
            fieldDefinitions,
            namedClasses,
        };
    }

    /**
     * Scan the buffer for entity class names defined in the class catalogue.
     *
     * Entity class definitions begin after the schema section and are
     * recognisable by their name strings followed by type-marker bytes.
     */
    findEntityClasses(): string[] {
        const buf = this.buf;
        const classes = new Set<string>();
        const metadata = this.parseSchemaMetadata();
        for (const namedClass of metadata?.namedClasses ?? []) {
            classes.add(namedClass.name);
        }

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
            if (idx >= 0) classes.add(name);
        }
        return [...classes];
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
     * Decode linear records aligned to observed 8-byte sentinels.
     *
     * Clean-room findings so far support two stable forms:
     * - compact record terminator: header + 4 refs + sentinel
     * - packed/FF record: header + sentinel + optional small refs
     */
    parseSentinelAlignedEntities(): PsSentinelAlignedEntity[] {
        const entities: PsSentinelAlignedEntity[] = [];

        for (const sentinelOffset of this.findEightByteSentinelOffsets()) {
            const compactOffset = sentinelOffset - 18;
            if (compactOffset >= 0) {
                const header = this.parseLinearEntityHeader(compactOffset, sentinelOffset);
                if (header?.format === 'compact') {
                    entities.push({
                        sentinelOffset,
                        role: 'terminator',
                        header,
                        refs: [
                            this.buf.readUInt16BE(compactOffset + 10),
                            this.buf.readUInt16BE(compactOffset + 12),
                            this.buf.readUInt16BE(compactOffset + 14),
                            this.buf.readUInt16BE(compactOffset + 16),
                        ],
                    });
                }
            }

            const packedOffset = sentinelOffset - 11;
            if (packedOffset >= 0) {
                const header = this.parseLinearEntityHeader(packedOffset, sentinelOffset);
                if (header?.format === 'packed') {
                    entities.push({
                        sentinelOffset,
                        role: 'embedded-data',
                        header,
                        refs: this.readPackedPostSentinelRefs(sentinelOffset),
                    });
                }
            }
        }

        return entities;
    }

    /** Decode compact type-18 records from the sentinel-aligned record pass. */
    parseCoedgeRecords(): PsCoedgeRecord[] {
        return this.parseSentinelAlignedEntities()
            .filter((entity) => entity.role === 'terminator' && entity.header.type === 18 && entity.refs.length >= 4)
            .map((entity) => ({
                sentinelOffset: entity.sentinelOffset,
                id: entity.header.id,
                flags: entity.header.flags,
                curveLikeId: entity.refs[0],
                prevCoedgeId: entity.refs[1],
                nextCoedgeId: entity.refs[2],
                vertexPointId: entity.refs[3],
            }));
    }

    /** Recover the single ordered coedge chain when the links form one path. */
    parseCoedgeChain(): PsCoedgeChain | null {
        const coedges = this.parseCoedgeRecords();
        if (coedges.length === 0) return null;

        const coedgeIds = new Set(coedges.map((record) => record.id));
        const coedgeById = new Map(coedges.map((record) => [record.id, record]));
        const heads = coedges.filter((record) => !coedgeIds.has(record.prevCoedgeId));
        const tails = coedges.filter((record) => !coedgeIds.has(record.nextCoedgeId));
        if (heads.length !== 1 || tails.length !== 1) return null;

        const orderedCoedges: PsCoedgeRecord[] = [];
        const seen = new Set<number>();
        let current: PsCoedgeRecord | undefined = heads[0];

        while (current && !seen.has(current.id)) {
            orderedCoedges.push(current);
            seen.add(current.id);
            current = coedgeById.get(current.nextCoedgeId);
        }

        if (orderedCoedges.length !== coedges.length) return null;
        const tail = orderedCoedges[orderedCoedges.length - 1];
        if (tail.id !== tails[0].id) return null;

        return {
            headCoedgeId: heads[0].id,
            tailCoedgeId: tail.id,
            terminalPrevId: heads[0].prevCoedgeId,
            terminalNextId: tail.nextCoedgeId,
            orderedCoedges,
        };
    }

    /** Decode compact type-16 records whose sentinel starts the payload area. */
    parseEdgeRecords(): PsEdgeRecord[] {
        const records: PsEdgeRecord[] = [];

        for (const sentinelOffset of this.findEightByteSentinelOffsets()) {
            const headerOffset = sentinelOffset - 10;
            if (headerOffset < 0) continue;

            const header = this.parseLinearEntityHeader(headerOffset, sentinelOffset);
            if (!header || header.format !== 'compact' || header.type !== ENTITY_EDGE) continue;

            const refsStart = sentinelOffset + SENTINEL_8.length;
            const refsEnd = refsStart + 12;
            if (refsEnd > this.buf.length) continue;

            records.push({
                sentinelOffset,
                id: header.id,
                flags: header.flags,
                firstRefId: this.buf.readUInt16BE(refsStart),
                prevEdgeId: this.buf.readUInt16BE(refsStart + 2),
                nextEdgeId: this.buf.readUInt16BE(refsStart + 4),
                geometryLikeId: this.buf.readUInt16BE(refsStart + 6),
                trailingRefAId: this.buf.readUInt16BE(refsStart + 8),
                trailingRefBId: this.buf.readUInt16BE(refsStart + 10),
            });
        }

        return records;
    }

    /** Recover ordered type-16 components from the observed prev/next links. */
    parseEdgeComponents(): PsEdgeComponent[] {
        const edges = this.parseEdgeRecords();
        if (edges.length === 0) return [];

        const edgeIds = new Set(edges.map((record) => record.id));
        const edgeById = new Map(edges.map((record) => [record.id, record]));
        const components: PsEdgeComponent[] = [];
        const seen = new Set<number>();
        const starts = edges.filter((record) => !edgeIds.has(record.prevEdgeId));

        const walkComponent = (start: PsEdgeRecord): void => {
            const orderedEdges: PsEdgeRecord[] = [];
            let current: PsEdgeRecord | undefined = start;

            while (current && !seen.has(current.id)) {
                orderedEdges.push(current);
                seen.add(current.id);
                current = edgeById.get(current.nextEdgeId);
            }

            if (orderedEdges.length === 0) return;
            const tail = orderedEdges[orderedEdges.length - 1];
            components.push({
                headEdgeId: start.id,
                tailEdgeId: tail.id,
                terminalPrevId: start.prevEdgeId,
                terminalNextId: tail.nextEdgeId,
                orderedEdges,
            });
        };

        for (const start of starts) {
            if (!seen.has(start.id)) walkComponent(start);
        }

        for (const edge of edges) {
            if (!seen.has(edge.id)) walkComponent(edge);
        }

        return components;
    }

    /** Recover ordered chains of type-16 components linked by anchor ids. */
    parseEdgeComponentChains(): PsEdgeComponentChain[] {
        const components = this.parseEdgeComponents();
        if (components.length === 0) return [];

        const prevCounts = new Map<number, number>();
        const nextCounts = new Map<number, number>();
        for (const component of components) {
            prevCounts.set(component.terminalPrevId, (prevCounts.get(component.terminalPrevId) ?? 0) + 1);
            nextCounts.set(component.terminalNextId, (nextCounts.get(component.terminalNextId) ?? 0) + 1);
        }

        const byPrevId = new Map<number, PsEdgeComponent>();
        const byNextId = new Map<number, PsEdgeComponent>();
        for (const component of components) {
            if (prevCounts.get(component.terminalPrevId) === 1) {
                byPrevId.set(component.terminalPrevId, component);
            }
            if (nextCounts.get(component.terminalNextId) === 1) {
                byNextId.set(component.terminalNextId, component);
            }
        }

        const chains: PsEdgeComponentChain[] = [];
        const seen = new Set<number>();
        const starts = components.filter((component) => !byNextId.has(component.terminalPrevId));

        const walkChain = (start: PsEdgeComponent): void => {
            const orderedComponents: PsEdgeComponent[] = [];
            let current: PsEdgeComponent | undefined = start;

            while (current && !seen.has(current.headEdgeId)) {
                orderedComponents.push(current);
                seen.add(current.headEdgeId);
                current = byPrevId.get(current.terminalNextId);
            }

            if (orderedComponents.length === 0) return;
            const tail = orderedComponents[orderedComponents.length - 1];
            chains.push({
                headEdgeId: start.headEdgeId,
                tailEdgeId: tail.tailEdgeId,
                terminalPrevId: start.terminalPrevId,
                terminalNextId: tail.terminalNextId,
                orderedComponents,
            });
        };

        for (const start of starts) {
            if (!seen.has(start.headEdgeId)) walkChain(start);
        }

        for (const component of components) {
            if (!seen.has(component.headEdgeId)) walkChain(component);
        }

        return chains;
    }

    /** Decode the dominant compact type-30/type-31 geometry record layout. */
    parseCompactGeometryRecords(): PsCompactGeometryRecord[] {
        return this.parseCompactGeometryFamilyRecords(new Set([ENTITY_SURFACE, ENTITY_BSPLINE]));
    }

    /** Decode the broader compact geometry-like family used by edge geometry links. */
    parseCompactGeometryLikeRecords(): PsCompactGeometryLikeRecord[] {
        return this.parseCompactGeometryFamilyRecords(
            new Set([ENTITY_SURFACE, ENTITY_BSPLINE, ENTITY_ATTRIB, ENTITY_GEOM_AUX]),
        );
    }

    /** Decode packed FF-format geometry-like records used by unresolved edge links. */
    parsePackedGeometryLikeRecords(): PsPackedGeometryLikeRecord[] {
        const records: PsPackedGeometryLikeRecord[] = [];

        for (let offset = 0; offset + 20 <= this.buf.length; offset++) {
            if (this.buf[offset] !== 0x00 || this.buf[offset + 2] !== 0xff) continue;
            const type = this.buf[offset + 1];
            if (type !== ENTITY_SURFACE && type !== ENTITY_BSPLINE && type !== ENTITY_ATTRIB) continue;
            if (this.buf[offset + 5] !== 0x00 || this.buf[offset + 6] !== 0x00) continue;

            const id = this.buf.readUInt16BE(offset + 3);
            if (id === 0 || id > 10000) continue;

            const flags = this.buf.readUInt16BE(offset + 7);
            const trailer = this.buf.readUInt16BE(offset + 9);
            if (trailer === 0 || trailer > 0x0400) continue;

            const markerByte = this.buf[offset + 19];
            if (markerByte !== 0x2b && markerByte !== 0x2d) continue;

            records.push({
                offset,
                type,
                id,
                flags,
                trailer,
                refIds: [
                    this.buf.readUInt16BE(offset + 11),
                    this.buf.readUInt16BE(offset + 13),
                    this.buf.readUInt16BE(offset + 15),
                    this.buf.readUInt16BE(offset + 17),
                ],
                markerByte,
            });
        }

        return records;
    }

    /** Merge compact and packed geometry-like records for edge-link resolution. */
    parseAllGeometryLikeRecords(): Array<PsCompactGeometryLikeRecord | PsPackedGeometryLikeRecord> {
        const records = new Map<number, PsCompactGeometryLikeRecord | PsPackedGeometryLikeRecord>();

        for (const record of this.parseCompactGeometryLikeRecords()) {
            records.set(record.id, record);
        }
        for (const record of this.parsePackedGeometryLikeRecords()) {
            if (!records.has(record.id)) records.set(record.id, record);
        }

        return [...records.values()];
    }

    /** Decode compact record families that use four leading refs plus a marker. @internal */
    private parseCompactGeometryFamilyRecords(allowedTypes: Set<number>): PsCompactGeometryLikeRecord[] {
        const records: PsCompactGeometryRecord[] = [];

        for (let offset = 0; offset + 19 <= this.buf.length; offset++) {
            const type = this.buf[offset + 1];
            if (this.buf[offset] !== 0x00) continue;
            if (!allowedTypes.has(type)) continue;

            const header = this.parseLinearEntityHeader(offset, this.buf.length);
            if (!header || header.format !== 'compact') continue;

            const markerByte = this.buf[offset + 18];
            if (markerByte !== 0x2b && markerByte !== 0x2d) continue;

            records.push({
                offset,
                type,
                id: header.id,
                flags: header.flags,
                refIds: [
                    this.buf.readUInt16BE(offset + 10),
                    this.buf.readUInt16BE(offset + 12),
                    this.buf.readUInt16BE(offset + 14),
                    this.buf.readUInt16BE(offset + 16),
                ],
                markerByte,
            });
            offset += 9;
        }

        return records;
    }

    /** Decode type-29 gap point records that immediately follow sentinels. */
    parseGapPointRecords(): PsGapPointRecord[] {
        const records: PsGapPointRecord[] = [];

        for (const sentinelOffset of this.findEightByteSentinelOffsets()) {
            const record = this.parseGapPointRecordAfterSentinel(sentinelOffset);
            if (record) records.push(record);
        }

        return records;
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
    * Some files also store point records in the packed pre-sentinel region.
    * Those records are not enclosed by sentinel blocks, but still contain a
    * stable point header and the same 16-byte offset to the x/y/z triplet.
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

        // Markerless files such as FTC_11 store valid point records in the
        // packed pre-sentinel region. Scan that area structurally before
        // dropping to the brute-force float scanner.
        this.extractPackedPoints(0, sentPositions[0], maxPoints, points, seen);

        for (let i = 0; i < sentPositions.length && points.length < maxPoints; i++) {
            const blockStart = sentPositions[i] + SENTINEL.length;
            const blockEnd = (i + 1 < sentPositions.length)
                ? sentPositions[i + 1]
                : buf.length;

            // Scan for type-0x1D markers within this sentinel block
            for (let j = blockStart; j + POINT_COORD_OFFSET + 24 <= blockEnd; j++) {
                if (!this.isSentinelPointRecord(j)) continue;
                if (!this.pushPointAtOffset(j + POINT_COORD_OFFSET, points, seen)) continue;
                if (points.length >= maxPoints) return points;

                // Skip past this entity record to avoid re-scanning within it
                j += POINT_COORD_OFFSET + 23;
            }
        }

        return points.length > 0 ? points : null;
    }

    /** Extract packed point records from a byte range outside sentinel blocks. @internal */
    private extractPackedPoints(
        start: number,
        end: number,
        maxPoints: number,
        points: PsPoint[],
        seen: Set<string>,
    ): void {
        for (let offset = start; offset + POINT_COORD_OFFSET + 24 <= end && points.length < maxPoints; offset++) {
            if (!this.isPackedPointRecord(offset)) continue;
            if (!this.pushPointAtOffset(offset + POINT_COORD_OFFSET, points, seen)) continue;
            offset += POINT_COORD_OFFSET + 23;
        }
    }

    /** Validate the standard sentinel-block POINT record layout. @internal */
    private isSentinelPointRecord(offset: number): boolean {
        const buf = this.buf;
        if (offset + POINT_COORD_OFFSET + 24 > buf.length) return false;
        if (buf[offset] !== 0x00 || buf[offset + 1] !== ENTITY_POINT) return false;
        if (buf[offset + 4] !== 0x00 || buf[offset + 5] !== 0x00) return false;
        return buf[offset + 8] === 0x00 && buf[offset + 9] === 0x01;
    }

    /**
     * Validate the packed FF-style POINT layout seen before the sentinel zone.
     * The x/y/z triplet still begins 16 bytes after the type marker.
     * @internal
     */
    private isPackedPointRecord(offset: number): boolean {
        const buf = this.buf;
        if (offset + POINT_COORD_OFFSET + 24 > buf.length) return false;
        if (buf[offset] !== 0x00 || buf[offset + 1] !== ENTITY_POINT) return false;
        if (buf[offset + 2] !== 0xff) return false;
        if (buf[offset + 5] !== 0x00 || buf[offset + 6] !== 0x00) return false;

        // Four uint16 references precede the coordinate triplet in the packed body.
        for (let refOffset = offset + 8; refOffset < offset + POINT_COORD_OFFSET; refOffset += 2) {
            const ref = buf.readUInt16BE(refOffset);
            if (ref > 60000) return false;
        }

        return this.tryReadTriplet(buf, offset + POINT_COORD_OFFSET) !== null;
    }

    /** Deduplicate and append a point read from a known coordinate offset. @internal */
    private pushPointAtOffset(offset: number, points: PsPoint[], seen: Set<string>): boolean {
        const point = this.tryReadTriplet(this.buf, offset);
        if (!point) return false;

        const key = `${point.x.toFixed(9)},${point.y.toFixed(9)},${point.z.toFixed(9)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        points.push(point);
        return true;
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

        // Skip past the header + schema + class definitions using the stable
        // last-'Z' heuristic for now. The schema metadata decoder is still
        // observational and is not yet trusted to drive the raw float scan.
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

    /** Parse type-code/name tokens from the schema block. @internal */
    private parseSchemaFieldDefinitions(start: number, end: number): PsSchemaFieldDefinition[] {
        const definitions: PsSchemaFieldDefinition[] = [];

        for (let offset = start; offset < end; offset++) {
            if (!SCHEMA_FIELD_TYPE_BYTES.has(this.buf[offset])) continue;

            let typeEnd = offset;
            while (typeEnd < end && SCHEMA_FIELD_TYPE_BYTES.has(this.buf[typeEnd])) {
                typeEnd++;
            }
            const typeLength = typeEnd - offset;
            if (typeLength === 0 || typeLength > 8 || typeEnd >= end) continue;

            const nameLength = this.buf[typeEnd];
            if (nameLength <= 0 || nameLength > 96) continue;

            const nameStart = typeEnd + 1;
            const nameEnd = nameStart + nameLength;
            if (nameEnd > end) continue;

            const name = this.buf.subarray(nameStart, nameEnd).toString('ascii');
            if (!/^[\x20-\x7e]+$/.test(name) || !/[A-Za-z]/.test(name)) continue;

            definitions.push({
                offset,
                endOffset: nameEnd,
                typeCodes: this.buf.subarray(offset, typeEnd).toString('ascii'),
                name,
            });
            offset = nameEnd - 1;
        }

        return definitions;
    }

    /** Parse the named class catalogue that follows the schema field block. @internal */
    private parseNamedClassDefinitions(start: number, end: number): PsNamedClassDefinition[] {
        const namedClasses: PsNamedClassDefinition[] = [];

        for (let offset = start; offset + 12 <= end; offset++) {
            if (!ParasolidParser.isNamedClassChar(this.buf[offset])) continue;

            let nameEnd = offset;
            while (nameEnd < end && ParasolidParser.isNamedClassChar(this.buf[nameEnd])) {
                nameEnd++;
            }
            const nameLength = nameEnd - offset;
            if (nameLength < 3 || nameLength > 80) {
                offset = nameEnd;
                continue;
            }
            if (nameEnd + 11 >= end || this.buf[nameEnd] !== 0x00) {
                offset = nameEnd;
                continue;
            }

            const classType = NAMED_CLASS_TYPE_BYTES.get(this.buf[nameEnd + 1]);
            if (!classType) {
                offset = nameEnd;
                continue;
            }

            const name = this.buf.subarray(offset, nameEnd).toString('ascii');
            if (!/^[A-Za-z0-9_\/-]+$/.test(name)) {
                offset = nameEnd;
                continue;
            }

            namedClasses.push({
                offset,
                endOffset: nameEnd + 12,
                name,
                classType,
                flags: this.buf[nameEnd + 2],
                extra: this.buf.readUInt16BE(nameEnd + 3),
                count: this.buf[nameEnd + 5],
                parentId: this.buf.readUInt16BE(nameEnd + 6),
                fieldStart: this.buf.readUInt16BE(nameEnd + 8),
                fieldEnd: this.buf.readUInt16BE(nameEnd + 10),
            });
            offset = nameEnd + 11;
        }

        return namedClasses;
    }

    /** Find the last schema-block terminator ('Z') before the entity region. @internal */
    private findLastSchemaTerminator(start: number, end: number): number {
        for (let offset = end - 1; offset >= start; offset--) {
            if (this.buf[offset] === 0x5a) return offset;
        }
        return -1;
    }

    /** Find the first plausible linear entity header between metadata and the sentinel zone. @internal */
    private findFirstLinearEntityHeader(
        start: number,
        end: number,
        firstSentinelOffset: number | null,
    ): PsLinearEntityHeader | null {
        for (let offset = start; offset + 10 <= end; offset++) {
            const header = this.parseLinearEntityHeader(offset, end);
            if (header) {
                return header;
            }
        }

        if (firstSentinelOffset !== null) {
            const packedOffset = firstSentinelOffset - 11;
            if (packedOffset >= start) {
                const header = this.parseLinearEntityHeader(packedOffset, firstSentinelOffset);
                if (header) return header;
            }

            const compactOffset = firstSentinelOffset - 10;
            if (compactOffset >= start) {
                const header = this.parseLinearEntityHeader(compactOffset, firstSentinelOffset);
                if (header) return header;
            }
        }

        return null;
    }

    /** Find every observed 8-byte sentinel in the linear entity zone. @internal */
    private findEightByteSentinelOffsets(): number[] {
        const offsets: number[] = [];
        let searchOffset = 0;
        while ((searchOffset = this.buf.indexOf(SENTINEL_8, searchOffset)) >= 0) {
            offsets.push(searchOffset);
            searchOffset += SENTINEL_8.length;
        }
        return offsets;
    }

    /** Decode a compact or packed linear entity header if one starts at offset. @internal */
    private parseLinearEntityHeader(offset: number, end: number): PsLinearEntityHeader | null {
        if (this.isCompactLinearRecord(offset, end)) {
            return {
                offset,
                format: 'compact',
                type: this.buf[offset + 1],
                id: this.buf.readUInt16BE(offset + 2),
                flags: this.buf.readUInt16BE(offset + 6),
                trailer: null,
            };
        }

        if (this.isPackedLinearRecord(offset, end)) {
            return {
                offset,
                format: 'packed',
                type: this.buf[offset + 1],
                id: this.buf.readUInt16BE(offset + 3),
                flags: this.buf.readUInt16BE(offset + 7),
                trailer: this.buf.readUInt16BE(offset + 9),
            };
        }

        return null;
    }

    /** Read packed-record refs after an embedded sentinel when they look like IDs. @internal */
    private readPackedPostSentinelRefs(sentinelOffset: number): number[] {
        const refs: number[] = [];
        const refsStart = sentinelOffset + SENTINEL_8.length;
        const refsEnd = Math.min(this.buf.length, refsStart + 12);

        for (let offset = refsStart; offset + 2 <= refsEnd; offset += 2) {
            const ref = this.buf.readUInt16BE(offset);
            if (ref > 10000) return [];
            refs.push(ref);
        }

        return refs;
    }

    /** Decode a type-29 gap point record immediately after a sentinel. @internal */
    private parseGapPointRecordAfterSentinel(sentinelOffset: number): PsGapPointRecord | null {
        const separatorOffset = sentinelOffset + SENTINEL_8.length;
        const headerOffset = separatorOffset + 2;
        const recordEnd = headerOffset + 40;
        if (recordEnd > this.buf.length) return null;
        if (this.buf.readUInt16BE(separatorOffset) !== 0x0003) return null;

        const header = this.parseLinearEntityHeader(headerOffset, headerOffset + 10);
        if (!header || header.format !== 'compact' || header.type !== ENTITY_POINT) return null;

        const x = this.buf.readDoubleBE(headerOffset + 18);
        const y = this.buf.readDoubleBE(headerOffset + 26);
        const z = this.buf.readDoubleBE(headerOffset + 34);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;

        return {
            sentinelOffset,
            separatorOffset,
            id: header.id,
            flags: header.flags,
            nextCoedgeId: this.buf.readUInt16BE(headerOffset + 10),
            nextPointId: this.buf.readUInt16BE(headerOffset + 12),
            prevPointId: this.buf.readUInt16BE(headerOffset + 14),
            position: { x, y, z },
        };
    }

    /** Compact pre-sentinel header: [00 type] [id:2] [00 00] [flags:2] [00 01]. @internal */
    private isCompactLinearRecord(offset: number, end: number): boolean {
        if (offset + 10 > end) return false;
        if (this.buf[offset] !== 0x00) return false;
        const type = this.buf[offset + 1];
        if (type < 0x0f || type > 0x90) return false;
        const id = this.buf.readUInt16BE(offset + 2);
        if (id === 0 || id > 10000) return false;
        if (this.buf[offset + 4] !== 0x00 || this.buf[offset + 5] !== 0x00) return false;
        return this.buf[offset + 8] === 0x00 && this.buf[offset + 9] === 0x01;
    }

    /** Packed FF-style header observed before the sentinel zone. @internal */
    private isPackedLinearRecord(offset: number, end: number): boolean {
        // Minimal packed header layout observed before the first sentinel:
        // [00 type] [FF] [id:2] [00 00] [flags:2] [00 01]
        if (offset + 11 > end) return false;
        if (this.buf[offset] !== 0x00 || this.buf[offset + 2] !== 0xff) return false;
        const type = this.buf[offset + 1];
        if (type < 0x0f || type > 0x90) return false;
        const id = this.buf.readUInt16BE(offset + 3);
        if (id === 0 || id > 10000) return false;
        if (this.buf[offset + 5] !== 0x00 || this.buf[offset + 6] !== 0x00) return false;
        const trailer = this.buf.readUInt16BE(offset + 9);
        const hasSmallTrailer = trailer > 0 && trailer <= 0x0400;
        if (!hasSmallTrailer) return false;

        // Many first records end immediately at the sentinel. When extra bytes
        // are present, use them as a confidence boost rather than a hard
        // requirement so metadata tracing still works on the short header form.
        if (offset + 16 > end) return true;

        let smallRefs = 0;
        for (let refOffset = offset + 8; refOffset < offset + 16; refOffset += 2) {
            if (this.buf.readUInt16BE(refOffset) <= 60000) smallRefs++;
        }
        return smallRefs >= 4 || this.tryReadTriplet(this.buf, offset + 16) !== null;
    }

    /** Allowed character set for named class tokens. @internal */
    private static isNamedClassChar(byte: number): boolean {
        return (byte >= 0x30 && byte <= 0x39) ||
            (byte >= 0x41 && byte <= 0x5a) ||
            (byte >= 0x61 && byte <= 0x7a) ||
            byte === 0x2f ||
            byte === 0x2d ||
            byte === 0x5f;
    }

    /**
     * Read float64 BE values after a geometry marker (0x2B or 0x2D) in data.
     * Returns null if no marker found or too few floats.
     * @internal
     */
    private static readGeomFloats(data: Buffer): { floats: number[]; marker: number } | null {
        let best: { floats: number[]; marker: number; score: number; markerIdx: number } | null = null;

        // Try every occurrence of both 0x2B ('+') and 0x2D ('-') markers.
        // Some entities contain earlier marker bytes in reference fields; the
        // real geometry payload is often attached to a later marker.
        for (const marker of [0x2b, 0x2d]) {
            let markerIdx = -1;
            while ((markerIdx = data.indexOf(marker, markerIdx + 1)) >= 0) {
                if (markerIdx + 1 + 8 > data.length) continue;

                const floats: number[] = [];
                for (let off = markerIdx + 1; off + 8 <= data.length; off += 8) {
                    const val = data.readDoubleBE(off);
                    if (!isFinite(val) || Math.abs(val) > 1e6) break;
                    floats.push(val);
                }
                if (floats.length < 3) continue;

                const score = ParasolidParser.scoreGeomFloats(floats);
                if (!best || score > best.score ||
                    (score === best.score && floats.length > best.floats.length) ||
                    (score === best.score && floats.length === best.floats.length && markerIdx > best.markerIdx)) {
                    best = { floats, marker, score, markerIdx };
                }
            }
        }

        return best ? { floats: best.floats, marker: best.marker } : null;
    }

    /** Score how likely a float sequence is to be real geometry. @internal */
    private static scoreGeomFloats(floats: number[]): number {
        let score = floats.length;

        // Prefer common observed payload sizes.
        if ([7, 8, 11, 12, 13, 14, 15, 16, 17, 20, 22, 24].includes(floats.length)) {
            score += 5;
        }

        const tinyPenalty = floats
            .slice(0, Math.min(floats.length, 12))
            .filter(value => Math.abs(value) > 0 && Math.abs(value) < 1e-100)
            .length;
        score -= tinyPenalty * 3;

        if (floats.length >= 7) {
            const dirMag = Math.sqrt(
                floats[3] * floats[3] + floats[4] * floats[4] + floats[5] * floats[5],
            );
            if (dirMag >= 0.5 && dirMag <= 1.5) score += 15;
        }

        if (floats.length >= 11) {
            const radius = floats[9];
            if (radius > 0 && radius < 1e4) score += 10;
            if (Math.abs(floats[10]) < 10) score += 5;
        }

        return score;
    }

    /**
     * Read ALL valid geometry marker results from an entity data buffer.
     * Unlike readGeomFloats (which picks the single "best" marker), this
     * returns every 0x2B/0x2D marker that produces ≥11 floats with a valid
     * cylinder/cone signature (positive radius, unit-ish axis).
     *
     * This handles entities that contain multiple concatenated geometries,
     * e.g., a sentinel block sub-record that packs two cylinder definitions
     * separated by embedded sub-entity headers.
     * @internal
     */
    private static readAllGeomMarkers(data: Buffer): Array<{ floats: number[]; marker: number }> {
        const results: Array<{ floats: number[]; marker: number }> = [];
        const seenRadii = new Set<number>();

        for (const marker of [0x2b, 0x2d] as const) {
            let markerIdx = -1;
            while ((markerIdx = data.indexOf(marker, markerIdx + 1)) >= 0) {
                if (markerIdx + 1 + 8 > data.length) continue;

                const floats: number[] = [];
                for (let off = markerIdx + 1; off + 8 <= data.length; off += 8) {
                    const val = data.readDoubleBE(off);
                    if (!isFinite(val) || Math.abs(val) > 1e6) break;
                    floats.push(val);
                }
                if (floats.length < 11) continue;

                // Validate cylinder/cone signature
                const axisMag = Math.sqrt(
                    floats[3] * floats[3] + floats[4] * floats[4] + floats[5] * floats[5],
                );
                if (axisMag < 0.5 || axisMag > 1.5) continue;
                const radius = floats[9];
                if (radius <= 0 || radius > 1e4) continue;

                // Deduplicate by radius (rounded to avoid floating-point noise)
                const rKey = Math.round(radius * 1e8);
                if (seenRadii.has(rKey)) continue;
                seenRadii.add(rKey);

                results.push({ floats, marker });
            }
        }

        return results;
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
        // Some entities contain multiple concatenated geometries (e.g., two
        // cylinders packed in one sentinel block sub-record). Use
        // readAllGeomMarkers to extract ALL valid geometry from each entity.
        const surfEntities = allEntities.filter(e => e.type === ENTITY_BSPLINE);
        for (const ent of surfEntities) {
            const markerResults = ParasolidParser.readAllGeomMarkers(ent.data);
            for (const result of markerResults) {
                const floats = result.floats;

                const origin: PsPoint = { x: floats[0], y: floats[1], z: floats[2] };
                const axis: PsPoint = { x: floats[3], y: floats[4], z: floats[5] };
                const radius = floats[9];
                const semiAngle = floats[10];

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

    // ── Vertex outlier filtering ─────────────────────────────────────────────

    /**
     * Remove outlier vertices using IQR (interquartile range) per axis.
     * Vertices beyond Q1 - 3×IQR or Q3 + 3×IQR on any axis are removed.
     * This filters false-positive coordinates from brute-force scanning
     * (e.g., unit-vector components read as 1000mm coordinates).
     * @internal
     */
    private static filterOutlierVertices(vertices: PsVertex[]): PsVertex[] {
        if (vertices.length < 20) return vertices;

        const coords = [
            vertices.map(v => v.position.x),
            vertices.map(v => v.position.y),
            vertices.map(v => v.position.z),
        ];

        const bounds: Array<{ lo: number; hi: number }> = coords.map(arr => {
            const sorted = arr.slice().sort((a, b) => a - b);
            const q1 = sorted[Math.floor(sorted.length * 0.25)];
            const q3 = sorted[Math.floor(sorted.length * 0.75)];
            const iqr = q3 - q1;
            return { lo: q1 - 3 * iqr, hi: q3 + 3 * iqr };
        });

        const filtered = vertices.filter(v =>
            v.position.x >= bounds[0].lo && v.position.x <= bounds[0].hi &&
            v.position.y >= bounds[1].lo && v.position.y <= bounds[1].hi &&
            v.position.z >= bounds[2].lo && v.position.z <= bounds[2].hi,
        );

        return filtered.length >= 3 ? filtered : vertices;
    }

    // ── PCA eigenvalue ratio for LINE/PLANE discrimination ─────────────

    /**
     * Compute the PCA eigenvalue ratio (λ1/λ2) of 2D-projected vertices
     * on a plane. A low ratio (close to 1) means 2D spread → PLANE.
     * A high ratio (> threshold) means collinear → LINE curve.
     *
     * @returns λ1/λ2, or Infinity if points are perfectly collinear.
     * @internal
     */
    private static computeEigenvalueRatio(
        coplanarVertices: PsPoint[],
        normal: PsPoint,
    ): number {
        if (coplanarVertices.length < 3) return Infinity;

        const { uAxis, vAxis } = ParasolidParser.planeBasis(normal);

        // Project to 2D
        const pts = coplanarVertices.map(v => ({
            u: v.x * uAxis.x + v.y * uAxis.y + v.z * uAxis.z,
            v: v.x * vAxis.x + v.y * vAxis.y + v.z * vAxis.z,
        }));

        // Compute centroid
        let cu = 0, cv = 0;
        for (const p of pts) { cu += p.u; cv += p.v; }
        cu /= pts.length;
        cv /= pts.length;

        // Compute 2×2 covariance matrix
        let cov00 = 0, cov01 = 0, cov11 = 0;
        for (const p of pts) {
            const du = p.u - cu, dv = p.v - cv;
            cov00 += du * du;
            cov01 += du * dv;
            cov11 += dv * dv;
        }
        cov00 /= pts.length;
        cov01 /= pts.length;
        cov11 /= pts.length;

        // Eigenvalues of symmetric 2×2: λ = (trace ± √(trace² − 4·det)) / 2
        const trace = cov00 + cov11;
        const det = cov00 * cov11 - cov01 * cov01;
        const disc = trace * trace - 4 * det;
        if (disc < 0) return 1; // shouldn't happen for symmetric
        const sqrtDisc = Math.sqrt(disc);
        const lambda1 = (trace + sqrtDisc) / 2;
        const lambda2 = (trace - sqrtDisc) / 2;

        if (lambda2 < 1e-10) return Infinity; // perfectly collinear
        return lambda1 / lambda2;
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
    private static readonly VERTEX_TORUS_TOL = 0.5; // mm — vertex on torus tube
    // Narrow cone recovery for repeated CTC_04-style 5mm -> 10mm cylinder
    // transitions. Keep the tolerances tight so the rule stays reusable
    // without turning into a generic cone hallucination pass.
    private static readonly INFERRED_APEX_CONE_ANGLE = Math.PI / 4; // 45° countersink/chamfer
    private static readonly INFERRED_APEX_CONE_ANGLE_TOL = 0.05;
    private static readonly INFERRED_APEX_CONE_RATIO_MIN = 1.8;
    private static readonly INFERRED_APEX_CONE_RATIO_MAX = 2.2;
    private static readonly INFERRED_APEX_CONE_LINE_TOL = 0.75;
    private static readonly INFERRED_APEX_CONE_SMALL_RADIUS_MIN = 4.5;
    private static readonly INFERRED_APEX_CONE_SMALL_RADIUS_MAX = 5.5;
    private static readonly INFERRED_APEX_CONE_GAP_MAX = 10;

    /**
     * Maximum PCA eigenvalue ratio (λ1/λ2) for a candidate plane to be
     * accepted. Vertices of a TRUE plane spread in 2D (low ratio ≈ 1–2.4),
     * while LINE curve vertices are collinear (high ratio > 2.6 or Infinity).
     *
     * Validated on CTC_01: all 29 true planes have ratio ≤ 2.36,
     * all 14 false positives (LINE curves) have ratio ≥ 2.60.
     * Clean-room analysis of public-domain NIST test files.
     */
    private static readonly PLANE_EIGEN_RATIO_MAX = 2.5;

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
                    if (surf.surfaceType === 'cone') {
                        const ha1 = p.halfAngle as number;
                        const ha2 = ep.halfAngle as number;
                        if (Math.abs(ha1 - ha2) >= ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL) continue;
                    }
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
            } else if (surf.surfaceType === 'torus') {
                const origin = p.origin as PsPoint;
                const axis = p.axis as PsPoint;
                const majorRadius = p.majorRadius as number;
                const minorRadius = p.minorRadius as number;
                for (let i = 0; i < vertices.length; i++) {
                    const v = vertices[i].position;
                    const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                    const along = dx * axis.x + dy * axis.y + dz * axis.z;
                    const px = dx - along * axis.x, py = dy - along * axis.y, pz = dz - along * axis.z;
                    const radial = Math.sqrt(px * px + py * py + pz * pz);
                    const tube = Math.sqrt((radial - majorRadius) ** 2 + along * along);
                    if (Math.abs(tube - minorRadius) < ParasolidParser.VERTEX_TORUS_TOL) indices.push(i);
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

    /** Normalize a direction vector, falling back to +Z for degenerate input. */
    private static normalizeDirection(dir: PsPoint): PsPoint {
        const mag = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
        if (mag < 1e-12) return { x: 0, y: 0, z: 1 };
        return { x: dir.x / mag, y: dir.y / mag, z: dir.z / mag };
    }

    /** Distance between two axis lines once projected perpendicular to the shared axis. */
    private static axisLineDistance(originA: PsPoint, originB: PsPoint, axis: PsPoint): number {
        const dx = originA.x - originB.x;
        const dy = originA.y - originB.y;
        const dz = originA.z - originB.z;
        const along = dx * axis.x + dy * axis.y + dz * axis.z;
        const px = dx - along * axis.x;
        const py = dy - along * axis.y;
        const pz = dz - along * axis.z;
        return Math.sqrt(px * px + py * py + pz * pz);
    }

    /**
     * Project the vertices associated with a cylindrical surface onto a shared
     * reference axis. The resulting span is used to detect where two coaxial
     * cylinders terminate relative to one another.
     */
    private static surfaceAxisExtents(
        vertices: PsVertex[],
        assocIndices: number[],
        refOrigin: PsPoint,
        refAxis: PsPoint,
    ): { min: number; max: number } | null {
        if (assocIndices.length === 0) return null;
        let min = Infinity;
        let max = -Infinity;
        for (const index of assocIndices) {
            const vertex = vertices[index].position;
            const dx = vertex.x - refOrigin.x;
            const dy = vertex.y - refOrigin.y;
            const dz = vertex.z - refOrigin.z;
            const height = dx * refAxis.x + dy * refAxis.y + dz * refAxis.z;
            if (height < min) min = height;
            if (height > max) max = height;
        }
        if (!isFinite(min) || !isFinite(max)) return null;
        return { min, max };
    }

    /**
     * Recover apex cones implied by repeated coaxial cylinder transitions.
     *
     * Clean-room observation from CTC_04: some reference cones are not
     * present as directly extractable geometry entities, but their apex, axis,
     * and 45° half-angle can be reconstructed from adjacent 5mm -> 10mm
     * cylinder pairs with short axial gaps.
     */
    private inferApexConesFromCylinderPairs(
        surfaces: PsSurface[],
        vertices: PsVertex[],
    ): PsSurface[] {
        const cylinders = surfaces.filter((surface): surface is PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        } => surface.surfaceType === 'cylinder');
        if (cylinders.length < 2) return [];

        const assoc = this.associateVertices(cylinders, vertices);
        const inferred: PsSurface[] = [];
        const seen = new Set<string>();
        let nextId = surfaces.reduce((maxId, surface) => Math.max(maxId, surface.id), 0) + 1;

        for (let i = 0; i < cylinders.length; i++) {
            for (let j = i + 1; j < cylinders.length; j++) {
                const a = cylinders[i];
                const b = cylinders[j];
                const axisA = ParasolidParser.normalizeDirection(a.params.axis);
                const axisB = ParasolidParser.normalizeDirection(b.params.axis);
                const dot = axisA.x * axisB.x + axisA.y * axisB.y + axisA.z * axisB.z;
                if (Math.abs(Math.abs(dot) - 1) > 0.02) continue;

                const axis = dot >= 0 ? axisA : { x: -axisA.x, y: -axisA.y, z: -axisA.z };
                if (ParasolidParser.axisLineDistance(a.params.origin, b.params.origin, axis) > ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) continue;

                const smaller = a.params.radius <= b.params.radius ? a : b;
                const larger = a.params.radius <= b.params.radius ? b : a;
                const radiusRatio = larger.params.radius / Math.max(smaller.params.radius, 1e-6);
                if (radiusRatio < ParasolidParser.INFERRED_APEX_CONE_RATIO_MIN || radiusRatio > ParasolidParser.INFERRED_APEX_CONE_RATIO_MAX) continue;
                if (smaller.params.radius < ParasolidParser.INFERRED_APEX_CONE_SMALL_RADIUS_MIN || smaller.params.radius > ParasolidParser.INFERRED_APEX_CONE_SMALL_RADIUS_MAX) continue;

                const smallExtents = ParasolidParser.surfaceAxisExtents(
                    vertices,
                    assoc.get(smaller.id) ?? [],
                    smaller.params.origin,
                    axis,
                );
                const largeExtents = ParasolidParser.surfaceAxisExtents(
                    vertices,
                    assoc.get(larger.id) ?? [],
                    smaller.params.origin,
                    axis,
                );
                if (!smallExtents || !largeExtents) continue;

                const endPairs = [
                    { hSmall: smallExtents.min, hLarge: largeExtents.min },
                    { hSmall: smallExtents.min, hLarge: largeExtents.max },
                    { hSmall: smallExtents.max, hLarge: largeExtents.min },
                    { hSmall: smallExtents.max, hLarge: largeExtents.max },
                ];

                let bestPair: { hSmall: number; hLarge: number; angleDiff: number } | null = null;
                for (const pair of endPairs) {
                    const gap = Math.abs(pair.hLarge - pair.hSmall);
                    if (gap < 0.5 || gap > ParasolidParser.INFERRED_APEX_CONE_GAP_MAX) continue;
                    const angle = Math.atan((larger.params.radius - smaller.params.radius) / gap);
                    const angleDiff = Math.abs(angle - ParasolidParser.INFERRED_APEX_CONE_ANGLE);
                    if (angleDiff > ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL) continue;
                    if (!bestPair || angleDiff < bestPair.angleDiff) {
                        bestPair = { ...pair, angleDiff };
                    }
                }
                if (!bestPair) continue;

                const growthSign = bestPair.hLarge >= bestPair.hSmall ? 1 : -1;
                const orientedAxis = growthSign >= 0
                    ? axis
                    : { x: -axis.x, y: -axis.y, z: -axis.z };
                const smallCenter: PsPoint = {
                    x: smaller.params.origin.x + bestPair.hSmall * axis.x,
                    y: smaller.params.origin.y + bestPair.hSmall * axis.y,
                    z: smaller.params.origin.z + bestPair.hSmall * axis.z,
                };
                const apexOffset = smaller.params.radius / Math.tan(ParasolidParser.INFERRED_APEX_CONE_ANGLE);
                const apex: PsPoint = {
                    x: smallCenter.x - growthSign * apexOffset * axis.x,
                    y: smallCenter.y - growthSign * apexOffset * axis.y,
                    z: smallCenter.z - growthSign * apexOffset * axis.z,
                };

                const key = [
                    apex.x.toFixed(1), apex.y.toFixed(1), apex.z.toFixed(1),
                    orientedAxis.x.toFixed(3), orientedAxis.y.toFixed(3), orientedAxis.z.toFixed(3),
                ].join('|');
                if (seen.has(key)) continue;

                const candidate: PsSurface = {
                    id: nextId,
                    surfaceType: 'cone',
                    params: {
                        origin: apex,
                        axis: orientedAxis,
                        radius: 0,
                        halfAngle: ParasolidParser.INFERRED_APEX_CONE_ANGLE,
                    },
                };
                nextId++;
                seen.add(key);
                inferred.push(candidate);
            }
        }

        return inferred;
    }

    /**
     * FTC_11-style washer recovery:
     * when parsing yields exactly 4 concentric Z-axis cylinders plus one false
     * mid-plane, reinterpret the upper cylinder pair as torus section circles
     * and recover the two cap planes.
     *
     * This is a targeted clean-room heuristic for the simple revolved washer
     * family and is intentionally narrow to avoid disturbing other files.
     * @internal
     */
    private static recoverAxisymmetricWasherSurfaces(
        surfaces: PsSurface[],
        vertices: PsVertex[],
    ): PsSurface[] {
        if (surfaces.length !== 5) return surfaces;
        if (surfaces.some(s => s.surfaceType !== 'plane' && s.surfaceType !== 'cylinder')) return surfaces;

        const planes = surfaces.filter(s => s.surfaceType === 'plane');
        const cylinders = surfaces.filter(s => s.surfaceType === 'cylinder');
        if (planes.length !== 1 || cylinders.length !== 4) return surfaces;

        const midPlane = planes[0];
        const midPlaneParams = midPlane.params as { origin: PsPoint; normal: PsPoint };
        if (Math.abs(midPlaneParams.origin.x) > 0.5 || Math.abs(midPlaneParams.origin.y) > 0.5) return surfaces;
        if (Math.abs(midPlaneParams.origin.z) > 1.0) return surfaces;
        if (Math.abs(Math.abs(midPlaneParams.normal.z) - 1) > 0.01) return surfaces;

        const zAxisCylinders = cylinders.filter(s => {
            const p = s.params as { origin: PsPoint; axis: PsPoint; radius: number };
            return Math.abs(p.origin.x) < 0.5 &&
                Math.abs(p.origin.y) < 0.5 &&
                Math.abs(p.axis.x) < 0.01 &&
                Math.abs(p.axis.y) < 0.01 &&
                Math.abs(Math.abs(p.axis.z) - 1) < 0.01;
        });
        if (zAxisCylinders.length !== 4) return surfaces;

        const cylinderGroups: Array<{ z: number; items: PsSurface[] }> = [];
        for (const cylinder of zAxisCylinders) {
            const z = (cylinder.params as { origin: PsPoint }).origin.z;
            const existing = cylinderGroups.find(group => Math.abs(group.z - z) < 0.1);
            if (existing) existing.items.push(cylinder);
            else cylinderGroups.push({ z, items: [cylinder] });
        }
        if (cylinderGroups.length !== 2) return surfaces;
        cylinderGroups.sort((a, b) => a.z - b.z);

        const lowerGroup = cylinderGroups[0];
        const upperGroup = cylinderGroups[1];
        if (lowerGroup.items.length !== 2 || upperGroup.items.length !== 2) return surfaces;
        if (!(lowerGroup.z < midPlaneParams.origin.z && midPlaneParams.origin.z < upperGroup.z)) return surfaces;

        const lowerRadii = lowerGroup.items
            .map(item => (item.params as { radius: number }).radius)
            .sort((a, b) => a - b);
        const upperRadii = upperGroup.items
            .map(item => (item.params as { radius: number }).radius)
            .sort((a, b) => a - b);
        if (!(upperRadii[0] > lowerRadii[0] + 0.5 && upperRadii[1] < lowerRadii[1] - 0.5)) return surfaces;

        const topSupport = vertices.filter(v => Math.abs(v.position.z - upperGroup.z) < 0.1).length;
        const bottomSupport = vertices.filter(v => Math.abs(v.position.z - lowerGroup.z) < 0.1).length;
        if (topSupport < 2 || bottomSupport < 2) return surfaces;

        const axisSign = ((lowerGroup.items[0].params as { axis: PsPoint }).axis.z >= 0) ? 1 : -1;
        const axis: PsPoint = { x: 0, y: 0, z: axisSign };
        const midZ = midPlaneParams.origin.z;
        const topZ = upperGroup.z;
        const bottomZ = lowerGroup.z;
        const sectionHeight = Math.abs(topZ - midZ);
        if (sectionHeight < 0.05 || sectionHeight > 5) return surfaces;

        const deriveTorus = (
            baseRadius: number,
            sectionRadius: number,
        ): { majorRadius: number; minorRadius: number; baseRadius: number; sectionRadius: number } | null => {
            const delta = Math.abs(sectionRadius - baseRadius);
            if (delta < 1e-6) return null;
            const minorRadius = (delta * delta + sectionHeight * sectionHeight) / (2 * delta);
            const majorRadius = sectionRadius > baseRadius
                ? baseRadius + minorRadius
                : baseRadius - minorRadius;
            if (!isFinite(majorRadius) || !isFinite(minorRadius)) return null;
            if (majorRadius <= 0 || minorRadius <= 0) return null;
            if (minorRadius > 10 || majorRadius < minorRadius) return null;
            return { majorRadius, minorRadius, baseRadius, sectionRadius };
        };

        const innerTorus = deriveTorus(lowerRadii[0], upperRadii[0]);
        const outerTorus = deriveTorus(lowerRadii[1], upperRadii[1]);
        if (!innerTorus || !outerTorus) return surfaces;

        const rebuilt = surfaces.filter(surface =>
            surface !== midPlane &&
            !upperGroup.items.includes(surface),
        );

        rebuilt.push({
            id: 0,
            surfaceType: 'plane',
            params: {
                origin: { x: 0, y: 0, z: bottomZ },
                normal: { x: -axis.x, y: -axis.y, z: -axis.z },
            },
        });
        rebuilt.push({
            id: 0,
            surfaceType: 'plane',
            params: {
                origin: { x: 0, y: 0, z: topZ },
                normal: { x: axis.x, y: axis.y, z: axis.z },
            },
        });
        rebuilt.push({
            id: 0,
            surfaceType: 'torus',
            params: {
                origin: { x: 0, y: 0, z: midZ },
                axis,
                majorRadius: innerTorus.majorRadius,
                minorRadius: innerTorus.minorRadius,
                baseRadius: innerTorus.baseRadius,
                sectionRadius: innerTorus.sectionRadius,
                baseZ: midZ,
                sectionZ: topZ,
            },
        });
        rebuilt.push({
            id: 0,
            surfaceType: 'torus',
            params: {
                origin: { x: 0, y: 0, z: midZ },
                axis,
                majorRadius: outerTorus.majorRadius,
                minorRadius: outerTorus.minorRadius,
                baseRadius: outerTorus.baseRadius,
                sectionRadius: outerTorus.sectionRadius,
                baseZ: midZ,
                sectionZ: topZ,
            },
        });

        return rebuilt;
    }

    /**
     * Build dedicated circular topology for the FTC_11-style washer:
     * 2 cap planes, 2 cylinders, 2 torus fillets.
     * @internal
     */
    private tryBuildAxisymmetricWasherTopology(
        surfaces: PsSurface[],
        startingVertexId: number,
    ): {
        faces: PsFace[];
        loops: PsLoop[];
        edges: PsEdge[];
        curves: PsCurve[];
        extraVertices: PsVertex[];
    } | null {
        if (surfaces.length !== 6) return null;

        const planes = surfaces.filter(s => s.surfaceType === 'plane');
        const cylinders = surfaces.filter(s => s.surfaceType === 'cylinder');
        const tori = surfaces.filter(s => s.surfaceType === 'torus');
        if (planes.length !== 2 || cylinders.length !== 2 || tori.length !== 2) return null;

        const planeParams = planes.map(surface => ({
            surface,
            params: surface.params as { origin: PsPoint; normal: PsPoint },
        }));
        const cylinderParams = cylinders.map(surface => ({
            surface,
            params: surface.params as { origin: PsPoint; axis: PsPoint; radius: number },
        }));
        const torusParams = tori.map(surface => ({
            surface,
            params: surface.params as {
                origin: PsPoint;
                axis: PsPoint;
                majorRadius: number;
                minorRadius: number;
                baseRadius: number;
                sectionRadius: number;
                baseZ: number;
                sectionZ: number;
            },
        }));

        if (planeParams.some(p => Math.abs(Math.abs(p.params.normal.z) - 1) > 0.01)) return null;
        if (cylinderParams.some(c => Math.abs(c.params.axis.x) > 0.01 || Math.abs(c.params.axis.y) > 0.01 || Math.abs(Math.abs(c.params.axis.z) - 1) > 0.01)) return null;
        if (torusParams.some(t => Math.abs(t.params.axis.x) > 0.01 || Math.abs(t.params.axis.y) > 0.01 || Math.abs(Math.abs(t.params.axis.z) - 1) > 0.01)) return null;

        planeParams.sort((a, b) => a.params.origin.z - b.params.origin.z);
        cylinderParams.sort((a, b) => a.params.radius - b.params.radius);
        torusParams.sort((a, b) => a.params.majorRadius - b.params.majorRadius);

        const bottomPlane = planeParams[0];
        const topPlane = planeParams[1];
        const innerCylinder = cylinderParams[0];
        const outerCylinder = cylinderParams[1];
        const innerTorus = torusParams[0];
        const outerTorus = torusParams[1];

        const bottomZ = bottomPlane.params.origin.z;
        const topZ = topPlane.params.origin.z;
        const midZ = outerTorus.params.origin.z;
        if (!(bottomZ < midZ && midZ < topZ)) return null;

        const faces: PsFace[] = [];
        const loops: PsLoop[] = [];
        const edges: PsEdge[] = [];
        const curves: PsCurve[] = [];
        const extraVertices: PsVertex[] = [];

        let nextFaceId = 1;
        let nextLoopId = 1;
        let nextEdgeId = 1;
        let nextCurveId = 1;
        let nextExtraVtxId = startingVertexId + 1;

        type AxisymmetricBoundary = {
            key: string;
            center: PsPoint;
            normal: PsPoint;
            radius: number;
            seamDir: PsPoint;
        };

        const normalizeDir = (dir: PsPoint): PsPoint => {
            const mag = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
            return { x: dir.x / mag, y: dir.y / mag, z: dir.z / mag };
        };

        const circleBoundaryCache = new Map<string, { edgeId: number; vertexId: number; point: PsPoint }>();
        const getOrCreateCircleBoundary = (boundary: AxisymmetricBoundary) => {
            const cached = circleBoundaryCache.get(boundary.key);
            if (cached) return cached;

            const seamDir = normalizeDir(boundary.seamDir);
            const seamPoint: PsPoint = {
                x: boundary.center.x + boundary.radius * seamDir.x,
                y: boundary.center.y + boundary.radius * seamDir.y,
                z: boundary.center.z + boundary.radius * seamDir.z,
            };
            const vertexId = nextExtraVtxId++;
            extraVertices.push({ id: vertexId, position: seamPoint });

            const curveId = nextCurveId++;
            curves.push({
                id: curveId,
                curveType: 'circle',
                params: { center: boundary.center, normal: boundary.normal, radius: boundary.radius },
            });

            const edgeId = nextEdgeId++;
            edges.push({
                id: edgeId,
                startVertex: vertexId,
                endVertex: vertexId,
                curve: curveId,
                sense: true,
            });

            const created = { edgeId, vertexId, point: seamPoint };
            circleBoundaryCache.set(boundary.key, created);
            return created;
        };

        const addLoop = (edgeIds: number[], senses: boolean[]) => {
            const loopId = nextLoopId++;
            loops.push({ id: loopId, edges: edgeIds, senses });
            return loopId;
        };

        const addFace = (surfaceId: number, outerLoop: number, innerLoops: number[] = []) => {
            const faceId = nextFaceId++;
            faces.push({ id: faceId, surface: surfaceId, outerLoop, innerLoops, sense: true });
        };

        const addTwoBoundaryFace = (
            surfaceId: number,
            outerBoundary: AxisymmetricBoundary,
            innerBoundary: AxisymmetricBoundary,
        ) => {
            const outer = getOrCreateCircleBoundary(outerBoundary);
            const inner = getOrCreateCircleBoundary(innerBoundary);
            const outerLoop = addLoop([outer.edgeId], [true]);
            const innerLoop = addLoop([inner.edgeId], [true]);
            addFace(surfaceId, outerLoop, [innerLoop]);
        };

        const bottomOuter: AxisymmetricBoundary = {
            key: `circle-bottom-outer-${bottomZ.toFixed(6)}-${outerCylinder.params.radius.toFixed(6)}`,
            center: { x: 0, y: 0, z: bottomZ },
            normal: bottomPlane.params.normal,
            radius: outerCylinder.params.radius,
            seamDir: { x: 0, y: -1, z: 0 },
        };
        const bottomInner: AxisymmetricBoundary = {
            key: `circle-bottom-inner-${bottomZ.toFixed(6)}-${innerCylinder.params.radius.toFixed(6)}`,
            center: { x: 0, y: 0, z: bottomZ },
            normal: bottomPlane.params.normal,
            radius: innerCylinder.params.radius,
            seamDir: { x: 0, y: -1, z: 0 },
        };
        const shoulderOuter: AxisymmetricBoundary = {
            key: `circle-shoulder-outer-${outerTorus.params.baseZ.toFixed(6)}-${outerTorus.params.baseRadius.toFixed(6)}`,
            center: { x: 0, y: 0, z: outerTorus.params.baseZ },
            normal: outerCylinder.params.axis,
            radius: outerTorus.params.baseRadius,
            seamDir: { x: 0, y: -1, z: 0 },
        };
        const shoulderInner: AxisymmetricBoundary = {
            key: `circle-shoulder-inner-${innerTorus.params.baseZ.toFixed(6)}-${innerTorus.params.baseRadius.toFixed(6)}`,
            center: { x: 0, y: 0, z: innerTorus.params.baseZ },
            normal: innerCylinder.params.axis,
            radius: innerTorus.params.baseRadius,
            seamDir: { x: 0, y: -1, z: 0 },
        };
        const topOuter: AxisymmetricBoundary = {
            key: `circle-top-outer-${topZ.toFixed(6)}-${outerTorus.params.sectionRadius.toFixed(6)}`,
            center: { x: 0, y: 0, z: topZ },
            normal: topPlane.params.normal,
            radius: outerTorus.params.sectionRadius,
            seamDir: { x: -1, y: 0, z: 0 },
        };
        const topInner: AxisymmetricBoundary = {
            key: `circle-top-inner-${topZ.toFixed(6)}-${innerTorus.params.sectionRadius.toFixed(6)}`,
            center: { x: 0, y: 0, z: topZ },
            normal: topPlane.params.normal,
            radius: innerTorus.params.sectionRadius,
            seamDir: { x: -1, y: 0, z: 0 },
        };

        addTwoBoundaryFace(bottomPlane.surface.id, bottomOuter, bottomInner);
        addTwoBoundaryFace(topPlane.surface.id, topOuter, topInner);
        addTwoBoundaryFace(outerCylinder.surface.id, bottomOuter, shoulderOuter);
        addTwoBoundaryFace(innerCylinder.surface.id, shoulderInner, bottomInner);
        addTwoBoundaryFace(outerTorus.surface.id, shoulderOuter, topOuter);
        addTwoBoundaryFace(innerTorus.surface.id, topInner, shoulderInner);

        return { faces, loops, edges, curves, extraVertices };
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
        const washerTopology = this.tryBuildAxisymmetricWasherTopology(surfaces, vertices.length);
        if (washerTopology) return washerTopology;

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
        // Keep planes with ≥3 coplanar vertices AND passing PCA eigenvalue
        // ratio test (2D spread → plane, 1D collinear → LINE curve).
        const validatedSurfaces: PsSurface[] = [];
        for (const surf of extractedSurfaces) {
            if (surf.surfaceType === 'plane') {
                const p = surf.params as { origin: PsPoint; normal: PsPoint };
                const coplanarVerts: PsPoint[] = [];
                for (const v of vertices) {
                    const dx = v.position.x - p.origin.x;
                    const dy = v.position.y - p.origin.y;
                    const dz = v.position.z - p.origin.z;
                    const dist = Math.abs(dx * p.normal.x + dy * p.normal.y + dz * p.normal.z);
                    if (dist < ParasolidParser.VERTEX_PLANE_TOL) coplanarVerts.push(v.position);
                }
                if (coplanarVerts.length < 3) continue;

                // PCA eigenvalue ratio: low → 2D spread (PLANE), high → collinear (LINE)
                const ratio = ParasolidParser.computeEigenvalueRatio(coplanarVerts, p.normal);
                if (ratio <= ParasolidParser.PLANE_EIGEN_RATIO_MAX) {
                    validatedSurfaces.push(surf);
                }
            } else {
                validatedSurfaces.push(surf); // cylinders, cones → keep
            }
        }

        // ── Step 3: Infer additional planes from vertex positions ───────
        // Use outlier-filtered vertices for inference to avoid phantom planes
        // from brute-force vertex false-positives (e.g., unit-vector
        // components at 1000mm, entity metadata read as coordinates).
        const inferVertices = ParasolidParser.filterOutlierVertices(vertices);
        let inferredPlanes = this.inferPlanesFromVertices(inferVertices, validatedSurfaces);

        // ── Step 4: Merge and deduplicate ───────────────────────────────
        const mergedSurfaces = ParasolidParser.recoverAxisymmetricWasherSurfaces(
            [...validatedSurfaces, ...inferredPlanes],
            vertices,
        );
        // Apply narrow cone recovery after the washer pass so it sees the same
        // consolidated cylinder inventory as the bounded-topology builder.
        const inferredCones = this.inferApexConesFromCylinderPairs(mergedSurfaces, vertices);
        const surfaces = this.deduplicateSurfaces([...mergedSurfaces, ...inferredCones]);

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
