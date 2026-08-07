/**
 * Preview breadcrumb — VSCode-style clickable path in the preview header.
 *
 * Renders `state.currentPath` as clickable segments. Clicking a segment opens a
 * dropdown listing the contents of the directory that segment lives in (its
 * siblings), so you can quick-switch to another file without leaving the
 * preview. Folders in the dropdown drill deeper; files open in the preview.
 *
 * The dropdown is appended to <body> and positioned `fixed` so it escapes the
 * widget's clipping/rounded-corner overflow.
 */

import { state, fns } from './preview-state.js';
import S from '../strings.js';

// ─────────────────────────────────────────────────────────────────────────────
// SVG icons (static, safe to inject)
// ─────────────────────────────────────────────────────────────────────────────

const ICON_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
const ICON_FOLDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const ICON_FILE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const ICON_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>`;

const MAX_ITEMS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

function dirname(p) {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
}

function basename(p) {
    return p.split('/').filter(Boolean).pop() || '/';
}

/**
 * Build the ordered list of breadcrumb segments for the current file.
 * Segments are relative to cwd when the file lives under it, otherwise the full
 * absolute path is shown. Returns { rootPath, segs:[{name, path, isFile}] }.
 */
function buildSegments() {
    const abs = state.currentPath;
    if (!abs) return null;

    const cwd = (state.cwd && abs.startsWith(state.cwd + '/')) ? state.cwd : null;
    const rel = cwd ? abs.slice(cwd.length + 1) : abs;
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) return null;

    const rootPath = cwd || '/';
    let acc = cwd || '';
    const segs = parts.map((name, i) => {
        acc = (acc + '/' + name).replace(/\/+/g, '/');
        return { name, path: acc, isFile: i === parts.length - 1 };
    });
    return { rootPath, segs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory fetch
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDir(dir) {
    const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}`);
    if (!res.ok) {
        let detail;
        try { detail = (await res.json())?.detail; } catch { /* ignore */ }
        throw new Error(detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const files = data.files || [];
    // Directories first, then files; each name-sorted (case-insensitive).
    files.sort((a, b) => {
        if (!!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Open a file into the preview (routes images to the gallery via app router)
// ─────────────────────────────────────────────────────────────────────────────

function openFile(path) {
    closeMenu();
    if (window.app?.previewFile) {
        window.app.previewFile(path, { imageGallery: 'dir' });
    } else if (fns.openPreviewPath) {
        fns.openPreviewPath(path);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dropdown menu
// ─────────────────────────────────────────────────────────────────────────────

let activeMenu = null; // { el, anchor, cleanup }

export function closeMenu() {
    if (!activeMenu) return;
    activeMenu.cleanup();
    activeMenu.el.remove();
    activeMenu = null;
}

function positionMenu(el, anchor) {
    const r = anchor.getBoundingClientRect();
    el.style.left = `${r.left}px`;
    el.style.top = `${r.bottom + 4}px`;
    // Clamp within viewport after it has a measured size.
    requestAnimationFrame(() => {
        if (!el.isConnected) return;
        const m = el.getBoundingClientRect();
        let left = r.left;
        let top = r.bottom + 4;
        if (left + m.width > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - m.width - 8);
        }
        if (top + m.height > window.innerHeight - 8) {
            top = Math.max(8, r.top - m.height - 4); // flip above the anchor
        }
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    });
}

/**
 * Render the list body for directory `dir`, highlighting `currentPath`.
 * Re-rendered on drill-down and on filter input; the outer menu shell persists.
 */
async function renderList(ctx) {
    const { listEl } = ctx;
    listEl.innerHTML = `<div class="pbm-loading">${S.status?.loading || 'Loading…'}</div>`;

    let files;
    try {
        files = await fetchDir(ctx.dir);
    } catch (e) {
        listEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'pbm-error';
        err.textContent = S.preview?.breadcrumb?.load_failed || "Couldn't load folder";
        listEl.appendChild(err);
        return;
    }
    if (ctx.dir !== ctx.pendingDir) return; // a newer drill superseded this load

    ctx.items = [];
    listEl.innerHTML = '';

    // "Up" row — jump to the parent directory (unless we're at the root already).
    const parent = dirname(ctx.dir);
    if (parent && parent !== ctx.dir) {
        const up = document.createElement('button');
        up.className = 'pbm-item pbm-up';
        up.type = 'button';
        up.innerHTML = `<span class="pbm-icon">${ICON_UP}</span><span class="pbm-name">..</span>`;
        up.setAttribute('data-tooltip', S.preview?.breadcrumb?.parent_dir || 'Parent directory');
        up.addEventListener('click', () => drillInto(ctx, parent));
        listEl.appendChild(up);
        ctx.items.push(up);
    }

    const filter = ctx.filter.trim().toLowerCase();
    const matched = filter
        ? files.filter(f => f.name.toLowerCase().includes(filter))
        : files;

    if (!matched.length) {
        const empty = document.createElement('div');
        empty.className = 'pbm-empty';
        empty.textContent = S.preview?.breadcrumb?.empty || 'No matching items';
        listEl.appendChild(empty);
    }

    const shown = matched.slice(0, MAX_ITEMS);
    for (const f of shown) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'pbm-item' + (f.is_dir ? ' is-dir' : '');
        if (f.path === ctx.currentPath) item.classList.add('current');

        const icon = document.createElement('span');
        icon.className = 'pbm-icon';
        icon.innerHTML = f.is_dir ? ICON_FOLDER : ICON_FILE;
        const name = document.createElement('span');
        name.className = 'pbm-name';
        name.textContent = f.name;
        item.appendChild(icon);
        item.appendChild(name);

        if (f.is_dir) {
            item.addEventListener('click', () => drillInto(ctx, f.path));
        } else {
            item.addEventListener('click', () => openFile(f.path));
        }
        listEl.appendChild(item);
        ctx.items.push(item);
    }

    if (matched.length > shown.length) {
        const more = document.createElement('div');
        more.className = 'pbm-more';
        more.textContent = (S.preview?.breadcrumb?.more || '{n} more — type to filter')
            .replace('{n}', matched.length - shown.length);
        listEl.appendChild(more);
    }

    ctx.activeIndex = -1;
    // Bring the current file into view so you see where you are.
    const cur = listEl.querySelector('.pbm-item.current');
    if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: 'nearest' }));
}

function drillInto(ctx, dir) {
    ctx.dir = dir;
    ctx.pendingDir = dir;
    ctx.currentPath = null; // no highlight once we leave the original path
    ctx.filter = '';
    if (ctx.filterEl) ctx.filterEl.value = '';
    renderList(ctx);
    ctx.filterEl?.focus?.();
}

function setActive(ctx, next) {
    const buttons = ctx.items.filter(b => b.offsetParent !== null);
    if (!buttons.length) return;
    let idx = ctx.activeIndex + next;
    if (idx < 0) idx = buttons.length - 1;
    if (idx >= buttons.length) idx = 0;
    buttons.forEach(b => b.classList.remove('active'));
    const btn = buttons[idx];
    btn.classList.add('active');
    btn.scrollIntoView({ block: 'nearest' });
    ctx.activeIndex = idx;
}

function openMenu(anchor, dir, currentPath) {
    closeMenu();

    const el = document.createElement('div');
    el.className = 'preview-breadcrumb-menu';

    const header = document.createElement('div');
    header.className = 'pbm-header';
    const filterEl = document.createElement('input');
    filterEl.type = 'text';
    filterEl.className = 'pbm-filter';
    filterEl.placeholder = S.preview?.breadcrumb?.filter_placeholder || 'Filter…';
    filterEl.spellcheck = false;
    filterEl.autocomplete = 'off';
    header.appendChild(filterEl);

    const listEl = document.createElement('div');
    listEl.className = 'pbm-list';

    el.appendChild(header);
    el.appendChild(listEl);
    document.body.appendChild(el);

    const ctx = {
        el, filterEl, listEl,
        dir, pendingDir: dir, currentPath,
        filter: '', items: [], activeIndex: -1,
    };

    filterEl.addEventListener('input', () => {
        ctx.filter = filterEl.value;
        renderList(ctx);
    });
    filterEl.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(ctx, 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(ctx, -1); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            const visible = ctx.items.filter(b => b.offsetParent !== null);
            const btn = visible[ctx.activeIndex] || visible[0];
            btn?.click();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeMenu();
        }
    });

    // Close on outside interaction / viewport change.
    const onDown = (e) => {
        if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu();
    };
    const onScroll = (e) => {
        if (el.contains(e.target)) return; // scrolling inside the list is fine
        closeMenu();
    };
    const onResize = () => closeMenu();
    // Escape closes ONLY the dropdown. Intercept on window in the capture phase
    // so this runs before the app's global shortcut handler (a document-capture
    // keydown in shortcuts.js) which would otherwise close the whole preview
    // widget. Works whether or not the filter input has focus (we skip autofocus
    // on touch devices). Bound immediately — no defer — so no keypress slips by.
    const onKeydown = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        closeMenu();
    };
    window.addEventListener('keydown', onKeydown, true);
    // Defer the outside-interaction binds so the opening click doesn't
    // immediately close the menu.
    setTimeout(() => {
        document.addEventListener('pointerdown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
    }, 0);

    activeMenu = {
        el, anchor,
        cleanup() {
            window.removeEventListener('keydown', onKeydown, true);
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
        },
    };

    positionMenu(el, anchor);
    renderList(ctx);
    // Auto-focus the filter on precise pointers only (avoid popping the iPad
    // keyboard when the user just wants to tap a file).
    if (!window.matchMedia?.('(pointer: coarse)').matches) {
        requestAnimationFrame(() => filterEl.focus());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Breadcrumb rendering (called from updateWidgetHeader)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace the header title's text with an interactive breadcrumb.
 * @param {HTMLElement} titleEl - the widget's `.widget-title` element
 */
export function renderBreadcrumb(titleEl) {
    closeMenu();

    const model = buildSegments();
    if (!model) {
        titleEl.classList.remove('has-breadcrumb');
        titleEl.textContent = state.currentPath || '';
        return;
    }

    titleEl.classList.add('has-breadcrumb');
    titleEl.textContent = '';

    const bar = document.createElement('div');
    bar.className = 'preview-breadcrumb';

    // Root (home) segment → lists the root directory's own contents.
    const rootBtn = document.createElement('button');
    rootBtn.type = 'button';
    rootBtn.className = 'pb-segment pb-root';
    rootBtn.innerHTML = ICON_HOME;
    rootBtn.setAttribute('data-tooltip', model.rootPath);
    rootBtn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't start a widget drag
    rootBtn.addEventListener('click', () => openMenu(rootBtn, model.rootPath, model.segs[0]?.path || null));
    bar.appendChild(rootBtn);

    model.segs.forEach((seg) => {
        const sep = document.createElement('span');
        sep.className = 'pb-sep';
        sep.textContent = '/';
        bar.appendChild(sep);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pb-segment' + (seg.isFile ? ' is-file' : '');
        btn.textContent = seg.name;
        // A segment lists the contents of the directory it lives in (siblings).
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', () => openMenu(btn, dirname(seg.path), seg.path));
        bar.appendChild(btn);
    });

    titleEl.appendChild(bar);
    // Scroll to the end so the filename stays visible when the path overflows.
    requestAnimationFrame(() => { bar.scrollLeft = bar.scrollWidth; });
}
