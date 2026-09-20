// Server-rendered HTML, inline CSS, no build step and no CDN.
//
// The reader is the owner: smart, knows the business, cannot read code. Every
// page leads with what is true right now. Colour is never the only signal.

export type NavKey = 'apis' | 'data' | 'jobs' | 'runs' | 'audit' | 'drift';

const NAV: Array<{ key: NavKey; label: string; href: string }> = [
  { key: 'apis', label: 'APIs', href: '/devops/apis' },
  { key: 'data', label: 'Data', href: '/devops/data' },
  { key: 'jobs', label: 'Jobs', href: '/devops/jobs' },
  { key: 'runs', label: 'Runs', href: '/devops/runs' },
  { key: 'audit', label: 'Audit', href: '/devops/audit' },
  { key: 'drift', label: 'Drift', href: '/devops/drift' },
];

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const h = escapeHtml;

export function layout(opts: {
  title: string;
  active: NavKey;
  driftBadge: { state: 'clean' | 'findings' | 'unchecked'; count: number };
  body: string;
}): string {
  const nav = NAV.map((item) => {
    const badge =
      item.key === 'drift' && opts.driftBadge.state !== 'clean'
        ? ` <span class="badge ${opts.driftBadge.state}">${
            opts.driftBadge.state === 'unchecked' ? 'not checked' : opts.driftBadge.count
          }</span>`
        : '';
    return `<a class="${item.key === opts.active ? 'on' : ''}" href="${item.href}">${item.label}${badge}</a>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(opts.title)}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #16181d; --muted: #5c6370; --line: #d9dce3;
    --panel: #f6f7f9; --accent: #1c4f9c; --bad: #9c1c1c; --good: #16643a; --warn: #8a5a00;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8eaee; --muted:#9aa2b1; --line:#2c3038;
            --panel:#1b1e24; --accent:#7aa7e8; --bad:#f08a8a; --good:#74d6a3; --warn:#e3b64f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { border-bottom:1px solid var(--line); padding:0 16px; }
  nav { display:flex; gap:4px; max-width:1100px; margin:0 auto; flex-wrap:wrap; }
  nav a { padding:14px 12px; text-decoration:none; color:var(--muted); border-bottom:2px solid transparent; }
  nav a.on { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:17px; margin:28px 0 8px; }
  p.lede { color:var(--muted); margin:0 0 20px; }
  table { border-collapse:collapse; width:100%; margin:8px 0 20px; font-size:14px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  pre { background:var(--panel); padding:10px; border-radius:6px; overflow:auto; margin:6px 0; }
  .badge { display:inline-block; padding:1px 7px; border-radius:10px; font-size:12px;
           background:var(--bad); color:#fff; font-weight:600; }
  .badge.unchecked { background:var(--warn); color:#000; }
  .tag { display:inline-block; padding:1px 7px; border-radius:4px; font-size:12px;
         border:1px solid var(--line); background:var(--panel); margin:0 3px 3px 0; }
  .tag.forbidden { border-color:var(--bad); color:var(--bad); }
  .tag.write { border-color:var(--accent); color:var(--accent); }
  .ok { color:var(--good); font-weight:600; }
  .bad { color:var(--bad); font-weight:600; }
  .warn { color:var(--warn); font-weight:600; }
  .muted { color:var(--muted); }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; margin:12px 0; }
  .step { display:grid; grid-template-columns:28px 1fr 120px 90px; gap:10px;
          padding:10px 0; border-bottom:1px solid var(--line); }
  .step .why { grid-column:2 / -1; color:var(--muted); font-style:italic; margin-top:4px; }
  .step .meta { grid-column:2 / -1; color:var(--muted); font-size:13px; margin-top:4px; }
  form.filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
  input, select, button { font:inherit; padding:6px 8px; border:1px solid var(--line);
                          border-radius:6px; background:var(--bg); color:var(--fg); }
  button { cursor:pointer; background:var(--panel); }
  a { color:var(--accent); }
</style>
</head><body>
<header><nav>${nav}</nav></header>
<main>${opts.body}</main>
</body></html>`;
}
