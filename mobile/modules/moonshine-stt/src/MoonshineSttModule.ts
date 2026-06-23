import { requireNativeModule } from 'expo-modules-core';

interface MoonshineSttModuleInterface {
  isAvailable(): Promise<boolean>;
  loadModel(modelDirPath: string): Promise<void>;
  transcribeAudioFile(audioFilePath: string): Promise<string>;
  isModelLoaded(): Promise<boolean>;
  unloadModel(): Promise<void>;
  getModelPath(): Promise<string | null>;
}

export default requireNativeModule<MoonshineSttModuleInterface>('MoonshineStt');
