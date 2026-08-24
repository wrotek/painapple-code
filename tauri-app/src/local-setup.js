// Local servers card + setup wizard (desktop builds only).
//
// Multiple instances behind one wizard:
//   cli    — "This Mac": uv-provisioned Python bridge, supervised child
//            process (src-tauri/src/local.rs local_start/local_stop).
//            Singleton — one supervised process per app.
//   docker — container sandboxes via Docker/Podman, any number (one per
//            project). The GUI never talks to the docker daemon: it drives
//            the uv-provisioned unified `painapple` CLI non-interactively
//            through local_tool(), so orchestration stays in Python and
//            config lands in the canonical store — every sandbox is a
//            NAMED docker-mode profile at
//            ~/.painapple-code/profiles/<name>/profile.yaml, written via
//            `painapple profile set <name> …` and run via
//            `painapple start/stop/restart <name>`. There is no flag-less
//            root sandbox ('default' is reserved for the root HOST
//            deployment). A GUI-made sandbox is fully manageable from the
//            terminal and vice versa: terminal-made docker-mode profiles
//            are adopted into the card via `profile get` on refresh.
//
// Loaded after launcher.js; reuses its top-level function declarations
// (navigateToServer, pingServer, escapeHtml) via shared script global scope.
// Design: docs-ai/plans/2026-07-30-cli-unification-redesign.md
// (wizard UX: docs-ai/plans/2026-07-10-desktop-app-local-setup-wizard.md)
const SETUP_KEY = 'painapple.localSetup';
const LEGACY_OPTS_KEY = 'painapple.localOpts';

// Docker accent palette (cli/deploy/config.py ACCENT_NAMES) — shared by
// both engines so the wizard shows one set of dots.
const LOCAL_ACCENTS = {
  blue: '#5b9fe0', green: '#5cb85c', red: '#e06b5b',
  orange: '#f0a050', purple: '#a97fd6', cyan: '#4fc3c3',
};
const ACCENT_KEYS = Object.keys(LOCAL_ACCENTS);
const ENGINE_PORT = { cli: 8988, docker: 8765 };
const ISOLATED_CLAUDE_HOME = '~/.painapple-code/shared/.claude';

const localEl = document.getElementById('local');
const localInstancesEl = document.getElementById('local-instances');
const localActions = document.getElementById('local-actions');
const localNote = document.getElementById('local-note');
const localLog = document.getElementById('local-log');

const wizardEl = document.getElementById('wizard');
const wizTitle = document.getElementById('wiz-title');
const wizStepsEl = document.getElementById('wiz-steps');
const wizBody = document.getElementById('wiz-body');
const wizErr = document.getElementById('wiz-err');
const wizFoot = document.getElementById('wiz-foot');
const wizBackBtn = document.getElementById('wiz-back');
const wizNextBtn = document.getElementById('wiz-next');
const wizCloseBtn = document.getElementById('wiz-close');
const wizLog = document.getElementById('wiz-log');

let lastStatus = null;   // local_status result (cli engine + provisioning)
let dockerState = null;  // local_docker_state result
let busyId = null;       // instance id an action is running against
let busyText = '';       // its current progress line (row badge)
let renderGen = 0;       // invalidates in-flight row pings on re-render

function localInvoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

// Run the provisioned painapple CLI. Never rejects on nonzero exit —
// callers branch on `code` and can show `output` (the CLI's own error text).
async function tool(args, opts) {
  try {
    return await localInvoke('local_tool', {
      args,
      stage: (opts && opts.stage) || 'docker',
      quiet: !!(opts && opts.quiet),
    });
  } catch (e) {
    return { output: String(e), code: -1 };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Persisted setup (v2: a list of instances) --------------------------------

function instDefaults(engine, existing) {
  existing = existing || setup.instances;
  return {
    engine,                  // 'cli' | 'docker'
    profile: undefined,      // docker: the profile name ('default' is reserved)
    folder: '',              // '' = home (cli) / required (docker)
    layout: 'project',       // docker: project | parent | multi(read-only)
    claude: 'isolated',      // docker: isolated | host | custom(read-only)
    claudeCustomPath: '',
    seedLogin: true,
    port: engine === 'docker' ? nextFreePort(existing) : null, // null = engine default
    access: 'local',         // local | lan
    listenCustom: '',        // terminal-configured custom bind IP, kept as-is
    tls: 'auto',
    name: engine === 'cli' ? 'LOCAL' : '',
    accent: ACCENT_KEYS[existing.length % ACCENT_KEYS.length],
    storage: 'volume',       // docker: volume | bind
    volumeName: 'painapple-data',
    dataDir: '',
  };
}

function loadSetup() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(SETUP_KEY)); } catch { /* fresh */ }
  if (stored && stored.v === 2 && Array.isArray(stored.instances)) {
    // Pre-unification records used profile 'default' for the flag-less
    // root sandbox; the CLI migration adopts that deployment as profile
    // 'docker' ('default' is reserved now) — remap so actions target it.
    let remapped = false;
    stored.instances.forEach(inst => {
      if (inst.engine === 'docker' && (!inst.profile || inst.profile === 'default')) {
        inst.profile = 'docker';
        if (inst.id === 'default') inst.id = 'docker';
        remapped = true;
      }
    });
    if (remapped) localStorage.setItem(SETUP_KEY, JSON.stringify(stored));
    return stored;
  }

  const s = { v: 2, instances: [] };
  if (stored && typeof stored === 'object') {
    // v1: single-instance object with the same field names + `configured`.
    if (stored.configured) {
      const inst = Object.assign(instDefaults(stored.engine || 'cli', []), stored);
      delete inst.configured;
      inst.id = inst.engine === 'cli' ? 'cli' : 'docker';
      if (inst.engine === 'docker') inst.profile = 'docker';
      s.instances.push(inst);
    }
    localStorage.setItem(SETUP_KEY, JSON.stringify(s));
    return s;
  }
  // Migrate the pre-wizard "This Mac" options, once.
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_OPTS_KEY));
    if (legacy && typeof legacy === 'object') {
      const inst = instDefaults('cli', []);
      inst.id = 'cli';
      inst.folder = legacy.cwd || '';
      inst.port = legacy.port || null;
      inst.name = legacy.name || 'LOCAL';
      inst.accent = legacy.accent || 'green';
      s.instances.push(inst);
      localStorage.removeItem(LEGACY_OPTS_KEY);
      localStorage.setItem(SETUP_KEY, JSON.stringify(s));
    }
  } catch { /* no legacy opts */ }
  return s;
}

let setup = loadSetup();

function saveSetup() {
  localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
}

function getInst(id) { return setup.instances.find(i => i.id === id) || null; }

function upsertInst(inst) {
  const idx = setup.instances.findIndex(i => i.id === inst.id);
  if (idx >= 0) setup.instances[idx] = inst;
  else setup.instances.push(inst);
}

function removeInst(id) {
  setup.instances = setup.instances.filter(i => i.id !== id);
}

function effectivePort(s) { return s.port || ENGINE_PORT[s.engine]; }

function usedPorts(exceptId, existing) {
  const used = new Set();
  (existing || setup.instances).forEach(i => {
    if (i.id !== exceptId) used.add(effectivePort(i));
  });
  return used;
}

function nextFreePort(existing) {
  const used = usedPorts(null, existing);
  for (let p = ENGINE_PORT.docker; ; p++) {
    if (!used.has(p) && p !== ENGINE_PORT.cli) return p;
  }
}

// Mirror of the server/CLI `--tls auto` resolution: loopback bind → off.
function effectiveScheme(s) {
  const on = s.tls === 'on' || (s.tls !== 'off' && s.access === 'lan');
  return on ? 'https' : 'http';
}

function localOrigin(s) {
  return `${effectiveScheme(s)}://127.0.0.1:${effectivePort(s)}`;
}

function instLabel(inst) {
  if (inst.name) return inst.name;
  if (inst.engine === 'cli') return 'This Mac';
  return inst.profile || 'Docker';
}

// --- Terminal interop: profiles on disk --------------------------------------

// Docker-mode profiles the CLI knows about (profiles/NAME/profile.yaml
// with mode: docker — host profiles are filtered out Rust-side).
function diskProfiles() {
  if (!dockerState) return [];
  return (dockerState.profiles || []).filter(p => p !== 'default');
}

// Terminal-made profiles become card instances by reading their config
// through the CLI (`profile get`) — so terminal edits always win on adopt.
async function adoptProfile(profile) {
  const r = await tool(['profile', 'get', profile], { quiet: true });
  if (r.code !== 0) return null;
  const inst = instDefaults('docker');
  inst.id = profile;
  inst.profile = profile;
  inst.name = '';
  applyDockerPrefill(inst, r.output);
  return inst;
}

let adopting = false;
async function adoptDiskProfiles() {
  if (adopting || busyId) return;
  if (!(lastStatus && lastStatus.provisioned) || (lastStatus && lastStatus.busy)) return;
  const known = new Set(setup.instances.filter(i => i.engine === 'docker').map(i => i.profile));
  const todo = diskProfiles().filter(p => !known.has(p));
  if (!todo.length) return;
  adopting = true;
  try {
    let changed = false;
    for (const p of todo) {
      const inst = await adoptProfile(p);
      if (inst) { upsertInst(inst); changed = true; }
    }
    if (changed) { saveSetup(); renderLocal(); }
  } finally {
    adopting = false;
  }
}

// --- Card --------------------------------------------------------------------

function appendLocalLog(line) {
  localLog.hidden = false;
  localLog.textContent += line + '\n';
  localLog.scrollTop = localLog.scrollHeight;
}

function localButton(label, primary, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = primary ? 'local-btn primary' : 'local-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function refreshLocal() {
  try { lastStatus = await localInvoke('local_status'); }
  catch { return; }
  try {
    dockerState = await localInvoke('local_docker_state');
    // Reconcile: a sandbox whose config was deleted in the terminal is gone —
    // keeping the row would just error on every action.
    const disk = new Set(diskProfiles());
    const keep = setup.instances.filter(i => i.engine !== 'docker' || disk.has(i.profile));
    if (keep.length !== setup.instances.length) {
      setup.instances = keep;
      saveSetup();
    }
  } catch {
    dockerState = dockerState || { runtime: null, configured: false, profiles: [], hostClaudeCreds: false };
  }
  renderLocal();
  adoptDiskProfiles(); // fire-and-forget; re-renders when done
}

// Instances to show: persisted ones + terminal-made profiles not yet adopted
// (visible immediately even before the Python driver is installed).
function displayList() {
  const list = [...setup.instances];
  const known = new Set(list.filter(i => i.engine === 'docker').map(i => i.profile));
  diskProfiles().forEach(p => {
    if (!known.has(p)) {
      list.push({
        id: p, engine: 'docker', profile: p, discovered: true,
        name: '', accent: '', port: null, access: 'local', tls: 'auto', folder: '',
      });
    }
  });
  return list;
}

const BUSY_VERBS = {
  provision: 'installing…', start: 'starting…',
  claude: 'installing Claude CLI…', docker: 'working…', remove: 'removing…',
};

function renderLocal() {
  const gen = ++renderGen;
  const status = lastStatus;
  localInstancesEl.innerHTML = '';
  localActions.innerHTML = '';
  localNote.innerHTML = '';
  localNote.hidden = true;

  const list = displayList();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'local-empty';
    empty.textContent = 'Run a pAInapple server on this Mac — natively, or as Docker sandboxes (one per project).';
    localInstancesEl.appendChild(empty);
    localActions.appendChild(localButton('Set up…', true, () => openWizard()));
    return;
  }

  const busy = !!busyId || !!(status && status.busy);
  list.forEach(inst => localInstancesEl.appendChild(renderInstanceRow(inst, gen, status, busy)));

  const add = localButton('Add server…', false, () => openWizard());
  add.classList.add('sm');
  if (busy) add.disabled = true;
  localActions.appendChild(add);

  // The bridge needs the Claude Code CLI for sessions — cli engine only
  // (the docker image bundles its own).
  if (list.some(i => i.engine === 'cli') && status && status.provisioned && !status.claudePath) {
    localNote.innerHTML = '<span class="warn">Claude Code CLI not found</span><span>— the This Mac server needs it for sessions.</span>';
    localNote.appendChild(localButton('Install Claude CLI', false, onInstallClaude));
    localNote.hidden = false;
  }
}

function renderInstanceRow(inst, gen, status, busy) {
  const row = document.createElement('div');
  row.className = 'li-row';
  row.dataset.instId = inst.id;
  row.innerHTML = `
    <div class="li-top">
      <span class="li-dot"></span>
      <span class="li-name"></span>
      <span class="local-engine"></span>
      <span class="local-badge li-badge" data-state="checking">checking…</span>
    </div>
    <div class="li-bottom">
      <span class="li-sub"></span>
      <span class="li-actions"></span>
    </div>`;
  row.querySelector('.li-dot').style.background = LOCAL_ACCENTS[inst.accent] || 'var(--muted)';
  row.querySelector('.li-name').textContent = instLabel(inst);
  row.querySelector('.local-engine').textContent = inst.engine === 'docker'
    ? `Docker${dockerState && dockerState.runtime === 'podman' ? ' · podman' : ''}`
    : 'This Mac';

  const sub = row.querySelector('.li-sub');
  if (inst.discovered) {
    sub.textContent = 'set up in the terminal — starting imports it here';
  } else {
    const bits = [inst.layout === 'multi' ? 'multiple projects' : (inst.folder || '~')];
    bits.push(`port ${effectivePort(inst)}`);
    if (inst.access === 'lan') bits.push('LAN');
    sub.textContent = bits.join(' · ');
    sub.title = sub.textContent; // full folder path survives the ellipsis
  }

  const badge = row.querySelector('.li-badge');
  const actions = row.querySelector('.li-actions');
  const setBadge = (text, state) => { badge.textContent = text; badge.dataset.state = state; };
  const btn = (label, primary, fn) => {
    const b = localButton(label, primary, fn);
    b.classList.add('sm');
    if (busy) b.disabled = true;
    actions.appendChild(b);
    return b;
  };
  const removeBtn = () => {
    const b = btn('Remove', false, () => {
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = 'Sure?';
        setTimeout(() => {
          if (b.isConnected) { b.classList.remove('armed'); b.textContent = 'Remove'; }
        }, 3000);
        return;
      }
      onRemoveInstance(inst);
    });
    b.classList.add('danger');
  };

  // An action is running against this row — show its progress, no buttons.
  if (busyId === inst.id) {
    setBadge(busyText || 'working…', 'busy');
    return row;
  }
  if (busyId === null && status && status.busy && !inst.discovered) {
    // Rust-side busy without a known initiator (e.g. wizard apply) — just
    // freeze the row; the generic verb beats a misleading "stopped".
    setBadge(BUSY_VERBS[status.busy] || 'working…', 'busy');
    return row;
  }

  if (inst.engine === 'cli') {
    if (!(status && status.provisioned)) {
      setBadge('not installed', 'off');
      btn('Install & start', true, () => onCliStartOpen(inst));
      btn('Edit', false, () => openWizard(inst.id));
      removeBtn();
    } else if (status.running) {
      setBadge(`running · port ${status.port}`, 'on');
      btn('Open', true, () => onCliStartOpen(inst));
      btn('Stop', false, () => onCliStop(inst));
      btn('Edit', false, () => openWizard(inst.id));
    } else {
      setBadge(status.serverVersion ? `v${status.serverVersion} · stopped` : 'stopped', 'off');
      btn('Start & Open', true, () => onCliStartOpen(inst));
      btn('Edit', false, () => openWizard(inst.id));
      btn('Update', false, () => onCliUpdate(inst));
      removeBtn();
    }
    return row;
  }

  // --- docker rows ---
  if (inst.discovered) {
    setBadge('not imported', 'off');
    btn('Start & Open', true, () => onDockerStartOpen(inst));
    return row;
  }
  const buildStopped = () => {
    actions.innerHTML = '';
    btn('Start & Open', true, () => onDockerStartOpen(inst));
    btn('Edit', false, () => openWizard(inst.id));
    btn('Update', false, () => onDockerUpdate(inst));
    removeBtn();
  };
  const buildRunning = () => {
    actions.innerHTML = '';
    btn('Open', true, () => onDockerStartOpen(inst));
    btn('Stop', false, () => onDockerStop(inst));
    btn('Edit', false, () => openWizard(inst.id));
    removeBtn();
  };
  if (!(status && status.provisioned)) {
    // Can't drive docker without the Python CLI — Start&Open provisions it.
    setBadge('stopped', 'off');
    buildStopped();
    return row;
  }
  buildStopped(); // sensible default while the ping is in flight
  pingServer(localOrigin(inst)).then(result => {
    if (gen !== renderGen || !row.isConnected) return;
    if (result.kind === 'reachable') {
      setBadge(`running · port ${effectivePort(inst)}`, 'on');
      buildRunning();
    } else {
      setBadge('stopped', 'off');
    }
  });
  return row;
}

// Update the badge of an in-flight row without a full re-render.
function rowProgress(id) {
  return (text) => {
    busyText = text;
    const badge = localInstancesEl.querySelector(`[data-inst-id="${CSS.escape(id)}"] .li-badge`);
    if (badge) { badge.textContent = text; badge.dataset.state = 'busy'; }
  };
}

// Wrap a per-instance action: claim the row, render it busy, always
// refresh at the end (which also re-reads docker/provision state).
async function withRowBusy(inst, initialText, fn) {
  busyId = inst.id;
  busyText = initialText;
  renderLocal();
  try {
    await fn(rowProgress(inst.id));
  } catch (e) {
    appendLocalLog('✗ ' + (e.message || e));
  } finally {
    busyId = null;
    busyText = '';
    refreshLocal();
  }
}

// --- cli engine actions --------------------------------------------------------

function cliStartConfig(s) {
  return {
    port: effectivePort(s),
    cwd: s.folder || null,
    instanceName: s.name || null,
    accent: s.accent || null,
    host: s.access === 'lan' ? '0.0.0.0' : null,
    tls: s.access === 'lan' ? s.tls : null,
  };
}

function onCliStartOpen(inst) {
  return withRowBusy(inst, 'starting…', async (progress) => {
    if (!lastStatus.provisioned) {
      localLog.textContent = '';
      localLog.hidden = false;
      progress('installing…');
      await localInvoke('local_provision', {});
      progress('starting…');
    }
    const url = await localInvoke('local_start', { config: cliStartConfig(inst) });
    navigateToServer({ url: new URL(url).origin, name: instLabel(inst) }, url);
  });
}

function onCliStop(inst) {
  return withRowBusy(inst, 'stopping…', () => localInvoke('local_stop'));
}

function onCliUpdate(inst) {
  return withRowBusy(inst, 'installing…', () => {
    localLog.textContent = '';
    localLog.hidden = false;
    return localInvoke('local_provision', {});
  });
}

async function onInstallClaude() {
  localLog.textContent = '';
  localLog.hidden = false;
  localNote.hidden = true;
  try {
    const path = await localInvoke('local_install_claude');
    appendLocalLog('✓ claude installed at ' + path);
    appendLocalLog('Run `claude` once in a terminal to log in before starting sessions.');
  } catch (e) {
    appendLocalLog('✗ ' + e);
  }
  refreshLocal();
}

// --- docker engine actions -----------------------------------------------------

// Bring a sandbox up (auto-pulling the image on first run), wait for
// /health, fetch the password. Returns the ready-to-navigate URL.
// `progress(text)` updates whichever surface initiated (row badge / wizard).
// `restart` forces a stop/rm/up cycle — the wizard uses it after a config
// change so new mounts/ports actually apply (and because the old container
// may sit on a *different* port than the freshly-saved one, a plain `up`
// would see "already running" and never serve the new config).
async function ensureDockerRunning(inst, progress, restart) {
  const origin = localOrigin(inst);

  // Already serving? Skip `start` entirely (idempotent Open).
  const alreadyUp = !restart && (await pingServer(origin)).kind === 'reachable';
  if (!alreadyUp) {
    progress(restart ? 'restarting container…' : 'starting container…');
    const cmd = [restart ? 'restart' : 'start', inst.profile];
    let up = await tool(cmd);
    if (up.code !== 0 && /not found locally/i.test(up.output)) {
      progress('downloading image…');
      const pull = await tool(['pull']);
      if (pull.code !== 0) throw new Error('image pull failed — see log');
      progress('starting container…');
      up = await tool(cmd);
    }
    if (up.code !== 0) throw new Error('container start failed — see log');

    progress('waiting for server…');
    let healthy = false;
    for (let i = 0; i < 90; i++) {
      const r = await pingServer(origin);
      if (r.kind === 'reachable') { healthy = true; break; }
      await sleep(1000);
    }
    if (!healthy) throw new Error('server did not answer /health — see log');
  }

  progress('reading password…');
  const pw = await dockerPassword(inst);
  return pw ? `${origin}/?tkn=${encodeURIComponent(pw)}` : `${origin}/`;
}

async function dockerPassword(inst) {
  // The bridge writes its auth config shortly after first start — retry
  // briefly (mirrors _wait_for_password in cli/deploy/container.py).
  for (let i = 0; i < 8; i++) {
    const r = await tool(['password', inst.profile], { quiet: true });
    const m = r.output.match(/^Password:\s*(\S+)/m);
    if (r.code === 0 && m) return m[1];
    await sleep(1500);
  }
  return null;
}

function onDockerStartOpen(inst) {
  return withRowBusy(inst, 'starting…', async (progress) => {
    // The Python CLI is the docker driver — a terminal-configured sandbox
    // with a fresh app install needs it provisioned before up/stop work.
    if (!(lastStatus && lastStatus.provisioned)) {
      progress('installing driver…');
      await localInvoke('local_provision', {});
      lastStatus = await localInvoke('local_status');
    }
    if (inst.discovered) {
      progress('importing config…');
      const adopted = await adoptProfile(inst.profile);
      if (adopted) {
        upsertInst(adopted);
        saveSetup();
        inst = adopted;
      }
    }
    const url = await ensureDockerRunning(inst, progress);
    navigateToServer({ url: new URL(url).origin, name: instLabel(inst) }, url);
  });
}

function onDockerStop(inst) {
  return withRowBusy(inst, 'stopping…', async () => {
    const r = await tool(['stop', inst.profile]);
    if (r.code !== 0) appendLocalLog('✗ stop failed — see log');
  });
}

function onDockerUpdate(inst) {
  return withRowBusy(inst, 'updating image…', async (progress) => {
    localLog.textContent = '';
    localLog.hidden = false;
    const wasUp = (await pingServer(localOrigin(inst))).kind === 'reachable';
    const pull = await tool(['pull']);
    if (pull.code === 0 && wasUp) {
      progress('restarting…');
      await tool(['restart', inst.profile]);
    }
  });
}

// Forget an instance. Docker: stop the container and delete the profile's
// config (profile.yaml) so it isn't re-adopted from disk — the data
// volume / bind dir and the shared Claude login are deliberately kept
// (the stopped container is reclaimed automatically on the next start of
// a same-named profile).
function onRemoveInstance(inst) {
  return withRowBusy(inst, 'removing…', async (progress) => {
    if (inst.engine === 'cli') {
      if (lastStatus && lastStatus.running) await localInvoke('local_stop');
    } else {
      if (lastStatus && lastStatus.provisioned) {
        progress('stopping container…');
        await tool(['stop', inst.profile]);
      }
      await localInvoke('local_docker_remove_profile', { profile: inst.profile });
      const data = inst.storage === 'bind' ? inst.dataDir : `volume "${inst.volumeName}"`;
      appendLocalLog(`✓ removed "${instLabel(inst)}" — its data (${data}) and the Claude login were kept`);
    }
    removeInst(inst.id);
    saveSetup();
  });
}

// --- Wizard ------------------------------------------------------------------

let wiz = null; // { mode, editingId, drafts, draft, stepIdx, applying }

function wizardSteps(draft) {
  const steps = wiz && wiz.mode === 'add' ? ['engine'] : [];
  steps.push('folder');
  if (draft.engine === 'docker') steps.push('claude');
  steps.push('network', 'look');
  if (draft.engine === 'docker') steps.push('storage');
  steps.push('review');
  return steps;
}

function makeDraft(engine) {
  if (engine === 'cli') {
    const existing = getInst('cli');
    if (existing) return JSON.parse(JSON.stringify(existing)); // singleton — edit it
  }
  return instDefaults(engine);
}

async function openWizard(editId) {
  const editing = editId ? getInst(editId) : null;
  const mode = editing ? 'edit' : 'add';
  wiz = { mode, editingId: editing ? editId : null, drafts: {}, stepIdx: 0, applying: false };
  if (editing) {
    wiz.draft = JSON.parse(JSON.stringify(editing));
  } else {
    // Adding: with a This Mac server already set up, the likely intent is
    // another Docker sandbox — preselect it (the engine step still shows both).
    const engine = getInst('cli') && dockerState && dockerState.runtime ? 'docker' : 'cli';
    wiz.draft = makeDraft(engine);
  }
  wiz.drafts[wiz.draft.engine] = wiz.draft;

  wizTitle.textContent = mode === 'edit'
    ? `Edit — ${instLabel(editing)}`
    : (setup.instances.length ? 'Add local server' : 'Set up local server');
  wizLog.hidden = true;
  wizLog.textContent = '';
  wizErr.textContent = '';
  wizardEl.hidden = false;

  // The on-disk config is canonical (possibly edited from the terminal) —
  // prefill the draft from `profile get` so terminal-side edits win.
  if (mode === 'edit' && editing.engine === 'docker' && lastStatus && lastStatus.provisioned) {
    wizBody.innerHTML = '<p class="wiz-q">Loading current configuration…</p>';
    wizFoot.hidden = true;
    const r = await tool(['profile', 'get', editing.profile], { quiet: true });
    wizFoot.hidden = false;
    if (r.code === 0) applyDockerPrefill(wiz.draft, r.output);
  }
  renderWizStep();
}

// Parse `painapple profile get NAME` output: lowercase unified key=value
// lines (`host` = bind, `tls` = TLS mode — cli/deploy/config.py maps the
// old LISTEN_HOST/TLS_MODE vocabulary onto these in profile.yaml).
function applyDockerPrefill(draft, output) {
  const cfg = {};
  output.split('\n').forEach(line => {
    const i = line.indexOf('=');
    if (i > 0) cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  if (cfg.workspace) draft.folder = cfg.workspace;
  if (cfg.workspace_mode) draft.layout = cfg.workspace_mode;
  if (cfg.port) draft.port = parseInt(cfg.port, 10) || draft.port;
  if (cfg.host) {
    draft.access = cfg.host === '127.0.0.1' ? 'local' : 'lan';
    draft.listenCustom =
      (cfg.host !== '127.0.0.1' && cfg.host !== '0.0.0.0') ? cfg.host : '';
  }
  if (cfg.tls) draft.tls = cfg.tls;
  if (cfg.instance_name !== undefined) draft.name = cfg.instance_name;
  if (cfg.accent) draft.accent = cfg.accent;
  if (cfg.claude_home) {
    const h = cfg.claude_home;
    if (/\/\.painapple-code\/shared\/\.claude$/.test(h)) {
      draft.claude = 'isolated';
    } else if (/^(~|\/(Users|home)\/[^/]+)\/\.claude$/.test(h)) {
      draft.claude = 'host'; // "<home>/.claude" exactly
    } else {
      draft.claude = 'custom'; // terminal-picked path — preserved on save
      draft.claudeCustomPath = h;
    }
  }
  if (cfg.data_volume) {
    if (cfg.data_volume.startsWith('/')) {
      draft.storage = 'bind';
      draft.dataDir = cfg.data_volume;
    } else {
      draft.storage = 'volume';
      draft.volumeName = cfg.data_volume;
    }
  }
}

function closeWizard() {
  if (wiz && wiz.applying) return; // no bailing mid-apply
  wizardEl.hidden = true;
  wiz = null;
}

wizCloseBtn.addEventListener('click', closeWizard);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !wizardEl.hidden) {
    e.stopPropagation();
    closeWizard();
  }
}, true);

wizBackBtn.addEventListener('click', () => {
  if (!wiz || wiz.applying || wiz.stepIdx === 0) return;
  wizErr.textContent = '';
  wiz.stepIdx -= 1;
  renderWizStep();
});

wizNextBtn.addEventListener('click', async () => {
  if (!wiz || wiz.applying) return;
  wizErr.textContent = '';
  const steps = wizardSteps(wiz.draft);
  const step = steps[wiz.stepIdx];
  const err = await validateStep(step);
  if (err) { wizErr.textContent = err; return; }
  if (step === 'review') {
    runWizardApply();
    return;
  }
  wiz.stepIdx += 1;
  renderWizStep();
});

function renderWizStep() {
  const steps = wizardSteps(wiz.draft);
  const step = steps[wiz.stepIdx];
  wizStepsEl.textContent = `${wiz.stepIdx + 1} / ${steps.length}`;
  wizBackBtn.style.visibility = wiz.stepIdx === 0 ? 'hidden' : 'visible';
  wizNextBtn.textContent = step === 'review'
    ? (lastStatus && lastStatus.provisioned ? 'Save & start' : 'Install & start')
    : 'Next';
  wizErr.textContent = '';
  const render = {
    engine: renderEngineStep,
    folder: renderFolderStep,
    claude: renderClaudeStep,
    network: renderNetworkStep,
    look: renderLookStep,
    storage: renderStorageStep,
    review: renderReviewStep,
  }[step];
  wizBody.innerHTML = '';
  render(wiz.draft);
}

// -- step: engine --

// Keep per-engine drafts so toggling back and forth doesn't lose typed values.
function selectEngine(engine) {
  if (wiz.draft.engine === engine) return;
  wiz.drafts[wiz.draft.engine] = wiz.draft;
  wiz.draft = wiz.drafts[engine] || (wiz.drafts[engine] = makeDraft(engine));
  renderWizStep();
}

function renderEngineStep(draft) {
  wizBody.innerHTML = '<p class="wiz-q">Where should your pAInapple server run?</p>';
  const hasCli = !!getInst('cli');
  const dockerCount = setup.instances.filter(i => i.engine === 'docker').length;

  const cli = document.createElement('button');
  cli.type = 'button';
  cli.className = 'wiz-opt' + (draft.engine === 'cli' ? ' selected' : '');
  cli.innerHTML = `
    <span class="wiz-opt-title">This Mac <span class="hint">${hasCli ? 'already set up — edits it' : 'recommended'}</span></span>
    <span class="wiz-opt-desc">Python is installed automatically (nothing touches your system).
    Runs while the app is open.</span>`;
  cli.addEventListener('click', () => selectEngine('cli'));
  wizBody.appendChild(cli);

  const hasRuntime = !!(dockerState && dockerState.runtime);
  const docker = document.createElement('button');
  docker.type = 'button';
  docker.className = 'wiz-opt'
    + (draft.engine === 'docker' ? ' selected' : '')
    + (hasRuntime ? '' : ' disabled');
  docker.innerHTML = `
    <span class="wiz-opt-title">Docker container${hasRuntime ? ` <span class="hint">via ${escapeHtml(dockerState.runtime)}</span>` : ''}</span>
    <span class="wiz-opt-desc">${hasRuntime
      ? (dockerCount
        ? 'Adds another isolated sandbox with its own folder, port, and history — one per project works great.'
        : 'Fully isolated — sessions can only touch the folders you choose. Keeps running in the background. Add as many sandboxes as you like, one per project.')
      : 'Docker or Podman not found on this Mac.'}</span>`;
  if (hasRuntime) {
    docker.addEventListener('click', () => selectEngine('docker'));
  }
  wizBody.appendChild(docker);

  if (!hasRuntime) {
    const note = document.createElement('div');
    note.className = 'wiz-note wiz-row';
    note.innerHTML = '<a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noopener">Get Docker Desktop</a>';
    const recheck = document.createElement('button');
    recheck.type = 'button';
    recheck.className = 'wiz-browse';
    recheck.textContent = 'Recheck';
    recheck.addEventListener('click', async () => {
      try { dockerState = await localInvoke('local_docker_state'); } catch { /* keep */ }
      renderWizStep();
    });
    note.appendChild(recheck);
    wizBody.appendChild(note);
  }
}

// -- step: folder --

function renderFolderStep(draft) {
  if (draft.engine === 'docker' && draft.layout === 'multi') {
    wizBody.innerHTML = `
      <p class="wiz-q">Project folder</p>
      <p class="wiz-note">This sandbox mounts <strong>multiple project folders</strong>
      (configured in the terminal via <code>painapple setup NAME</code>).
      The wizard leaves that list untouched — manage it from the terminal.</p>`;
    return;
  }
  wizBody.innerHTML = `
    <p class="wiz-q">Which folder should the server work in?</p>
    <div class="wiz-row">
      <input type="text" id="wiz-folder" placeholder="${draft.engine === 'cli' ? '~ (home folder)' : '/path/to/project'}"
             value="${escapeHtml(draft.folder || '')}" spellcheck="false" autocapitalize="off">
      <button type="button" class="wiz-browse" id="wiz-folder-browse">Browse…</button>
    </div>`;
  const input = document.getElementById('wiz-folder');
  input.addEventListener('input', () => { draft.folder = input.value.trim(); });
  document.getElementById('wiz-folder-browse').addEventListener('click', async () => {
    const picked = await pickFolder(draft.folder);
    if (picked) {
      draft.folder = picked;
      input.value = picked;
      if (draft.engine === 'docker') autoLayout(draft);
    }
  });

  if (draft.engine === 'docker') {
    const label = document.createElement('div');
    label.className = 'wiz-label';
    label.textContent = 'Folder layout';
    wizBody.appendChild(label);
    wizBody.appendChild(segControl([
      { value: 'project', label: 'Single project' },
      { value: 'parent', label: 'Folder of projects' },
    ], draft.layout, v => { draft.layout = v; updateLayoutNote(draft); }));
    const note = document.createElement('div');
    note.className = 'wiz-note';
    note.id = 'wiz-layout-note';
    wizBody.appendChild(note);
    updateLayoutNote(draft);
  } else {
    const note = document.createElement('div');
    note.className = 'wiz-note';
    note.textContent = 'Sessions start here; you can open any project under it.';
    wizBody.appendChild(note);
  }
}

function updateLayoutNote(draft) {
  const note = document.getElementById('wiz-layout-note');
  if (!note) return;
  const name = (draft.folder || '').split('/').filter(Boolean).pop() || 'project';
  note.textContent = draft.layout === 'parent'
    ? 'Each subfolder becomes a project inside the container (/workspace).'
    : `Mounted as the only project (/workspace/${name}).`;
}

async function autoLayout(draft) {
  try {
    const probe = await localInvoke('local_probe_dir', { path: draft.folder });
    if (probe.exists) {
      draft.layout = probe.git ? 'project' : 'parent';
      const seg = wizBody.querySelector('.wiz-seg');
      if (seg) {
        seg.querySelectorAll('button').forEach(b =>
          b.classList.toggle('on', b.dataset.value === draft.layout));
      }
      updateLayoutNote(draft);
    }
  } catch { /* keep manual pick */ }
}

async function pickFolder(current) {
  try {
    const res = await localInvoke('plugin:dialog|open', {
      options: {
        directory: true,
        multiple: false,
        title: 'Choose folder',
        defaultPath: current || undefined,
      },
    });
    return typeof res === 'string' ? res : null;
  } catch {
    return null; // plugin unavailable — text input still works
  }
}

// -- step: claude (docker only) --

function renderClaudeStep(draft) {
  wizBody.innerHTML = '<p class="wiz-q">Which Claude account state should the container use?</p>';

  const iso = document.createElement('button');
  iso.type = 'button';
  iso.className = 'wiz-opt' + (draft.claude === 'isolated' ? ' selected' : '');
  iso.innerHTML = `
    <span class="wiz-opt-title">Isolated <span class="hint">recommended</span></span>
    <span class="wiz-opt-desc">The container gets its own Claude login and history
    (~/.painapple-code/shared/.claude, shared between sandboxes — log in once).
    Your Mac's ~/.claude stays untouched.</span>`;
  iso.addEventListener('click', () => { draft.claude = 'isolated'; renderWizStep(); });
  wizBody.appendChild(iso);

  const host = document.createElement('button');
  host.type = 'button';
  host.className = 'wiz-opt' + (draft.claude === 'host' ? ' selected' : '');
  host.innerHTML = `
    <span class="wiz-opt-title">Share this Mac's</span>
    <span class="wiz-opt-desc">Mounts your ~/.claude directly — the container reads and
    writes your real credentials, sessions, and settings.</span>`;
  host.addEventListener('click', () => { draft.claude = 'host'; renderWizStep(); });
  wizBody.appendChild(host);

  if (draft.claude === 'custom') {
    const custom = document.createElement('div');
    custom.className = 'wiz-note';
    custom.innerHTML = `Currently set to a custom path
      (<code>${escapeHtml(draft.claudeCustomPath)}</code>, from the terminal).
      Picking an option above replaces it; Next keeps it.`;
    wizBody.appendChild(custom);
  }

  if (draft.claude === 'isolated' && dockerState && dockerState.hostClaudeCreds) {
    const check = document.createElement('label');
    check.className = 'wiz-check';
    check.innerHTML = `<input type="checkbox" id="wiz-seed" ${draft.seedLogin ? 'checked' : ''}>
      Copy the login from this Mac's ~/.claude (skips claude login in the container)`;
    wizBody.appendChild(check);
    document.getElementById('wiz-seed').addEventListener('change', (e) => {
      draft.seedLogin = e.target.checked;
    });
  }
}

// -- step: network --

function renderNetworkStep(draft) {
  wizBody.innerHTML = `
    <p class="wiz-q">Network</p>
    <div class="wiz-label">Port</div>
    <div class="wiz-row">
      <input type="text" id="wiz-port" inputmode="numeric" spellcheck="false"
             value="${escapeHtml(String(draft.port || ENGINE_PORT[draft.engine]))}">
    </div>
    <div class="wiz-label">Who can connect</div>`;
  const portInput = document.getElementById('wiz-port');
  portInput.addEventListener('input', () => {
    draft.port = parseInt(portInput.value.trim(), 10) || null;
  });

  wizBody.appendChild(segControl([
    { value: 'local', label: 'This device only' },
    { value: 'lan', label: draft.listenCustom ? `Local network (${draft.listenCustom})` : 'Local network' },
  ], draft.access, v => { draft.access = v; renderWizStep(); }));

  if (draft.access === 'lan') {
    const warn = document.createElement('div');
    warn.className = 'wiz-warn';
    warn.textContent = draft.listenCustom
      ? `Reachable on ${draft.listenCustom} — anyone with the password can connect.`
      : 'Reachable from your whole network — anyone with the password can connect.';
    wizBody.appendChild(warn);

    const tlsLabel = document.createElement('div');
    tlsLabel.className = 'wiz-label';
    tlsLabel.textContent = 'Encryption (TLS, self-signed)';
    wizBody.appendChild(tlsLabel);
    wizBody.appendChild(segControl([
      { value: 'auto', label: 'Auto (on)' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ], draft.tls, v => { draft.tls = v; }));
  } else {
    const note = document.createElement('div');
    note.className = 'wiz-note';
    note.textContent = 'Only this app (127.0.0.1) can reach the server. iPads/phones need Local network.';
    wizBody.appendChild(note);
  }
}

// -- step: look --

function renderLookStep(draft) {
  wizBody.innerHTML = `
    <p class="wiz-q">Appearance</p>
    <div class="wiz-label">Instance name (shown in the app icon and UI)</div>
    <div class="wiz-row">
      <input type="text" id="wiz-name" maxlength="12" spellcheck="false"
             value="${escapeHtml(draft.name || '')}" placeholder="${draft.engine === 'cli' ? 'LOCAL' : 'e.g. MYAPP'}">
    </div>
    <div class="wiz-label">Accent color</div>
    <div class="accent-dots" id="wiz-accents"></div>`;
  document.getElementById('wiz-name').addEventListener('input', (e) => {
    draft.name = e.target.value.trim();
  });
  const dots = document.getElementById('wiz-accents');
  Object.entries(LOCAL_ACCENTS).forEach(([accent, color]) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'accent-dot' + (draft.accent === accent ? ' selected' : '');
    dot.dataset.accent = accent;
    dot.title = accent;
    dot.setAttribute('aria-label', `Accent ${accent}`);
    dot.style.background = color;
    dot.addEventListener('click', () => {
      draft.accent = accent;
      dots.querySelectorAll('.accent-dot').forEach(d =>
        d.classList.toggle('selected', d.dataset.accent === accent));
    });
    dots.appendChild(dot);
  });
}

// -- step: storage (docker only) --

function renderStorageStep(draft) {
  wizBody.innerHTML = `
    <p class="wiz-q">Where should sessions, logs, and history live?</p>`;
  wizBody.appendChild(segControl([
    { value: 'volume', label: 'Docker volume' },
    { value: 'bind', label: 'Folder on this Mac' },
  ], draft.storage, v => { draft.storage = v; renderWizStep(); }));

  if (draft.storage === 'volume') {
    const label = document.createElement('div');
    label.className = 'wiz-label';
    label.textContent = 'Volume name';
    wizBody.appendChild(label);
    const row = document.createElement('div');
    row.className = 'wiz-row';
    row.innerHTML = `<input type="text" id="wiz-volume" spellcheck="false"
      value="${escapeHtml(draft.volumeName || 'painapple-data')}">`;
    wizBody.appendChild(row);
    document.getElementById('wiz-volume').addEventListener('input', (e) => {
      draft.volumeName = e.target.value.trim();
    });
  } else {
    const label = document.createElement('div');
    label.className = 'wiz-label';
    label.textContent = 'Data folder';
    wizBody.appendChild(label);
    const row = document.createElement('div');
    row.className = 'wiz-row';
    row.innerHTML = `<input type="text" id="wiz-datadir" spellcheck="false" autocapitalize="off"
        placeholder="~/.painapple-code/shared/data"
        value="${escapeHtml(draft.dataDir || '')}">
      <button type="button" class="wiz-browse" id="wiz-datadir-browse">Browse…</button>`;
    wizBody.appendChild(row);
    document.getElementById('wiz-datadir').addEventListener('input', (e) => {
      draft.dataDir = e.target.value.trim();
    });
    document.getElementById('wiz-datadir-browse').addEventListener('click', async () => {
      const picked = await pickFolder(draft.dataDir);
      if (picked) {
        draft.dataDir = picked;
        document.getElementById('wiz-datadir').value = picked;
      }
    });
  }
}

// -- step: review --

// A new sandbox needs a CLI profile name before review/apply: a slug from
// the instance name / folder, made unique against everything on disk and
// in the card ('default' is reserved for the root host deployment).
function slugify(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 24);
}

function ensureProfile(draft) {
  if (draft.engine !== 'docker' || draft.profile) return;
  const taken = new Set([
    'default', // reserved — the root host deployment
    ...setup.instances.map(i => i.profile).filter(Boolean),
    ...diskProfiles(),
  ]);
  const base = slugify(draft.name)
    || slugify((draft.folder || '').split('/').filter(Boolean).pop())
    || 'sandbox';
  let profile = base;
  for (let i = 2; taken.has(profile); i++) profile = `${base}-${i}`;
  draft.profile = profile;
  // Match the CLI's per-profile volume default so two sandboxes never share
  // a data volume by accident (only if the user left the generic default).
  if (draft.storage === 'volume' && draft.volumeName === 'painapple-data') {
    draft.volumeName = `painapple-data-${profile}`;
  }
}

function renderReviewStep(draft) {
  ensureProfile(draft);
  const steps = wizardSteps(draft);
  const rows = [];
  const row = (key, val, stepId) => rows.push({ key, val, stepId });

  row('Engine', draft.engine === 'docker'
    ? `Docker container (${(dockerState && dockerState.runtime) || 'docker'})`
    : 'This Mac', wiz.mode === 'add' ? 'engine' : null);
  row('Folder', draft.layout === 'multi'
    ? 'multiple projects (terminal-managed)'
    : `${draft.folder || '~'}${draft.engine === 'docker' ? (draft.layout === 'parent' ? ' · folder of projects' : ' · single project') : ''}`,
    'folder');
  if (draft.engine === 'docker') {
    row('Claude', draft.claude === 'isolated'
      ? `Isolated${draft.seedLogin && dockerState && dockerState.hostClaudeCreds ? ' · login copied from this Mac' : ''}`
      : draft.claude === 'host' ? "Share this Mac's ~/.claude"
      : `Custom (${draft.claudeCustomPath})`, 'claude');
  }
  row('Network', `${draft.access === 'lan' ? (draft.listenCustom || '0.0.0.0') : '127.0.0.1'}:${effectivePort(draft)}`
    + (draft.access === 'lan' ? ` · TLS ${draft.tls}` : ''), 'network');
  row('Look', `${draft.name || '(no name)'} · ${draft.accent || 'default'}`, 'look');
  if (draft.engine === 'docker') {
    row('Storage', draft.storage === 'volume'
      ? `Docker volume "${draft.volumeName}"` : draft.dataDir, 'storage');
    if (draft.profile) {
      row('Terminal', `painapple start ${draft.profile} · status ${draft.profile} · …`, null);
    }
  }

  wizBody.innerHTML = '<p class="wiz-q">Everything look right?</p>';
  const list = document.createElement('div');
  list.className = 'wiz-review';
  rows.forEach(({ key, val, stepId }) => {
    const el = document.createElement('div');
    el.className = 'rev-row';
    el.innerHTML = `<span class="rev-key">${escapeHtml(key)}</span>
      <span class="rev-val">${escapeHtml(val)}</span>`;
    if (stepId) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'rev-edit';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => {
        wiz.stepIdx = steps.indexOf(stepId);
        renderWizStep();
      });
      el.appendChild(edit);
    }
    list.appendChild(el);
  });
  wizBody.appendChild(list);

  if (!(lastStatus && lastStatus.provisioned)) {
    const note = document.createElement('div');
    note.className = 'wiz-note';
    note.textContent = draft.engine === 'docker'
      ? 'First run: installs the painapple-code driver, downloads the container image, then starts.'
      : 'First run: downloads Python 3.13 + the server into the app\'s own folder, then starts.';
    wizBody.appendChild(note);
  }
}

// -- validation --

async function validateStep(step) {
  const draft = wiz.draft;
  if (step === 'engine') {
    if (draft.engine === 'docker' && !(dockerState && dockerState.runtime)) {
      return 'Install Docker Desktop (or Podman) first, then Recheck.';
    }
  }
  if (step === 'folder' && draft.layout !== 'multi') {
    if (draft.engine === 'docker' && !draft.folder) {
      return 'Pick the folder to mount into the container.';
    }
    if (draft.folder) {
      try {
        const probe = await localInvoke('local_probe_dir', { path: draft.folder });
        if (!probe.exists) return `Folder does not exist: ${probe.expanded}`;
        draft.folder = probe.expanded;
      } catch { /* older build without probe — let the CLI validate */ }
    }
  }
  if (step === 'network') {
    const p = effectivePort(draft);
    if (!(p >= 1 && p <= 65535)) return 'Port must be 1–65535.';
    const excludeId = draft.engine === 'cli' ? 'cli' : (wiz.editingId || draft.id || null);
    const clash = setup.instances.find(i => i.id !== excludeId && effectivePort(i) === p);
    if (clash) return `Port ${p} is already used by "${instLabel(clash)}" — pick another.`;
  }
  if (step === 'look' && (draft.name || '').length > 12) {
    return 'Instance name is max 12 characters.';
  }
  if (step === 'storage') {
    if (draft.storage === 'volume' && !draft.volumeName) return 'Volume name can\'t be empty.';
    if (draft.storage === 'bind' && !draft.dataDir) return 'Pick a data folder.';
  }
  return null;
}

// -- apply --

function wizProgress(text) {
  let p = wizBody.querySelector('.wiz-progress');
  if (!p) {
    wizBody.innerHTML = '';
    p = document.createElement('div');
    p.className = 'wiz-progress';
    p.innerHTML = '<span class="spin"></span><span class="txt"></span>';
    wizBody.appendChild(p);
  }
  p.querySelector('.txt').textContent = text;
}

async function runWizardApply() {
  const draft = wiz.draft;
  wiz.applying = true;
  wizBackBtn.style.visibility = 'hidden';
  wizNextBtn.disabled = true;
  wizCloseBtn.style.visibility = 'hidden';
  wizLog.hidden = false;
  wizLog.textContent = '';

  try {
    // 1. The Python package is needed by both engines (bridge / docker driver).
    if (!(lastStatus && lastStatus.provisioned)) {
      wizProgress('installing painapple-code…');
      await localInvoke('local_provision', {});
      lastStatus = await localInvoke('local_status');
    }

    if (draft.engine === 'docker') {
      ensureProfile(draft);

      // 2. Persist config through the CLI (validates + writes the
      //    profile.yaml; creates the profile as mode: docker if missing).
      wizProgress('saving configuration…');
      const pairs = [];
      if (draft.layout !== 'multi') {
        pairs.push(`WORKSPACE=${draft.folder}`, `WORKSPACE_MODE=${draft.layout}`);
      }
      pairs.push(
        `PORT=${effectivePort(draft)}`,
        `LISTEN_HOST=${draft.access === 'lan' ? (draft.listenCustom || '0.0.0.0') : '127.0.0.1'}`,
        `TLS_MODE=${draft.tls}`,
        `INSTANCE_NAME=${draft.name || ''}`,
        `ACCENT=${draft.accent || ''}`,
        `DATA_VOLUME=${draft.storage === 'volume' ? draft.volumeName : draft.dataDir}`,
      );
      if (draft.claude === 'isolated') pairs.push(`CLAUDE_HOME=${ISOLATED_CLAUDE_HOME}`);
      else if (draft.claude === 'host') pairs.push('CLAUDE_HOME=~/.claude');
      const set = await tool(['profile', 'set', draft.profile, ...pairs]);
      if (set.code !== 0) throw new Error('saving configuration failed — see log');

      // 3. Seed the isolated Claude home so the container starts logged in.
      if (draft.claude === 'isolated' && draft.seedLogin
          && dockerState && dockerState.hostClaudeCreds) {
        wizProgress('copying Claude login…');
        try {
          const seeded = await localInvoke('local_seed_claude', { dest: ISOLATED_CLAUDE_HOME });
          if (seeded.creds) appendWizLog('✓ credentials copied');
          if (seeded.onboarding) appendWizLog('✓ onboarding state copied');
        } catch (e) {
          appendWizLog('⚠ could not copy login: ' + e);
        }
      }

      const inst = commitDraft(draft);

      // 4. Pull (first run) + restart with the new config + health +
      // password, then go.
      const url = await ensureDockerRunning(inst, wizProgress, true);
      wizardEl.hidden = true;
      wiz = null;
      navigateToServer({ url: new URL(url).origin, name: instLabel(inst) }, url);
      return;
    }

    // --- cli engine ---
    const inst = commitDraft(draft);
    // local_start is idempotent per (port, scheme) — stop first so a changed
    // folder/name/accent actually takes effect instead of "Open"-ing the old
    // instance.
    if (lastStatus && lastStatus.running) {
      wizProgress('restarting server…');
      await localInvoke('local_stop');
    }
    wizProgress('starting server…');
    const url = await localInvoke('local_start', { config: cliStartConfig(inst) });
    wizardEl.hidden = true;
    wiz = null;
    navigateToServer({ url: new URL(url).origin, name: instLabel(inst) }, url);
  } catch (e) {
    appendWizLog('✗ ' + (e.message || e));
    // Restore footer so the user can fix a step and retry.
    wiz.applying = false;
    wizNextBtn.disabled = false;
    wizCloseBtn.style.visibility = 'visible';
    wiz.stepIdx = wizardSteps(draft).length - 1;
    renderWizStep(); // clears wizErr — set the message after
    wizErr.textContent = String(e.message || e);
    refreshLocal();
  }
}

function commitDraft(draft) {
  const inst = JSON.parse(JSON.stringify(draft));
  delete inst.discovered;
  inst.id = inst.engine === 'cli' ? 'cli' : (wiz.editingId || inst.profile);
  upsertInst(inst);
  saveSetup();
  renderLocal();
  return inst;
}

function appendWizLog(line) {
  wizLog.hidden = false;
  wizLog.textContent += line + '\n';
  wizLog.scrollTop = wizLog.scrollHeight;
}

// -- shared widgets --

function segControl(options, current, onPick) {
  const seg = document.createElement('div');
  seg.className = 'wiz-seg';
  options.forEach(({ value, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.value = value;
    btn.textContent = label;
    btn.classList.toggle('on', value === current);
    btn.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(b =>
        b.classList.toggle('on', b === btn));
      onPick(value);
    });
    seg.appendChild(btn);
  });
  return seg;
}

// --- init --------------------------------------------------------------------

async function initLocal() {
  if (!(window.__TAURI__ && window.__TAURI__.core)) {
    localEl.remove();
    wizardEl.remove();
    return;
  }
  try { lastStatus = await localInvoke('local_status'); }
  catch {
    // iOS build / plain browser — no local mode.
    localEl.remove();
    wizardEl.remove();
    return;
  }
  try { dockerState = await localInvoke('local_docker_state'); }
  catch { dockerState = { runtime: null, configured: false, profiles: [], hostClaudeCreds: false }; }
  localEl.hidden = false;

  document.getElementById('local-log-toggle').addEventListener('click', async () => {
    if (localLog.hidden) {
      try {
        const lines = await localInvoke('local_logs');
        localLog.textContent = lines.join('\n') + (lines.length ? '\n' : '');
      } catch { /* keep whatever's there */ }
      localLog.hidden = false;
      localLog.scrollTop = localLog.scrollHeight;
    } else {
      localLog.hidden = true;
    }
  });

  window.__TAURI__.event.listen('local-progress', (e) => {
    // Wizard open → its log pane; otherwise the card log (server chatter
    // only when the pane is already open).
    if (wiz && !wizardEl.hidden) {
      appendWizLog(e.payload.line);
    } else if (!localLog.hidden) {
      appendLocalLog(e.payload.line);
    } else if (e.payload.stage !== 'server') {
      appendLocalLog(e.payload.line);
    }
  });
  window.__TAURI__.event.listen('local-server-exited', () => refreshLocal());

  renderLocal();
  adoptDiskProfiles();
}
initLocal();
