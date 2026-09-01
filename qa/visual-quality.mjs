import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium, firefox, webkit, devices } from 'playwright';

const ROOT = process.cwd();
const BASE_URL = (process.env.KISS_QA_BASE_URL || 'http://127.0.0.1:4321').replace(/\/+$/, '');
const ENGINE = process.env.KISS_QA_ENGINE || 'chromium';
const PROFILE_SET = process.env.KISS_QA_PROFILE_SET || 'full';
const OS = process.env.KISS_QA_OS || process.platform;
const CONFIG_PATH = path.resolve(ROOT, process.env.KISS_QA_CONFIG || '.kiss-qa.json');
const ARTIFACT_ROOT = path.resolve(ROOT, 'kiss-qa-artifacts', OS, ENGINE);

const DEFAULT_THRESHOLDS = Object.freeze({
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
  sideBySideMaxHorizontalOverlap: 0.35,
  sectionPaddingWarnPx: 180,
  sectionPaddingWarnVh: 0.19,
  sectionContentOccupancyWarn: 0.65
});

const PROFILES = {
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
      { name: 'desktop-webkit', device: 'Desktop Safari' },
      { name: 'wide-1920x1080', viewport: { width: 1920, height: 1080 } }
    ],
    core: [
      { name: 'iphone-se', device: 'iPhone SE' },
      { name: 'iphone-15', device: 'iPhone 15' },
      { name: 'desktop-webkit', device: 'Desktop Safari' }
    ],
    'os-smoke': [
      { name: 'iphone-15', device: 'iPhone 15' },
      { name: 'desktop-webkit', device: 'Desktop Safari' }
    ]
  }
};

const BROWSERS = { chromium, firefox, webkit };
if (!BROWSERS[ENGINE]) throw new Error(`Unsupported KISS_QA_ENGINE: ${ENGINE}`);

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
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

function joinUrl(base, route = '/') {
  const suffix = String(route || '/').replace(/^\/+/, '');
  return suffix ? `${base}/${suffix}` : `${base}/`;
}

function allowed(route, rule, selector = '') {
  return allowRules.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return (!entry.route || entry.route === route || entry.route === '*')
      && (!entry.rule || entry.rule === rule || entry.rule === '*')
      && (!entry.selector || entry.selector === selector);
  });
}

function profileOptions(profile) {
  const base = {
    locale: config.locale || 'de-DE',
    colorScheme: config.colorScheme || 'light',
    reducedMotion: 'reduce'
  };
  if (profile.device) {
    const device = devices[profile.device];
    if (!device) throw new Error(`Unknown Playwright device profile: ${profile.device}`);
    return { ...device, ...base };
  }
  return {
    ...base,
    viewport: profile.viewport,
    ...(ENGINE === 'chromium' ? { isMobile: Boolean(profile.isMobile), hasTouch: Boolean(profile.hasTouch) } : {})
  };
}

async function settle(page) {
  await page.evaluate(() => {
    for (const img of document.images) img.loading = 'eager';
  });
  await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all([...document.images].map(async (img) => {
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
  if (explicitRoutes?.length) {
    return [...new Set(explicitRoutes.map((route) => route.startsWith('/') ? route : `/${route}`))].slice(0, maxRoutes);
  }

  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: config.locale || 'de-DE' });
  const page = await context.newPage();
  try {
    const response = await page.goto(joinUrl(BASE_URL, '/'), { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response || response.status() >= 400) return ['/'];
    await settle(page);
    const rawRoutes = await page.evaluate((limit) => {
      const found = [];
      for (const anchor of document.querySelectorAll('a[href]')) {
        const raw = anchor.getAttribute('href');
        if (!raw || /^(?:#|mailto:|tel:|javascript:)/i.test(raw)) continue;
        try {
          const url = new URL(raw, location.href);
          if (url.origin !== location.origin) continue;
          found.push(url.pathname);
        } catch {}
        if (found.length >= limit * 3) break;
      }
      return found;
    }, maxRoutes);

    const basePath = new URL(BASE_URL).pathname.replace(/\/+$/, '');
    const routes = new Set(['/']);
    for (let raw of rawRoutes) {
      if (basePath && basePath !== '/' && raw.startsWith(basePath)) raw = raw.slice(basePath.length) || '/';
      if (!raw.startsWith('/')) raw = `/${raw}`;
      routes.add(raw);
      if (routes.size >= maxRoutes) break;
    }
    return [...routes];
  } finally {
    await context.close();
    await browser.close();
  }
}

const MEANINGFUL_SELECTOR = [
  'h1','h2','h3','h4','h5','h6','p','blockquote','li','dt','dd',
  'a[href]','button','input','textarea','select','img','picture','video',
  'form','table','address','[role="button"]','[role="img"]'
].join(',');

async function collectLayout(page) {
  return page.evaluate((meaningfulSelector) => {
    const visible = (element) => {
      if (!(element instanceof Element)) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.02) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };

    const box = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return {
        top: r.top + scrollY,
        bottom: r.bottom + scrollY,
        left: r.left + scrollX,
        right: r.right + scrollX,
        width: r.width,
        height: r.height
      };
    };

    const selectorFor = (element) => element.id
      ? `#${element.id}`
      : element.classList.length
        ? `.${[...element.classList].slice(0, 2).join('.')}`
        : element.tagName.toLowerCase();

    const main = document.querySelector('main') || document.body;
    const header = document.querySelector('header, [role="banner"], .site-header');
    const mainBox = box(main);
    const headerBox = box(header);
    const heroCandidate = main.querySelector(
      '[data-kiss-hero], :scope > .hero, :scope > [class*="hero"], :scope > section:first-of-type, :scope > section:first-child'
    ) || main.firstElementChild;
    const hero = heroCandidate && visible(heroCandidate) ? heroCandidate : null;
    const heroBox = box(hero);

    const meaningful = [...main.querySelectorAll(meaningfulSelector)]
      .filter(visible)
      .map((element) => ({ element, box: box(element) }))
      .filter((item) => item.box);

    const contentOrigin = Math.max(headerBox?.bottom || 0, mainBox?.top || 0);
    const firstMeaningful = meaningful
      .filter((item) => item.box.bottom >= contentOrigin - 2)
      .sort((a, b) => a.box.top - b.box.top)[0]?.box || null;

    let heroData = null;
    if (hero && heroBox) {
      const inside = meaningful.filter((item) => {
        const r = item.box;
        return r.bottom > heroBox.top && r.top < heroBox.bottom && r.right > heroBox.left && r.left < heroBox.right;
      });
      const contentTop = inside.length ? Math.min(...inside.map((item) => item.box.top)) : heroBox.bottom;
      const contentBottom = inside.length ? Math.max(...inside.map((item) => item.box.bottom)) : heroBox.top;
      const contentSpan = Math.max(0, Math.min(heroBox.bottom, contentBottom) - Math.max(heroBox.top, contentTop));

      const collectColumns = (parent) => [...parent.children].filter(visible).map((child) => {
        const childBox = box(child);
        if (!childBox || childBox.width < heroBox.width * 0.20) return null;
        const descendants = [...child.querySelectorAll(meaningfulSelector)].filter(visible);
        if (child.matches(meaningfulSelector)) descendants.unshift(child);
        const contentBoxes = descendants.map(box).filter(Boolean);
        if (!contentBoxes.length) return null;
        return {
          selector: selectorFor(child),
          box: childBox,
          contentTop: Math.min(...contentBoxes.map((r) => r.top)),
          contentBottom: Math.max(...contentBoxes.map((r) => r.bottom))
        };
      }).filter(Boolean);

      let columns = collectColumns(hero);
      const directChildren = [...hero.children].filter(visible);
      if (columns.length < 2 && directChildren.length === 1) columns = collectColumns(directChildren[0]);

      const style = getComputedStyle(hero);
      heroData = {
        selector: selectorFor(hero),
        box: heroBox,
        contentTop,
        contentBottom,
        contentSpan,
        topGap: Math.max(0, contentTop - heroBox.top),
        bottomGap: Math.max(0, heroBox.bottom - contentBottom),
        paddingTop: Number.parseFloat(style.paddingTop) || 0,
        paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
        columns
      };
    }

    const root = document.documentElement;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: {
        scrollWidth: Math.max(root.scrollWidth, document.body?.scrollWidth || 0),
        clientWidth: root.clientWidth
      },
      firstMeaningful,
      aboveFoldGap: firstMeaningful ? Math.max(0, firstMeaningful.top - contentOrigin) : null,
      hero: heroData
    };
  }, MEANINGFUL_SELECTOR);
}

function horizontalOverlapRatio(a, b) {
  const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  return overlap / Math.max(1, Math.min(a.width, b.width));
}

function sideBySidePairs(columns) {
  const pairs = [];
  for (let i = 0; i < columns.length; i += 1) {
    for (let j = i + 1; j < columns.length; j += 1) {
      const a = columns[i];
      const b = columns[j];
      if (horizontalOverlapRatio(a.box, b.box) <= thresholds.sideBySideMaxHorizontalOverlap) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

function assess(route, metrics) {
  const failures = [];
  const warnings = [];
  const vh = metrics.viewport.height;
  const overflow = metrics.page.scrollWidth - metrics.page.clientWidth;

  if (overflow > thresholds.horizontalOverflowPx && !allowed(route, 'horizontal-overflow')) {
    failures.push({ rule: 'horizontal-overflow', message: `Horizontal overflow ${Math.round(overflow)}px.` });
  }

  if (metrics.aboveFoldGap != null && !allowed(route, 'above-fold-gap')) {
    const ratio = metrics.aboveFoldGap / vh;
    if (ratio > thresholds.aboveFoldFailRatio) {
      failures.push({ rule: 'above-fold-gap', message: `First meaningful content starts ${Math.round(metrics.aboveFoldGap)}px (${(ratio * 100).toFixed(0)}vh) below content origin.` });
    } else if (ratio > thresholds.aboveFoldWarnRatio) {
      warnings.push({ rule: 'above-fold-gap', message: `Large first-content gap: ${Math.round(metrics.aboveFoldGap)}px (${(ratio * 100).toFixed(0)}vh).` });
    }
  }

  const hero = metrics.hero;
  if (!hero?.box?.height) return { failures, warnings };

  const heroHeightRatio = hero.box.height / vh;
  const contentOccupancy = hero.contentSpan / hero.box.height;
  if (!allowed(route, 'hero-height', hero.selector)) {
    if (heroHeightRatio > thresholds.heroTallFailRatio && contentOccupancy < thresholds.heroContentOccupancyFail) {
      failures.push({ rule: 'hero-height', selector: hero.selector, message: `Hero is ${(heroHeightRatio * 100).toFixed(0)}vh high while content spans ${(contentOccupancy * 100).toFixed(0)}%.` });
    } else if (heroHeightRatio > thresholds.heroTallWarnRatio && contentOccupancy < thresholds.heroContentOccupancyWarn) {
      warnings.push({ rule: 'hero-height', selector: hero.selector, message: `Hero is unusually tall (${(heroHeightRatio * 100).toFixed(0)}vh) for its content (${(contentOccupancy * 100).toFixed(0)}%).` });
    }
  }

  const topGapRatio = hero.topGap / hero.box.height;
  if (!allowed(route, 'hero-top-gap', hero.selector)) {
    if (hero.topGap > 220 && topGapRatio > thresholds.heroTopGapFailRatio) {
      failures.push({ rule: 'hero-top-gap', selector: hero.selector, message: `Hero content begins ${Math.round(hero.topGap)}px into section (${(topGapRatio * 100).toFixed(0)}%).` });
    } else if (hero.topGap > 150 && topGapRatio > thresholds.heroTopGapWarnRatio) {
      warnings.push({ rule: 'hero-top-gap', selector: hero.selector, message: `Large hero top gap: ${Math.round(hero.topGap)}px (${(topGapRatio * 100).toFixed(0)}%).` });
    }
  }

  const paddingLimit = Math.max(thresholds.sectionPaddingWarnPx, vh * thresholds.sectionPaddingWarnVh);
  if (!allowed(route, 'section-padding', hero.selector)
      && (hero.paddingTop > paddingLimit || hero.paddingBottom > paddingLimit)
      && contentOccupancy < thresholds.sectionContentOccupancyWarn) {
    warnings.push({
      rule: 'section-padding',
      selector: hero.selector,
      message: `Hero padding is large (top ${Math.round(hero.paddingTop)}px / bottom ${Math.round(hero.paddingBottom)}px) while content spans ${(contentOccupancy * 100).toFixed(0)}%.`
    });
  }

  if (!allowed(route, 'column-start-delta', hero.selector)) {
    for (const [a, b] of sideBySidePairs(hero.columns || [])) {
      const delta = Math.abs(a.contentTop - b.contentTop);
      const lowerTop = Math.max(a.contentTop, b.contentTop);
      const blankRatio = Math.max(0, lowerTop - hero.box.top) / hero.box.height;
      const warnLimit = Math.max(thresholds.columnStartWarnPx, vh * thresholds.columnStartWarnVh);
      const failLimit = Math.max(thresholds.columnStartFailPx, vh * thresholds.columnStartFailVh);
      if (delta > failLimit && blankRatio > thresholds.columnBlankFailRatio) {
        failures.push({
          rule: 'column-start-delta',
          selector: hero.selector,
          message: `Side-by-side hero columns start ${Math.round(delta)}px apart; lower column leaves ${(blankRatio * 100).toFixed(0)}% of hero height empty above its content.`
        });
        break;
      }
      if (delta > warnLimit && blankRatio > thresholds.columnBlankWarnRatio) {
        warnings.push({
          rule: 'column-start-delta',
          selector: hero.selector,
          message: `Side-by-side hero columns start ${Math.round(delta)}px apart with ${(blankRatio * 100).toFixed(0)}% blank space above lower content.`
        });
        break;
      }
    }
  }

  return { failures, warnings };
}

async function run() {
  await fs.rm(ARTIFACT_ROOT, { recursive: true, force: true });
  await fs.mkdir(ARTIFACT_ROOT, { recursive: true });

  const browserType = BROWSERS[ENGINE];
  const profiles = PROFILES[ENGINE]?.[PROFILE_SET] || PROFILES[ENGINE]?.core;
  if (!profiles?.length) throw new Error(`No profiles for ${ENGINE}/${PROFILE_SET}`);
  const routes = await discoverRoutes(browserType);
  const browser = await browserType.launch({ headless: true });
  const cases = [];
  const failures = [];
  const warnings = [];

  try {
    for (const profile of profiles) {
      const context = await browser.newContext(profileOptions(profile));
      try {
        for (const route of routes) {
          const page = await context.newPage();
          const browserErrors = [];
          const badResponses = [];
          page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
          page.on('console', (message) => {
            if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
          });
          page.on('response', (response) => {
            if (response.status() < 400) return;
            try {
              if (new URL(response.url()).origin === new URL(BASE_URL).origin) {
                badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
              }
            } catch {}
          });

          let metrics = null;
          let status = null;
          let result = { failures: [], warnings: [] };
          try {
            const response = await page.goto(joinUrl(BASE_URL, route), { waitUntil: 'domcontentloaded', timeout: 30000 });
            status = response?.status() ?? null;
            if (!response || response.status() >= 400) {
              result.failures.push({ rule: 'navigation', message: `Navigation failed with status ${status ?? 'none'}.` });
            } else {
              await settle(page);
              metrics = await collectLayout(page);
              result = assess(route, metrics);
            }
          } catch (error) {
            result.failures.push({ rule: 'navigation', message: error.message });
          }

          if (browserErrors.length) result.failures.push({ rule: 'browser-errors', message: [...new Set(browserErrors)].join(' | ') });
          if (badResponses.length) result.failures.push({ rule: 'network-errors', message: [...new Set(badResponses)].join(' | ') });

          const enrichedFailures = result.failures.map((item) => ({ ...item, route, profile: profile.name, engine: ENGINE, os: OS }));
          const enrichedWarnings = result.warnings.map((item) => ({ ...item, route, profile: profile.name, engine: ENGINE, os: OS }));
          failures.push(...enrichedFailures);
          warnings.push(...enrichedWarnings);

          await page.screenshot({ path: path.join(ARTIFACT_ROOT, `${routeKey(route)}--${profile.name}.png`), fullPage: false }).catch(() => {});
          cases.push({ route, profile: profile.name, engine: ENGINE, os: OS, status, metrics, failures: enrichedFailures, warnings: enrichedWarnings });
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    os: OS,
    engine: ENGINE,
    profileSet: PROFILE_SET,
    routes,
    thresholds,
    summary: { failures: failures.length, warnings: warnings.length, cases: cases.length },
    failures,
    warnings,
    cases
  };
  await fs.writeFile(path.join(ARTIFACT_ROOT, 'report.json'), JSON.stringify(report, null, 2));

  const lines = [
    '# KISS Visual Quality Gate', '',
    `- OS: **${OS}**`,
    `- Engine: **${ENGINE}**`,
    `- Profilset: **${PROFILE_SET}**`,
    `- Routen: **${routes.length}**`,
    `- Fälle: **${cases.length}**`,
    `- Fehler: **${failures.length}**`,
    `- Warnungen: **${warnings.length}**`, ''
  ];
  if (failures.length) {
    lines.push('## Fehler', '');
    failures.forEach((item) => lines.push(`- **${item.rule}** — ${item.route} / ${item.profile}: ${item.message}`));
    lines.push('');
  }
  if (warnings.length) {
    lines.push('## Warnungen', '');
    warnings.forEach((item) => lines.push(`- **${item.rule}** — ${item.route} / ${item.profile}: ${item.message}`));
    lines.push('');
  }
  if (!failures.length && !warnings.length) lines.push('Keine verdächtigen Layout-Proportionen oder technischen Rendering-Probleme erkannt.', '');
  await fs.writeFile(path.join(ARTIFACT_ROOT, 'report.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));

  if (failures.length || (failOnWarnings && warnings.length)) process.exit(1);
}

await run();
