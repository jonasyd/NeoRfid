import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSession } from '@/context/SessionContext';

export default function LoginScreen() {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
        <Image source={require('../../../assets/logo.png')} style={styles.logoImage} resizeMode="contain" />
        <Text style={styles.title}>Neoretail Gestión de Stock</Text>
        <Text style={styles.subtitle}>con soporte para RFID</Text>

        <Text style={styles.label}>Usuario</Text>
        <TextInput
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="Usuario"
          placeholderTextColor="#98a2b3"
        />

        <Text style={styles.label}>Password</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            style={styles.passwordInput}
            placeholder="Password"
            placeholderTextColor="#98a2b3"
          />
          <Pressable style={styles.eyeButton} onPress={() => setShowPassword(!showPassword)}>
            <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color="#667085" />
          </Pressable>
        </View>

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={({ pressed }) => [styles.button, pressed && { opacity: 0.8 }]} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>INGRESAR</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', backgroundColor: '#022449', padding: 20 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 24, shadowOpacity: 0.08, shadowRadius: 18, elevation: 3 },
  logoImage: { alignSelf: 'center', width: 140, height: 140, marginBottom: 8 },
  title: { textAlign: 'center', fontSize: 22, fontWeight: '700', color: '#172033' },
  subtitle: { textAlign: 'center', color: '#475467', marginTop: 4, marginBottom: 26, fontSize: 14 },
  label: { fontSize: 13, fontWeight: '600', color: '#344054', marginBottom: 6 },
  input: { height: 48, borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 10, paddingHorizontal: 14, marginBottom: 15, color: '#101828' },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d0d5dd',
    borderRadius: 10,
    marginBottom: 20,
    height: 48,
    paddingHorizontal: 14,
    backgroundColor: '#fff',
  },
  passwordInput: {
    flex: 1,
    height: '100%',
    color: '#101828',
    padding: 0,
  },
  eyeButton: {
    paddingLeft: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  button: { height: 50, backgroundColor: '#0b63ce', borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  buttonText: { color: '#fff', fontWeight: '700' },
  error: { color: '#d92d20', marginBottom: 8, fontSize: 13 },
});
