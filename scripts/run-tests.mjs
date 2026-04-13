#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);

function hasBun() {
    const probe = spawnSync('bun', ['--version'], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
    });
    return probe.status === 0;
}

const useBun = hasBun();
const command = useBun ? 'bun' : 'node';
const args = useBun
    ? ['test', ...forwardedArgs]
    : [
        '--max-old-space-size=1024',
        '--experimental-vm-modules',
        './node_modules/jest/bin/jest.js',
        ...forwardedArgs,
    ];

if (useBun) {
    console.log('Using Bun test runner');
} else {
    console.log('Using Jest fallback');
}

const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
});

if (typeof result.status === 'number') {
    process.exit(result.status);
}

process.exit(1);