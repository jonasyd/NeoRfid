import { router } from 'expo-router';
import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSession } from '@/context/SessionContext';

export default function DepositoScreen() {
  const { session, setDeposito } = useSession();
  return (
    <Screen>
      <Text style={styles.title}>Seleccioná el depósito</Text>
      <Text style={styles.subtitle}>Las consultas de stock utilizarán el depósito seleccionado.</Text>
      <FlatList
        data={session?.depositos ?? []}
        keyExtractor={(item) => item.uuid}
        renderItem={({ item }) => {
          const displayName = item.Sucursal ? `${item.Sucursal} - ${item.nombre}` : item.nombre;
          return (
            <Pressable style={styles.item} onPress={async () => { await setDeposito(item); router.replace('/(app)/(tabs)'); }}>
              <View><Text style={styles.name}>{displayName}</Text><Text style={styles.uuid}>{item.uuid}</Text></View>
              <Text style={styles.arrow}>›</Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No hay depósitos disponibles.</Text>}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '700', color: '#101828', marginTop: 20 },
  subtitle: { color: '#667085', marginTop: 6, marginBottom: 20 },
  item: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', elevation: 1 },
  name: { fontSize: 16, fontWeight: '600', color: '#101828' },
  uuid: { fontSize: 11, color: '#98a2b3', marginTop: 4 },
  arrow: { fontSize: 28, color: '#98a2b3' },
  empty: { color: '#667085', marginTop: 30, textAlign: 'center' },
});
