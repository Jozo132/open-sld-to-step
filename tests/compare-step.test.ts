import { compareStepFiles } from '../scripts/compare-step.mjs';

function buildStep(
    conePlacements: Array<{
        origin: [number, number, number];
        radius: number;
        angle: number;
        axis?: [number, number, number];
        refDir?: [number, number, number];
    }>,
    options: { degreeAngleUnit?: boolean } = {},
): string {
    const lines = [
        'ISO-10303-21;',
        'HEADER;',
        'ENDSEC;',
        'DATA;',
    ];

    let nextId = 1;
    for (const placement of conePlacements) {
        const pointId = nextId++;
        const axisId = nextId++;
        const refId = nextId++;
        const placeId = nextId++;
        const coneId = nextId++;
        const axis = placement.axis ?? [0, 1, 0];
        const refDir = placement.refDir ?? [1, 0, 0];
        lines.push(`#${pointId}=CARTESIAN_POINT('',(${placement.origin[0]},${placement.origin[1]},${placement.origin[2]}));`);
        lines.push(`#${axisId}=DIRECTION('',(${axis[0]},${axis[1]},${axis[2]}));`);
        lines.push(`#${refId}=DIRECTION('',(${refDir[0]},${refDir[1]},${refDir[2]}));`);
        lines.push(`#${placeId}=AXIS2_PLACEMENT_3D('',#${pointId},#${axisId},#${refId});`);
        lines.push(`#${coneId}=CONICAL_SURFACE('',#${placeId},${placement.radius},${placement.angle});`);
    }

    if (options.degreeAngleUnit) {
        const radianUnitId = nextId++;
        const degreeMeasureId = nextId++;
        const degreeUnitId = nextId++;
        const lengthUnitId = nextId++;
        const solidAngleUnitId = nextId++;
        const uncertaintyId = nextId++;
        const contextId = nextId++;

        lines.push(`#${radianUnitId}=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));`);
        lines.push(`#${degreeMeasureId}=PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(1.745329251994E-2),#${radianUnitId});`);
        lines.push(`#${degreeUnitId}=(CONVERSION_BASED_UNIT('DEGREE',#${degreeMeasureId})NAMED_UNIT(*)PLANE_ANGLE_UNIT());`);
        lines.push(`#${lengthUnitId}=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));`);
        lines.push(`#${solidAngleUnitId}=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());`);
        lines.push(`#${uncertaintyId}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-2),#${lengthUnitId},'closure','');`);
        lines.push(`#${contextId}=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertaintyId}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnitId},#${degreeUnitId},#${solidAngleUnitId}))REPRESENTATION_CONTEXT('ID1','3'));`);
    }

    lines.push('ENDSEC;');
    lines.push('END-ISO-10303-21;');
    return lines.join('\n');
}

function buildConicalFaceStep(
    faces: Array<{
        origin: [number, number, number];
        radius: number;
        angle: number;
        vertices: Array<[number, number, number]>;
        axis?: [number, number, number];
        refDir?: [number, number, number];
    }>,
): string {
    const lines = [
        'ISO-10303-21;',
        'HEADER;',
        'ENDSEC;',
        'DATA;',
    ];

    let nextId = 1;
    for (const face of faces) {
        const pointIds = face.vertices.map((vertex) => {
            const pointId = nextId++;
            lines.push(`#${pointId}=CARTESIAN_POINT('',(${vertex[0]},${vertex[1]},${vertex[2]}));`);
            return pointId;
        });

        const vertexIds = pointIds.map((pointId) => {
            const vertexId = nextId++;
            lines.push(`#${vertexId}=VERTEX_POINT('',#${pointId});`);
            return vertexId;
        });

        const edgeCurveIds = [];
        const orientedEdgeIds = [];
        for (let index = 0; index < face.vertices.length; index++) {
            const start = face.vertices[index];
            const end = face.vertices[(index + 1) % face.vertices.length];
            const dx = end[0] - start[0];
            const dy = end[1] - start[1];
            const dz = end[2] - start[2];
            const length = Math.hypot(dx, dy, dz) || 1;

            const directionId = nextId++;
            const vectorId = nextId++;
            const lineId = nextId++;
            const edgeCurveId = nextId++;
            const orientedEdgeId = nextId++;

            lines.push(`#${directionId}=DIRECTION('',(${dx / length},${dy / length},${dz / length}));`);
            lines.push(`#${vectorId}=VECTOR('',#${directionId},${length});`);
            lines.push(`#${lineId}=LINE('',#${pointIds[index]},#${vectorId});`);
            lines.push(`#${edgeCurveId}=EDGE_CURVE('',#${vertexIds[index]},#${vertexIds[(index + 1) % vertexIds.length]},#${lineId},.T.);`);
            lines.push(`#${orientedEdgeId}=ORIENTED_EDGE('',*,*,#${edgeCurveId},.T.);`);

            edgeCurveIds.push(edgeCurveId);
            orientedEdgeIds.push(orientedEdgeId);
        }

        const loopId = nextId++;
        const boundId = nextId++;
        const axisId = nextId++;
        const refId = nextId++;
        const placePointId = nextId++;
        const placeId = nextId++;
        const coneId = nextId++;
        const faceId = nextId++;
        const axis = face.axis ?? [0, 1, 0];
        const refDir = face.refDir ?? [1, 0, 0];

        lines.push(`#${loopId}=EDGE_LOOP('',(${orientedEdgeIds.map((id) => `#${id}`).join(',')}));`);
        lines.push(`#${boundId}=FACE_OUTER_BOUND('',#${loopId},.T.);`);
        lines.push(`#${axisId}=DIRECTION('',(${axis[0]},${axis[1]},${axis[2]}));`);
        lines.push(`#${refId}=DIRECTION('',(${refDir[0]},${refDir[1]},${refDir[2]}));`);
        lines.push(`#${placePointId}=CARTESIAN_POINT('',(${face.origin[0]},${face.origin[1]},${face.origin[2]}));`);
        lines.push(`#${placeId}=AXIS2_PLACEMENT_3D('',#${placePointId},#${axisId},#${refId});`);
        lines.push(`#${coneId}=CONICAL_SURFACE('',#${placeId},${face.radius},${face.angle});`);
        lines.push(`#${faceId}=ADVANCED_FACE('',(#${boundId}),#${coneId},.T.);`);
    }

    lines.push('ENDSEC;');
    lines.push('END-ISO-10303-21;');
    return lines.join('\n');
}

describe('compareStepFiles', () => {
    it('deduplicates identical cone placements before cone scoring', () => {
        const generated = buildStep([
            { origin: [0, 2, 0], radius: 3, angle: 45 },
        ]);
        const reference = buildStep([
            { origin: [0, 2, 0], radius: 3, angle: 45 },
            { origin: [0, 2, 0], radius: 3, angle: 45 },
        ]);

        const { scores, output } = compareStepFiles(generated, reference, 'generated.stp', 'reference.stp');

        expect(scores.Cones).toEqual({ matched: 1, total: 1, pct: 100 });
        expect(output).toContain('Cone matching canonicalizes equivalent placements: generated=1→1  reference=2→1');
    });

    it('keeps distinct cone placements separate', () => {
        const generated = buildStep([
            { origin: [0, 2, 0], radius: 3, angle: 45 },
        ]);
        const reference = buildStep([
            { origin: [0, 2, 0], radius: 3, angle: 45 },
            { origin: [10, 2, 0], radius: 3, angle: 45 },
        ]);

        const { scores } = compareStepFiles(generated, reference, 'generated.stp', 'reference.stp');

        expect(scores.Cones).toEqual({ matched: 1, total: 2, pct: 50 });
    });

    it('matches cones that use different section-circle parameterizations', () => {
        const angle = Math.PI / 4;
        const generated = buildStep([
            { origin: [0, 2, 0], radius: 3, angle },
        ]);
        const reference = buildStep([
            { origin: [0, 1, 0], radius: 2, angle },
        ]);

        const { scores } = compareStepFiles(generated, reference, 'generated.stp', 'reference.stp');

        expect(scores.Cones).toEqual({ matched: 1, total: 1, pct: 100 });
    });

    it('matches negative-axis cones across section and apex parameterizations', () => {
        const angle = Math.PI / 4;
        const offset = 2 / Math.tan(angle);
        const generated = buildStep([
            { origin: [0, offset, 0], radius: 0, angle, axis: [0, -1, 0] },
        ]);
        const reference = buildStep([
            { origin: [0, 0, 0], radius: 2, angle, axis: [0, -1, 0] },
        ]);

        const { scores } = compareStepFiles(generated, reference, 'generated.stp', 'reference.stp');

        expect(scores.Cones).toEqual({ matched: 1, total: 1, pct: 100 });
    });

    it('normalizes compact degree-based plane-angle units for equivalent cone parameterizations', () => {
        const tan3Deg = Math.tan(3 * Math.PI / 180);
        const generated = buildStep([
            { origin: [0, 20, 0], radius: 20 * tan3Deg, angle: 3 },
        ], { degreeAngleUnit: true });
        const reference = buildStep([
            { origin: [0, 40, 0], radius: 40 * tan3Deg, angle: 3 },
        ], { degreeAngleUnit: true });

        const { scores } = compareStepFiles(generated, reference, 'generated.stp', 'reference.stp');

        expect(scores.Cones).toEqual({ matched: 1, total: 1, pct: 100 });
    });

    it('deduplicates exact duplicate conical faces before face scoring', () => {
        const generated = buildConicalFaceStep([
            {
                origin: [0, 0, 0],
                radius: 5,
                angle: Math.PI / 4,
                vertices: [
                    [0, 0, 0],
                    [5, 5, 0],
                    [0, 5, 5],
                ],
            },
        ]);
        const reference = buildConicalFaceStep([
            {
                origin: [0, 0, 0],
                radius: 5,
                angle: Math.PI / 4,
                vertices: [
                    [0, 0, 0],
                    [5, 5, 0],
                    [0, 5, 5],
                ],
            },
            {
                origin: [0, 0, 0],
                radius: 5,
                angle: Math.PI / 4,
                vertices: [
                    [0, 0, 0],
                    [5, 5, 0],
                    [0, 5, 5],
                ],
            },
        ]);

        const { scores, output } = compareStepFiles(generated, reference, 'generated.stp', 'reference.stp');

        expect(scores.Faces).toEqual({ matched: 1, total: 1, pct: 100 });
        expect(output).toContain('Conical face matching canonicalizes equivalent faces: generated=1→1  reference=2→1');
    });

    it('keeps distinct conical faces on the same cone separate', () => {
        const generated = buildConicalFaceStep([
            {
                origin: [0, 0, 0],
                radius: 5,
                angle: Math.PI / 4,
                vertices: [
                    [0, 0, 0],
                    [5, 5, 0],
                    [0, 5, 5],
                ],
            },
        ]);
        const reference = buildConicalFaceStep([
            {
                origin: [0, 0, 0],
                radius: 5,
                angle: Math.PI / 4,
                vertices: [
                    [0, 0, 0],
                    [5, 5, 0],
                    [0, 5, 5],
                ],
            },
            {
                origin: [0, 0, 0],
                radius: 5,
                angle: Math.PI / 4,
                vertices: [
                    [10, 0, 0],
                    [15, 5, 0],
                    [10, 5, 5],
                ],
            },
        ]);

        const { scores, output } = compareStepFiles(generated, reference, 'generated.stp', 'reference.stp');

        expect(scores.Faces).toEqual({ matched: 1, total: 2, pct: 50 });
        expect(output).not.toContain('Conical face matching canonicalizes equivalent faces: generated=1→1  reference=2→1');
    });

    it('matches conical faces across negative-axis section and apex parameterizations', () => {
        const angle = Math.PI / 4;
        const radius = 2;
        const offset = radius / Math.tan(angle);
        const generated = buildConicalFaceStep([
            {
                origin: [0, offset, 0],
                radius: 0,
                angle,
                axis: [0, -1, 0],
                vertices: [
                    [0, offset, 0],
                    [2, 0, 0],
                    [0, 0, 2],
                ],
            },
        ]);
        const reference = buildConicalFaceStep([
            {
                origin: [0, 0, 0],
                radius,
                angle,
                axis: [0, -1, 0],
                vertices: [
                    [0, offset, 0],
                    [2, 0, 0],
                    [0, 0, 2],
                ],
            },
        ]);

        const { scores } = compareStepFiles(generated, reference, 'generated.stp', 'reference.stp');

        expect(scores.Faces).toEqual({ matched: 1, total: 1, pct: 100 });
    });
});