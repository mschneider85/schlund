import './style.css';
import { MODE_NAMES, starsFor, escapeHtml, type Mode } from './config';
import type { Game } from './game';
import type { Welcome } from './net';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* privat */ } },
};

// ---------- Menü (sofort bedienbar, Spiel lädt im Hintergrund) ----------
let game: Game | null = null;
const name = $<HTMLInputElement>('name');
name.value = store.get('name') || '';
// ohne eingegebenen Namen: zufälliger, pro Gerät fester Name (statt "Du" – den sähen ja auch die anderen)
const AUTO = ['Schlinger', 'Futterloch', 'Happs', 'Krümel', 'Mampfer', 'Schluckauf', 'Gierschlund', 'Nimmersatt', 'Plumps', 'Wirbel'];
const autoName = store.get('autoname') || AUTO[Math.floor(Math.random() * AUTO.length)] + (10 + Math.floor(Math.random() * 90));
store.set('autoname', autoName);
name.placeholder = autoName;
let mode: Mode = (store.get('mode') as Mode) in MODE_NAMES ? (store.get('mode') as Mode) : 'battle';
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

// Ton
let muted = store.get('muted') === '1';
const applyMute = () => { $('btnmute').textContent = muted ? '🔇' : '🔊'; if (game) game.sfx.muted = muted; };
$('btnmute').onclick = () => { muted = !muted; store.set('muted', muted ? '1' : '0'); applyMute(); };
applyMute();

const show = (id: string, on: boolean) => $(id).classList.toggle('hidden', !on);

let wakeLock: { release(): Promise<void> } | null = null;
let starting = false;
const play = async () => {
  if (!game || starting) return;
  starting = true;
  const n = name.value.trim() || autoName;
  store.set('name', name.value.trim());
  // Battle: still nach einer laufenden Runde echter Spieler suchen, sonst selbst eine eröffnen
  const net = mode === 'battle' ? game.net : null;
  const w = net ? await net.findMatch(n).catch(() => null) : null;
  starting = false;
  begin(n, w);
  // noch niemand gefunden: sofort selbst starten und in den ersten Sekunden weiter Ausschau halten
  if (net && !w) lateJoin(n, ++round);
  try { wakeLock = await (navigator as any).wakeLock?.request('screen'); } catch { /* egal */ }
};
let round = 0;
async function lateJoin(n: string, id: number) {
  const t0 = performance.now();
  while (id === round && game?.running && game.net?.role === 'host' && performance.now() - t0 < 12000) {
    await new Promise((r) => setTimeout(r, 400));
    const w = await game.net.lateMatch(n).catch(() => null);
    if (!w) continue;
    if (id === round && game.running) begin(n, w);
    else game.net.cancelJoin(w);
    return;
  }
}
function begin(n: string, w: Welcome | null) {
  if (!game) return;
  game.setup(n, mode, w ?? undefined);
  if (game.net && !w && mode === 'battle') game.net.becomeHost();
  // Solo lässt sich anhalten; im Battle läuft die Welt weiter (echte Mitspieler) – dort nur „Verlassen“
  const solo = mode === 'solo';
  $('btnpause').textContent = solo ? '⏸' : '✕';
  $('btnpause').setAttribute('aria-label', solo ? 'Pause' : 'Runde verlassen');
  $('pausetitle').textContent = solo ? 'Pause' : 'Runde verlassen?';
  $('resume').textContent = solo ? 'WEITER' : 'WEITERSPIELEN';
  $('quit').textContent = solo ? 'Runde beenden' : 'Verlassen';
  show('menu', false); show('over', false); show('pause', false); show('hud', true);
  $('hud').classList.toggle('solo', mode === 'solo');
  game.start(w && w.cd > 0.3 ? w.cd : 3);
}
const toMenu = () => {
  show('over', false); show('pause', false); show('hud', false); show('menu', true);
  showBest();
};
$('play').onclick = play;
$('again').onclick = play;
$('tomenu').onclick = toMenu;
name.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });

// Pause
const pause = (on: boolean) => {
  if (!game || !game.running) return;
  game.setPaused(on);
  show('pause', on);
};
$('btnpause').onclick = () => pause(true);
$('resume').onclick = () => pause(false);
$('quit').onclick = () => { round++; game?.setPaused(false); game?.demo(); wakeLock?.release().catch(() => {}); wakeLock = null; toMenu(); };
addEventListener('keydown', (e) => {
  if (!$('over').classList.contains('hidden') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); play(); return; }
  if (!game?.running) return;
  if (e.key === 'Escape' || e.key.toLowerCase() === 'p') pause(!game.menuPaused);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  // Im Hintergrund rechnet der Browser nicht weiter: als Host die Runde an die anderen abgeben
  // (Chrome meldet auch ein komplett verdecktes Fenster als versteckt – deshalb erst nach 5 s)
  if (game?.net?.role === 'host') setTimeout(() => { if (document.hidden && game?.net?.role === 'host') game.net.leaveRound(); }, 5000);
  if (game?.mode === 'solo') pause(true);
});

async function boot() {
  // Three.js + Physik (Rust -> WebAssembly SIMD) laden, während das Menü schon bedienbar ist
  const { Game } = await import('./game');
  const g = new Game($<HTMLCanvasElement>('gl'));
  game = g;
  applyMute();

  g.onEnd = (r) => {
    wakeLock?.release().catch(() => {}); wakeLock = null;
    const value = r.mode === 'solo' ? Math.round(r.percent * 1000) : r.score;
    const rec = value > best(r.mode);
    if (rec) store.set('best-' + r.mode, String(value));
    if (r.mode === 'solo') {
      const st = starsFor(r.percent);
      $('overtitle').textContent = `${(r.percent * 100).toFixed(1)} % der Stadt!`;
      $('results').innerHTML = `<li class="stars">${'<span class="on">★</span>'.repeat(st)}${'<span>★</span>'.repeat(3 - st)}</li>`
        + `<li class="me"><span class="n">Level</span><span>${r.table[0].level + 1}</span></li>`
        + `<li><span class="n">Punkte</span><span>${r.score}</span></li>`;
    } else {
      $('overtitle').textContent = r.eliminated ? `Gefressen – Platz ${r.rank}`
        : r.rank === 1 ? '🏆 Du hast gewonnen!' : `Platz ${r.rank}`;
      $('results').innerHTML = r.table.map((h, i) => {
        const out = !h.alive;
        return `<li class="${h.isPlayer ? 'me' : ''}"><span>${i + 1}.</span><span class="n">${i === 0 && !out ? '👑 ' : ''}${escapeHtml(h.name)}${out ? ' 💀' : ''}</span><span>Lv ${h.level + 1}</span></li>`;
      }).join('');
    }
    $('overbest').textContent = rec ? `Neuer Rekord: ${fmt(r.mode, value)}!` : `Rekord: ${fmt(r.mode, best(r.mode))}`;
    setTimeout(() => { show('hud', false); show('over', true); showBest(); $('again').focus(); }, 600);
  };

  if (import.meta.env.DEV) (window as any).game = g;

  // Mehrspieler im Hintergrund – wenn es nicht klappt, merkt man nichts (Bots)
  import('./net').then(({ Net }) => {
    g.net = new Net(g);
    // Diagnose: Seite mit ?debug öffnen
    if (new URLSearchParams(location.search).has('debug')) {
      const pre = document.createElement('pre');
      pre.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;margin:0;padding:6px 8px;font:11px/1.35 monospace;color:#fff;background:rgba(0,0,0,.65);border-radius:8px;pointer-events:none;white-space:pre';
      document.body.appendChild(pre);
      setInterval(() => { pre.textContent = g.net!.debugInfo(); }, 500);
    }
  }).catch((e) => console.warn('offline', e));

  g.demo(); // Hintergrund-Demo im Menü
  const btn = $<HTMLButtonElement>('play');
  btn.disabled = false; btn.textContent = 'SPIELEN';
  $('loadbar').classList.add('done');

  let last = performance.now();
  const loop = (now: number) => {
    g.frame((now - last) / 1000);
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
  show('install', true);
});
$('install').onclick = async () => {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice;
  deferred = null;
  show('install', false);
};
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.error));
}

boot().catch((e) => {
  console.error(e);
  const p = $('loading').querySelector('p')!;
  p.textContent = 'Start fehlgeschlagen – dein Browser unterstützt WebGL2/WebAssembly SIMD nicht. (' + String(e) + ')';
  show('menu', false); show('loading', true);
});
