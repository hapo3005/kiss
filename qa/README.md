# KISS Visual Quality Gate

This directory contains the centrally maintained visual-quality runner used by KISS website projects.

## What it checks

The gate intentionally avoids cross-OS pixel equality. Font rasterization and native rendering differ between Linux, Windows and macOS, so pixel-perfect cross-platform screenshots would create false failures.

Instead it measures layout geometry and browser behaviour:

- horizontal overflow
- suspicious above-the-fold empty space
- hero height versus actual content span
- excessive hero top gap
- unusually large section padding combined with low content occupancy
- vertically misaligned hero columns that create one-sided whitespace
- navigation, browser console and same-origin network errors

Screenshots are still captured as evidence for every tested route/profile.

## Coverage

The reusable workflow runs:

- Chromium, Firefox and WebKit on Linux
- Chromium and Firefox smoke tests on Windows
- WebKit and Chromium smoke tests on macOS
- small and large phones, Android-like touch profiles, iPhone SE/iPhone 15, tablet portrait/landscape, phone landscape, laptop, desktop and 1920px wide desktop

This is representative compatibility coverage, not a claim that every physical device model in existence is emulated.

## Project configuration

Projects can add `.kiss-qa.json`:

```json
{
  "routes": ["/", "/leistungen/", "/ueber-uns/", "/kontakt/"],
  "maxRoutes": 12,
  "failOnWarnings": false,
  "allow": [
    {
      "route": "/",
      "rule": "hero-height",
      "selector": ".hero.editorial"
    }
  ],
  "thresholds": {}
}
```

`allow` is for intentional design decisions only. It keeps the quality gate from forcing every project into the same density.

Available rule names include `horizontal-overflow`, `above-fold-gap`, `hero-height`, `hero-top-gap`, `section-padding`, and `column-start-delta`.
