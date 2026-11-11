"use strict";

// ============================== SETUP ======================================
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

const GRAVITY = 0.55;
const FRICTION = 0.82;
const AIR_DRAG = 0.985;
const MAX_FALL = 18;
const BLAST = 90; // margin outside screen for KOs

const keys = {};
window.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => { keys[e.code] = false; });

// ============================== AUDIO ======================================
let audioCtx = null;
function beep(freq, dur, type = "square", vol = 0.08) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (err) { /* audio unavailable */ }
}

// ============================== STAGE ======================================
const platforms = [
  { x: 340, y: 560, w: 600, h: 26, main: true },   // main stage
  { x: 150, y: 400, w: 200, h: 18, main: false },  // left soft platform
  { x: 930, y: 400, w: 200, h: 18, main: false },  // right soft platform
  { x: 540, y: 280, w: 200, h: 18, main: false },  // top soft platform
];

// ============================== FIGHTER ====================================
const CHARACTERS = [
  { name: "BLAZE", color: "#ff5a4e", dark: "#b32d24", glow: "#ffb199" },
  { name: "VOLT",  color: "#4ecbff", dark: "#1f7fb5", glow: "#b6ecff" },
  { name: "TOXIN", color: "#7dff5a", dark: "#3fa822", glow: "#d6ffc4" },
  { name: "NOVA",  color: "#d24eff", dark: "#7d1fa8", glow: "#eec2ff" },
];

class Fighter {
  constructor(charIdx, controls, isBot, spawnX) {
    this.char = CHARACTERS[charIdx % CHARACTERS.length];
    this.controls = controls; // {left,right,up,down,light,heavy}
    this.isBot = isBot;
    this.spawnX = spawnX;
    this.stocks = 3;
    this.damage = 0;
    this.reset(spawnX);
  }

  reset(x) {
    this.x = x; this.y = 300;
    this.vx = 0; this.vy = 0;
    this.w = 44; this.h = 62;
    this.facing = x < W / 2 ? 1 : -1;
    this.onGround = false;
    this.jumps = 2;
    this.jumpsMax = 2;
    this.hitstun = 0;
    this.invuln = 120;
    this.attackTimer = 0;
    this.attackType = null;
    this.attackCooldown = 0;
    this.hasHit = false;
    this.dodgeTimer = 0;
    this.dodgeCooldown = 0;
    this.fastFalling = false;
    this.dead = false;
    this.respawnTimer = 0;
    this.animTime = 0;
    this.landSquash = 0;
  }

  get center() { return { x: this.x, y: this.y - this.h / 2 }; }

  startAttack(type) {
    if (this.attackCooldown > 0 || this.hitstun > 0 || this.dodgeTimer > 0 || this.dead) return;
    this.attackType = type;
    this.attackTimer = type === "heavy" ? 26 : 16;
    this.attackCooldown = type === "heavy" ? 42 : 22;
    this.hasHit = false;
    const lunge = type === "heavy" ? 7 : 3.5;
    this.vx += this.facing * lunge;
    if (!this.onGround) this.vy = Math.min(this.vy, type === "heavy" ? -2 : 0);
    beep(type === "heavy" ? 160 : 320, 0.08, "sawtooth", 0.05);
  }

  startDodge() {
    if (this.dodgeCooldown > 0 || this.hitstun > 0 || this.dead) return;
    this.dodgeTimer = 14;
    this.dodgeCooldown = 60;
    this.vx = (keys[this.controls.right] ? 1 : keys[this.controls.left] ? -1 : this.facing) * 11;
    if (!this.onGround) this.vy = Math.min(this.vy, -3);
    beep(520, 0.1, "sine", 0.05);
  }

  update(opponent) {
    this.animTime++;
    if (this.dead) {
      this.respawnTimer--;
      if (this.respawnTimer <= 0 && this.stocks > 0) {
        this.reset(this.spawnX);
      }
      return;
    }

    if (this.invuln > 0) this.invuln--;
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.dodgeCooldown > 0) this.dodgeCooldown--;
    if (this.landSquash > 0) this.landSquash--;

    if (this.hitstun > 0) {
      this.hitstun--;
      this.attackTimer = 0;
    } else if (this.dodgeTimer > 0) {
      this.dodgeTimer--;
    } else {
      this.handleInput();
    }

    // Attack hitbox lifetime
    if (this.attackTimer > 0) this.attackTimer--;

    this.physics();

    if (this.attackTimer > 0 && !this.hasHit) this.checkHit(opponent);
    this.checkBlastZones();
  }

  handleInput() {
    const c = this.controls;
    const speed = this.onGround ? 6.2 : 5.4;
    if (keys[c.left]) { this.vx -= 0.9; this.facing = -1; }
    if (keys[c.right]) { this.vx += 0.9; this.facing = 1; }
    this.vx = Math.max(-speed, Math.min(speed, this.vx));

    if (keys[c.up] && !this.jumpHeld && this.jumps > 0) {
      this.vy = -12.5;
      this.jumps--;
      this.onGround = false;
      beep(440, 0.08, "triangle", 0.04);
    }
    this.jumpHeld = keys[c.up];

    this.fastFalling = keys[c.down] && !this.onGround;

    if (keys[c.light] && !this.lightHeld) this.startAttack("light");
    if (keys[c.heavy] && !this.heavyHeld) this.startAttack("heavy");
    this.lightHeld = keys[c.light];
    this.heavyHeld = keys[c.heavy];
  }

  physics() {
    this.vy += GRAVITY * (this.fastFalling ? 1.9 : 1);
    if (this.vy > MAX_FALL) this.vy = MAX_FALL;
    if (this.fastFalling) this.vy = Math.min(this.vy + 1.5, MAX_FALL + 4);

    if (this.dodgeTimer > 0) this.vy *= 0.4;

    this.x += this.vx;
    this.y += this.vy;

    if (!this.onGround) {
      this.vx *= AIR_DRAG;
    }

    this.onGround = false;
    for (const p of platforms) {
      // landing (only from above)
      if (this.vy >= 0 &&
          this.x + this.w / 2 > p.x && this.x - this.w / 2 < p.x + p.w &&
          this.y > p.y - 4 && this.y - this.vy <= p.y + 6) {
        this.y = p.y;
        if (this.vy > 8) this.landSquash = 8;
        this.vy = 0;
        this.onGround = true;
        this.jumps = this.jumpsMax;
        this.fastFalling = false;
      }
    }

    if (this.onGround) this.vx *= FRICTION;

    // wall bump at arena sides (below stage level only, stage itself has gaps)
    if (this.x < this.w / 2) { this.x = this.w / 2; this.vx = Math.max(0, this.vx); }
    if (this.x > W - this.w / 2) { this.x = W - this.w / 2; this.vx = Math.min(0, this.vx); }
  }

  attackHitbox() {
    if (this.attackTimer <= 0) return null;
    const activeWindow = this.attackType === "heavy" ? 20 : 12;
    if (this.attackTimer < (this.attackType === "heavy" ? 8 : 6)) return null;
    const reach = this.attackType === "heavy" ? 78 : 58;
    const h = this.attackType === "heavy" ? 70 : 54;
    return {
      x: this.facing === 1 ? this.x + this.w / 2 : this.x - this.w / 2 - reach,
      y: this.y - this.h - 6 + (this.h - h) / 2,
      w: reach, h: h,
    };
  }

  checkHit(opponent) {
    const hb = this.attackHitbox();
    if (!hb || !opponent || opponent.dead || opponent.invuln > 0 || opponent.dodgeTimer > 0) return;
    const ox = opponent.x - opponent.w / 2, oy = opponent.y - opponent.h;
    if (hb.x < ox + opponent.w && hb.x + hb.w > ox && hb.y < opponent.y && hb.y + hb.h > oy) {
      this.hasHit = true;
      const heavy = this.attackType === "heavy";
      const dmg = heavy ? 12 : 5;
      const baseKb = heavy ? 13 : 6;
      const scale = heavy ? 0.16 : 0.09;
      opponent.damage += dmg;
      const kb = baseKb + opponent.damage * scale;
      const dir = opponent.x >= this.x ? 1 : -1;
      opponent.vx = dir * kb;
      opponent.vy = heavy ? -kb * 0.75 : -kb * 0.45;
      opponent.hitstun = Math.min(40, 8 + Math.floor(kb * 0.8));
      opponent.attackTimer = 0;
      opponent.onGround = false;
      spawnHitSparks(opponent.x, opponent.y - opponent.h / 2, heavy ? 22 : 12, this.char.glow);
      screenShake = heavy ? 14 : 6;
      beep(heavy ? 110 : 220, 0.12, "square", 0.09);
    }
  }

  checkBlastZones() {
    if (this.dead) return;
    if (this.x < -BLAST || this.x > W + BLAST || this.y - this.h > H + BLAST || this.y < -BLAST - 400) {
      this.dead = true;
      this.stocks--;
      this.respawnTimer = 80;
      spawnKOEffect(this.x, Math.max(20, Math.min(H, this.y)));
      screenShake = 20;
      beep(80, 0.4, "sawtooth", 0.12);
    }
  }
}

// ============================== BOT AI =====================================
function botThink(bot, foe) {
  if (bot.dead || bot.hitstun > 0 || bot.dodgeTimer > 0) return;
  const dx = foe.x - bot.x;
  const dy = foe.y - bot.y;
  const dist = Math.abs(dx);

  // recover
  if (bot.y > 620 || bot.x < 120 || bot.x > W - 120) {
    bot.vx += (W / 2 - bot.x) * 0.004;
    if (bot.vy > 0 && bot.jumps > 0 && Math.random() < 0.2) { bot.vy = -12.5; bot.jumps--; }
  } else if (foe.dead) {
    bot.vx *= 0.9;
  } else {
    if (dy < -60 && bot.onGround && Math.random() < 0.1) { bot.vy = -12.5; bot.jumps--; }
    if (bot.onGround && Math.random() < 0.03 && bot.jumps > 0) { bot.vy = -12.5; bot.jumps--; }
    if (dist > 70) {
      bot.vx += Math.sign(dx) * 0.8;
      bot.facing = Math.sign(dx) || bot.facing;
    } else if (dist < 34) {
      bot.vx -= Math.sign(dx) * 0.5;
    }
    if (dist < 75 && Math.abs(dy) < 60) {
      if (foe.damage > 70 && Math.random() < 0.04) bot.startAttack("heavy");
      else if (Math.random() < 0.09) bot.startAttack("light");
    }
    if (bot.damage > 90 && Math.random() < 0.008) bot.startDodge();
  }
  bot.vx = Math.max(-6.2, Math.min(6.2, bot.vx));
}

// ============================== EFFECTS ====================================
let particles = [];
let screenShake = 0;
let hitFlashes = [];

function spawnHitSparks(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 2 + Math.random() * 7;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 20 + Math.random() * 15, color, size: 2 + Math.random() * 4 });
  }
  hitFlashes.push({ x, y, life: 10, max: 10, r: 20 });
}
function spawnKOEffect(x, y) {
  for (let i = 0; i < 50; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 3 + Math.random() * 11;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 30 + Math.random() * 25, color: ["#fff", "#ffd34e", "#ff5a4e"][i % 3], size: 3 + Math.random() * 6 });
  }
  hitFlashes.push({ x, y, life: 18, max: 18, r: 60 });
}
function updateEffects() {
  particles = particles.filter(p => {
    p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.vx *= 0.96; p.life--;
    return p.life > 0;
  });
  hitFlashes = hitFlashes.filter(f => (f.life--, f.life > 0));
  if (screenShake > 0) screenShake *= 0.85;
}

// ============================== GAME STATE =================================
let state = "menu"; // menu | playing | gameover
let mode = "bot";
let p1 = null, p2 = null;
let winner = null;
let menuSel = 0;
const MENU_ITEMS = ["1 PLAYER  (vs BOT)", "2 PLAYERS  (local)"];

function startGame(m) {
  mode = m;
  p1 = new Fighter(0, { left: "KeyA", right: "KeyD", up: "KeyW", down: "KeyS", light: "KeyJ", heavy: "KeyK" }, false, 420);
  p2 = new Fighter(1, { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", light: "Comma", heavy: "Period" }, m === "bot", W - 420);
  particles = []; hitFlashes = [];
  state = "playing";
  beep(660, 0.15, "triangle", 0.07);
}

function checkGameOver() {
  if (p1.stocks <= 0 || p2.stocks <= 0) {
    winner = p1.stocks <= 0 ? p2 : p1;
    state = "gameover";
    beep(660, 0.5, "triangle", 0.1);
  }
}

// ============================== RENDER =====================================
function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#141a33");
  g.addColorStop(0.6, "#0e1226");
  g.addColorStop(1, "#090b18");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // stars
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  for (let i = 0; i < 60; i++) {
    const sx = (i * 197) % W, sy = (i * 113) % 500;
    const tw = 0.5 + 0.5 * Math.sin(tick / 30 + i);
    ctx.globalAlpha = 0.15 + tw * 0.2;
    ctx.fillRect(sx, sy, 2, 2);
  }
  ctx.globalAlpha = 1;

  // distant mountains
  ctx.fillStyle = "#10142b";
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i <= 8; i++) {
    ctx.lineTo(i * (W / 8), 480 + ((i % 2) ? 90 : 0) + Math.sin(i * 7) * 40);
  }
  ctx.lineTo(W, H);
  ctx.fill();
}

function drawPlatforms() {
  for (const p of platforms) {
    if (p.main) {
      ctx.fillStyle = "#2b3160";
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = "#4e58a8";
      ctx.fillRect(p.x, p.y, p.w, 8);
      ctx.fillStyle = "#1a1e3d";
      for (let i = 0; i < p.w; i += 40) ctx.fillRect(p.x + i + 8, p.y + 12, 24, 8);
      // side rock
      ctx.fillStyle = "#232850";
      ctx.beginPath();
      ctx.moveTo(p.x + 30, p.y + p.h); ctx.lineTo(p.x + 70, p.y + p.h + 120);
      ctx.lineTo(p.x + 130, p.y + p.h); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p.x + p.w - 130, p.y + p.h); ctx.lineTo(p.x + p.w - 70, p.y + p.h + 120);
      ctx.lineTo(p.x + p.w - 30, p.y + p.h); ctx.fill();
    } else {
      ctx.fillStyle = "rgba(120,140,255,0.85)";
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = "rgba(200,215,255,0.9)";
      ctx.fillRect(p.x, p.y, p.w, 4);
    }
  }
}

function drawFighter(f) {
  if (f.dead) return;
  if (f.invuln > 0 && Math.floor(tick / 4) % 2 === 0) ctx.globalAlpha = 0.35;
  if (f.dodgeTimer > 0) ctx.globalAlpha = 0.3;

  const squash = f.landSquash > 0 ? 1 - f.landSquash * 0.03 : 1;
  const stretch = f.landSquash > 0 ? 1 + f.landSquash * 0.03 : 1;
  const h = f.h * squash, w = f.w * stretch;
  const bx = f.x - w / 2, by = f.y - h;
  const walking = f.onGround && Math.abs(f.vx) > 1 && f.hitstun <= 0;
  const bob = walking ? Math.sin(f.animTime * 0.4) * 3 : 0;
  const airborne = !f.onGround;

  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(f.facing, 1);
  ctx.translate(-f.x, -f.y);

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(f.x, f.y + 4, w * 0.45, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // legs
  ctx.strokeStyle = f.char.dark;
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  const legSwing = walking ? Math.sin(f.animTime * 0.4) * 12 : airborne ? 8 : 0;
  ctx.beginPath();
  ctx.moveTo(f.x - 6, f.y - 24 + bob); ctx.lineTo(f.x - 6 - legSwing * 0.4, f.y);
  ctx.moveTo(f.x + 6, f.y - 24 + bob); ctx.lineTo(f.x + 6 + legSwing * 0.4, f.y);
  ctx.stroke();

  // body
  ctx.fillStyle = f.char.color;
  const bodyH = 30, bodyW = 26;
  ctx.beginPath();
  ctx.roundRect(f.x - bodyW / 2, f.y - h + 14 + bob, bodyW, bodyH, 8);
  ctx.fill();
  ctx.fillStyle = f.char.dark;
  ctx.beginPath();
  ctx.roundRect(f.x - bodyW / 2, f.y - h + 32 + bob, bodyW, 12, 6);
  ctx.fill();

  // head
  ctx.fillStyle = "#ffe0c2";
  ctx.beginPath();
  ctx.arc(f.x, f.y - h + 4 + bob, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = f.char.color;
  ctx.beginPath();
  ctx.arc(f.x, f.y - h + 1 + bob, 12, Math.PI, Math.PI * 2);
  ctx.fill();

  // eyes
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(f.x + 3, f.y - h + 2 + bob, 3, 5);
  ctx.fillRect(f.x + 9, f.y - h + 2 + bob, 3, 5);

  // weapon arm
  const attacking = f.attackTimer > 0;
  const heavy = f.attackType === "heavy";
  ctx.strokeStyle = f.char.color;
  ctx.lineWidth = 7;
  if (attacking) {
    const t = 1 - f.attackTimer / (heavy ? 26 : 16);
    const swing = -0.8 + t * 2.2;
    const ax = f.x + 14, ay = f.y - h + 22 + bob;
    const wx = ax + Math.cos(swing) * 34, wy = ay + Math.sin(swing) * 34;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(wx, wy); ctx.stroke();
    // blade
    ctx.strokeStyle = "#e8ecff";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(wx, wy);
    ctx.lineTo(wx + Math.cos(swing) * (heavy ? 42 : 28), wy + Math.sin(swing) * (heavy ? 42 : 28));
    ctx.stroke();
    // trail
    ctx.strokeStyle = f.char.glow;
    ctx.globalAlpha = ctx.globalAlpha * 0.5;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ax, ay, heavy ? 55 : 42, swing - 1.2, swing);
    ctx.stroke();
    ctx.globalAlpha = f.invuln > 0 && Math.floor(tick / 4) % 2 === 0 ? 0.35 : 1;
  } else {
    const swing = walking ? Math.sin(f.animTime * 0.4 + Math.PI) * 10 : 0;
    ctx.beginPath();
    ctx.moveTo(f.x + 8, f.y - h + 22 + bob);
    ctx.lineTo(f.x + 16, f.y - h + 34 + bob + swing * 0.3);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // damage % above head
  ctx.font = "bold 16px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = f.damage > 100 ? "#ff5a4e" : f.damage > 60 ? "#ffb347" : "#cfd6ff";
  ctx.fillText(f.damage + "%", f.x, f.y - h - 14);
}

function drawHUD() {
  // P1 panel
  drawStockPanel(30, 24, p1);
  drawStockPanel(W - 30 - 240, 24, p2, true);
}

function drawStockPanel(x, y, f, right) {
  ctx.save();
  if (right) ctx.translate(x + 240, y), ctx.scale(-1, 1), ctx.translate(0, 0), ctx.translate(-240, 0);
  ctx.fillStyle = "rgba(10,14,30,0.7)";
  ctx.beginPath();
  ctx.roundRect(x, y, 240, 64, 10);
  ctx.fill();
  ctx.strokeStyle = f.char.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, 240, 64, 10);
  ctx.stroke();

  ctx.fillStyle = f.char.color;
  ctx.font = "bold 18px 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(f.char.name, x + 16, y + 26);

  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < f.stocks ? "#ffd34e" : "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.moveTo(x + 18 + i * 26, y + 52);
    ctx.lineTo(x + 26 + i * 26, y + 38);
    ctx.lineTo(x + 34 + i * 26, y + 52);
    ctx.lineTo(x + 26 + i * 26, y + 46);
    ctx.fill();
  }
  ctx.restore();

  // damage meter
  const mw = 160;
  const mx = right ? x + 240 - 16 - mw : x + 16;
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(mx, y + 46, mw, 6);
  const pct = Math.min(1, f.damage / 150);
  ctx.fillStyle = pct > 0.66 ? "#ff5a4e" : pct > 0.33 ? "#ffb347" : "#7dff5a";
  ctx.fillRect(mx, y + 46, mw * pct, 6);
}

function drawCenterText(text, size, color, y) {
  ctx.font = `bold ${size}px 'Segoe UI', sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, y);
}

function drawMenu() {
  drawBackground();
  drawPlatforms();
  drawCenterText("BRAWL ARENA", 84, "#ffd34e", 200);
  ctx.font = "bold 20px 'Segoe UI', sans-serif";
  ctx.fillStyle = "#8a93c8";
  ctx.fillText("a Brawlhalla-style platform fighter", W / 2, 240);

  MENU_ITEMS.forEach((item, i) => {
    const sel = i === menuSel;
    drawCenterText((sel ? "> " : "") + item + (sel ? " <" : ""), 34, sel ? "#fff" : "#5a6394", 360 + i * 60);
  });

  ctx.font = "16px 'Segoe UI', sans-serif";
  ctx.fillStyle = "#5a6394";
  ctx.fillText("W/S or Up/Down to select  •  ENTER to play", W / 2, 520);

  const lines = [
    "P1:  A/D move   W jump (x2)   S fast-fall   J light   K heavy",
    "P2:  ←/→ move   ↑ jump        ↓ fast-fall   , light   . heavy",
    "Knock enemies off the stage. 3 stocks each. Higher damage = bigger knockback!",
  ];
  lines.forEach((l, i) => {
    ctx.fillStyle = i === 2 ? "#8a93c8" : "#4a5280";
    ctx.fillText(l, W / 2, 580 + i * 28);
  });
}

function drawGameover() {
  drawBackground();
  drawPlatforms();
  drawCenterText("K.O.!", 100, "#ff5a4e", 240);
  drawCenterText(`${winner.char.name} WINS!`, 56, winner.char.color, 330);
  drawCenterText("ENTER — rematch      ESC — menu", 26, "#cfd6ff", 430);
}

// ============================== MAIN LOOP ==================================
let tick = 0;
function loop() {
  tick++;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (screenShake > 0.5) {
    ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
  }

  if (state === "menu") {
    drawMenu();
    if (keys["KeyW"] || keys["ArrowUp"]) { if (tick % 12 === 0) { menuSel = (menuSel + 1) % 2; beep(500, 0.05, "square", 0.04); } }
    if (keys["KeyS"] || keys["ArrowDown"]) { if (tick % 12 === 0) { menuSel = (menuSel + 1) % 2; beep(500, 0.05, "square", 0.04); } }
    if (keys["Enter"]) startGame(MENU_ITEMS[menuSel].startsWith("1") ? "bot" : "local");
  } else if (state === "playing") {
    drawBackground();
    drawPlatforms();

    if (p2.isBot) botThink(p2, p1);
    p1.update(p2);
    p2.update(p1);
    updateEffects();

    drawFighter(p2);
    drawFighter(p1);
    drawHUD();

    for (const fl of hitFlashes) {
      ctx.globalAlpha = fl.life / fl.max * 0.6;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(fl.x, fl.y, fl.r * (1.5 - fl.life / fl.max), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    for (const p of particles) {
      ctx.globalAlpha = Math.min(1, p.life / 20);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      ctx.globalAlpha = 1;
    }

    checkGameOver();
  } else if (state === "gameover") {
    drawGameover();
    if (keys["Enter"]) startGame(mode);
    if (keys["Escape"]) { state = "menu"; keys["Enter"] = false; }
  }

  ctx.restore();

  if (state === "playing") {
    ctx.font = "13px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillText("ESC — quit to menu", W / 2, H - 14);
    if (keys["Escape"]) { state = "menu"; }
  }
  requestAnimationFrame(loop);
}
loop();
