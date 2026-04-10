/**
 * parasolid-to-step-mapper.test.ts
 *
 * Unit tests for the ParasolidToStepMapper stub.
 */

import {
    ParasolidToStepMapper,
    PsModel,
} from '../src/step/ParasolidToStepMapper.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Construct a minimal empty PsModel (no bodies/faces/etc.). */
function emptyModel(): PsModel {
    return {
        bodies: [],
        shells: [],
        faces: [],
        loops: [],
        edges: [],
        vertices: [],
        curves: [],
        surfaces: [],
    };
}

/** Construct a minimal PsModel with one vertex and one body (no faces). */
function singleVertexModel(): PsModel {
    return {
        bodies: [{ id: 1, shells: [] }],
        shells: [],
        faces: [],
        loops: [],
        edges: [],
        vertices: [{ id: 1, position: { x: 1.0, y: 2.0, z: 3.0 } }],
        curves: [],
        surfaces: [],
    };
}

// ── mapModel ──────────────────────────────────────────────────────────────────

describe('ParasolidToStepMapper.mapModel', () => {
    it('returns an empty entity list for an empty model', () => {
        const mapper = new ParasolidToStepMapper();
        const entities = mapper.mapModel(emptyModel());
        expect(entities).toHaveLength(0);
    });

    it('emits CARTESIAN_POINT and VERTEX_POINT for each vertex', () => {
        const mapper = new ParasolidToStepMapper();
        const entities = mapper.mapModel(singleVertexModel());
        const types = entities.map(e => e.type);
        expect(types).toContain('CARTESIAN_POINT');
        expect(types).toContain('VERTEX_POINT');
    });

    it('assigns sequential IDs starting from 1', () => {
        const mapper = new ParasolidToStepMapper();
        const entities = mapper.mapModel(singleVertexModel());
        expect(entities[0].id).toBe(1);
        for (let i = 1; i < entities.length; i++) {
            expect(entities[i].id).toBe(entities[i - 1].id + 1);
        }
    });

    it('CARTESIAN_POINT attrs contain vertex coordinates', () => {
        const mapper = new ParasolidToStepMapper();
        const model = singleVertexModel();
        const entities = mapper.mapModel(model);
        const pt = entities.find(e => e.type === 'CARTESIAN_POINT');
        expect(pt).toBeDefined();
        expect(pt!.attrs).toContain('1');
        expect(pt!.attrs).toContain('2');
        expect(pt!.attrs).toContain('3');
    });

    it('IDs are reset across multiple mapModel calls', () => {
        const mapper = new ParasolidToStepMapper();
        mapper.mapModel(singleVertexModel());
        const second = mapper.mapModel(singleVertexModel());
        // IDs should start from 1 again
        expect(second[0].id).toBe(1);
    });
});

// ── toStepFile ────────────────────────────────────────────────────────────────

describe('ParasolidToStepMapper.toStepFile', () => {
    it('produces a string starting with ISO-10303-21', () => {
        const output = ParasolidToStepMapper.toStepFile([]);
        expect(output.startsWith('ISO-10303-21;')).toBe(true);
    });

    it('contains the HEADER and ENDSEC markers', () => {
        const output = ParasolidToStepMapper.toStepFile([]);
        expect(output).toContain('HEADER;');
        expect(output).toContain('ENDSEC;');
    });

    it('contains the DATA section', () => {
        const output = ParasolidToStepMapper.toStepFile([]);
        expect(output).toContain('DATA;');
    });

    it('ends with END-ISO-10303-21', () => {
        const output = ParasolidToStepMapper.toStepFile([]);
        expect(output).toContain('END-ISO-10303-21;');
    });

    it('serialises entity instances correctly', () => {
        const entities = [
            { id: 1, type: 'CARTESIAN_POINT', attrs: "'',(0.,0.,0.)" },
            { id: 2, type: 'VERTEX_POINT', attrs: "'',#1" },
        ];
        const output = ParasolidToStepMapper.toStepFile(entities);
        expect(output).toContain("#1=CARTESIAN_POINT('',(0.,0.,0.));");
        expect(output).toContain("#2=VERTEX_POINT('',#1);");
    });

    it('embeds the provided file name in FILE_NAME', () => {
        const output = ParasolidToStepMapper.toStepFile([], 'my_model.stp');
        expect(output).toContain('my_model.stp');
    });

    it('contains FILE_SCHEMA with AP214', () => {
        const output = ParasolidToStepMapper.toStepFile([]);
        expect(output).toContain('AP214');
    });
});
