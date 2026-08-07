#!/usr/bin/env node
//
// personalize-devcontainer.js — read a user's devcontainer.json and emit a
// minimal wrapper devcontainer.json that uses painapple-code:base as the
// base image, carrying over the user's features (and a few other safe
// fields) on top.
//
// Invoked from `./painapple-docker.sh build` when DEVCONTAINER_PATH is set.
// The generated file is fed to `@devcontainers/cli build`, which resolves
// the features from their OCI registries and bakes them into a new image
// layered on top of painapple-code:base.
//
// Usage:
//   node personalize-devcontainer.js <input-path> <output-path> <base-image>
//
//   input-path   absolute path to the user's devcontainer.json (JSONC)
//   output-path  where to write the generated wrapper (JSON, no comments)
//   base-image   image to use as the FROM (e.g. painapple-code:base)
//
// Fields carried over from the user's file:
//   features         — the main payload; OCI refs resolved by devcontainer CLI
//   containerEnv     — env vars set inside the image (build-time and runtime)
//   remoteEnv        — env vars set only when attaching (devcontainer CLI honors)
//
// Fields explicitly NOT carried over (would conflict or are irrelevant):
//   image / build / dockerFile — replaced by our base image
//   forwardPorts / portsAttributes — these are runtime hints, not bake-time
//   mounts / runArgs — runtime concerns; painapple-docker.sh handles its own
//   customizations — IDE/editor settings, irrelevant for a baked image
//   postCreateCommand / postAttachCommand / etc. — bridge has its own entrypoint
//
// Relative feature paths (e.g. "./my-feature") in the user's file are
// resolved against the user's devcontainer.json directory so they survive
// being referenced from the temp workspace folder we hand to the CLI.

import * as fs from 'node:fs';
import * as path from 'node:path';

function die(msg) {
    process.stderr.write(`personalize-devcontainer: ${msg}\n`);
    process.exit(1);
}

// Strip JSONC (/* */ and //) comments and trailing commas. Mirrors what
// the official @devcontainers/cli does internally — we keep it inline so
// the helper has no npm dependencies beyond Node's stdlib.
//
// Walks the string once so comment markers inside string literals (the
// only place they're legal raw characters in JSON) don't trigger the
// stripper. Trailing-comma removal happens after, by regex on the cleaned
// output, which is safe because string literals can't contain real commas
// followed by ] or } anymore (any such commas would've been escaped).
function stripJsonc(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const next = src[i + 1];
        // Line comment — skip until \n (keep the \n so line numbers in any
        // downstream parse error still line up roughly).
        if (c === '/' && next === '/') {
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        // Block comment — skip until */.
        if (c === '/' && next === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        // String literal — copy verbatim (including escapes) so embedded
        // // or /* don't trick the stripper.
        if (c === '"') {
            out += c;
            i++;
            while (i < n) {
                const ch = src[i];
                out += ch;
                i++;
                if (ch === '\\' && i < n) {
                    out += src[i];
                    i++;
                    continue;
                }
                if (ch === '"') break;
            }
            continue;
        }
        out += c;
        i++;
    }
    // Trailing commas before } or ].
    return out.replace(/,(\s*[}\]])/g, '$1');
}

function main() {
    const [, , inPath, outPath, baseImage] = process.argv;
    if (!inPath || !outPath || !baseImage) {
        die('usage: personalize-devcontainer.js <input> <output> <base-image>');
    }

    let src;
    try {
        src = fs.readFileSync(inPath, 'utf8');
    } catch (e) {
        die(`could not read ${inPath}: ${e.message}`);
    }

    let user;
    try {
        user = JSON.parse(stripJsonc(src));
    } catch (e) {
        die(`could not parse ${inPath} as JSONC: ${e.message}`);
    }

    if (user === null || typeof user !== 'object' || Array.isArray(user)) {
        die(`${inPath}: top-level must be an object`);
    }

    // Resolve relative feature paths so a "./my-feature" reference still
    // points at the user's checkout after the wrapper moves to a temp dir.
    const userDir = path.dirname(path.resolve(inPath));
    const features = {};
    if (user.features && typeof user.features === 'object') {
        for (const [key, value] of Object.entries(user.features)) {
            const isLocal = key.startsWith('./') || key.startsWith('../') ||
                key.startsWith('/') || key.match(/^[a-zA-Z]:/);
            features[isLocal ? path.resolve(userDir, key) : key] = value;
        }
    }

    const wrapper = {
        name: 'painapple-code-personalized',
        image: baseImage,
        features,
    };
    if (user.containerEnv && typeof user.containerEnv === 'object') {
        wrapper.containerEnv = user.containerEnv;
    }
    if (user.remoteEnv && typeof user.remoteEnv === 'object') {
        wrapper.remoteEnv = user.remoteEnv;
    }
    // remoteUser carries over too — features sometimes write to that user's
    // home, and the painapple-code base ships an `app` user. Honor the
    // user's choice if they specified one; otherwise keep our `app`.
    if (typeof user.remoteUser === 'string' && user.remoteUser.trim()) {
        wrapper.remoteUser = user.remoteUser;
    }

    try {
        fs.writeFileSync(outPath, JSON.stringify(wrapper, null, 2) + '\n');
    } catch (e) {
        die(`could not write ${outPath}: ${e.message}`);
    }

    const featureCount = Object.keys(features).length;
    process.stderr.write(
        `personalize-devcontainer: wrote ${outPath}\n` +
        `  base:     ${baseImage}\n` +
        `  features: ${featureCount}\n`
    );
    for (const k of Object.keys(features)) {
        process.stderr.write(`            - ${k}\n`);
    }
}

main();
