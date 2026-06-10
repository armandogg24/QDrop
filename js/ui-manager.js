export class UIManager {
  /**
   * Oculta todas las secciones y muestra únicamente la seleccionada con animación.
   */
  static showScreen(screenId) {
    const screens = ['login-screen', 'lobby-screen', 'room-screen', 'transfer-screen', 'error-screen'];
    screens.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === screenId) {
        el.classList.remove('hidden');
        // Forzar reflow para que la animación se dispare correctamente
        void el.offsetWidth;
        el.classList.add('fade-in');
      } else {
        el.classList.add('hidden');
        el.classList.remove('fade-in');
      }
    });
  }

  /**
   * Genera el código QR usando la librería QRious (cargada vía CDN).
   */
  static generateQRCode(canvasId, value) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof QRious === 'undefined') {
      console.warn('[UIManager] QRious no disponible o canvas no encontrado.');
      return;
    }
    new QRious({
      element: canvas,
      value: value,
      size: 200,
      background: '#ffffff',
      foreground: '#0b0f19',
      level: 'H'
    });
  }

  /**
   * Muestra un banner flotante de notificación temporal con autocierre.
   */
  static showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const notif = document.createElement('div');
    notif.className = `notification notification-${type} slide-up`;

    const icon = { success: '✅', info: 'ℹ️', error: '❌' }[type] ?? 'ℹ️';
    notif.innerHTML = `<span class="notif-icon">${icon}</span><span class="notif-msg">${message}</span>`;

    container.appendChild(notif);

    setTimeout(() => {
      notif.style.opacity = '0';
      notif.style.transform = 'translateY(10px)';
      notif.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
      setTimeout(() => notif.remove(), 400);
    }, 3500);
  }

  /**
   * Actualiza la barra de progreso activa durante una transferencia.
   */
  static updateProgressBar(percent, fileName, speedMbps, isIncoming) {
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const fileInfoText = document.getElementById('progress-file-info');
    const speedText = document.getElementById('progress-speed');

    if (!progressContainer) return;

    progressContainer.classList.remove('hidden');

    const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
    if (progressBar) progressBar.style.width = `${safePercent}%`;
    if (progressText) progressText.textContent = `${safePercent}%`;

    if (fileInfoText) {
      const direction = isIncoming ? '⬇ Recibiendo' : '⬆ Enviando';
      const shortName = fileName.length > 30 ? fileName.substring(0, 27) + '...' : fileName;
      fileInfoText.textContent = `${direction}: ${shortName}`;
    }

    if (speedText) {
      speedText.textContent = speedMbps >= 1
        ? `${speedMbps.toFixed(1)} Mbps`
        : `${(speedMbps * 1024).toFixed(0)} Kbps`;
    }
  }

  /**
   * Oculta el contenedor de progreso y lo resetea al 0%.
   */
  static hideProgressBar() {
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    if (progressContainer) progressContainer.classList.add('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = '0%';
  }

  /**
   * Añade un archivo completado al historial visible de la sala.
   */
  static appendCompletedTransfer(fileName, fileSize, blob, isIncoming) {
    const list = document.getElementById('completed-transfers-list');
    if (!list) return;

    // Eliminar el mensaje de "lista vacía" si existe
    const emptyState = document.getElementById('empty-state-text');
    if (emptyState) emptyState.remove();

    const item = document.createElement('div');
    item.className = 'completed-transfer-item fade-in';

    const sizeStr = this.formatBytes(fileSize);
    const directionIcon = isIncoming ? '⬇️' : '⬆️';
    const directionText = isIncoming ? 'Recibido' : 'Enviado';

    let actionHtml;
    if (isIncoming && blob) {
      const url = URL.createObjectURL(blob);
      // Sanitizar el nombre del archivo para usarlo como atributo download
      const safeName = fileName.replace(/[^\w.\-]/g, '_');
      actionHtml = `<a href="${url}" download="${safeName}" class="btn btn-small btn-success">Guardar</a>`;
    } else {
      actionHtml = `<span class="badge badge-success">Enviado</span>`;
    }

    item.innerHTML = `
      <div class="transfer-info">
        <span class="transfer-icon">${directionIcon}</span>
        <div class="transfer-details">
          <div class="transfer-name" title="${fileName}">${fileName}</div>
          <div class="transfer-meta">${directionText} · ${sizeStr}</div>
        </div>
      </div>
      <div class="transfer-action">${actionHtml}</div>
    `;

    // Insertar al principio para mostrar los más recientes primero
    list.insertBefore(item, list.firstChild);
  }

  /**
   * Muestra u oculta el overlay del escáner QR.
   */
  static toggleScanner(show) {
    const overlay = document.getElementById('scanner-overlay');
    if (!overlay) return;
    overlay.classList.toggle('hidden', !show);
  }

  /**
   * Formatea bytes en unidades legibles (Bytes → KB → MB → GB).
   */
  static formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
