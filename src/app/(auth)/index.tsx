import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSession } from '@/context/SessionContext';

export default function LoginScreen() {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleLogin() {
    if (!username.trim() || !password) {
      setError('Ingresá usuario y password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await signIn(username.trim(), password);
      router.replace('/(app)');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'No se pudo iniciar sesión.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <View style={styles.logo}><Ionicons name="cube-outline" size={42} color="#0b63ce" /></View>
        <Text style={styles.title}>Chafon Stock</Text>
        <Text style={styles.subtitle}>Gestión de stock RFID</Text>

        <Text style={styles.label}>Usuario</Text>
        <TextInput value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} style={styles.input} placeholder="Usuario" />

        <Text style={styles.label}>Password</Text>
        <TextInput value={password} onChangeText={setPassword} secureTextEntry style={styles.input} placeholder="Password" />

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={({ pressed }) => [styles.button, pressed && { opacity: 0.8 }]} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>INGRESAR</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', backgroundColor: '#eef3f8', padding: 20 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 24, shadowOpacity: 0.08, shadowRadius: 18, elevation: 3 },
  logo: { alignSelf: 'center', width: 76, height: 76, borderRadius: 38, justifyContent: 'center', alignItems: 'center', backgroundColor: '#e8f1ff', marginBottom: 12 },
  title: { textAlign: 'center', fontSize: 25, fontWeight: '700', color: '#172033' },
  subtitle: { textAlign: 'center', color: '#667085', marginTop: 4, marginBottom: 26 },
  label: { fontSize: 13, fontWeight: '600', color: '#344054', marginBottom: 6 },
  input: { height: 48, borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 10, paddingHorizontal: 14, marginBottom: 15, color: '#101828' },
  button: { height: 50, backgroundColor: '#0b63ce', borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  buttonText: { color: '#fff', fontWeight: '700' },
  error: { color: '#d92d20', marginBottom: 10, fontSize: 13 },
});
