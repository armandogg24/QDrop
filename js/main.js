import { PeerManager } from './peer-manager.js';
import { FileTransferManager } from './file-transfer.js';
import { UIManager } from './ui-manager.js';

class QDropApp {
  constructor() {
    this.peerManager = null;
    this.fileTransferManager = new FileTransferManager();
    this.localUsername = '';
    this.wakeLock = null;
    this.roomId = null;
    this._isSending = false;
    this._scannerStream = null;
    this._scanning = false;
    this._hasActiveTransfer = false;
    this._wakeLockListenerAdded = false;
    this._pendingRoomId = null;
    this._installPrompt = null;
    this._focusHandler = null;
    this._visibilityHandler = null;
    this._ackResolve = null;
  }

  start() {
    this.registerServiceWorker();
    this.setupInstallBanner();
    // IMPORTANTE: registrar listeners PRIMERO, luego verificar sesión
    this.setupUIEventListeners();
    this.checkSessionAndInit();
  }

  /* -----------------------------------------------------------------------
     PWA: Service Worker
  ----------------------------------------------------------------------- */
  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then((reg) => console.log('[SW] Registrado:', reg.scope))
          .catch((err) => console.warn('[SW] Error:', err));
      });
    }
  }

  /* -----------------------------------------------------------------------
     PWA: Banner de instalación
  ----------------------------------------------------------------------- */
  setupInstallBanner() {
    // No mostrar si ya está instalada (standalone o iOS fullscreen)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || ('standalone' in navigator && navigator.standalone);
    if (isStandalone) return;

    // No mostrar si ya fue descartada en esta sesión
    if (sessionStorage.getItem('qdrop_install_dismissed')) return;

    const banner = document.getElementById('install-banner');
    const installBtn = document.getElementById('install-btn');
    const dismissBtn = document.getElementById('install-dismiss-btn');
    if (!banner) return;

    // iOS: no hay beforeinstallprompt, mostrar con instrucciones
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone;
    if (isIOS) {
      const textEl = banner.querySelector('.install-text span');
      if (textEl) textEl.textContent = 'Toca Compartir > Agregar a Pantalla de Inicio';
      banner.classList.remove('hidden');
      dismissBtn?.addEventListener('click', () => {
        banner.classList.add('hidden');
        sessionStorage.setItem('qdrop_install_dismissed', '1');
      });
      return;
    }

    // Android Chrome: escuchar beforeinstallprompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this._installPrompt = e;
      banner.classList.remove('hidden');
    });

    installBtn?.addEventListener('click', async () => {
      if (!this._installPrompt) return;
      this._installPrompt.prompt();
      const result = await this._installPrompt.userChoice;
      if (result.outcome === 'accepted') {
        banner.classList.add('hidden');
        this._installPrompt = null;
      }
    });

    dismissBtn?.addEventListener('click', () => {
      banner.classList.add('hidden');
      sessionStorage.setItem('qdrop_install_dismissed', '1');
    });
  }

  /* -----------------------------------------------------------------------
     Sesión de alias con persistencia de 24h en localStorage
  ----------------------------------------------------------------------- */
  checkSessionAndInit() {
    // Guardar roomId de la URL si existe (para auto-completar en lobby)
    const urlParams = new URLSearchParams(window.location.search);
    this._pendingRoomId = urlParams.get('room');

    const sessionData = localStorage.getItem('qdrop_user');
    if (sessionData) {
      try {
        const session = JSON.parse(sessionData);
        if (Date.now() < session.expiresAt) {
          this.localUsername = session.username;
          session.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
          localStorage.setItem('qdrop_user', JSON.stringify(session));

          // Si hay sala pendiente (vía QR o URL), unirse directamente
          if (this._pendingRoomId) {
            this.roomId = this._pendingRoomId;
            this._pendingRoomId = null;
            this.initializePeer();
            return;
          }

          // Sesión vigente sin sala → ir al lobby
          UIManager.showScreen('lobby-screen');
          this._autoShowJoinSection();
          return;
        } else {
          localStorage.removeItem('qdrop_user');
        }
      } catch {
        localStorage.removeItem('qdrop_user');
      }
    }

    UIManager.showScreen('login-screen');
  }

  /* -----------------------------------------------------------------------
     Eventos de UI (se registran una sola vez al iniciar)
  ----------------------------------------------------------------------- */
  setupUIEventListeners() {
    /* --- Formulario de login / alias --- */
    document.getElementById('login-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('username-input');
      const name = input?.value.trim();
      if (!name) return;

      this.localUsername = name;
      localStorage.setItem('qdrop_user', JSON.stringify({
        username: name,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
      }));

      // Ir al lobby en lugar de iniciar peer directamente
      UIManager.showScreen('lobby-screen');
      this._autoShowJoinSection();
    });

    /* --- Copiar enlace de invitación --- */
    document.getElementById('copy-link-btn')?.addEventListener('click', () => {
      const linkInput = document.getElementById('invite-link-input');
      if (!linkInput) return;
      const url = linkInput.value;
      if (navigator.clipboard && url) {
        navigator.clipboard.writeText(url)
          .then(() => UIManager.showNotification('¡Enlace copiado al portapapeles!', 'success'))
          .catch(() => {
            linkInput.select();
            UIManager.showNotification('Selecciona el enlace y cópialo manualmente.', 'info');
          });
      }
    });

    /* --- Zona de drag & drop --- */
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    dropZone?.addEventListener('click', (e) => {
      // Evitar que el click en el input dispare el evento dos veces
      if (e.target !== fileInput) fileInput?.click();
    });

    dropZone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone?.addEventListener('dragleave', (e) => {
      // Solo quitar la clase si el mouse salió del dropzone (no de un hijo)
      if (!dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('drag-over');
      }
    });

    dropZone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (files?.length > 0) this.handleFileSelected(files[0]);
    });

    fileInput?.addEventListener('change', () => {
      const files = fileInput.files;
      if (files?.length > 0) this.handleFileSelected(files[0]);
    });

    /* --- Salir de la sala --- */
    document.getElementById('leave-room-btn')?.addEventListener('click', () => {
      this.peerManager?.disconnect();
      // NO borrar la sesión de alias al salir: el usuario puede volver sin reintroducir su nombre
      window.location.href = window.location.pathname;
    });

    /* --- Botón de reintento en pantalla de error --- */
    document.getElementById('retry-btn')?.addEventListener('click', () => {
      window.location.href = window.location.pathname;
    });

    /* --- Advertencia al cerrar con transferencia activa --- */
    window.addEventListener('beforeunload', (e) => {
      if (this._hasActiveTransfer) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    /* --- Lobby: Crear sala --- */
    document.getElementById('create-room-btn')?.addEventListener('click', () => {
      this.roomId = null;
      this.initializePeer();
    });

    /* --- Lobby: Toggle unirse --- */
    document.getElementById('toggle-join-btn')?.addEventListener('click', () => {
      const group = document.getElementById('join-input-group');
      if (group) {
        group.classList.toggle('hidden');
        const input = document.getElementById('room-id-input');
        if (!group.classList.contains('hidden') && this._pendingRoomId) {
          if (input) input.value = this._pendingRoomId;
          this._pendingRoomId = null;
        }
        if (!group.classList.contains('hidden') && input) input.focus();
      }
    });

    /* --- Lobby: Unirse a sala --- */
    document.getElementById('join-room-btn')?.addEventListener('click', () => {
      const input = document.getElementById('room-id-input');
      const id = input?.value.trim().toUpperCase();
      if (!id || id.length < 3) {
        UIManager.showNotification('Ingresa un ID de sala válido (mín. 3 caracteres)', 'error');
        return;
      }
      this.roomId = id;
      this.initializePeer();
    });

    /* --- Lobby: Escanear QR --- */
    document.getElementById('lobby-scan-qr-btn')?.addEventListener('click', () => {
      this.startQRScanner();
    });

    /* --- Mostrar advertencia de IP local --- */
    this.showLocalIPNotice();

    /* --- Escáner QR (login screen) --- */
    document.getElementById('scan-qr-btn')?.addEventListener('click', () => {
      this.startQRScanner();
    });

    document.getElementById('scanner-close-btn')?.addEventListener('click', () => {
      this.stopQRScanner();
    });

    document.getElementById('scanner-cancel-btn')?.addEventListener('click', () => {
      this.stopQRScanner();
    });
  }

  /* -----------------------------------------------------------------------
     Inicialización de WebRTC / PeerJS
  ----------------------------------------------------------------------- */
  initializePeer() {
    UIManager.showScreen('room-screen');
    const statusText = document.getElementById('room-status-text');
    if (statusText) statusText.textContent = 'Inicializando red P2P...';

    this.peerManager = new PeerManager(this.localUsername);
    this.peerManager.initialize(this.roomId, {

      onLocalIdReady: (roomId, isHost) => {
        const inviteSection = document.getElementById('invite-section');
        const linkInput = document.getElementById('invite-link-input');

        if (isHost) {
          const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
          if (linkInput) linkInput.value = inviteUrl;
          UIManager.generateQRCode('invite-qr-canvas', inviteUrl);
          if (statusText) statusText.textContent = `Sala #${roomId} • Esperando que alguien se conecte...`;
          inviteSection?.classList.remove('hidden');
        } else {
          if (statusText) statusText.textContent = `Uniéndose a la sala #${roomId}...`;
          inviteSection?.classList.add('hidden');
        }
      },

      onPeerConnected: (peerId, peerUsername) => {
        UIManager.showScreen('transfer-screen');
        UIManager.showNotification(`¡Conectado con ${peerUsername}!`, 'success');
        this.peerManager?.startKeepalive();
        this.requestWakeLock();
        this.requestNotificationPermission();
        this._setupConnectionKeepalive();
        this._updatePeerList();
      },

      onPeerDisconnected: (peerId) => {
        this._updatePeerList();
        if (this.peerManager?.isConnected()) {
          UIManager.showNotification('Un usuario se desconectó.', 'info');
        } else {
          this.peerManager?.stopKeepalive();
          this.setTransferActive(false);
          this._removeConnectionKeepalive();
          this.releaseWakeLock();
          UIManager.showNotification('No quedan usuarios conectados. Volviendo al inicio...', 'info');
          setTimeout(() => {
            window.location.href = window.location.pathname;
          }, 3000);
        }
      },

      onDataReceived: (data, peerId) => {
        this.handleDataReceived(data, peerId);
      },

      onPeersUpdated: () => {
        this._updatePeerList();
      },

      onError: (err) => {
        console.error('[QDrop] Error:', err);
        const errorMsg = document.getElementById('error-message');
        if (errorMsg) {
          errorMsg.textContent = this.friendlyError(err);
        }
        UIManager.showScreen('error-screen');
        this.releaseWakeLock();
      }
    });
  }

  /* -----------------------------------------------------------------------
     Envío de archivos
  ----------------------------------------------------------------------- */
  async handleFileSelected(file) {
    if (this._isSending) {
      UIManager.showNotification('Ya hay una transferencia en curso. Espera a que termine.', 'info');
      return;
    }
    const peers = this.peerManager?.getPeers() || [];
    if (peers.length === 0) {
      UIManager.showNotification('No hay ninguna conexión activa.', 'error');
      return;
    }

    const dropZone = document.getElementById('drop-zone');
    this._isSending = true;
    this.setTransferActive(true);
    if (dropZone) dropZone.style.pointerEvents = 'none';

    try {
      UIManager.updateProgressBar(0, file.name, 0, false);

      // Enviar a todos los peers conectados (broadcast)
      this._ackResolve = null;
      const ackPromises = [];

      for (const peer of peers) {
        const conn = this.peerManager.getConnection(peer.peerId);
        if (!conn) continue;

        const ackPromise = new Promise((resolve) => {
          this._ackResolve = resolve; // Se resuelve al recibir cada file-ack
        });
        ackPromises.push(ackPromise);

        await FileTransferManager.sendFile(file, conn, (bytesSent, totalBytes, speedMbps) => {
          const percent = (bytesSent / totalBytes) * 100;
          UIManager.updateProgressBar(percent, file.name, speedMbps, false);
        }, () => ackPromise);
      }

      UIManager.showNotification('¡Archivo enviado con éxito!', 'success');
      UIManager.appendCompletedTransfer(file.name, file.size, null, false);
    } catch (err) {
      console.error('[QDrop] Error enviando archivo:', err);
      UIManager.showNotification('Error al enviar el archivo. Revisa la conexión.', 'error');
    } finally {
      UIManager.hideProgressBar();
      this._isSending = false;
      this.setTransferActive(false);
      if (dropZone) dropZone.style.pointerEvents = 'auto';
      const fileInput = document.getElementById('file-input');
      if (fileInput) fileInput.value = '';
    }
  }

  /* -----------------------------------------------------------------------
     Recepción de datos (binarios de control y chunks de archivos)
  ----------------------------------------------------------------------- */
  handleDataReceived(data, peerId) {
    if (data instanceof ArrayBuffer) {
      const result = this.fileTransferManager.appendChunk(data, (bytesRx, totalBytes, speedMbps) => {
        const percent = (bytesRx / totalBytes) * 100;
        const name = this.fileTransferManager.currentMeta?.fileName ?? 'Archivo';
        UIManager.updateProgressBar(percent, name, speedMbps, true);
      });

      if (result.complete && result.blob && result.meta) {
        UIManager.hideProgressBar();
        UIManager.showNotification(`Archivo "${result.meta.fileName}" recibido`, 'success');
        UIManager.appendCompletedTransfer(result.meta.fileName, result.meta.fileSize, result.blob, true);
        this.triggerHapticAndNotification(result.meta.fileName);
        this.setTransferActive(false);

        // Enviar ACK al remitente específico
        if (peerId) {
          this.peerManager?.sendTo(peerId, { type: 'file-ack', payload: { fileId: result.meta.fileId } });
        }
      }
      return;
    }

    if (data && typeof data === 'object') {
      if (data.type === 'file-meta') {
        this.fileTransferManager.startReceiving(data.payload);
        UIManager.updateProgressBar(0, data.payload.fileName, 0, true);
        this.setTransferActive(true);
      } else if (data.type === 'file-ack') {
        if (this._ackResolve) {
          this._ackResolve();
          this._ackResolve = null;
        }
      }
    }
  }

  /* -----------------------------------------------------------------------
     Vibración y notificación del sistema al recibir un archivo
  ----------------------------------------------------------------------- */
  triggerHapticAndNotification(fileName) {
    if ('vibrate' in navigator) {
      navigator.vibrate([200, 100, 200]);
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('QDrop – Archivo recibido', {
        body: `"${fileName}" está listo para guardar.`,
        icon: './assets/icons/icon.svg'
      });
    }
  }

  requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  /* -----------------------------------------------------------------------
     Wake Lock (pantalla activa durante transferencias)
  ----------------------------------------------------------------------- */
  async requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      console.log('[WakeLock] Activo.');

      if (!this._wakeLockListenerAdded) {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && this._hasActiveTransfer) {
            // El Wake Lock se libera automáticamente al ocultar la página
            this.wakeLock = null;
            this.requestWakeLock();
          }
        });
        this._wakeLockListenerAdded = true;
      }
    } catch (err) {
      console.warn('[WakeLock] No disponible:', err.message);
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().then(() => {
        console.log('[WakeLock] Liberado.');
        this.wakeLock = null;
      }).catch(() => {
        this.wakeLock = null;
      });
    }
  }

  setTransferActive(active) {
    this._hasActiveTransfer = active;
    if (active) {
      this.requestWakeLock();
    }
    // No liberar wake lock aquí — se libera al desconectar
  }

  /**
   * Agrega handlers para mantener la conexión viva incluso cuando
   * el usuario abre el selector de archivos (que puede backgroundear el tab).
   */
  _setupConnectionKeepalive() {
    this._removeConnectionKeepalive();

    this._focusHandler = () => {
      if (!this.peerManager?.isConnected()) {
        console.warn('[Keepalive] Conexión perdida al recuperar foco. Re-estableciendo...');
        window.location.reload();
      }
    };

    this._visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        // Enviar ráfaga de pings al volver para refrescar ICE
        if (this.peerManager?.isConnected()) {
          const conn = this.peerManager.getActiveConnection();
          for (let i = 0; i < 3; i++) {
            conn.send({ type: 'ping' });
          }
        }
      }
    };

    window.addEventListener('focus', this._focusHandler);
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  _removeConnectionKeepalive() {
    if (this._focusHandler) {
      window.removeEventListener('focus', this._focusHandler);
      this._focusHandler = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
  }

  _updatePeerList() {
    const container = document.getElementById('peer-list-container');
    if (!container) return;

    const myLabel = document.getElementById('my-name-label');
    if (myLabel) myLabel.textContent = `${this.localUsername} (Tú)`;

    const peers = this.peerManager?.getPeers() || [];

    // Limpiar peers anteriores (mantener solo el template)
    let template = document.getElementById('peer-template');
    if (!template) {
      template = container.querySelector('.peer-user');
    }
    container.querySelectorAll('.peer-user:not(.me)').forEach(el => {
      if (el.id !== 'peer-template') el.remove();
    });

    if (peers.length === 0) {
      // Mostrar "Esperando peers..." o dejar la plantilla oculta
      return;
    }

    for (const peer of peers) {
      // Verificar si ya existe
      if (container.querySelector(`[data-peer-id="${peer.peerId}"]`)) continue;

      const el = document.createElement('div');
      el.className = 'peer-user';
      el.dataset.peerId = peer.peerId;
      el.innerHTML = `
        <div class="user-avatar">📱</div>
        <div class="user-name">${peer.username}</div>
      `;
      container.appendChild(el);
    }
  }

  /* -----------------------------------------------------------------------
     Auto-mostrar sección de unirse si hay roomId pendiente
  ----------------------------------------------------------------------- */
  _autoShowJoinSection() {
    if (this._pendingRoomId) {
      const group = document.getElementById('join-input-group');
      const input = document.getElementById('room-id-input');
      if (group && input) {
        group.classList.remove('hidden');
        input.value = this._pendingRoomId;
        this._pendingRoomId = null;
      }
    }
  }

  /* -----------------------------------------------------------------------
     Detección de IP local para redes locales
  ----------------------------------------------------------------------- */
  showLocalIPNotice() {
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      // Intentar detectar IP local
      this._detectLocalIP().then((ip) => {
        if (ip && ip !== hostname) {
          const port = window.location.port || '80';
          const correctOrigin = `http://${ip}:${port}`;
          // Mostrar noticia
          const notice = document.createElement('div');
          notice.className = 'local-ip-notice';
          notice.innerHTML = `💡 <strong>Conecta desde otro dispositivo:</strong><br>
            Usa esta URL: <code>${correctOrigin}${window.location.pathname}</code>`;
          const inviteBox = document.querySelector('.invite-box');
          if (inviteBox) inviteBox.prepend(notice);
          // Corregir el link de invitación si ya está generado
          const linkInput = document.getElementById('invite-link-input');
          if (linkInput && linkInput.value.includes('localhost')) {
            linkInput.value = linkInput.value.replace(/http:\/\/localhost(:\d+)?/, correctOrigin);
          }
        }
      });
    }
  }

  async _detectLocalIP() {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      return new Promise((resolve) => {
        pc.onicecandidate = (ice) => {
          if (!ice.candidate) {
            pc.close();
            resolve(null);
            return;
          }
          const match = /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/.exec(ice.candidate.candidate);
          if (match) {
            const ip = match[1];
            if (!ip.startsWith('0.') && !ip.startsWith('127.')) {
              pc.close();
              resolve(ip);
            }
          }
        };
        setTimeout(() => { pc.close(); resolve(null); }, 3000);
      });
    } catch {
      return null;
    }
  }

  /* -----------------------------------------------------------------------
     Escáner QR integrado con cámara + jsQR
  ----------------------------------------------------------------------- */
  startQRScanner() {
    this._scannerStream = null;
    this._scanning = true;
    UIManager.toggleScanner(true);

    const video = document.getElementById('scanner-video');
    const canvas = document.getElementById('scanner-canvas');
    const hint = document.getElementById('scanner-hint');

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: 320, height: 320 }
    }).then((stream) => {
      this._scannerStream = stream;
      video.srcObject = stream;
      video.play();

      const ctx = canvas.getContext('2d');
      const scanLoop = () => {
        if (!this._scanning) return;

        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

          if (typeof jsQR !== 'undefined') {
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert'
            });

            if (code) {
              try {
                const url = new URL(code.data);
                const room = url.searchParams.get('room');
                if (room) {
                  if (hint) hint.textContent = '✅ ¡Código detectado!';
                  if ('vibrate' in navigator) navigator.vibrate(50);
                  this.stopQRScanner();
                  if (this.localUsername) {
                    // Ya logueado: unirse directamente a la sala
                    this.roomId = room;
                    this.initializePeer();
                  } else {
                    // Sin sesión: ir al login con la sala en la URL
                    window.location.href = url.pathname + '?room=' + room;
                  }
                  return;
                } else {
                  if (hint) hint.textContent = '⚠️ Este QR no es de una sala QDrop';
                }
              } catch {
                if (hint) hint.textContent = '⚠️ QR inválido. Escanea el código de la sala.';
              }
            }
          }
        }

        if (this._scanning) {
          requestAnimationFrame(scanLoop);
        }
      };

      scanLoop();
    }).catch((err) => {
      console.warn('[QR] Error accediendo a la cámara:', err.message);
      if (hint) hint.textContent = '❌ No se pudo acceder a la cámara. Revisa los permisos.';
    });
  }

  stopQRScanner() {
    this._scanning = false;
    if (this._scannerStream) {
      this._scannerStream.getTracks().forEach(t => t.stop());
      this._scannerStream = null;
    }
    const video = document.getElementById('scanner-video');
    if (video) video.srcObject = null;
    UIManager.toggleScanner(false);
  }

  /* -----------------------------------------------------------------------
     Mensajes de error amigables según el tipo de error de PeerJS
  ----------------------------------------------------------------------- */
  friendlyError(err) {
    const type = err?.type ?? '';
    const messages = {
      'peer-unavailable': 'La sala no existe o el otro dispositivo ya no está disponible.',
      'network': 'Error de red. Comprueba tu conexión a internet.',
      'server-error': 'El servidor de señalización no responde. Intenta de nuevo.',
      'unavailable-id': 'El ID de sala ya está en uso. Recarga la página.',
      'browser-incompatible': 'Tu navegador no soporta WebRTC. Usa Chrome, Edge o Firefox actualizados.'
    };
    return messages[type] ?? (err?.message ?? 'Error desconocido. Intenta recargar la página.');
  }
}

/* -------------------------------------------------------------------------
   Punto de entrada
------------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  const app = new QDropApp();
  app.start();
});
