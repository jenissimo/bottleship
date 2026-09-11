/**
 * Engine comparison runner: N arms, each a FRESH entry on a named engine binary plus one
 * integrity-checked steady-state window.
 *
 * Why a series and not two runs: the engine is bound when the guest's worker boots, so the two
 * binaries can never be interleaved inside one guest, and a single window per arm is worth
 * nothing against a control noise floor measured at several percent. Balanced order (BAAB /
 * ABBA) is what keeps a monotonic host drift from being read as an engine effect, and the
 * per-arm engine identity comes from the bytes v86 actually instantiated, never from the
 * hash the URL asked for.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ENGINES = {
  A: '9aa38d8bf99d9b6d8c8371605c9d2070edaeb6af28de8e9d6f07ae86210af276',
  B: '3ee78d780847f28bd69a1def4eabfc5cc59dfc2bff70e178468c6d4a356294c0',
};
const button = document.createElement('button');
button.textContent = 'Серия сравнения движков';
document.querySelector('#status').after(button);

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

button.onclick = async () => {
  const start = document.querySelector('#start');
  if (start.disabled || button.disabled) return;
  const status = document.querySelector('#status'), log = document.querySelector('#log');
  const note = s => { status.textContent = s; log.textContent += s + '\n'; };
  const params = new URLSearchParams(location.search);
  const order = (params.get('series') || 'BAAB').toUpperCase().split('');
  // ?engine=<sha> pins EVERY arm to one binary — used when the two arms are separate runs
  // (an engine is chosen at boot, so it cannot be alternated inside one guest) and the
  // comparison is made on traces rather than on this run's FPS.
  const pinned = params.get('engine');
  if (pinned) { if (!/^[a-f0-9]{64}$/.test(pinned)) throw Error('Invalid engine hash'); for (const k of Object.keys(ENGINES)) ENGINES[k] = pinned; }
  if (order.some(a => !ENGINES[a])) throw Error('Unknown arm in series');
  const cfg = await (await fetch('./navigation-record-config.json', { cache: 'no-store' })).json();
  let seq = Date.now();
  const save = async (kind, data) => {
    const r = await fetch(cfg.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: seq++, kind, t: performance.now(), data }),
    });
    if (!r.ok) throw Error('Collector ' + r.status);
  };
  const seriesId = 'series-' + seq;
  start.disabled = button.disabled = true;
  const arms = [];
  try {
    await save('series-start', { seriesId, order, engines: ENGINES });
    const { run } = await import('./nfsu-experiment.mjs?series=' + seq);
    for (const [index, arm] of order.entries()) {
      note('Рука ' + (index + 1) + '/' + order.length + ' (' + arm + '): вход');
      await window.__nfsuEnter(ENGINES[arm]);
      if (!window.__nfsuEntered()) throw Error('Вход не подтверждён на руке ' + (index + 1));
      const frame = document.querySelector('#guest iframe');
      const call = async (cmd, ...args) => {
        const r = await frame.contentWindow.__BS__.harness.__runSteps([{ cmd, args }]);
        if (!r.ok) throw Error(cmd + ': ' + JSON.stringify(r.error));
        return r.steps.at(-1).result;
      };
      // The window record itself is what the collector keeps; this only carries the arm label
      // and enough of the result to build the paired summary without re-reading the archive.
      let record = null;
      const armSave = async (kind, data) => {
        if (kind === 'engine-window') { record = data; data = { ...data, seriesId, arm, index }; }
        return save(kind, data);
      };
      await run({ call, save: armSave, note, sleep, scene: window.__nfsuScene });
      if (!record?.valid) throw Error('Окно не прошло проверку на руке ' + (index + 1));
      if (record.engine.sha256 !== ENGINES[arm]) throw Error('Рука ' + arm + ' исполнила другой движок');
      arms.push({ index, arm, fps: record.fps, p50: record.p50, p95: record.p95,
        frames: record.frames, moverPerFrame: record.moverPerFrame,
        wbufHitsPerFrame: record.wbuf.hitsPerFrame, wbufFallbacksPerFrame: record.wbuf.fallbacksPerFrame });
      note('Рука ' + (index + 1) + ': ' + record.fps.toFixed(2) + ' FPS');
    }
    const byArm = key => arms.filter(a => a.arm === key).map(a => a.fps);
    const a = byArm('A'), b = byArm('B');
    const summary = {
      seriesId, order, arms,
      medianA: a.length ? median(a) : null, medianB: b.length ? median(b) : null,
      ratio: a.length && b.length ? median(b) / median(a) : null,
      note: 'Ratio = median B / median A on FPS. Directional only unless it clears the measured A/A control spread.',
    };
    await save('series-summary', summary);
    note('Серия готова: A ' + (summary.medianA ?? 0).toFixed(2) + ' · B ' + (summary.medianB ?? 0).toFixed(2)
      + ' · ratio ' + (summary.ratio ?? 0).toFixed(4));
  } catch (e) {
    await save('series-failed', { seriesId, arms, error: String(e) }).catch(() => {});
    note('Серия остановлена: ' + e);
  } finally { start.disabled = button.disabled = false; }
};
