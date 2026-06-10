export class PeerManager {
  constructor(localUsername) {
    this.peer = null;
    this.localPeerId = '';
    this.isCoordinator = false;
    this.coordinatorId = '';
    this.roomId = '';
    this.localUsername = localUsername;
    this.peers = new Map(); // peerId → { conn, username }
    this._events = null;
    this._keepaliveInterval = null;
    this._keepaliveWorker = null;
    this._connecting = new Set(); // peerIds we're currently connecting to
  }

  /**
   * Inicializa el nodo. El primero en crear la sala es el coordinador
   * (ID fijo "qdrop-{roomId}"). Los demás se conectan al coordinador
   * y luego establecen enlaces directos con cada nodo existente.
   */
  initialize(roomId, events) {
    this._events = events;

    if (roomId) {
      this.isCoordinator = false;
      this.roomId = roomId;
      this.coordinatorId = `qdrop-${roomId}`;
      this.peer = new Peer(undefined, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        }
      });
    } else {
      this.isCoordinator = true;
      this.roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
      this.coordinatorId = `qdrop-${this.roomId}`;
      this.peer = new Peer(this.coordinatorId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        }
      });
    }

    this.peer.on('open', (id) => {
      this.localPeerId = id;
      console.log('[Mesh] PeerJS conectado. ID:', id, '| Coordinador?', this.isCoordinator);
      events.onLocalIdReady(this.roomId, this.isCoordinator);

      if (!this.isCoordinator) {
        setTimeout(() => this.connectToCoordinator(), 500);
      }
    });

    // El coordinador acepta conexiones de nuevos peers
    // Los peers existentes también aceptan conexiones directas de otros peers
    this.peer.on('connection', (conn) => {
      this.setupPeerConnection(conn, null);
    });

    this.peer.on('disconnected', () => {
      console.warn('[Mesh] Desconectado del servidor PeerJS. Reconectando...');
      this.peer.reconnect();
    });

    this.peer.on('error', (err) => {
      console.error('[Mesh] Error PeerJS:', err.type, err.message);
      events.onError(err);
    });
  }

  /**
   * El invitado se conecta al coordinador.
   */
  connectToCoordinator() {
    console.log('[Mesh] Conectando al coordinador:', this.coordinatorId);
    const conn = this.peer.connect(this.coordinatorId, {
      reliable: true,
      serialization: 'binary'
    });
    this.setupPeerConnection(conn, this.coordinatorId);
  }

  /**
   * Configura los handlers para una conexión entrante o saliente.
   * @param {Object} conn - Conexión PeerJS
   * @param {string|null} expectedPeerId - Si es saliente, el ID esperado
   */
  setupPeerConnection(conn, expectedPeerId) {
    const peerId = expectedPeerId || conn.peer;

    conn.on('open', () => {
      console.log('[Mesh] Canal abierto con:', peerId);

      // Si es conexión con el coordinador, presentarnos
      if (peerId === this.coordinatorId && !this.isCoordinator) {
        conn.send({ type: 'username', payload: { username: this.localUsername, peerId: this.localPeerId } });
      }

      this.startKeepalive();
    });

    conn.on('data', async (raw) => {
      let data = raw;

      if (raw instanceof Blob) {
        data = await raw.arrayBuffer();
      }

      if (data && typeof data.byteLength === 'number' && data.byteLength > 0) {
        if (!(data instanceof ArrayBuffer)) {
          const buf = data.buffer;
          data = buf.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        if (data.byteLength < 2048) {
          try {
            const text = new TextDecoder().decode(data);
            data = JSON.parse(text);
          } catch {
            this._events.onDataReceived(data, peerId);
            return;
          }
        } else {
          this._events.onDataReceived(data, peerId);
          return;
        }
      }

      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          this._events.onDataReceived(data, peerId);
          return;
        }
      }

      if (data && typeof data === 'object') {
        if (data.type === 'username') {
          const username = data.payload.username;
          const incomingPeerId = data.payload.peerId || peerId;

          // Almacenar o actualizar en peers
          if (!this.peers.has(incomingPeerId)) {
            this.peers.set(incomingPeerId, { conn, username });
          } else {
            const existing = this.peers.get(incomingPeerId);
            existing.conn = conn;
            existing.username = username;
          }

          console.log(`[Mesh] Peer conectado: ${username} (${incomingPeerId})`);

          // Si soy el coordinador, enviar lista de peers al recién llegado
          // y notificar a los demás
          if (this.isCoordinator) {
            this._syncNewPeer(incomingPeerId, username);
          }

          this._events.onPeerConnected(incomingPeerId, username);
          this._events.onPeersUpdated?.(this.getPeers());
        } else if (data.type === 'peer-list') {
          // Recibimos la lista de peers existentes del coordinador
          const peerList = data.payload.peers; // [{ peerId, username }]
          console.log('[Mesh] Lista de peers recibida:', peerList);
          for (const p of peerList) {
            if (p.peerId !== this.localPeerId && !this.peers.has(p.peerId) && !this._connecting.has(p.peerId)) {
              this.connectToPeer(p.peerId, p.username);
            }
          }
        } else if (data.type === 'peer-joined') {
          // Otro peer se unió (broadcast del coordinador)
          const p = data.payload;
          if (p.peerId !== this.localPeerId && !this.peers.has(p.peerId) && !this._connecting.has(p.peerId)) {
            this.connectToPeer(p.peerId, p.username);
          }
        } else if (data.type === 'peer-left') {
          const leftPeerId = data.payload.peerId;
          console.log('[Mesh] Peer se fue:', leftPeerId);
          this.peers.delete(leftPeerId);
          this._events.onPeerDisconnected(leftPeerId);
          this._events.onPeersUpdated?.(this.getPeers());
        } else if (data.type === 'ping') {
          // Keepalive
        } else {
          this._events.onDataReceived(data, peerId);
        }
      } else {
        this._events.onDataReceived(data, peerId);
      }
    });

    conn.on('close', () => {
      console.log('[Mesh] Canal cerrado con:', peerId);
      if (this.peers.has(peerId)) {
        this.peers.delete(peerId);
        this._events.onPeerDisconnected(peerId);
        this._events.onPeersUpdated?.(this.getPeers());
      }
      if (this.peers.size === 0) {
        this.stopKeepalive();
      }
    });

    conn.on('error', (err) => {
      console.error('[Mesh] Error en canal con', peerId, ':', err);
    });
  }

  /**
   * El coordinador sincroniza al nuevo peer y notifica a los existentes.
   */
  _syncNewPeer(newPeerId, newUsername) {
    // Enviar lista de peers existentes al nuevo
    const existingPeers = [];
    for (const [pid, info] of this.peers) {
      if (pid !== newPeerId) {
        existingPeers.push({ peerId: pid, username: info.username });
      }
    }
    const newConn = this.peers.get(newPeerId)?.conn;
    if (newConn) {
      newConn.send({ type: 'peer-list', payload: { peers: existingPeers } });
    }

    // Notificar a los peers existentes que alguien nuevo se unió
    for (const [pid, info] of this.peers) {
      if (pid !== newPeerId) {
        info.conn.send({ type: 'peer-joined', payload: { peerId: newPeerId, username: newUsername } });
      }
    }
  }

  /**
   * Conecta directamente a otro peer (establece enlace de malla).
   */
  connectToPeer(peerId, username) {
    if (this._connecting.has(peerId) || this.peers.has(peerId)) return;
    this._connecting.add(peerId);

    console.log(`[Mesh] Conectando directamente a ${username} (${peerId})...`);
    const conn = this.peer.connect(peerId, {
      reliable: true,
      serialization: 'binary'
    });

    conn.on('open', () => {
      this._connecting.delete(peerId);
      // Presentarnos a este peer
      conn.send({ type: 'username', payload: { username: this.localUsername, peerId: this.localPeerId } });
    });

    conn.on('close', () => {
      this._connecting.delete(peerId);
    });

    this.setupPeerConnection(conn, peerId);
  }

  /**
   * Envía datos a todos los peers conectados.
   */
  broadcast(data) {
    for (const [, info] of this.peers) {
      if (info.conn && info.conn.open) {
        info.conn.send(data);
      }
    }
  }

  /**
   * Envía datos a un peer específico.
   */
  sendTo(peerId, data) {
    const info = this.peers.get(peerId);
    if (info && info.conn && info.conn.open) {
      info.conn.send(data);
      return true;
    }
    return false;
  }

  /**
   * Retorna la lista de peers conectados: [{ peerId, username }]
   */
  getPeers() {
    const list = [];
    for (const [peerId, info] of this.peers) {
      list.push({ peerId, username: info.username });
    }
    return list;
  }

  /**
   * Retorna true si hay al menos un peer conectado.
   */
  isConnected() {
    return this.peers.size > 0;
  }

  /**
   * Retorna la primera conexión activa (compatibilidad con código anterior).
   */
  getActiveConnection() {
    for (const [, info] of this.peers) {
      if (info.conn && info.conn.open) return info.conn;
    }
    return null;
  }

  /**
   * Retorna la conexión a un peer específico.
   */
  getConnection(peerId) {
    const info = this.peers.get(peerId);
    return (info && info.conn && info.conn.open) ? info.conn : null;
  }

  /**
   * Retorna la primera conexión cuyo peer tenga el nombre indicado.
   */
  getConnectionByUsername(username) {
    for (const [, info] of this.peers) {
      if (info.username === username && info.conn && info.conn.open) return info.conn;
    }
    return null;
  }

  getPeerUsername() {
    for (const [, info] of this.peers) {
      return info.username;
    }
    return '';
  }

  startKeepalive() {
    if (this._keepaliveWorker) return;

    try {
      this._keepaliveWorker = new Worker('./js/keepalive-worker.js');
      this._keepaliveWorker.onmessage = () => {
        this.broadcast({ type: 'ping' });
        if (this.peers.size === 0) this.stopKeepalive();
      };
    } catch (err) {
      this._keepaliveInterval = setInterval(() => {
        this.broadcast({ type: 'ping' });
        if (this.peers.size === 0) this.stopKeepalive();
      }, 5000);
      return;
    }

    this._keepaliveWorker.postMessage({ type: 'start', interval: 5000 });
  }

  stopKeepalive() {
    if (this._keepaliveWorker) {
      this._keepaliveWorker.postMessage({ type: 'stop' });
    }
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  }

  disconnect() {
    this.stopKeepalive();
    for (const [, info] of this.peers) {
      if (info.conn) info.conn.close();
    }
    this.peers.clear();
    if (this._keepaliveWorker) {
      this._keepaliveWorker.terminate();
      this._keepaliveWorker = null;
    }
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
  }
}
