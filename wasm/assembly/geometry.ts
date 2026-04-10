/**
 * geometry.ts – AssemblyScript WASM module stub for heavy geometry operations.
 *
 * This module is compiled to WebAssembly using the AssemblyScript toolchain
 * (`npx asc wasm/assembly/geometry.ts -o wasm/geometry.wasm`).
 *
 * Functions exported here are intended to be called from the TypeScript host
 * (src/step/ParasolidToStepMapper.ts) via a WASM adapter.
 *
 * Current stub exports:
 *  - add          : smoke-test function
 *  - dot3         : 3-D dot product
 *  - cross3       : 3-D cross product (result written to shared memory)
 *  - normalize3   : normalize a 3-D vector in place
 *
 * Future work:
 *  - B-spline basis function evaluation
 *  - Surface normal computation
 *  - Curve/surface intersection
 *  - Tolerance / manifold validation
 */

/**
 * Smoke-test export: returns the sum of two i32 values.
 * Used by unit tests to verify the WASM module loads correctly.
 */
export function add(a: i32, b: i32): i32 {
    return a + b;
}

/**
 * Dot product of two 3-D vectors (a·b).
 */
export function dot3(
    ax: f64, ay: f64, az: f64,
    bx: f64, by: f64, bz: f64,
): f64 {
    return ax * bx + ay * by + az * bz;
}

/**
 * Length (Euclidean norm) of a 3-D vector.
 */
export function length3(x: f64, y: f64, z: f64): f64 {
    return Math.sqrt(x * x + y * y + z * z) as f64;
}
