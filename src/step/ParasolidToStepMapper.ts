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
 * @stub  This is a conceptual stub.  Entity mappings are outlined in comments;
 *        the actual geometry decoding and coefficient mapping will be added
 *        incrementally as the Parasolid block format is reverse-engineered.
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
     * Map a {@link PsModel} to a flat list of STEP entities.
     *
     * @stub  Currently emits a minimal skeleton; detailed surface/curve
     *        parameter mapping is left for future implementation.
     */
    mapModel(model: PsModel): StepEntity[] {
        this.entities = [];
        this.nextId = 1;

        // Map vertices → CARTESIAN_POINT + VERTEX_POINT
        const vertexStepIds = new Map<number, number>();
        for (const v of model.vertices) {
            const ptId = this.addEntity(
                'CARTESIAN_POINT',
                `'',(${v.position.x},${v.position.y},${v.position.z})`,
            );
            const vtxId = this.addEntity('VERTEX_POINT', `'',#${ptId}`);
            vertexStepIds.set(v.id, vtxId);
        }

        // Map curves → EDGE_CURVE geometry stubs
        const curveStepIds = new Map<number, number>();
        for (const c of model.curves) {
            // TODO: decode c.params and emit LINE / CIRCLE / B_SPLINE_CURVE_WITH_KNOTS
            const curveId = this.addEntity(
                'B_SPLINE_CURVE_WITH_KNOTS',
                `'',0,(),(),(),(UNSPECIFIED.),.F.,.F.`
            );
            curveStepIds.set(c.id, curveId);
        }

        // Map edges → EDGE_CURVE + ORIENTED_EDGE stubs
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

        // Map surfaces → surface entity stubs
        const surfaceStepIds = new Map<number, number>();
        for (const s of model.surfaces) {
            let surfId: number;
            switch (s.surfaceType) {
                case 'plane':
                    // TODO: extract origin & normal from s.params
                    surfId = this.addEntity('PLANE', `''`);
                    break;
                case 'cylinder':
                    // TODO: extract axis, position, radius from s.params
                    surfId = this.addEntity('CYLINDRICAL_SURFACE', `'',#1,1.`);
                    break;
                default:
                    surfId = this.addEntity(
                        'B_SPLINE_SURFACE_WITH_KNOTS',
                        `'',1,1,((#1)),(.UNSPECIFIED.),(.T.),(.T.),(1,1),(1,1),(0.,1.),(0.,1.)`
                    );
            }
            surfaceStepIds.set(s.id, surfId);
        }

        // Map loops → FACE_BOUND stubs
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

        // Map faces → ADVANCED_FACE stubs
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

        // Map shells → CLOSED_SHELL / OPEN_SHELL stubs
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

        // Map bodies → MANIFOLD_SOLID_BREP stubs
        for (const b of model.bodies) {
            // Use the first closed shell as the outer shell (AP214 requirement)
            const firstShell = b.shells[0];
            const shellId = firstShell !== undefined
                ? shellStepIds.get(firstShell)
                : undefined;
            if (shellId === undefined) continue;
            this.addEntity('MANIFOLD_SOLID_BREP', `'',#${shellId}`);
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
            `FILE_SCHEMA(('AP214_IS'));`,
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
