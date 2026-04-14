import { compareStepFiles } from '../scripts/compare-step.mjs';

function buildStep(
    conePlacements: Array<{ origin: [number, number, number]; radius: number; angle: number }>,
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
        lines.push(`#${pointId}=CARTESIAN_POINT('',(${placement.origin[0]},${placement.origin[1]},${placement.origin[2]}));`);
        lines.push(`#${axisId}=DIRECTION('',(0.,1.,0.));`);
        lines.push(`#${refId}=DIRECTION('',(1.,0.,0.));`);
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
});