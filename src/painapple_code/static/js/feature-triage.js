/**
 * Feature-triage tool behaviour. Extracted from an inline <script> in
 * feature-triage.html so the CSP can keep script-src free of 'unsafe-inline'.
 */
// ── State ──────────────────────────────────────────────────
let FEATURES = [], GROUPS = [], FILE_MAP = {};
let decisions = {}, notes = {};
let currentView = 'grid';
let searchQuery = '';
let gridFilter = 'all';
let detailFeatureId = null;
let detailList = []; // filtered list for prev/next
let collapsedGroups = {};

// ── Data loading ───────────────────────────────────────────
async function loadData() {
  const [featRes, triageRes] = await Promise.all([
    fetch('/api/features').then(r => r.json()),
    fetch('/api/triage-state').then(r => r.json())
  ]);
  GROUPS = featRes.groups || [];
  FEATURES = featRes.features || [];
  decisions = triageRes.decisions || {};
  notes = triageRes.notes || {};
  buildFileMap();
}

function buildFileMap() {
  FILE_MAP = {};
  for (const f of FEATURES) {
    const allFiles = [
      ...(f.primary_files || []).map(p => ({ file: p, type: 'primary' })),
      ...(f.supporting_files || []).map(p => ({ file: p, type: 'supporting' })),
    ];
    // Also include spec file inventory
    if (f.spec && f.spec.file_inventory) {
      for (const fi of f.spec.file_inventory) {
        const exists = allFiles.find(a => a.file === fi.file || fi.file.endsWith(a.file) || a.file.endsWith(fi.file));
        if (!exists) allFiles.push({ file: fi.file, type: 'inventory', lines: fi.lines, role: fi.role });
      }
    }
    for (const af of allFiles) {
      if (!FILE_MAP[af.file]) FILE_MAP[af.file] = { features: [], lines: af.lines, role: af.role };
      FILE_MAP[af.file].features.push({ id: f.id, name: f.name, type: af.type });
      if (af.lines && !FILE_MAP[af.file].lines) FILE_MAP[af.file].lines = af.lines;
      if (af.role && !FILE_MAP[af.file].role) FILE_MAP[af.file].role = af.role;
    }
  }
}

// ── Persistence ────────────────────────────────────────────
let saveTimeout = null;
function persistState() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fetch('/api/triage-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions, notes })
    });
  }, 500);
}

// ── Search ─────────────────────────────────────────────────
function matchesSearch(f, q) {
  if (!q) return true;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let haystack = `${f.id} ${f.name} ${f.group} ${f.priority} ${f.complexity} ${notes[f.id]||''} ${decisions[f.id]||''}`;
  if (f.spec) {
    haystack += ` ${f.spec.what_it_does} ${f.spec.why_it_exists}`;
    if (f.spec.key_behaviors) haystack += ' ' + f.spec.key_behaviors.join(' ');
    if (f.spec.edge_cases) haystack += ' ' + f.spec.edge_cases;
  }
  if (f.tags) haystack += ' ' + f.tags.join(' ');
  if (f.primary_files) haystack += ' ' + f.primary_files.join(' ');
  haystack = haystack.toLowerCase();
  return terms.every(t => {
    if (t.startsWith('-') && t.length > 1) return !haystack.includes(t.slice(1));
    return haystack.includes(t);
  });
}

function getFilteredFeatures() {
  return FEATURES.filter(f => {
    if (!matchesSearch(f, searchQuery)) return false;
    if (gridFilter === 'all') return true;
    if (gridFilter === 'pending') return !decisions[f.id];
    return decisions[f.id] === gridFilter;
  });
}

// ── View management ────────────────────────────────────────
function showView(view, skipHash) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.header-nav button').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.header-nav button[data-view="${view}"]`);
  if (btn) btn.classList.add('active');

  if (view === 'detail') {
    document.getElementById('detail-view').classList.add('active');
    document.getElementById('export-bar').style.display = 'none';
  } else {
    document.getElementById(`${view}-view`).classList.add('active');
    document.getElementById('export-bar').style.display = (view === 'summary') ? 'flex' : 'none';
    if (view === 'grid') renderGrid();
    if (view === 'files') renderFiles();
    if (view === 'summary') renderSummary();
  }
  if (!skipHash) updateHash();
}

function updateHash() {
  let hash = currentView;
  if (currentView === 'detail' && detailFeatureId) hash = `feature/${detailFeatureId}`;
  history.replaceState(null, '', '#' + hash);
}

function restoreFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return false;
  const parts = hash.split('/');
  if (parts[0] === 'feature' && parts[1]) {
    openDetail(parts[1]);
    return true;
  }
  if (parts[0] === 'tiles') {
    // compat with old triage URLs
    if (parts[1]) { openDetail(parts[1]); return true; }
    showView('grid', true);
    return true;
  }
  if (['grid', 'files', 'summary'].includes(parts[0])) {
    showView(parts[0], true);
    return true;
  }
  return false;
}

// ── Progress & stats ───────────────────────────────────────
function updateStats() {
  const counts = { keep: 0, cut: 0, merge: 0, rethink: 0 };
  FEATURES.forEach(f => { if (decisions[f.id]) counts[decisions[f.id]]++; });
  const decided = Object.values(counts).reduce((a, b) => a + b, 0);
  const total = FEATURES.length;
  const pct = total ? Math.round((decided / total) * 100) : 0;

  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('header-stats').innerHTML = `
    <span>${decided}/${total}</span>
    <span class="dot keep"></span>${counts.keep}
    <span class="dot cut"></span>${counts.cut}
    <span class="dot merge"></span>${counts.merge}
    <span class="dot rethink"></span>${counts.rethink}
  `;
}

// ── Markdown renderer ──────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Escapes a value for use inside a quoted HTML attribute (escHtml leaves
// quotes alone, which is fine for text nodes but not for attributes).
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function inlineMd(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\b([A-H]\d{2})\b/g, (m, id) => {
      const f = FEATURES.find(f => f.id === id);
      return f ? `<a class="related-chip" data-action="openDetail" data-id="${escAttr(id)}" title="${f.name}">${id}</a>` : m;
    });
}

function renderMd(text) {
  if (!text) return '<span style="color:var(--text-faint)">No content</span>';
  const lines = text.split('\n');
  let html = '';
  let inCode = false, inList = false, listTag = '', inTable = false, isFirstTableRow = true;

  function closeList() { if (inList) { html += `</${listTag}>`; inList = false; } }
  function closeTable() { if (inTable) { html += '</tbody></table>'; inTable = false; } }

  for (const line of lines) {
    // Code blocks
    if (line.trim().startsWith('```')) {
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { closeList(); closeTable(); html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += escHtml(line) + '\n'; continue; }

    // Tables
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      closeList();
      if (line.trim().match(/^\|[\s:|-]+\|$/)) continue; // separator
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (!inTable) {
        html += '<table><tbody>';
        inTable = true;
        isFirstTableRow = true;
      }
      const tag = isFirstTableRow ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${inlineMd(c)}</${tag}>`).join('') + '</tr>';
      isFirstTableRow = false;
      continue;
    }
    closeTable();

    const trimmed = line.trim();

    // Sub-headers
    if (trimmed.startsWith('### ')) {
      closeList();
      html += `<h4>${inlineMd(trimmed.slice(4))}</h4>`;
      continue;
    }

    // Bullet lists
    const bullet = trimmed.match(/^[-*]\s+(.+)/);
    if (bullet) {
      if (!inList || listTag !== 'ul') { closeList(); html += '<ul>'; inList = true; listTag = 'ul'; }
      html += `<li>${inlineMd(bullet[1])}</li>`;
      continue;
    }

    // Numbered lists
    const num = trimmed.match(/^\d+\.\s+(.+)/);
    if (num) {
      if (!inList || listTag !== 'ol') { closeList(); html += '<ol>'; inList = true; listTag = 'ol'; }
      html += `<li>${inlineMd(num[1])}</li>`;
      continue;
    }

    // Empty line
    if (!trimmed) { closeList(); continue; }

    // Continuation of list item (indented)
    if (inList && line.match(/^\s{2,}/)) {
      html += ` ${inlineMd(trimmed)}`;
      continue;
    }

    // Paragraph
    closeList();
    html += `<p>${inlineMd(trimmed)}</p>`;
  }
  closeList(); closeTable();
  if (inCode) html += '</code></pre>';
  return html;
}

// ── Grid View ──────────────────────────────────────────────
function renderGrid() {
  const filtered = getFilteredFeatures();
  detailList = filtered.map(f => f.id);

  // Build group structure
  const groupedFeatures = {};
  for (const g of GROUPS) groupedFeatures[g.id] = [];
  for (const f of filtered) {
    if (!groupedFeatures[f.group]) groupedFeatures[f.group] = [];
    groupedFeatures[f.group].push(f);
  }

  let toolbarHtml = `
    <div class="grid-toolbar">
      <button class="filter-chip ${gridFilter==='all'?'active':''}" data-action="setGridFilter" data-filter="all">All</button>
      <button class="filter-chip keep ${gridFilter==='keep'?'active':''}" data-action="setGridFilter" data-filter="keep">Keep</button>
      <button class="filter-chip cut ${gridFilter==='cut'?'active':''}" data-action="setGridFilter" data-filter="cut">Cut</button>
      <button class="filter-chip merge ${gridFilter==='merge'?'active':''}" data-action="setGridFilter" data-filter="merge">Merge</button>
      <button class="filter-chip rethink ${gridFilter==='rethink'?'active':''}" data-action="setGridFilter" data-filter="rethink">Rethink</button>
      <button class="filter-chip ${gridFilter==='pending'?'active':''}" data-action="setGridFilter" data-filter="pending">Pending</button>
      <span class="grid-count">${filtered.length} features</span>
    </div>
  `;

  let contentHtml = '<div class="grid-content">';
  for (const g of GROUPS) {
    const gf = groupedFeatures[g.id] || [];
    if (gf.length === 0) continue;
    const collapsed = collapsedGroups[g.id];
    contentHtml += `<div class="grid-group">`;
    contentHtml += `<div class="grid-group-header ${collapsed?'collapsed':''}" data-action="toggleGroup" data-gid="${escAttr(g.id)}">
      <span class="chevron">\u25B6</span>
      <h2>${g.id}: ${g.name}</h2>
      <span class="count">${gf.length}</span>
    </div>`;
    if (!collapsed) {
      contentHtml += '<div class="grid-group-tiles">';
      for (const f of gf) {
        const d = decisions[f.id];
        const desc = f.spec?.what_it_does || '';
        const bCount = f.spec?.key_behaviors?.length || 0;
        const fCount = f.spec?.file_inventory?.length || 0;
        contentHtml += `
          <div class="tile ${d ? 'decision-'+d : ''}" data-action="openDetail" data-id="${escAttr(f.id)}">
            ${d ? `<div class="tile-decision-dot ${d}"></div>` : ''}
            <div class="tile-header">
              <span class="tile-id">${f.id}</span>
              <span class="tile-name">${f.name}</span>
            </div>
            <div class="tile-desc">${desc ? escHtml(desc.split('.')[0] + '.') : ''}</div>
            <div class="tile-meta">
              <span class="tile-badge ${f.priority}">${f.priority}</span>
              <span class="tile-badge">${f.complexity}</span>
              ${bCount ? `<span class="tile-badge b-count">${bCount} behaviors</span>` : ''}
              ${fCount ? `<span class="tile-badge f-count">${fCount} files</span>` : ''}
            </div>
          </div>
        `;
      }
      contentHtml += '</div>';
    }
    contentHtml += '</div>';
  }
  contentHtml += '</div>';

  document.getElementById('grid-view').innerHTML = toolbarHtml + contentHtml;
}

function setGridFilter(f) {
  gridFilter = f;
  renderGrid();
}

function toggleGroup(gid) {
  collapsedGroups[gid] = !collapsedGroups[gid];
  renderGrid();
}

// ── Detail View ────────────────────────────────────────────
function openDetail(id) {
  const f = FEATURES.find(x => x.id === id);
  if (!f) return;
  detailFeatureId = id;
  if (!detailList.includes(id)) detailList = FEATURES.map(x => x.id);
  renderDetail(f);
  showView('detail');
}

function renderDetail(f) {
  const idx = detailList.indexOf(f.id);
  const prevId = idx > 0 ? detailList[idx - 1] : null;
  const nextId = idx < detailList.length - 1 ? detailList[idx + 1] : null;
  const d = decisions[f.id] || '';
  const n = notes[f.id] || '';
  const s = f.spec || {};
  const group = GROUPS.find(g => g.id === f.group);

  let html = `
    <div class="detail-header">
      <button class="detail-back" data-action="goBackFromDetail" title="Back to grid">\u2190</button>
      <div class="detail-title">
        <span class="id">${f.id}</span>
        <span class="name">${f.name}</span>
      </div>
      <span style="color:var(--text-faint);font-size:12px">${idx+1}/${detailList.length}</span>
      <button class="detail-nav-btn" data-action="navDetail" data-dir="-1" ${!prevId?'disabled':''}  title="Previous (Left arrow)">\u2190</button>
      <button class="detail-nav-btn" data-action="navDetail" data-dir="1" ${!nextId?'disabled':''} title="Next (Right arrow)">\u2192</button>
    </div>
    <div class="detail-body">
      <div class="detail-pills">
        <span class="pill ${f.priority}">${f.priority}</span>
        <span class="pill complexity">${f.complexity} complexity</span>
        <span class="pill group">${group ? group.name : f.group}</span>
        ${f.tags ? f.tags.map(t => `<span class="pill tag">${t}</span>`).join('') : ''}
        ${s.journey_turns ? `<span class="pill tag">${s.journey_turns} journey turns</span>` : ''}
      </div>

      <div class="detail-decisions">
        <button class="decision-btn keep ${d==='keep'?'selected':''}" data-action="setDecision" data-id="${escAttr(f.id)}" data-decision="keep">Keep</button>
        <button class="decision-btn cut ${d==='cut'?'selected':''}" data-action="setDecision" data-id="${escAttr(f.id)}" data-decision="cut">Cut</button>
        <button class="decision-btn merge ${d==='merge'?'selected':''}" data-action="setDecision" data-id="${escAttr(f.id)}" data-decision="merge">Merge</button>
        <button class="decision-btn rethink ${d==='rethink'?'selected':''}" data-action="setDecision" data-id="${escAttr(f.id)}" data-decision="rethink">Rethink</button>
      </div>

      <textarea class="detail-notes" placeholder="Notes about this feature..."
        data-action="setNotes" data-id="${escAttr(f.id)}">${escHtml(n)}</textarea>
  `;

  // What It Does + Why It Exists (always open)
  if (s.what_it_does || s.why_it_exists) {
    html += `
      <div class="spec-section open">
        <div class="spec-section-header" data-action="toggleSection">
          <span class="chevron">\u25B6</span>
          <span class="title">Overview</span>
        </div>
        <div class="spec-section-content">
          <div class="md-content">
            ${s.what_it_does ? `<p>${inlineMd(s.what_it_does)}</p>` : ''}
            ${s.why_it_exists ? `<h4>Why It Exists</h4><p>${inlineMd(s.why_it_exists)}</p>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  // Key Behaviors
  if (s.key_behaviors && s.key_behaviors.length) {
    let bhtml = '';
    s.key_behaviors.forEach((b, i) => {
      const numMatch = b.match(/^(\d+)\.\s*(.*)/s);
      const text = numMatch ? numMatch[2] : b;
      bhtml += `<div class="behavior-item"><span class="behavior-num">${i+1}</span><span class="behavior-text">${inlineMd(text)}</span></div>`;
    });
    html += `
      <div class="spec-section open">
        <div class="spec-section-header" data-action="toggleSection">
          <span class="chevron">\u25B6</span>
          <span class="title">Key Behaviors</span>
          <span class="count">${s.key_behaviors.length}</span>
        </div>
        <div class="spec-section-content" style="padding:0">${bhtml}</div>
      </div>
    `;
  }

  // Architecture
  if (s.architecture) {
    html += makeSection('Architecture', s.architecture);
  }

  // API Surface
  if (s.api_surface) {
    html += makeSection('API Surface', s.api_surface);
  }

  // State Management
  if (s.state_management) {
    html += makeSection('State Management', s.state_management);
  }

  // File Inventory
  if (s.file_inventory && s.file_inventory.length) {
    const totalLines = s.file_inventory.reduce((sum, fi) => sum + (parseInt(fi.lines) || 0), 0);
    let thtml = '<table class="file-table">';
    for (const fi of s.file_inventory) {
      thtml += `<tr>
        <td class="ft-file" data-action="navigateToFile" data-file="${escAttr(fi.file)}">${escHtml(fi.file)}</td>
        <td class="ft-lines">${fi.lines}</td>
        <td class="ft-role">${escHtml(fi.role)}</td>
      </tr>`;
    }
    thtml += '</table>';
    html += `
      <div class="spec-section open">
        <div class="spec-section-header" data-action="toggleSection">
          <span class="chevron">\u25B6</span>
          <span class="title">File Inventory</span>
          <span class="count">${s.file_inventory.length} files, ${totalLines.toLocaleString()} lines</span>
        </div>
        <div class="spec-section-content" style="padding:0">${thtml}</div>
      </div>
    `;
  }

  // Dependencies + Related Features
  const relatedIds = f.related_features || [];
  if (s.dependencies || relatedIds.length) {
    let depHtml = '';
    if (s.dependencies) depHtml += `<div class="md-content">${renderMd(s.dependencies)}</div>`;
    if (relatedIds.length) {
      depHtml += '<div style="margin-top:10px"><strong style="font-size:12px;color:var(--text-dim)">Related Features:</strong><div style="margin-top:4px">';
      for (const rid of relatedIds) {
        const rf = FEATURES.find(x => x.id === rid);
        depHtml += `<span class="related-chip" data-action="openDetail" data-id="${escAttr(rid)}" title="${rf ? rf.name : rid}">${rid}${rf ? ' ' + rf.name : ''}</span>`;
      }
      depHtml += '</div></div>';
    }
    html += `
      <div class="spec-section">
        <div class="spec-section-header" data-action="toggleSection">
          <span class="chevron">\u25B6</span>
          <span class="title">Dependencies & Related</span>
          <span class="count">${relatedIds.length} related</span>
        </div>
        <div class="spec-section-content">${depHtml}</div>
      </div>
    `;
  }

  // Decisions Made
  if (s.decisions) {
    html += makeSection('Decisions Made', s.decisions);
  }

  // Edge Cases
  if (s.edge_cases) {
    html += makeSection('Edge Cases & Constraints', s.edge_cases);
  }

  // Requirements for 2.0
  if (s.requirements) {
    html += makeSection('Requirements for 2.0', s.requirements);
  }

  // iPadOS workarounds
  if (f.ipados_workarounds && f.ipados_workarounds.length) {
    let wHtml = '<ul>';
    for (const w of f.ipados_workarounds) wHtml += `<li>${inlineMd(w)}</li>`;
    wHtml += '</ul>';
    html += `
      <div class="spec-section">
        <div class="spec-section-header" data-action="toggleSection">
          <span class="chevron">\u25B6</span>
          <span class="title">iPadOS Workarounds</span>
          <span class="count">${f.ipados_workarounds.length}</span>
        </div>
        <div class="spec-section-content"><div class="md-content">${wHtml}</div></div>
      </div>
    `;
  }

  html += '</div>'; // detail-body
  document.getElementById('detail-view').innerHTML = html;
  document.getElementById('detail-view').scrollTop = 0;
}

function makeSection(title, content, open) {
  return `
    <div class="spec-section ${open ? 'open' : ''}">
      <div class="spec-section-header" data-action="toggleSection">
        <span class="chevron">\u25B6</span>
        <span class="title">${title}</span>
      </div>
      <div class="spec-section-content"><div class="md-content">${renderMd(content)}</div></div>
    </div>
  `;
}

function toggleSection(header) {
  header.parentElement.classList.toggle('open');
}

function setDecision(id, dec) {
  if (decisions[id] === dec) delete decisions[id];
  else decisions[id] = dec;
  persistState();
  updateStats();
  const f = FEATURES.find(x => x.id === id);
  if (f) renderDetail(f);
}

function setNotes(id, text) {
  if (text.trim()) notes[id] = text;
  else delete notes[id];
  persistState();
}

function navDetail(dir) {
  const idx = detailList.indexOf(detailFeatureId);
  const newIdx = idx + dir;
  if (newIdx >= 0 && newIdx < detailList.length) {
    openDetail(detailList[newIdx]);
  }
}

function goBackFromDetail() {
  showView('grid');
}

function navigateToFile(file) {
  showView('files');
  setTimeout(() => {
    const input = document.querySelector('.files-search');
    // bubbles:true so the delegated 'input' listener on document sees it
    // (real user input events bubble; a bare new Event('input') does not).
    if (input) { input.value = file; input.dispatchEvent(new Event('input', { bubbles: true })); }
  }, 50);
}

// ── Files View ─────────────────────────────────────────────
function renderFiles() {
  let fileSearch = '';
  const el = document.querySelector('.files-search');
  if (el) fileSearch = el.value;

  // Build sorted file list
  const entries = Object.entries(FILE_MAP).sort(([a], [b]) => a.localeCompare(b));
  const filtered = fileSearch
    ? entries.filter(([path]) => path.toLowerCase().includes(fileSearch.toLowerCase()))
    : entries;

  // Group by directory
  const dirs = {};
  for (const [path, info] of filtered) {
    const parts = path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push({ path, ...info, filename: parts[parts.length - 1] });
  }

  let html = `
    <div class="files-toolbar">
      <input class="files-search" placeholder="Filter files..." value="${escAttr(fileSearch)}" data-action="renderFiles">
      <span class="files-count">${filtered.length} files across ${FEATURES.length} features</span>
    </div>
    <div class="files-content">
  `;

  for (const dir of Object.keys(dirs).sort()) {
    html += `<div class="file-group">`;
    html += `<div class="file-group-header">${dir}/</div>`;
    for (const f of dirs[dir]) {
      html += `<div class="file-entry">
        <span class="file-name">${escHtml(f.filename)}</span>
        <span class="file-lines">${f.lines || ''}</span>
        <div class="file-features">
          ${f.features.map(ff => `<span class="file-feat-chip ${ff.type === 'primary' ? 'primary' : ''}" data-action="openDetail" data-id="${escAttr(ff.id)}" title="${ff.name}">${ff.id}</span>`).join('')}
        </div>
      </div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  document.getElementById('files-view').innerHTML = html;
}

// ── Summary View ───────────────────────────────────────────
function renderSummary() {
  const counts = { keep: 0, cut: 0, merge: 0, rethink: 0 };
  FEATURES.forEach(f => { if (decisions[f.id]) counts[decisions[f.id]]++; });
  const pending = FEATURES.length - Object.values(counts).reduce((a, b) => a + b, 0);

  let html = '<div class="summary-content">';
  html += `<div class="summary-grid">
    <div class="stat-card"><div class="stat-num keep">${counts.keep}</div><div class="stat-label">Keep</div></div>
    <div class="stat-card"><div class="stat-num cut">${counts.cut}</div><div class="stat-label">Cut</div></div>
    <div class="stat-card"><div class="stat-num merge">${counts.merge}</div><div class="stat-label">Merge</div></div>
    <div class="stat-card"><div class="stat-num rethink">${counts.rethink}</div><div class="stat-label">Rethink</div></div>
    <div class="stat-card"><div class="stat-num pending">${pending}</div><div class="stat-label">Pending</div></div>
  </div>`;

  // Priority breakdown
  const byPriority = { critical: [], high: [], medium: [], low: [] };
  FEATURES.forEach(f => { if (byPriority[f.priority]) byPriority[f.priority].push(f); });
  html += `<div class="summary-section"><h3>Priority Breakdown</h3>`;
  for (const [p, list] of Object.entries(byPriority)) {
    if (!list.length) continue;
    const decided = list.filter(f => decisions[f.id]).length;
    html += `<div style="margin-bottom:4px;font-size:13px;color:var(--text-dim)">
      <strong style="text-transform:capitalize">${p}</strong>: ${list.length} features (${decided} decided)
    </div>`;
  }
  html += '</div>';

  // Per-group rows
  for (const g of GROUPS) {
    const gf = FEATURES.filter(f => f.group === g.id);
    if (!gf.length) continue;
    html += `<div class="summary-section"><h3>${g.id}: ${g.name}</h3>`;
    for (const f of gf) {
      const d = decisions[f.id] || 'pending';
      const n = notes[f.id] || '';
      html += `
        <div class="summary-row" data-action="openDetail" data-id="${escAttr(f.id)}">
          <span class="sid">${f.id}</span>
          <span class="sname">${f.name}</span>
          <span class="spriority ${f.priority}">${f.priority}</span>
          ${n ? `<span class="snote" title="${escHtml(n)}">${escHtml(n)}</span>` : ''}
          <span class="sdecision ${d}">${d}</span>
        </div>
      `;
    }
    html += '</div>';
  }
  html += '</div>';
  document.getElementById('summary-view').innerHTML = html;
}

// ── Export ──────────────────────────────────────────────────
function exportMarkdown() {
  let md = '# Feature Triage Results\n\n';
  md += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
  const counts = { keep: 0, cut: 0, merge: 0, rethink: 0 };
  FEATURES.forEach(f => { if (decisions[f.id]) counts[decisions[f.id]]++; });
  md += `**Decisions:** ${counts.keep} keep, ${counts.cut} cut, ${counts.merge} merge, ${counts.rethink} rethink, ${FEATURES.length - Object.keys(decisions).length} pending\n\n`;
  md += '| ID | Feature | Priority | Decision | Notes |\n';
  md += '|----|---------|----------|----------|-------|\n';
  for (const f of FEATURES) {
    const d = decisions[f.id] || 'pending';
    const n = (notes[f.id] || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    md += `| ${f.id} | ${f.name} | ${f.priority} | ${d} | ${n} |\n`;
  }
  copyToClipboard(md);
  showToast('Markdown copied to clipboard');
}

function exportJSON() {
  const data = FEATURES.map(f => ({
    id: f.id, name: f.name, group: f.group, priority: f.priority,
    decision: decisions[f.id] || null, notes: notes[f.id] || null
  }));
  copyToClipboard(JSON.stringify(data, null, 2));
  showToast('JSON copied to clipboard');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// ── Keyboard ───────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't intercept when typing in inputs
  if (e.target.tagName === 'TEXTAREA') return;
  if (e.target.tagName === 'INPUT') {
    if (e.key === 'Escape') {
      e.target.blur();
      e.target.value = '';
      searchQuery = '';
      renderGrid();
    }
    return;
  }

  if (e.key === 'Escape') {
    if (currentView === 'detail') { goBackFromDetail(); return; }
  }

  // Detail view shortcuts
  if (currentView === 'detail') {
    if (e.key === 'ArrowLeft') { navDetail(-1); return; }
    if (e.key === 'ArrowRight') { navDetail(1); return; }
    if (e.key === '1') { setDecision(detailFeatureId, 'keep'); return; }
    if (e.key === '2') { setDecision(detailFeatureId, 'cut'); return; }
    if (e.key === '3') { setDecision(detailFeatureId, 'merge'); return; }
    if (e.key === '4') { setDecision(detailFeatureId, 'rethink'); return; }
  }

  // Grid view: type to search
  if (currentView === 'grid' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const input = document.getElementById('global-search');
    if (input) { input.focus(); return; }
  }
});

// Global search
document.getElementById('global-search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  if (currentView === 'grid') renderGrid();
});

// Nav buttons
document.querySelectorAll('.header-nav button').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ── Delegated actions ──────────────────────────────────────
// Markup carries data-action (+ data-* arguments) instead of inline on*
// handlers, so script-src can drop 'unsafe-inline'.
const CLICK_ACTIONS = {
  openDetail:       (el) => openDetail(el.dataset.id),
  setGridFilter:    (el) => setGridFilter(el.dataset.filter),
  toggleGroup:      (el) => toggleGroup(el.dataset.gid),
  goBackFromDetail: ()   => goBackFromDetail(),
  navDetail:        (el) => navDetail(Number(el.dataset.dir)),
  setDecision:      (el) => setDecision(el.dataset.id, el.dataset.decision),
  toggleSection:    (el) => toggleSection(el),
  navigateToFile:   (el) => navigateToFile(el.dataset.file),
  exportMarkdown:   ()   => exportMarkdown(),
  exportJSON:       ()   => exportJSON(),
};

const INPUT_ACTIONS = {
  setNotes:    (el) => setNotes(el.dataset.id, el.value),
  renderFiles: ()   => renderFiles(),
};

function delegateActions(table) {
  return (e) => {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    const el = target.closest('[data-action]');
    if (!el) return;
    const name = el.dataset.action;
    if (!Object.prototype.hasOwnProperty.call(table, name)) return;
    table[name](el, e);
  };
}

document.addEventListener('click', delegateActions(CLICK_ACTIONS));
document.addEventListener('input', delegateActions(INPUT_ACTIONS));

// ── Init ───────────────────────────────────────────────────
(async () => {
  await loadData();
  updateStats();
  if (!restoreFromHash()) {
    showView('grid');
  }
})();
