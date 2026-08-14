import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { Alert, BackHandler } from 'react-native';
import { useSession } from '@/context/SessionContext';

const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'home-outline',
  stock: 'barcode-outline',
  inventario: 'book-outline',
  pedidos: 'cart-outline',
  configuracion: 'settings-outline',
  salir: 'log-out-outline',
};

export function AppTabs() {
  const { signOut } = useSession();

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: '#0b63ce',
        tabBarInactiveTintColor: '#667085',
        tabBarLabelStyle: { fontSize: 10, marginBottom: 2 },
        tabBarStyle: { height: 62, paddingTop: 5 },
        tabBarIcon: ({ color, size }) => <Ionicons name={icons[route.name] ?? 'ellipse-outline'} color={color} size={size} />,
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
