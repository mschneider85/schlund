import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* privat */ } },
};

async function boot() {
  // dynamisch, damit ein fehlendes WebAssembly-SIMD sauber gemeldet werden kann
  const { Game, SKINS, escapeHtml } = await import('./game');
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
  const best = () => Number(store.get('best')) || 0;
  const showBest = () => { $('best').textContent = best() ? `Rekord: ${best()}` : ''; };
  showBest();

  let wakeLock: { release(): Promise<void> } | null = null;
  const play = async () => {
    const n = name.value.trim() || 'Du';
    store.set('name', name.value.trim());
    game.setup(n, skin);
    $('menu').classList.add('hidden');
    $('over').classList.add('hidden');
    $('hud').classList.remove('hidden');
    game.start();
    try { wakeLock = await (navigator as any).wakeLock?.request('screen'); } catch { /* egal */ }
  };
  $('play').onclick = play;
  $('again').onclick = play;
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });

  game.onEnd = (rank, score, table) => {
    wakeLock?.release().catch(() => {}); wakeLock = null;
    const rec = score > best();
    if (rec) store.set('best', String(score));
    $('overtitle').textContent = rank === 1 ? '🏆 Du hast gewonnen!' : `Platz ${rank}`;
    $('results').innerHTML = table.map((h, i) =>
      `<li class="${h.isPlayer ? 'me' : ''}"><span>${i + 1}.</span><span class="n">${escapeHtml(h.name)}</span><span>${h.score}</span></li>`).join('');
    $('overbest').textContent = rec ? `Neuer Rekord: ${score}!` : `Rekord: ${best()}`;
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
