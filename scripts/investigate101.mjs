/**
 * investigate101.mjs — FTC_11 point-cloud support for planes and tori
 *
 * Goal: determine whether the CURRENT parser extraction path for FTC_11
 * already yields enough point data to recover the missing top plane and both
 * torus surfaces. This uses the built SldprtContainerParser + ParasolidParser
 * directly, then clusters z levels and radial distances and measures support
 * for the reference surfaces.
 *
 * Reference FTC_11 geometry:
 * - planes: z = -1.5 mm, z = 0.425 mm
 * - cylinders: r = 16 mm, r = 31.5 mm
 * - tori: (R=17.5, r=1.5), (R=30, r=1.5)
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const MM = 1000;
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href,
);
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href,
);

function clusterValues(values, tolerance) {
    if (values.length === 0) return [];
    const sorted = values.slice().sort((a, b) => a - b);
    const clusters = [];
    let current = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        if (Math.abs(sorted[i] - current[current.length - 1]) <= tolerance) {
            current.push(sorted[i]);
        } else {
            clusters.push(current);
            current = [sorted[i]];
        }
    }
    clusters.push(current);

    return clusters.map(cluster => ({
        center: cluster.reduce((sum, value) => sum + value, 0) / cluster.length,
        count: cluster.length,
        min: cluster[0],
        max: cluster[cluster.length - 1],
    }));
}

function radial(point) {
    return Math.sqrt(point.x * point.x + point.y * point.y);
}

function torusResidual(point, majorRadius, minorRadius) {
    const rho = radial(point);
    return Math.abs((rho - majorRadius) * (rho - majorRadius) + point.z * point.z - minorRadius * minorRadius);
}

function summarizeSupport(name, points, predicate) {
    const matches = points.filter(predicate);
    console.log(`\n${name}: ${matches.length} matching point(s)`);
    for (const point of matches.slice(0, 10)) {
        console.log(`  (${point.x.toFixed(3)}, ${point.y.toFixed(3)}, ${point.z.toFixed(3)})  rho=${radial(point).toFixed(3)}`);
    }
    if (matches.length > 10) console.log(`  ... ${matches.length - 10} more`);
}

const sldPath = join(
    'downloads',
    'nist',
    'NIST-FTC-CTC-PMI-CAD-models',
    'SolidWorks MBD 2018',
    'nist_ftc_11_asme1_rb_sw1802.SLDPRT',
);

const sldBuf = readFileSync(sldPath);
const result = SldprtContainerParser.extractParasolid(sldBuf);
if (!result) {
    console.log('FAIL: no Parasolid buffer extracted from SLDPRT');
    process.exit(1);
}

const ps = result.data;
const parser = new ParasolidParser(ps);
const points = parser.extractCoordinates(2000).map(point => ({
    x: point.x * MM,
    y: point.y * MM,
    z: point.z * MM,
}));
const model = new ParasolidParser(ps).parse();

console.log(`PS buffer length: ${ps.length} bytes`);
console.log(`Current parser extracted points: ${points.length}`);
console.log(`Current parser surfaces: ${model.surfaces.length}`);
for (const surface of model.surfaces) {
    const params = surface.params;
    if (surface.surfaceType === 'plane') {
        console.log(`  plane id=${surface.id} z=${params.origin.z.toFixed(3)} n=(${params.normal.x.toFixed(3)}, ${params.normal.y.toFixed(3)}, ${params.normal.z.toFixed(3)})`);
    } else if (surface.surfaceType === 'cylinder') {
        console.log(`  cylinder id=${surface.id} r=${params.radius.toFixed(3)} origin=(${params.origin.x.toFixed(3)}, ${params.origin.y.toFixed(3)}, ${params.origin.z.toFixed(3)})`);
    } else if (surface.surfaceType === 'cone') {
        console.log(`  cone id=${surface.id} r=${params.radius.toFixed(3)} halfAngle=${params.halfAngle.toFixed(6)}`);
    }
}

const zClusters = clusterValues(points.map(point => point.z), 0.05)
    .sort((a, b) => a.center - b.center);
console.log('\n=== Z CLUSTERS (tol 0.05 mm) ===');
for (const cluster of zClusters.slice(0, 20)) {
    console.log(`z=${cluster.center.toFixed(3)} mm  count=${cluster.count}  span=[${cluster.min.toFixed(3)}, ${cluster.max.toFixed(3)}]`);
}

const rhoClusters = clusterValues(points.map(radial), 0.05)
    .sort((a, b) => a.center - b.center);
console.log('\n=== RADIAL CLUSTERS (tol 0.05 mm) ===');
for (const cluster of rhoClusters.slice(0, 20)) {
    console.log(`rho=${cluster.center.toFixed(3)} mm  count=${cluster.count}  span=[${cluster.min.toFixed(3)}, ${cluster.max.toFixed(3)}]`);
}

console.log('\n=== REFERENCE SURFACE SUPPORT ===');
summarizeSupport('Bottom plane z=-1.5', points, point => Math.abs(point.z + 1.5) < 0.05);
summarizeSupport('Top plane z=0.425', points, point => Math.abs(point.z - 0.425) < 0.05);
summarizeSupport('Inner cylinder r=16', points, point => Math.abs(radial(point) - 16) < 0.05);
summarizeSupport('Outer cylinder r=31.5', points, point => Math.abs(radial(point) - 31.5) < 0.05);
summarizeSupport('Inner torus R=17.5 r=1.5', points, point => torusResidual(point, 17.5, 1.5) < 0.05);
summarizeSupport('Outer torus R=30 r=1.5', points, point => torusResidual(point, 30, 1.5) < 0.05);

console.log('\n=== TORUS SECTION CHECK AT TOP PLANE ===');
for (const topPoint of points.filter(point => Math.abs(point.z - 0.425) < 0.05).slice(0, 20)) {
    const rho = radial(topPoint);
    console.log(
        `rho=${rho.toFixed(3)}  innerResidual=${torusResidual(topPoint, 17.5, 1.5).toFixed(6)}  outerResidual=${torusResidual(topPoint, 30, 1.5).toFixed(6)}`,
    );
}