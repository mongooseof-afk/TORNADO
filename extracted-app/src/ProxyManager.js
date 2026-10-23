/**
 * ThunderBolt 1.8.5 — Proxy Manager (Clean Implementation)
 * Round-robin randomized proxy rotation.
 */
class ProxyManager {
  constructor() {
    this.originalProxies = [];
    this.availableProxies = [];
  }

  setProxies(list) {
    this.originalProxies = Array.isArray(list) ? list : [];
    this._reshuffle();
  }

  _shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  _reshuffle() {
    this.availableProxies = this._shuffle([...this.originalProxies]);
  }

  getNextRandom() {
    if (this.availableProxies.length === 0) {
      this._reshuffle();
    }
    return this.availableProxies.shift() || null;
  }
}

module.exports = new ProxyManager();