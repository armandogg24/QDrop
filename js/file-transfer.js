export class FileTransferManager {
  static CHUNK_SIZE = 262144; // 256 KB (16x más grande que antes)
  static SUPER_CHUNK_SIZE = 1048576; // 1 MB - lee del archivo en bloques grandes
  static BUFFER_THRESHOLD = 64 * 1024 * 1024; // 64 MB (antes 8 MB)
  static BUFFER_RESUME = 4 * 1024 * 1024; // 4 MB (antes 64 KB)

  /**
   * Envía un archivo con chunks grandes y lectura eficiente en super-bloques.
   * Los metadatos van por PeerJS, los chunks van por `peerConnection.send()`.
   */
  static async sendFile(file, peerConnection, onProgress) {
    const fileId = Math.random().toString(36).substring(2, 11);

    // 1. Enviar metadatos del archivo como objeto (PeerJS lo serializa correctamente)
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

    // Pausa mínima para que el receptor procese metadatos
    await new Promise(r => setTimeout(r, 10));

    let bytesSent = 0;
    const startTime = performance.now();
    const dc = peerConnection._dc || peerConnection.dataChannel;
    let fileOffset = 0;

    while (fileOffset < file.size) {
      // Leer un super-bloque de 1MB del archivo (reduces FileReader calls 64x)
      const superSize = Math.min(this.SUPER_CHUNK_SIZE, file.size - fileOffset);
      const superBlob = file.slice(fileOffset, fileOffset + superSize);
      fileOffset += superSize;

      const superBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(superBlob);
      });

      // Dividir el super-bloque en chunks de envío (sin más FileReader)
      let chunkOffset = 0;
      while (chunkOffset < superBuffer.byteLength) {
        // Buffer control con umbrales relajados para red local
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

    // Señal de fin de archivo
    peerConnection.send({ type: 'file-end', payload: { fileId } });
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
