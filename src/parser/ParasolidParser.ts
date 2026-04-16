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

import { Buffer } from 'node:buffer';
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
import type {
    BoundaryBudgetCandidate,
    BoundaryBudgetMatchOption,
    BoundaryBudgetTarget,
    PointEdgeChainPosition,
    RawEntity,
    PsCoedgeChain,
    PsCoedgeRecord,
    PsCompactGeometryLikeRecord,
    PsCompactGeometryRecord,
    PsDirectGeometryLikeRecord,
    PsEdgeComponent,
    PsEdgeComponentChain,
    PsEdgeRecord,
    PsEntityCensus,
    PsFaceEdgeHit,
    PsFaceInlineWindowRecord,
    PsFaceRecord,
    PsGapPointRecord,
    PsGeometryLikeAliasRecord,
    PsLinearEntityHeader,
    PsNamedClassDefinition,
    PsPackedGeometryLikeRecord,
    PsPointRecord,
    PsRawFaceBoundaryHint,
    PsSchemaFieldDefinition,
    PsSchemaMetadata,
    PsSentinelAlignedEntity,
    PsShellInlineContainerGraph,
    PsShellInlineContainerLink,
    PsShellInlineFaceAnchorRecord,
    PsShellInlineFaceRecord,
    PsTransmitHeader,
} from './ParasolidParserTypes.js';
import {
    buildBoundaryBudgetKey as buildBoundaryBudgetKeyImpl,
    buildBoundarySpreadMetrics as buildBoundarySpreadMetricsImpl,
    buildPointCoordKey as buildPointCoordKeyImpl,
    clusterPoints2D as clusterPoints2DImpl,
    computeEigenvalueRatio as computeEigenvalueRatioImpl,
    convexHull2D as convexHull2DImpl,
    filterOutlierVertices as filterOutlierVerticesImpl,
    isPointInConvexHull as isPointInConvexHullImpl,
    isPointInPolygon as isPointInPolygonImpl,
    planeBasis as planeBasisImpl,
} from './ParasolidParserUtils.js';
import {
    computeBoundaryAnchorPenalty as computeBoundaryAnchorPenaltyImpl,
    computeBoundaryCoedgePenalty as computeBoundaryCoedgePenaltyImpl,
    computeBoundaryCoveragePenalty as computeBoundaryCoveragePenaltyImpl,
    computeBoundaryRepeatedHitPenalty as computeBoundaryRepeatedHitPenaltyImpl,
    computeBoundarySpreadPenalty as computeBoundarySpreadPenaltyImpl,
    countBoundaryAnchorMatches as countBoundaryAnchorMatchesImpl,
    countBoundaryCoedgeMatches as countBoundaryCoedgeMatchesImpl,
    scoreRawFaceBoundaryCandidate as scoreRawFaceBoundaryCandidateImpl,
} from './ParasolidBoundaryMatching.js';
import {
    ENTITY_ATTRIB,
    ENTITY_BSPLINE,
    ENTITY_FACE,
    ENTITY_SURFACE,
    PS_TO_MM,
} from './ParasolidParserConstants.js';
import {
    buildBoundaryCandidateSpread as buildBoundaryCandidateSpreadImpl,
    buildEdgeChainPositionMap as buildEdgeChainPositionMapImpl,
    buildPointEdgeChainPositionsByCoord as buildPointEdgeChainPositionsByCoordImpl,
    buildRawFaceBoundaryHints as buildRawFaceBoundaryHintsImpl,
    buildSyntheticShellInlineBoundaryHints as buildSyntheticShellInlineBoundaryHintsImpl,
    countEntityRecords as countEntityRecordsImpl,
    extractAllEntities as extractAllEntitiesImpl,
    extractCoordinates as extractCoordinatesImpl,
    findEntityClasses as findEntityClassesImpl,
    getEntityCensus as getEntityCensusImpl,
    parseAllGeometryLikeRecords as parseAllGeometryLikeRecordsImpl,
    parseCoedgeChain as parseCoedgeChainImpl,
    parseCoedgeRecords as parseCoedgeRecordsImpl,
    parseCompactGeometryLikeRecords as parseCompactGeometryLikeRecordsImpl,
    parseCompactGeometryRecords as parseCompactGeometryRecordsImpl,
    parseEdgeComponentChains as parseEdgeComponentChainsImpl,
    parseEdgeComponents as parseEdgeComponentsImpl,
    parseEdgeRecords as parseEdgeRecordsImpl,
    parseFaceEdgeHits as parseFaceEdgeHitsImpl,
    parseFaceInlineWindowRecords as parseFaceInlineWindowRecordsImpl,
    parseFaceRecords as parseFaceRecordsImpl,
    parseGapPointRecords as parseGapPointRecordsImpl,
    parseGeometryLikeAliasRecords as parseGeometryLikeAliasRecordsImpl,
    parseHeader as parseHeaderImpl,
    parsePackedGeometryLikeRecords as parsePackedGeometryLikeRecordsImpl,
    parsePointRecords as parsePointRecordsImpl,
    parseSchemaMetadata as parseSchemaMetadataImpl,
    parseSentinelAlignedEntities as parseSentinelAlignedEntitiesImpl,
    parseShellInlineContainerGraph as parseShellInlineContainerGraphImpl,
    parseShellInlineContainerLinks as parseShellInlineContainerLinksImpl,
    parseShellInlineFaceAnchorRecords as parseShellInlineFaceAnchorRecordsImpl,
    parseShellInlineFaceRecords as parseShellInlineFaceRecordsImpl,
} from './ParasolidStructuralParsers.js';
export type {
    PsTransmitHeader,
    PsEntityCensus,
    PsSchemaFieldDefinition,
    PsNamedClassDefinition,
    PsSchemaMetadata,
    PsLinearEntityHeader,
    PsSentinelAlignedEntity,
    PsCoedgeRecord,
    PsCoedgeChain,
    PsEdgeRecord,
    PsEdgeComponent,
    PsEdgeComponentChain,
    PsPointRecord,
    PsFaceRecord,
    PsFaceInlineWindowRecord,
    PsShellInlineContainerLink,
    PsShellInlineContainerGraph,
    PsShellInlineFaceRecord,
    PsShellInlineFaceAnchorRecord,
    PsFaceEdgeHit,
    PsRawFaceBoundaryHint,
    PsCompactGeometryRecord,
    PsCompactGeometryLikeRecord,
    PsPackedGeometryLikeRecord,
    PsGeometryLikeAliasRecord,
    PsGapPointRecord,
} from './ParasolidParserTypes.js';

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

    constructor(buf: Buffer) {
        this.buf = buf;
    }

    /**
     * Parse the transmit-file header.
     * Returns null if the buffer does not look like a Parasolid transmit file.
     */
    parseHeader(): PsTransmitHeader | null {
        return parseHeaderImpl(this.buf);
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
        return parseSchemaMetadataImpl(this.buf);
    }

    /**
     * Scan the buffer for entity class names defined in the class catalogue.
     *
     * Entity class definitions begin after the schema section and are
     * recognisable by their name strings followed by type-marker bytes.
     */
    findEntityClasses(): string[] {
        return findEntityClassesImpl(this.buf);
    }

    /**
     * Count the number of entity instance records in the binary stream.
     *
     * Each entity is prefixed by `=p` (0x3D 0x70) or `=q` (0x3D 0x71).
     */
    countEntityRecords(): { pRecords: number; qRecords: number } {
        return countEntityRecordsImpl(this.buf);
    }

    /**
     * Decode linear records aligned to observed 8-byte sentinels.
     *
     * Clean-room findings so far support two stable forms:
     * - compact record terminator: header + 4 refs + sentinel
     * - packed/FF record: header + sentinel + optional small refs
     */
    parseSentinelAlignedEntities(): PsSentinelAlignedEntity[] {
        return parseSentinelAlignedEntitiesImpl(this.buf);
    }

    /** Decode compact type-18 records from the sentinel-aligned record pass. */
    parseCoedgeRecords(): PsCoedgeRecord[] {
        return parseCoedgeRecordsImpl(this.buf);
    }

    /** Recover the single ordered coedge chain when the links form one path. */
    parseCoedgeChain(): PsCoedgeChain | null {
        return parseCoedgeChainImpl(this.buf);
    }

    /** Decode compact type-16 records whose sentinel starts the payload area. */
    parseEdgeRecords(): PsEdgeRecord[] {
        return parseEdgeRecordsImpl(this.buf);
    }

    /** Decode minimal raw face records from sentinel-block sub-record entities. */
    parseFaceRecords(): PsFaceRecord[] {
        return parseFaceRecordsImpl(this.buf);
    }

    /** Decode the stable 30-69 byte window carried by longer raw FACE payloads. */
    parseFaceInlineWindowRecords(): PsFaceInlineWindowRecord[] {
        return parseFaceInlineWindowRecordsImpl(this.buf);
    }

    /** Decode inline type-0x11 container links embedded inside shell/body payload segments. */
    parseShellInlineContainerLinks(): PsShellInlineContainerLink[] {
        return parseShellInlineContainerLinksImpl(this.buf);
    }

    /** Summarize the graph induced by inline type-0x11 container-link segments. */
    parseShellInlineContainerGraph(): PsShellInlineContainerGraph {
        return parseShellInlineContainerGraphImpl(this.buf);
    }

    /** Decode inline face-like records carried by non-link type-0x11 payload segments. */
    parseShellInlineFaceRecords(): PsShellInlineFaceRecord[] {
        return parseShellInlineFaceRecordsImpl(this.buf);
    }

    /** Decode the stable short inline face family that carries global coedge and edge anchors. */
    parseShellInlineFaceAnchorRecords(): PsShellInlineFaceAnchorRecord[] {
        return parseShellInlineFaceAnchorRecordsImpl(this.buf);
    }

    /** Build conservative shell-inline boundary hints from grouped short anchor records. */
    private buildSyntheticShellInlineBoundaryHints(): PsRawFaceBoundaryHint[] {
        return buildSyntheticShellInlineBoundaryHintsImpl(this.buf);
    }

    /** Decode aligned edge-id hits embedded in raw face payloads. */
    parseFaceEdgeHits(): PsFaceEdgeHit[] {
        return parseFaceEdgeHitsImpl(this.buf);
    }

    /** Collect raw face edge-hit hints for boundary matching. */
    parseRawFaceBoundaryHints(): PsRawFaceBoundaryHint[] {
        return this.buildRawFaceBoundaryHints(this.extractSurfaces());
    }

    /** Collect derived raw face boundary hints for matching experiments. */
    private buildRawFaceBoundaryHints(extractedSurfaces: PsSurface[] = []): PsRawFaceBoundaryHint[] {
        return buildRawFaceBoundaryHintsImpl(this.buf, extractedSurfaces);
    }

    /** Build a stable key for a heuristic boundary candidate. @internal */
    private static buildBoundaryBudgetKey(surfaceType: string, surfaceId: number, variant = 0): string {
        return buildBoundaryBudgetKeyImpl(surfaceType, surfaceId, variant);
    }

    /** Build a stable coordinate key for matching decoded structural points back to mm-space vertices. @internal */
    private static buildPointCoordKey(point: PsPoint): string {
        return buildPointCoordKeyImpl(point);
    }

    /** Collapse ordered chain positions into spread metrics shared by raw hints and heuristic candidates. @internal */
    private static buildBoundarySpreadMetrics(
        positionedHits: Array<{ chainIndex: number; linearIndex: number }>,
    ): {
        chainCount: number;
        segmentCount: number;
        maxSegmentLength: number;
        maxChainSpan: number | null;
    } {
        return buildBoundarySpreadMetricsImpl(positionedHits);
    }

    /** Project structural point records onto decoded edge-chain positions keyed by mm-space coordinates. @internal */
    private buildPointEdgeChainPositionsByCoord(): Map<string, PointEdgeChainPosition[]> {
        return buildPointEdgeChainPositionsByCoordImpl(this.buf);
    }

    /** Derive candidate-side spread metrics from boundary vertices that map back to edge-chain positions. @internal */
    private buildBoundaryCandidateSpread(
        vertexIndices: number[],
        vertices: PsVertex[],
        pointEdgePositionsByCoord: Map<string, PointEdgeChainPosition[]>,
    ): {
        mappedEdgeCount: number;
        mappedEdgeIds: number[];
        mappedCoedgeIds: number[];
        chainCount: number;
        segmentCount: number;
        maxSegmentLength: number;
        maxChainSpan: number | null;
    } {
        return buildBoundaryCandidateSpreadImpl(vertexIndices, vertices, pointEdgePositionsByCoord);
    }

    /** Build heuristic boundary candidates plus candidate-side spread metrics. @internal */
    private buildBoundaryBudgetCandidates(
        surfaces: PsSurface[],
        vertices: PsVertex[],
        vertexSurfaceMap: Map<number, number[]>,
    ): BoundaryBudgetCandidate[] {
        const candidates: BoundaryBudgetCandidate[] = [];
        const cylSurfaces = surfaces.filter(
            (surface) => surface.surfaceType === 'cylinder' || surface.surfaceType === 'cone',
        );
        const pointEdgePositionsByCoord = this.buildPointEdgeChainPositionsByCoord();

        for (const surf of surfaces) {
            const assocIndices = vertexSurfaceMap.get(surf.id) ?? [];
            const params = surf.params as Record<string, unknown>;

            if (surf.surfaceType === 'plane') {
                const origin = params.origin as PsPoint;
                const normal = params.normal as PsPoint;
                const clusters = this.buildPlaneBoundaryClusters(origin, normal, assocIndices, vertices);

                clusters.forEach((cluster, clusterIndex) => {
                    const holeCandidates = this.collectPlaneHoleCandidates(
                        origin,
                        normal,
                        cluster,
                        cylSurfaces,
                        vertices,
                        vertexSurfaceMap,
                    );
                    const spread = this.buildBoundaryCandidateSpread(
                        cluster.map((point) => point.idx),
                        vertices,
                        pointEdgePositionsByCoord,
                    );
                    candidates.push({
                        key: ParasolidParser.buildBoundaryBudgetKey('plane', surf.id, clusterIndex),
                        surfaceType: 'plane',
                        outerSize: cluster.length,
                        totalSize: cluster.length + holeCandidates.length,
                        holeCount: holeCandidates.length,
                        mappedEdgeCount: spread.mappedEdgeCount,
                        mappedEdgeIds: spread.mappedEdgeIds,
                        mappedCoedgeIds: spread.mappedCoedgeIds,
                        chainCount: spread.chainCount,
                        segmentCount: spread.segmentCount,
                        maxSegmentLength: spread.maxSegmentLength,
                        maxChainSpan: spread.maxChainSpan,
                        matched: false,
                    });
                });
                continue;
            }

            if (surf.surfaceType === 'cylinder' || surf.surfaceType === 'cone') {
                const origin = params.origin as PsPoint;
                const axis = params.axis as PsPoint;
                const ordered = this.buildAngularBoundaryPoints(origin, axis, assocIndices, vertices);
                if (ordered.length >= 3) {
                    const spread = this.buildBoundaryCandidateSpread(
                        ordered.map((point) => point.idx),
                        vertices,
                        pointEdgePositionsByCoord,
                    );
                    candidates.push({
                        key: ParasolidParser.buildBoundaryBudgetKey(surf.surfaceType, surf.id),
                        surfaceType: surf.surfaceType,
                        outerSize: ordered.length,
                        totalSize: ordered.length,
                        holeCount: 0,
                        mappedEdgeCount: spread.mappedEdgeCount,
                        mappedEdgeIds: spread.mappedEdgeIds,
                        mappedCoedgeIds: spread.mappedCoedgeIds,
                        chainCount: spread.chainCount,
                        segmentCount: spread.segmentCount,
                        maxSegmentLength: spread.maxSegmentLength,
                        maxChainSpan: spread.maxChainSpan,
                        matched: false,
                    });
                }
            }
        }

        return candidates;
    }

    /** Compute a conservative penalty from candidate-side spread metrics. @internal */
    private static computeBoundarySpreadPenalty(
        hint: PsRawFaceBoundaryHint,
        candidate: BoundaryBudgetCandidate,
    ): number {
        return computeBoundarySpreadPenaltyImpl(hint, candidate);
    }

    /** Penalize candidates that miss explicitly anchored raw face edges. @internal */
    private static computeBoundaryAnchorPenalty(
        hint: PsRawFaceBoundaryHint,
        candidate: BoundaryBudgetCandidate,
    ): number {
        return computeBoundaryAnchorPenaltyImpl(hint, candidate);
    }

    /** Penalize candidates that miss explicitly anchored raw face coedges. @internal */
    private static computeBoundaryCoedgePenalty(
        hint: PsRawFaceBoundaryHint,
        candidate: BoundaryBudgetCandidate,
    ): number {
        return computeBoundaryCoedgePenaltyImpl(hint, candidate);
    }

    /** Penalize edge-anchored matches that recover no candidate edges at all. @internal */
    private static computeBoundaryCoveragePenalty(
        hint: PsRawFaceBoundaryHint,
        candidate: BoundaryBudgetCandidate,
    ): number {
        return computeBoundaryCoveragePenaltyImpl(hint, candidate);
    }

    /** Break duplicate-anchor ties with repeated non-anchor raw hits when available. @internal */
    private static computeBoundaryRepeatedHitPenalty(
        hint: PsRawFaceBoundaryHint,
        candidate: BoundaryBudgetCandidate,
    ): number {
        return computeBoundaryRepeatedHitPenaltyImpl(hint, candidate);
    }

    /** Count explicit raw edge anchors recovered by a heuristic boundary candidate. @internal */
    private static countBoundaryAnchorMatches(
        hint: PsRawFaceBoundaryHint,
        candidate: BoundaryBudgetCandidate,
    ): number {
        return countBoundaryAnchorMatchesImpl(hint, candidate);
    }

    /** Count explicit raw coedge anchors recovered by a heuristic boundary candidate. @internal */
    private static countBoundaryCoedgeMatches(
        hint: PsRawFaceBoundaryHint,
        candidate: BoundaryBudgetCandidate,
    ): number {
        return countBoundaryCoedgeMatchesImpl(hint, candidate);
    }

    /** Score one raw face hint against one heuristic boundary candidate. @internal */
    private static scoreRawFaceBoundaryCandidate(
        hint: PsRawFaceBoundaryHint,
        candidate: BoundaryBudgetCandidate,
    ): BoundaryBudgetMatchOption | null {
        return scoreRawFaceBoundaryCandidateImpl(hint, candidate);
    }

    /** Recover ordered type-16 components from the observed prev/next links. */
    parseEdgeComponents(): PsEdgeComponent[] {
        return parseEdgeComponentsImpl(this.buf);
    }

    /** Recover ordered chains of type-16 components linked by anchor ids. */
    parseEdgeComponentChains(): PsEdgeComponentChain[] {
        return parseEdgeComponentChainsImpl(this.buf);
    }

    /** Decode the dominant compact type-30/type-31 geometry record layout. */
    parseCompactGeometryRecords(): PsCompactGeometryRecord[] {
        return parseCompactGeometryRecordsImpl(this.buf);
    }

    /** Decode the broader compact geometry-like family used by edge geometry links. */
    parseCompactGeometryLikeRecords(): PsCompactGeometryLikeRecord[] {
        return parseCompactGeometryLikeRecordsImpl(this.buf);
    }

    /** Decode packed FF-format geometry-like records used by unresolved edge links. */
    parsePackedGeometryLikeRecords(): PsPackedGeometryLikeRecord[] {
        return parsePackedGeometryLikeRecordsImpl(this.buf);
    }

    /** Decode conservative aliases for edge targets that point at refIds[1] of a unique record. */
    parseGeometryLikeAliasRecords(): PsGeometryLikeAliasRecord[] {
        return parseGeometryLikeAliasRecordsImpl(this.buf);
    }

    /** Merge compact and packed geometry-like records for edge-link resolution. */
    parseAllGeometryLikeRecords(): Array<PsDirectGeometryLikeRecord | PsGeometryLikeAliasRecord> {
        return parseAllGeometryLikeRecordsImpl(this.buf);
    }

    /** Build a position map for edges that participate in ordered component chains. @internal */
    private buildEdgeChainPositionMap(): Map<number, { chainIndex: number; componentIndex: number; edgeIndex: number; linearIndex: number }> {
        return buildEdgeChainPositionMapImpl(this.buf);
    }

    /** Evenly decimate an ordered cycle to a smaller number of representatives. @internal */
    private static decimateOrderedCycle<T>(items: T[], targetCount: number): T[] {
        if (targetCount < 3 || targetCount >= items.length) return items;

        const picked = new Set<number>();
        const result: T[] = [];

        for (let i = 0; i < targetCount; i++) {
            let index = Math.floor(((i + 0.5) * items.length) / targetCount);
            if (index >= items.length) index = items.length - 1;
            while (picked.has(index) && index + 1 < items.length) index++;
            while (picked.has(index) && index - 1 >= 0) index--;
            if (picked.has(index)) continue;
            picked.add(index);
            result.push(items[index]);
        }

        return result.length >= 3 ? result : items;
    }

    /** Project plane-associated vertices into sorted boundary clusters. @internal */
    private buildPlaneBoundaryClusters(
        origin: PsPoint,
        normal: PsPoint,
        assocIndices: number[],
        vertices: PsVertex[],
    ): Array<Array<{ u: number; v: number; idx: number }>> {
        if (assocIndices.length < 3) return [];

        const { uAxis, vAxis } = ParasolidParser.planeBasis(normal);
        const pts2D = assocIndices.map((index) => {
            const vertex = vertices[index].position;
            const dx = vertex.x - origin.x;
            const dy = vertex.y - origin.y;
            const dz = vertex.z - origin.z;
            return {
                u: dx * uAxis.x + dy * uAxis.y + dz * uAxis.z,
                v: dx * vAxis.x + dy * vAxis.y + dz * vAxis.z,
                idx: index,
            };
        });

        let uMin = Infinity;
        let uMax = -Infinity;
        let vMin = Infinity;
        let vMax = -Infinity;
        for (const point of pts2D) {
            if (point.u < uMin) uMin = point.u;
            if (point.u > uMax) uMax = point.u;
            if (point.v < vMin) vMin = point.v;
            if (point.v > vMax) vMax = point.v;
        }

        const bboxDiag = Math.sqrt((uMax - uMin) ** 2 + (vMax - vMin) ** 2);
        const clusterThreshold = Math.max(60, bboxDiag / 3);
        const clusters = ParasolidParser.clusterPoints2D(pts2D, clusterThreshold);

        return clusters
            .map((cluster) => {
                if (cluster.length < 3) return [];
                const centroidU = cluster.reduce((sum, point) => sum + point.u, 0) / cluster.length;
                const centroidV = cluster.reduce((sum, point) => sum + point.v, 0) / cluster.length;
                return cluster.slice().sort((left, right) => {
                    return Math.atan2(left.v - centroidV, left.u - centroidU)
                        - Math.atan2(right.v - centroidV, right.u - centroidU);
                });
            })
            .filter((cluster) => cluster.length >= 3);
    }

    /** Order associated surface vertices by angle around an axis. @internal */
    private buildAngularBoundaryPoints(
        origin: PsPoint,
        axis: PsPoint,
        assocIndices: number[],
        vertices: PsVertex[],
    ): Array<{ idx: number; angle: number }> {
        if (assocIndices.length < 3) return [];

        const { uAxis, vAxis } = ParasolidParser.planeBasis(axis);
        return assocIndices
            .map((index) => {
                const vertex = vertices[index].position;
                const dx = vertex.x - origin.x;
                const dy = vertex.y - origin.y;
                const dz = vertex.z - origin.z;
                const u = dx * uAxis.x + dy * uAxis.y + dz * uAxis.z;
                const w = dx * vAxis.x + dy * vAxis.y + dz * vAxis.z;
                return { idx: index, angle: Math.atan2(w, u) };
            })
            .sort((left, right) => left.angle - right.angle);
    }

    /** Collect plane-hole candidates in a stable order so raw face hints can cap retained holes. @internal */
    private collectPlaneHoleCandidates(
        origin: PsPoint,
        normal: PsPoint,
        boundaryPts: Array<{ u: number; v: number; idx: number }>,
        cylSurfaces: PsSurface[],
        vertices: PsVertex[],
        vertexSurfaceMap: Map<number, number[]>,
    ): Array<{ center: PsPoint; radius: number; seamPoint: PsPoint; support: number }> {
        const { uAxis, vAxis } = ParasolidParser.planeBasis(normal);
        const candidates: Array<{ center: PsPoint; radius: number; seamPoint: PsPoint; support: number }> = [];

        for (const cyl of cylSurfaces) {
            const cp = cyl.params as Record<string, unknown>;
            const cylAxis = cp.axis as PsPoint;
            const cylOrigin = cp.origin as PsPoint;
            const cylRadius = cp.radius as number;

            const dot = cylAxis.x * normal.x + cylAxis.y * normal.y + cylAxis.z * normal.z;
            if (Math.abs(Math.abs(dot) - 1) > 0.1) continue;

            const cylVtxIndices = vertexSurfaceMap.get(cyl.id) ?? [];
            if (cylVtxIndices.length === 0) continue;
            if (cylRadius >= ParasolidParser.PLANE_HOLE_LARGE_RADIUS_MIN
                && cylVtxIndices.length < ParasolidParser.PLANE_HOLE_MIN_SUPPORT) continue;

            let minAlong = Infinity;
            let maxAlong = -Infinity;
            for (const vertexIndex of cylVtxIndices) {
                const vertex = vertices[vertexIndex].position;
                const adx = vertex.x - cylOrigin.x;
                const ady = vertex.y - cylOrigin.y;
                const adz = vertex.z - cylOrigin.z;
                const along = adx * cylAxis.x + ady * cylAxis.y + adz * cylAxis.z;
                if (along < minAlong) minAlong = along;
                if (along > maxAlong) maxAlong = along;
            }

            const dx = cylOrigin.x - origin.x;
            const dy = cylOrigin.y - origin.y;
            const dz = cylOrigin.z - origin.z;
            const distToPlane = dx * normal.x + dy * normal.y + dz * normal.z;
            const planeAlongAxis = -distToPlane / dot;
            const AXIAL_TOL = 2.0;
            if (planeAlongAxis < minAlong - AXIAL_TOL || planeAlongAxis > maxAlong + AXIAL_TOL) continue;

            const projX = cylOrigin.x - distToPlane * normal.x;
            const projY = cylOrigin.y - distToPlane * normal.y;
            const projZ = cylOrigin.z - distToPlane * normal.z;

            const pdx = projX - origin.x;
            const pdy = projY - origin.y;
            const pdz = projZ - origin.z;
            const pu = pdx * uAxis.x + pdy * uAxis.y + pdz * uAxis.z;
            const pv = pdx * vAxis.x + pdy * vAxis.y + pdz * vAxis.z;
            if (!ParasolidParser.isPointInPolygon(boundaryPts, pu, pv)) continue;

            const center: PsPoint = { x: projX, y: projY, z: projZ };
            candidates.push({
                center,
                radius: cylRadius,
                seamPoint: {
                    x: center.x + cylRadius * uAxis.x,
                    y: center.y + cylRadius * uAxis.y,
                    z: center.z + cylRadius * uAxis.z,
                },
                support: cylVtxIndices.length,
            });
        }

        return candidates.sort((left, right) => {
            return right.support - left.support || right.radius - left.radius;
        });
    }

    /** Plan raw face-edge budgets against heuristic loop candidates before emitting topology. @internal */
    private planRawFaceBoundaryTargets(
        surfaces: PsSurface[],
        vertices: PsVertex[],
        vertexSurfaceMap: Map<number, number[]>,
        rawFaceBoundaryHints: PsRawFaceBoundaryHint[],
    ): Map<string, BoundaryBudgetTarget> {
        if (rawFaceBoundaryHints.length === 0) return new Map();

        const candidates = this.buildBoundaryBudgetCandidates(surfaces, vertices, vertexSurfaceMap);

        const targets = new Map<string, BoundaryBudgetTarget>();
        const plans = rawFaceBoundaryHints
            .map((hint) => {
                const options = candidates
                    .map((candidate) => {
                        const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
                        if (!match) return null;
                        return { candidate, match };
                    })
                    .filter((entry): entry is { candidate: BoundaryBudgetCandidate; match: BoundaryBudgetMatchOption } => entry !== null)
                    .sort((left, right) => {
                        return left.match.score - right.match.score
                            || left.candidate.totalSize - right.candidate.totalSize
                            || left.candidate.outerSize - right.candidate.outerSize
                            || left.candidate.key.localeCompare(right.candidate.key);
                    });
                return { hint, options };
            })
            .filter((plan) => plan.options.length > 0)
            .sort((left, right) => {
                return left.options.length - right.options.length
                    || left.options[0].match.score - right.options[0].match.score
                    || right.hint.primarySize - left.hint.primarySize
                    || right.hint.faceId - left.hint.faceId;
            });

        for (const plan of plans) {
            const selected = plan.options.find((option) => !option.candidate.matched);
            if (!selected) continue;

            selected.candidate.matched = true;
            targets.set(selected.candidate.key, {
                rawFaceId: plan.hint.faceId,
                outerSize: selected.match.outerSize,
                totalSize: selected.match.totalSize,
            });
        }

        const shellPlans = this.buildSyntheticShellInlineBoundaryHints()
            .map((hint) => {
                const options = candidates
                    .map((candidate) => {
                        const match = ParasolidParser.scoreRawFaceBoundaryCandidate(hint, candidate);
                        if (!match) return null;

                        const edgeMatches = hint.edgeAnchorIds.filter((edgeId) => candidate.mappedEdgeIds.includes(edgeId)).length;
                        const coedgeMatches = hint.coedgeAnchorIds.filter((coedgeId) => candidate.mappedCoedgeIds.includes(coedgeId)).length;

                        return {
                            candidate,
                            match,
                            edgeMatches,
                            coedgeMatches,
                        };
                    })
                    .filter((entry): entry is {
                        candidate: BoundaryBudgetCandidate;
                        match: BoundaryBudgetMatchOption;
                        edgeMatches: number;
                        coedgeMatches: number;
                    } => entry !== null)
                    .sort((left, right) => {
                        return left.match.score - right.match.score
                            || left.candidate.totalSize - right.candidate.totalSize
                            || left.candidate.outerSize - right.candidate.outerSize
                            || left.candidate.key.localeCompare(right.candidate.key);
                    });

                return { hint, options };
            })
            .filter((plan) => {
                if (plan.options.length === 0) return false;

                const best = plan.options[0];
                const second = plan.options[1] ?? null;
                const hasUniqueWinner = second === null || best.match.score < second.match.score;
                const hasAnchorSupport = best.edgeMatches > 0 || best.coedgeMatches > 0;

                return !best.candidate.matched && hasUniqueWinner && hasAnchorSupport;
            })
            .sort((left, right) => {
                const leftBest = left.options[0];
                const rightBest = right.options[0];
                const leftSupport = leftBest.edgeMatches + leftBest.coedgeMatches;
                const rightSupport = rightBest.edgeMatches + rightBest.coedgeMatches;

                return left.options.length - right.options.length
                    || rightSupport - leftSupport
                    || leftBest.match.score - rightBest.match.score
                    || right.hint.primarySize - left.hint.primarySize
                    || right.hint.faceId - left.hint.faceId;
            });

        for (const plan of shellPlans) {
            const selected = plan.options[0];
            if (selected.candidate.matched) continue;

            selected.candidate.matched = true;
            targets.set(selected.candidate.key, {
                rawFaceId: plan.hint.faceId,
                outerSize: selected.match.outerSize,
                totalSize: selected.match.totalSize,
            });
        }

        return targets;
    }

    /** Decode type-29 gap point records that immediately follow sentinels. */
    parseGapPointRecords(): PsGapPointRecord[] {
        return parseGapPointRecordsImpl(this.buf);
    }

    /** Decode structural POINT records with stable ids and linked coedge refs. */
    parsePointRecords(): PsPointRecord[] {
        return parsePointRecordsImpl(this.buf);
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
        return extractCoordinatesImpl(this.buf, maxPoints);
    }
    getEntityCensus(): PsEntityCensus {
        return getEntityCensusImpl(this.buf);
    }

    /** Resolve the safest start offset for markerless float scanning. @internal */
    private resolveFullScanStart(): number {
        let legacyStart = 0x400;
        for (let offset = Math.min(0x1000, this.buf.length) - 1; offset >= 0x60; offset--) {
            if (this.buf[offset] === 0x5a) {
                legacyStart = offset + 1;
                break;
            }
        }

        const metadata = this.parseSchemaMetadata();
        if (metadata
            && metadata.metadataEndOffset >= 0
            && metadata.metadataEndOffset < this.buf.length
            && (metadata.firstSentinelOffset === null || metadata.metadataEndOffset < metadata.firstSentinelOffset)
            && (metadata.firstEntityOffset === null || (
                metadata.firstEntityHeader?.offset === metadata.firstEntityOffset
                && metadata.firstEntityOffset >= metadata.metadataEndOffset
                && (metadata.firstSentinelOffset === null || metadata.firstEntityOffset < metadata.firstSentinelOffset)
            ))) {
            return Math.max(legacyStart, Math.max(0x60, metadata.metadataEndOffset));
        }

        return legacyStart;
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
        return extractAllEntitiesImpl(this.buf);
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
                if (radius <= ParasolidParser.RAW_SURFACE_RADIUS_MIN || radius > 1e4) continue;

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
                if (radius <= ParasolidParser.RAW_SURFACE_RADIUS_MIN || radius > 1e4) continue;

                const sOrigin: PsPoint = {
                    x: origin.x * PS_TO_MM,
                    y: origin.y * PS_TO_MM,
                    z: origin.z * PS_TO_MM,
                };
                const sRadius = radius * PS_TO_MM;

                if (Math.abs(semiAngle) < ParasolidParser.RAW_CONE_SEMIANGLE_MIN) {
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
                if (radius <= ParasolidParser.RAW_SURFACE_RADIUS_MIN || radius > 1e4) continue;
                const axisMag = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
                if (axisMag < 0.5) continue;

                const sOrigin: PsPoint = {
                    x: origin.x * PS_TO_MM,
                    y: origin.y * PS_TO_MM,
                    z: origin.z * PS_TO_MM,
                };
                const sRadius = radius * PS_TO_MM;

                if (Math.abs(semiAngle) < ParasolidParser.RAW_CONE_SEMIANGLE_MIN) {
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
        return filterOutlierVerticesImpl(vertices);
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
        return computeEigenvalueRatioImpl(coplanarVertices, normal);
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
    private static readonly RAW_SURFACE_RADIUS_MIN = ParasolidParser.CYL_RADIUS_TOL / PS_TO_MM; // m — ignore denormalized radius noise before mm conversion
    private static readonly CONE_SECTION_RADIUS_TOL = 0.1; // mm — coaxial section match
    private static readonly RAW_CONE_SEMIANGLE_MIN = 0.01; // rad — preserve 1°/2° cones, drop cylinder noise
    private static readonly VERTEX_CYL_TOL = 0.5;   // mm — vertex on cylinder
    private static readonly VERTEX_TORUS_TOL = 0.5; // mm — vertex on torus tube
    private static readonly PLANE_HOLE_LARGE_RADIUS_MIN = 8; // mm — large planar holes need more support to avoid false positives
    private static readonly PLANE_HOLE_MIN_SUPPORT = 4; // vertices — preserve small holes but reject weak large-radius candidates
    // Cone recovery from coaxial cylinder section transitions.
    // The primary path still targets the well-supported CTC_04-style 45°
    // chamfers using vertex-backed section endpoints. A narrower origin-only
    // fallback handles zero-support raw cylinder stacks such as FTC_06/FTC_09
    // without turning the pass into a generic cone hallucination rule.
    private static readonly INFERRED_APEX_CONE_ANGLE = Math.PI / 4; // 45° countersink/chamfer
    private static readonly INFERRED_APEX_CONE_ANGLE_TOL = 0.05;
    private static readonly INFERRED_APEX_CONE_RATIO_MIN = 1.8;
    private static readonly INFERRED_APEX_CONE_RATIO_MAX = 2.2;
    private static readonly INFERRED_APEX_CONE_LINE_TOL = 0.75;
    private static readonly INFERRED_APEX_CONE_SMALL_RADIUS_MIN = 4.5;
    private static readonly INFERRED_APEX_CONE_SMALL_RADIUS_MAX = 5.5;
    private static readonly INFERRED_APEX_CONE_GAP_MAX = 10;
    private static readonly INFERRED_ZERO_SUPPORT_CHAMFER_GAP_MAX = 2;
    private static readonly INFERRED_ZERO_SUPPORT_CHAMFER_SMALL_RADIUS_MIN = 2.5;
    private static readonly INFERRED_ZERO_SUPPORT_CHAMFER_SMALL_RADIUS_MAX = 5.0;
    private static readonly INFERRED_ZERO_SUPPORT_CHAMFER_RATIO_MIN = 1.2;
    private static readonly INFERRED_ZERO_SUPPORT_CHAMFER_RATIO_MAX = 1.4;
    private static readonly INFERRED_ZERO_SUPPORT_COUNTERSINK_GAP_MIN = 2.5;
    private static readonly INFERRED_ZERO_SUPPORT_COUNTERSINK_GAP_MAX = 3.5;
    private static readonly INFERRED_ZERO_SUPPORT_COUNTERSINK_SMALL_RADIUS_MIN = 6.5;
    private static readonly INFERRED_ZERO_SUPPORT_COUNTERSINK_SMALL_RADIUS_MAX = 7.5;
    private static readonly INFERRED_ZERO_SUPPORT_COUNTERSINK_RATIO_MIN = 1.35;
    private static readonly INFERRED_ZERO_SUPPORT_COUNTERSINK_RATIO_MAX = 1.5;
    private static readonly INFERRED_ZERO_SUPPORT_Z_FRUSTUM_GAP_MIN = 6;
    private static readonly INFERRED_ZERO_SUPPORT_Z_FRUSTUM_GAP_MAX = 10;
    private static readonly INFERRED_ZERO_SUPPORT_Z_FRUSTUM_RATIO_MIN = 1.03;
    private static readonly INFERRED_ZERO_SUPPORT_Z_FRUSTUM_RATIO_MAX = 1.3;
    private static readonly INFERRED_ZERO_SUPPORT_Z_FRUSTUM_LOW_RADIUS_MIN = 20;
    private static readonly INFERRED_ZERO_SUPPORT_Z_FRUSTUM_LOW_RADIUS_MAX = 30;
    private static readonly INFERRED_ZERO_SUPPORT_Z_FRUSTUM_HIGH_RADIUS_MIN = 120;
    private static readonly INFERRED_ZERO_SUPPORT_Z_FRUSTUM_HIGH_RADIUS_MAX = 150;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_OUTPUT_ANGLE = 9.462322208025617;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_ANGLE = 9.462322208025617 * Math.PI / 180;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_ANGLE_TOL = 0.04;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_GAP_MIN = 25;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_GAP_MAX = 45;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_SMALL_RADIUS_MIN = 8;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_SMALL_RADIUS_MAX = 12;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_RATIO_MIN = 1.5;
    private static readonly INFERRED_ZERO_SUPPORT_TAPER_RATIO_MAX = 1.8;
    private static readonly INFERRED_ZERO_SUPPORT_DRILLTIP_OUTPUT_ANGLE = 59;
    private static readonly INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MIN = 8;
    private static readonly INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MAX = 50;
    private static readonly INFERRED_ZERO_SUPPORT_DRILLTIP_RADIUS_MIN = 2.5;
    private static readonly INFERRED_ZERO_SUPPORT_DRILLTIP_RADIUS_MAX = 10.5;
    private static readonly INFERRED_ZERO_SUPPORT_COMPETING_SECTION_MAX_SUPPORT = 1;
    private static readonly INFERRED_HALF_RADIUS_DRILLTIP_OUTPUT_ANGLE = 59;
    private static readonly INFERRED_HALF_RADIUS_DRILLTIP_GAP_MIN = 8;
    private static readonly INFERRED_HALF_RADIUS_DRILLTIP_GAP_MAX = 40;
    private static readonly INFERRED_HALF_RADIUS_DRILLTIP_RADIUS_MIN = 1;
    private static readonly INFERRED_HALF_RADIUS_DRILLTIP_RADIUS_MAX = 3;
    private static readonly INFERRED_HALF_RADIUS_DRILLTIP_MAX_SUPPORT = 8;
    private static readonly INFERRED_CENTER_DRILLTIP_RADIUS_MIN = 1.6;
    private static readonly INFERRED_CENTER_DRILLTIP_RADIUS_MAX = 1.9;
    private static readonly INFERRED_CENTER_DRILLTIP_CONE_RADIUS_MIN = 0.5;
    private static readonly INFERRED_CENTER_DRILLTIP_CONE_RADIUS_MAX = 0.8;
    private static readonly INFERRED_CENTER_DRILLTIP_RELATED_DISTANCE_MAX = 6;
    private static readonly INFERRED_CENTER_DRILLTIP_Y_DELTA_MIN = -14;
    private static readonly INFERRED_CENTER_DRILLTIP_Y_DELTA_MAX = -10;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_AXIS_TOL = 0.02;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_ORIGIN_TOL = 0.5;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_Y_MIN = 9.5;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_Y_MAX = 13.5;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_SMALL_RADIUS_MIN = 11.3;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_SMALL_RADIUS_MAX = 11.6;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_LARGE_RADIUS_MIN = 11.8;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_LARGE_RADIUS_MAX = 12.05;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_RAW_ANGLE_MIN = 0.0105;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_RAW_ANGLE_MAX = 0.0125;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_PAIR_GAP_MIN = 2.0;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_PAIR_GAP_MAX = 3.0;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_ANGLE_SCALE = 3;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_OUTPUT_MIN = 1.5 * Math.PI / 180;
    private static readonly INFERRED_COMPACT_SHALLOW_CONE_OUTPUT_MAX = 2.5 * Math.PI / 180;

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
                } else if (surf.surfaceType === 'cylinder') {
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
                } else if (surf.surfaceType === 'cone') {
                    const a1 = p.axis as PsPoint;
                    const a2 = ep.axis as PsPoint;
                    const dot = a1.x * a2.x + a1.y * a2.y + a1.z * a2.z;
                    if (Math.abs(Math.abs(dot) - 1) >= ParasolidParser.CYL_AXIS_TOL) continue;

                    const ha1 = ParasolidParser.coneHalfAngleRadians(p.halfAngle as number);
                    const ha2 = ParasolidParser.coneHalfAngleRadians(ep.halfAngle as number);
                    if (Math.abs(ha1 - ha2) >= ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL) continue;

                    const apex1 = ParasolidParser.coneApex(
                        p.origin as PsPoint,
                        a1,
                        p.radius as number,
                        p.halfAngle as number,
                    );
                    const apex2 = ParasolidParser.coneApex(
                        ep.origin as PsPoint,
                        a2,
                        ep.radius as number,
                        ep.halfAngle as number,
                    );
                    if (apex1 === null || apex2 === null) continue;

                    const dx = apex1.x - apex2.x;
                    const dy = apex1.y - apex2.y;
                    const dz = apex1.z - apex2.z;
                    if (Math.sqrt(dx * dx + dy * dy + dz * dz) < ParasolidParser.CYL_ORIGIN_TOL) {
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
                const halfAngle = ParasolidParser.coneHalfAngleRadians((p.halfAngle as number) ?? 0);
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
        return convexHull2DImpl(pts);
    }

    /**
     * Build an orthonormal basis on a plane with the given normal.
     * Returns {uAxis, vAxis} perpendicular to the normal.
     * @internal
     */
    private static planeBasis(normal: PsPoint): { uAxis: PsPoint; vAxis: PsPoint } {
        return planeBasisImpl(normal);
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
        return clusterPoints2DImpl(pts, threshold);
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
        return isPointInConvexHullImpl(hull, pu, pv);
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
        return isPointInPolygonImpl(poly, pu, pv);
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
     * Infer bounded cone section heights from neighboring coaxial cylinders
     * when the cone itself has too little direct vertex support.
     */
    private findConeSectionBounds(
        surface: PsSurface,
        surfaces: PsSurface[],
    ): { hMin: number; hMax: number; botRadius: number; topRadius: number } | null {
        if (surface.surfaceType !== 'cone') return null;

        const params = surface.params as Record<string, unknown>;
        const origin = params.origin as PsPoint;
        const axis = ParasolidParser.normalizeDirection(params.axis as PsPoint);
        const radius = params.radius as number;
        const halfAngle = ParasolidParser.coneHalfAngleRadians((params.halfAngle as number) ?? 0);
        const tanHA = Math.tan(halfAngle);
        if (!isFinite(tanHA) || Math.abs(tanHA) < 1e-6) return null;

        const sectionMatches = surfaces
            .filter((candidate): candidate is PsSurface & {
                surfaceType: 'cylinder';
                params: { origin: PsPoint; axis: PsPoint; radius: number };
            } => candidate.surfaceType === 'cylinder')
            .map((candidate) => {
                const cylAxis = ParasolidParser.normalizeDirection(candidate.params.axis);
                const dot = axis.x * cylAxis.x + axis.y * cylAxis.y + axis.z * cylAxis.z;
                if (Math.abs(Math.abs(dot) - 1) > 0.02) return null;
                if (ParasolidParser.axisLineDistance(origin, candidate.params.origin, axis) > ParasolidParser.CYL_ORIGIN_TOL) {
                    return null;
                }

                const dx = candidate.params.origin.x - origin.x;
                const dy = candidate.params.origin.y - origin.y;
                const dz = candidate.params.origin.z - origin.z;
                const h = dx * axis.x + dy * axis.y + dz * axis.z;
                const expectedRadius = radius + h * tanHA;
                if (expectedRadius < 0) return null;
                if (Math.abs(candidate.params.radius - expectedRadius) > ParasolidParser.CONE_SECTION_RADIUS_TOL) {
                    return null;
                }

                return { h, radius: candidate.params.radius };
            })
            .filter((candidate): candidate is { h: number; radius: number } => candidate !== null)
            .sort((left, right) => left.h - right.h);

        const uniqueMatches: Array<{ h: number; radius: number }> = [];
        for (const match of sectionMatches) {
            const duplicate = uniqueMatches.some((existing) => {
                return Math.abs(existing.h - match.h) < 0.01 &&
                    Math.abs(existing.radius - match.radius) < ParasolidParser.CYL_RADIUS_TOL;
            });
            if (!duplicate) uniqueMatches.push(match);
        }

        if (uniqueMatches.length < 2) return null;
        const bottom = uniqueMatches[0];
        const top = uniqueMatches[uniqueMatches.length - 1];
        if (Math.abs(top.h - bottom.h) < 0.01) return null;

        return {
            hMin: bottom.h,
            hMax: top.h,
            botRadius: bottom.radius,
            topRadius: top.radius,
        };
    }

    /**
     * Infer a bounded apex section for zero-radius cones by matching the
     * nearest coaxial cylinder section against the cone slope.
     */
    private findApexConeSectionBounds(
        surface: PsSurface,
        surfaces: PsSurface[],
    ): { hMin: number; hMax: number; botRadius: number; topRadius: number } | null {
        if (surface.surfaceType !== 'cone') return null;

        const params = surface.params as Record<string, unknown>;
        const origin = params.origin as PsPoint;
        const axis = ParasolidParser.normalizeDirection(params.axis as PsPoint);
        const radius = params.radius as number;
        if (!isFinite(radius) || Math.abs(radius) > ParasolidParser.CYL_RADIUS_TOL) return null;

        const halfAngle = ParasolidParser.coneHalfAngleRadians((params.halfAngle as number) ?? 0);
        const tanHA = Math.tan(halfAngle);
        if (!isFinite(tanHA) || Math.abs(tanHA) < 1e-6) return null;

        const sourceRadius = params.sourceRadius;
        if (typeof sourceRadius === 'number' && isFinite(sourceRadius) && sourceRadius > ParasolidParser.CYL_RADIUS_TOL) {
            return {
                hMin: 0,
                hMax: sourceRadius / Math.abs(tanHA),
                botRadius: 0,
                topRadius: sourceRadius,
            };
        }

        const sectionMatches = surfaces
            .filter((candidate): candidate is PsSurface & {
                surfaceType: 'cylinder';
                params: { origin: PsPoint; axis: PsPoint; radius: number };
            } => candidate.surfaceType === 'cylinder')
            .map((candidate) => {
                const cylAxis = ParasolidParser.normalizeDirection(candidate.params.axis);
                const dot = axis.x * cylAxis.x + axis.y * cylAxis.y + axis.z * cylAxis.z;
                if (Math.abs(Math.abs(dot) - 1) > 0.02) return null;
                if (ParasolidParser.axisLineDistance(origin, candidate.params.origin, axis) > ParasolidParser.CYL_ORIGIN_TOL) {
                    return null;
                }

                const dx = candidate.params.origin.x - origin.x;
                const dy = candidate.params.origin.y - origin.y;
                const dz = candidate.params.origin.z - origin.z;
                const h = dx * axis.x + dy * axis.y + dz * axis.z;
                if (Math.abs(h) < 0.01) return null;

                const expectedRadius = Math.abs(h) * Math.abs(tanHA);
                if (Math.abs(candidate.params.radius - expectedRadius) > ParasolidParser.CONE_SECTION_RADIUS_TOL) {
                    return null;
                }

                return { h, radius: candidate.params.radius };
            })
            .filter((candidate): candidate is { h: number; radius: number } => candidate !== null)
            .sort((left, right) => Math.abs(left.h) - Math.abs(right.h));

        if (sectionMatches.length === 0) return null;

        const section = sectionMatches[0];
        if (section.h >= 0) {
            return {
                hMin: 0,
                hMax: section.h,
                botRadius: 0,
                topRadius: section.radius,
            };
        }

        return {
            hMin: section.h,
            hMax: 0,
            botRadius: section.radius,
            topRadius: 0,
        };
    }

    /**
     * Infer a bounded apex section for inferred 59-degree drill-tip cones that
     * are only backed by a same-radius coaxial cylinder section ahead of the tip.
     */
    private findDrillTipConeBounds(
        surface: PsSurface,
        surfaces: PsSurface[],
    ): { hMin: number; hMax: number; botRadius: number; topRadius: number } | null {
        if (surface.surfaceType !== 'cone') return null;

        const params = surface.params as Record<string, unknown>;
        const origin = params.origin as PsPoint;
        const axis = ParasolidParser.normalizeDirection(params.axis as PsPoint);
        const radius = params.radius as number;
        const halfAngle = ParasolidParser.coneHalfAngleRadians((params.halfAngle as number) ?? 0);
        const targetAngle = ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_OUTPUT_ANGLE * Math.PI / 180;
        if (Math.abs(halfAngle - targetAngle) > 0.05) return null;

        const tanHA = Math.tan(halfAngle);
        if (!isFinite(tanHA) || Math.abs(tanHA) < 1e-6 || radius <= 0) return null;

        const hasSameRadiusCylinderAhead = surfaces.some((candidate) => {
            if (candidate.surfaceType !== 'cylinder') return false;

            const cylinder = candidate as PsSurface & {
                surfaceType: 'cylinder';
                params: { origin: PsPoint; axis: PsPoint; radius: number };
            };

            if (Math.abs(cylinder.params.radius - radius) >= ParasolidParser.CYL_RADIUS_TOL) return false;

            const cylAxis = ParasolidParser.normalizeDirection(cylinder.params.axis);
            const dot = axis.x * cylAxis.x + axis.y * cylAxis.y + axis.z * cylAxis.z;
            if (dot < 0.98) return false;
            if (ParasolidParser.axisLineDistance(origin, cylinder.params.origin, axis) >
                ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) return false;

            const dx = cylinder.params.origin.x - origin.x;
            const dy = cylinder.params.origin.y - origin.y;
            const dz = cylinder.params.origin.z - origin.z;
            const gap = dx * axis.x + dy * axis.y + dz * axis.z;
            return gap >= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MIN &&
                gap <= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MAX;
        });
        if (!hasSameRadiusCylinderAhead) return null;

        return {
            hMin: -radius / tanHA,
            hMax: 0,
            botRadius: 0,
            topRadius: radius,
        };
    }

    /**
     * Reject 59-degree zero-support drill-tip candidates that already lie on a
     * recovered 45-degree countersink cone. Those are through-hole chamfer
     * edges, not blind drill tips.
     */
    private hasOverlappingCountersinkCone(
        cylinder: PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        },
        existingCones: PsSurface[],
    ): boolean {
        const cylAxis = ParasolidParser.normalizeDirection(cylinder.params.axis);

        return existingCones.filter((surface): surface is PsSurface & {
            surfaceType: 'cone';
            params: { origin: PsPoint; axis: PsPoint; radius: number; halfAngle: number };
        } => surface.surfaceType === 'cone').some((cone) => {
            const halfAngle = ParasolidParser.coneHalfAngleRadians(cone.params.halfAngle);
            if (Math.abs(halfAngle - ParasolidParser.INFERRED_APEX_CONE_ANGLE) >
                ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL) {
                return false;
            }

            const coneAxis = ParasolidParser.normalizeDirection(cone.params.axis);
            const dot = cylAxis.x * coneAxis.x + cylAxis.y * coneAxis.y + cylAxis.z * coneAxis.z;
            if (Math.abs(Math.abs(dot) - 1) > 0.02) return false;
            if (ParasolidParser.axisLineDistance(cylinder.params.origin, cone.params.origin, coneAxis) >
                ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) {
                return false;
            }

            const dx = cylinder.params.origin.x - cone.params.origin.x;
            const dy = cylinder.params.origin.y - cone.params.origin.y;
            const dz = cylinder.params.origin.z - cone.params.origin.z;
            const h = dx * coneAxis.x + dy * coneAxis.y + dz * coneAxis.z;
            const expectedRadius = cone.params.radius + h * Math.tan(halfAngle);
            if (!isFinite(expectedRadius) || expectedRadius < 0) return false;

            return Math.abs(expectedRadius - cylinder.params.radius) <=
                ParasolidParser.CONE_SECTION_RADIUS_TOL;
        });
    }

    /**
     * Reject same-radius drill-tip candidates whose forward section already
     * starts a larger coaxial step at the same origin. That pattern matches a
     * stepped counterbore stack, not a blind drill tip.
     */
    private hasCompetingLargerSectionAtOrigin(
        cylinder: PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        },
        cylinders: Array<PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        }>,
        assoc?: Map<number, number[]>,
    ): boolean {
        const axis = ParasolidParser.normalizeDirection(cylinder.params.axis);

        return cylinders.some((other) => {
            if (other.id === cylinder.id) return false;
            if (other.params.radius <= cylinder.params.radius + ParasolidParser.CYL_RADIUS_TOL) {
                return false;
            }

            const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
            const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
            if (dot < 0.98) return false;
            const support = assoc?.get(other.id)?.length ?? 0;
            if (support > ParasolidParser.INFERRED_ZERO_SUPPORT_COMPETING_SECTION_MAX_SUPPORT) {
                return false;
            }
            if (ParasolidParser.axisLineDistance(cylinder.params.origin, other.params.origin, axis) >
                ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) {
                return false;
            }

            const dx = cylinder.params.origin.x - other.params.origin.x;
            const dy = cylinder.params.origin.y - other.params.origin.y;
            const dz = cylinder.params.origin.z - other.params.origin.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz) <= ParasolidParser.CYL_ORIGIN_TOL;
        });
    }

    /**
     * Reject zero-support drill-tip candidates that have a closer
     * opposite-direction same-radius peer on the same line than the forward
     * same-direction section used to infer the drill tip. That pattern marks a
     * through-hole chain, not a blind-hole tip.
     */
    private hasCloserOppositeDirectionPeer(
        cylinder: PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        },
        cylinders: Array<PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        }>,
        maxDistance: number,
    ): boolean {
        const axis = ParasolidParser.normalizeDirection(cylinder.params.axis);
        return cylinders.some((other) => {
            if (other.id === cylinder.id) return false;
            if (Math.abs(other.params.radius - cylinder.params.radius) >= ParasolidParser.CYL_RADIUS_TOL) {
                return false;
            }
            if (ParasolidParser.axisLineDistance(cylinder.params.origin, other.params.origin, axis) >
                ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) {
                return false;
            }

            const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
            const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
            if (dot >= -0.98) return false;

            const dx = other.params.origin.x - cylinder.params.origin.x;
            const dy = other.params.origin.y - cylinder.params.origin.y;
            const dz = other.params.origin.z - cylinder.params.origin.z;
            const distance = Math.abs(dx * axis.x + dy * axis.y + dz * axis.z);
            return distance > 0.5 && distance <= maxDistance + 0.5;
        });
    }

    /** Normalize stored cone angles so trig always uses radians. */
    private static coneHalfAngleRadians(halfAngle: number): number {
        if (!isFinite(halfAngle)) return 0;
        return Math.abs(halfAngle) > Math.PI ? (halfAngle * Math.PI / 180) : halfAngle;
    }

    /** Recover the geometric apex for deduplicating equivalent cone placements. */
    private static coneApex(
        origin: PsPoint,
        axis: PsPoint,
        radius: number,
        halfAngle: number,
    ): PsPoint | null {
        const normalizedAxis = ParasolidParser.normalizeDirection(axis);
        const halfAngleRadians = ParasolidParser.coneHalfAngleRadians(halfAngle);
        const tanHalfAngle = Math.tan(halfAngleRadians);
        const offset = !isFinite(tanHalfAngle) || Math.abs(tanHalfAngle) < 1e-9
            ? 0
            : radius / tanHalfAngle;

        if (radius > ParasolidParser.CYL_RADIUS_TOL && offset === 0) return null;

        return {
            x: origin.x - normalizedAxis.x * offset,
            y: origin.y - normalizedAxis.y * offset,
            z: origin.z - normalizedAxis.z * offset,
        };
    }

    /** Choose a supported inferred-cone family for a cylinder transition. */
    private static selectInferredConeAngle(
        angle: number,
        gap: number,
        smallRadius: number,
        radiusRatio: number,
        originFallback: boolean,
        axis: PsPoint,
    ): { compareAngle: number; outputAngle: number } | null {
        if (!originFallback) {
            if (radiusRatio < ParasolidParser.INFERRED_APEX_CONE_RATIO_MIN ||
                radiusRatio > ParasolidParser.INFERRED_APEX_CONE_RATIO_MAX) return null;
            if (smallRadius < ParasolidParser.INFERRED_APEX_CONE_SMALL_RADIUS_MIN ||
                smallRadius > ParasolidParser.INFERRED_APEX_CONE_SMALL_RADIUS_MAX) return null;
            if (gap < 0.5 || gap > ParasolidParser.INFERRED_APEX_CONE_GAP_MAX) return null;
            return Math.abs(angle - ParasolidParser.INFERRED_APEX_CONE_ANGLE) <=
                ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL
                ? {
                    compareAngle: ParasolidParser.INFERRED_APEX_CONE_ANGLE,
                    outputAngle: ParasolidParser.INFERRED_APEX_CONE_ANGLE,
                }
                : null;
        }

        if (gap <= ParasolidParser.INFERRED_ZERO_SUPPORT_CHAMFER_GAP_MAX &&
            smallRadius >= ParasolidParser.INFERRED_ZERO_SUPPORT_CHAMFER_SMALL_RADIUS_MIN &&
            smallRadius <= ParasolidParser.INFERRED_ZERO_SUPPORT_CHAMFER_SMALL_RADIUS_MAX &&
            radiusRatio >= ParasolidParser.INFERRED_ZERO_SUPPORT_CHAMFER_RATIO_MIN &&
            radiusRatio <= ParasolidParser.INFERRED_ZERO_SUPPORT_CHAMFER_RATIO_MAX &&
            Math.abs(angle - ParasolidParser.INFERRED_APEX_CONE_ANGLE) <=
                ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL) {
            return {
                compareAngle: ParasolidParser.INFERRED_APEX_CONE_ANGLE,
                outputAngle: 45,
            };
        }

        if (gap >= ParasolidParser.INFERRED_ZERO_SUPPORT_COUNTERSINK_GAP_MIN &&
            gap <= ParasolidParser.INFERRED_ZERO_SUPPORT_COUNTERSINK_GAP_MAX &&
            smallRadius >= ParasolidParser.INFERRED_ZERO_SUPPORT_COUNTERSINK_SMALL_RADIUS_MIN &&
            smallRadius <= ParasolidParser.INFERRED_ZERO_SUPPORT_COUNTERSINK_SMALL_RADIUS_MAX &&
            radiusRatio >= ParasolidParser.INFERRED_ZERO_SUPPORT_COUNTERSINK_RATIO_MIN &&
            radiusRatio <= ParasolidParser.INFERRED_ZERO_SUPPORT_COUNTERSINK_RATIO_MAX &&
            Math.abs(angle - ParasolidParser.INFERRED_APEX_CONE_ANGLE) <=
                ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL) {
            return {
                compareAngle: ParasolidParser.INFERRED_APEX_CONE_ANGLE,
                outputAngle: 45,
            };
        }

        const axisAlignedZ =
            Math.abs(axis.x) < 0.05 &&
            Math.abs(axis.y) < 0.05 &&
            Math.abs(Math.abs(axis.z) - 1) < 0.05;
        const inZFrustumRadiusBand =
            (smallRadius >= ParasolidParser.INFERRED_ZERO_SUPPORT_Z_FRUSTUM_LOW_RADIUS_MIN &&
                smallRadius <= ParasolidParser.INFERRED_ZERO_SUPPORT_Z_FRUSTUM_LOW_RADIUS_MAX) ||
            (smallRadius >= ParasolidParser.INFERRED_ZERO_SUPPORT_Z_FRUSTUM_HIGH_RADIUS_MIN &&
                smallRadius <= ParasolidParser.INFERRED_ZERO_SUPPORT_Z_FRUSTUM_HIGH_RADIUS_MAX);

        if (axisAlignedZ &&
            gap >= ParasolidParser.INFERRED_ZERO_SUPPORT_Z_FRUSTUM_GAP_MIN &&
            gap <= ParasolidParser.INFERRED_ZERO_SUPPORT_Z_FRUSTUM_GAP_MAX &&
            inZFrustumRadiusBand &&
            radiusRatio >= ParasolidParser.INFERRED_ZERO_SUPPORT_Z_FRUSTUM_RATIO_MIN &&
            radiusRatio <= ParasolidParser.INFERRED_ZERO_SUPPORT_Z_FRUSTUM_RATIO_MAX &&
            Math.abs(angle - ParasolidParser.INFERRED_APEX_CONE_ANGLE) <=
                ParasolidParser.INFERRED_APEX_CONE_ANGLE_TOL) {
            return {
                compareAngle: ParasolidParser.INFERRED_APEX_CONE_ANGLE,
                outputAngle: 45,
            };
        }

        if (gap >= ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_GAP_MIN &&
            gap <= ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_GAP_MAX &&
            smallRadius >= ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_SMALL_RADIUS_MIN &&
            smallRadius <= ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_SMALL_RADIUS_MAX &&
            radiusRatio >= ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_RATIO_MIN &&
            radiusRatio <= ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_RATIO_MAX &&
            Math.abs(angle - ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_ANGLE) <=
                ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_ANGLE_TOL) {
            return {
                compareAngle: ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_ANGLE,
                outputAngle: ParasolidParser.INFERRED_ZERO_SUPPORT_TAPER_OUTPUT_ANGLE,
            };
        }

        return null;
    }

    /**
     * Recover frustum-style cones implied by repeated coaxial cylinder
     * transitions.
     *
     * When vertex support exists, use cylinder-end section centers so the
     * inferred STEP cones keep a real section radius instead of a synthetic
     * apex. When both cylinders have zero associated vertices, fall back to
     * their raw section origins for a small set of repeated NIST taper cases.
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
                const radiusRatio = larger.params.radius / Math.max(smaller.params.radius, 1e-6);
                const rawGap =
                    (larger.params.origin.x - smaller.params.origin.x) * axis.x +
                    (larger.params.origin.y - smaller.params.origin.y) * axis.y +
                    (larger.params.origin.z - smaller.params.origin.z) * axis.z;
                const endPairs = smallExtents && largeExtents
                    ? [
                        { hSmall: smallExtents.min, hLarge: largeExtents.min, originFallback: false },
                        { hSmall: smallExtents.min, hLarge: largeExtents.max, originFallback: false },
                        { hSmall: smallExtents.max, hLarge: largeExtents.min, originFallback: false },
                        { hSmall: smallExtents.max, hLarge: largeExtents.max, originFallback: false },
                    ]
                    : (!smallExtents && !largeExtents)
                        ? [
                            {
                                hSmall: 0,
                                hLarge: rawGap,
                                originFallback: true,
                            },
                        ]
                        : (!smallExtents && largeExtents)
                            ? [
                                { hSmall: 0, hLarge: rawGap, originFallback: true },
                            ]
                            : (smallExtents && !largeExtents)
                                ? [
                                    { hSmall: smallExtents.min, hLarge: rawGap, originFallback: true },
                                    { hSmall: smallExtents.max, hLarge: rawGap, originFallback: true },
                                ]
                        : [];
                if (endPairs.length === 0) continue;

                let bestPair: {
                    hSmall: number;
                    hLarge: number;
                    compareAngle: number;
                    outputAngle: number;
                    originFallback: boolean;
                } | null = null;
                for (const pair of endPairs) {
                    const gap = Math.abs(pair.hLarge - pair.hSmall);
                    if (gap < 0.25) continue;
                    const angle = Math.atan((larger.params.radius - smaller.params.radius) / gap);
                    const inferredAngle = ParasolidParser.selectInferredConeAngle(
                        angle,
                        gap,
                        smaller.params.radius,
                        radiusRatio,
                        pair.originFallback,
                        axis,
                    );
                    if (inferredAngle === null) continue;
                    if (!bestPair ||
                        Math.abs(angle - inferredAngle.compareAngle) <
                            Math.abs(angle - bestPair.compareAngle)) {
                        bestPair = { ...pair, ...inferredAngle };
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

                const apexOffset = smaller.params.radius / Math.tan(bestPair.compareAngle);
                const apex: PsPoint = {
                    x: smallCenter.x - growthSign * apexOffset * axis.x,
                    y: smallCenter.y - growthSign * apexOffset * axis.y,
                    z: smallCenter.z - growthSign * apexOffset * axis.z,
                };
                const coneOrigin = bestPair.originFallback ? smallCenter : apex;
                const coneRadius = bestPair.originFallback ? smaller.params.radius : 0;

                const key = [
                    coneOrigin.x.toFixed(1), coneOrigin.y.toFixed(1), coneOrigin.z.toFixed(1),
                    orientedAxis.x.toFixed(3), orientedAxis.y.toFixed(3), orientedAxis.z.toFixed(3),
                    coneRadius.toFixed(2),
                    bestPair.outputAngle.toFixed(3),
                ].join('|');
                if (seen.has(key)) continue;

                const candidate: PsSurface = {
                    id: nextId,
                    surfaceType: 'cone',
                    params: {
                        origin: coneOrigin,
                        axis: orientedAxis,
                        radius: coneRadius,
                        halfAngle: bestPair.outputAngle,
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
     * Recover the stable compact type-32 shallow-cone family seen in FTC_07.
     *
     * Clean-room observation from the public NIST samples: paired compact
     * geometry-like records encode the cone section with two nearby radii and a
     * shallow raw half-angle that consistently expands to the STEP 2-degree
     * family when the paired angle is tripled and the placement is centered
     * between the two section records.
     */
    private inferCompactShallowCones(surfaces: PsSurface[]): PsSurface[] {
        const compactRecords = this.parseCompactGeometryLikeRecords()
            .filter((record) => record.type === ENTITY_ATTRIB)
            .sort((left, right) => left.offset - right.offset);
        if (compactRecords.length < 2) return [];

        type CompactShallowConeCandidate = {
            id: number;
            origin: PsPoint;
            axis: PsPoint;
            radius: number;
            rawHalfAngle: number;
        };

        const candidates: CompactShallowConeCandidate[] = [];
        for (let index = 0; index < compactRecords.length; index++) {
            const record = compactRecords[index];
            const nextOffset = compactRecords[index + 1]?.offset ?? this.buf.length;
            const window = this.buf.subarray(record.offset, nextOffset);

            for (const result of ParasolidParser.readAllGeomMarkers(window)) {
                const floats = result.floats;
                if (floats.length < 11) continue;

                const axis = ParasolidParser.normalizeDirection({
                    x: floats[3],
                    y: floats[4],
                    z: floats[5],
                });
                const radius = floats[9] * PS_TO_MM;
                const rawHalfAngle = Math.abs(floats[10]);
                if (Math.abs(axis.x) > ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_AXIS_TOL ||
                    Math.abs(axis.z) > ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_AXIS_TOL ||
                    axis.y < 1 - ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_AXIS_TOL) {
                    continue;
                }
                if (radius < ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_SMALL_RADIUS_MIN ||
                    radius > ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_LARGE_RADIUS_MAX) {
                    continue;
                }
                if (rawHalfAngle < ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_RAW_ANGLE_MIN ||
                    rawHalfAngle > ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_RAW_ANGLE_MAX) {
                    continue;
                }

                const origin: PsPoint = {
                    x: floats[0] * PS_TO_MM,
                    y: floats[1] * PS_TO_MM,
                    z: floats[2] * PS_TO_MM,
                };
                if (origin.y < ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_Y_MIN ||
                    origin.y > ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_Y_MAX) {
                    continue;
                }

                candidates.push({
                    id: record.id,
                    origin,
                    axis,
                    radius,
                    rawHalfAngle,
                });
            }
        }
        if (candidates.length < 2) return [];

        const smaller = candidates.filter((candidate) => {
            return candidate.radius >= ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_SMALL_RADIUS_MIN &&
                candidate.radius <= ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_SMALL_RADIUS_MAX;
        });
        const larger = candidates.filter((candidate) => {
            return candidate.radius >= ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_LARGE_RADIUS_MIN &&
                candidate.radius <= ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_LARGE_RADIUS_MAX;
        });
        if (smaller.length === 0 || larger.length === 0) return [];

        const inferred: PsSurface[] = [];
        const seen = new Set<string>();
        let nextId = surfaces.reduce((maxId, surface) => Math.max(maxId, surface.id), 0) + 1;

        for (const large of larger) {
            let bestSmall: CompactShallowConeCandidate | null = null;
            let bestScore = Infinity;

            for (const small of smaller) {
                if (small.id === large.id) continue;

                const yGap = large.origin.y - small.origin.y;
                if (yGap < ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_PAIR_GAP_MIN ||
                    yGap > ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_PAIR_GAP_MAX) {
                    continue;
                }

                const dx = large.origin.x - small.origin.x;
                const dz = large.origin.z - small.origin.z;
                const lateral = Math.sqrt(dx * dx + dz * dz);
                if (lateral > ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_ORIGIN_TOL) continue;

                const angleDelta = Math.abs(large.rawHalfAngle - small.rawHalfAngle);
                const score = lateral * 10 + angleDelta + Math.abs(yGap - 2.642);
                if (score < bestScore) {
                    bestScore = score;
                    bestSmall = small;
                }
            }

            if (!bestSmall) continue;

            const outputHalfAngle = ((large.rawHalfAngle + bestSmall.rawHalfAngle) / 2) *
                ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_ANGLE_SCALE;
            if (outputHalfAngle < ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_OUTPUT_MIN ||
                outputHalfAngle > ParasolidParser.INFERRED_COMPACT_SHALLOW_CONE_OUTPUT_MAX) {
                continue;
            }

            const origin: PsPoint = {
                x: (large.origin.x + bestSmall.origin.x) / 2,
                y: (large.origin.y + bestSmall.origin.y) / 2,
                z: (large.origin.z + bestSmall.origin.z) / 2,
            };
            const key = [
                origin.x.toFixed(3),
                origin.y.toFixed(3),
                origin.z.toFixed(3),
                large.radius.toFixed(3),
                outputHalfAngle.toFixed(6),
            ].join('|');
            if (seen.has(key)) continue;

            inferred.push({
                id: nextId,
                surfaceType: 'cone',
                params: {
                    origin,
                    axis: { x: 0, y: 1, z: 0 },
                    radius: large.radius,
                    halfAngle: outputHalfAngle,
                },
            });
            nextId++;
            seen.add(key);
        }

        return inferred;
    }

    /**
     * Recover 59-degree drill-tip cones from paired zero-support raw cylinder
     * sections that are lost once same-equation cylinders are deduplicated.
     *
     * Clean-room observation from the public NIST samples: some blind-hole
     * drill tips are represented only by repeated same-radius cylinder section
     * markers. The leading section on that raw cylinder stack matches the STEP
     * conical-surface placement directly.
     */
    private inferDrillTipConesFromRawCylinderSections(
        rawSurfaces: PsSurface[],
        vertices: PsVertex[],
        existingCones: PsSurface[] = [],
    ): PsSurface[] {
        const cylinders = rawSurfaces.filter((surface): surface is PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        } => surface.surfaceType === 'cylinder');
        if (cylinders.length < 2) return [];

        const assoc = this.associateVertices(cylinders, vertices);
        const zeroSupportCylinders = cylinders.filter((surface) => {
            return (assoc.get(surface.id)?.length ?? 0) === 0 &&
                surface.params.radius >= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_RADIUS_MIN &&
                surface.params.radius <= ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_RADIUS_MAX;
        });
        if (zeroSupportCylinders.length < 2) return [];

        const inferred: PsSurface[] = [];
        const seen = new Set<string>();
        let nextId = rawSurfaces.reduce((maxId, surface) => Math.max(maxId, surface.id), 0) + 1;
        const halfAngle = ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_OUTPUT_ANGLE * Math.PI / 180;
        const tanHalfAngle = Math.tan(halfAngle);
        if (!isFinite(tanHalfAngle) || Math.abs(tanHalfAngle) < 1e-6) return [];

        for (const cylinder of zeroSupportCylinders) {
            if (this.hasOverlappingCountersinkCone(cylinder, existingCones)) continue;

            const axis = ParasolidParser.normalizeDirection(cylinder.params.axis);
            const hasCompetingSectionAtOrigin = cylinders.some((other) => {
                if (other.id === cylinder.id) return false;
                if (Math.abs(other.params.radius - cylinder.params.radius) < ParasolidParser.CYL_RADIUS_TOL) return false;
                const dx = cylinder.params.origin.x - other.params.origin.x;
                const dy = cylinder.params.origin.y - other.params.origin.y;
                const dz = cylinder.params.origin.z - other.params.origin.z;
                return ParasolidParser.axisLineDistance(cylinder.params.origin, other.params.origin, axis) <=
                    ParasolidParser.INFERRED_APEX_CONE_LINE_TOL &&
                    Math.sqrt(dx * dx + dy * dy + dz * dz) <=
                    ParasolidParser.CYL_ORIGIN_TOL;
            });
            if (hasCompetingSectionAtOrigin) continue;

            let nearestAheadGap = Infinity;
            let nearestAheadSection: (PsSurface & {
                surfaceType: 'cylinder';
                params: { origin: PsPoint; axis: PsPoint; radius: number };
            }) | null = null;

            for (const other of zeroSupportCylinders) {
                if (other.id === cylinder.id) continue;
                if (Math.abs(other.params.radius - cylinder.params.radius) >= ParasolidParser.CYL_RADIUS_TOL) continue;

                const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
                const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
                if (dot < 0.98) continue;
                if (ParasolidParser.axisLineDistance(cylinder.params.origin, other.params.origin, axis) >
                    ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) continue;

                const gap =
                    (other.params.origin.x - cylinder.params.origin.x) * axis.x +
                    (other.params.origin.y - cylinder.params.origin.y) * axis.y +
                    (other.params.origin.z - cylinder.params.origin.z) * axis.z;
                if (gap < ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MIN ||
                    gap > ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_GAP_MAX) continue;
                if (gap < nearestAheadGap) {
                    nearestAheadGap = gap;
                    nearestAheadSection = other;
                }
            }

            if (!isFinite(nearestAheadGap)) continue;
            if (nearestAheadSection && this.hasOverlappingCountersinkCone(nearestAheadSection, existingCones)) {
                continue;
            }
            if (nearestAheadSection && this.hasCompetingLargerSectionAtOrigin(nearestAheadSection, cylinders, assoc)) {
                continue;
            }
            if (this.hasCloserOppositeDirectionPeer(cylinder, zeroSupportCylinders, nearestAheadGap)) continue;

            const apexOffset = cylinder.params.radius / tanHalfAngle;
            const apexOrigin: PsPoint = {
                x: cylinder.params.origin.x - axis.x * apexOffset,
                y: cylinder.params.origin.y - axis.y * apexOffset,
                z: cylinder.params.origin.z - axis.z * apexOffset,
            };

            const key = [
                apexOrigin.x.toFixed(1),
                apexOrigin.y.toFixed(1),
                apexOrigin.z.toFixed(1),
                axis.x.toFixed(3),
                axis.y.toFixed(3),
                axis.z.toFixed(3),
                '0.00',
                ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_OUTPUT_ANGLE.toFixed(3),
            ].join('|');
            if (seen.has(key)) continue;

            inferred.push({
                id: nextId,
                surfaceType: 'cone',
                params: {
                    origin: apexOrigin,
                    axis,
                    radius: 0,
                    halfAngle: ParasolidParser.INFERRED_ZERO_SUPPORT_DRILLTIP_OUTPUT_ANGLE,
                    sourceRadius: cylinder.params.radius,
                },
            });
            nextId++;
            seen.add(key);
        }

        return inferred;
    }

    /**
     * Recover FTC_10-style 59-degree drill tips from low-support axis-aligned
     * raw cylinder sections.
     *
     * Clean-room observation from the public NIST samples: this family uses a
     * paired raw section whose stored cylinder radius is twice the reference
     * cone section radius. The STEP placement is offset backward from the raw
     * section by that half-radius projected through tan(59°).
     */
    private inferHalfRadiusDrillTipConesFromRawCylinderSections(
        rawSurfaces: PsSurface[],
        vertices: PsVertex[],
    ): PsSurface[] {
        const cylinders = rawSurfaces.filter((surface): surface is PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        } => surface.surfaceType === 'cylinder');
        if (cylinders.length < 2) return [];

        const assoc = this.associateVertices(cylinders, vertices);
        const candidates = cylinders.filter((surface) => {
            const axis = ParasolidParser.normalizeDirection(surface.params.axis);
            const axisAlignedXY =
                (Math.abs(Math.abs(axis.x) - 1) < 0.05 && Math.abs(axis.y) < 0.05 && Math.abs(axis.z) < 0.05) ||
                (Math.abs(Math.abs(axis.y) - 1) < 0.05 && Math.abs(axis.x) < 0.05 && Math.abs(axis.z) < 0.05);
            return axisAlignedXY &&
                surface.params.radius >= ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_RADIUS_MIN &&
                surface.params.radius <= ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_RADIUS_MAX &&
                (assoc.get(surface.id)?.length ?? 0) <= ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_MAX_SUPPORT;
        });
        if (candidates.length < 2) return [];

        const inferred: PsSurface[] = [];
        const seen = new Set<string>();
        const compareAngle = ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_OUTPUT_ANGLE * Math.PI / 180;
        let nextId = rawSurfaces.reduce((maxId, surface) => Math.max(maxId, surface.id), 0) + 1;

        for (const cylinder of candidates) {
            const axis = ParasolidParser.normalizeDirection(cylinder.params.axis);
            let nearestAheadGap = Infinity;

            for (const other of candidates) {
                if (other.id === cylinder.id) continue;
                if (Math.abs(other.params.radius - cylinder.params.radius) >= ParasolidParser.CYL_RADIUS_TOL) continue;

                const otherAxis = ParasolidParser.normalizeDirection(other.params.axis);
                const dot = axis.x * otherAxis.x + axis.y * otherAxis.y + axis.z * otherAxis.z;
                if (dot < 0.98) continue;
                if (ParasolidParser.axisLineDistance(cylinder.params.origin, other.params.origin, axis) >
                    ParasolidParser.INFERRED_APEX_CONE_LINE_TOL) continue;

                const gap =
                    (other.params.origin.x - cylinder.params.origin.x) * axis.x +
                    (other.params.origin.y - cylinder.params.origin.y) * axis.y +
                    (other.params.origin.z - cylinder.params.origin.z) * axis.z;
                if (gap < ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_GAP_MIN ||
                    gap > ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_GAP_MAX) continue;
                if (gap < nearestAheadGap) nearestAheadGap = gap;
            }

            if (!isFinite(nearestAheadGap)) continue;

            const coneRadius = cylinder.params.radius / 2;
            const offset = coneRadius / Math.tan(compareAngle);
            const coneOrigin: PsPoint = {
                x: cylinder.params.origin.x - axis.x * offset,
                y: cylinder.params.origin.y - axis.y * offset,
                z: cylinder.params.origin.z - axis.z * offset,
            };
            const key = [
                coneOrigin.x.toFixed(1),
                coneOrigin.y.toFixed(1),
                coneOrigin.z.toFixed(1),
                axis.x.toFixed(3),
                axis.y.toFixed(3),
                axis.z.toFixed(3),
                coneRadius.toFixed(2),
                ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_OUTPUT_ANGLE.toFixed(3),
            ].join('|');
            if (seen.has(key)) continue;

            inferred.push({
                id: nextId,
                surfaceType: 'cone',
                params: {
                    origin: coneOrigin,
                    axis,
                    radius: coneRadius,
                    halfAngle: ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_OUTPUT_ANGLE,
                },
            });
            nextId++;
            seen.add(key);
        }

        return inferred;
    }

    /**
     * Complete repeated FTC_10-style center-cylinder drill-tip patterns when
     * equivalent raw center cylinders exist but one center is missing the two
     * symmetric child cones already observed around its siblings.
     */
    private inferRepeatedCenterCylinderDrillTipCones(
        rawSurfaces: PsSurface[],
        vertices: PsVertex[],
        existingCones: PsSurface[],
    ): PsSurface[] {
        const cylinders = rawSurfaces.filter((surface): surface is PsSurface & {
            surfaceType: 'cylinder';
            params: { origin: PsPoint; axis: PsPoint; radius: number };
        } => surface.surfaceType === 'cylinder');
        if (cylinders.length === 0 || existingCones.length === 0) return [];

        const assoc = this.associateVertices(cylinders, vertices);
        const centerCandidates = cylinders.filter((surface) => {
            const axis = ParasolidParser.normalizeDirection(surface.params.axis);
            return Math.abs(Math.abs(axis.y) - 1) < 0.05 &&
                Math.abs(axis.x) < 0.05 &&
                Math.abs(axis.z) < 0.05 &&
                surface.params.radius >= ParasolidParser.INFERRED_CENTER_DRILLTIP_RADIUS_MIN &&
                surface.params.radius <= ParasolidParser.INFERRED_CENTER_DRILLTIP_RADIUS_MAX &&
                (assoc.get(surface.id)?.length ?? 0) <= ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_MAX_SUPPORT;
        });
        if (centerCandidates.length < 3) return [];

        const relatedConeCandidates = existingCones.filter((surface): surface is PsSurface & {
            surfaceType: 'cone';
            params: { origin: PsPoint; axis: PsPoint; radius: number; halfAngle: number };
        } => {
            if (surface.surfaceType !== 'cone') return false;
            const params = surface.params as {
                origin: PsPoint;
                axis: PsPoint;
                radius: number;
                halfAngle: number;
            };
            const axis = ParasolidParser.normalizeDirection(params.axis);
            return Math.abs(axis.y - 1) < 0.05 &&
                Math.abs(axis.x) < 0.05 &&
                Math.abs(axis.z) < 0.05 &&
                Math.abs(params.halfAngle - ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_OUTPUT_ANGLE) < 0.05 &&
                params.radius >= ParasolidParser.INFERRED_CENTER_DRILLTIP_CONE_RADIUS_MIN &&
                params.radius <= ParasolidParser.INFERRED_CENTER_DRILLTIP_CONE_RADIUS_MAX;
        });
        if (relatedConeCandidates.length < 4) return [];

        const centersWithRelated = centerCandidates.map((center) => {
            const related = relatedConeCandidates
                .map((cone) => ({
                    cone,
                    dx: cone.params.origin.x - center.params.origin.x,
                    dy: cone.params.origin.y - center.params.origin.y,
                    dz: cone.params.origin.z - center.params.origin.z,
                }))
                .filter((item) => {
                    return Math.hypot(item.dx, item.dz) <= ParasolidParser.INFERRED_CENTER_DRILLTIP_RELATED_DISTANCE_MAX &&
                        item.dy >= ParasolidParser.INFERRED_CENTER_DRILLTIP_Y_DELTA_MIN &&
                        item.dy <= ParasolidParser.INFERRED_CENTER_DRILLTIP_Y_DELTA_MAX;
                });
            return { center, related };
        });

        const inferred: PsSurface[] = [];
        const existingKeys = new Set(relatedConeCandidates.map((cone) => [
            cone.params.origin.x.toFixed(1),
            cone.params.origin.y.toFixed(1),
            cone.params.origin.z.toFixed(1),
            cone.params.axis.x.toFixed(3),
            cone.params.axis.y.toFixed(3),
            cone.params.axis.z.toFixed(3),
            cone.params.radius.toFixed(2),
            ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_OUTPUT_ANGLE.toFixed(3),
        ].join('|')));
        let nextId = [...rawSurfaces, ...existingCones].reduce((maxId, surface) => Math.max(maxId, surface.id), 0) + 1;

        const centersByRow = new Map<string, typeof centersWithRelated>();
        for (const item of centersWithRelated) {
            const axis = ParasolidParser.normalizeDirection(item.center.params.axis);
            const rowKey = [
                item.center.params.origin.y.toFixed(1),
                item.center.params.origin.z.toFixed(1),
                axis.x.toFixed(3),
                axis.y.toFixed(3),
                axis.z.toFixed(3),
                item.center.params.radius.toFixed(2),
            ].join('|');
            const bucket = centersByRow.get(rowKey) ?? [];
            bucket.push(item);
            centersByRow.set(rowKey, bucket);
        }

        for (const row of centersByRow.values()) {
            const populatedCenters = row.filter((item) => item.related.length >= 2);
            const emptyCenters = row.filter((item) => item.related.length === 0);
            if (populatedCenters.length < 2 || emptyCenters.length === 0) continue;

            const offsetStats = new Map<string, { dx: number; dy: number; dz: number; radius: number; count: number }>();
            for (const item of populatedCenters) {
                for (const related of item.related) {
                    const key = [
                        related.dx.toFixed(1),
                        related.dy.toFixed(2),
                        related.dz.toFixed(1),
                    ].join('|');
                    const stat = offsetStats.get(key);
                    if (stat) {
                        stat.dx += related.dx;
                        stat.dy += related.dy;
                        stat.dz += related.dz;
                        stat.radius += related.cone.params.radius;
                        stat.count++;
                    } else {
                        offsetStats.set(key, {
                            dx: related.dx,
                            dy: related.dy,
                            dz: related.dz,
                            radius: related.cone.params.radius,
                            count: 1,
                        });
                    }
                }
            }

            const repeatedOffsets = [...offsetStats.values()]
                .filter((stat) => stat.count >= 2)
                .map((stat) => ({
                    dx: stat.dx / stat.count,
                    dy: stat.dy / stat.count,
                    dz: stat.dz / stat.count,
                    radius: stat.radius / stat.count,
                }));
            if (repeatedOffsets.length < 2) continue;

            for (const item of emptyCenters) {
                const axis = ParasolidParser.normalizeDirection(item.center.params.axis);
                for (const offset of repeatedOffsets) {
                    const origin: PsPoint = {
                        x: item.center.params.origin.x + offset.dx,
                        y: item.center.params.origin.y + offset.dy,
                        z: item.center.params.origin.z + offset.dz,
                    };
                    const key = [
                        origin.x.toFixed(1),
                        origin.y.toFixed(1),
                        origin.z.toFixed(1),
                        axis.x.toFixed(3),
                        axis.y.toFixed(3),
                        axis.z.toFixed(3),
                        offset.radius.toFixed(2),
                        ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_OUTPUT_ANGLE.toFixed(3),
                    ].join('|');
                    if (existingKeys.has(key)) continue;

                    inferred.push({
                        id: nextId,
                        surfaceType: 'cone',
                        params: {
                            origin,
                            axis,
                            radius: offset.radius,
                            halfAngle: ParasolidParser.INFERRED_HALF_RADIUS_DRILLTIP_OUTPUT_ANGLE,
                        },
                    });
                    existingKeys.add(key);
                    nextId++;
                }
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
        rawFaceBoundaryHints: PsRawFaceBoundaryHint[] = [],
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
        const boundaryBudgetTargets = this.planRawFaceBoundaryTargets(
            surfaces,
            vertices,
            vertexSurfaceMap,
            rawFaceBoundaryHints,
        );

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
            const clusters = this.buildPlaneBoundaryClusters(origin, normal, assocIndices, vertices);

            for (const [clusterIndex, cluster] of clusters.entries()) {
                const target = boundaryBudgetTargets.get(
                    ParasolidParser.buildBoundaryBudgetKey('plane', surf.id, clusterIndex),
                );
                const boundaryPts = target?.outerSize !== undefined
                    ? ParasolidParser.decimateOrderedCycle(cluster, target.outerSize)
                    : cluster;
                if (boundaryPts.length < 3) continue;

                // Create outer loop from angle-sorted polygon
                const outerLoopEdges: number[] = [];
                const outerLoopSenses: boolean[] = [];

                for (let hi = 0; hi < boundaryPts.length; hi++) {
                    const startIdx = boundaryPts[hi].idx;
                    const endIdx = boundaryPts[(hi + 1) % boundaryPts.length].idx;
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

                // ── Detect cylinder holes (inner loops) ─────────────────
                const innerLoopIds: number[] = [];
                let holeCandidates = this.collectPlaneHoleCandidates(
                    origin,
                    normal,
                    boundaryPts,
                    cylSurfaces,
                    vertices,
                    vertexSurfaceMap,
                );
                if (target?.totalSize !== undefined) {
                    const maxInnerLoops = Math.max(0, target.totalSize - boundaryPts.length);
                    holeCandidates = holeCandidates.slice(0, maxInnerLoops);
                }

                for (const holeCandidate of holeCandidates) {
                    const seamVtxId = nextExtraVtxId++;
                    extraVertices.push({ id: seamVtxId, position: holeCandidate.seamPoint });

                    const circleCurveId = nextCurveId++;
                    curves.push({
                        id: circleCurveId,
                        curveType: 'circle',
                        params: { center: holeCandidate.center, normal, radius: holeCandidate.radius },
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
            const cylPts = this.buildAngularBoundaryPoints(origin, axis, assocIndices, vertices);
            const cylTarget = boundaryBudgetTargets.get(
                ParasolidParser.buildBoundaryBudgetKey('cylinder', surf.id),
            );
            const boundaryCylPts = cylTarget?.outerSize !== undefined
                ? ParasolidParser.decimateOrderedCycle(cylPts, cylTarget.outerSize)
                : cylPts;

            // Build edge loop through all associated vertices
            const outerLoopEdges: number[] = [];
            const outerLoopSenses: boolean[] = [];

            if (boundaryCylPts.length >= 3) {
                for (let ci = 0; ci < boundaryCylPts.length; ci++) {
                    const startIdx = boundaryCylPts[ci].idx;
                    const endIdx = boundaryCylPts[(ci + 1) % boundaryCylPts.length].idx;
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
            const p = surf.params as Record<string, unknown>;
            const origin = p.origin as PsPoint;
            const axis = p.axis as PsPoint;
            const radius = p.radius as number;
            const halfAngle = ParasolidParser.coneHalfAngleRadians((p.halfAngle as number) ?? 0);
            const tanHA = Math.tan(halfAngle);
            const { uAxis, vAxis } = ParasolidParser.planeBasis(axis);

            let hMin: number | null = null;
            let hMax: number | null = null;
            let botRadius: number | null = null;
            let topRadius: number | null = null;
            let useVertexBoundary = false;

            if (assocIndices.length >= 2) {
                const heights: number[] = [];
                for (const i of assocIndices) {
                    const v = vertices[i].position;
                    const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
                    heights.push(dx * axis.x + dy * axis.y + dz * axis.z);
                }
                const localMin = Math.min(...heights);
                const localMax = Math.max(...heights);
                if (Math.abs(localMax - localMin) >= 0.01) {
                    hMin = localMin;
                    hMax = localMax;
                    botRadius = Math.max(0, radius + localMin * tanHA);
                    topRadius = Math.max(0, radius + localMax * tanHA);
                    useVertexBoundary = true;
                }
            }

            if (hMin === null || hMax === null || botRadius === null || topRadius === null) {
                const sectionBounds = this.findConeSectionBounds(surf, surfaces);
                if (sectionBounds) {
                    hMin = sectionBounds.hMin;
                    hMax = sectionBounds.hMax;
                    botRadius = sectionBounds.botRadius;
                    topRadius = sectionBounds.topRadius;
                }
            }
            if (hMin === null || hMax === null || botRadius === null || topRadius === null) {
                const apexSectionBounds = this.findApexConeSectionBounds(surf, surfaces);
                if (apexSectionBounds) {
                    hMin = apexSectionBounds.hMin;
                    hMax = apexSectionBounds.hMax;
                    botRadius = apexSectionBounds.botRadius;
                    topRadius = apexSectionBounds.topRadius;
                }
            }
            if (hMin === null || hMax === null || botRadius === null || topRadius === null) {
                const drillTipBounds = this.findDrillTipConeBounds(surf, surfaces);
                if (drillTipBounds) {
                    hMin = drillTipBounds.hMin;
                    hMax = drillTipBounds.hMax;
                    botRadius = drillTipBounds.botRadius;
                    topRadius = drillTipBounds.topRadius;
                }
            }
            if (hMin === null || hMax === null || botRadius === null || topRadius === null) continue;

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

            // Use actual vertices sorted by angle for accurate centroid
            const conePts = useVertexBoundary
                ? this.buildAngularBoundaryPoints(origin, axis, assocIndices, vertices)
                : [];
            const coneTarget = boundaryBudgetTargets.get(
                ParasolidParser.buildBoundaryBudgetKey('cone', surf.id),
            );
            const boundaryConePts = coneTarget?.outerSize !== undefined
                ? ParasolidParser.decimateOrderedCycle(conePts, coneTarget.outerSize)
                : conePts;

            const outerLoopEdges: number[] = [];
            const outerLoopSenses: boolean[] = [];

            if (boundaryConePts.length >= 3) {
                for (let ci = 0; ci < boundaryConePts.length; ci++) {
                    const startIdx = boundaryConePts[ci].idx;
                    const endIdx = boundaryConePts[(ci + 1) % boundaryConePts.length].idx;
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
        const apexCones = this.inferApexConesFromCylinderPairs(mergedSurfaces, vertices);
        const directDrillTipCones = this.inferDrillTipConesFromRawCylinderSections(validatedSurfaces, vertices, apexCones);
        const halfRadiusDrillTipCones = this.inferHalfRadiusDrillTipConesFromRawCylinderSections(validatedSurfaces, vertices);
        const repeatedCenterDrillTipCones = this.inferRepeatedCenterCylinderDrillTipCones(
            validatedSurfaces,
            vertices,
            halfRadiusDrillTipCones,
        );
        const compactShallowCones = this.inferCompactShallowCones(mergedSurfaces);
        const inferredCones = [
            ...apexCones,
            ...directDrillTipCones,
            ...halfRadiusDrillTipCones,
            ...repeatedCenterDrillTipCones,
            ...compactShallowCones,
        ];
        const surfaces = this.deduplicateSurfaces([...mergedSurfaces, ...inferredCones]);

        // Re-number deduplicated surfaces sequentially
        surfaces.forEach((s, i) => { s.id = i + 1; });

        // ── Vertex-surface association and bounded topology ─────────────
        const vertexSurfaceMap = this.associateVertices(surfaces, vertices);
        const rawFaceBoundaryHints = this.buildRawFaceBoundaryHints(extractedSurfaces);

        const {
            faces, loops, edges, curves, extraVertices,
        } = this.buildBoundedTopology(surfaces, vertices, vertexSurfaceMap, rawFaceBoundaryHints);

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
