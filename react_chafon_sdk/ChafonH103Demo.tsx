import React, { useState } from 'react';
import { useChafonH103 } from './useChafonH103';
import { ChafonH103Protocol } from './ChafonH103Protocol';

export const ChafonH103Demo: React.FC = () => {
  const {
    isConnected,
    isScanning,
    batteryLevel,
    scannedDevices,
    tags,
    singleTag,
    lastBarcode,
    keyState,
    readMode,
    error,
    startScan,
    connect,
    disconnect,
    getBatteryLevel,
    setReadMode,
    startInventory,
    stopInventory,
    readSingleTag,
    startRadarMasked,
    stopRadar,
    startBarcodeScan,
    stopBarcodeScan,
    clearTags,
    clearBarcode,
  } = useChafonH103();

  const [modelCode, setModelCode] = useState<string>('1234');
  const [colorCode, setColorCode] = useState<number>(1);
  const [sizeCode, setSizeCode] = useState<number>(2);

  const handleSearchByModel = async () => {
    try {
      const articleHex = ChafonH103Protocol.encodeModelArticleHex(modelCode);
      const companyHex = '008100';
      const mask = `${companyHex}${articleHex}`;
      await startRadarMasked(0, mask.length / 2, mask);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleSearchByColorAndSize = async () => {
    try {
      const articleHex = ChafonH103Protocol.encodeModelArticleHex(modelCode);
      const colorHex = ChafonH103Protocol.encodeRfidCodeHex(colorCode, 3, 'color');
      const sizeHex = ChafonH103Protocol.encodeRfidCodeHex(sizeCode, 3, 'size');
      const companyHex = '008100';
      const mask = `${companyHex}${articleHex}${colorHex}${sizeHex}`;
      await startRadarMasked(0, mask.length / 2, mask);
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div style={{ padding: 20, fontFamily: 'sans-serif', maxWidth: 800, margin: '0 auto' }}>
      <h2>Chafon CF-H103 RFID / Barcode Terminal - React Integration</h2>

      {/* Connection & Battery Status Bar */}
      <div
        style={{
          padding: 12,
          borderRadius: 8,
          backgroundColor: isConnected ? '#e6fffa' : '#fff5f5',
          border: `1px solid ${isConnected ? '#319795' : '#e53e3e'}`,
          marginBottom: 16,
        }}
      >
        <strong>Estado Conexión:</strong> {isConnected ? 'CONECTADO 🟢' : 'DESCONECTADO 🔴'}
        {batteryLevel !== null && <span style={{ marginLeft: 20 }}>🔋 Batería: {batteryLevel}%</span>}
        {keyState && (
          <span style={{ marginLeft: 20 }}>
            🔘 Gatillo: {keyState.state === 'start' ? 'PRESIONADO' : 'LIBERADO'}
          </span>
        )}
      </div>

      {error && (
        <div style={{ padding: 10, backgroundColor: '#fed7d7', color: '#9b2c2c', borderRadius: 6, marginBottom: 16 }}>
          ⚠️ Error: {error}
        </div>
      )}

      {/* Control Buttons */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {!isConnected ? (
          <>
            <button onClick={startScan} disabled={isScanning}>
              {isScanning ? 'Escaneando BLE...' : 'Buscar Terminal Chafon'}
            </button>
          </>
        ) : (
          <>
            <button onClick={disconnect}>Desconectar</button>
            <button onClick={getBatteryLevel}>Consultar Batería</button>
            <button onClick={() => setReadMode('rfid')}>Modo RFID</button>
            <button onClick={() => setReadMode('barcode')}>Modo Barcode</button>
          </>
        )}
      </div>

      {/* Device List if Disconnected */}
      {!isConnected && scannedDevices.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3>Dispositivos encontrados:</h3>
          <ul>
            {scannedDevices.map((dev) => (
              <li key={dev.address} style={{ marginBottom: 8 }}>
                {dev.name} ({dev.address}){' '}
                <button onClick={() => connect(dev.rawDevice || dev.address)}>Conectar</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* RFID Section */}
      {isConnected && (
        <fieldset style={{ marginBottom: 20, borderRadius: 8, padding: 16 }}>
          <legend><strong>Operaciones RFID (Modo actual: {readMode.toUpperCase()})</strong></legend>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <button onClick={startInventory}>Iniciar Inventario Continuo</button>
            <button onClick={stopInventory}>Detener Inventario</button>
            <button onClick={() => readSingleTag(0x01)}>Leer Tag Individual (EPC)</button>
            <button onClick={clearTags}>Limpiar Lista</button>
          </div>

          <div style={{ marginTop: 12, padding: 10, backgroundColor: '#f7fafc', borderRadius: 6 }}>
            <h4>Búsqueda EPC / Radar filtrado:</h4>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
              <label>Código Modelo:</label>
              <input value={modelCode} onChange={(e) => setModelCode(e.target.value)} style={{ width: 80 }} />
              <label>Color ID:</label>
              <input type="number" value={colorCode} onChange={(e) => setColorCode(Number(e.target.value))} style={{ width: 50 }} />
              <label>Talle ID:</label>
              <input type="number" value={sizeCode} onChange={(e) => setSizeCode(Number(e.target.value))} style={{ width: 50 }} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={handleSearchByModel}>Buscar por Modelo (Radar Mask)</button>
              <button onClick={handleSearchByColorAndSize}>Buscar por Color y Talle</button>
              <button onClick={stopRadar}>Detener Radar</button>
            </div>
          </div>

          {singleTag && (
            <div style={{ marginTop: 12, padding: 8, backgroundColor: '#ebf8ff', borderRadius: 6 }}>
              📌 Tag leido individualmente: EPC={singleTag.epc} | Data={singleTag.data} | Status={singleTag.status}
            </div>
          )}

          <h4>Tags leídos ({tags.length}):</h4>
          <ul style={{ maxHeight: 200, overflowY: 'auto' }}>
            {tags.map((t) => (
              <li key={t.epc}>
                <code>{t.epc}</code> | RSSI: <strong>{t.rssi} dBm</strong>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      {/* Barcode Section */}
      {isConnected && (
        <fieldset style={{ borderRadius: 8, padding: 16 }}>
          <legend><strong>Escáner Código de Barras (1D/2D)</strong></legend>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <button onClick={startBarcodeScan}>Disparar Lectura Barcode</button>
            <button onClick={stopBarcodeScan}>Detener Lectura</button>
            <button onClick={clearBarcode}>Limpiar</button>
          </div>

          {lastBarcode ? (
            <div style={{ padding: 12, backgroundColor: '#ebf8ff', borderRadius: 6, fontSize: 18 }}>
              📷 <strong>Código leído:</strong> <code>{lastBarcode.value}</code>
            </div>
          ) : (
            <div>Aprete el gatillo físico o el botón de arriba para escanear...</div>
          )}
        </fieldset>
      )}
    </div>
  );
};
