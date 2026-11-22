/**
 * Minimaler MQTT-3.1.1-Client über WebSocket (nur QoS 0: CONNECT, SUBSCRIBE, PUBLISH, PING).
 * Dient als Notfall-Relay, wenn keine direkte WebRTC-Verbindung zustande kommt –
 * über öffentliche Broker, ohne Registrierung.
 */
const enc = new TextEncoder();

function str(s: string) {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}
function packet(type: number, body: number[] | Uint8Array) {
  const len: number[] = [];
  let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = type; out.set(len, 1); out.set(body, 1 + len.length);
  return out;
}

export class Mqtt {
  private ws: WebSocket | null = null;
  private pid = 1;
  private ping = 0;
  private retry = 0;
  ready = false;
  closed = false;

  constructor(
    readonly url: string,
    private topics: string[],
    private onMsg: (topic: string, payload: Uint8Array) => void,
  ) { this.open(); }

  private open() {
    if (this.closed) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url, 'mqtt'); } catch { this.later(); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const id = 'schlund-' + Math.random().toString(36).slice(2, 12);
      // Protokoll "MQTT", Level 4, Clean Session, Keepalive 45 s
      ws.send(packet(0x10, [...str('MQTT'), 4, 0x02, 0, 45, ...str(id)]));
    };
    let buf = new Uint8Array(0);
    ws.onmessage = (e) => {
      const chunk = new Uint8Array(e.data as ArrayBuffer);
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf); merged.set(chunk, buf.length);
      buf = merged;
      // vollständige Pakete abarbeiten
      for (;;) {
        if (buf.length < 2) break;
        let len = 0, mul = 1, i = 1, d;
        do { d = buf[i++]; len += (d & 127) * mul; mul *= 128; } while (d & 128 && i < buf.length);
        if (d & 128 || buf.length < i + len) break;
        this.handle(buf[0], buf.subarray(i, i + len));
        buf = buf.slice(i + len);
      }
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this.ready = false; this.ws = null;
      clearInterval(this.ping);
      this.later();
    };
  }

  private later() {
    if (this.closed) return;
    this.retry = Math.min(30, this.retry + 3);
    setTimeout(() => this.open(), this.retry * 1000);
  }

  private handle(h: number, body: Uint8Array) {
    const type = h >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.ws?.close(); return; }
      this.ready = true; this.retry = 0;
      for (const t of this.topics) this.subscribe(t);
      clearInterval(this.ping);
      this.ping = window.setInterval(() => this.ws?.send(new Uint8Array([0xc0, 0])), 30000);
    } else if (type === 3) { // PUBLISH
      const tl = (body[0] << 8) | body[1];
      const topic = new TextDecoder().decode(body.subarray(2, 2 + tl));
      const qos = (h >> 1) & 3;
      this.onMsg(topic, body.subarray(2 + tl + (qos ? 2 : 0)));
    }
  }

  private subscribe(topic: string) {
    const id = this.pid++ & 0xffff || 1;
    this.ws?.send(packet(0x82, [id >> 8, id & 255, ...str(topic), 0]));
  }

  publish(topic: string, payload: Uint8Array) {
    if (!this.ready || !this.ws || this.ws.bufferedAmount > 256 * 1024) return;
    const t = str(topic);
    const body = new Uint8Array(t.length + payload.length);
    body.set(t); body.set(payload, t.length);
    this.ws.send(packet(0x30, body));
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    this.ws?.close();
  }
}
