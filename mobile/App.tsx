import React, { useState, useEffect, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { TripsScreen } from './src/screens/TripsScreen';
import { BLEScreen } from './src/screens/BLEScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { AlertHistoryScreen } from './src/screens/AlertHistoryScreen';
import { DebugLogScreen } from './src/screens/DebugLogScreen';
import { loadSettings, type Settings, DEFAULT_SETTINGS } from './src/config/settings';
import { setEnabledPids } from './src/services/obdService';
import { seedDefaultSchedule } from './src/services/maintenanceService';
import { MaintenanceScreen } from './src/screens/MaintenanceScreen';

type Screen = 'dashboard' | 'trips' | 'ble' | 'settings' | 'alerts' | 'debug' | 'maintenance';

export default function App() {
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [liveMode, setLiveMode] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  // Load settings on startup and sync enabled PIDs to OBD service
  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setEnabledPids(s.enabledPids);
      seedDefaultSchedule().catch(() => {});
    });
  }, []);

  const handleNavigate = useCallback((s: string) => {
    // Map any route to valid screens
    if (s === 'scan') s = 'ble'; // SCAN CODES → BLE connection screen
    setScreen(s as Screen);
  }, []);

  // When returning from settings, reload to pick up any changes
  const handleSettingsBack = useCallback(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setEnabledPids(s.enabledPids);
    });
    setScreen('dashboard');
  }, []);

  return (
    <>
      <StatusBar style="light" />
      {screen === 'dashboard' && (
        <DashboardScreen
          onNavigate={handleNavigate}
          useLiveGPS={liveMode}
          enabledPids={settings.enabledPids}
        />
      )}
      {screen === 'trips' && (
        <TripsScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'ble' && (
        <BLEScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'settings' && (
        <SettingsScreen
          onBack={handleSettingsBack}
          liveMode={liveMode}
          onLiveModeChange={setLiveMode}
        />
      )}
      {screen === 'alerts' && (
        <AlertHistoryScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'debug' && (
        <DebugLogScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'maintenance' && (
        <MaintenanceScreen
          onBack={() => setScreen('dashboard')}
          severeDuty={settings.severeDuty}
          wizardComplete={settings.maintenanceWizardComplete}
          onWizardComplete={() => {
            loadSettings().then((s) => setSettings(s));
          }}
        />
      )}
    </>
  );
}
