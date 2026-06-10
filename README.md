# QDrop

Transfiere archivos entre dispositivos al instante, sin cables, sin servidores, sin límites.

QDrop usa **WebRTC** (PeerJS) para conectar dos dispositivos directamente —同一 red local o remoto — y transferir archivos peer-to-peer a toda velocidad. No pasa por ningún servidor intermedio, no se almacena en la nube, no hay límite de tamaño.

## Cómo funciona

1. **Abrí QDrop** en ambos dispositivos
2. **Poné tu nombre** (solo para identificar la sesión)
3. **Uno crea una sala**, el otro se une escaneando el QR o copiando el ID
4. **Arrastrá un archivo** y se transfiere al instante

## Características

- **Transferencia P2P directa** — sin límite de tamaño, sin subida a servidores
- **QR instantáneo** — escaneá y conectate al toque
- **Velocidad local** — en la misma red WiFi, tan rápido como tu router permita
- **Wake Lock** — la pantalla no se apaga durante la transferencia
- **Conexión persistente** — keepalive + reconexión automática
- **PWA** — instalable en el celular como una app nativa

## Probar

### Opción 1 — GitHub Pages (recomendada)

Click Here

### Opción 2 — Live Server (desarrollo)

```bash
# Cloná el repo
git clone https://github.com/tu-usuario/qdrop.git
cd qdrop

# Abrí index.html con Live Server (VS Code) o cualquier servidor estático
npx serve .
```

Abrí en tu PC y en tu celular (misma red WiFi) y conectate escaneando el QR o copiando el ID.

## Development

El proyecto usa JavaScript directamente (sin build step). Si querés modificar los archivos fuente en `src/`, compilalos a `js/` con:

```bash
npx tsc
```

## Licencia

MIT
