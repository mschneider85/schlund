# Schlund – Friss die Stadt

Ein Arcade-Spiel als installierbare PWA: Du steuerst ein schwarzes Loch durch eine Low-Poly-Stadt, verschlingst alles, was hineinpasst, wächst und frisst am Ende die anderen Löcher. Eine Runde dauert 3 Minuten.

```bash
npm install
npm run dev       # Entwicklung (http://localhost:5173)
npm run build     # Produktions-Build nach dist/ (inkl. Service Worker)
npm run preview   # Build lokal testen (PWA/Offline nur hier)
```

## Technik
- **WebGL2 / Three.js** – alle Objekte als `InstancedMesh` (~25 Draw-Calls für ~1800 Objekte), eigene Shader-Erweiterungen:
  das Loch ist ein `discard` im Bodenshader, Objekte verdunkeln sich beim Fallen, Röntgen-Dithering für Gebäude vor dem Spieler.
- **WebAssembly (SIMD)** – Rapier-Physik (Rust). Objekte bekommen erst beim Hineinkippen einen Physikkörper;
  die Grubenwände sind kinematische Collider, Kollisionsgruppen trennen die Löcher voneinander.
- **WebRTC-Mehrspieler ohne Server** (Battle) – über [Trystero](https://github.com/dmotz/trystero), Signaling über öffentliche Nostr-Relays.
  Wer eine Runde startet, ist Host (Physik, Bots, Punkte); später Kommende übernehmen still ein Bot-Loch.
  Das eigene Loch bewegt sich lokal ohne Verzögerung, Verkehr und fremde Löcher werden interpoliert.
  Geht der Host, übernimmt ein anderer Spieler nahtlos; ohne Verbindung spielt man einfach gegen Bots.
  Klappt keine Direktverbindung (Mobilfunk-/Firmen-NAT), laufen die Nachrichten AES-verschlüsselt über öffentliche
  MQTT-Broker (eigener Mini-Client, `src/mqtt.ts`) – ohne Registrierung. Diagnose: Seite mit `?debug` öffnen.
- **PWA** – Manifest, Service Worker mit beim Build erzeugter Precache-Liste (komplett offline spielbar), Install-Button.
- Web Audio (synthetische Sounds), Vibration API, Screen Wake Lock, Pointer Events (Touch-Steuerung), WASD/Pfeiltasten.

## Code
| Datei | Inhalt |
|---|---|
| `src/objects.ts` | Objektkatalog (Geometrien, Collider, Punkte), Materialien/Shader |
| `src/city.ts` | prozeduraler Stadtgenerator + Bodentextur |
| `src/world.ts` | Physikwelt, Objektzustand, Verkehr, Instanz-Sync |
| `src/hole.ts` | Loch: Level/Wachstum, Grubenwände, Darstellung |
| `src/game.ts` | Spielschleife, Kamera, Eingabe, Bot-KI, HUD |
| `src/net.ts` | Mehrspieler: Matchmaking, Host/Client-Protokoll, Host-Wechsel, Transport WebRTC/MQTT |
| `src/mqtt.ts` | minimaler MQTT-over-WebSocket-Client (Notfall-Relay) |
| `vite.config.ts` | WASM-Plugin + Service-Worker-Generator |
