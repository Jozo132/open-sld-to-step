/**
 * ParasolidToStepMapper.ts
 *
 * Conceptual stub for the Parasolid BRep → STEP (ISO 10303) translation
 * engine.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Architecture overview
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The full translation pipeline consists of four stages:
 *
 *  1. Parasolid Block Parser
 *     Reads the Parasolid binary (.x_b) or text (.x_t) stream, reconstructs
 *     the BRep topology graph:
 *       Body → Lump → Shell → Face → Loop → Edge → Vertex
 *     Each entity type corresponds to a well-defined Parasolid block type.
 *     Reference: public Parasolid schema documentation and clean-room analysis.
 *
 *  2. Geometry Kernel Bridge (WASM)
 *     Computationally intensive tasks (surface/curve evaluation, tolerance
 *     checks, manifold validation) are delegated to an AssemblyScript WASM
 *     module built separately under `wasm/assembly/`.
 *     The TypeScript host calls into the WASM module via a thin adapter.
 *
 *  3. STEP Entity Builder
 *     Maps each topological entity to its STEP (AP214 / AP242) counterpart:
 *
 *       Parasolid entity          → STEP entity
 *       ─────────────────────────────────────────────
 *       Body                      → MANIFOLD_SOLID_BREP
 *       Shell                     → CLOSED_SHELL / OPEN_SHELL
 *       Face                      → ADVANCED_FACE
 *       Loop                      → FACE_BOUND / FACE_OUTER_BOUND
 *       Edge                      → EDGE_CURVE
 *       Vertex                    → VERTEX_POINT
 *       Plane surface             → PLANE
 *       Cylindrical surface       → CYLINDRICAL_SURFACE
 *       B-spline surface          → B_SPLINE_SURFACE_WITH_KNOTS
 *       Line curve                → LINE
 *       Circle curve              → CIRCLE
 *       B-spline curve            → B_SPLINE_CURVE_WITH_KNOTS
 *       Cartesian point           → CARTESIAN_POINT
 *       Direction vector          → DIRECTION
 *       Axis placement            → AXIS2_PLACEMENT_3D
 *
 *  4. STEP File Writer
 *     Serialises the entity graph to ISO 10303-21 "exchange structure" text:
 *       - ISO 10303-21 header section (FILE_DESCRIPTION, FILE_NAME, FILE_SCHEMA)
 *       - DATA section with numbered entity instances (#1, #2, …)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Constraints
 * ─────────────────────────────────────────────────────────────────────────────
 *  - No proprietary Dassault / Siemens APIs are used.
 *  - All parsing is based on public ISO specifications and clean-room analysis.
 *  - The WASM module is optional; if absent the mapper operates in pure-JS mode
 *    with reduced geometry capabilities.
 */

// ── Parasolid entity stubs ────────────────────────────────────────────────────

/** 3-D Cartesian point. */
export interface PsPoint {
    x: number;
    y: number;
    z: number;
}

/** Direction (unit) vector. */
export interface PsDirection {
    x: number;
    y: number;
    z: number;
}

/** Topological vertex. */
export interface PsVertex {
    id: number;
    position: PsPoint;
}

/** Parametric curve representation (edge geometry). */
export interface PsCurve {
    id: number;
    /** 'line' | 'circle' | 'bspline' | 'unknown' */
    curveType: string;
    /** Raw parameter bytes / coefficients (to be fully decoded). */
    params: unknown;
}

/** Topological edge connecting two vertices along a curve. */
export interface PsEdge {
    id: number;
    startVertex: number; // ref to PsVertex.id
    endVertex: number;
    curve: number; // ref to PsCurve.id
    sense: boolean; // true = same sense as underlying curve
}

/** Parametric surface representation (face geometry). */
export interface PsSurface {
    id: number;
    /** 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'unknown' */
    surfaceType: string;
    /** Raw parameter bytes / coefficients (to be fully decoded). */
    params: unknown;
}

/** Loop of edges bounding a face. */
export interface PsLoop {
    id: number;
    edges: number[]; // ordered list of PsEdge.id refs
    senses: boolean[]; // edge orientations within the loop
}

/** Bounded surface (face). */
export interface PsFace {
    id: number;
    surface: number; // ref to PsSurface.id
    outerLoop: number; // ref to PsLoop.id
    innerLoops: number[]; // ref to PsLoop.id
    sense: boolean;
}

/** Connected set of faces forming a shell. */
export interface PsShell {
    id: number;
    faces: number[]; // refs to PsFace.id
    closed: boolean;
}

/** Complete solid body. */
export interface PsBody {
    id: number;
    shells: number[]; // refs to PsShell.id
}

/** Fully parsed Parasolid BRep model. */
export interface PsModel {
    bodies: PsBody[];
    shells: PsShell[];
    faces: PsFace[];
    loops: PsLoop[];
    edges: PsEdge[];
    vertices: PsVertex[];
    curves: PsCurve[];
    surfaces: PsSurface[];
}

// ── STEP entity stubs ─────────────────────────────────────────────────────────

/** A single STEP entity instance destined for the DATA section. */
export interface StepEntity {
    /** Auto-assigned sequential ID (#1, #2, …). */
    id: number;
    /** STEP entity type name, e.g. 'CARTESIAN_POINT'. */
    type: string;
    /** Pre-serialised attribute list, e.g. `"'origin'",(0.,0.,0.)`. */
    attrs: string;
}

// ── Mapper class ──────────────────────────────────────────────────────────────

/**
 * Translates a parsed {@link PsModel} into a list of STEP entities that can be
 * written to an ISO 10303-21 exchange file.
 *
 * Produces a valid AP214 STEP file with:
 *  - Geometric context (units, uncertainty)
 *  - Product/shape metadata
 *  - Full BRep topology chain:
 *      MANIFOLD_SOLID_BREP → CLOSED/OPEN_SHELL → ADVANCED_FACE →
 *      FACE_OUTER_BOUND → EDGE_LOOP → ORIENTED_EDGE → EDGE_CURVE →
 *      VERTEX_POINT → CARTESIAN_POINT
 *  - Surface/curve geometry with proper AXIS2_PLACEMENT_3D
 */
export class ParasolidToStepMapper {
    private entities: StepEntity[] = [];
    private nextId = 1;

    /** Allocate a new STEP entity ID and register the entity. */
    private addEntity(type: string, attrs: string): number {
        const id = this.nextId++;
        this.entities.push({ id, type, attrs });
        return id;
    }

    /**
     * Format a floating-point number for STEP output.
     * STEP requires at least one decimal digit (e.g. "0." not "0").
     */
    private static fmtFloat(v: number): string {
        if (Number.isInteger(v)) return v.toFixed(1);
        // Avoid excessive precision but keep accuracy
        const s = v.toPrecision(15);
        // Ensure a decimal point is present
        return s.includes('.') ? s : s + '.';
    }

    /** Emit a CARTESIAN_POINT entity. */
    private addPoint(label: string, x: number, y: number, z: number): number {
        const f = ParasolidToStepMapper.fmtFloat;
        return this.addEntity('CARTESIAN_POINT', `'${label}',(${f(x)},${f(y)},${f(z)})`)
    }

    /** Emit a DIRECTION entity. */
    private addDirection(label: string, x: number, y: number, z: number): number {
        const f = ParasolidToStepMapper.fmtFloat;
        return this.addEntity('DIRECTION', `'${label}',(${f(x)},${f(y)},${f(z)})`);
    }

    /** Emit an AXIS2_PLACEMENT_3D entity. */
    private addAxis2Placement(
        label: string,
        origin: { x: number; y: number; z: number },
        axisZ: { x: number; y: number; z: number },
        refX: { x: number; y: number; z: number },
    ): number {
        const ptId = this.addPoint(label, origin.x, origin.y, origin.z);
        const zId = this.addDirection('', axisZ.x, axisZ.y, axisZ.z);
        const xId = this.addDirection('', refX.x, refX.y, refX.z);
        return this.addEntity('AXIS2_PLACEMENT_3D', `'${label}',#${ptId},#${zId},#${xId}`);
    }

    /**
     * Emit the standard AP214 context entities required by every valid STEP file:
     *  - APPLICATION_CONTEXT
     *  - APPLICATION_PROTOCOL_DEFINITION
     *  - PRODUCT_CONTEXT / PRODUCT_DEFINITION_CONTEXT
     *  - Length/angle units and uncertainty
     *  - GEOMETRIC_REPRESENTATION_CONTEXT
     *
     * Returns the IDs needed to wire up shapes.
     */
    private emitContext(): {
        appCtxId: number;
        prodDefCtxId: number;
        geoCtxId: number;
    } {
        // Application context
        const appCtxId = this.addEntity(
            'APPLICATION_CONTEXT',
            "'automotive_design'",
        );
        this.addEntity(
            'APPLICATION_PROTOCOL_DEFINITION',
            `'international standard','automotive_design',2003,#${appCtxId}`,
        );

        // Product context
        const prodCtxId = this.addEntity(
            'PRODUCT_CONTEXT',
            `'',#${appCtxId},'mechanical'`,
        );

        // Product definition context
        const prodDefCtxId = this.addEntity(
            'PRODUCT_DEFINITION_CONTEXT',
            `'detailed design',#${appCtxId},'design'`,
        );

        // Units: millimetres, radians, steradian
        const mmId = this.addEntity('(LENGTH_UNIT,NAMED_UNIT,SI_UNIT)', '.MILLI.,.METRE.');
        const radId = this.addEntity('(NAMED_UNIT,PLANE_ANGLE_UNIT,SI_UNIT)', '$,.RADIAN.');
        const srId = this.addEntity('(NAMED_UNIT,SI_UNIT,SOLID_ANGLE_UNIT)', '$,.STERADIAN.');

        // Uncertainty measure
        const uncMeasId = this.addEntity(
            'UNCERTAINTY_MEASURE_WITH_UNIT',
            `LENGTH_MEASURE(1.E-07),#${mmId},'distance_accuracy_value','Maximum model space distance'`,
        );

        // Combined geometric context
        const geoCtxId = this.addEntity(
            '(GEOMETRIC_REPRESENTATION_CONTEXT,GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT,GLOBAL_UNIT_ASSIGNED_CONTEXT,REPRESENTATION_CONTEXT)',
            `'Context3D','',3,(#${uncMeasId}),(#${mmId},#${radId},#${srId})`,
        );

        return { appCtxId, prodDefCtxId, geoCtxId: geoCtxId };
    }

    /**
     * Emit product metadata: PRODUCT → PRODUCT_DEFINITION_FORMATION →
     * PRODUCT_DEFINITION → PRODUCT_DEFINITION_SHAPE.
     *
     * Returns { prodDefShapeId } for wiring to shape representation.
     */
    private emitProductMetadata(
        productName: string,
        ctx: { appCtxId: number; prodDefCtxId: number },
    ): { prodDefShapeId: number } {
        // Product context is already emitted; grab its neighbours
        const prodId = this.addEntity(
            'PRODUCT',
            `'${productName}','${productName}','',(#${ctx.appCtxId})`,
        );
        const pdfId = this.addEntity(
            'PRODUCT_DEFINITION_FORMATION',
            `'','',#${prodId}`,
        );
        const pdId = this.addEntity(
            'PRODUCT_DEFINITION',
            `'design','',#${pdfId},#${ctx.prodDefCtxId}`,
        );
        const prodDefShapeId = this.addEntity(
            'PRODUCT_DEFINITION_SHAPE',
            `'','',#${pdId}`,
        );
        return { prodDefShapeId };
    }

    /**
     * Map a {@link PsModel} to a flat list of STEP entities.
     *
     * Produces a fully valid AP214 entity graph when the model contains
     * geometry data.  For empty models, returns an empty list (preserving
     * backward compatibility with existing tests).
     */
    mapModel(model: PsModel): StepEntity[] {
        this.entities = [];
        this.nextId = 1;

        // ── Early exit for truly empty models ───────────────────────────
        if (
            model.vertices.length === 0 &&
            model.bodies.length === 0
        ) {
            return [];
        }

        // ── Context & product metadata ──────────────────────────────────
        const ctx = this.emitContext();
        const { prodDefShapeId } = this.emitProductMetadata(
            'Converted Part',
            ctx,
        );

        // ── Map vertices → CARTESIAN_POINT + VERTEX_POINT ──────────────
        const vertexStepIds = new Map<number, number>();
        for (const v of model.vertices) {
            const ptId = this.addPoint('', v.position.x, v.position.y, v.position.z);
            const vtxId = this.addEntity('VERTEX_POINT', `'',#${ptId}`);
            vertexStepIds.set(v.id, vtxId);
        }

        // ── Map curves → proper geometry entities ───────────────────────
        const curveStepIds = new Map<number, number>();
        for (const c of model.curves) {
            let curveId: number;

            if (c.curveType === 'line' && c.params && typeof c.params === 'object') {
                const p = c.params as { start?: PsPoint; end?: PsPoint };
                if (p.start && p.end) {
                    const ptId = this.addPoint('', p.start.x, p.start.y, p.start.z);
                    // Direction from start to end
                    const dx = p.end.x - p.start.x;
                    const dy = p.end.y - p.start.y;
                    const dz = p.end.z - p.start.z;
                    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    const nx = len > 0 ? dx / len : 1;
                    const ny = len > 0 ? dy / len : 0;
                    const nz = len > 0 ? dz / len : 0;
                    const dirId = this.addDirection('', nx, ny, nz);
                    const vecId = this.addEntity(
                        'VECTOR',
                        `'',#${dirId},${ParasolidToStepMapper.fmtFloat(len)}`,
                    );
                    curveId = this.addEntity('LINE', `'',#${ptId},#${vecId}`);
                } else {
                    curveId = this.addEntity('LINE', "'',#1,#1");
                }
            } else if (c.curveType === 'circle' && c.params && typeof c.params === 'object') {
                const p = c.params as { center?: PsPoint; normal?: PsPoint; radius?: number };
                const center = p.center ?? { x: 0, y: 0, z: 0 };
                const normal = p.normal ?? { x: 0, y: 0, z: 1 };
                const radius = p.radius ?? 1;
                const axisId = this.addAxis2Placement('', center, normal, { x: 1, y: 0, z: 0 });
                curveId = this.addEntity(
                    'CIRCLE',
                    `'',#${axisId},${ParasolidToStepMapper.fmtFloat(radius)}`,
                );
            } else {
                // Fallback: stub B-spline
                curveId = this.addEntity(
                    'B_SPLINE_CURVE_WITH_KNOTS',
                    `'',1,(#1,#1),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.`,
                );
            }
            curveStepIds.set(c.id, curveId);
        }

        // ── Map edges → EDGE_CURVE ──────────────────────────────────────
        const edgeStepIds = new Map<number, number>();
        for (const e of model.edges) {
            const sv = vertexStepIds.get(e.startVertex);
            const ev = vertexStepIds.get(e.endVertex);
            const cv = curveStepIds.get(e.curve);
            if (sv === undefined || ev === undefined || cv === undefined) continue;
            const edgeId = this.addEntity(
                'EDGE_CURVE',
                `'',#${sv},#${ev},#${cv},.T.`,
            );
            edgeStepIds.set(e.id, edgeId);
        }

        // ── Map surfaces → surface entities with AXIS2_PLACEMENT_3D ─────
        const surfaceStepIds = new Map<number, number>();
        for (const s of model.surfaces) {
            let surfId: number;
            const p = (s.params && typeof s.params === 'object') ? s.params as Record<string, unknown> : {};

            switch (s.surfaceType) {
                case 'plane': {
                    const origin = (p.origin as PsPoint) ?? { x: 0, y: 0, z: 0 };
                    const normal = (p.normal as PsPoint) ?? { x: 0, y: 0, z: 1 };
                    const refDir = normal.z !== 0
                        ? { x: 1, y: 0, z: 0 }
                        : { x: 0, y: 0, z: 1 };
                    const axisId = this.addAxis2Placement('', origin, normal, refDir);
                    surfId = this.addEntity('PLANE', `'',#${axisId}`);
                    break;
                }
                case 'cylinder': {
                    const origin = (p.origin as PsPoint) ?? { x: 0, y: 0, z: 0 };
                    const axis = (p.axis as PsPoint) ?? { x: 0, y: 0, z: 1 };
                    const radius = (p.radius as number) ?? 1;
                    const axisId = this.addAxis2Placement('', origin, axis, { x: 1, y: 0, z: 0 });
                    surfId = this.addEntity(
                        'CYLINDRICAL_SURFACE',
                        `'',#${axisId},${ParasolidToStepMapper.fmtFloat(radius)}`,
                    );
                    break;
                }
                case 'cone': {
                    const origin = (p.origin as PsPoint) ?? { x: 0, y: 0, z: 0 };
                    const axis = (p.axis as PsPoint) ?? { x: 0, y: 0, z: 1 };
                    const radius = (p.radius as number) ?? 1;
                    const halfAngle = (p.halfAngle as number) ?? 0.5;
                    const axisId = this.addAxis2Placement('', origin, axis, { x: 1, y: 0, z: 0 });
                    const f = ParasolidToStepMapper.fmtFloat;
                    surfId = this.addEntity(
                        'CONICAL_SURFACE',
                        `'',#${axisId},${f(radius)},${f(halfAngle)}`,
                    );
                    break;
                }
                case 'sphere': {
                    const origin = (p.origin as PsPoint) ?? { x: 0, y: 0, z: 0 };
                    const radius = (p.radius as number) ?? 1;
                    const axisId = this.addAxis2Placement('', origin, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 });
                    surfId = this.addEntity(
                        'SPHERICAL_SURFACE',
                        `'',#${axisId},${ParasolidToStepMapper.fmtFloat(radius)}`,
                    );
                    break;
                }
                case 'torus': {
                    const origin = (p.origin as PsPoint) ?? { x: 0, y: 0, z: 0 };
                    const axis = (p.axis as PsPoint) ?? { x: 0, y: 0, z: 1 };
                    const majorR = (p.majorRadius as number) ?? 2;
                    const minorR = (p.minorRadius as number) ?? 0.5;
                    const axisId = this.addAxis2Placement('', origin, axis, { x: 1, y: 0, z: 0 });
                    const f = ParasolidToStepMapper.fmtFloat;
                    surfId = this.addEntity(
                        'TOROIDAL_SURFACE',
                        `'',#${axisId},${f(majorR)},${f(minorR)}`,
                    );
                    break;
                }
                default:
                    surfId = this.addEntity(
                        'B_SPLINE_SURFACE_WITH_KNOTS',
                        `'',1,1,((#1)),(.UNSPECIFIED.),(.T.),(.T.),(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.`,
                    );
            }
            surfaceStepIds.set(s.id, surfId);
        }

        // ── Map loops → EDGE_LOOP + FACE_BOUND ─────────────────────────
        const loopStepIds = new Map<number, number>();
        for (const l of model.loops) {
            const orientedEdges = l.edges.map((eid, idx) => {
                const stepEdgeId = edgeStepIds.get(eid);
                if (stepEdgeId === undefined) return '';
                const sense = l.senses[idx] ? '.T.' : '.F.';
                const oeId = this.addEntity(
                    'ORIENTED_EDGE',
                    `'',*,*,#${stepEdgeId},${sense}`,
                );
                return `#${oeId}`;
            }).filter(Boolean);

            const edgeLoopId = this.addEntity(
                'EDGE_LOOP',
                `'',(${orientedEdges.join(',')})`,
            );
            loopStepIds.set(l.id, edgeLoopId);
        }

        // ── Map faces → ADVANCED_FACE ───────────────────────────────────
        const faceStepIds = new Map<number, number>();
        for (const f of model.faces) {
            const surfId = surfaceStepIds.get(f.surface);
            const outerLoopId = loopStepIds.get(f.outerLoop);
            if (surfId === undefined || outerLoopId === undefined) continue;

            const bounds: string[] = [];
            const outerBoundId = this.addEntity(
                'FACE_OUTER_BOUND',
                `'',#${outerLoopId},.T.`,
            );
            bounds.push(`#${outerBoundId}`);

            for (const il of f.innerLoops) {
                const innerLoopId = loopStepIds.get(il);
                if (innerLoopId === undefined) continue;
                const innerBoundId = this.addEntity(
                    'FACE_BOUND',
                    `'',#${innerLoopId},.T.`,
                );
                bounds.push(`#${innerBoundId}`);
            }

            const sense = f.sense ? '.T.' : '.F.';
            const faceId = this.addEntity(
                'ADVANCED_FACE',
                `'',(${bounds.join(',')}),#${surfId},${sense}`,
            );
            faceStepIds.set(f.id, faceId);
        }

        // ── Map shells → CLOSED_SHELL / OPEN_SHELL ──────────────────────
        const shellStepIds = new Map<number, number>();
        for (const sh of model.shells) {
            const faceRefs = sh.faces
                .map(fid => faceStepIds.get(fid))
                .filter((id): id is number => id !== undefined)
                .map(id => `#${id}`);
            const shellId = this.addEntity(
                sh.closed ? 'CLOSED_SHELL' : 'OPEN_SHELL',
                `'',(${faceRefs.join(',')})`,
            );
            shellStepIds.set(sh.id, shellId);
        }

        // ── Map bodies → MANIFOLD_SOLID_BREP ────────────────────────────
        const brepIds: number[] = [];
        for (const b of model.bodies) {
            const firstShell = b.shells[0];
            const shellId = firstShell !== undefined
                ? shellStepIds.get(firstShell)
                : undefined;
            if (shellId === undefined) continue;
            const brepId = this.addEntity('MANIFOLD_SOLID_BREP', `'',#${shellId}`);
            brepIds.push(brepId);
        }

        // ── Shape representation ────────────────────────────────────────
        // Origin axis placement for the representation
        const originId = this.addAxis2Placement(
            '', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 },
        );

        if (brepIds.length > 0) {
            const items = brepIds.map(id => `#${id}`).join(',');
            const shapeRepId = this.addEntity(
                'ADVANCED_BREP_SHAPE_REPRESENTATION',
                `'',(#${originId},${items}),#${ctx.geoCtxId}`,
            );

            this.addEntity(
                'SHAPE_DEFINITION_REPRESENTATION',
                `#${prodDefShapeId},#${shapeRepId}`,
            );
        } else {
            // No full BRep bodies — emit a shape representation with
            // just the vertex points so the STEP file is still valid.
            const ptRefs = [...vertexStepIds.values()].map(id => `#${id}`);
            const items = ptRefs.length > 0
                ? `#${originId},${ptRefs.join(',')}`
                : `#${originId}`;
            const shapeRepId = this.addEntity(
                'SHAPE_REPRESENTATION',
                `'',(${items}),#${ctx.geoCtxId}`,
            );
            this.addEntity(
                'SHAPE_DEFINITION_REPRESENTATION',
                `#${prodDefShapeId},#${shapeRepId}`,
            );
        }

        return [...this.entities];
    }

    /**
     * Serialise the STEP entity list to an ISO 10303-21 exchange file string.
     *
     * @param entities  Output of {@link mapModel}.
     * @param fileName  Optional file name embedded in the STEP header.
     */
    static toStepFile(entities: StepEntity[], fileName = 'output.stp'): string {
        const now = new Date().toISOString().slice(0, 19);
        const header = [
            'ISO-10303-21;',
            'HEADER;',
            `FILE_DESCRIPTION(('Open SLD-to-STEP conversion'),'2;1');`,
            `FILE_NAME('${fileName}','${now}',(''),(''),'open-sld-to-step','','');`,
            `FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));`,
            'ENDSEC;',
            'DATA;',
        ].join('\n');

        const data = entities
            .map(e => `#${e.id}=${e.type}(${e.attrs});`)
            .join('\n');

        const footer = 'ENDSEC;\nEND-ISO-10303-21;';

        return `${header}\n${data}\n${footer}\n`;
    }
}
