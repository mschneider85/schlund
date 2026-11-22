/** Leichtgewichtige Konstanten – ohne Three.js/Rapier, damit das Menü sofort startet */
export type Mode = 'battle' | 'solo';
export const MODE_NAMES: Record<Mode, string> = { battle: 'Battle', solo: 'Solo' };
export const SKINS = [0xff5caa, 0x4cc9f0, 0xffd250, 0x7bf06c, 0xb77cff, 0xff8a4c, 0xffffff];

/** Solo: Sterne ab diesem Anteil der Stadt */
export const STAR_STEPS = [0.5, 0.75, 0.95];
export const starsFor = (p: number) => STAR_STEPS.filter((s) => p >= s).length;

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
