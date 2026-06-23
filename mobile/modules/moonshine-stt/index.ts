import MoonshineSttModule from './src/MoonshineSttModule';

/**
 * Check if the Moonshine STT native module is available on this platform.
 */
export async function isAvailable(): Promise<boolean> {
  return MoonshineSttModule.isAvailable();
}

/**
 * Load the Moonshine model from the given directory path.
 * The directory should contain the model files (.ort, tokenizer.bin, etc.).
 * Model is loaded lazily — call this before first transcription for faster first use.
 *
 * @param modelDirPath - Absolute path or file:// URI to the model directory
 */
export async function loadModel(modelDirPath: string): Promise<void> {
  return MoonshineSttModule.loadModel(modelDirPath);
}

/**
 * Transcribe an audio file to text using the loaded Moonshine model.
 * Accepts M4A/AAC/WAV audio files — conversion to 16kHz mono PCM
 * happens inside the native module for performance.
 *
 * @param audioFilePath - File URI or absolute path to the audio file
 * @returns Transcribed text
 * @throws If model is not loaded or transcription fails
 */
export async function transcribeAudioFile(audioFilePath: string): Promise<string> {
  return MoonshineSttModule.transcribeAudioFile(audioFilePath);
}

/**
 * Check if a model is currently loaded in memory.
 */
export async function isModelLoaded(): Promise<boolean> {
  return MoonshineSttModule.isModelLoaded();
}

/**
 * Unload the model from memory. Call when entering background
 * or when switching away from local transcription.
 */
export async function unloadModel(): Promise<void> {
  return MoonshineSttModule.unloadModel();
}

/**
 * Get the filesystem path of the currently loaded model directory.
 * Returns null if no model is loaded.
 */
export async function getModelPath(): Promise<string | null> {
  return MoonshineSttModule.getModelPath();
}
