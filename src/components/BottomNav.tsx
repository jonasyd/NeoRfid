import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { Alert, BackHandler } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '@/context/SessionContext';

const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'home-outline',
  stock: 'barcode-outline',
  inventario: 'book-outline',
  pedidos: 'cart-outline',
  configuracion: 'settings-outline',
  salir: 'log-out-outline',
};

/**
 * Icono de una pestaña a partir del nombre de su ruta.
 *
 * Las rutas que son un archivo suelto (index.tsx, salir.tsx) llegan como "index" y "salir", pero
 * las que son una carpeta con index adentro llegan como "stock/index". Buscar el nombre completo
 * en el mapa fallaba para esas cuatro y caían todas en el ícono por defecto, que es el círculo.
 */
function iconFor(routeName: string) {
  const key = routeName.split('/')[0];
  return icons[key] ?? 'ellipse-outline';
}

export function AppTabs() {
  const { signOut } = useSession();
  // Alto de la barra de gestos o de los tres botones del sistema. Sin esto la barra de pestañas
  // queda por debajo y los íconos se encinan con los botones nativos.
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: '#0b63ce',
        tabBarInactiveTintColor: '#667085',
        tabBarLabelStyle: { fontSize: 10, marginBottom: 2 },
        tabBarStyle: {
          height: 62 + insets.bottom,
          paddingTop: 5,
          paddingBottom: insets.bottom,
        },
        tabBarIcon: ({ color, size }) => <Ionicons name={iconFor(route.name)} color={color as any} size={size} />,
      })}
    >
      <Tabs.Screen name="index" options={{ title: 'Inicio' }} />
      <Tabs.Screen name="stock" options={{ title: 'Stock' }} />
      <Tabs.Screen name="inventario" options={{ title: 'Inventario' }} />
      <Tabs.Screen name="pedidos" options={{ title: 'Pedidos' }} />
      <Tabs.Screen name="configuracion" options={{ title: 'Config.' }} />
      <Tabs.Screen
        name="salir"
        options={{ title: 'Salir' }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            Alert.alert(
              'Salir',
              '¿Desea cerrar la aplicación?',
              [
                { text: 'Cancelar', style: 'cancel' },
                {
                  text: 'Salir',
                  onPress: async () => {
                    try {
                      await signOut();
                    } catch {}
                    BackHandler.exitApp();
                  }
                },
              ],
              { cancelable: true }
            );
          },
        }}
      />
    </Tabs>
  );
}
