/**
 * 发送闸门 · 限频 + 熔断
 * ─────────────────────────────────────────────────────────────
 * 教程第十三章：被腾讯风控的三个原因里，「重试风暴」和「发送太勤」是两个。
 *   限频：每分钟、每小时最多发多少条，超了这一轮剩下的就不发了
 *   熔断：连续失败 N 次就停一段时间，期间一条都不发（发送失败时最忌讳一直撞）
 *
 *   const gate = new SendGate({ perMinute: 6, perHour: 80 });
 *   const g = gate.allow(); if (!g.ok) return;
 *   const r = await bot.send(...); gate.record(r.ok);
 */
export class SendGate {
  /**
   * @param {object} opts
   * @param {number} [opts.perMinute=6]
   * @param {number} [opts.perHour=80]
   * @param {number} [opts.failThreshold=3]   连续失败几次就熔断
   * @param {number} [opts.cooldownMs=180000] 熔断多久
   */
  constructor({ perMinute = 6, perHour = 80, failThreshold = 3, cooldownMs = 180000 } = {}) {
    this.perMinute = perMinute;
    this.perHour = perHour;
    this.failThreshold = failThreshold;
    this.cooldownMs = cooldownMs;
    this.sentAt = [];
    this.consecutiveFails = 0;
    this.openUntil = 0;
  }

  /** @returns {{ok:boolean, reason?:string}} */
  allow(now = Date.now()) {
    if (now < this.openUntil) return { ok: false, reason: '熔断中，还剩 ' + Math.ceil((this.openUntil - now) / 1000) + ' 秒' };
    this.sentAt = this.sentAt.filter((t) => now - t < 3600000);
    if (this.sentAt.filter((t) => now - t < 60000).length >= this.perMinute) return { ok: false, reason: '超过每分钟 ' + this.perMinute + ' 条' };
    if (this.sentAt.length >= this.perHour) return { ok: false, reason: '超过每小时 ' + this.perHour + ' 条' };
    return { ok: true };
  }

  /** 发完一条调一次：成功清零失败计数，失败累计到阈值就熔断（失败也算发过，免得失败后马上补发） */
  record(ok, now = Date.now()) {
    this.sentAt.push(now);
    if (ok) { this.consecutiveFails = 0; return; }
    this.consecutiveFails++;
    if (this.consecutiveFails >= this.failThreshold) {
      this.openUntil = now + this.cooldownMs;
      this.consecutiveFails = 0;
    }
  }

  status(now = Date.now()) {
    return {
      open: now < this.openUntil,
      openForMs: Math.max(0, this.openUntil - now),
      lastMinute: this.sentAt.filter((t) => now - t < 60000).length,
      lastHour: this.sentAt.filter((t) => now - t < 3600000).length,
    };
  }
}

export default SendGate;
