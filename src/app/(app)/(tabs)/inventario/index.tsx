import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Screen } from '@/components/Screen';
export default function InventarioScreen() { return <Screen><Text style={styles.title}>Inventario</Text><Text style={styles.text}>Módulo preparado para la próxima iteración.</Text></Screen>; }
const styles = StyleSheet.create({ title: { fontSize: 24, fontWeight: '700', color: '#101828', marginTop: 4 }, text: { color: '#667085', marginTop: 8 } });
