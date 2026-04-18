import type { Buffer } from 'node:buffer';
import type { PsPoint } from '../step/ParasolidToStepMapper.js';

export interface PsTransmitHeader {
    modellerVersion: number;
    schemaId: string;
}

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

export interface PsSchemaFieldDefinition {
    offset: number;
    endOffset: number;
    typeCodes: string;
    name: string;
}

export interface PsNamedClassDefinition {
    offset: number;
    endOffset: number;
    name: string;
    classType: 'P' | 'O' | 'Q';
    flags: number;
    extra: number;
    count: number;
    parentId: number;
    fieldStart: number;
    fieldEnd: number;
}

export interface PsSchemaMetadata {
    schemaId: string;
    schemaOffset: number;
    schemaTerminatorOffset: number;
    metadataEndOffset: number;
    firstEntityOffset: number | null;
    firstEntityHeader: PsLinearEntityHeader | null;
    firstSentinelOffset: number | null;
    fieldDefinitions: PsSchemaFieldDefinition[];
    namedClasses: PsNamedClassDefinition[];
}

export interface PsLinearEntityHeader {
    offset: number;
    format: 'compact' | 'packed';
    type: number;
    id: number;
    flags: number;
    trailer: number | null;
}

export interface PsSentinelAlignedEntity {
    sentinelOffset: number;
    role: 'terminator' | 'embedded-data';
    header: PsLinearEntityHeader;
    refs: number[];
}

export interface PsCoedgeRecord {
    sentinelOffset: number;
    id: number;
    flags: number;
    curveLikeId: number;
    prevCoedgeId: number;
    nextCoedgeId: number;
    vertexPointId: number;
}

export interface PsCoedgeChain {
    headCoedgeId: number;
    tailCoedgeId: number;
    terminalPrevId: number;
    terminalNextId: number;
    orderedCoedges: PsCoedgeRecord[];
}

export interface PsEdgeRecord {
    sentinelOffset: number;
    id: number;
    flags: number;
    firstRefId: number;
    prevEdgeId: number;
    nextEdgeId: number;
    geometryLikeId: number;
    trailingRefAId: number;
    trailingRefBId: number;
}

export interface PsEdgeComponent {
    headEdgeId: number;
    tailEdgeId: number;
    terminalPrevId: number;
    terminalNextId: number;
    orderedEdges: PsEdgeRecord[];
}

export interface PsEdgeComponentChain {
    headEdgeId: number;
    tailEdgeId: number;
    terminalPrevId: number;
    terminalNextId: number;
    orderedComponents: PsEdgeComponent[];
}

export interface PsPointRecord {
    offset: number;
    format: 'sentinel' | 'packed';
    id: number;
    flags: number;
    nextCoedgeId: number;
    nextPointId: number;
    prevPointId: number;
    position: PsPoint;
}

export interface PsFaceRecord {
    offset: number;
    primary: boolean;
    id: number;
    flags: number;
    primaryRefId: number;
    geometryLikeId: number;
    secondaryRefId: number;
    shellId: number | null;
    coedgeAnchorAId: number | null;
    edgeAnchorAId: number | null;
    coedgeAnchorBId: number | null;
    edgeAnchorBId: number | null;
    dataLength: number;
}

export interface PsFaceInlineWindowRecord {
    faceId: number;
    shellId: number | null;
    wordLength: number;
    words: number[];
    markerWord: number;
    inlineTagWord: number;
    hasSelfFaceTail: boolean;
    hasSelfShellTail: boolean;
}

export interface PsShellInlineContainerLink {
    shellId: number;
    segmentIndex: number;
    linkedContainerId: number;
}

export interface PsShellInlineContainerGraph {
    nodeIds: number[];
    rootIds: number[];
    internalLinks: PsShellInlineContainerLink[];
    externalLinks: PsShellInlineContainerLink[];
}

export interface PsShellInlineFaceRecord {
    shellId: number;
    segmentIndex: number;
    inlineId: number;
    wordLength: number;
    refs: number[];
}

export interface PsShellInlineFaceAnchorRecord {
    shellId: number;
    segmentIndex: number;
    inlineId: number;
    refAId: number;
    refBId: number;
    coedgeAnchorId: number;
    refCId: number;
    edgeAnchorId: number;
}

export interface PsFaceEdgeHit {
    faceId: number;
    byteOffset: number;
    edgeId: number;
    chainIndex: number | null;
    componentIndex: number | null;
    edgeIndex: number | null;
    linearIndex: number | null;
}

export interface PsRawFaceBoundaryHint {
    faceId: number;
    primarySize: number;
    collapsedSize: number | null;
    edgeAnchorCount: number;
    edgeAnchorIds: number[];
    coedgeAnchorIds: number[];
    repeatedEdgeIds: number[];
    resolvedSurfaceType: string | null;
    chainCount: number;
    segmentCount: number;
    maxSegmentLength: number;
    maxChainSpan: number | null;
}

export interface BoundaryBudgetCandidate {
    key: string;
    surfaceType: string;
    outerSize: number;
    totalSize: number;
    holeCount: number;
    mappedEdgeCount: number;
    mappedEdgeIds: number[];
    mappedCoedgeIds: number[];
    chainCount: number;
    segmentCount: number;
    maxSegmentLength: number;
    maxChainSpan: number | null;
    matched: boolean;
}

export interface BoundaryBudgetTarget {
    rawFaceId: number;
    outerSize?: number;
    totalSize?: number;
}

export interface BoundaryBudgetMatchOption {
    score: number;
    outerSize?: number;
    totalSize?: number;
}

export interface PointEdgeChainPosition {
    coedgeId: number;
    edgeId: number | null;
    chainIndex: number | null;
    linearIndex: number | null;
}

export interface PsCompactGeometryRecord {
    offset: number;
    type: number;
    id: number;
    flags: number;
    refIds: [number, number, number, number];
    markerByte: number;
}

export interface PsCompactGeometryLikeRecord extends PsCompactGeometryRecord {}

export interface PsBroadProfileSegmentRecord {
    offset: number;
    type: number;
    id: number;
    refIds: [number, number, number, number];
    markerByte: number;
    markerOffset: number;
    shift: number;
    startPoint: PsPoint;
    endPoint: PsPoint;
    encodedLength: number;
    actualLength: number;
    tailScalar: number;
}

export interface PsProfileWrapperFrameRecord {
    markerByte: number;
    markerOffset: number;
    shift: number;
    origin: PsPoint;
    axis: PsPoint;
    refdir: PsPoint;
    tailScalars: number[];
}

export interface PsProfileWrapperRecord {
    offset: number;
    type: number;
    id: number;
    flags: number;
    payloadBytes: number;
    refIds: [number, number, number, number];
    previousSegmentId: number | null;
    nextSegmentId: number | null;
    primaryMarkerByte: number | null;
    primaryMarkerOffset: number | null;
    primaryShift: number | null;
    primaryPoint: PsPoint | null;
    primaryDirection: PsPoint | null;
    duplicatedSegment: PsBroadProfileSegmentRecord | null;
    framePlacement: PsProfileWrapperFrameRecord | null;
}

export interface PsProfileSkeletonComponent {
    segmentIds: number[];
    vertexPoints: PsPoint[];
    closed: boolean;
    closureWrapperId: number | null;
    closurePoint: PsPoint | null;
    closureDirection: PsPoint | null;
    closureLength: number | null;
}

export interface PsPackedGeometryLikeRecord {
    offset: number;
    type: number;
    id: number;
    flags: number;
    trailer: number;
    refIds: [number, number, number, number];
    markerByte: number;
}

export interface PsGeometryLikeAliasRecord {
    offset: number;
    type: number;
    id: number;
    canonicalId: number;
    flags: number;
    trailer: number | null;
    refIds: [number, number, number, number];
    markerByte: number;
}

export type PsDirectGeometryLikeRecord = PsCompactGeometryLikeRecord | PsPackedGeometryLikeRecord;

export interface PsGapPointRecord {
    sentinelOffset: number;
    separatorOffset: number;
    id: number;
    flags: number;
    nextCoedgeId: number;
    nextPointId: number;
    prevPointId: number;
    position: PsPoint;
}

export interface RawEntity {
    type: number;
    id: number;
    offset: number;
    primary: boolean;
    data: Buffer;
}