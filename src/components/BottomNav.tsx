import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';

const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'home-outline',
  stock: 'search-outline',
  inventario: 'clipboard-outline',
  pedidos: 'cart-outline',
  configuracion: 'settings-outline',
};

export function AppTabs() {
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
    </Tabs>
  );
}
