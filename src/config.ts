/** Leichtgewichtige Konstanten – ohne Three.js/Rapier, damit das Menü sofort startet */
export type Mode = 'classic' | 'battle' | 'solo';
export const MODE_NAMES: Record<Mode, string> = { classic: 'Klassik', battle: 'Battle', solo: 'Solo' };
export const SKINS = [0xff5caa, 0x4cc9f0, 0xffd250, 0x7bf06c, 0xb77cff, 0xff8a4c, 0xffffff];

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
