#!/usr/bin/env node
/**
 * vegalite-to-svg.js - Convert Vega-Lite JSON spec to SVG
 *
 * Usage: echo '{"$schema":"...","mark":"bar",...}' | node vegalite-to-svg.js [--dark]
 *
 * Reads Vega-Lite JSON from stdin, writes SVG to stdout.
 * No DOM or canvas polyfills needed — Vega renders SVG natively in headless mode.
 */

import * as vega from 'vega';
import * as vegaLite from 'vega-lite';

const darkMode = process.argv.includes('--dark');

// Read stdin
const chunks = [];
for await (const chunk of process.stdin) {
    chunks.push(chunk);
}
const input = Buffer.concat(chunks).toString('utf-8');

if (!input.trim()) {
    process.stderr.write('Error: no input received on stdin\n');
    process.exit(1);
}

let vlSpec;
try {
    vlSpec = JSON.parse(input);
} catch {
    process.stderr.write('Error: input is not valid JSON\n');
    process.exit(1);
}

// Apply dark mode theme overrides
if (darkMode) {
    vlSpec.config = {
        ...(vlSpec.config || {}),
        background: '#1e1e1e',
        axis: {
            ...(vlSpec.config?.axis || {}),
            labelColor: '#ccc',
            titleColor: '#ccc',
            gridColor: '#444',
            domainColor: '#666',
            tickColor: '#666',
        },
        legend: {
            ...(vlSpec.config?.legend || {}),
            labelColor: '#ccc',
            titleColor: '#ccc',
        },
        title: {
            ...(vlSpec.config?.title || {}),
            color: '#ccc',
            subtitleColor: '#999',
        },
        view: {
            ...(vlSpec.config?.view || {}),
            stroke: '#444',
        },
    };
}

try {
    // Compile Vega-Lite → full Vega spec
    const vgSpec = vegaLite.compile(vlSpec).spec;

    // Render to SVG in headless mode (no DOM needed)
    const view = new vega.View(vega.parse(vgSpec), { renderer: 'none' });
    const svg = await view.toSVG();
    view.finalize();

    process.stdout.write(svg);
} catch (e) {
    process.stderr.write(`Error: render failed: ${e.message}\n`);
    process.exit(1);
}
