import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import {
  getChafonStatus,
  subscribeChafonStatus,
  syncChafonStatusFromNative,
  type ChafonStatus,
} from '@modules/chafon-h103';
import ChafonH103 from '@modules/chafon-h103';

/**
 * Estado del lector Chafon compartido entre pantallas (conexión, modo de lectura, potencia y
 * batería). El módulo mantiene ese estado al día por su cuenta; acá además lo re-sincronizamos
 * contra el nativo al montar y cada vez que la pantalla toma foco, porque una pantalla puede
 * montarse después de que la conexión ya ocurrió y en ese caso nunca vio el evento.
 */
export function useChafonStatus(): ChafonStatus {
  const status = useSyncExternalStore(subscribeChafonStatus, getChafonStatus, getChafonStatus);

  useEffect(() => {
    syncChafonStatusFromNative();
  }, []);

  useFocusEffect(
    useCallback(() => {
      const s = syncChafonStatusFromNative();
      // Si está conectada pero todavía no conocemos batería/potencia, las pedimos una vez.
      if (s.connected) {
        if (s.battery == null) ChafonH103.getBattery().catch(() => undefined);
        if (s.power == null) ChafonH103.getAllParam().catch(() => undefined);
      }
    }, [])
  );

  return status;
}
