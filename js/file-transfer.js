export class FileTransferManager {
  static CHUNK_SIZE = 262144; // 256 KB (16x más grande que antes)
  static SUPER_CHUNK_SIZE = 1048576; // 1 MB - lee del archivo en bloques grandes
  static BUFFER_THRESHOLD = 64 * 1024 * 1024; // 64 MB (antes 8 MB)
  static BUFFER_RESUME = 4 * 1024 * 1024; // 4 MB (antes 64 KB)

  /**
   * Envía un archivo con chunks grandes y lectura eficiente en super-bloques.
   * Espera a que el buffer de envío se drene completamente antes de señalar
   * el fin de archivo, y luego espera confirmación (ACK) del receptor.
   *
   * @param {File} file - Archivo a enviar
   * @param {Object} peerConnection - Conexión PeerJS activa
   * @param {Function} onProgress - Callback (bytesSent, totalBytes, speedMbps)
   * @param {Function} waitForAck - Callback que retorna una Promise que se resuelve al recibir file-ack
   */
  static async sendFile(file, peerConnection, onProgress, waitForAck) {
    const fileId = Math.random().toString(36).substring(2, 11);

    peerConnection.send({
      type: 'file-meta',
      payload: {
        fileId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        totalChunks: Math.ceil(file.size / this.CHUNK_SIZE)
      }
    });

    await new Promise(r => setTimeout(r, 10));

    let bytesSent = 0;
    const startTime = performance.now();
    const dc = peerConnection._dc || peerConnection.dataChannel;
    let fileOffset = 0;

    while (fileOffset < file.size) {
      const superSize = Math.min(this.SUPER_CHUNK_SIZE, file.size - fileOffset);
      const superBlob = file.slice(fileOffset, fileOffset + superSize);
      fileOffset += superSize;

      const superBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(superBlob);
      });

      let chunkOffset = 0;
      while (chunkOffset < superBuffer.byteLength) {
        if (dc && dc.bufferedAmount > this.BUFFER_THRESHOLD) {
          await this.waitForBufferDrain(dc);
        }

        const end = Math.min(chunkOffset + this.CHUNK_SIZE, superBuffer.byteLength);
        const chunk = superBuffer.slice(chunkOffset, end);
        chunkOffset += this.CHUNK_SIZE;

        peerConnection.send(chunk);

        bytesSent += chunk.byteLength;

        const elapsedSeconds = (performance.now() - startTime) / 1000;
        const speedMbps = elapsedSeconds > 0
          ? (bytesSent * 8) / (1024 * 1024 * elapsedSeconds)
          : 0;

        onProgress(bytesSent, file.size, speedMbps);
      }
    }

    // Esperar a que el buffer de envío se drene por completo
    if (dc) {
      await this.waitForBufferEmpty(dc);
    }

    // Señal de fin de archivo
    peerConnection.send({ type: 'file-end', payload: { fileId } });

    // Esperar confirmación del receptor
    if (waitForAck) {
      await waitForAck();
    }
  }

  /**
   * Espera a que el buffer de envío esté completamente vacío.
   */
  static waitForBufferEmpty(dc) {
    return new Promise((resolve) => {
      const check = () => {
        if (!dc || dc.bufferedAmount === 0) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      if (dc.bufferedAmountLowThreshold !== undefined) {
        dc.bufferedAmountLowThreshold = 0;
        dc.onbufferedamountlow = () => {
          dc.onbufferedamountlow = null;
          resolve();
        };
        setTimeout(check, 50);
      } else {
        setTimeout(check, 10);
      }
    });
  }

  /**
   * Espera a que el buffer de envío se drene antes de continuar.
   */
  static waitForBufferDrain(dc) {
    return new Promise((resolve) => {
      const check = () => {
        if (!dc || dc.bufferedAmount <= this.BUFFER_RESUME) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      if (dc.bufferedAmountLowThreshold !== undefined) {
        dc.bufferedAmountLowThreshold = this.BUFFER_RESUME;
        dc.onbufferedamountlow = () => {
          dc.onbufferedamountlow = null;
          resolve();
        };
        setTimeout(check, 50);
      } else {
        setTimeout(check, 10);
      }
    });
  }

  constructor() {
    this.receivedBuffers = [];
    this.receivedBytes = 0;
    this.currentMeta = null;
    this.receiveStartTime = 0;
  }

  /**
   * Inicializa la recepción de un archivo con sus metadatos.
   */
  startReceiving(meta) {
    this.currentMeta = meta;
    this.receivedBuffers = [];
    this.receivedBytes = 0;
    this.receiveStartTime = performance.now();
  }

  /**
   * Procesa un fragmento binario recibido y verifica si la transferencia completó.
   */
  appendChunk(chunk, onProgress) {
    if (!this.currentMeta) {
      return { complete: false };
    }

    this.receivedBuffers.push(chunk);
    this.receivedBytes += chunk.byteLength;

    const elapsedSeconds = (performance.now() - this.receiveStartTime) / 1000;
    const speedMbps = elapsedSeconds > 0
      ? (this.receivedBytes * 8) / (1024 * 1024 * elapsedSeconds)
      : 0;

    onProgress(this.receivedBytes, this.currentMeta.fileSize, speedMbps);

    if (this.receivedBytes >= this.currentMeta.fileSize) {
      const blob = new Blob(this.receivedBuffers, { type: this.currentMeta.fileType });
      const completedMeta = this.currentMeta;

      // Limpiar estado
      this.currentMeta = null;
      this.receivedBuffers = [];
      this.receivedBytes = 0;

      return { complete: true, blob, meta: completedMeta };
    }

    return { complete: false };
  }
}
