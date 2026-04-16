import type { PsPoint, PsVertex } from '../step/ParasolidToStepMapper.js';

export interface ParasolidBoundarySpreadMetrics {
    chainCount: number;
    segmentCount: number;
    maxSegmentLength: number;
    maxChainSpan: number | null;
}

export interface Parasolid2DPoint {
    u: number;
    v: number;
    idx: number;
}

export function buildBoundaryBudgetKey(surfaceType: string, surfaceId: number, variant = 0): string {
    return `${surfaceType}:${surfaceId}:${variant}`;
}

export function buildPointCoordKey(point: PsPoint): string {
    return `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;
}

export function buildBoundarySpreadMetrics(
    positionedHits: Array<{ chainIndex: number; linearIndex: number }>,
): ParasolidBoundarySpreadMetrics {
    const chainRanges = new Map<number, { min: number; max: number }>();
    let segmentCount = 0;
    let previous: { chainIndex: number; linearIndex: number } | null = null;
    let maxSegmentLength = 0;
    let currentSegmentLength = 0;

    for (const point of positionedHits) {
        const range = chainRanges.get(point.chainIndex) ?? { min: point.linearIndex, max: point.linearIndex };
        range.min = Math.min(range.min, point.linearIndex);
        range.max = Math.max(range.max, point.linearIndex);
        chainRanges.set(point.chainIndex, range);

        if (!previous || point.chainIndex !== previous.chainIndex || point.linearIndex - previous.linearIndex > 1) {
            segmentCount++;
            currentSegmentLength = 1;
        } else {
            currentSegmentLength++;
        }
        if (currentSegmentLength > maxSegmentLength) maxSegmentLength = currentSegmentLength;
        previous = point;
    }

    let maxChainSpan: number | null = null;
    for (const range of chainRanges.values()) {
        const span = range.max - range.min + 1;
        if (maxChainSpan === null || span > maxChainSpan) maxChainSpan = span;
    }

    return {
        chainCount: chainRanges.size,
        segmentCount,
        maxSegmentLength,
        maxChainSpan,
    };
}

export function filterOutlierVertices(vertices: PsVertex[]): PsVertex[] {
    if (vertices.length < 20) return vertices;

    const coords = [
        vertices.map((vertex) => vertex.position.x),
        vertices.map((vertex) => vertex.position.y),
        vertices.map((vertex) => vertex.position.z),
    ];

    const bounds: Array<{ lo: number; hi: number }> = coords.map((axisValues) => {
        const sorted = axisValues.slice().sort((left, right) => left - right);
        const q1 = sorted[Math.floor(sorted.length * 0.25)];
        const q3 = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1;
        return { lo: q1 - 3 * iqr, hi: q3 + 3 * iqr };
    });

    const filtered = vertices.filter((vertex) =>
        vertex.position.x >= bounds[0].lo && vertex.position.x <= bounds[0].hi &&
        vertex.position.y >= bounds[1].lo && vertex.position.y <= bounds[1].hi &&
        vertex.position.z >= bounds[2].lo && vertex.position.z <= bounds[2].hi,
    );

    return filtered.length >= 3 ? filtered : vertices;
}

export function computeEigenvalueRatio(coplanarVertices: PsPoint[], normal: PsPoint): number {
    if (coplanarVertices.length < 3) return Infinity;

    const { uAxis, vAxis } = planeBasis(normal);
    const points = coplanarVertices.map((vertex) => ({
        u: vertex.x * uAxis.x + vertex.y * uAxis.y + vertex.z * uAxis.z,
        v: vertex.x * vAxis.x + vertex.y * vAxis.y + vertex.z * vAxis.z,
    }));

    let cu = 0;
    let cv = 0;
    for (const point of points) {
        cu += point.u;
        cv += point.v;
    }
    cu /= points.length;
    cv /= points.length;

    let cov00 = 0;
    let cov01 = 0;
    let cov11 = 0;
    for (const point of points) {
        const du = point.u - cu;
        const dv = point.v - cv;
        cov00 += du * du;
        cov01 += du * dv;
        cov11 += dv * dv;
    }
    cov00 /= points.length;
    cov01 /= points.length;
    cov11 /= points.length;

    const trace = cov00 + cov11;
    const det = cov00 * cov11 - cov01 * cov01;
    const disc = trace * trace - 4 * det;
    if (disc < 0) return 1;

    const sqrtDisc = Math.sqrt(disc);
    const lambda1 = (trace + sqrtDisc) / 2;
    const lambda2 = (trace - sqrtDisc) / 2;
    if (lambda2 < 1e-10) return Infinity;

    return lambda1 / lambda2;
}

export function convexHull2D(pts: Parasolid2DPoint[]): Parasolid2DPoint[] {
    if (pts.length <= 2) return [...pts];

    const sorted = pts.slice().sort((left, right) => left.u - right.u || left.v - right.v);
    const unique: Parasolid2DPoint[] = [sorted[0]];
    for (let index = 1; index < sorted.length; index++) {
        const previous = unique[unique.length - 1];
        if (Math.abs(sorted[index].u - previous.u) > 1e-6 || Math.abs(sorted[index].v - previous.v) > 1e-6) {
            unique.push(sorted[index]);
        }
    }
    if (unique.length <= 2) return unique;

    const cross = (origin: Parasolid2DPoint, left: Parasolid2DPoint, right: Parasolid2DPoint) =>
        (left.u - origin.u) * (right.v - origin.v) - (left.v - origin.v) * (right.u - origin.u);

    const lower: Parasolid2DPoint[] = [];
    for (const point of unique) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop();
        }
        lower.push(point);
    }

    const upper: Parasolid2DPoint[] = [];
    for (let index = unique.length - 1; index >= 0; index--) {
        const point = unique[index];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
            upper.pop();
        }
        upper.push(point);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

export function planeBasis(normal: PsPoint): { uAxis: PsPoint; vAxis: PsPoint } {
    const arbitrary: PsPoint = Math.abs(normal.z) < 0.9
        ? { x: 0, y: 0, z: 1 }
        : { x: 1, y: 0, z: 0 };

    let ux = normal.y * arbitrary.z - normal.z * arbitrary.y;
    let uy = normal.z * arbitrary.x - normal.x * arbitrary.z;
    let uz = normal.x * arbitrary.y - normal.y * arbitrary.x;
    const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;

    const vx = normal.y * uz - normal.z * uy;
    const vy = normal.z * ux - normal.x * uz;
    const vz = normal.x * uy - normal.y * ux;
    return { uAxis: { x: ux, y: uy, z: uz }, vAxis: { x: vx, y: vy, z: vz } };
}

export function clusterPoints2D(pts: Parasolid2DPoint[], threshold: number): Parasolid2DPoint[][] {
    const assigned = new Int32Array(pts.length).fill(-1);
    let nextCluster = 0;
    const thresholdSq = threshold * threshold;

    for (let index = 0; index < pts.length; index++) {
        if (assigned[index] >= 0) continue;

        const cluster = nextCluster++;
        const queue = [index];
        assigned[index] = cluster;
        while (queue.length > 0) {
            const currentIndex = queue.shift() as number;
            const currentU = pts[currentIndex].u;
            const currentV = pts[currentIndex].v;
            for (let candidateIndex = 0; candidateIndex < pts.length; candidateIndex++) {
                if (assigned[candidateIndex] >= 0) continue;
                const du = currentU - pts[candidateIndex].u;
                const dv = currentV - pts[candidateIndex].v;
                if (du * du + dv * dv <= thresholdSq) {
                    assigned[candidateIndex] = cluster;
                    queue.push(candidateIndex);
                }
            }
        }
    }

    const clusters: Parasolid2DPoint[][] = [];
    for (let cluster = 0; cluster < nextCluster; cluster++) {
        clusters.push(pts.filter((_, index) => assigned[index] === cluster));
    }
    return clusters;
}

export function isPointInConvexHull(hull: Array<{ u: number; v: number }>, pu: number, pv: number): boolean {
    for (let index = 0; index < hull.length; index++) {
        const start = hull[index];
        const end = hull[(index + 1) % hull.length];
        const cross = (end.u - start.u) * (pv - start.v) - (end.v - start.v) * (pu - start.u);
        if (cross < -1e-6) return false;
    }
    return true;
}

export function isPointInPolygon(poly: Array<{ u: number; v: number }>, pu: number, pv: number): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const ui = poly[i].u;
        const vi = poly[i].v;
        const uj = poly[j].u;
        const vj = poly[j].v;
        const intersects = ((vi > pv) !== (vj > pv))
            && (pu < ((uj - ui) * (pv - vi)) / ((vj - vi) || 1e-12) + ui);
        if (intersects) inside = !inside;
    }
    return inside;
}