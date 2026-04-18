#!/usr/bin/env node
/**
 * investigate175.mjs — Summarize inferred torus families in parser output.
 *
 * Goal:
 * understand whether torus overgeneration is coming from a few repeated
 * radius/axis families or from many unrelated candidates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSample, listSamplePaths } from './_payload-gap-lib.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REFERENCE_ROOT = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models');

function referencePathForSample(fileName) {
    const lower = fileName.toLowerCase();
    const definitionDir = lower.includes('_ctc_') ? 'CTC Definitions' : 'FTC Definitions';
    return path.join(
        REFERENCE_ROOT,
        definitionDir,
        lower.replace('_sw1802.sldprt', '.stp'),
    );
}

function detectLengthUnitScale(text) {
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1;
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return 1000;
    return 1;
}

function parseStepEntities(text) {
    const entities = new Map();
    const normalized = text.replace(/\r\n/g, '\n');
    const dataStart = normalized.indexOf('DATA;');
    const dataEnd = normalized.indexOf('ENDSEC;', dataStart);
    if (dataStart < 0 || dataEnd < 0) return entities;

    const joined = normalized.slice(dataStart + 5, dataEnd).replace(/\n(?!#\d+=)/g, '');
    const lineRe = /^#(\d+)\s*=\s*(.+);$/gm;
    let match;
    while ((match = lineRe.exec(joined)) !== null) {
        const id = Number(match[1]);
        const rest = match[2].trim();
        const complex = rest.match(/^\(([^)]+)\)\s*\((.+)\)$/s);
        if (complex) {
            const types = complex[1].split(',').map((value) => value.trim());
            entities.set(id, { type: types.sort().join(','), types, args: complex[2] });
            continue;
        }
        const simple = rest.match(/^([A-Z_][A-Z0-9_]*)\s*\((.+)\)$/s);
        if (simple) {
            entities.set(id, { type: simple[1], types: [simple[1]], args: simple[2] });
            continue;
        }
        entities.set(id, { type: '???', types: [], args: rest });
    }

    return entities;
}

function extractRefs(args) {
    return [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseNumberTuple(text) {
    return text.split(',').map((value) => Number(value.trim())).filter((value) => !Number.isNaN(value));
}

function resolveCartesianPoint(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('CARTESIAN_POINT')) return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    return match ? parseNumberTuple(match[1]) : null;
}

function resolveDirection(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('DIRECTION')) return null;
    const match = entity.args.match(/\(\s*([^)]+)\s*\)/);
    if (!match) return null;
    const [x, y, z] = parseNumberTuple(match[1]);
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
}

function resolveAxis2Placement(entities, id) {
    const entity = entities.get(id);
    if (!entity || !entity.types.includes('AXIS2_PLACEMENT_3D')) return null;
    const refs = extractRefs(entity.args);
    return {
        origin: refs[0] ? resolveCartesianPoint(entities, refs[0]) : null,
        axis: refs[1] ? resolveDirection(entities, refs[1]) : null,
    };
}

function extractReferenceTori(fileName) {
    const referencePath = referencePathForSample(fileName);
    const text = fs.readFileSync(referencePath, 'utf8');
    const entities = parseStepEntities(text);
    const scale = detectLengthUnitScale(text);
    const tori = [];
    for (const entity of entities.values()) {
        if (!entity.types.includes('TOROIDAL_SURFACE')) continue;
        const match = entity.args.match(/'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9.eE+\-]+)\s*,\s*([0-9.eE+\-]+)/);
        if (!match) continue;
        const placement = resolveAxis2Placement(entities, Number(match[1]));
        if (!placement?.origin || !placement?.axis) continue;
        tori.push({
            params: {
                origin: {
                    x: placement.origin[0] * scale,
                    y: placement.origin[1] * scale,
                    z: placement.origin[2] * scale,
                },
                axis: {
                    x: placement.axis[0],
                    y: placement.axis[1],
                    z: placement.axis[2],
                },
                majorRadius: Number(match[2]) * scale,
                minorRadius: Number(match[3]) * scale,
            },
        });
    }
    return tori;
}

function canonicalizeAxis(axis) {
    const length = Math.hypot(axis.x, axis.y, axis.z) || 1;
    let x = axis.x / length;
    let y = axis.y / length;
    let z = axis.z / length;

    if (Math.abs(x) > 1e-9) {
        if (x < 0) {
            x = -x;
            y = -y;
            z = -z;
        }
    } else if (Math.abs(y) > 1e-9) {
        if (y < 0) {
            x = -x;
            y = -y;
            z = -z;
        }
    } else if (z < 0) {
        x = -x;
        y = -y;
        z = -z;
    }

    return [x, y, z];
}

function round(value, places = 3) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

function axisKey(axis) {
    const [x, y, z] = canonicalizeAxis(axis);
    return `${round(x)},${round(y)},${round(z)}`;
}

function radiusKey(surface) {
    return `${round(surface.params.majorRadius, 3)}|${round(surface.params.minorRadius, 3)}|${axisKey(surface.params.axis)}`;
}

function printFamilies(label, tori) {
    const families = new Map();
    for (const surface of tori) {
        const key = radiusKey(surface);
        const entry = families.get(key) ?? {
            count: 0,
            sample: surface,
            minX: surface.params.origin.x,
            maxX: surface.params.origin.x,
            minY: surface.params.origin.y,
            maxY: surface.params.origin.y,
            minZ: surface.params.origin.z,
            maxZ: surface.params.origin.z,
        };
        entry.count += 1;
        entry.minX = Math.min(entry.minX, surface.params.origin.x);
        entry.maxX = Math.max(entry.maxX, surface.params.origin.x);
        entry.minY = Math.min(entry.minY, surface.params.origin.y);
        entry.maxY = Math.max(entry.maxY, surface.params.origin.y);
        entry.minZ = Math.min(entry.minZ, surface.params.origin.z);
        entry.maxZ = Math.max(entry.maxZ, surface.params.origin.z);
        families.set(key, entry);
    }

    const sortedFamilies = [...families.values()].sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        if (right.sample.params.majorRadius !== left.sample.params.majorRadius) {
            return right.sample.params.majorRadius - left.sample.params.majorRadius;
        }
        return right.sample.params.minorRadius - left.sample.params.minorRadius;
    });

    console.log(`  ${label} total tori: ${tori.length}`);
    for (const family of sortedFamilies.slice(0, 20)) {
        const { origin, axis, majorRadius, minorRadius } = family.sample.params;
        console.log(
            `  ${label} count=${family.count.toString().padStart(2)} ` +
            `R=${round(majorRadius, 3).toFixed(3)} ` +
            `r=${round(minorRadius, 3).toFixed(3)} ` +
            `axis=${axisKey(axis)} ` +
            `origin=(${round(origin.x, 1)}, ${round(origin.y, 1)}, ${round(origin.z, 1)}) ` +
            `span=(${round(family.maxX - family.minX, 1)}, ${round(family.maxY - family.minY, 1)}, ${round(family.maxZ - family.minZ, 1)})`,
        );
    }
}

const filters = process.argv.slice(2);
const samplePaths = listSamplePaths(filters);

for (const samplePath of samplePaths) {
    const { fileName, parser } = loadSample(samplePath);
    const model = parser.parse();
    const tori = model.surfaces.filter((surface) => surface.surfaceType === 'torus');

    console.log(`\n${fileName}`);
    printFamilies('generated', tori);
    printFamilies('reference', extractReferenceTori(fileName));
}