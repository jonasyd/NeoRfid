import React, { PropsWithChildren } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Edge = 'top' | 'right' | 'bottom' | 'left';

interface ScreenProps extends PropsWithChildren {
  style?: ViewStyle;
  noPadding?: boolean;
  /**
   * Bordes donde se respeta el área segura del sistema.
   *
   * Por defecto NO incluye 'bottom', porque casi todas las pantallas viven dentro de las
   * pestañas y esa barra ya reserva la franja de los botones del sistema. Aplicarlo también acá
   * lo contaba dos veces y dejaba una banda muerta entre el contenido y las pestañas — se veía
   * como que la imagen de Inicio no llegaba hasta abajo.
   *
   * Las pantallas que no están dentro de las pestañas sí tienen que pedir 'bottom'.
   */
  edges?: readonly Edge[];
}

const DEFAULT_EDGES: readonly Edge[] = ['top', 'left', 'right'];

export function Screen({ children, style, noPadding, edges = DEFAULT_EDGES }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safe} edges={edges}>
      <View style={[styles.container, noPadding && { padding: 0 }, style]}>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f7f8fa' },
  container: { flex: 1, padding: 16 },
});
