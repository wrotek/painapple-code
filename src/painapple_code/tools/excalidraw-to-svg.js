#!/usr/bin/env node
/**
 * excalidraw-to-svg.js - Convert .excalidraw JSON to SVG
 *
 * Usage: node excalidraw-to-svg.js [--dark] < input.excalidraw > output.svg
 *        echo '{"type":"excalidraw",...}' | node excalidraw-to-svg.js
 *
 * Reads excalidraw JSON from stdin, writes SVG to stdout.
 * Supports both raw .excalidraw JSON and Obsidian .excalidraw.md
 * (compressed-json via LZ-string) formats.
 *
 * Requires @excalidraw/utils (which needs DOM polyfill via jsdom).
 */

import { JSDOM } from 'jsdom';
import LZString from 'lz-string';

// Set up browser globals before importing excalidraw
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
});

// Polyfill browser globals for @excalidraw/utils (which assumes browser env)
const globals = {
    window: dom.window,
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    XMLSerializer: dom.window.XMLSerializer,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: clearTimeout,
    devicePixelRatio: 1,
    ResizeObserver: class { observe() {} disconnect() {} },
    FontFace: class {
        constructor(family, source) { this.family = family; this.source = source; }
        load() { return Promise.resolve(this); }
    },
};
for (const [key, value] of Object.entries(globals)) {
    try { globalThis[key] = value; } catch { /* read-only, skip */ }
}
// navigator is read-only in newer Node — use defineProperty
Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    writable: true,
    configurable: true,
});
// fonts.add() stub
if (!document.fonts) {
    Object.defineProperty(document, 'fonts', {
        value: { add() {}, check() { return true; }, ready: Promise.resolve() },
    });
}

// Now import excalidraw utils
const { exportToSvg } = await import('@excalidraw/utils');

// Parse CLI args
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

/**
 * Extract excalidraw JSON from Obsidian .excalidraw.md format.
 * These files contain a ```compressed-json block between %% markers
 * with LZ-string base64 compressed excalidraw data.
 */
function extractFromObsidianMd(text) {
    const match = text.match(/```compressed-json\n([\s\S]*?)```/);
    if (!match) return null;

    // The compressed data is chunked into lines — join and decompress
    const compressed = match[1].replace(/\n/g, '');
    const decompressed = LZString.decompressFromBase64(compressed);
    if (!decompressed) return null;

    try {
        return JSON.parse(decompressed);
    } catch {
        return null;
    }
}

let data;

// Try raw JSON first
try {
    data = JSON.parse(input);
} catch {
    // Not JSON — try Obsidian .excalidraw.md format
    data = extractFromObsidianMd(input);
    if (!data) {
        process.stderr.write('Error: input is not valid excalidraw JSON or Obsidian .excalidraw.md format\n');
        process.exit(1);
    }
}

if (data.type !== 'excalidraw') {
    process.stderr.write('Error: input is not an excalidraw file (missing type: "excalidraw")\n');
    process.exit(1);
}

try {
    const svg = await exportToSvg({
        elements: data.elements || [],
        appState: {
            ...(data.appState || {}),
            exportWithDarkMode: darkMode,
            exportBackground: true,
        },
        files: data.files || {},
    });

    // svg is an SVGSVGElement — serialize to string
    const serializer = new XMLSerializer();
    let svgString = serializer.serializeToString(svg);

    // Fix duplicate xmlns attribute (jsdom serializer bug) — breaks <img> rendering
    svgString = svgString.replace(
        /(<svg\s[^>]*?)xmlns="http:\/\/www\.w3\.org\/2000\/svg"\s+(.*?)xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
        '$1xmlns="http://www.w3.org/2000/svg" $2'
    );

    process.stdout.write(svgString);
} catch (e) {
    process.stderr.write(`Error: render failed: ${e.message}\n${e.stack}\n`);
    process.exit(1);
}
