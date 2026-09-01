import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium, firefox, webkit, devices } from 'playwright';

const ROOT = process.cwd();
const baseUrl = (process.env.KISS_QA_BASE_URL || 'http://127.0.0.1:4321').replace(/\/+$/, '');
const engineName = process.env.KISS_QA_ENGINE || 'chromium';
const profileSet = process.env.KISS_QA_PROFILE_SET || 'full';
const osLabel = process.env.KISS_QA_OS || process.platform;
const configPath = path.resolve(ROOT, process.env.KISS_QA_CONFIG || '.kiss-qa.json');
const artifactRoot = path.resolve(ROOT, '.kiss-qa-artifacts', osLabel, engineName);

const DEFAULT_THRESHOLDS = {
  horizontalOverflowPx: 2,
  aboveFoldWarnRatio: 0.26,
  aboveFoldFailRatio: 0.38,
  heroTallWarnRatio: 1.18,
  heroTallFailRatio: 1.45,
  heroContentOccupancyWarn: 0.62,
  heroContentOccupancyFail: 0.52,
  heroTopGapWarnRatio: 0.26,
  heroTopGapFailRatio: 0.36,
  columnStartWarnPx: 120,
  columnStartWarnVh: 0.14,
  columnStartFailPx: 140,
  columnStartFailVh: 0.14,
  columnBlankFailRatio: 0.28,
  columnBlankWarnRatio: 0.22,
  sectionPaddingWarnPx: 180,
  sectionPaddingWarnVh: 0.19,
  sectionContentOccupancyWarn: 0.65
};

const defaultProfiles = {
  chromium: {
    full: [
      { name: 'phone-small-360x800', viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true },
      { name: 'pixel-7', device: 'Pixel 7' },
      { name: 'phone-large-430x932', viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true },
      { name: 'phone-landscape-844x390', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
      { name: 'tablet-768x1024', viewport: { width: 768, height: 1024 }, hasTouch: true },
      { name: 'tablet-landscape-1024x768', viewport: { width: 1024, height: 768 }, hasTouch: true },
      { name: 'laptop-1366x768', viewport: { width: 1366, height: 768 } },
      { name: 'desktop-1440x1000', viewport: { width: 1440, height: 1000 } },
      { name: 'wide-1920x1080', viewport: { width: 1920, height: 1080 } }
    ],
    core: [
      { name: 'phone-390x844', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      { name: 'tablet-768x1024', viewport: { width: 768, height: 1024 }, hasTouch: true },
      { name: 'desktop-1440x1000', viewport: { width: 1440, height: 1000 } }
    ],
    'os-smoke': [
      { name: 'phone-390x844', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      { name: 'desktop-1440x1000', viewport: { width: 1440, height: 1000 } }
    ]
  },
  firefox: {
    full: [
      { name: 'phone-390x844', viewport: { width: 390, height: 844 } },
      { name: 'tablet-768x1024', viewport: { width: 768, height: 1024 } },
      { name: 'desktop-1440x1000', viewport: { width: 1440, height: 1000 } },
      { name: 'wide-1920x1080', viewport: { width: 1920, height: 1080 } }
    ],
    core: [
      { name: 'phone-390x844', viewport: { width: 390, height: 844 } },
      { name: 'desktop-1440x1000', viewport: { width: 1440, height: 1000 } }
    ],
    'os-smoke': [
      { name: 'desktop-1440x1000', viewport: { width: 1440, height: 1000 } }
    ]
  },
  webkit: {
    full: [
      { name: 'iphone-se', device: 'iPhone SE' },
      { name: 'iphone-15', device: 'iPhone 15' },
      { name: 'ipad-mini', device: 'iPad Mini' },
      { name: 'desktop-safari', device: 'Desktop Safari' },
      { name: 'wide-1920x1080', viewport: { width: 1920, height: 1080 } }
    ],
    core: [
      { name: 'iphone-se', device: 'iPhone SE' },
      { name: 'iphone-15', device: 'iPhone 15' },
      { name: 'desktop-safari', device: 'Desktop Safari' }
    ],
    'os-smoke': [
      { name: 'iphone-15', device: 'iPhone 15' },
      { name: 'desktop-safari', device: 'Desktop Safari' }
    ]
  }
};

const engines = { chromium, firefox, webkit };
if (!engines[engineName]) {
  throw new Error(`Unsupported KISS_QA_ENGINE "${engineName}". Expected chromium, firefox or webkit.`);
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }
}

const config = await readConfig();
const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds || {}) };
const maxRoutes = Number(config.maxRoutes || 12);
const explicitRoutes = Array.isArray(config.routes) ? config.routes : null;
const allowRules = Array.isArray(config.allow) ? config.allow : [];
const failOnWarnings = config.failOnWarnings === true;

function routeKey(route) {
  const clean = route.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  return clean ? clean.replace(/[^a-z0-9_-]+/gi, '-') : 'home';
}

function isAllowed(route, rule, selector = '') {
  return allowRules.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const routeOk = !entry.route || entry.route === route || entry.route === '*';
    const ruleOk = !entry.rule || entry.rule === rule || entry.rule === '*';
    const selectorOk = !entry.selector || entry.selector === selector;
    return routeOk && ruleOk && selectorOk;
  });
}

function contextOptions(profile) {
  const base = {
    locale: config.locale || 'de-DE',
    colorScheme: config.colorScheme || 'light',
    reducedMotion: 'reduce'
  };
  if (profile.device && devices[profile.device]) return { ...devices[profile.device], ...base };
  return {
    ...base,
    viewport: profile.viewport,
    isMobile: Boolean(profile.isMobile),
    hasTouch: Boolean(profile.hasTouch)
  };
}

async function settle(page) {
  await page.evaluate(() => {
    for (const img of document.images) img.loading = 'eager';
  });
  await page.waitForLoadState('networkidle', { timeout: 7_000 }).catch(() => {});
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    const imgs = [...document.images];
    await Promise.all(imgs.map(async (img) => {
      if (!img.complete) {
        await Promise.race([
          new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }),
          new Promise((resolve) => setTimeout(resolve, 3500))
        ]);
      }
      try { await img.decode?.(); } catch {}
    }));
  });
  await page.waitForTimeout(80);
}

async function discoverRoutes(browserType) {
  if (explicitRoutes?.length) return [...new Set(explicitRoutes.map((r) => r.startsWith('/') ? r : `/${r}`))];

  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: config.locale || 'de-DE' });
  const page = await context.newPage();
  const discovered = new Set(['/']);

  try {
    const response = await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response || response.status() >= 400) return ['/'];
    await settle(page);
    const sameOrigin = await page.evaluate((limit) => {
      const out = [];
      for (const anchor of document.querySelectorAll('a[href]')) {
        const raw = anchor.getAttribute('href');
        if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
        try {
          const u = new URL(raw, location.href);
          if (u.origin !== location.origin) continue;
          out.push(`${u.pathname}${u.search}`);
        } catch {}
        if (out.length >= limit * 3) break;
      }
      return out;
    }, maxRoutes);
    for (const item of sameOrigin) {
      const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
      let p = item.split('?')[0] || '/';
      if (basePath && basePath !== '/' && p.startsWith(basePath)) p = p.slice(basePath.length) || '/';
      if (!p.startsWith('/')) p = `/${p}`;
      discovered.add(p);
      if (discovered.size >= maxRoutes) break;
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return [...discovered];
}

const meaningfulSelector = [
  'h1','h2','h3','h4','h5','h6','p','blockquote','li','dt','dd',
  'a[href]','button','input','textarea','select','img','picture','video',
  'form','table','address','[role="button"]','[role="img"]'
].join(',');

async function collectLayout(page) {
  return page.evaluate(({ meaningfulSelector, thresholds }) => {
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.02) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };

    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top + scrollY,
        bottom: r.bottom + scrollY,
        left: r.left + scrollX,
        right: r.right + scrollX,
        width: r.width,
        height: r.height
      };
    };

    const main = document.querySelector('main') || document.body;
    const header = document.querySelector('header, [role="banner"], .site-header');
    const headerRect = rectOf(header);
    const mainRect = rectOf(main);

    const firstSection =
      main.querySelector('[data-kiss-hero], :scope > .hero, :scope > [class*="hero"], :scope > section:first-of-type, :scope > section:first-child')
      || main.firstElementChild;
    const hero = firstSection && visible(firstSection) ? firstSection : null;
    const heroRect = rectOf(hero);

    const meaningful = [...main.querySelectorAll(meaningfulSelector)]
      .filter(visible)
      .map((el) => ({ el, rect: rectOf(el) }))
      .filter((x) => x.rect);

    const topOrigin = Math.max(headerRect?.bottom || 0, mainRect?.top || 0);
    const firstMeaningful = meaningful
      .filter((x) => x.rect.bottom >= topOrigin - 2)
      .sort((a, b) => a.rect.top - b.rect.top)[0]?.rect || null;

    let heroMetrics = null;
    if (hero && heroRect) {
      const inside = meaningful.filter((x) => {
        const r = x.rect;
        return r.bottom > heroRect.top && r.top < heroRect.bottom && r.right > heroRect.left && r.left < heroRect.right;
      });

      const clipped = inside.map(({ rect }) => ({
        top: Math.max(rect.top, heroRect.top),
        bottom: Math.min(rect.bottom, heroRect.bottom)
      })).filter((r) => r.bottom > r.top).sort((a, b) => a.top - b.top);

      const merged = [];
      for (const interval of clipped) {
        const last = merged.at(-1);
        if (last && interval.top <= last.bottom + 2) last.bottom = Math.max(last.bottom, interval.bottom);
        else merged.push({ ...interval });
      }
      const occupied = merged.reduce((sum, r) => sum + (r.bottom - r.top), 0);
      const contentTop = inside.length ? Math.min(...inside.map((x) => x.rect.top)) : heroRect.bottom;
      const contentBottom = inside.length ? Math.max(...inside.map((x) => x.rect.bottom)) : heroRect.top;
      const contentSpan = Math.max(0, Math.min(heroRect.bottom, contentBottom) - Math.max(heroRect.top, contentTop));

      const directChildren = [...hero.children].filter(visible);
      const columnCandidates = [];
      const heroWidth = Math.max(1, heroRect.width);
      for (const child of directChildren) {
        const childRect = rectOf(child);
        if (!childRect || childRect.width < heroWidth * 0.22) continue;
        const childMeaningful = [...child.querySelectorAll(meaningfulSelector)].filter(visible);
        if (child.matches(meaningfulSelector)) childMeaningful.unshift(child);
        const tops = childMeaningful.map((el) => rectOf(el)?.top).filter((v) => Number.isFinite(v));
        if (!tops.length) continue;
        columnCandidates.push({
          selector: child.id ? `#${child.id}` : child.classList.length ? `.${[...child.classList].slice(0, 2).join('.')}` : child.tagName.toLowerCase(),
          top: Math.min(...tops),
          width: childRect.width,
          height: childRect.height
        });
      }

      if (columnCandidates.length < 2 && directChildren.length === 1) {
        const wrapper = directChildren[0];
        const wrapperRect = rectOf(wrapper);
        if (wrapperRect && wrapperRect.width > heroWidth * 0.7) {
          for (const child of [...wrapper.children].filter(visible)) {
            const childRect = rectOf(child);
            if (!childRect || childRect.width < heroWidth * 0.22) continue;
            const childMeaningful = [...child.querySelectorAll(meaningfulSelector)].filter(visible);
            if (child.matches(meaningfulSelector)) childMeaningful.unshift(child);
            const tops = childMeaningful.map((el) => rectOf(el)?.top).filter((v) => Number.isFinite(v));
            if (!tops.length) continue;
            columnCandidates.push({
              selector: child.id ? `#${child.id}` : child.classList.length ? `.${[...child.classList].slice(0, 2).join('.')}` : child.tagName.toLowerCase(),
              top: Math.min(...tops),
              width: childRect.width,
              height: childRect.height
            });
          }
        }
      }

      const style = getComputedStyle(hero);
      heroMetrics = {
        selector: hero.id ? `#${hero.id}` : hero.classList.length ? `.${[...hero.classList].slice(0, 2).join('.')}` : hero.tagName.toLowerCase(),
        rect: heroRect,
        contentTop,
        contentBottom,
        contentSpan,
        occupiedVerticalPx: occupied,
        occupiedVerticalRatio: heroRect.height ? occupied / heroRect.height : 1,
        topGap: Math.max(0, contentTop - heroRect.top),
        bottomGap: Math.max(0, heroRect.bottom - contentBottom),
        paddingTop: Number.parseFloat(style.paddingTop) || 0,
        paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
        columns: columnCandidates
      };
    }

    const root = document.documentElement;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: {
        scrollWidth: Math.max(root.scrollWidth, document.body?.scrollWidth || 0),
        clientWidth: root.clientWidth,
        scrollHeight: Math.max(root.scrollHeight, document.body?.scrollHeight || 0)
      },
      headerRect,
      mainRect,
      firstMeaningful,
      aboveFoldGap: firstMeaningful ? Math.max(0, firstMeaningful.top - topOrigin) : null,
      hero: heroMetrics,
      thresholdEcho: thresholds
    };
  }, { meaningfulSelector, thresholds });
}

function evaluateLayout(route, metrics) {
  const fails = [];
  const warnings = [];
  const vh = metrics.viewport.height;
  const overflow = metrics.page.scrollWidth - metrics.page.clientWidth;

  if (overflow > thresholds.horizontalOverflowPx && !isAllowed(route, 'horizontal-overflow')) {
    fails.push({
      rule: 'horizontal-overflow',
      message: `Horizontal overflow ${Math.round(overflow)}px exceeds ${thresholds.horizontalOverflowPx}px.`
    });
  }

  if (metrics.aboveFoldGap != null && !isAllowed(route, 'above-fold-gap')) {
    const ratio = metrics.aboveFoldGap / vh;
    if (ratio > thresholds.aboveFoldFailRatio) {
      fails.push({ rule: 'above-fold-gap', message: `First meaningful content starts ${Math.round(metrics.aboveFoldGap)}px (${(ratio * 100).toFixed(0)}vh) below the content origin.` });
    } else if (ratio > thresholds.aboveFoldWarnRatio) {
      warnings.push({ rule: 'above-fold-gap', message: `Large first-content gap: ${Math.round(metrics.aboveFoldGap)}px (${(ratio * 100).toFixed(0)}vh).` });
    }
  }

  const hero = metrics.hero;
  if (hero && hero.rect.height > 0) {
    const heroHeightRatio = hero.rect.height / vh;
    const contentOccupancy = hero.contentSpan / hero.rect.height;
    if (!isAllowed(route, 'hero-height', hero.selector)) {
      if (heroHeightRatio > thresholds.heroTallFailRatio && contentOccupancy < thresholds.heroContentOccupancyFail) {
        fails.push({ rule: 'hero-height', selector: hero.selector, message: `Hero is ${(heroHeightRatio * 100).toFixed(0)}vh high while content spans only ${(contentOccupancy * 100).toFixed(0)}% of it.` });
      } else if (heroHeightRatio > thresholds.heroTallWarnRatio && contentOccupancy < thresholds.heroContentOccupancyWarn) {
        warnings.push({ rule: 'hero-height', selector: hero.selector, message: `Hero is unusually tall (${(heroHeightRatio * 100).toFixed(0)}vh) for its content (${(contentOccupancy * 100).toFixed(0)}% span).` });
      }
    }

    const topGapRatio = hero.topGap / hero.rect.height;
    if (!isAllowed(route, 'hero-top-gap', hero.selector)) {
      if (topGapRatio > thresholds.heroTopGapFailRatio && hero.topGap > 220) {
        fails.push({ rule: 'hero-top-gap', selector: hero.selector, message: `Hero content begins ${Math.round(hero.topGap)}px into the section (${(topGapRatio * 100).toFixed(0)}%).` });
      } else if (topGapRatio > thresholds.heroTopGapWarnRatio && hero.topGap > 150) {
        warnings.push({ rule: 'hero-top-gap', selector: hero.selector, message: `Large hero top gap: ${Math.round(hero.topGap)}px (${(topGapRatio * 100).toFixed(0)}%).` });
      }
    }

    if (!isAllowed(route, 'section-padding', hero.selector)) {
      const paddingLimit = Math.max(thresholds.sectionPaddingWarnPx, vh * thresholds.sectionPaddingWarnVh);
      const contentRatio = hero.contentSpan / hero.rect.height;
      if ((hero.paddingTop > paddingLimit || hero.paddingBottom > paddingLimit) && contentRatio < thresholds.sectionContentOccupancyWarn) {
        warnings.push({
          rule: 'section-padding',
          selector: hero.selector,
          message: `Hero padding is large (top ${Math.round(hero.paddingTop)}px / bottom ${Math.round(hero.paddingBottom)}px) while content spans ${(contentRatio * 100).toFixed(0)}%.`
        });
      }
    }

    if (hero.columns?.length >= 2 && !isAllowed(route, 'column-start-delta', hero.selector)) {
      const starts = hero.columns.map((c) => c.top).filter(Number.isFinite);
      const minTop = Math.min(...starts);
      const maxTop = Math.max(...starts);
      const delta = maxTop - minTop;
      const blankRatio = Math.max(0, maxTop - hero.rect.top) / hero.rect.height;
      const warnLimit = Math.max(thresholds.columnStartWarnPx, vh * thresholds.columnStartWarnVh);
      const failLimit = Math.max(thresholds.columnStartFailPx, vh * thresholds.columnStartFailVh);
      if (delta > failLimit && blankRatio > thresholds.columnBlankFailRatio) {
        fails.push({
          rule: 'column-start-delta',
          selector: hero.selector,
          message: `Hero columns start ${Math.round(delta)}px apart; the lower column leaves ${(blankRatio * 100).toFixed(0)}% of hero height empty above its content.`
        });
      } else if (delta > warnLimit && blankRatio > thresholds.columnBlankWarnRatio) {
        warnings.push({
          rule: 'column-start-delta',
          selector: hero.selector,
          message: `Hero column starts differ by ${Math.round(delta)}px with ${(blankRatio * 100).toFixed(0)}% blank space above the lower column.`
        });
      }
    }
  }

  return { fails, warnings };
}

async function run() {
  await fs.rm(artifactRoot, { recursive: true, force: true });
  await fs.mkdir(artifactRoot, { recursive: true });

  const browserType = engines[engineName];
  const profiles = defaultProfiles[engineName]?.[profileSet] || defaultProfiles[engineName]?.core;
  const routes = await discoverRoutes(browserType);
  const browser = await browserType.launch({ headless: true });
  const results = [];
  const globalFails = [];
  const globalWarnings = [];

  try {
    for (const profile of profiles) {
      const context = await browser.newContext(contextOptions(profile));
      for (const route of routes) {
        const page = await context.newPage();
        const consoleErrors = [];
        const responseErrors = [];

        page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`);
        });
        page.on('response', (response) => {
          if (response.status() < 400) return;
          try {
            const current = new URL(response.url());
            const base = new URL(baseUrl);
            if (current.origin === base.origin) responseErrors.push(`${response.status()} ${current.pathname}`);
          } catch {}
        });

        const targetUrl = `${baseUrl}${route === '/' ? '/' : route}`;
        let navigationStatus = null;
        let metrics = null;
        let assessed = { fails: [], warnings: [] };

        try {
          const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          navigationStatus = response?.status() ?? null;
          if (!response || response.status() >= 400) {
            assessed.fails.push({ rule: 'navigation', message: `Navigation failed with status ${navigationStatus ?? 'none'}.` });
          } else {
            await settle(page);
            metrics = await collectLayout(page);
            assessed = evaluateLayout(route, metrics);
          }
        } catch (error) {
          assessed.fails.push({ rule: 'navigation', message: error.message });
        }

        if (consoleErrors.length) {
          assessed.fails.push({ rule: 'browser-errors', message: [...new Set(consoleErrors)].join(' | ') });
        }
        if (responseErrors.length) {
          assessed.fails.push({ rule: 'network-errors', message: [...new Set(responseErrors)].join(' | ') });
        }

        const screenshotName = `${routeKey(route)}--${profile.name}.png`;
        await page.screenshot({ path: path.join(artifactRoot, screenshotName), fullPage: false }).catch(() => {});

        const enrichedFails = assessed.fails.map((f) => ({ ...f, route, profile: profile.name, engine: engineName, os: osLabel }));
        const enrichedWarnings = assessed.warnings.map((w) => ({ ...w, route, profile: profile.name, engine: engineName, os: osLabel }));
        globalFails.push(...enrichedFails);
        globalWarnings.push(...enrichedWarnings);
        results.push({
          route,
          profile: profile.name,
          engine: engineName,
          os: osLabel,
          navigationStatus,
          metrics,
          fails: enrichedFails,
          warnings: enrichedWarnings
        });

        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    os: osLabel,
    engine: engineName,
    profileSet,
    routes,
    thresholds,
    failOnWarnings,
    summary: { failures: globalFails.length, warnings: globalWarnings.length, cases: results.length },
    failures: globalFails,
    warnings: globalWarnings,
    cases: results
  };

  await fs.writeFile(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2));

  const lines = [
    '# KISS Visual Quality Gate',
    '',
    `- OS: **${osLabel}**`,
    `- Engine: **${engineName}**`,
    `- Profilset: **${profileSet}**`,
    `- Routen: **${routes.length}**`,
    `- Fälle: **${results.length}**`,
    `- Fehler: **${globalFails.length}**`,
    `- Warnungen: **${globalWarnings.length}**`,
    ''
  ];

  if (globalFails.length) {
    lines.push('## Fehler', '');
    for (const item of globalFails) {
      lines.push(`- **${item.rule}** — ${item.route} / ${item.profile}: ${item.message}`);
    }
    lines.push('');
  }

  if (globalWarnings.length) {
    lines.push('## Warnungen', '');
    for (const item of globalWarnings) {
      lines.push(`- **${item.rule}** — ${item.route} / ${item.profile}: ${item.message}`);
    }
    lines.push('');
  }

  if (!globalFails.length && !globalWarnings.length) {
    lines.push('Keine verdächtigen Layout-Proportionen oder technischen Rendering-Probleme erkannt.', '');
  }

  await fs.writeFile(path.join(artifactRoot, 'report.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));

  if (globalFails.length || (failOnWarnings && globalWarnings.length)) {
    process.exit(1);
  }
}

await run();
