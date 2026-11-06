// IndexedDB on the operator's computer: survives closing the tab, sleep, browser restarts.
(() => {
  if (self.__scanDb) return;
  const NAME = 'site-scan';
  const STORES = {
    meta: { keyPath: 'k' },
    states: { keyPath: 'sig' },
    events: { autoIncrement: true },
    netlog: { autoIncrement: true },
    net: { keyPath: 'key' },
    probes: { autoIncrement: true },
    incidents: { autoIncrement: true },
  };
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open(NAME, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        for (const [name, opts] of Object.entries(STORES)) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
      };
      rq.onsuccess = () => {
        const db = rq.result;
        db.onversionchange = () => { db.close(); dbp = null; };
        db.onclose = () => { dbp = null; };
        resolve(db);
      };
      rq.onerror = () => { dbp = null; reject(rq.error); };
      rq.onblocked = () => { /* another page has it open: wait */ };
    });
    return dbp;
  }

  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abort')); });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function get(store, key) { const db = await open(); return req(db.transaction(store).objectStore(store).get(key)); }
  async function put(store, value) { const db = await open(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); return done(tx); }
  async function add(store, values) {
    if (!values.length) return;
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.add(v);
    return done(tx);
  }
  async function count(store) { const db = await open(); return req(db.transaction(store).objectStore(store).count()); }
  async function clearAll() {
    const db = await open();
    const tx = db.transaction(Object.keys(STORES), 'readwrite');
    for (const s of Object.keys(STORES)) tx.objectStore(s).clear();
    return done(tx);
  }
  /** Deletes `n` old records of an autoIncrement store, keeping the very first `skip` (the start of the recording). */
  async function trim(store, n, skip = 0) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    let left = n;
    let skipped = !skip;
    os.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c || left <= 0) return;
      if (!skipped) { skipped = true; c.advance(skip); return; }
      c.delete();
      left--;
      c.continue();
    };
    return done(tx);
  }
  /** Read-modify-write of several keys in one transaction. */
  async function update(store, keys, fn) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const k of keys) {
      const r = os.get(k);
      r.onsuccess = () => { const v = fn(k, r.result); if (v) os.put(v); };
    }
    return done(tx);
  }
  /** Streams every record of a store: fn(value) for each, in key order. */
  async function each(store, fn) {
    const db = await open();
    const tx = db.transaction(store);
    await new Promise((res, rej) => {
      const c = tx.objectStore(store).openCursor();
      c.onsuccess = (e) => { const cur = e.target.result; if (!cur) { res(); return; } try { fn(cur.value); } catch (err) { rej(err); return; } cur.continue(); };
      c.onerror = () => rej(c.error);
    });
  }

  /** All keys of a store (cheap: no values are read). */
  async function keys(store) {
    const db = await open();
    const r = db.transaction(store).objectStore(store).getAllKeys();
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  /** The newest n records of a store (newest last), reading only those — not the whole store. */
  async function last(store, n) {
    const db = await open();
    const tx = db.transaction(store);
    const out = [];
    await new Promise((res, rej) => {
      const c = tx.objectStore(store).openCursor(null, 'prev');
      c.onsuccess = (e) => { const cur = e.target.result; if (!cur || out.length >= n) { res(); return; } out.push(cur.value); cur.continue(); };
      c.onerror = () => rej(c.error);
    });
    return out.reverse();
  }

  self.__scanDb = { open, get, put, add, count, clearAll, trim, update, each, last, keys, STORES: Object.keys(STORES) };
})();
