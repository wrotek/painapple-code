/**
 * Zen Mode Widget — OLED-optimized focus view
 *
 * Fullscreen overlay with three views:
 *   Map    — SVG mind map of session work (files, tools, prompts)
 *   Review — Clean text summary with stats
 *   Act    — Decision buttons (continue, commit, new, exit)
 *
 * Designed for dark rooms with OLED displays. Pure black background,
 * warm amber accents, minimal chrome.
 */

import S from '../strings.js';
import { escapeHtml } from '../utils.js';
import { showToast } from '../context-menu.js';
import { engineAuthorLabel } from '../status-bar.js';

// ─────────────────────────────────────────────────────────────────────
// SVG Icons (inline to avoid dependencies)
// ─────────────────────────────────────────────────────────────────────

const ICONS = {
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    gitCommit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    gitDiff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3v18M3 12h18"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
};

// ─────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────

let overlayEl = null;
let activeTab = 'map';
let sessionData = null;
let selectedNode = null;
let detailCard = null;

// ─────────────────────────────────────────────────────────────────────
// Data Extraction
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract structured session data from the active session's messages.
 * Builds a graph of turns, files, and tools for the mind map.
 */
function extractSessionData(session) {
    if (!session?.messages?.length) return null;

    const turns = [];
    const allFiles = new Map();  // path → {action, turns}
    const allTools = new Map();  // name → count
    let currentTurn = null;

    for (const msg of session.messages) {
        // User prompt starts a new turn
        if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
            currentTurn = {
                index: turns.length,
                prompt: msg.content.trim(),
                files: new Map(),
                tools: new Map(),
                summary: '',
            };
            turns.push(currentTurn);
        }

        // Thinking blocks contain tool usage
        if (msg.role === 'thinking' && msg.tools && currentTurn) {
            for (const tool of msg.tools) {
                const name = tool.toolName || tool.tool_name || '';
                if (!name) continue;
                currentTurn.tools.set(name, (currentTurn.tools.get(name) || 0) + 1);
                allTools.set(name, (allTools.get(name) || 0) + 1);

                const fp = tool.toolInput?.file_path || tool.tool_input?.file_path;
                if (fp) {
                    const action = (name === 'Write' || name === 'Edit') ? 'edited'
                        : name === 'Read' ? 'read' : 'used';
                    currentTurn.files.set(fp, action);
                    if (!allFiles.has(fp) || action === 'edited') {
                        allFiles.set(fp, { action, turn: currentTurn.index });
                    }
                }
            }
        }

        // Tool messages (standalone)
        if (msg.role === 'tool' && currentTurn) {
            const name = msg.toolName || msg.tool_name || '';
            if (name) {
                currentTurn.tools.set(name, (currentTurn.tools.get(name) || 0) + 1);
                allTools.set(name, (allTools.get(name) || 0) + 1);
            }
            const fp = msg.toolInput?.file_path || msg.tool_input?.file_path;
            if (fp) {
                const action = (name === 'Write' || name === 'Edit') ? 'edited'
                    : name === 'Read' ? 'read' : 'used';
                currentTurn.files.set(fp, action);
                if (!allFiles.has(fp) || action === 'edited') {
                    allFiles.set(fp, { action, turn: currentTurn.index });
                }
            }
        }

        // Turn summary messages
        if (msg.role === 'turn_summary' && currentTurn) {
            if (msg.changedFiles) {
                for (const f of msg.changedFiles) {
                    const fp = typeof f === 'string' ? f : f.path || f.file;
                    if (fp) {
                        currentTurn.files.set(fp, 'edited');
                        allFiles.set(fp, { action: 'edited', turn: currentTurn.index });
                    }
                }
            }
        }

        // Assistant text → turn summary
        if (msg.role === 'assistant' && currentTurn && !currentTurn.summary) {
            const text = typeof msg.content === 'string' ? msg.content
                : Array.isArray(msg.content)
                    ? msg.content.find(b => b.type === 'text')?.text || ''
                    : '';
            if (text) {
                currentTurn.summary = text.slice(0, 200).replace(/\n+/g, ' ').trim();
            }
        }
    }

    // Session stats
    const stats = {
        turns: turns.length,
        filesEdited: [...allFiles.values()].filter(f => f.action === 'edited').length,
        filesRead: [...allFiles.values()].filter(f => f.action === 'read').length,
        toolCalls: [...allTools.values()].reduce((a, b) => a + b, 0),
        cost: session.totalCost || 0,
        messages: session.messages.length,
    };

    return { turns, allFiles, allTools, stats };
}

// ─────────────────────────────────────────────────────────────────────
// Mind Map — SVG radial layout
// ─────────────────────────────────────────────────────────────────────

function computeLayout(data, width, height) {
    const cx = width / 2;
    const cy = height / 2;
    const nodes = [];
    const edges = [];

    if (!data || !data.turns.length) return { nodes, edges };

    // Center: session node
    nodes.push({
        id: 'session',
        x: cx, y: cy,
        type: 'session',
        label: 'Session',
        r: 22,
        color: '#b8962f',
    });

    const turnCount = data.turns.length;
    const turnRadius = Math.min(width, height) * (turnCount <= 3 ? 0.22 : 0.28);

    data.turns.forEach((turn, i) => {
        const angle = (i / turnCount) * Math.PI * 2 - Math.PI / 2;
        const tx = cx + Math.cos(angle) * turnRadius;
        const ty = cy + Math.sin(angle) * turnRadius;
        const turnId = `turn-${i}`;
        const promptLabel = turn.prompt.length > 35
            ? turn.prompt.slice(0, 33) + '...'
            : turn.prompt;

        nodes.push({
            id: turnId,
            x: tx, y: ty,
            type: 'turn',
            label: promptLabel,
            r: 14,
            color: '#8a7a5a',
            data: turn,
        });

        edges.push({ from: 'session', to: turnId });

        // File nodes branching off this turn
        const files = [...turn.files.entries()];
        const fileRadius = Math.min(turnRadius * 0.45, 80);
        const maxFiles = 6;
        const visibleFiles = files.slice(0, maxFiles);
        const spread = visibleFiles.length > 1
            ? Math.min(0.35, Math.PI / (turnCount || 1)) : 0;

        visibleFiles.forEach(([fp, action], j) => {
            const mid = (visibleFiles.length - 1) / 2;
            const fAngle = angle + (j - mid) * spread;
            const fx = tx + Math.cos(fAngle) * fileRadius;
            const fy = ty + Math.sin(fAngle) * fileRadius;
            const fileId = `${turnId}-f-${j}`;
            const fileName = fp.split('/').pop();

            nodes.push({
                id: fileId,
                x: fx, y: fy,
                type: 'file',
                label: fileName,
                r: 7,
                color: action === 'edited' ? '#665530' : '#3a3a30',
                data: { path: fp, action },
            });

            edges.push({ from: turnId, to: fileId });
        });

        if (files.length > maxFiles) {
            const extraAngle = angle + ((visibleFiles.length - 0.5) - (visibleFiles.length - 1) / 2) * spread;
            const ex = tx + Math.cos(extraAngle) * fileRadius;
            const ey = ty + Math.sin(extraAngle) * fileRadius;
            nodes.push({
                id: `${turnId}-more`,
                x: ex, y: ey,
                type: 'file',
                label: `+${files.length - maxFiles}`,
                r: 7,
                color: '#2a2218',
            });
        }
    });

    return { nodes, edges };
}

function buildBezier(n1, n2) {
    const dx = n2.x - n1.x;
    const dy = n2.y - n1.y;
    const cx1 = n1.x + dx * 0.4;
    const cy1 = n1.y + dy * 0.1;
    const cx2 = n1.x + dx * 0.6;
    const cy2 = n2.y - dy * 0.1;
    return `M${n1.x},${n1.y} C${cx1},${cy1} ${cx2},${cy2} ${n2.x},${n2.y}`;
}

function renderMindMap(container, data) {
    const rect = container.getBoundingClientRect();
    const w = rect.width || 800;
    const h = rect.height || 600;
    const layout = computeLayout(data, w, h);
    const nodeMap = new Map(layout.nodes.map(n => [n.id, n]));

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'zen-map-svg');

    // Defs: glow filter
    svg.innerHTML = `
        <defs>
            <filter id="zen-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur"/>
                <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <radialGradient id="zen-center-glow">
                <stop offset="0%" stop-color="rgba(184,150,47,0.15)"/>
                <stop offset="100%" stop-color="rgba(184,150,47,0)"/>
            </radialGradient>
        </defs>
    `;

    // Center glow ring
    const centerNode = nodeMap.get('session');
    if (centerNode) {
        const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pulse.setAttribute('cx', centerNode.x);
        pulse.setAttribute('cy', centerNode.y);
        pulse.setAttribute('r', 60);
        pulse.setAttribute('fill', 'url(#zen-center-glow)');
        pulse.setAttribute('class', 'zen-pulse-ring');
        svg.appendChild(pulse);
    }

    // Edges
    layout.edges.forEach((edge, i) => {
        const n1 = nodeMap.get(edge.from);
        const n2 = nodeMap.get(edge.to);
        if (!n1 || !n2) return;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', buildBezier(n1, n2));
        path.setAttribute('class', 'zen-edge-path');

        // Staggered entrance
        setTimeout(() => {
            const len = path.getTotalLength?.() || 100;
            path.style.setProperty('--path-length', len);
            path.classList.add('visible', 'animate');
        }, 200 + i * 80);

        svg.appendChild(path);
    });

    // Nodes
    layout.nodes.forEach((node, i) => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'zen-node');
        g.setAttribute('data-id', node.id);

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', node.x);
        circle.setAttribute('cy', node.y);
        circle.setAttribute('r', node.r);
        circle.setAttribute('fill', node.color);
        circle.setAttribute('class', 'zen-node-circle');

        if (node.type === 'session') {
            circle.setAttribute('filter', 'url(#zen-glow)');
        }

        g.appendChild(circle);

        // Label
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', node.x);
        label.setAttribute('y', node.y + node.r + 8);
        label.setAttribute('class', 'zen-node-label');
        label.textContent = node.label;
        g.appendChild(label);

        // Staggered entrance
        setTimeout(() => g.classList.add('visible'), 100 + i * 60);

        // Click handler
        g.addEventListener('click', (e) => {
            e.stopPropagation();
            showNodeDetail(node, container);
        });

        svg.appendChild(g);
    });

    // Click on background dismisses detail card
    svg.addEventListener('click', () => hideNodeDetail());

    container.innerHTML = '';
    container.appendChild(svg);
}

function showNodeDetail(node, mapContainer) {
    hideNodeDetail();
    selectedNode = node.id;

    // Highlight selected node in SVG
    const svgNode = mapContainer.querySelector(`[data-id="${node.id}"]`);
    if (svgNode) svgNode.classList.add('selected');

    const card = document.createElement('div');
    card.className = 'zen-detail-card';

    let html = '';

    if (node.type === 'session') {
        const data = sessionData;
        html = `
            <div class="zen-detail-title">Session Overview</div>
            <div class="zen-detail-meta">
                ${data?.stats?.turns || 0} turns &middot;
                ${data?.stats?.filesEdited || 0} files edited &middot;
                ${data?.stats?.toolCalls || 0} tool calls
                ${data?.stats?.cost ? ` &middot; $${data.stats.cost.toFixed(3)}` : ''}
            </div>
        `;
    } else if (node.type === 'turn' && node.data) {
        const turn = node.data;
        html = `
            <div class="zen-detail-title">${escapeHtml(turn.prompt)}</div>
            ${turn.summary ? `<div class="zen-detail-meta" style="margin-top:6px">${escapeHtml(turn.summary)}</div>` : ''}
            ${turn.files.size ? `
                <div class="zen-detail-files">
                    ${[...turn.files.entries()].slice(0, 8).map(([fp, action]) =>
                        `<div class="zen-detail-file">${action === 'edited' ? '~' : action === 'read' ? '>' : '?'} ${fp.split('/').pop()}</div>`
                    ).join('')}
                </div>
            ` : ''}
        `;
    } else if (node.type === 'file' && node.data) {
        html = `
            <div class="zen-detail-title">${escapeHtml(node.data.path.split('/').pop())}</div>
            <div class="zen-detail-meta">${escapeHtml(node.data.path)}</div>
            <div class="zen-detail-meta" style="margin-top:4px;color:var(--zen-accent-dim)">${node.data.action}</div>
        `;
    }

    card.innerHTML = html;

    // Position near the node
    const rect = mapContainer.getBoundingClientRect();
    const svgRect = mapContainer.querySelector('svg')?.getBoundingClientRect() || rect;
    const scaleX = svgRect.width / (parseFloat(mapContainer.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[2]) || svgRect.width);
    const scaleY = svgRect.height / (parseFloat(mapContainer.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[3]) || svgRect.height);

    let left = svgRect.left - rect.left + node.x * scaleX + 16;
    let top = svgRect.top - rect.top + node.y * scaleY - 20;

    // Keep on screen
    if (left + 320 > rect.width) left = left - 340;
    if (top + 200 > rect.height) top = rect.height - 220;
    if (top < 10) top = 10;

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;

    mapContainer.appendChild(card);
    detailCard = card;
    requestAnimationFrame(() => card.classList.add('visible'));
}

function hideNodeDetail() {
    if (detailCard) {
        detailCard.remove();
        detailCard = null;
    }
    selectedNode = null;
    // Remove selected class from all nodes
    overlayEl?.querySelectorAll('.zen-node.selected').forEach(n => n.classList.remove('selected'));
}

// ─────────────────────────────────────────────────────────────────────
// Summary View
// ─────────────────────────────────────────────────────────────────────

function renderSummary(container, data, session) {
    if (!data) {
        container.innerHTML = `<div class="zen-empty">${ICONS.compass}<div class="zen-empty-text">${S.zen_mode?.empty || 'No session data'}</div></div>`;
        return;
    }

    const s = data.stats;
    const sessionName = session?.name || 'Session';

    // Build file list (edited files first, then read)
    const editedFiles = [...data.allFiles.entries()]
        .filter(([, v]) => v.action === 'edited')
        .map(([path, v]) => ({ path, ...v }));
    const readFiles = [...data.allFiles.entries()]
        .filter(([, v]) => v.action === 'read')
        .map(([path, v]) => ({ path, ...v }));

    // Build turn timeline
    const timeline = data.turns.map((t, i) => {
        const filesCount = t.files.size;
        const toolsCount = [...t.tools.values()].reduce((a, b) => a + b, 0);
        return `<div class="zen-file-item" style="border-left:2px solid var(--zen-accent-dim);padding-left:12px">
            <span style="color:var(--zen-text-dim);font-size:10px;min-width:20px">${i + 1}.</span>
            <span style="flex:1">${escapeHtml(t.prompt.slice(0, 80))}${t.prompt.length > 80 ? '...' : ''}</span>
            ${filesCount ? `<span style="color:var(--zen-accent-dim);font-size:10px">${filesCount} files</span>` : ''}
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="zen-summary">
            <div class="zen-summary-section">
                <div class="zen-summary-heading">${S.zen_mode?.stats_heading || 'Session'}</div>
                <div class="zen-stat-grid">
                    <div class="zen-stat">
                        <div class="zen-stat-value">${s.turns}</div>
                        <div class="zen-stat-label">${S.zen_mode?.stat_turns || 'Turns'}</div>
                    </div>
                    <div class="zen-stat">
                        <div class="zen-stat-value">${s.filesEdited}</div>
                        <div class="zen-stat-label">${S.zen_mode?.stat_files || 'Files Edited'}</div>
                    </div>
                    <div class="zen-stat">
                        <div class="zen-stat-value">${s.toolCalls}</div>
                        <div class="zen-stat-label">${S.zen_mode?.stat_tools || 'Tool Calls'}</div>
                    </div>
                    ${s.cost ? `<div class="zen-stat">
                        <div class="zen-stat-value">$${s.cost.toFixed(2)}</div>
                        <div class="zen-stat-label">${S.zen_mode?.stat_cost || 'Cost'}</div>
                    </div>` : ''}
                </div>
            </div>

            ${timeline ? `
            <div class="zen-summary-section">
                <div class="zen-summary-heading">${S.zen_mode?.turns_heading || 'Conversation Flow'}</div>
                <div class="zen-file-list">${timeline}</div>
            </div>` : ''}

            ${editedFiles.length ? `
            <div class="zen-summary-section">
                <div class="zen-summary-heading">${S.zen_mode?.files_edited_heading || 'Files Changed'}</div>
                <div class="zen-file-list">
                    ${editedFiles.map(f => `
                        <div class="zen-file-item">
                            <span class="zen-file-action edited">edit</span>
                            <span class="zen-file-path">${escapeHtml(f.path)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}

            ${readFiles.length ? `
            <div class="zen-summary-section">
                <div class="zen-summary-heading">${S.zen_mode?.files_read_heading || 'Files Read'}</div>
                <div class="zen-file-list">
                    ${readFiles.slice(0, 20).map(f => `
                        <div class="zen-file-item">
                            <span class="zen-file-action read">read</span>
                            <span class="zen-file-path">${escapeHtml(f.path)}</span>
                        </div>
                    `).join('')}
                    ${readFiles.length > 20 ? `<div class="zen-file-item" style="color:var(--zen-text-dim)">+${readFiles.length - 20} more</div>` : ''}
                </div>
            </div>` : ''}
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────
// Actions View
// ─────────────────────────────────────────────────────────────────────

function renderActions(container) {
    container.innerHTML = `
        <div class="zen-actions">
            <div class="zen-actions-prompt">${S.zen_mode?.decide_prompt || 'What would you like to do next?'}</div>
            <div class="zen-actions-grid">
                <button class="zen-action-btn" data-action="continue">
                    ${ICONS.play}
                    <span class="zen-action-label">${S.zen_mode?.action_continue || 'Continue'}</span>
                    <span class="zen-action-hint">${S.zen_mode?.action_continue_hint || 'Keep working in this session'}</span>
                </button>
                <button class="zen-action-btn" data-action="diff">
                    ${ICONS.gitDiff}
                    <span class="zen-action-label">${S.zen_mode?.action_diff || 'View Diff'}</span>
                    <span class="zen-action-hint">${S.zen_mode?.action_diff_hint || 'See all changes made'}</span>
                </button>
                <button class="zen-action-btn" data-action="commit">
                    ${ICONS.gitCommit}
                    <span class="zen-action-label">${S.zen_mode?.action_commit || 'Commit'}</span>
                    <span class="zen-action-hint">${S.zen_mode?.action_commit_hint || 'Ask Claude to commit changes'}</span>
                </button>
                <button class="zen-action-btn" data-action="new">
                    ${ICONS.plus}
                    <span class="zen-action-label">${S.zen_mode?.action_new || 'New Session'}</span>
                    <span class="zen-action-hint">${S.zen_mode?.action_new_hint || 'Start fresh'}</span>
                </button>
            </div>
        </div>
    `;

    // Action handlers
    container.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => handleAction(btn.dataset.action));
    });
}

function handleAction(action) {
    closeZen();

    // Small delay to let the exit animation complete
    setTimeout(() => {
        switch (action) {
            case 'continue':
                // Focus the input
                document.querySelector('#user-input')?.focus();
                break;
            case 'diff':
                // Open git widget (contains diff view)
                try {
                    window.app?.toggleGitPanel?.();
                } catch { /* ignore */ }
                break;
            case 'commit':
                // Send /commit command
                if (window.app?.sendMessage) {
                    window.app.sendMessage('/commit');
                }
                break;
            case 'new':
                window.app?.createSession?.();
                break;
        }
    }, 350);
}

// ─────────────────────────────────────────────────────────────────────
// Chat View — Clean conversation reader
// ─────────────────────────────────────────────────────────────────────

function renderChat(container, session) {
    if (!session?.messages?.length) {
        container.innerHTML = `<div class="zen-empty">${ICONS.compass}<div class="zen-empty-text">${S.zen_mode?.empty_chat || 'No messages yet'}</div></div>`;
        return;
    }

    const msgs = session.messages;
    const blocks = [];
    let pendingTools = [];

    // Collapse messages into readable blocks:
    // user text → show
    // assistant text → show (rendered markdown-lite)
    // tool_use/tool_result → collapse into one-liner group
    // thinking → dim expandable block
    for (const msg of msgs) {
        const content = msg.content;

        // User prompt
        if (msg.role === 'user' && typeof content === 'string' && content.trim()) {
            if (pendingTools.length) {
                blocks.push({ type: 'tools', tools: [...pendingTools] });
                pendingTools = [];
            }
            blocks.push({ type: 'user', text: content.trim() });
            continue;
        }

        // User with array content (tool results)
        if (msg.role === 'user' && Array.isArray(content)) {
            for (const part of content) {
                if (part.type === 'tool_result') {
                    // Find matching tool_use
                    const existing = pendingTools.find(t => t.id === part.tool_use_id);
                    if (existing) {
                        existing.result = typeof part.content === 'string'
                            ? part.content.slice(0, 200) : '(result)';
                    }
                }
            }
            continue;
        }

        // Assistant
        if (msg.role === 'assistant') {
            const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }];

            for (const part of parts) {
                if (part.type === 'text' && part.text?.trim()) {
                    if (pendingTools.length) {
                        blocks.push({ type: 'tools', tools: [...pendingTools] });
                        pendingTools = [];
                    }
                    blocks.push({ type: 'assistant', text: part.text.trim() });
                } else if (part.type === 'tool_use') {
                    const toolName = part.name || 'Tool';
                    const filePath = part.input?.file_path || part.input?.command?.slice(0, 60) || '';
                    pendingTools.push({
                        id: part.id,
                        name: toolName,
                        detail: filePath,
                    });
                } else if (part.type === 'thinking' && part.thinking) {
                    if (pendingTools.length) {
                        blocks.push({ type: 'tools', tools: [...pendingTools] });
                        pendingTools = [];
                    }
                    blocks.push({ type: 'thinking', text: part.thinking.slice(0, 500) });
                }
            }
            continue;
        }

        // Result/cost bars
        if (msg.type === 'result' || msg.role === 'result') {
            if (pendingTools.length) {
                blocks.push({ type: 'tools', tools: [...pendingTools] });
                pendingTools = [];
            }
            const cost = msg.cost_usd || msg.costUsd;
            if (cost) {
                blocks.push({ type: 'divider', cost });
            }
        }
    }

    // Flush remaining tools
    if (pendingTools.length) {
        blocks.push({ type: 'tools', tools: [...pendingTools] });
    }

    // Render blocks
    let html = '<div class="zen-chat">';

    for (const block of blocks) {
        switch (block.type) {
            case 'user':
                html += `<div class="zen-chat-msg zen-chat-user">
                    <div class="zen-chat-role">you</div>
                    <div class="zen-chat-text">${escapeHtml(block.text)}</div>
                </div>`;
                break;

            case 'assistant':
                html += `<div class="zen-chat-msg zen-chat-assistant">
                    <div class="zen-chat-role">${escapeHtml(engineAuthorLabel(session))}</div>
                    <div class="zen-chat-text">${formatZenMarkdown(block.text)}</div>
                </div>`;
                break;

            case 'tools':
                html += `<div class="zen-chat-tools">`;
                for (const tool of block.tools) {
                    const icon = tool.name === 'Read' ? '&gt;' : tool.name === 'Edit' ? '~' : tool.name === 'Write' ? '+' : tool.name === 'Bash' ? '$' : '&bull;';
                    const detail = tool.detail ? tool.detail.split('/').pop() : '';
                    html += `<div class="zen-chat-tool"><span class="zen-tool-icon">${icon}</span><span class="zen-tool-name">${escapeHtml(tool.name)}</span>${detail ? `<span class="zen-tool-detail">${escapeHtml(detail)}</span>` : ''}</div>`;
                }
                html += `</div>`;
                break;

            case 'thinking':
                html += `<details class="zen-chat-thinking">
                    <summary>thinking...</summary>
                    <div class="zen-chat-thinking-text">${escapeHtml(block.text)}</div>
                </details>`;
                break;

            case 'divider':
                html += `<div class="zen-chat-divider"><span class="zen-chat-cost">$${block.cost.toFixed(3)}</span></div>`;
                break;
        }
    }

    html += '</div>';
    container.innerHTML = html;

    // Scroll to bottom
    const chatEl = container.querySelector('.zen-chat');
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
}

/**
 * Minimal markdown: **bold**, `code`, ```code blocks```, line breaks.
 * Keeps it readable without pulling in the full markdown renderer.
 */
function formatZenMarkdown(text) {
    return escapeHtml(text)
        .replace(/```[\s\S]*?```/g, m => {
            const inner = m.slice(3, -3).replace(/^\w*\n/, '');
            return `<pre class="zen-code-block">${inner}</pre>`;
        })
        .replace(/`([^`]+)`/g, '<code class="zen-inline-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}

// ─────────────────────────────────────────────────────────────────────
// Main Render / Lifecycle
// ─────────────────────────────────────────────────────────────────────

const TABS = [
    { id: 'chat', label: 'Chat' },
    { id: 'map', label: 'Map' },
    { id: 'review', label: 'Review' },
    { id: 'act', label: 'Act' },
];

function renderZen(session) {
    // Extract data
    sessionData = extractSessionData(session);

    const overlay = document.createElement('div');
    overlay.className = 'zen-overlay';

    const sessionName = session?.name || 'Session';

    // Top bar
    overlay.innerHTML = `
        <div class="zen-topbar">
            <div class="zen-session-name">${escapeHtml(sessionName)}</div>
            <div class="zen-tab-dots">
                ${TABS.map(t => `
                    <button class="zen-tab-dot ${t.id === activeTab ? 'active' : ''}"
                            data-tab="${t.id}" data-label="${t.label}"
                            data-tooltip="${t.label}"></button>
                `).join('')}
            </div>
            <button class="zen-close-btn" data-tooltip="Exit Zen (Esc)">${ICONS.x}</button>
        </div>
        <div class="zen-content">
            ${TABS.map(t => `
                <div class="zen-view ${t.id === activeTab ? 'active' : ''}" data-view="${t.id}">
                    ${t.id === 'map' ? '<div class="zen-map-container"></div>' : ''}
                </div>
            `).join('')}
        </div>
    `;

    // Event: tab switching
    overlay.querySelectorAll('.zen-tab-dot').forEach(dot => {
        dot.addEventListener('click', () => switchTab(dot.dataset.tab, overlay, session));
    });

    // Event: close
    overlay.querySelector('.zen-close-btn').addEventListener('click', closeZen);

    // Event: ESC key + arrow keys for tab nav
    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeZen();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            cycleZenTab(e.key === 'ArrowRight' ? 1 : -1, overlay, session);
        }
    };
    overlay._keyHandler = keyHandler;
    document.addEventListener('keydown', keyHandler, true);

    // Gesture: trackpad two-finger swipe (wheel events)
    let wheelAccum = 0;
    let wheelTimer = null;
    let wheelCooldown = false;
    const WHEEL_THRESHOLD = 120;
    const WHEEL_COOLDOWN = 400;

    const wheelHandler = (e) => {
        // Only handle horizontal scroll
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        e.preventDefault();
        e.stopPropagation();

        if (wheelCooldown) return;

        wheelAccum += e.deltaX;
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => { wheelAccum = 0; }, 150);

        if (Math.abs(wheelAccum) >= WHEEL_THRESHOLD) {
            cycleZenTab(wheelAccum > 0 ? 1 : -1, overlay, session);
            wheelAccum = 0;
            wheelCooldown = true;
            setTimeout(() => { wheelCooldown = false; }, WHEEL_COOLDOWN);
        }
    };
    overlay.addEventListener('wheel', wheelHandler, { passive: false });

    // Gesture: touch swipe (finger)
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;

    const touchStartHandler = (e) => {
        if (e.touches.length !== 1) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
    };

    const touchEndHandler = (e) => {
        if (!touchStartTime) return;
        const dt = Date.now() - touchStartTime;
        if (dt > 500) { touchStartTime = 0; return; }

        const touch = e.changedTouches[0];
        const dx = touch.clientX - touchStartX;
        const dy = touch.clientY - touchStartY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        // Must be primarily horizontal, > 80px distance
        if (absDx > 80 && absDx > absDy * 2) {
            cycleZenTab(dx < 0 ? 1 : -1, overlay, session);
        }
        touchStartTime = 0;
    };

    overlay.addEventListener('touchstart', touchStartHandler, { passive: true });
    overlay.addEventListener('touchend', touchEndHandler, { passive: true });

    // Store handlers for cleanup
    overlay._wheelHandler = wheelHandler;
    overlay._touchStartHandler = touchStartHandler;
    overlay._touchEndHandler = touchEndHandler;

    document.body.appendChild(overlay);
    overlayEl = overlay;

    // Animate in
    requestAnimationFrame(() => {
        overlay.classList.add('zen-visible');
        // Render initial view after fade-in starts
        setTimeout(() => renderActiveView(overlay, session), 100);
    });
}

function cycleZenTab(direction, overlay, session) {
    const currentIdx = TABS.findIndex(t => t.id === activeTab);
    const newIdx = (currentIdx + direction + TABS.length) % TABS.length;
    switchTab(TABS[newIdx].id, overlay, session);
}

function switchTab(tabId, overlay, session) {
    if (activeTab === tabId) return;
    activeTab = tabId;
    hideNodeDetail();

    // Update dots
    overlay.querySelectorAll('.zen-tab-dot').forEach(d => {
        d.classList.toggle('active', d.dataset.tab === tabId);
    });

    // Update views
    overlay.querySelectorAll('.zen-view').forEach(v => {
        v.classList.toggle('active', v.dataset.view === tabId);
    });

    renderActiveView(overlay, session);
}

function renderActiveView(overlay, session) {
    const view = overlay.querySelector(`.zen-view[data-view="${activeTab}"]`);
    if (!view) return;

    switch (activeTab) {
        case 'chat':
            renderChat(view, session);
            break;
        case 'map': {
            const mapContainer = view.querySelector('.zen-map-container');
            if (mapContainer) {
                if (!sessionData || !sessionData.turns.length) {
                    mapContainer.innerHTML = `<div class="zen-empty">${ICONS.compass}<div class="zen-empty-text">${S.zen_mode?.empty_map || 'No turns yet. Start a conversation to see the map.'}</div></div>`;
                } else {
                    renderMindMap(mapContainer, sessionData);
                }
            }
            break;
        }
        case 'review':
            renderSummary(view, sessionData, session);
            break;
        case 'act':
            renderActions(view);
            break;
    }
}

export function openZen() {
    if (overlayEl) return; // Already open
    activeTab = 'chat';
    const session = window.app?.activeSession;
    renderZen(session);
}

export function closeZen() {
    if (!overlayEl) return;

    // Remove event handlers
    if (overlayEl._keyHandler) {
        document.removeEventListener('keydown', overlayEl._keyHandler, true);
    }
    if (overlayEl._wheelHandler) {
        overlayEl.removeEventListener('wheel', overlayEl._wheelHandler);
    }
    if (overlayEl._touchStartHandler) {
        overlayEl.removeEventListener('touchstart', overlayEl._touchStartHandler);
        overlayEl.removeEventListener('touchend', overlayEl._touchEndHandler);
    }

    overlayEl.classList.remove('zen-visible');
    const el = overlayEl;
    overlayEl = null;
    sessionData = null;
    selectedNode = null;
    detailCard = null;

    setTimeout(() => el.remove(), 600);
}

export function toggleZen() {
    if (overlayEl) closeZen();
    else openZen();
}

export function isZenOpen() {
    return !!overlayEl;
}

// ─────────────────────────────────────────────────────────────────────
// Widget Registration (for quick-actions & shortcuts integration)
// ─────────────────────────────────────────────────────────────────────

export function registerZenWidget() {
    // Zen mode is NOT a standard widget — it's a fullscreen overlay.
    // We register it as a lightweight entry so quick-actions and shortcuts can find it.
    // The actual rendering bypasses the widget system for true fullscreen control.

    // Make toggle available globally for shortcuts
    window.toggleZenMode = toggleZen;
    window.isZenModeOpen = isZenOpen;
}
