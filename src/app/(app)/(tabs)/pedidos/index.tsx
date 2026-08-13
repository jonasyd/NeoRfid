import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Ionicons } from '@expo/vector-icons';

export default function PedidosScreen() {
  return (
    <Screen>
      <View style={styles.center}>
        <Ionicons name="cart-outline" size={80} color="#98a2b3" />
        <Text style={styles.title}>Pedidos</Text>
        <Text style={styles.subtitle}>Coming Soon</Text>
        <Text style={styles.text}>Este módulo estará disponible en la próxima versión.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  title: { fontSize: 24, fontWeight: '700', color: '#101828', marginTop: 16 },
  subtitle: { fontSize: 16, fontWeight: '600', color: '#0b63ce', marginTop: 4 },
  text: { color: '#667085', marginTop: 8, textAlign: 'center' }
});
