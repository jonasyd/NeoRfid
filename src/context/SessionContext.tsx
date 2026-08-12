import React, { PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthSession, Deposito } from '@/types/api';
import { getSession, loadDepositos, login, logout, refreshAccessToken, restoreSession, selectDeposito } from '@/services/api';

interface SessionContextValue {
  session: AuthSession | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshDepositos: () => Promise<Deposito[]>;
  setDeposito: (deposito: Deposito) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    restoreSession().then(setSession).finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (Date.now() >= session.expiresAt) {
        refreshAccessToken()
          .then(() => {
            const refreshed = getSession();
            if (refreshed) setSession({ ...refreshed });
          })
          .catch(() => undefined);
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [session]);

  const signIn = useCallback(async (username: string, password: string) => {
    const newSession = await login(username, password);
    setSession(newSession);
    const depositos = await loadDepositos();
    setSession((current) => current ? { ...current, depositos } : current);
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    setSession(null);
  }, []);

  const refreshDepositos = useCallback(async () => {
    const depositos = await loadDepositos();
    setSession((current) => current ? { ...current, depositos } : current);
    return depositos;
  }, []);

  const setDeposito = useCallback(async (deposito: Deposito) => {
    await selectDeposito(deposito);
    setSession((current) => current ? { ...current, depositoSeleccionado: deposito } : current);
  }, []);

  const value = useMemo(() => ({
    session,
    isLoading,
    isAuthenticated: !!session?.accessToken,
    signIn,
    signOut,
    refreshDepositos,
    setDeposito,
  }), [session, isLoading, signIn, signOut, refreshDepositos, setDeposito]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession debe utilizarse dentro de SessionProvider');
  return value;
}
