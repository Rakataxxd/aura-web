// ESCÁNER DE COMBATE MANGA
// Todo se dibuja en canvas: MediaRecorder graba el canvas, no el DOM.
// Si esto fuera HTML/CSS, el clip descargado saldria sin numeros.

export const INK = '#0a0a0c';
export const BONE = '#f4efe4';
export const P_COLOR = ['#c9ff2e', '#ff2d6f'];
export const GOLD = '#ffc531';

const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [0, 11], [0, 12],
];

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Renderer {
  constructor(canvas) {
    this.c = canvas;
    this.x = canvas.getContext('2d', { alpha: false });
    this.shake = 0;
    this.flash = 0;
    this.flashColor = BONE;
    this.callouts = [];   // nombres de move
    this.bursts = [];     // criticos
    this.line = { text: '', life: 0, color: BONE };
    this.t = 0;
    this.grain = this.makeGrain();
  }

  makeGrain() {
    const g = document.createElement('canvas');
    g.width = g.height = 140;
    const gx = g.getContext('2d');
    const img = gx.createImageData(140, 140);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + Math.random() * 145;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 15;
    }
    gx.putImageData(img, 0, 0);
    return g;
  }

  get u() { return Math.min(this.c.width, this.c.height) / 100; }

  /** Baja el tamano hasta que el texto quepa. Sin esto se desborda en vertical. */
  fitFont(text, maxW, size, family, weight = '') {
    const { x } = this;
    let s = size;
    for (let i = 0; i < 14; i++) {
      x.font = `${weight} ${s}px ${family}`.trim();
      if (x.measureText(text).width <= maxW) break;
      s *= 0.9;
    }
    return s;
  }

  addCallout(text, color, sub = '') {
    this.callouts.push({ text, sub, color, life: 1.9, max: 1.9 });
    if (this.callouts.length > 2) this.callouts.shift();   // apilar 3+ es ilegible
    this.shake = Math.max(this.shake, 0.55);
  }

  addCrit(text, mult, color) {
    this.bursts.length = 0;   // el critico es momento heroe: nunca dos encimados
    this.bursts.push({ text, mult, color, life: 1.5, max: 1.5 });
    this.shake = 1;
    this.flash = 1;
    this.flashColor = GOLD;
  }

  setLine(text, color = BONE) { this.line = { text, life: 3.2, color }; }

  // ---------- capas ----------

  drawVideo(video, mirror) {
    const { x, c } = this;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const s = Math.max(c.width / vw, c.height / vh);      // cover
    const w = vw * s, h = vh * s;
    x.save();
    if (mirror) { x.translate(c.width, 0); x.scale(-1, 1); }
    x.drawImage(video, (c.width - w) / 2, (c.height - h) / 2, w, h);
    x.restore();
    // el video crudo compite con el HUD -> lo apago un poco
    x.fillStyle = 'rgba(10,10,12,0.30)';
    x.fillRect(0, 0, c.width, c.height);
  }

  drawScreentone(intensity) {
    if (intensity <= 0.02) return;
    const { x, c, u } = this;
    const step = u * 2.4;
    x.save();
    x.globalAlpha = 0.10 * intensity;
    x.fillStyle = BONE;
    for (let gy = 0; gy < c.height; gy += step) {
      for (let gx = (gy / step % 2) * step / 2; gx < c.width; gx += step) {
        const d = Math.hypot(gx - c.width / 2, gy - c.height / 2) / (c.width * 0.7);
        const r = clamp(d * intensity * u * 0.5, 0, u * 0.42);
        if (r > 0.3) { x.beginPath(); x.arc(gx, gy, r, 0, 7); x.fill(); }
      }
    }
    x.restore();
  }

  drawSpeedLines(intensity) {
    if (intensity <= 0.02) return;
    const { x, c } = this;
    const cx = c.width / 2, cy = c.height / 2;
    const R = Math.hypot(cx, cy);
    x.save();
    x.globalAlpha = 0.5 * intensity;
    x.strokeStyle = BONE;
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + this.t * 0.15;
      const inner = R * (0.42 + Math.random() * 0.3);
      x.lineWidth = Math.random() * 3 + 0.6;
      x.beginPath();
      x.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      x.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      x.stroke();
    }
    x.restore();
  }

  drawSkeleton(lm, color, energy, mirror) {
    if (!lm) return;
    const { x, c, u } = this;
    const px = (p) => [(mirror ? 1 - p.x : p.x) * c.width, p.y * c.height];
    const glow = clamp(energy / 5, 0, 1);

    x.save();
    x.lineCap = 'round';
    x.shadowColor = color;
    x.shadowBlur = u * (1.2 + glow * 5);
    x.strokeStyle = color;
    x.lineWidth = u * (0.45 + glow * 0.5);
    for (const [a, b] of CONNECTIONS) {
      if ((lm[a].visibility ?? 1) < 0.45 || (lm[b].visibility ?? 1) < 0.45) continue;
      const [x1, y1] = px(lm[a]), [x2, y2] = px(lm[b]);
      x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke();
    }
    x.fillStyle = BONE;
    for (const i of [0, 15, 16, 27, 28]) {
      if ((lm[i].visibility ?? 1) < 0.45) continue;
      const [cx2, cy2] = px(lm[i]);
      x.beginPath(); x.arc(cx2, cy2, u * (0.5 + glow * 0.7), 0, 7); x.fill();
    }
    x.restore();
  }

  drawPod(p, slot, active) {
    const { x, c, u } = this;
    const color = P_COLOR[slot];
    const right = slot === 1;
    const padX = u * 3.5;
    const y = c.height - u * 15;
    const w = u * 34;
    const bx = right ? c.width - padX - w : padX;

    x.save();
    x.globalAlpha = active ? 1 : 0.35;

    // barra de placa
    x.fillStyle = 'rgba(10,10,12,0.72)';
    x.fillRect(bx, y, w, u * 10.5);
    x.fillStyle = color;
    x.fillRect(right ? bx + w - u * 0.8 : bx, y, u * 0.8, u * 10.5);

    // etiqueta
    x.textAlign = right ? 'right' : 'left';
    const tx = right ? bx + w - u * 2.4 : bx + u * 2.4;
    x.fillStyle = color;
    x.font = `700 ${u * 2.1}px "Chakra Petch", sans-serif`;
    x.fillText(`JUGADOR ${slot + 1}`, tx, y + u * 3.1);

    // numero de aura
    x.fillStyle = BONE;
    x.font = `${u * 6.4}px "Archivo Black", sans-serif`;
    x.fillText(Math.round(p.aura).toLocaleString('es-GT'), tx, y + u * 8.6);

    // barra de energia
    const barW = w - u * 4.8, barY = y + u * 9.4;
    const e = clamp(p.energy / 6, 0, 1);
    x.fillStyle = 'rgba(244,239,228,0.16)';
    x.fillRect(bx + u * 2.4, barY, barW, u * 0.7);
    x.fillStyle = color;
    x.shadowColor = color; x.shadowBlur = u * e * 3;
    x.fillRect(right ? bx + u * 2.4 + barW * (1 - e) : bx + u * 2.4, barY, barW * e, u * 0.7);
    x.shadowBlur = 0;

    // combo
    if (p.combo > 1) {
      const pop = 1 + Math.sin(this.t * 14) * 0.06;
      x.save();
      x.translate(tx, y - u * 1.6);
      x.scale(pop, pop);
      x.fillStyle = GOLD;
      x.font = `${u * 3.6}px "Archivo Black", sans-serif`;
      x.fillText(`${p.combo}× COMBO`, 0, 0);
      x.restore();
    }
    x.restore();
  }

  drawCallouts(dt) {
    const { x, c, u } = this;
    for (let i = this.callouts.length - 1; i >= 0; i--) {
      const k = this.callouts[i];
      k.life -= dt;
      if (k.life <= 0) { this.callouts.splice(i, 1); continue; }
      const age = 1 - k.life / k.max;
      const inT = clamp(age / 0.16, 0, 1);
      const scale = 0.7 + easeOut(inT) * 0.3 + (1 - inT) * 0.15;
      const alpha = k.life < 0.4 ? k.life / 0.4 : 1;
      const y = c.height * 0.30 - i * u * 9;

      x.save();
      x.globalAlpha = alpha;
      x.translate(c.width / 2, y);
      x.transform(1, 0, -0.16, 1, 0, 0);   // italica falsa = velocidad
      x.scale(scale, scale);
      x.textAlign = 'center';

      // el ancho util encoge por la italica falsa y por el skew de la caja
      const maxW = c.width * 0.84 / scale;
      const fs = this.fitFont(k.text, maxW, u * 5.6, '"Archivo Black", sans-serif');
      const tw = x.measureText(k.text).width;
      x.fillStyle = INK;
      x.fillRect(-tw / 2 - u * 2, -fs * 0.79, tw + u * 4, fs * 1.14);
      x.fillStyle = k.color;
      x.fillRect(-tw / 2 - u * 2, fs * 0.29, tw + u * 4, u * 0.5);
      x.fillStyle = BONE;
      x.fillText(k.text, 0, 0);
      if (k.sub) {
        x.font = `700 ${u * 2.4}px "Chakra Petch", sans-serif`;
        x.fillStyle = k.color;
        x.fillText(k.sub, 0, fs * 0.82);
      }
      x.restore();
    }
  }

  drawBursts(dt) {
    const { x, c, u } = this;
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt;
      if (b.life <= 0) { this.bursts.splice(i, 1); continue; }
      const age = 1 - b.life / b.max;
      const scale = 0.4 + easeOut(clamp(age / 0.2, 0, 1)) * 0.75;
      const alpha = b.life < 0.5 ? b.life / 0.5 : 1;

      x.save();
      x.globalAlpha = alpha;
      x.translate(c.width / 2, c.height * 0.5);
      x.rotate(-0.06);
      x.scale(scale, scale);
      x.textAlign = 'center';
      this.fitFont(b.text, c.width * 0.88 / scale, u * 8.5, '"Archivo Black", sans-serif');
      // aberracion cromatica
      x.fillStyle = '#00e5ff'; x.fillText(b.text, -u * 0.7, 0);
      x.fillStyle = '#ff003c'; x.fillText(b.text, u * 0.7, 0);
      x.fillStyle = GOLD; x.fillText(b.text, 0, 0);
      x.font = `${u * 5}px "Archivo Black", sans-serif`;
      x.fillStyle = BONE;
      x.fillText(`AURA ×${b.mult}`, 0, u * 7);
      x.restore();
    }
  }

  drawLine(dt) {
    if (this.line.life <= 0 || !this.line.text) return;
    this.line.life -= dt;
    const { x, c, u } = this;
    const a = clamp(this.line.life / 0.5, 0, 1);
    x.save();
    x.globalAlpha = a;
    x.textAlign = 'center';
    this.fitFont(this.line.text, c.width * 0.90, u * 2.9, '"Chakra Petch", sans-serif', '700');
    const tw = x.measureText(this.line.text).width;
    const y = c.height - u * 22;   // arriba de las placas Y del contador de combo
    x.fillStyle = INK;
    x.fillRect(c.width / 2 - tw / 2 - u * 2, y - u * 3, tw + u * 4, u * 4.4);
    x.fillStyle = this.line.color;
    x.fillRect(c.width / 2 - tw / 2 - u * 2, y + u * 1.4, tw + u * 4, u * 0.35);
    x.fillStyle = BONE;
    x.fillText(this.line.text, c.width / 2, y);
    x.restore();
  }

  drawChrome(status) {
    const { x, c, u } = this;
    x.save();
    x.textAlign = 'center';
    x.fillStyle = BONE;
    x.font = `700 ${u * 2.6}px "Chakra Petch", sans-serif`;
    x.fillText('ESCÁNER DE AURA', c.width / 2, u * 5);
    x.font = `${u * 1.7}px "Share Tech Mono", monospace`;
    x.fillStyle = 'rgba(244,239,228,0.55)';
    x.fillText(status, c.width / 2, u * 8);
    // esquinas de mira
    x.strokeStyle = 'rgba(244,239,228,0.4)';
    x.lineWidth = u * 0.25;
    const m = u * 2.4, L = u * 4;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const px2 = sx > 0 ? m : c.width - m, py = sy > 0 ? m : c.height - m;
      x.beginPath();
      x.moveTo(px2 + sx * L, py); x.lineTo(px2, py); x.lineTo(px2, py + sy * L);
      x.stroke();
    }
    x.restore();
  }

  frame({ video, mirror, players, active, status, dt }) {
    const { x, c } = this;
    this.t += dt;
    this.shake = Math.max(0, this.shake - dt * 2.6);
    this.flash = Math.max(0, this.flash - dt * 3.4);

    const maxE = Math.max(...players.map((p) => p.energy), 0);

    x.save();
    if (this.shake > 0.01) {
      const s = this.shake * this.u * 1.6;
      x.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    x.fillStyle = INK;
    x.fillRect(-50, -50, c.width + 100, c.height + 100);
    this.drawVideo(video, mirror);
    this.drawScreentone(clamp(maxE / 5, 0, 1));
    this.drawSpeedLines(clamp((maxE - 3) / 4, 0, 1) * 0.8 + this.flash * 0.5);

    players.forEach((p, i) => this.drawSkeleton(p.lm, P_COLOR[i], p.energy, mirror));

    // grano
    const pat = x.createPattern(this.grain, 'repeat');
    x.save(); x.globalAlpha = 0.5; x.fillStyle = pat;
    x.translate((this.t * 60) % 140 - 140, (this.t * 37) % 140 - 140);
    x.fillRect(0, 0, c.width + 140, c.height + 140); x.restore();

    players.forEach((p, i) => { if (i < active) this.drawPod(p, i, true); });
    this.drawChrome(status);
    this.drawCallouts(dt);
    this.drawBursts(dt);
    this.drawLine(dt);

    if (this.flash > 0.01) {
      x.fillStyle = this.flashColor;
      x.globalAlpha = this.flash * 0.30;
      x.fillRect(0, 0, c.width, c.height);
      x.globalAlpha = 1;
    }
    x.restore();
  }
}
