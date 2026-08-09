/**
 * AboutWidget — app identity: version, license, and where the source lives.
 *
 * Split out of the help modal's About section. The version rows STAY in help
 * (that's where people look when something seems stale), but the legal and
 * project-identity material belongs in a panel of its own — help is already a
 * long scroll of shortcuts, and a license notice buried under it isn't much of
 * a notice.
 *
 * Why this panel is load-bearing rather than decorative: painapple-code is
 * AGPL-3.0-or-later, and §13 obliges anyone offering it over a network to
 * offer that network's users the corresponding source. A bridge whose whole
 * purpose is being reached from other devices is squarely in scope, so the
 * source link below is the compliance surface, not a courtesy.
 *
 * License and URLs come from /api/info (read from installed distribution
 * metadata), never hardcoded here — a fork changes pyproject.toml and this
 * panel follows it, which is the only way the offer stays truthful.
 */

import { WidgetManager, getIcon } from '../widget-system/index.js';
import { getVersionInfo } from '../config.js';
import { escapeHtml } from '../utils.js';
import { showToast } from '../context-menu.js';
import S from '../strings.js';

/** Epoch-seconds build stamp → readable local timestamp. */
function formatBuild(stamp) {
    const secs = Number(stamp);
    if (!secs || !Number.isFinite(secs)) return stamp ? String(stamp) : '';
    const d = new Date(secs * 1000);
    if (Number.isNaN(d.getTime())) return String(stamp);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Pick a URL by label, tolerating however the dist spelled it.
 * pyproject labels are free-form ("Source", "Repository", "Source Code"), so
 * match case-insensitively against a list of aliases rather than one key.
 */
function pickUrl(urls, aliases) {
    if (!urls) return null;
    const entries = Object.entries(urls);
    for (const alias of aliases) {
        const hit = entries.find(([k]) => k.toLowerCase() === alias.toLowerCase());
        if (hit && hit[1]) return hit[1];
    }
    return null;
}

/** External link row. rel=noopener because target=_blank without it leaks window.opener. */
function linkRow(url, label, desc) {
    if (!url) return '';
    return `
        <a class="about-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
            <div class="about-link-text">
                <span class="about-link-label">${escapeHtml(label)}</span>
                <span class="about-link-desc">${escapeHtml(desc)}</span>
            </div>
            <span class="about-link-icon">${getIcon('external')}</span>
        </a>
    `;
}

function row(label, value) {
    return `
        <div class="about-row">
            <span class="about-row-label">${escapeHtml(label)}</span>
            <code class="about-row-value">${escapeHtml(value)}</code>
        </div>
    `;
}

/** Plain-text version block for the clipboard — what you paste into a bug report. */
function versionText(info) {
    const lines = [
        `${S.about.app_name} ${info.server || S.about.unknown}`,
        `${S.about.frontend}: ${formatBuild(info.clientBuild) || S.about.unknown}`,
    ];
    if (info.restartNeeded && info.diskVersion) lines.push(`on disk: ${info.diskVersion}`);
    lines.push(`${S.about.license_row}: ${info.license || ''}`.trim());
    lines.push(`${navigator.userAgent}`);
    return lines.join('\n');
}

function renderBody(container) {
    const info = getVersionInfo();
    const urls = info.urls || {};

    const source = pickUrl(urls, ['Source', 'Repository', 'Source Code', 'Code']);
    const issues = pickUrl(urls, ['Issues', 'Bug Tracker', 'Tracker']);
    const homepage = pickUrl(urls, ['Homepage', 'Home']);
    const docs = pickUrl(urls, ['Documentation', 'Docs']);

    // The license text itself ships in the repo; point at it there rather
    // than inlining 660 lines of AGPL into a popup.
    const licenseUrl = source ? `${source.replace(/\/+$/, '')}/blob/main/LICENSE` : null;
    const noticesUrl = source ? `${source.replace(/\/+$/, '')}/blob/main/THIRD_PARTY_NOTICES.md` : null;

    // Two independent staleness axes with different remedies — newer assets
    // on the server means reload the page, newer code in the checkout than
    // the server booted with means restart the server.
    const hints = [];
    if (info.restartNeeded) {
        hints.push(S.help.about_restart.replace('{disk}', info.diskVersion || ''));
    }
    if (info.stale) {
        hints.push(S.help.about_stale.replace('{build}', formatBuild(info.serverBuild) || ''));
    }

    container.innerHTML = `
        <div class="about-widget-body">
            <div class="about-hero">
                <div class="about-hero-name">${escapeHtml(S.about.app_name)}</div>
                <div class="about-hero-version">${escapeHtml(info.server || S.about.unknown)}</div>
                <div class="about-hero-tagline">${escapeHtml(S.about.tagline)}</div>
            </div>

            <div class="about-section">
                <h4>${escapeHtml(S.about.version_title)}</h4>
                ${info.server ? row(S.about.server, info.server) : ''}
                ${formatBuild(info.clientBuild) ? row(S.about.frontend, formatBuild(info.clientBuild)) : ''}
                ${hints.map((h) => `<div class="about-hint">${escapeHtml(h)}</div>`).join('')}
                <button class="about-copy-btn" data-action="copy-version">
                    ${getIcon('copy')}<span>${escapeHtml(S.about.copy_version)}</span>
                </button>
            </div>

            <div class="about-section">
                <h4>${escapeHtml(S.about.license_title)}</h4>
                ${info.license ? row(S.about.license_row, info.license) : ''}
                <div class="about-notice">${escapeHtml(S.about.license_notice)}</div>
                ${linkRow(licenseUrl, S.about.license_link, '')}
                ${linkRow(noticesUrl, S.about.third_party, '')}
            </div>

            <div class="about-section">
                <h4>${escapeHtml(S.about.links_title)}</h4>
                ${linkRow(source, S.about.source, S.about.source_desc)}
                ${linkRow(issues, S.about.issues, S.about.issues_desc)}
                ${linkRow(docs, S.about.docs, S.about.docs_desc)}
                ${linkRow(homepage, S.about.homepage, S.about.homepage_desc)}
            </div>
        </div>
    `;

    const copyBtn = container.querySelector('[data-action="copy-version"]');
    copyBtn?.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(versionText(getVersionInfo()));
            showToast(S.about.copied);
        } catch {
            // Clipboard API needs a secure context; plain-http LAN access is
            // a normal way to reach this bridge, so failure isn't exceptional.
            showToast(S.errors.copy_failed);
        }
    });
}

export function registerAboutWidget() {
    WidgetManager.register('about', {
        title: S.about.title,
        icon: 'info',
        type: 'floating',
        scope: 'global',
        // Tall enough that the source-code link clears the fold — it's the
        // AGPL §13 offer, so it shouldn't need a scroll to discover.
        size: { width: 520, height: 760 },
        minSize: { width: 360, height: 400 },

        render(container) {
            container.classList.add('about-widget');
            renderBody(container);
        },
    });
}

export const AboutWidget = {
    open: () => WidgetManager.open('about'),
    close: () => WidgetManager.close('about'),
};
