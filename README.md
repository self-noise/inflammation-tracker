# Inflammation Tracker

A small, self-hosted [Progressive Web App](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/What_is_a_progressive_web_app) for daily self-reported inflammation logging (e.g., for inflammatory arthitis).

It runs in the browser, installs to phone home screen, works offline, and syncs entries
as CSV rows to your own [Koofr](https://koofr.eu) account via WebDAV. No
backend, no database, no third-party service holding your data — just static
files in front of a CSV file you own.

> **Disclaimer.** This is a self-hosted personal logging tool. It is not a
> medical device, makes no clinical claims, and is not a substitute for
> medical advice. The author accepts no liability for decisions made on the
> basis of its data. Use at your own discretion.

## Architecture

```
Browser (PWA on phone / laptop)
   │
   │  HTTPS, HTTP Basic auth
   ▼
Static files on your web host
   │
   │  WebDAV (GET / PUT) via Worker (CORS proxy)
   ▼
Cloudflare Worker  ──────►  Koofr WebDAV (/<your-folder>/log.csv)
```

Three independently-owned tiers:

| Tier | What it holds | You bring |
|---|---|---|
| **App** | Seven static files in `app/` | Any static web host with HTTPS and Basic-auth support (Hostinger is the worked example; Netlify/Cloudflare Pages/a small VPS all work) |
| **Proxy** | A ~50-line Cloudflare Worker (`worker/worker.js`) that adds the CORS headers Koofr does not send | A free Cloudflare account |
| **Storage** | A single append-only CSV file on Koofr at a path of your choice | A Koofr account (free tier is fine) |

The CSV on Koofr is the only authoritative store; everything else can be
rebuilt from this repository.

## Repository layout

```
inflammation-tracker/
├── README.md            ← this file
├── LICENSE              ← MIT
├── app/                 ← the PWA (deploy these to your web host)
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── sync.js
│   ├── sw.js
│   ├── manifest.json
│   └── icon.svg
├── worker/
│   └── worker.js        ← CORS proxy to deploy on Cloudflare Workers
└── manual/
    ├── manual.tex       ← full setup & security manual (LaTeX source)
    └── manual.pdf       ← the rendered manual (read this to deploy)
```

## Quick start

**Read `manual/manual.pdf`.** It walks through the full deployment end to end:
choosing a folder, uploading files, applying security headers via `.htaccess`,
locking the URL with HTTP Basic auth, creating a Koofr app password, deploying
the Cloudflare Worker, and installing the app on a phone.

The manual uses Hostinger as a worked example because it has cheap shared
hosting, hPanel-driven HTTP Basic auth, and `.htaccess` support. Only Steps
1–4 are Hostinger-specific; Steps 5–8 are host-neutral. See the
"Adapting to other hosts" note near the start of the manual for the
substitutions needed on Netlify, Cloudflare Pages, a small VPS, etc.

## Customisation pointers

Most things are deliberately easy to change without restructuring the app.

- **Severity scale.** The four-button scale (1 = no symptoms, 2 = minor,
  3 = moderate, 4 = severe) is defined by the radio buttons in
  `app/index.html` (the Inflammation fieldset) and by the colour classes
  in `app/style.css`. Add or remove buttons and the CSV `score` column
  takes whatever integer you store; the on-load today-check does not
  depend on the value range.
- **Location checkboxes.** The fixed ten locations live as a single
  `LOCATIONS` array at the top of `app/app.js`. Edit that array (and the
  matching markup block in `app/index.html`) to change them. Storage
  format is pipe-delimited, lowercased; downstream code reads it back
  the same way.
- **The medication question.** The methotrexate checkbox is wired into
  the Medication fieldset in `app/index.html` and stored as a 0/1
  column called `methotrexate`. Rename, add more, or remove entirely by
  editing the fieldset, the `rowToCsv()` builder in `app/sync.js`, and
  the CSV header on first write. If you remove the column entirely from
  an in-use deployment, delete the CSV on Koofr first and let the app
  recreate it — the code does not do in-place schema migration.
- **CSV path on Koofr.** The default `/inflammation/log.csv` lives in
  `DEFAULT_SETTINGS.path` at the top of `app/app.js` and in the
  placeholder text of the settings form in `app/index.html`. Whatever
  the user enters in Settings overrides the default at runtime.
- **Cache version.** `CACHE_VERSION` in `app/sw.js` controls the offline
  shell cache. Bump it on every visible deploy so installed devices
  pick up the new files instead of serving the cached old ones.

## Privacy and security

- **Your data lives on your Koofr.** Nobody operating this repository
  (or any future maintainer) has any access to it; the app talks
  directly from your browser to your Cloudflare Worker to your Koofr.
- **The Worker only forwards.** It does not log request bodies or
  store anything; it exists solely to add the CORS headers Koofr does
  not send.
- **Credentials are per-device.** Your Koofr email and app password
  are stored in each browser's `localStorage` only. Use a separate
  Koofr application-specific password per device so that losing a
  device forces revocation of only that one credential.
- **App passwords are account-wide.** Koofr's application-specific
  passwords cannot be scoped to a single folder; they grant the same
  access as the main account password under a separately revocable
  credential. Treat them as such.
- **The URL is gated by HTTP Basic auth.** This is the real lock — an
  unguessable folder name is just a second layer.
- **Strong CSP, HSTS, frame-protection, and other security headers**
  are applied by the `.htaccess` shown in the manual. Keep them on.

## Contributing

This is a personal project published in case it is useful to others.
Pull requests are welcome but may not always be merged — the codebase
deliberately stays small and the schema deliberately stays narrow. Bug
reports and security observations are especially welcome.

## Licence

Released under the [MIT Licence](LICENSE).
