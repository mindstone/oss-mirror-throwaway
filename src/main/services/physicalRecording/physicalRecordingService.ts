/**
 * Physical Recording Service
 *
 * Handles BLE connection to Limitless Pendant for recording in-person meetings.
 * This is a separate recording path from Meeting Bot (cloud) and Local Recording (Desktop SDK).
 *
 * Key features:
 * - BLE device scanning and connection
 * - Real-time audio streaming from Limitless Pendant
 * - Opus audio decoding to PCM
 * - Button event detection for recording triggers
 * - Batch download of offline recordings
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getSettings, updateSettings } from '@core/services/settingsStore';
import type { PhysicalRecordingState, PhysicalRecordingDevice } from './types';
import type { MeetingStatusSource } from '@shared/ipc/channels/meetingBot';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { transcribePhysicalRecording } from './transcriptionService';
import { isLocalRecordingCapturing } from '../meetingBot/meetingBotRuntimeRegistry';
import { isQuickCaptureActive } from '@main/ipc/quickCaptureState';

const log = createScopedLogger({ service: 'physical-recording' });

// Limitless Pendant BLE UUIDs
const LIMITLESS_SERVICE = '632de001604c446ba80f7963e950f3fb';
const LIMITLESS_TX = '632de002604c446ba80f7963e950f3fb';
const LIMITLESS_RX = '632de003604c446ba80f7963e950f3fb';

// Minimum RSSI for device discovery (filter weak signals)
const MIN_RSSI = -70;

// Noble types (dynamic import to handle native module loading)
// Noble's default export is an EventEmitter singleton with BLE scanning methods.
// `typeof import(...)` gives the module namespace, not the runtime instance shape.
type Peripheral = import('@stoprocent/noble').Peripheral;
type Characteristic = import('@stoprocent/noble').Characteristic;
interface Noble {
  state: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Noble event listeners are variadic per-event; @stoprocent/noble uses `any[]` in its own types
  on(event: string, callback: (...args: any[]) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Noble event listeners are variadic per-event; @stoprocent/noble uses `any[]` in its own types
  removeListener(event: string, callback: (...args: any[]) => void): void;
  startScanning(serviceUUIDs?: string[], allowDuplicates?: boolean): void;
  stopScanning(): void;
}

// BLE protocol state
let messageIndex = 0;
let requestId = 0;

/**
 * Physical Recording Service
 * Manages BLE connection to Limitless Pendant and audio capture.
 */
class PhysicalRecordingService extends EventEmitter {
  private noble: Noble | null = null;
  private connectedPeripheral: Peripheral | null = null;
  private txChar: Characteristic | null = null;
  private rxChar: Characteristic | null = null;
  private opusDecoder: OpusDecoderType | null = null;
  private state: PhysicalRecordingState = {
    status: 'disconnected',
    isRecording: false,
  };
  private audioFrames: Buffer[] = [];
  private recordingStartTime: Date | null = null;
  private scanTimeout: NodeJS.Timeout | null = null;
  private lastButtonToggle: number = 0;
  private durationBroadcastInterval: NodeJS.Timeout | null = null;
  private currentRecordingQuip: string | null = null;

  constructor() {
    super();
    
    // Handle button press events internally for main-process toggle
    this.on('buttonPress', ({ type }: { type: 'short' | 'long' }) => {
      if (type === 'long') {
        fireAndForget(this.handleButtonToggle(), 'physicalRecording.physicalRecordingService.line83');
      }
    });
  }

  /**
   * Handle button press to toggle recording.
   * Runs in main process, so it works even if renderer is not ready.
   */
  private async handleButtonToggle(): Promise<void> {
    // Debounce: ignore if within 500ms of last toggle
    const now = Date.now();
    if (now - this.lastButtonToggle < 500) {
      log.debug('Button toggle debounced');
      return;
    }
    this.lastButtonToggle = now;
    
    try {
      if (this.state.isRecording) {
        log.info('Button press: stopping recording');
        const result = await this.stopRecording();
        this.emit('buttonRecordingStopped');
        
        // Process the recording if we have audio (fire-and-forget)
        if (result && result.audioBuffer) {
          fireAndForget(this.processButtonRecording(result.audioBuffer, result.duration, result.startTime), 'physicalRecording.physicalRecordingService.line109');
        }
      } else if (this.state.status === 'connected') {
        log.info('Button press: starting recording');
        await this.startRecording();
        this.emit('buttonRecordingStarted');
      }
    } catch (err) {
      // Log error but don't propagate - button press should not crash
      log.error({ err }, 'Button toggle failed');
      // Emit event so UI can show error if listening
      this.emit('buttonToggleError', err);
    }
  }

  /**
   * Process a button-triggered recording.
   * Transcribes the audio and broadcasts status updates.
   * Runs asynchronously so the button response is not blocked.
   */
  private async processButtonRecording(audioBuffer: Buffer, duration: number, startTime: Date): Promise<void> {
    try {
      log.info({ duration, bytes: audioBuffer.length }, 'Processing button recording');
      await transcribePhysicalRecording(audioBuffer, duration, startTime);
      
      // Broadcast done state
      broadcastPhysicalRecordingBackgroundStatus('done_physical', 'Saved to memory');
      log.info('Button recording processed successfully');
    } catch (err) {
      log.error({ err }, 'Failed to transcribe button recording');
      // Broadcast error status - using transcribing_physical with error message
      // since done_physical implies success
      broadcastPhysicalRecordingBackgroundStatus('transcribing_physical', 'Transcription failed');
    }
  }

  /**
   * Initialize the BLE library (noble).
   * Called lazily to avoid loading native modules until needed.
   */
  async initialize(): Promise<void> {
    if (this.noble) return;

    try {
      // Dynamic import to load from app.asar.unpacked in packaged app
      const noble = await this.loadNoble();
      this.noble = noble;

      noble.on('stateChange', (state: string) => {
        log.info({ bleState: state }, 'BLE state changed');
        if (state === 'poweredOff') {
          this.updateState({ status: 'error', error: 'Bluetooth is powered off' });
        } else if (state === 'unauthorized') {
          this.updateState({ status: 'error', error: 'Bluetooth access not authorized' });
        }
      });

      noble.on('warning', (message: string) => {
        log.warn({ warning: message }, 'Noble warning');
      });

      log.info('Physical recording service initialized');
    } catch (err) {
      log.error({ err }, 'Failed to initialize noble BLE library');
      throw new Error('BLE not available: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Load noble from the correct location (handles packaged app vs dev).
   */
  private async loadNoble(): Promise<Noble> {
    // In packaged app, noble is in app.asar.unpacked/node_modules
    if (app.isPackaged) {
      const resourcesPath = process.resourcesPath;
      const noblePath = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@stoprocent', 'noble');
       
      return require(noblePath);
    }
    // In development, use normal require
     
    return require('@stoprocent/noble');
  }

  /**
   * Load the Opus decoder (WebAssembly).
   */
  private async loadOpusDecoder(): Promise<OpusDecoderType> {
    if (this.opusDecoder) return this.opusDecoder;

    const { OpusDecoder } = await import('opus-decoder');
    // 32000 Hz is the Limitless Pendant's native sample rate but isn't in
    // opus-decoder's OpusDecoderSampleRate union. The library handles it at runtime.
    const decoder = new OpusDecoder({ sampleRate: 32000 as 48000, channels: 1 });
    await decoder.ready;
    this.opusDecoder = decoder;
    return decoder;
  }

  /**
   * Initialize streaming after BLE connection.
   * This enables button notifications from the pendant.
   * Must be called after BLE connection is established.
   * Based on Omi's _initialize() implementation.
   */
  private async initializeStreaming(): Promise<void> {
    if (!this.txChar) {
      throw new Error('Cannot initialize streaming - not connected');
    }

    log.info('Initializing pendant streaming...');

    // Helper to add timeout to BLE write operations
    const writeWithTimeout = async (data: Buffer, timeoutMs = 5000): Promise<void> => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('BLE write timeout'));
        }, timeoutMs);

        this.sendCommand(data)
          .then(() => {
            clearTimeout(timeout);
            resolve();
          })
          .catch((err) => {
            clearTimeout(timeout);
            reject(err);
          });
      });
    };

    // Command 1: Time sync (matches Omi's _initialize)
    await writeWithTimeout(encodeSetCurrentTime(Date.now()));
    await new Promise(r => setTimeout(r, 1000)); // 1 second delay like Omi

    // Command 2: Enable data stream (this triggers notifications to flow)
    await writeWithTimeout(encodeEnableDataStream(true));
    await new Promise(r => setTimeout(r, 1000)); // 1 second delay like Omi

    log.info('Pendant streaming initialized - button notifications now active');
  }

  /**
   * Get current service state.
   */
  getState(): PhysicalRecordingState {
    return { ...this.state };
  }

  /**
   * Wait for the BLE adapter to be powered on.
   */
  private async waitForPoweredOn(timeoutMs = 5000): Promise<void> {
    if (!this.noble) throw new Error('BLE not initialized');
    const noble = this.noble;

    const currentState = noble.state;
    if (currentState === 'poweredOn') return;

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line prefer-const -- declared before onStateChange/timeout mutual reference
      let timeout: NodeJS.Timeout;

      function onStateChange(state: string) {
        if (state === 'poweredOn') {
          clearTimeout(timeout);
          noble.removeListener('stateChange', onStateChange);
          resolve();
        } else if (state === 'poweredOff' || state === 'unauthorized' || state === 'unsupported') {
          clearTimeout(timeout);
          noble.removeListener('stateChange', onStateChange);
          reject(new Error(`Bluetooth ${state}. Please enable Bluetooth and grant permission.`));
        }
      }

      timeout = setTimeout(() => {
        noble.removeListener('stateChange', onStateChange);
        reject(new Error(`Bluetooth not ready. Current state: ${noble.state}. Make sure Bluetooth is enabled.`));
      }, timeoutMs);

      noble.on('stateChange', onStateChange);
    });
  }

  /**
   * Scan for Limitless Pendant devices.
   */
  async scanForDevices(timeoutMs = 10000): Promise<PhysicalRecordingDevice[]> {
    await this.initialize();
    if (!this.noble) throw new Error('BLE not initialized');
    const noble = this.noble;

    // Wait for Bluetooth to be ready before scanning
    try {
      await this.waitForPoweredOn(5000);
    } catch (err) {
      log.error({ err }, 'Bluetooth not ready for scanning');
      this.updateState({ status: 'error', error: err instanceof Error ? err.message : 'Bluetooth not ready' });
      throw err;
    }

    const devices: PhysicalRecordingDevice[] = [];
    const seenIds = new Set<string>();

    return new Promise((resolve, reject) => {
      this.updateState({ status: 'scanning' });

      const self = this;
      // eslint-disable-next-line prefer-const -- declared before cleanup/scanTimer mutual reference
      let scanTimer: NodeJS.Timeout;

      function cleanup() {
        if (self.scanTimeout) {
          clearTimeout(self.scanTimeout);
          self.scanTimeout = null;
        }
        clearTimeout(scanTimer);
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);
      }

      function onDiscover(peripheral: Peripheral) {
        const name = peripheral.advertisement.localName || '';
        const rssi = peripheral.rssi;

        // Filter: must have name, good signal, and be a Limitless device
        if (!name || rssi < MIN_RSSI) return;
        if (!name.toLowerCase().includes('pendant') && !name.toLowerCase().includes('limitless')) return;
        if (seenIds.has(peripheral.id)) return;

        seenIds.add(peripheral.id);
        devices.push({
          id: peripheral.id,
          name: name,
          rssi: rssi,
        });

        log.info({ device: name, rssi }, 'Found Limitless device');
        self.emit('deviceFound', { id: peripheral.id, name, rssi });
      }

      // Set up scan timeout
      scanTimer = setTimeout(() => {
        cleanup();
        log.info({ deviceCount: devices.length }, 'Scan timeout reached');
        self.updateState({ status: 'disconnected' });
        resolve(devices);
      }, timeoutMs);

      self.scanTimeout = scanTimer;

      noble.on('discover', onDiscover);

      // Start scanning
      try {
        noble.startScanning([], true);
        log.info({ timeoutMs }, 'Started BLE scanning');
      } catch (err) {
        cleanup();
        log.error({ err }, 'Failed to start BLE scanning');
        this.updateState({ status: 'error', error: err instanceof Error ? err.message : 'Failed to start scan' });
        reject(err);
      }
    });
  }

  /**
   * Stop scanning for devices.
   */
  stopScanning(): void {
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout);
      this.scanTimeout = null;
    }
    if (this.noble) {
      this.noble.stopScanning();
    }
    this.updateState({ status: 'disconnected' });
  }

  /**
   * Connect to a specific Limitless device by ID.
   */
  async connect(deviceId: string): Promise<void> {
    await this.initialize();
    if (!this.noble) throw new Error('BLE not initialized');
    const noble = this.noble;

    if (this.connectedPeripheral) {
      await this.disconnect();
    }

    this.updateState({ status: 'connecting' });

    return new Promise((resolve, reject) => {
      let connectTimeout: NodeJS.Timeout | null = null;

      const onDiscover = (peripheral: Peripheral) => {
        fireAndForget((async () => {
        if (peripheral.id !== deviceId) return;

        // Clear timeout immediately when device found (reviewer feedback)
        if (connectTimeout) {
          clearTimeout(connectTimeout);
          connectTimeout = null;
        }

        noble.stopScanning();
        noble.removeListener('discover', onDiscover);

        try {
          peripheral.once('disconnect', () => {
            log.info('Device disconnected');
            this.handleDisconnect();
          });

          log.info({ deviceId }, 'Connecting to device...');
          await peripheral.connectAsync();
          log.info('Connected, discovering services...');

          // Small delay for connection stability
          await new Promise(r => setTimeout(r, 1000));

          const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
            [LIMITLESS_SERVICE],
            [LIMITLESS_TX, LIMITLESS_RX]
          );

          for (const c of characteristics) {
            const uuid = c.uuid.toLowerCase().replace(/-/g, '');
            if (uuid.includes('632de002')) this.txChar = c;
            if (uuid.includes('632de003')) this.rxChar = c;
          }

          if (!this.txChar || !this.rxChar) {
            throw new Error('Required BLE characteristics not found');
          }

          // Subscribe to notifications
          await this.rxChar.subscribeAsync();
          this.rxChar.on('data', (data: Buffer) => this.handleBleData(data));

          this.connectedPeripheral = peripheral;

          // Get battery level if available
          const batteryLevel = await this.getBatteryLevel();

          // Initialize streaming to enable button notifications
          try {
            await this.initializeStreaming();
          } catch (err) {
            log.warn({ err }, 'Failed to initialize streaming - button detection may not work');
            // Continue anyway - device is still connected for manual recording
          }

          const deviceName = peripheral.advertisement.localName || 'Limitless Pendant';

          this.updateState({
            status: 'connected',
            device: {
              id: peripheral.id,
              name: deviceName,
              rssi: peripheral.rssi,
            },
            batteryLevel,
          });

          // Persist device ID for auto-reconnect
          const currentSettings = getSettings();
          updateSettings({
            meetingBot: {
              ...currentSettings.meetingBot,
              limitless: {
                ...currentSettings.meetingBot?.limitless,
                lastConnectedDeviceId: peripheral.id,
                lastConnectedDeviceName: deviceName,
              },
            },
          });

          log.info({ deviceId, deviceName, batteryLevel }, 'Device connected successfully');
          resolve();
        } catch (err) {
          log.error({ err, deviceId }, 'Failed to connect to device');
          this.updateState({ status: 'error', error: 'Connection failed' });
          reject(err);
        }
        })(), 'physicalRecording.discover');
      };

      noble.on('discover', onDiscover);

      // Timeout for connection
      connectTimeout = setTimeout(() => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanning();
        if (this.state.status === 'connecting') {
          this.updateState({ status: 'error', error: 'Connection timeout' });
          reject(new Error('Connection timeout'));
        }
      }, 15000);

      noble.startScanning([], false);
    });
  }

  /**
   * Disconnect from the current device.
   */
  async disconnect(): Promise<void> {
    if (this.state.isRecording) {
      await this.stopRecording();
    }

    if (this.rxChar) {
      try {
        this.rxChar.removeAllListeners('data');
        await this.rxChar.unsubscribeAsync();
      } catch {
        // Ignore errors during cleanup
      }
      this.rxChar = null;
    }

    this.txChar = null;

    if (this.connectedPeripheral) {
      try {
        await this.connectedPeripheral.disconnectAsync();
      } catch {
        // Ignore errors during cleanup
      }
      this.connectedPeripheral = null;
    }

    this.updateState({ status: 'disconnected', device: undefined, batteryLevel: undefined });
    log.info('Disconnected from device');
  }

  /**
   * Explicitly disconnect and clear saved device (user-initiated).
   * This prevents auto-reconnect on next startup.
   */
  async disconnectAndForget(): Promise<void> {
    await this.disconnect();
    
    // Clear saved device ID
    const currentSettings = getSettings();
    updateSettings({
      meetingBot: {
        ...currentSettings.meetingBot,
        limitless: {
          ...currentSettings.meetingBot?.limitless,
          lastConnectedDeviceId: undefined,
          lastConnectedDeviceName: undefined,
        },
      },
    });
    
    log.info('Disconnected and cleared saved device');
  }

  /**
   * Force disconnect without waiting for BLE operations.
   * Used when normal disconnect hangs. Clears state immediately.
   */
  forceDisconnectAndForget(): void {
    log.warn('Force disconnecting (BLE operations may have hung)');
    
    // Clear listeners without waiting
    if (this.rxChar) {
      try {
        this.rxChar.removeAllListeners('data');
      } catch {
        // Ignore
      }
      this.rxChar = null;
    }
    this.txChar = null;
    
    // Clear peripheral reference (BLE may still be connected at OS level)
    if (this.connectedPeripheral) {
      // Fire-and-forget disconnect attempt
      this.connectedPeripheral.disconnectAsync().catch(() => {});
      this.connectedPeripheral = null;
    }
    
    // Update state immediately
    this.updateState({ 
      status: 'disconnected', 
      device: undefined, 
      batteryLevel: undefined,
      isRecording: false,
      recordingStartTime: undefined,
    });
    
    // Clear saved device ID
    const currentSettings = getSettings();
    updateSettings({
      meetingBot: {
        ...currentSettings.meetingBot,
        limitless: {
          ...currentSettings.meetingBot?.limitless,
          lastConnectedDeviceId: undefined,
          lastConnectedDeviceName: undefined,
        },
      },
    });
    
    log.info('Force disconnected and cleared saved device');
  }

  /**
   * Start recording audio from the connected device.
   */
  async startRecording(): Promise<void> {
    if (this.state.status !== 'connected') {
      throw new Error('Not connected to a device');
    }

    if (this.state.isRecording) {
      throw new Error('Already recording');
    }

    // Mutual exclusion: don't start physical recording while local recording is capturing
    if (isLocalRecordingCapturing()) {
      log.warn('Cannot start physical recording while local recording is capturing');
      throw new Error('Local recording is active. Stop it first to record from pendant.');
    }

    // Mutual exclusion: don't start physical recording while quick capture is active
    if (isQuickCaptureActive()) {
      log.warn('Cannot start physical recording while quick capture is active');
      throw new Error('Quick capture is active. Stop it first to record from pendant.');
    }

    // Reset audio buffer state (but NOT messageIndex/requestId - they should continue incrementing)
    this.audioFrames = [];
    this.recordingStartTime = new Date();

    // NOTE: Don't re-send time sync or enable data stream - already done in initializeStreaming()
    // The stream is already active from when we connected
    log.info({ deviceId: this.state.device?.id, deviceName: this.state.device?.name }, 'Starting recording (stream already active from connection)');

    this.updateState({ isRecording: true, recordingStartTime: this.recordingStartTime });
    log.info({ deviceId: this.state.device?.id, deviceName: this.state.device?.name, startTime: this.recordingStartTime?.toISOString() }, 'Recording started');
    this.emit('recordingStarted');
    
    // Pick a stable quip for this recording session
    const recordingQuip = pickRandomQuip();
    this.currentRecordingQuip = recordingQuip;
    
    // Broadcast initial status
    broadcastPhysicalRecordingStatus('recording_physical', recordingQuip);
    
    // Start duration broadcast interval (every second)
    this.durationBroadcastInterval = setInterval(() => {
      if (this.state.isRecording) {
        broadcastPhysicalRecordingStatus('recording_physical', recordingQuip);
      }
    }, 1000);
  }

  /**
   * Stop recording and return the captured audio.
   */
  async stopRecording(): Promise<{ audioBuffer: Buffer; duration: number; startTime: Date } | null> {
    if (!this.state.isRecording || !this.recordingStartTime) {
      return null;
    }

    const startTime = this.recordingStartTime;
    log.info({ frames: this.audioFrames.length, deviceId: this.state.device?.id, deviceName: this.state.device?.name }, 'Stopping recording...');

    // NOTE: Don't disable the data stream here - keep it active so button detection
    // continues working for subsequent recordings. Audio frame collection is already
    // gated by `isRecording` flag in handleBleData().

    const frames = [...this.audioFrames];
    this.audioFrames = [];

    if (frames.length === 0) {
      log.warn('No audio frames captured');
      if (this.durationBroadcastInterval) {
        clearInterval(this.durationBroadcastInterval);
        this.durationBroadcastInterval = null;
      }
      this.updateState({ isRecording: false, recordingStartTime: undefined });
      return null;
    }

    // Decode Opus frames to PCM
    log.info({ frames: frames.length }, 'Decoding audio...');
    const pcmData = await this.decodeOpusFrames(frames);

    if (!pcmData || pcmData.length === 0) {
      log.warn('Failed to decode audio frames');
      if (this.durationBroadcastInterval) {
        clearInterval(this.durationBroadcastInterval);
        this.durationBroadcastInterval = null;
      }
      this.updateState({ isRecording: false, recordingStartTime: undefined });
      return null;
    }

    // Create WAV file
    const wavBuffer = createWavBuffer(pcmData, 32000);
    const duration = pcmData.length / 32000; // seconds

    // Stop the duration broadcast interval
    if (this.durationBroadcastInterval) {
      clearInterval(this.durationBroadcastInterval);
      this.durationBroadcastInterval = null;
    }
    this.currentRecordingQuip = null;

    this.updateState({ isRecording: false, recordingStartTime: undefined });
    
    // Broadcast transcribing state (low precedence so meetings can override)
    broadcastPhysicalRecordingBackgroundStatus('transcribing_physical', 'Transcribing...');
    log.info({ duration: duration.toFixed(2), bytes: wavBuffer.length }, 'Recording stopped');
    this.emit('recordingStopped', { duration });

    return { audioBuffer: wavBuffer, duration, startTime };
  }

  /**
   * Get the current recording duration in seconds.
   */
  getRecordingDuration(): number {
    if (!this.recordingStartTime) return 0;
    return (Date.now() - this.recordingStartTime.getTime()) / 1000;
  }

  /**
   * Get the number of captured audio frames.
   */
  getFrameCount(): number {
    return this.audioFrames.length;
  }

  /**
   * Handle incoming BLE data from the device.
   */
  private handleBleData(data: Buffer): void {
    // Method 1: Parse button events from protobuf (primary method)
    const buttonDetected = this.tryParseButtonStatus(data);

    // Method 2: Check for debug log strings (fallback method)
    // Only check if protobuf didn't find a button event
    if (!buttonDetected) {
      const dataStr = data.toString('utf8', 0, Math.min(data.length, 200));

      if (dataStr.includes('BUTTON_LONG_PRESS')) {
        log.info('Button long press detected (debug string)');
        this.emit('buttonPress', { type: 'long' });
      } else if (dataStr.includes('BUTTON_SHORT_PRESS')) {
        log.info('Button short press detected (debug string)');
        this.emit('buttonPress', { type: 'short' });
      } else if (dataStr.includes('Recording state set to RECORDING')) {
        log.info('Device started recording');
        this.emit('deviceRecordingStateChange', { recording: true });
      } else if (dataStr.includes('IDLE_MODE')) {
        log.info('Device entered idle mode');
        this.emit('deviceRecordingStateChange', { recording: false });
      }
    }

    // Extract Opus frames ONLY if we're recording
    if (this.state.isRecording) {
      const frames = extractOpusFrames(data);
      if (frames.length > 0) {
        this.audioFrames.push(...frames);
      }
    }
  }

  /**
   * Parse button status from protobuf-encoded BLE notification.
   * Based on Omi's _tryParseButtonStatus implementation.
   *
   * Protocol structure:
   * - 0x22: Length-delimited wrapper (field 4 of BLE packet)
   * - 0x42: Button message marker (field 8)
   * - 0x08: Event field (field 1 of button message)
   * - Value: 0=none, 1=short, 2=long, 3=double
   *
   * Unlike Omi, we DO want to capture LONG_PRESS (2) for recording toggle.
   */
  private tryParseButtonStatus(data: Buffer): boolean {
    try {
      if (data.length < 10) return false;

      let pos = 0;
      while (pos < data.length - 5) {
        // Look for 0x22 (length-delimited wrapper)
        if (data[pos] === 0x22) {
          pos++;
          if (pos >= data.length) return false;

          // Decode payload length
          const [payloadLength, newPos] = decodeVarint(data, pos);
          pos = newPos;

          if (payloadLength < 2 || payloadLength > data.length - pos) return false;

          // Look for 0x42 (button message marker)
          if (data[pos] !== 0x42) {
            pos++;
            continue;
          }

          let innerPos = pos + 1;
          if (innerPos >= data.length) return false;

          // Decode button message length
          const [buttonLength, btnPos] = decodeVarint(data, innerPos);
          innerPos = btnPos;

          if (buttonLength < 2 || buttonLength > 50 || innerPos + buttonLength > data.length) return false;

          const buttonEnd = innerPos + buttonLength;

          // Look for 0x08 (event field)
          while (innerPos < buttonEnd - 1) {
            if (data[innerPos] === 0x08) {
              innerPos++;
              const [buttonEvent] = decodeVarint(data, innerPos);

              // Button events: 0=none, 1=short, 2=long, 3=double
              if (buttonEvent < 0 || buttonEvent > 3) return false;
              if (buttonEvent === 0) return false; // NOT_PRESSED - ignore

              const eventType = buttonEvent === 1 ? 'short' : buttonEvent === 2 ? 'long' : 'double';
              log.info({ buttonEvent, eventType }, 'Button event detected (protobuf)');
              this.emit('buttonPress', { type: eventType });
              return true;
            }
            innerPos++;
          }
          return false;
        }
        pos++;
      }
    } catch {
      // Silently ignore parsing errors - not all packets contain button events
    }
    return false;
  }

  /**
   * Handle device disconnect event.
   * If recording was in progress, attempt to save partial audio.
   */
  private handleDisconnect(): void {
    // Clear broadcast interval first
    if (this.durationBroadcastInterval) {
      clearInterval(this.durationBroadcastInterval);
      this.durationBroadcastInterval = null;
    }
    
    this.connectedPeripheral = null;
    this.txChar = null;
    this.rxChar = null;

    if (this.state.isRecording && this.audioFrames.length > 0) {
      // Attempt to recover partial recording
      log.warn({ frames: this.audioFrames.length }, 'Disconnected while recording - attempting partial save');
      const partialFrames = [...this.audioFrames];
      this.audioFrames = [];

      // Decode and emit partial recording asynchronously
      this.decodeOpusFrames(partialFrames).then((pcmData) => {
        if (pcmData && pcmData.length > 0) {
          const wavBuffer = createWavBuffer(pcmData, 32000);
          const duration = pcmData.length / 32000;
          log.info({ duration: duration.toFixed(2) }, 'Partial recording recovered');
          this.emit('partialRecordingRecovered', { audioBuffer: wavBuffer, duration });
        } else {
          log.warn('Could not decode partial recording');
          this.emit('disconnectedWhileRecording', { framesLost: partialFrames.length });
        }
      }).catch((err) => {
        log.error({ err }, 'Failed to recover partial recording');
        this.emit('disconnectedWhileRecording', { framesLost: partialFrames.length });
      });
    } else if (this.state.isRecording) {
      this.emit('disconnectedWhileRecording', { framesLost: 0 });
    }

    this.updateState({
      status: 'disconnected',
      device: undefined,
      batteryLevel: undefined,
      isRecording: false,
      recordingStartTime: undefined,
    });
  }

  /**
   * Send a command to the device.
   */
  private async sendCommand(data: Buffer): Promise<void> {
    if (!this.txChar) {
      throw new Error('Not connected to device');
    }
    await this.txChar.writeAsync(data, false);
  }

  /**
   * Get battery level from the device (if available).
   */
  private async getBatteryLevel(): Promise<number | undefined> {
    if (!this.connectedPeripheral) return undefined;

    try {
      const { characteristics } = await this.connectedPeripheral.discoverSomeServicesAndCharacteristicsAsync(
        ['180f'], // Battery Service UUID
        ['2a19']  // Battery Level UUID
      );

      for (const c of characteristics) {
        if (c.uuid === '2a19') {
          const data = await c.readAsync();
          return data[0]; // Battery level 0-100
        }
      }
    } catch {
      // Battery service may not be available
    }

    return undefined;
  }

  /**
   * Decode Opus frames to PCM samples.
   */
  private async decodeOpusFrames(frames: Buffer[]): Promise<Int16Array | null> {
    try {
      const decoder = await this.loadOpusDecoder();

      const pcmChunks: Float32Array[] = [];
      for (const frame of frames) {
        try {
          const result = decoder.decodeFrame(frame);
          if (result != null && (result.samplesDecoded ?? 0) > 0) {
            pcmChunks.push(result.channelData[0]);
          }
        } catch {
          // Skip invalid frames
        }
      }

      if (pcmChunks.length === 0) return null;

      // Combine chunks
      const totalSamples = pcmChunks.reduce((sum, c) => sum + c.length, 0);
      const pcmFloat = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of pcmChunks) {
        pcmFloat.set(chunk, offset);
        offset += chunk.length;
      }

      // Convert to Int16
      return float32ToInt16(pcmFloat);
    } catch (err) {
      log.error({ err }, 'Failed to decode Opus frames');
      return null;
    }
  }

  /**
   * Update internal state and emit change event.
   */
  private updateState(partial: Partial<PhysicalRecordingState>): void {
    this.state = { ...this.state, ...partial };
    this.emit('stateChange', this.getState());
  }

  /**
   * Cleanup resources.
   */
  async cleanup(): Promise<void> {
    await this.disconnect();

    if (this.opusDecoder) {
      this.opusDecoder.free();
      this.opusDecoder = null;
    }

    this.removeAllListeners();
    log.info('Physical recording service cleaned up');
  }
}

// Type for Opus decoder
type OpusDecoderType = {
  ready: Promise<void>;
  decodeFrame(data: Buffer | Uint8Array): { samplesDecoded: number; channelData: Float32Array[] } | null;
  free(): void;
};

// =============================================================================
// BLE Protocol Helpers (from limitless-full.js)
// =============================================================================

/**
 * Encode a varint using BigInt to support 64-bit values like Date.now().
 * Standard JS bitwise ops truncate to 32-bit, so we use BigInt for large values.
 */
function encodeVarint(value: number | bigint): number[] {
  const result: number[] = [];
  let v = BigInt(value);
  while (v > 0x7fn) {
    result.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  result.push(Number(v & 0x7fn));
  return result.length > 0 ? result : [0];
}

function decodeVarint(data: Buffer | number[], pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (pos < data.length) {
    const byte = data[pos];
    pos++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function encodeField(fieldNum: number, wireType: number, value: number[]): number[] {
  const tag = (fieldNum << 3) | wireType;
  return [...encodeVarint(tag), ...value];
}

function encodeBytesField(fieldNum: number, data: number[]): number[] {
  return encodeField(fieldNum, 2, [...encodeVarint(data.length), ...data]);
}

function encodeIntField(fieldNum: number, value: number): number[] {
  return encodeField(fieldNum, 0, encodeVarint(value));
}

function encodeMessage(fieldNum: number, msgBytes: number[]): number[] {
  return encodeBytesField(fieldNum, msgBytes);
}

function encodeBleWrapper(payload: number[]): Buffer {
  const msg: number[] = [];
  msg.push(...encodeIntField(1, messageIndex++));
  msg.push(...encodeIntField(2, 0));
  msg.push(...encodeIntField(3, 1));
  msg.push(...encodeBytesField(4, payload));
  return Buffer.from(msg);
}

function encodeRequestData(): number[] {
  const msg: number[] = [];
  msg.push(...encodeIntField(1, ++requestId));
  msg.push(...encodeField(2, 0, [0x00]));
  return encodeMessage(30, msg);
}

function encodeSetCurrentTime(timestampMs: number): Buffer {
  const timeMsg = encodeIntField(1, timestampMs);
  return encodeBleWrapper([...encodeMessage(6, timeMsg), ...encodeRequestData()]);
}

function encodeEnableDataStream(enable = true): Buffer {
  const msg: number[] = [];
  msg.push(...encodeField(1, 0, [0x00]));
  msg.push(...encodeField(2, 0, [enable ? 0x01 : 0x00]));
  return encodeBleWrapper([...encodeMessage(8, msg), ...encodeRequestData()]);
}

// =============================================================================
// Opus Frame Extraction
// =============================================================================

function isValidOpusToc(byte: number): boolean {
  return byte === 0xb8 || byte === 0x78 || byte === 0xf8 ||
         byte === 0xb0 || byte === 0x70 || byte === 0xf0;
}

function extractOpusFrames(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let pos = 0;

  while (pos < data.length - 3) {
    if (data[pos] === 0x22) {
      pos++;
      if (pos >= data.length) break;

      const [length, newPos] = decodeVarint(data, pos);
      pos = newPos;

      if (length >= 10 && length <= 200 && pos + length <= data.length) {
        const frame = data.subarray(pos, pos + length);
        if (frame.length > 0 && isValidOpusToc(frame[0])) {
          frames.push(Buffer.from(frame));
        }
        pos += length;
      }
    } else {
      pos++;
    }
  }

  return frames;
}

// =============================================================================
// Audio Conversion
// =============================================================================

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function createWavBuffer(samples: Int16Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);      // Chunk size
  buffer.writeUInt16LE(1, 20);       // Audio format (PCM)
  buffer.writeUInt16LE(1, 22);       // Channels (mono)
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32);       // Block align
  buffer.writeUInt16LE(16, 34);      // Bits per sample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write samples
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

// =============================================================================
// Broadcast Functions (for meeting-bot:status IPC)
// =============================================================================

/** Quips for physical recording states */
const PHYSICAL_RECORDING_QUIPS = [
  'Recording in-person.',
  'Taking notes the old-fashioned way.',
  'Capturing the room.',
  'Listening in.',
  'On it.',
];

/**
 * Pick a random quip for physical recording.
 */
function pickRandomQuip(): string {
  return PHYSICAL_RECORDING_QUIPS[Math.floor(Math.random() * PHYSICAL_RECORDING_QUIPS.length)];
}

// =============================================================================
// Singleton Export
// =============================================================================

export const physicalRecordingService = new PhysicalRecordingService();

/**
 * Broadcast physical recording status to renderer.
 * Uses 'physical_recording' source (highest precedence) for active recording states.
 */
export function broadcastPhysicalRecordingStatus(
  state: 'recording_physical',
  quip?: string
): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: physical recording status is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  const service = physicalRecordingService;
  const currentState = service.getState();
  
  const duration = currentState.recordingStartTime
    ? Math.floor((Date.now() - currentState.recordingStartTime.getTime()) / 1000)
    : 0;

  const payload = {
    state,
    source: 'physical_recording' as MeetingStatusSource,
    meeting: currentState.device
      ? {
          id: `physical-${currentState.device.id}`,
          title: 'In-person Recording',
          startTime: currentState.recordingStartTime?.toISOString() || new Date().toISOString(),
          meetingUrl: '',
        }
      : undefined,
    recordingDuration: duration,
    quip: quip || pickRandomQuip(),
    timestamp: Date.now(),
  };

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', payload);
    }
  }
}

/**
 * Broadcast background status for transcription/done states.
 * Uses 'desktop_sdk' source (lowest precedence) so new meetings can override.
 */
export function broadcastPhysicalRecordingBackgroundStatus(
  state: 'transcribing_physical' | 'done_physical',
  quip: string
): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: physical recording background status is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  const service = physicalRecordingService;
  const currentState = service.getState();

  const payload = {
    state,
    source: 'physical_recording' as MeetingStatusSource, // Must match recording_physical source for state transitions
    meeting: currentState.device
      ? {
          id: `physical-${currentState.device.id}`,
          title: 'In-person Recording',
          startTime: new Date().toISOString(),
          meetingUrl: '',
        }
      : undefined,
    quip,
    timestamp: Date.now(),
  };

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', payload);
    }
  }
}

/**
 * Get current physical recording status for the get-current-status handler.
 * Returns null if no active physical recording.
 */
export function getPhysicalRecordingStatus(): {
  isRecording: boolean;
  startTime?: string;
  deviceName?: string;
  duration?: number;
} | null {
  const service = physicalRecordingService;
  const state = service.getState();
  
  if (!state.isRecording) {
    return null;
  }
  
  return {
    isRecording: true,
    startTime: state.recordingStartTime?.toISOString(),
    deviceName: state.device?.name,
    duration: state.recordingStartTime
      ? Math.floor((Date.now() - state.recordingStartTime.getTime()) / 1000)
      : 0,
  };
}

/**
 * Check if physical recording is currently capturing audio.
 * Used for mutual exclusion with local recording.
 */
export function isPhysicalRecordingActive(): boolean {
  return physicalRecordingService.getState().isRecording;
}

// =============================================================================
// Auto-Connect on Startup
// =============================================================================

/**
 * Initialize physical recording service and auto-connect to last device.
 * Called from app startup (non-blocking).
 */
export async function initializePhysicalRecording(): Promise<void> {
  const settings = getSettings();
  const limitless = settings.meetingBot?.limitless;
  const deviceId = limitless?.lastConnectedDeviceId;
  const deviceName = limitless?.lastConnectedDeviceName;
  const autoConnectEnabled = limitless?.autoConnectEnabled ?? true;
  
  if (!deviceId || !autoConnectEnabled) {
    log.info({ hasDeviceId: !!deviceId, autoConnectEnabled }, 'Skipping physical recording auto-connect');
    return;
  }
  
  log.info({ deviceId, deviceName }, 'Attempting auto-reconnect to Limitless Pendant');
  
  try {
    await physicalRecordingService.initialize();
    
    // Scan briefly to find the device (5 second timeout)
    const devices = await physicalRecordingService.scanForDevices(5000);
    const target = devices.find(d => d.id === deviceId);
    
    if (target) {
      await physicalRecordingService.connect(deviceId);
      log.info({ deviceId, deviceName }, 'Auto-reconnected to Limitless Pendant');
    } else {
      log.info({ deviceId, deviceName, foundDevices: devices.length }, 'Previously paired device not found during auto-connect');
    }
  } catch (err) {
    log.warn({ err, deviceId, deviceName }, 'Auto-reconnect to Limitless failed');
  }
}

export default physicalRecordingService;
