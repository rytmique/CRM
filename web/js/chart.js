import { h, s, fmtInt, dayLabel } from './ui.js';

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * Single-series daily column chart (inline SVG) with per-column hover tooltip.
 * data: [{ day: 'YYYY-MM-DD', value: number }], series: CSS var name for the fill.
 */
export function columnChart({ title, data, series = '--series-1', unit = '', extra }) {
  const W = 640, H = 200, padL = 36, padR = 8, padT = 10, padB = 26;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.min(24, Math.max(4, band - 4));
  const y = (v) => padT + plotH - (v / max) * plotH;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `${title}: ${data.map((d) => `${dayLabel(d.day)} — ${d.value}`).join(', ')}` });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    svg.append(s('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: i === 0 ? 'axis' : 'grid' }));
    svg.append(s('text', { x: padL - 6, y: yy + 4, class: 'tick', 'text-anchor': 'end' }, fmtInt(Math.round(v))));
  }
  const labelEvery = Math.ceil(data.length / 10);
  const tip = h('div.chart-tip', { hidden: true });
  const wrap = h('div.chart-wrap', svg, tip);

  data.forEach((d, i) => {
    const cx = padL + band * i + band / 2;
    const x = cx - barW / 2;
    const top = y(d.value);
    const hgt = padT + plotH - top;
    if (d.value > 0) {
      const r = Math.min(4, hgt, barW / 2);
      // Rounded data-end (top), square at the baseline.
      const path = `M${x},${top + hgt} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + hgt} Z`;
      svg.append(s('path', { d: path, class: 'bar', style: `fill: var(${series})` }));
    }
    if (i % labelEvery === 0 || i === data.length - 1) {
      svg.append(s('text', { x: cx, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, dayLabel(d.day)));
    }
    const hit = s('rect', { x: padL + band * i, y: padT, width: band, height: plotH, class: 'hit', tabindex: 0, 'aria-label': `${dayLabel(d.day)}: ${d.value}` });
    const show = () => {
      tip.replaceChildren(h('b', dayLabel(d.day)), h('span', `${fmtInt(d.value)}${unit}`), extra ? h('span.muted', extra(d)) : null);
      tip.hidden = false;
      const pct = (cx / W) * 100;
      tip.style.left = `${pct}%`;
      tip.style.top = `${(Math.max(top, padT + 20) / H) * 100}%`;
      tip.classList.toggle('flip', pct > 75);
      hit.classList.add('on');
    };
    const hide = () => { tip.hidden = true; hit.classList.remove('on'); };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('blur', hide);
    svg.append(hit);
  });

  const total = data.reduce((a, d) => a + d.value, 0);
  return h('figure.chart',
    h('figcaption', h('span', title), h('b', fmtInt(total))),
    wrap,
    h('details.chart-table', h('summary', 'Таблиця'),
      h('table.table.compact', h('thead', h('tr', h('th', 'День'), h('th.num', title))),
        h('tbody', data.slice().reverse().map((d) => h('tr', h('td', dayLabel(d.day)), h('td.num', fmtInt(d.value))))))));
}
