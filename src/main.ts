import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* privat */ } },
};

async function boot() {
  // dynamisch, damit ein fehlendes WebAssembly-SIMD sauber gemeldet werden kann
  const { Game, SKINS, MODE_NAMES, escapeHtml } = await import('./game');
  type Mode = keyof typeof MODE_NAMES;
  // Physik: Rapier (Rust -> WebAssembly SIMD), wird per ESM-Integration geladen
  const game = new Game($<HTMLCanvasElement>('gl'));

  // Menü
  let skin = Number(store.get('skin')) || SKINS[0];
  const name = $<HTMLInputElement>('name');
  name.value = store.get('name') || '';
  const skins = $('skins');
  for (const c of SKINS) {
    const el = document.createElement('div');
    el.className = 'skin' + (c === skin ? ' sel' : '');
    el.style.background = '#' + c.toString(16).padStart(6, '0');
    el.onclick = () => { skin = c; store.set('skin', String(c)); skins.querySelectorAll('.skin').forEach((s) => s.classList.remove('sel')); el.classList.add('sel'); };
    skins.appendChild(el);
  }
  let mode: Mode = (store.get('mode') as Mode) in MODE_NAMES ? (store.get('mode') as Mode) : 'classic';
  // Rekorde je Modus (Solo in Promille der Stadt)
  const best = (m: Mode) => Number(store.get('best-' + m)) || 0;
  const fmt = (m: Mode, v: number) => (m === 'solo' ? (v / 10).toFixed(1) + ' %' : String(v));
  const showBest = () => { $('best').textContent = best(mode) ? `Rekord ${MODE_NAMES[mode]}: ${fmt(mode, best(mode))}` : ''; };
  document.querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => {
    b.classList.toggle('sel', b.dataset.mode === mode);
    b.onclick = () => {
      mode = b.dataset.mode as Mode; store.set('mode', mode);
      document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('sel', x === b));
      showBest();
    };
  });
  showBest();

  let wakeLock: { release(): Promise<void> } | null = null;
  const play = async () => {
    const n = name.value.trim() || 'Du';
    store.set('name', name.value.trim());
    game.setup(n, skin, mode);
    $('menu').classList.add('hidden');
    $('over').classList.add('hidden');
    $('hud').classList.remove('hidden');
    game.start();
    try { wakeLock = await (navigator as any).wakeLock?.request('screen'); } catch { /* egal */ }
  };
  $('play').onclick = play;
  $('again').onclick = play;
  $('tomenu').onclick = () => { $('over').classList.add('hidden'); $('menu').classList.remove('hidden'); showBest(); };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });

  game.onEnd = (r) => {
    wakeLock?.release().catch(() => {}); wakeLock = null;
    const value = r.mode === 'solo' ? Math.round(r.percent * 1000) : r.score;
    const rec = value > best(r.mode);
    if (rec) store.set('best-' + r.mode, String(value));
    if (r.mode === 'solo') {
      $('overtitle').textContent = `${(r.percent * 100).toFixed(1)} % der Stadt!`;
      $('results').innerHTML = `<li class="me"><span class="n">Punkte</span><span>${r.score}</span></li>`;
    } else {
      $('overtitle').textContent = r.mode === 'battle' && r.eliminated ? `Gefressen – Platz ${r.rank}`
        : r.rank === 1 ? '🏆 Du hast gewonnen!' : `Platz ${r.rank}`;
      $('results').innerHTML = r.table.map((h, i) => {
        const out = r.mode === 'battle' && !h.alive;
        return `<li class="${h.isPlayer ? 'me' : ''}"><span>${i + 1}.</span><span class="n">${escapeHtml(h.name)}${out ? ' 💀' : ''}</span><span>${h.score}</span></li>`;
      }).join('');
    }
    $('overbest').textContent = rec ? `Neuer Rekord: ${fmt(r.mode, value)}!` : `Rekord: ${fmt(r.mode, best(r.mode))}`;
    setTimeout(() => { $('hud').classList.add('hidden'); $('over').classList.remove('hidden'); showBest(); }, 900);
  };

  if (import.meta.env.DEV) (window as any).game = game;

  // Hintergrund-Demo im Menü
  game.setup('', SKINS[0]);
  game.player.die();
  $('loading').classList.add('hidden');

  let last = performance.now();
  const loop = (now: number) => {
    game.frame((now - last) / 1000);
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ---- PWA ----
let deferred: any = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  $('install').classList.remove('hidden');
});
$('install').onclick = async () => {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice;
  deferred = null;
  $('install').classList.add('hidden');
};
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.error));
}

boot().catch((e) => {
  console.error(e);
  const p = document.createElement('p');
  p.textContent = 'Start fehlgeschlagen – dein Browser unterstützt WebGL2/WebAssembly SIMD nicht. (' + String(e) + ')';
  $('loading').replaceChildren(p);
});
