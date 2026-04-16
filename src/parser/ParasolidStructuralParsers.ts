import { Buffer } from 'node:buffer';
import type {
    PsPoint,
    PsSurface,
    PsVertex,
} from '../step/ParasolidToStepMapper.js';
import {
    buildBoundarySpreadMetrics,
    buildPointCoordKey,
} from './ParasolidParserUtils.js';
import {
    ENTITY_ATTRIB,
    ENTITY_BSPLINE,
    ENTITY_COEDGE,
    ENTITY_EDGE,
    ENTITY_FACE,
    ENTITY_GEOM_AUX,
    ENTITY_GEOM_CHAIN,
    ENTITY_LOOP,
    ENTITY_POINT,
    ENTITY_SHELL,
    ENTITY_SURFACE,
    NAMED_CLASS_TYPE_BYTES,
    POINT_COORD_OFFSET,
    PS_TO_MM,
    RECORD_MARKER_P,
    RECORD_MARKER_Q,
    RECORD_PREFIX,
    SCHEMA_FIELD_TYPE_BYTES,
    SENTINEL,
    SENTINEL_8,
    SUB_RECORD_SEP,
} from './ParasolidParserConstants.js';
import type {
    PointEdgeChainPosition,
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
    RawEntity,
} from './ParasolidParserTypes.js';

export function parseHeader(buf: Buffer): PsTransmitHeader | null {
    if (buf.length < 20 || buf[0] !== 0x50 || buf[1] !== 0x53) return null;

    const transmitIdx = buf.indexOf('TRANSMIT', 0, 'ascii');
    if (transmitIdx < 0 || transmitIdx > 32) return null;

    const versionMarker = buf.indexOf('version ', 0, 'ascii');
    let modellerVersion = 0;
    if (versionMarker >= 0 && versionMarker < 128) {
        let numStr = '';
        for (let index = versionMarker + 8; index < buf.length && index < versionMarker + 20; index++) {
            if (buf[index] >= 0x30 && buf[index] <= 0x39) numStr += String.fromCharCode(buf[index]);
            else break;
        }
        modellerVersion = parseInt(numStr, 10) || 0;
    }

    const schemaIndex = buf.indexOf('SCH_', 0, 'ascii');
    let schemaId = '';
    if (schemaIndex >= 0 && schemaIndex < 256) {
        let end = schemaIndex;
        while (end < buf.length && buf[end] >= 0x20 && buf[end] <= 0x7e) end++;
        schemaId = buf.subarray(schemaIndex, end).toString('ascii');
    }

    return { modellerVersion, schemaId };
}

export function parseSchemaMetadata(buf: Buffer): PsSchemaMetadata | null {
    const schemaIndex = buf.indexOf('SCH_', 0, 'ascii');
    if (schemaIndex < 0) return null;

    let schemaTerminatorOffset = schemaIndex;
    while (schemaTerminatorOffset < buf.length) {
        const byte = buf[schemaTerminatorOffset];
        if (byte === 0x00 || byte === 0x0a || byte === 0x0d) break;
        if (byte < 0x20 || byte > 0x7e) break;
        schemaTerminatorOffset++;
    }

    const schemaId = buf.subarray(schemaIndex, schemaTerminatorOffset).toString('ascii');
    const firstSentinelOffset = buf.indexOf(SENTINEL);
    const schemaRegionEnd = firstSentinelOffset >= 0
        ? firstSentinelOffset
        : Math.min(buf.length, schemaTerminatorOffset + 4096);

    const fieldDefinitions = parseSchemaFieldDefinitions(
        buf,
        schemaTerminatorOffset + 1,
        Math.min(schemaRegionEnd, schemaTerminatorOffset + 2048),
    );
    const namedClasses = parseNamedClassDefinitions(buf, schemaTerminatorOffset + 1, schemaRegionEnd);

    let metadataEndOffset = schemaTerminatorOffset + 1;
    for (const fieldDefinition of fieldDefinitions) {
        if (fieldDefinition.endOffset > metadataEndOffset) metadataEndOffset = fieldDefinition.endOffset;
    }
    for (const namedClass of namedClasses) {
        if (namedClass.endOffset > metadataEndOffset) metadataEndOffset = namedClass.endOffset;
    }

    const trailingSchemaTerminator = findLastSchemaTerminator(
        buf,
        metadataEndOffset,
        Math.min(schemaRegionEnd, metadataEndOffset + 64),
    );
    if (trailingSchemaTerminator >= 0) metadataEndOffset = trailingSchemaTerminator + 1;

    const firstEntityHeader = findFirstLinearEntityHeader(
        buf,
        metadataEndOffset,
        schemaRegionEnd,
        firstSentinelOffset >= 0 ? firstSentinelOffset : null,
    );

    return {
        schemaId,
        schemaOffset: schemaIndex,
        schemaTerminatorOffset,
        metadataEndOffset,
        firstEntityOffset: firstEntityHeader?.offset ?? null,
        firstEntityHeader,
        firstSentinelOffset: firstSentinelOffset >= 0 ? firstSentinelOffset : null,
        fieldDefinitions,
        namedClasses,
    };
}

export function findEntityClasses(buf: Buffer): string[] {
    const classes = new Set<string>();
    const metadata = parseSchemaMetadata(buf);
    for (const namedClass of metadata?.namedClasses ?? []) classes.add(namedClass.name);

    const knownNames = [
        'BODY', 'REGION', 'LUMP', 'SHELL', 'FACE', 'LOOP', 'FIN',
        'EDGE', 'VERTEX', 'POINT', 'CURVE', 'SURFACE',
        'PLANE', 'CYLINDER', 'CONE', 'SPHERE', 'TORUS',
        'LINE', 'CIRCLE', 'ELLIPSE', 'BCURVE', 'BSURF',
        'BODY_MATCH', 'ATTRIB',
    ];

    for (const name of knownNames) {
        const index = buf.indexOf(name, 0, 'ascii');
        if (index >= 0) classes.add(name);
    }

    return [...classes];
}

export function countEntityRecords(buf: Buffer): { pRecords: number; qRecords: number } {
    let pRecords = 0;
    let qRecords = 0;

    for (let index = 0; index < buf.length - 1; index++) {
        if (buf[index] !== RECORD_PREFIX) continue;
        if (buf[index + 1] === RECORD_MARKER_P) pRecords++;
        else if (buf[index + 1] === RECORD_MARKER_Q) qRecords++;
    }

    return { pRecords, qRecords };
}

export function parseSentinelAlignedEntities(buf: Buffer): PsSentinelAlignedEntity[] {
    const entities: PsSentinelAlignedEntity[] = [];

    for (const sentinelOffset of findEightByteSentinelOffsets(buf)) {
        const compactOffset = sentinelOffset - 18;
        if (compactOffset >= 0) {
            const header = parseLinearEntityHeader(buf, compactOffset, sentinelOffset);
            if (header?.format === 'compact') {
                entities.push({
                    sentinelOffset,
                    role: 'terminator',
                    header,
                    refs: [
                        buf.readUInt16BE(compactOffset + 10),
                        buf.readUInt16BE(compactOffset + 12),
                        buf.readUInt16BE(compactOffset + 14),
                        buf.readUInt16BE(compactOffset + 16),
                    ],
                });
            }
        }

        const packedOffset = sentinelOffset - 11;
        if (packedOffset >= 0) {
            const header = parseLinearEntityHeader(buf, packedOffset, sentinelOffset);
            if (header?.format === 'packed') {
                entities.push({
                    sentinelOffset,
                    role: 'embedded-data',
                    header,
                    refs: readPackedPostSentinelRefs(buf, sentinelOffset),
                });
            }
        }
    }

    return entities;
}

export function parseCoedgeRecords(buf: Buffer): PsCoedgeRecord[] {
    return parseSentinelAlignedEntities(buf)
        .filter((entity) => entity.role === 'terminator' && entity.header.type === ENTITY_COEDGE && entity.refs.length >= 4)
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

export function parseCoedgeChain(buf: Buffer): PsCoedgeChain | null {
    const coedges = parseCoedgeRecords(buf);
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

export function parseEdgeRecords(buf: Buffer): PsEdgeRecord[] {
    const records: PsEdgeRecord[] = [];

    for (const sentinelOffset of findEightByteSentinelOffsets(buf)) {
        const headerOffset = sentinelOffset - 10;
        if (headerOffset < 0) continue;

        const header = parseLinearEntityHeader(buf, headerOffset, sentinelOffset);
        if (!header || header.format !== 'compact' || header.type !== ENTITY_EDGE) continue;

        const refsStart = sentinelOffset + SENTINEL_8.length;
        const refsEnd = refsStart + 12;
        if (refsEnd > buf.length) continue;

        records.push({
            sentinelOffset,
            id: header.id,
            flags: header.flags,
            firstRefId: buf.readUInt16BE(refsStart),
            prevEdgeId: buf.readUInt16BE(refsStart + 2),
            nextEdgeId: buf.readUInt16BE(refsStart + 4),
            geometryLikeId: buf.readUInt16BE(refsStart + 6),
            trailingRefAId: buf.readUInt16BE(refsStart + 8),
            trailingRefBId: buf.readUInt16BE(refsStart + 10),
        });
    }

    return records;
}

export function parseFaceRecords(buf: Buffer): PsFaceRecord[] {
    const coedgeIds = new Set(parseCoedgeRecords(buf).map((record) => record.id));
    const edgeIds = new Set(parseEdgeRecords(buf).map((record) => record.id));

    return extractAllEntities(buf)
        .filter((entity) => entity.type === ENTITY_FACE && entity.data.length >= 12)
        .map((entity) => {
            const shellId = entity.data.length >= 18
                && entity.data.readUInt16BE(12) === ENTITY_SHELL
                && entity.data.readUInt16BE(16) === 1
                ? entity.data.readUInt16BE(14)
                : null;
            const coedgeAnchorAId = entity.data.length >= 26 ? entity.data.readUInt16BE(24) : 0;
            const edgeAnchorAId = entity.data.length >= 30 ? entity.data.readUInt16BE(28) : 0;
            const coedgeAnchorBId = entity.data.length >= 72 ? entity.data.readUInt16BE(70) : 0;
            const edgeAnchorBId = entity.data.length >= 76 ? entity.data.readUInt16BE(74) : 0;

            return {
                offset: entity.offset,
                primary: entity.primary,
                id: entity.id,
                flags: entity.data.readUInt16BE(2),
                primaryRefId: entity.data.readUInt16BE(6),
                geometryLikeId: entity.data.readUInt16BE(8),
                secondaryRefId: entity.data.readUInt16BE(10),
                shellId,
                coedgeAnchorAId: coedgeIds.has(coedgeAnchorAId) ? coedgeAnchorAId : null,
                edgeAnchorAId: edgeIds.has(edgeAnchorAId) ? edgeAnchorAId : null,
                coedgeAnchorBId: coedgeIds.has(coedgeAnchorBId) ? coedgeAnchorBId : null,
                edgeAnchorBId: edgeIds.has(edgeAnchorBId) ? edgeAnchorBId : null,
                dataLength: entity.data.length,
            };
        });
}

export function parseFaceInlineWindowRecords(buf: Buffer): PsFaceInlineWindowRecord[] {
    return extractAllEntities(buf)
        .filter((entity) => entity.type === ENTITY_FACE && entity.data.length >= 70)
        .map((entity) => {
            const shellId = entity.data.length >= 18
                && entity.data.readUInt16BE(12) === ENTITY_SHELL
                && entity.data.readUInt16BE(16) === 1
                ? entity.data.readUInt16BE(14)
                : null;
            const words: number[] = [];
            for (let byteOffset = 30; byteOffset < 70; byteOffset += 2) {
                words.push(entity.data.readUInt16BE(byteOffset));
            }
            return {
                faceId: entity.id,
                shellId,
                wordLength: words.length,
                words,
                markerWord: words[2],
                inlineTagWord: words[3],
                hasSelfFaceTail: words[17] === entity.id,
                hasSelfShellTail: shellId !== null && words[19] === shellId,
            };
        });
}

export function parseShellInlineContainerLinks(buf: Buffer): PsShellInlineContainerLink[] {
    const links: PsShellInlineContainerLink[] = [];

    forEachShellPayloadSegment(buf, (entity, segmentIndex, words) => {
        if (words.length === 2 && words[0] === ENTITY_SHELL) {
            links.push({
                shellId: entity.id,
                segmentIndex,
                linkedContainerId: words[1],
            });
        }
    });

    return links;
}

export function parseShellInlineContainerGraph(buf: Buffer): PsShellInlineContainerGraph {
    const nodeIds = extractAllEntities(buf)
        .filter((entity) => entity.type === ENTITY_SHELL)
        .map((entity) => entity.id)
        .sort((left, right) => left - right);
    const nodeIdSet = new Set(nodeIds);
    const internalLinks: PsShellInlineContainerLink[] = [];
    const externalLinks: PsShellInlineContainerLink[] = [];

    for (const link of parseShellInlineContainerLinks(buf)) {
        if (nodeIdSet.has(link.linkedContainerId)) internalLinks.push(link);
        else externalLinks.push(link);
    }

    const incomingInternalTargets = new Set(internalLinks.map((link) => link.linkedContainerId));
    const rootIds = nodeIds.filter((id) => !incomingInternalTargets.has(id));

    return { nodeIds, rootIds, internalLinks, externalLinks };
}

export function parseShellInlineFaceRecords(buf: Buffer): PsShellInlineFaceRecord[] {
    const records: PsShellInlineFaceRecord[] = [];

    forEachShellPayloadSegment(buf, (entity, segmentIndex, words) => {
        if (words.length === 0) return;
        if (words.length === 2 && words[0] === ENTITY_SHELL) return;

        const firstWord = words[0];
        const inlineType = firstWord >> 8;
        if (inlineType !== ENTITY_FACE) return;

        records.push({
            shellId: entity.id,
            segmentIndex,
            inlineId: firstWord & 0xff,
            wordLength: words.length,
            refs: words.slice(1),
        });
    });

    return records;
}

export function parseShellInlineFaceAnchorRecords(buf: Buffer): PsShellInlineFaceAnchorRecord[] {
    const coedgeIds = new Set(parseCoedgeRecords(buf).map((record) => record.id));
    const edgeIds = new Set(parseEdgeRecords(buf).map((record) => record.id));
    if (coedgeIds.size === 0 || edgeIds.size === 0) return [];

    return parseShellInlineFaceRecords(buf)
        .filter((record) => record.wordLength === 6
            && record.refs.length === 5
            && coedgeIds.has(record.refs[2])
            && edgeIds.has(record.refs[4]))
        .map((record) => ({
            shellId: record.shellId,
            segmentIndex: record.segmentIndex,
            inlineId: record.inlineId,
            refAId: record.refs[0],
            refBId: record.refs[1],
            coedgeAnchorId: record.refs[2],
            refCId: record.refs[3],
            edgeAnchorId: record.refs[4],
        }));
}

export function buildSyntheticShellInlineBoundaryHints(buf: Buffer): PsRawFaceBoundaryHint[] {
    const anchorRecords = parseShellInlineFaceAnchorRecords(buf);
    if (anchorRecords.length === 0) return [];

    const edgePositions = buildEdgeChainPositionMap(buf);
    const groups = new Map<string, {
        shellId: number;
        inlineId: number;
        edgeAnchorIds: Set<number>;
        coedgeAnchorIds: Set<number>;
    }>();

    for (const record of anchorRecords) {
        const key = `${record.shellId}:${record.inlineId}`;
        const group = groups.get(key) ?? {
            shellId: record.shellId,
            inlineId: record.inlineId,
            edgeAnchorIds: new Set<number>(),
            coedgeAnchorIds: new Set<number>(),
        };
        group.edgeAnchorIds.add(record.edgeAnchorId);
        group.coedgeAnchorIds.add(record.coedgeAnchorId);
        groups.set(key, group);
    }

    return [...groups.values()]
        .map((group) => {
            const orderedEdgePositions = [...group.edgeAnchorIds]
                .map((edgeId) => edgePositions.get(edgeId))
                .filter((position): position is {
                    chainIndex: number;
                    componentIndex: number;
                    edgeIndex: number;
                    linearIndex: number;
                } => position !== undefined)
                .map((position) => ({
                    chainIndex: position.chainIndex,
                    linearIndex: position.linearIndex,
                }))
                .sort((left, right) => left.chainIndex - right.chainIndex || left.linearIndex - right.linearIndex);
            const spread = buildBoundarySpreadMetrics(orderedEdgePositions);

            return {
                faceId: -(group.shellId * 1000 + group.inlineId),
                primarySize: group.edgeAnchorIds.size,
                collapsedSize: spread.segmentCount >= 3 ? spread.segmentCount : null,
                edgeAnchorCount: group.edgeAnchorIds.size,
                edgeAnchorIds: [...group.edgeAnchorIds].sort((left, right) => left - right),
                coedgeAnchorIds: [...group.coedgeAnchorIds].sort((left, right) => left - right),
                repeatedEdgeIds: [],
                resolvedSurfaceType: null,
                chainCount: spread.chainCount,
                segmentCount: spread.segmentCount,
                maxSegmentLength: spread.maxSegmentLength,
                maxChainSpan: spread.maxChainSpan,
            };
        })
        .filter((hint) => hint.primarySize >= 3);
}

export function parseFaceEdgeHits(buf: Buffer): PsFaceEdgeHit[] {
    const edgeIds = new Set(parseEdgeRecords(buf).map((record) => record.id));
    if (edgeIds.size === 0) return [];

    const edgePositions = buildEdgeChainPositionMap(buf);
    const hits: PsFaceEdgeHit[] = [];

    for (const entity of extractAllEntities(buf)) {
        if (entity.type !== ENTITY_FACE) continue;

        for (let byteOffset = 0; byteOffset + 2 <= entity.data.length; byteOffset += 2) {
            const edgeId = entity.data.readUInt16BE(byteOffset);
            if (!edgeIds.has(edgeId)) continue;

            const position = edgePositions.get(edgeId);
            hits.push({
                faceId: entity.id,
                byteOffset,
                edgeId,
                chainIndex: position?.chainIndex ?? null,
                componentIndex: position?.componentIndex ?? null,
                edgeIndex: position?.edgeIndex ?? null,
                linearIndex: position?.linearIndex ?? null,
            });
        }
    }

    return hits;
}

export function buildRawFaceBoundaryHints(buf: Buffer, extractedSurfaces: PsSurface[] = []): PsRawFaceBoundaryHint[] {
    const hits = parseFaceEdgeHits(buf);
    if (hits.length === 0) return [];

    const faceRecords = new Map(parseFaceRecords(buf).map((face) => [face.id, face]));
    const directSurfaceTypes = new Map(extractedSurfaces.map((surface) => [surface.id, surface.surfaceType]));
    const hitsByFace = new Map<number, PsFaceEdgeHit[]>();

    for (const hit of hits) {
        const bucket = hitsByFace.get(hit.faceId) ?? [];
        bucket.push(hit);
        hitsByFace.set(hit.faceId, bucket);
    }

    return [...hitsByFace.entries()]
        .map(([faceId, faceHits]) => {
            const faceRecord = faceRecords.get(faceId);
            const primarySize = new Set(faceHits.map((hit) => hit.edgeId)).size;
            const faceHitCounts = new Map<number, number>();
            for (const hit of faceHits) {
                faceHitCounts.set(hit.edgeId, (faceHitCounts.get(hit.edgeId) ?? 0) + 1);
            }

            const positionedHits = faceHits
                .filter((hit) => hit.chainIndex !== null && hit.linearIndex !== null)
                .map((hit) => ({
                    chainIndex: hit.chainIndex as number,
                    linearIndex: hit.linearIndex as number,
                }))
                .sort((left, right) => left.chainIndex - right.chainIndex || left.linearIndex - right.linearIndex);
            const spread = buildBoundarySpreadMetrics(positionedHits);
            const edgeAnchorIds = [faceRecord?.edgeAnchorAId, faceRecord?.edgeAnchorBId]
                .filter((edgeId): edgeId is number => typeof edgeId === 'number' && edgeId > 0);
            const coedgeAnchorIds = [faceRecord?.coedgeAnchorAId, faceRecord?.coedgeAnchorBId]
                .filter((coedgeId): coedgeId is number => typeof coedgeId === 'number' && coedgeId > 0);
            const repeatedEdgeIds = [...faceHitCounts.entries()]
                .filter(([, count]) => count >= 2)
                .map(([edgeId]) => edgeId)
                .sort((left, right) => left - right);

            return {
                faceId,
                primarySize,
                collapsedSize: spread.segmentCount >= 3 ? spread.segmentCount : null,
                edgeAnchorCount: edgeAnchorIds.length,
                edgeAnchorIds,
                coedgeAnchorIds,
                repeatedEdgeIds,
                resolvedSurfaceType: directSurfaceTypes.get(faceRecord?.geometryLikeId ?? -1) ?? null,
                chainCount: spread.chainCount,
                segmentCount: spread.segmentCount,
                maxSegmentLength: spread.maxSegmentLength,
                maxChainSpan: spread.maxChainSpan,
            };
        })
        .filter((hint) => hint.primarySize >= 3)
        .sort((left, right) => right.primarySize - left.primarySize
            || (right.collapsedSize ?? 0) - (left.collapsedSize ?? 0)
            || right.faceId - left.faceId);
}

export function buildPointEdgeChainPositionsByCoord(buf: Buffer): Map<string, PointEdgeChainPosition[]> {
    const pointRecords = parsePointRecords(buf);
    if (pointRecords.length === 0) return new Map();

    const coedgeById = new Map(parseCoedgeRecords(buf).map((record) => [record.id, record]));
    if (coedgeById.size === 0) return new Map();

    const edgeRefBuckets = new Map<number, PsEdgeRecord[]>();
    for (const edge of parseEdgeRecords(buf)) {
        const bucket = edgeRefBuckets.get(edge.firstRefId) ?? [];
        bucket.push(edge);
        edgeRefBuckets.set(edge.firstRefId, bucket);
    }

    const uniqueEdgeByFirstRef = new Map<number, PsEdgeRecord>();
    for (const [firstRefId, bucket] of edgeRefBuckets) {
        if (bucket.length === 1) uniqueEdgeByFirstRef.set(firstRefId, bucket[0]);
    }

    const edgePositions = buildEdgeChainPositionMap(buf);
    const positionsByCoord = new Map<string, PointEdgeChainPosition[]>();

    for (const point of pointRecords) {
        const coedge = coedgeById.get(point.nextCoedgeId);
        if (!coedge) continue;

        const edge = uniqueEdgeByFirstRef.get(coedge.curveLikeId);
        const edgePosition = edge ? edgePositions.get(edge.id) : undefined;

        const key = buildPointCoordKey({
            x: point.position.x * PS_TO_MM,
            y: point.position.y * PS_TO_MM,
            z: point.position.z * PS_TO_MM,
        });
        const bucket = positionsByCoord.get(key) ?? [];
        bucket.push({
            coedgeId: coedge.id,
            edgeId: edge?.id ?? null,
            chainIndex: edgePosition?.chainIndex ?? null,
            linearIndex: edgePosition?.linearIndex ?? null,
        });
        positionsByCoord.set(key, bucket);
    }

    return positionsByCoord;
}

export function buildBoundaryCandidateSpread(
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
    const uniquePositions = new Map<string, PointEdgeChainPosition>();
    const uniqueEdgeIds = new Set<number>();
    const uniqueCoedgeIds = new Set<number>();

    for (const vertexIndex of vertexIndices) {
        const vertex = vertices[vertexIndex];
        if (!vertex) continue;

        const key = buildPointCoordKey(vertex.position);
        const bucket = pointEdgePositionsByCoord.get(key) ?? [];
        for (const position of bucket) {
            uniqueCoedgeIds.add(position.coedgeId);
            if (position.edgeId !== null) uniqueEdgeIds.add(position.edgeId);
            if (position.edgeId !== null && position.chainIndex !== null && position.linearIndex !== null) {
                uniquePositions.set(`${position.edgeId}:${position.chainIndex}:${position.linearIndex}`, position);
            }
        }
    }

    const orderedPositions = [...uniquePositions.values()]
        .sort((left, right) => (left.chainIndex as number) - (right.chainIndex as number)
            || (left.linearIndex as number) - (right.linearIndex as number))
        .map((position) => ({
            chainIndex: position.chainIndex as number,
            linearIndex: position.linearIndex as number,
        }));
    const spread = buildBoundarySpreadMetrics(orderedPositions);

    return {
        mappedEdgeCount: uniqueEdgeIds.size,
        mappedEdgeIds: [...uniqueEdgeIds].sort((left, right) => left - right),
        mappedCoedgeIds: [...uniqueCoedgeIds].sort((left, right) => left - right),
        chainCount: spread.chainCount,
        segmentCount: spread.segmentCount,
        maxSegmentLength: spread.maxSegmentLength,
        maxChainSpan: spread.maxChainSpan,
    };
}

export function parseEdgeComponents(buf: Buffer): PsEdgeComponent[] {
    const edges = parseEdgeRecords(buf);
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

export function parseEdgeComponentChains(buf: Buffer): PsEdgeComponentChain[] {
    const components = parseEdgeComponents(buf);
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
        if (prevCounts.get(component.terminalPrevId) === 1) byPrevId.set(component.terminalPrevId, component);
        if (nextCounts.get(component.terminalNextId) === 1) byNextId.set(component.terminalNextId, component);
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

export function buildEdgeChainPositionMap(buf: Buffer): Map<number, { chainIndex: number; componentIndex: number; edgeIndex: number; linearIndex: number }> {
    const positions = new Map<number, { chainIndex: number; componentIndex: number; edgeIndex: number; linearIndex: number }>();

    parseEdgeComponentChains(buf).forEach((chain, chainIndex) => {
        let linearIndex = 0;
        chain.orderedComponents.forEach((component, componentIndex) => {
            component.orderedEdges.forEach((edge, edgeIndex) => {
                positions.set(edge.id, { chainIndex, componentIndex, edgeIndex, linearIndex });
                linearIndex++;
            });
        });
    });

    return positions;
}

export function parseCompactGeometryRecords(buf: Buffer): PsCompactGeometryRecord[] {
    return parseCompactGeometryFamilyRecords(buf, new Set([ENTITY_SURFACE, ENTITY_BSPLINE]));
}

export function parseCompactGeometryLikeRecords(buf: Buffer): PsCompactGeometryLikeRecord[] {
    return parseCompactGeometryFamilyRecords(
        buf,
        new Set([ENTITY_SURFACE, ENTITY_BSPLINE, ENTITY_ATTRIB, ENTITY_GEOM_AUX, ENTITY_GEOM_CHAIN]),
    );
}

export function parsePackedGeometryLikeRecords(buf: Buffer): PsPackedGeometryLikeRecord[] {
    const records: PsPackedGeometryLikeRecord[] = [];

    for (let offset = 0; offset + 20 <= buf.length; offset++) {
        if (buf[offset] !== 0x00 || buf[offset + 2] !== 0xff) continue;
        const type = buf[offset + 1];
        if (type !== ENTITY_SURFACE && type !== ENTITY_BSPLINE && type !== ENTITY_ATTRIB) continue;
        if (buf[offset + 5] !== 0x00 || buf[offset + 6] !== 0x00) continue;

        const id = buf.readUInt16BE(offset + 3);
        if (id === 0 || id > 10000) continue;

        const flags = buf.readUInt16BE(offset + 7);
        const trailer = buf.readUInt16BE(offset + 9);
        if (trailer === 0 || trailer > 0x0400) continue;

        const markerByte = buf[offset + 19];
        if (markerByte !== 0x2b && markerByte !== 0x2d) continue;

        records.push({
            offset,
            type,
            id,
            flags,
            trailer,
            refIds: [
                buf.readUInt16BE(offset + 11),
                buf.readUInt16BE(offset + 13),
                buf.readUInt16BE(offset + 15),
                buf.readUInt16BE(offset + 17),
            ],
            markerByte,
        });
    }

    return records;
}

export function parseGeometryLikeAliasRecords(buf: Buffer): PsGeometryLikeAliasRecord[] {
    return buildGeometryLikeAliases(parseDirectGeometryLikeRecords(buf));
}

export function parseAllGeometryLikeRecords(buf: Buffer): Array<PsDirectGeometryLikeRecord | PsGeometryLikeAliasRecord> {
    const direct = parseDirectGeometryLikeRecords(buf);
    const records = new Map<number, PsDirectGeometryLikeRecord | PsGeometryLikeAliasRecord>();

    for (const record of direct) records.set(record.id, record);
    for (const record of buildGeometryLikeAliases(direct)) {
        if (!records.has(record.id)) records.set(record.id, record);
    }

    return [...records.values()];
}

export function parseGapPointRecords(buf: Buffer): PsGapPointRecord[] {
    const records: PsGapPointRecord[] = [];
    for (const sentinelOffset of findEightByteSentinelOffsets(buf)) {
        const record = parseGapPointRecordAfterSentinel(buf, sentinelOffset);
        if (record) records.push(record);
    }
    return records;
}

export function parsePointRecords(buf: Buffer): PsPointRecord[] {
    const records: PsPointRecord[] = [];
    const seen = new Set<number>();
    const sentinelPositions: number[] = [];
    let index = 0;

    while ((index = buf.indexOf(SENTINEL, index)) >= 0) {
        sentinelPositions.push(index);
        index += SENTINEL.length;
    }

    const packedEnd = sentinelPositions.length > 0 ? sentinelPositions[0] : buf.length;
    extractPackedPointRecords(buf, 0, packedEnd, records, seen);

    for (let sentinelIndex = 0; sentinelIndex < sentinelPositions.length; sentinelIndex++) {
        const blockStart = sentinelPositions[sentinelIndex] + SENTINEL.length;
        const blockEnd = sentinelIndex + 1 < sentinelPositions.length
            ? sentinelPositions[sentinelIndex + 1]
            : buf.length;

        for (let offset = blockStart; offset + POINT_COORD_OFFSET + 24 <= blockEnd; offset++) {
            const record = parseSentinelPointRecordAtOffset(buf, offset);
            if (!record || seen.has(record.id)) continue;
            records.push(record);
            seen.add(record.id);
            offset += POINT_COORD_OFFSET + 23;
        }
    }

    return records;
}

export function extractCoordinates(buf: Buffer, maxPoints = 2000): PsPoint[] {
    const structural = extractStructuralPoints(buf, maxPoints);
    if (structural && structural.length > 0) return structural;

    const fallbackLimit = Math.min(maxPoints, 500);
    const markers: number[] = [];
    for (let index = 0; index < buf.length - 1; index++) {
        if (buf[index] === RECORD_PREFIX && (buf[index + 1] === RECORD_MARKER_P || buf[index + 1] === RECORD_MARKER_Q)) {
            markers.push(index);
        }
    }

    if (markers.length > 0) return extractFromMarkers(buf, markers, fallbackLimit);
    return extractFromFullScan(buf, fallbackLimit);
}

export function getEntityCensus(buf: Buffer): PsEntityCensus {
    const census: PsEntityCensus = {
        sentinels: 0,
        points: 0,
        coedges: 0,
        edges: 0,
        faces: 0,
        surfaces: 0,
        shells: 0,
        loops: 0,
        other: 0,
    };

    let index = 0;
    while ((index = buf.indexOf(SENTINEL, index)) >= 0) {
        census.sentinels++;
        index += SENTINEL.length;
    }
    if (census.sentinels === 0) return census;

    for (let offset = 0; offset < buf.length - 3; offset++) {
        if (buf[offset] !== 0x00 || buf[offset + 1] !== 0x03 || buf[offset + 2] !== 0x00) continue;
        const type = buf[offset + 3];
        switch (type) {
            case ENTITY_POINT: census.points++; break;
            case ENTITY_COEDGE: census.coedges++; break;
            case ENTITY_EDGE: census.edges++; break;
            case ENTITY_FACE: census.faces++; break;
            case ENTITY_SURFACE: census.surfaces++; break;
            case ENTITY_BSPLINE: census.surfaces++; break;
            case ENTITY_SHELL: census.shells++; break;
            case ENTITY_LOOP: census.loops++; break;
            default:
                if (type >= 0x0f && type <= 0x3f) census.other++;
        }
    }

    return census;
}

export function extractAllEntities(buf: Buffer): RawEntity[] {
    const entities: RawEntity[] = [];
    const sentinelPositions: number[] = [];
    let index = 0;

    while ((index = buf.indexOf(SENTINEL, index)) >= 0) {
        sentinelPositions.push(index);
        index += SENTINEL.length;
    }
    if (sentinelPositions.length === 0) return entities;

    for (let sentinelIndex = 0; sentinelIndex < sentinelPositions.length; sentinelIndex++) {
        const blockStart = sentinelPositions[sentinelIndex] + SENTINEL.length;
        const blockEnd = sentinelIndex + 1 < sentinelPositions.length
            ? sentinelPositions[sentinelIndex + 1]
            : buf.length;
        const block = buf.subarray(blockStart, blockEnd);
        if (block.length < 8) continue;

        const subRecords: Array<{ data: Buffer; offset: number }> = [];
        let searchStart = 0;
        while (true) {
            const separatorIndex = block.indexOf(SUB_RECORD_SEP, searchStart);
            if (separatorIndex < 0) {
                subRecords.push({ data: block.subarray(searchStart), offset: blockStart + searchStart });
                break;
            }
            subRecords.push({ data: block.subarray(searchStart, separatorIndex), offset: blockStart + searchStart });
            searchStart = separatorIndex + SUB_RECORD_SEP.length;
        }

        for (let recordIndex = 0; recordIndex < subRecords.length; recordIndex++) {
            const { data: record, offset } = subRecords[recordIndex];
            if (recordIndex === 0) {
                if (record.length < 8) continue;
                if (record.readUInt32BE(0) !== 3) continue;
                const type = record[5];
                if (type < 0x0d || type > 0x3f) continue;
                const id = record.readUInt16BE(6);
                entities.push({ type, id, offset, primary: true, data: record.subarray(8) });
            } else {
                if (record.length < 4) continue;
                if (record[0] !== 0x00) continue;
                const type = record[1];
                if (type < 0x0d || type > 0x3f) continue;
                const id = record.readUInt16BE(2);
                entities.push({ type, id, offset, primary: false, data: record.subarray(4) });
            }
        }
    }

    return entities;
}

function forEachShellPayloadSegment(
    buf: Buffer,
    visitor: (entity: RawEntity, segmentIndex: number, words: number[]) => void,
): void {
    for (const entity of extractAllEntities(buf)) {
        if (entity.type !== ENTITY_SHELL || entity.data.length < 4) continue;

        let segmentIndex = 0;
        let currentWords: number[] = [];
        for (let offset = 0; offset + 2 <= entity.data.length; offset += 2) {
            const word = entity.data.readUInt16BE(offset);
            if (word === 1) {
                if (currentWords.length > 0) {
                    visitor(entity, segmentIndex, currentWords);
                    segmentIndex++;
                }
                currentWords = [];
                continue;
            }
            currentWords.push(word);
        }
        if (currentWords.length > 0) visitor(entity, segmentIndex, currentWords);
    }
}

function parseDirectGeometryLikeRecords(buf: Buffer): PsDirectGeometryLikeRecord[] {
    const records = new Map<number, PsDirectGeometryLikeRecord>();
    for (const record of parseCompactGeometryLikeRecords(buf)) records.set(record.id, record);
    for (const record of parsePackedGeometryLikeRecords(buf)) {
        if (!records.has(record.id)) records.set(record.id, record);
    }
    return [...records.values()];
}

function buildGeometryLikeAliases(direct: PsDirectGeometryLikeRecord[]): PsGeometryLikeAliasRecord[] {
    const directIds = new Set(direct.map((record) => record.id));
    const buckets = new Map<number, PsDirectGeometryLikeRecord[]>();

    for (const record of direct) {
        const aliasId = record.refIds[1];
        const bucket = buckets.get(aliasId) ?? [];
        bucket.push(record);
        buckets.set(aliasId, bucket);
    }

    const aliases: PsGeometryLikeAliasRecord[] = [];
    for (const [aliasId, bucket] of buckets) {
        if (bucket.length !== 1 || directIds.has(aliasId)) continue;
        const canonical = bucket[0];
        aliases.push({
            offset: canonical.offset,
            type: canonical.type,
            id: aliasId,
            canonicalId: canonical.id,
            flags: canonical.flags,
            trailer: 'trailer' in canonical ? canonical.trailer : null,
            refIds: canonical.refIds,
            markerByte: canonical.markerByte,
        });
    }

    return aliases;
}

function parseCompactGeometryFamilyRecords(buf: Buffer, allowedTypes: Set<number>): PsCompactGeometryLikeRecord[] {
    const records: PsCompactGeometryRecord[] = [];

    for (let offset = 0; offset + 19 <= buf.length; offset++) {
        const type = buf[offset + 1];
        if (buf[offset] !== 0x00 || !allowedTypes.has(type)) continue;

        const header = parseLinearEntityHeader(buf, offset, buf.length);
        if (!header || header.format !== 'compact') continue;

        const markerByte = buf[offset + 18];
        if (markerByte !== 0x2b && markerByte !== 0x2d) continue;

        records.push({
            offset,
            type,
            id: header.id,
            flags: header.flags,
            refIds: [
                buf.readUInt16BE(offset + 10),
                buf.readUInt16BE(offset + 12),
                buf.readUInt16BE(offset + 14),
                buf.readUInt16BE(offset + 16),
            ],
            markerByte,
        });
        offset += 9;
    }

    return records;
}

function extractStructuralPoints(buf: Buffer, maxPoints: number): PsPoint[] | null {
    const sentinelPositions: number[] = [];
    let index = 0;
    while ((index = buf.indexOf(SENTINEL, index)) >= 0) {
        sentinelPositions.push(index);
        index += SENTINEL.length;
    }
    if (sentinelPositions.length === 0) return null;

    const points: PsPoint[] = [];
    const seen = new Set<string>();
    extractPackedPoints(buf, 0, sentinelPositions[0], maxPoints, points, seen);

    for (let sentinelIndex = 0; sentinelIndex < sentinelPositions.length && points.length < maxPoints; sentinelIndex++) {
        const blockStart = sentinelPositions[sentinelIndex] + SENTINEL.length;
        const blockEnd = sentinelIndex + 1 < sentinelPositions.length
            ? sentinelPositions[sentinelIndex + 1]
            : buf.length;

        for (let offset = blockStart; offset + POINT_COORD_OFFSET + 24 <= blockEnd; offset++) {
            if (!isSentinelPointRecord(buf, offset)) continue;
            if (!pushPointAtOffset(buf, offset + POINT_COORD_OFFSET, points, seen)) continue;
            if (points.length >= maxPoints) return points;
            offset += POINT_COORD_OFFSET + 23;
        }
    }

    return points.length > 0 ? points : null;
}

function extractPackedPoints(
    buf: Buffer,
    start: number,
    end: number,
    maxPoints: number,
    points: PsPoint[],
    seen: Set<string>,
): void {
    for (let offset = start; offset + POINT_COORD_OFFSET + 24 <= end && points.length < maxPoints; offset++) {
        if (!isPackedPointRecord(buf, offset)) continue;
        if (!pushPointAtOffset(buf, offset + POINT_COORD_OFFSET, points, seen)) continue;
        offset += POINT_COORD_OFFSET + 23;
    }
}

function extractPackedPointRecords(
    buf: Buffer,
    start: number,
    end: number,
    records: PsPointRecord[],
    seen: Set<number>,
): void {
    for (let offset = start; offset + POINT_COORD_OFFSET + 24 <= end; offset++) {
        const record = parsePackedPointRecordAtOffset(buf, offset);
        if (!record || seen.has(record.id)) continue;
        records.push(record);
        seen.add(record.id);
        offset += POINT_COORD_OFFSET + 23;
    }
}

function isSentinelPointRecord(buf: Buffer, offset: number): boolean {
    if (offset + POINT_COORD_OFFSET + 24 > buf.length) return false;
    if (buf[offset] !== 0x00 || buf[offset + 1] !== ENTITY_POINT) return false;
    if (buf[offset + 4] !== 0x00 || buf[offset + 5] !== 0x00) return false;
    return buf[offset + 8] === 0x00 && buf[offset + 9] === 0x01;
}

function isPackedPointRecord(buf: Buffer, offset: number): boolean {
    if (offset + POINT_COORD_OFFSET + 24 > buf.length) return false;
    if (buf[offset] !== 0x00 || buf[offset + 1] !== ENTITY_POINT) return false;
    if (buf[offset + 2] !== 0xff) return false;
    if (buf[offset + 5] !== 0x00 || buf[offset + 6] !== 0x00) return false;

    for (let refOffset = offset + 8; refOffset < offset + POINT_COORD_OFFSET; refOffset += 2) {
        if (buf.readUInt16BE(refOffset) > 60000) return false;
    }

    return tryReadTriplet(buf, offset + POINT_COORD_OFFSET) !== null;
}

function parseSentinelPointRecordAtOffset(buf: Buffer, offset: number): PsPointRecord | null {
    if (!isSentinelPointRecord(buf, offset)) return null;
    const position = tryReadTriplet(buf, offset + POINT_COORD_OFFSET);
    if (!position) return null;

    return {
        offset,
        format: 'sentinel',
        id: buf.readUInt16BE(offset + 2),
        flags: buf.readUInt16BE(offset + 6),
        nextCoedgeId: buf.readUInt16BE(offset + 10),
        nextPointId: buf.readUInt16BE(offset + 12),
        prevPointId: buf.readUInt16BE(offset + 14),
        position,
    };
}

function parsePackedPointRecordAtOffset(buf: Buffer, offset: number): PsPointRecord | null {
    if (!isPackedPointRecord(buf, offset)) return null;
    const position = tryReadTriplet(buf, offset + POINT_COORD_OFFSET);
    if (!position) return null;

    return {
        offset,
        format: 'packed',
        id: buf.readUInt16BE(offset + 3),
        flags: buf.readUInt16BE(offset + 7),
        nextCoedgeId: buf.readUInt16BE(offset + 8),
        nextPointId: buf.readUInt16BE(offset + 10),
        prevPointId: buf.readUInt16BE(offset + 12),
        position,
    };
}

function pushPointAtOffset(buf: Buffer, offset: number, points: PsPoint[], seen: Set<string>): boolean {
    const point = tryReadTriplet(buf, offset);
    if (!point) return false;

    const key = `${point.x.toFixed(9)},${point.y.toFixed(9)},${point.z.toFixed(9)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    points.push(point);
    return true;
}

function extractFromMarkers(buf: Buffer, markers: number[], maxPoints: number): PsPoint[] {
    const points: PsPoint[] = [];
    const seen = new Set<string>();

    for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
        const markerOffset = markers[markerIndex];
        const isP = buf[markerOffset + 1] === RECORD_MARKER_P;
        const recordEnd = markerIndex + 1 < markers.length
            ? markers[markerIndex + 1]
            : Math.min(markerOffset + 20000, buf.length);
        const dataStart = markerOffset + (isP ? 5 : 2);

        for (let offset = dataStart; offset + 24 <= recordEnd; offset++) {
            const point = tryReadTriplet(buf, offset);
            if (!point) continue;
            const key = `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push(point);
            if (points.length >= maxPoints) return points;
        }
    }

    return points;
}

export function resolveFullScanStart(buf: Buffer): number {
    let legacyStart = 0x400;
    for (let offset = Math.min(0x1000, buf.length) - 1; offset >= 0x60; offset--) {
        if (buf[offset] === 0x5a) {
            legacyStart = offset + 1;
            break;
        }
    }

    const metadata = parseSchemaMetadata(buf);
    if (metadata
        && metadata.metadataEndOffset >= 0
        && metadata.metadataEndOffset < buf.length
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

function extractFromFullScan(buf: Buffer, maxPoints: number): PsPoint[] {
    const points: PsPoint[] = [];
    const seen = new Set<string>();
    const dataStart = resolveFullScanStart(buf);

    for (let offset = dataStart; offset + 24 <= buf.length; offset++) {
        const point = tryReadTriplet(buf, offset);
        if (!point) continue;
        if (Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)) < 0.001) continue;

        const key = `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(point);
        if (points.length >= maxPoints) return points;
    }

    return points;
}

function parseSchemaFieldDefinitions(buf: Buffer, start: number, end: number): PsSchemaFieldDefinition[] {
    const definitions: PsSchemaFieldDefinition[] = [];

    for (let offset = start; offset < end; offset++) {
        if (!SCHEMA_FIELD_TYPE_BYTES.has(buf[offset])) continue;

        let typeEnd = offset;
        while (typeEnd < end && SCHEMA_FIELD_TYPE_BYTES.has(buf[typeEnd])) typeEnd++;
        const typeLength = typeEnd - offset;
        if (typeLength === 0 || typeLength > 8 || typeEnd >= end) continue;

        const nameLength = buf[typeEnd];
        if (nameLength <= 0 || nameLength > 96) continue;

        const nameStart = typeEnd + 1;
        const nameEnd = nameStart + nameLength;
        if (nameEnd > end) continue;

        const name = buf.subarray(nameStart, nameEnd).toString('ascii');
        if (!/^[\x20-\x7e]+$/.test(name) || !/[A-Za-z]/.test(name)) continue;

        definitions.push({
            offset,
            endOffset: nameEnd,
            typeCodes: buf.subarray(offset, typeEnd).toString('ascii'),
            name,
        });
        offset = nameEnd - 1;
    }

    return definitions;
}

function parseNamedClassDefinitions(buf: Buffer, start: number, end: number): PsNamedClassDefinition[] {
    const namedClasses: PsNamedClassDefinition[] = [];

    for (let offset = start; offset + 12 <= end; offset++) {
        if (!isNamedClassChar(buf[offset])) continue;

        let nameEnd = offset;
        while (nameEnd < end && isNamedClassChar(buf[nameEnd])) nameEnd++;
        const nameLength = nameEnd - offset;
        if (nameLength < 3 || nameLength > 80) {
            offset = nameEnd;
            continue;
        }
        if (nameEnd + 11 >= end || buf[nameEnd] !== 0x00) {
            offset = nameEnd;
            continue;
        }

        const classType = NAMED_CLASS_TYPE_BYTES.get(buf[nameEnd + 1]);
        if (!classType) {
            offset = nameEnd;
            continue;
        }

        const name = buf.subarray(offset, nameEnd).toString('ascii');
        if (!/^[A-Za-z0-9_\/-]+$/.test(name)) {
            offset = nameEnd;
            continue;
        }

        namedClasses.push({
            offset,
            endOffset: nameEnd + 12,
            name,
            classType,
            flags: buf[nameEnd + 2],
            extra: buf.readUInt16BE(nameEnd + 3),
            count: buf[nameEnd + 5],
            parentId: buf.readUInt16BE(nameEnd + 6),
            fieldStart: buf.readUInt16BE(nameEnd + 8),
            fieldEnd: buf.readUInt16BE(nameEnd + 10),
        });
        offset = nameEnd + 11;
    }

    return namedClasses;
}

function findLastSchemaTerminator(buf: Buffer, start: number, end: number): number {
    for (let offset = end - 1; offset >= start; offset--) {
        if (buf[offset] === 0x5a) return offset;
    }
    return -1;
}

function findFirstLinearEntityHeader(
    buf: Buffer,
    start: number,
    end: number,
    firstSentinelOffset: number | null,
): PsLinearEntityHeader | null {
    for (let offset = start; offset + 10 <= end; offset++) {
        const header = parseLinearEntityHeader(buf, offset, end);
        if (header) return header;
    }

    if (firstSentinelOffset !== null) {
        const packedOffset = firstSentinelOffset - 11;
        if (packedOffset >= start) {
            const header = parseLinearEntityHeader(buf, packedOffset, firstSentinelOffset);
            if (header) return header;
        }

        const compactOffset = firstSentinelOffset - 10;
        if (compactOffset >= start) {
            const header = parseLinearEntityHeader(buf, compactOffset, firstSentinelOffset);
            if (header) return header;
        }
    }

    return null;
}

function findEightByteSentinelOffsets(buf: Buffer): number[] {
    const offsets: number[] = [];
    let searchOffset = 0;
    while ((searchOffset = buf.indexOf(SENTINEL_8, searchOffset)) >= 0) {
        offsets.push(searchOffset);
        searchOffset += SENTINEL_8.length;
    }
    return offsets;
}

function parseLinearEntityHeader(buf: Buffer, offset: number, end: number): PsLinearEntityHeader | null {
    if (isCompactLinearRecord(buf, offset, end)) {
        return {
            offset,
            format: 'compact',
            type: buf[offset + 1],
            id: buf.readUInt16BE(offset + 2),
            flags: buf.readUInt16BE(offset + 6),
            trailer: null,
        };
    }

    if (isPackedLinearRecord(buf, offset, end)) {
        return {
            offset,
            format: 'packed',
            type: buf[offset + 1],
            id: buf.readUInt16BE(offset + 3),
            flags: buf.readUInt16BE(offset + 7),
            trailer: buf.readUInt16BE(offset + 9),
        };
    }

    return null;
}

function readPackedPostSentinelRefs(buf: Buffer, sentinelOffset: number): number[] {
    const refs: number[] = [];
    const refsStart = sentinelOffset + SENTINEL_8.length;
    const refsEnd = Math.min(buf.length, refsStart + 12);

    for (let offset = refsStart; offset + 2 <= refsEnd; offset += 2) {
        const ref = buf.readUInt16BE(offset);
        if (ref > 10000) return [];
        refs.push(ref);
    }

    return refs;
}

function parseGapPointRecordAfterSentinel(buf: Buffer, sentinelOffset: number): PsGapPointRecord | null {
    const separatorOffset = sentinelOffset + SENTINEL_8.length;
    const headerOffset = separatorOffset + 2;
    const recordEnd = headerOffset + 40;
    if (recordEnd > buf.length) return null;
    if (buf.readUInt16BE(separatorOffset) !== 0x0003) return null;

    const header = parseLinearEntityHeader(buf, headerOffset, headerOffset + 10);
    if (!header || header.format !== 'compact' || header.type !== ENTITY_POINT) return null;

    const x = buf.readDoubleBE(headerOffset + 18);
    const y = buf.readDoubleBE(headerOffset + 26);
    const z = buf.readDoubleBE(headerOffset + 34);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;

    return {
        sentinelOffset,
        separatorOffset,
        id: header.id,
        flags: header.flags,
        nextCoedgeId: buf.readUInt16BE(headerOffset + 10),
        nextPointId: buf.readUInt16BE(headerOffset + 12),
        prevPointId: buf.readUInt16BE(headerOffset + 14),
        position: { x, y, z },
    };
}

function isCompactLinearRecord(buf: Buffer, offset: number, end: number): boolean {
    if (offset + 10 > end) return false;
    if (buf[offset] !== 0x00) return false;
    const type = buf[offset + 1];
    if (type < 0x0f || type > 0x90) return false;
    const id = buf.readUInt16BE(offset + 2);
    if (id === 0 || id > 10000) return false;
    if (buf[offset + 4] !== 0x00 || buf[offset + 5] !== 0x00) return false;
    return buf[offset + 8] === 0x00 && buf[offset + 9] === 0x01;
}

function isPackedLinearRecord(buf: Buffer, offset: number, end: number): boolean {
    if (offset + 11 > end) return false;
    if (buf[offset] !== 0x00 || buf[offset + 2] !== 0xff) return false;
    const type = buf[offset + 1];
    if (type < 0x0f || type > 0x90) return false;
    const id = buf.readUInt16BE(offset + 3);
    if (id === 0 || id > 10000) return false;
    if (buf[offset + 5] !== 0x00 || buf[offset + 6] !== 0x00) return false;
    const trailer = buf.readUInt16BE(offset + 9);
    const hasSmallTrailer = trailer > 0 && trailer <= 0x0400;
    if (!hasSmallTrailer) return false;
    if (offset + 16 > end) return true;

    let smallRefs = 0;
    for (let refOffset = offset + 8; refOffset < offset + 16; refOffset += 2) {
        if (buf.readUInt16BE(refOffset) <= 60000) smallRefs++;
    }
    return smallRefs >= 4 || tryReadTriplet(buf, offset + 16) !== null;
}

function isNamedClassChar(byte: number): boolean {
    return (byte >= 0x30 && byte <= 0x39)
        || (byte >= 0x41 && byte <= 0x5a)
        || (byte >= 0x61 && byte <= 0x7a)
        || byte === 0x2f
        || byte === 0x2d
        || byte === 0x5f;
}

function tryReadTriplet(buf: Buffer, offset: number): PsPoint | null {
    if (offset + 24 > buf.length) return null;

    const x = buf.readDoubleBE(offset);
    const y = buf.readDoubleBE(offset + 8);
    const z = buf.readDoubleBE(offset + 16);

    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) return null;
    if (x === 0 && y === 0 && z === 0) return null;
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-15) return null;

    return { x, y, z };
}
