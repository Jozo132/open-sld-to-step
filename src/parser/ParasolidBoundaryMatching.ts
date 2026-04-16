import type {
    BoundaryBudgetCandidate,
    BoundaryBudgetMatchOption,
    PsRawFaceBoundaryHint,
} from './ParasolidParserTypes.js';

export function computeBoundarySpreadPenalty(
    hint: PsRawFaceBoundaryHint,
    candidate: BoundaryBudgetCandidate,
): number {
    if (candidate.mappedEdgeCount < 3) return 0;

    let penalty = 0;
    penalty += Math.abs(candidate.chainCount - hint.chainCount) * 30;
    penalty += Math.abs(candidate.segmentCount - hint.segmentCount) * 8;
    penalty += Math.abs(candidate.maxSegmentLength - hint.maxSegmentLength) * 3;

    if (hint.maxChainSpan !== null && candidate.maxChainSpan !== null) {
        penalty += Math.min(Math.round(Math.abs(candidate.maxChainSpan - hint.maxChainSpan) / 25), 40);
    }

    return penalty;
}

export function computeBoundaryAnchorPenalty(
    hint: PsRawFaceBoundaryHint,
    candidate: BoundaryBudgetCandidate,
): number {
    if (hint.edgeAnchorIds.length === 0) return 0;
    if (candidate.mappedEdgeIds.length === 0) return hint.edgeAnchorIds.length * 30;

    const mappedEdgeIds = new Set(candidate.mappedEdgeIds);
    let matchedAnchors = 0;
    for (const edgeAnchorId of hint.edgeAnchorIds) {
        if (mappedEdgeIds.has(edgeAnchorId)) matchedAnchors++;
    }

    const missingAnchors = hint.edgeAnchorIds.length - matchedAnchors;
    if (missingAnchors === 0) return 0;

    const perMissingPenalty = candidate.mappedEdgeIds.length >= hint.edgeAnchorIds.length ? 45 : 15;
    let penalty = missingAnchors * perMissingPenalty;
    if (candidate.mappedEdgeIds.length >= hint.edgeAnchorIds.length && matchedAnchors === 0) {
        penalty += 25;
    }

    return penalty;
}

export function computeBoundaryCoedgePenalty(
    hint: PsRawFaceBoundaryHint,
    candidate: BoundaryBudgetCandidate,
): number {
    if (hint.coedgeAnchorIds.length === 0 || candidate.mappedCoedgeIds.length === 0) return 0;

    const mappedCoedgeIds = new Set(candidate.mappedCoedgeIds);
    let matchedAnchors = 0;
    for (const coedgeAnchorId of hint.coedgeAnchorIds) {
        if (mappedCoedgeIds.has(coedgeAnchorId)) matchedAnchors++;
    }

    const missingAnchors = hint.coedgeAnchorIds.length - matchedAnchors;
    if (missingAnchors === 0) return 0;

    const perMissingPenalty = candidate.mappedCoedgeIds.length >= hint.coedgeAnchorIds.length ? 18 : 6;
    let penalty = missingAnchors * perMissingPenalty;
    if (candidate.mappedCoedgeIds.length >= hint.coedgeAnchorIds.length && matchedAnchors === 0) {
        penalty += 10;
    }

    return penalty;
}

export function computeBoundaryCoveragePenalty(
    hint: PsRawFaceBoundaryHint,
    candidate: BoundaryBudgetCandidate,
): number {
    if (hint.edgeAnchorIds.length === 0 || candidate.mappedEdgeCount > 0) return 0;

    const mappedCoedgeIds = new Set(candidate.mappedCoedgeIds);
    const coedgeMatches = hint.coedgeAnchorIds.filter((coedgeId) => mappedCoedgeIds.has(coedgeId)).length;
    return coedgeMatches > 0 ? 20 : 60;
}

export function computeBoundaryRepeatedHitPenalty(
    hint: PsRawFaceBoundaryHint,
    candidate: BoundaryBudgetCandidate,
): number {
    if (hint.repeatedEdgeIds.length === 0 || candidate.mappedEdgeIds.length === 0) return 0;

    const uniqueEdgeAnchors = new Set(hint.edgeAnchorIds);
    if (uniqueEdgeAnchors.size === hint.edgeAnchorIds.length) return 0;

    const repeatedNonAnchorIds = hint.repeatedEdgeIds.filter((edgeId) => !uniqueEdgeAnchors.has(edgeId));
    if (repeatedNonAnchorIds.length === 0) return 0;

    const mappedEdgeIds = new Set(candidate.mappedEdgeIds);
    for (const edgeId of repeatedNonAnchorIds) {
        if (mappedEdgeIds.has(edgeId)) return 0;
    }

    return 8;
}

export function countBoundaryAnchorMatches(
    hint: PsRawFaceBoundaryHint,
    candidate: BoundaryBudgetCandidate,
): number {
    if (hint.edgeAnchorIds.length === 0 || candidate.mappedEdgeIds.length === 0) return 0;
    const mappedEdgeIds = new Set(candidate.mappedEdgeIds);
    let matches = 0;
    for (const edgeAnchorId of hint.edgeAnchorIds) {
        if (mappedEdgeIds.has(edgeAnchorId)) matches++;
    }
    return matches;
}

export function countBoundaryCoedgeMatches(
    hint: PsRawFaceBoundaryHint,
    candidate: BoundaryBudgetCandidate,
): number {
    if (hint.coedgeAnchorIds.length === 0 || candidate.mappedCoedgeIds.length === 0) return 0;
    const mappedCoedgeIds = new Set(candidate.mappedCoedgeIds);
    let matches = 0;
    for (const coedgeAnchorId of hint.coedgeAnchorIds) {
        if (mappedCoedgeIds.has(coedgeAnchorId)) matches++;
    }
    return matches;
}

export function scoreRawFaceBoundaryCandidate(
    hint: PsRawFaceBoundaryHint,
    candidate: BoundaryBudgetCandidate,
): BoundaryBudgetMatchOption | null {
    if (hint.resolvedSurfaceType && candidate.surfaceType !== hint.resolvedSurfaceType) {
        return null;
    }

    const totalDelta = hint.collapsedSize !== null
        ? Math.abs(candidate.totalSize - hint.collapsedSize)
        : null;

    const simpleAnchoredPlanePenalty = hint.edgeAnchorCount >= 2
        && hint.primarySize <= 8
        && hint.collapsedSize !== null
        && hint.collapsedSize >= hint.primarySize - 1
        && candidate.surfaceType === 'plane'
        && candidate.totalSize > candidate.outerSize
        ? 15 + (candidate.totalSize - candidate.outerSize) * 5
        : 0;
    const anchorlessNonPlanePenalty = hint.edgeAnchorCount === 0 && candidate.surfaceType !== 'plane'
        ? 25
        : 0;
    const anchorPenalty = computeBoundaryAnchorPenalty(hint, candidate);
    const coedgePenalty = computeBoundaryCoedgePenalty(hint, candidate);
    const coveragePenalty = computeBoundaryCoveragePenalty(hint, candidate);
    const repeatedHitPenalty = computeBoundaryRepeatedHitPenalty(hint, candidate);
    const spreadPenalty = computeBoundarySpreadPenalty(hint, candidate);
    const anchorMatches = countBoundaryAnchorMatches(hint, candidate);

    if (candidate.outerSize === hint.primarySize) {
        return {
            score: (totalDelta ?? 0) + simpleAnchoredPlanePenalty + anchorlessNonPlanePenalty + anchorPenalty + coedgePenalty + coveragePenalty + repeatedHitPenalty + spreadPenalty,
            outerSize: hint.primarySize,
            totalSize: candidate.surfaceType === 'plane' && totalDelta !== null && totalDelta <= 1
                ? hint.collapsedSize ?? undefined
                : undefined,
        };
    }

    const outerDelta = candidate.outerSize - hint.primarySize;
    if (
        outerDelta === 1
        && hint.primarySize === 3
        && hint.edgeAnchorCount >= 2
        && anchorMatches > 0
    ) {
        return {
            score: 80 + (totalDelta ?? 0) + simpleAnchoredPlanePenalty + anchorlessNonPlanePenalty + anchorPenalty + coedgePenalty + coveragePenalty + repeatedHitPenalty + spreadPenalty,
            outerSize: hint.primarySize,
            totalSize: candidate.surfaceType === 'plane' && totalDelta !== null && totalDelta <= 1
                ? hint.collapsedSize ?? undefined
                : undefined,
        };
    }

    if (outerDelta >= 2 && outerDelta <= 3) {
        if (hint.primarySize <= 3 && !hint.resolvedSurfaceType) return null;
        return {
            score: 100 + outerDelta * 10 + (totalDelta ?? 0) + simpleAnchoredPlanePenalty + anchorlessNonPlanePenalty + anchorPenalty + coedgePenalty + coveragePenalty + repeatedHitPenalty + spreadPenalty,
            outerSize: hint.primarySize,
            totalSize: candidate.surfaceType === 'plane' && totalDelta !== null && totalDelta <= 1
                ? hint.collapsedSize ?? undefined
                : undefined,
        };
    }

    if (candidate.surfaceType === 'plane' && hint.collapsedSize !== null && totalDelta !== null && totalDelta <= 1) {
        return {
            score: 200 + totalDelta * 10 + Math.min(Math.abs(candidate.outerSize - hint.primarySize), 50) + simpleAnchoredPlanePenalty + anchorPenalty + coedgePenalty + coveragePenalty + repeatedHitPenalty,
            totalSize: hint.collapsedSize,
        };
    }

    return null;
}