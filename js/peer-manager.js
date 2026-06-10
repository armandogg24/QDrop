export class PeerManager {
  constructor(localUsername) {
    this.peer = null;
    this.connection = null;
    this.isHost = false;
    this.roomId = '';
    this.localUsername = localUsername;
    this.peerUsername = '';
    this._events = null;
    this._keepaliveInterval = null;
    this._keepaliveWorker = null;
  }

  /**
   * Inicializa el par local y maneja el rol de Host o Invitado según la URL.
   */
  initialize(roomIdFromUrl, events) {
    this._events = events;

    if (roomIdFromUrl) {
      // Rol: Invitado (Guest)
      this.isHost = false;
      this.roomId = roomIdFromUrl;
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
      // Rol: Creador de la Sala (Host)
      this.isHost = true;
      this.roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
      this.peer = new Peer(`${this.roomId}-host`, {
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
      console.log('PeerJS conectado con ID:', id);
      events.onLocalIdReady(this.roomId, this.isHost);
      if (!this.isHost) {
        // Pequeño delay para que el servidor PeerJS propague el host
        setTimeout(() => this.connectToHost(events), 500);
      }
    });

    // El Host escucha conexiones entrantes
    this.peer.on('connection', (conn) => {
      if (this.isHost && !this.connection) {
        this.connection = conn;
        this.setupConnectionHandlers(events);
      } else {
        // Rechazar conexiones adicionales
        conn.close();
      }
    });

    this.peer.on('disconnected', () => {
      console.warn('Desconectado del servidor PeerJS. Intentando reconectar...');
      this.peer.reconnect();
    });

    this.peer.on('error', (err) => {
      console.error('Error de PeerJS:', err.type, err.message);
      events.onError(err);
    });
  }

  /**
   * Conecta al host de la sala (rol de Invitado).
   */
  connectToHost(events) {
    const hostId = `${this.roomId}-host`;
    console.log('Intentando conectar al host:', hostId);
    this.connection = this.peer.connect(hostId, {
      reliable: true,
      serialization: 'binary'
    });
    this.setupConnectionHandlers(events);
  }

  /**
   * Configura los eventos del canal de datos abierto.
   */
  setupConnectionHandlers(events) {
    this.connection.on('open', () => {
      console.log('Canal de datos abierto.');
      // Enviar nombre de usuario como primer mensaje de control
      this.connection.send({
        type: 'username',
        payload: { username: this.localUsername }
      });
      // Iniciar keepalive para mantener la conexión activa
      this.startKeepalive();
    });

    this.connection.on('data', async (raw) => {
      let data = raw;

      // Normalizar Blob a ArrayBuffer
      if (raw instanceof Blob) {
        data = await raw.arrayBuffer();
      }

      // Detectar datos binarios (ArrayBuffer, Uint8Array, TypedArrays)
      // PeerJS con serialization:'binary' entrega Uint8Array, NO ArrayBuffer
      if (data && typeof data.byteLength === 'number' && data.byteLength > 0) {
        // Normalizar a ArrayBuffer
        if (!(data instanceof ArrayBuffer)) {
          const buf = data.buffer;
          data = buf.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }

        // Pequeño: podría ser un mensaje de control serializado como binario
        if (data.byteLength < 2048) {
          try {
            const text = new TextDecoder().decode(data);
            const parsed = JSON.parse(text);
            data = parsed;
          } catch {
            events.onDataReceived(data);
            return;
          }
        } else {
          events.onDataReceived(data);
          return;
        }
      }

      // Normalizar string JSON a objeto
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          events.onDataReceived(data);
          return;
        }
      }

      // Aquí data debería ser un objeto (mensaje de control)
      if (data && typeof data === 'object') {
        if (data.type === 'username') {
          this.peerUsername = data.payload.username;
          events.onPeerConnected(this.peerUsername);
        } else if (data.type === 'ping') {
          // Keepalive: ignora
        } else {
          events.onDataReceived(data);
        }
      } else {
        events.onDataReceived(data);
      }
    });

    this.connection.on('close', () => {
      console.log('Canal de datos cerrado.');
      this.stopKeepalive();
      events.onPeerDisconnected();
    });

    this.connection.on('error', (err) => {
      console.error('Error en canal de datos:', err);
      events.onError(err);
    });
  }

  /**
   * Envía datos (string JSON o ArrayBuffer) al par conectado.
   */
  send(data) {
    if (this.connection && this.connection.open) {
      this.connection.send(data);
      return true;
    }
    return false;
  }

  /**
   * Verifica si la conexión está activa y lista.
   */
  isConnected() {
    return this.connection && this.connection.open;
  }

  /**
   * Obtiene la conexión activa del canal de datos.
   */
  getActiveConnection() {
    return this.connection;
  }

  /**
   * Obtiene el nombre del par conectado.
   */
  getPeerUsername() {
    return this.peerUsername;
  }

  /**
   * Inicia el envío periódico de pings vía Web Worker.
   * El Worker no es frenado por el navegador aunque el tab esté en segundo plano
   * (ej. al abrir el selector de archivos en el celular).
   */
  startKeepalive() {
    this.stopKeepalive();

    // Si el Worker ya existe, reciclarlo
    if (!this._keepaliveWorker) {
      try {
        this._keepaliveWorker = new Worker('./js/keepalive-worker.js');
        this._keepaliveWorker.onmessage = () => {
          if (this.connection && this.connection.open) {
            this.connection.send({ type: 'ping' });
          } else {
            this.stopKeepalive();
          }
        };
      } catch (err) {
        // Fallback a setInterval si no soporta Workers
        console.warn('[Keepalive] Workers no soportado, usando setInterval:', err.message);
        this._keepaliveInterval = setInterval(() => {
          if (this.connection && this.connection.open) {
            this.connection.send({ type: 'ping' });
          } else {
            this.stopKeepalive();
          }
        }, 5000);
        return;
      }
    }

    this._keepaliveWorker.postMessage({ type: 'start', interval: 5000 });
  }

  /**
   * Detiene los pings de keepalive.
   */
  stopKeepalive() {
    if (this._keepaliveWorker) {
      this._keepaliveWorker.postMessage({ type: 'stop' });
    }
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  }

  /**
   * Desconecta de la sala de forma limpia.
   */
  disconnect() {
    this.stopKeepalive();
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    if (this._keepaliveWorker) {
      this._keepaliveWorker.terminate();
      this._keepaliveWorker = null;
    }
  }
}
