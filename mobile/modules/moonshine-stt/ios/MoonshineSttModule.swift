import ExpoModulesCore
import AVFoundation
// MoonshineVoice types (Transcriber, Transcript, etc.) are compiled as part of
// this pod from vendored sources in MoonshineVoice/*.swift, downloaded at build
// time from the official moonshine-swift releases.

/// Expo native module for on-device speech-to-text using Moonshine.
///
/// Provides lazy model loading, background-thread inference, automatic
/// audio format conversion (M4A/AAC → 16 kHz mono PCM), and lifecycle
/// management (unloads model when the app enters background).
public class MoonshineSttModule: Module {
  /// Transcriber instance — loaded lazily on first use or explicit loadModel() call.
  private var transcriber: Transcriber?
  /// Filesystem path to the currently loaded model directory.
  private var loadedModelPath: String?
  /// Lock for thread-safe access to transcriber state.
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("MoonshineStt")

    // Free memory when the app enters background
    OnAppEntersBackground {
      self.lock.lock()
      defer { self.lock.unlock() }
      self.transcriber = nil
      self.loadedModelPath = nil
    }

    // Also free memory when the app is destroyed
    OnDestroy {
      self.lock.lock()
      defer { self.lock.unlock() }
      self.transcriber = nil
      self.loadedModelPath = nil
    }

    // MARK: - isAvailable

    AsyncFunction("isAvailable") { () -> Bool in
      return true
    }

    // MARK: - loadModel

    AsyncFunction("loadModel") { (modelDirPath: String) in
      try self.ensureModelLoaded(modelDirPath: modelDirPath)
    }

    // MARK: - transcribeAudioFile

    AsyncFunction("transcribeAudioFile") { (audioFilePath: String) -> String in
      // 1. Convert audio to 16 kHz mono float32 samples on a background thread
      let samples = try self.loadAndConvertAudio(filePath: audioFilePath)

      // 2. Run inference on a background thread
      // Uses ObjCExceptionCatcher because ONNX Runtime can throw ObjC/C++
      // exceptions during inference, not just during model load.
      NSLog("[MoonshineStt] Transcribing %d samples at 16kHz", samples.count)

      return try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
          self.lock.lock()
          guard let transcriber = self.transcriber else {
            self.lock.unlock()
            continuation.resume(throwing: MoonshineSttError.modelNotLoaded)
            return
          }
          self.lock.unlock()

          var transcript: Transcript?
          var innerError: Error?

          do {
            try ObjCExceptionCatcher.`try`({
              do {
                transcript = try transcriber.transcribeWithoutStreaming(
                  audioData: samples,
                  sampleRate: 16000
                )
              } catch {
                innerError = error
              }
            })
          } catch {
            let nsError = error as NSError
            let name = nsError.userInfo["ExceptionName"] as? String ?? "unknown"
            let reason = nsError.userInfo["ExceptionReason"] as? String ?? "unknown"
            let stack = nsError.userInfo["ExceptionCallStack"] as? String ?? ""
            NSLog("[MoonshineStt] FATAL: Transcription ObjC exception — %@: %@", name, reason)
            if !stack.isEmpty { NSLog("[MoonshineStt] Native stack:\n%@", stack) }
            continuation.resume(throwing: MoonshineSttError.transcriptionFailed("[\(name)] \(reason)"))
            return
          }

          if let innerError = innerError {
            NSLog("[MoonshineStt] Transcription Swift error: %@", innerError.localizedDescription)
            continuation.resume(throwing: MoonshineSttError.transcriptionFailed(innerError.localizedDescription))
          } else if let transcript = transcript {
            let text = transcript.lines.map { $0.text }.joined(separator: " ")
            NSLog("[MoonshineStt] Transcription succeeded: %d lines, %d chars", transcript.lines.count, text.count)
            continuation.resume(returning: text)
          } else {
            NSLog("[MoonshineStt] Transcription returned nil transcript")
            continuation.resume(returning: "")
          }
        }
      }
    }

    // MARK: - isModelLoaded

    AsyncFunction("isModelLoaded") { () -> Bool in
      self.lock.lock()
      defer { self.lock.unlock() }
      return self.transcriber != nil
    }

    // MARK: - unloadModel

    AsyncFunction("unloadModel") {
      self.lock.lock()
      defer { self.lock.unlock() }
      self.transcriber = nil
      self.loadedModelPath = nil
    }

    // MARK: - getModelPath

    AsyncFunction("getModelPath") { () -> String? in
      self.lock.lock()
      defer { self.lock.unlock() }
      return self.loadedModelPath
    }
  }

  // MARK: - Private helpers

  /// Load model if not already loaded (or if path changed).
  /// Runs model initialization on a background thread.
  ///
  /// Uses ObjCExceptionCatcher because ONNX Runtime (inside MoonshineVoice)
  /// can throw ObjC/C++ exceptions on model load failures. Swift's do/catch
  /// only catches Swift Error — ObjC exceptions bypass it and SIGABRT the app.
  private func ensureModelLoaded(modelDirPath: String) throws {
    lock.lock()
    if loadedModelPath == modelDirPath && transcriber != nil {
      lock.unlock()
      return
    }
    lock.unlock()

    // Strip file:// prefix for filesystem access
    let cleanPath = modelDirPath.hasPrefix("file://")
      ? String(modelDirPath.dropFirst(7))
      : modelDirPath

    var newTranscriber: Transcriber?
    var innerError: Error?

    NSLog("[MoonshineStt] Loading model from: %@", cleanPath)

    do {
      try ObjCExceptionCatcher.`try`({
        do {
          newTranscriber = try Transcriber(modelPath: cleanPath, modelArch: .mediumStreaming)
        } catch {
          innerError = error
        }
      })
    } catch {
      let nsError = error as NSError
      let name = nsError.userInfo["ExceptionName"] as? String ?? "unknown"
      let reason = nsError.userInfo["ExceptionReason"] as? String ?? "unknown"
      let stack = nsError.userInfo["ExceptionCallStack"] as? String ?? ""
      NSLog("[MoonshineStt] FATAL: Model load ObjC exception — %@: %@", name, reason)
      if !stack.isEmpty { NSLog("[MoonshineStt] Native stack:\n%@", stack) }
      throw MoonshineSttError.modelLoadFailed("[\(name)] \(reason)")
    }

    if let innerError = innerError {
      NSLog("[MoonshineStt] Model load Swift error: %@", innerError.localizedDescription)
      throw MoonshineSttError.modelLoadFailed(innerError.localizedDescription)
    }

    guard let transcriber = newTranscriber else {
      NSLog("[MoonshineStt] FATAL: Transcriber init returned nil (no exception thrown)")
      throw MoonshineSttError.modelLoadFailed("Transcriber initialization returned nil")
    }

    NSLog("[MoonshineStt] Model loaded successfully from: %@", cleanPath)

    lock.lock()
    self.transcriber = transcriber
    self.loadedModelPath = cleanPath
    lock.unlock()
  }

  /// Load an audio file and convert to 16 kHz mono Float32 samples.
  /// Supports M4A, AAC, WAV, and any format AVFoundation can decode.
  private func loadAndConvertAudio(filePath: String) throws -> [Float] {
    // Resolve URL — handle both file:// URIs and bare paths
    let cleanPath = filePath.hasPrefix("file://")
      ? String(filePath.dropFirst(7))
      : filePath
    let url = URL(fileURLWithPath: cleanPath)

    let audioFile: AVAudioFile
    do {
      audioFile = try AVAudioFile(forReading: url)
    } catch {
      throw MoonshineSttError.audioConversionFailed("Cannot open audio file: \(error.localizedDescription)")
    }

    // Target format: 16 kHz mono PCM Float32
    guard let targetFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 16000,
      channels: 1,
      interleaved: false
    ) else {
      throw MoonshineSttError.audioConversionFailed("Failed to create target audio format")
    }

    let sourceFormat = audioFile.processingFormat

    // Fast path: source is already 16 kHz mono — read directly
    if sourceFormat.sampleRate == 16000 && sourceFormat.channelCount == 1 {
      let frameCount = AVAudioFrameCount(audioFile.length)
      guard let buffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCount) else {
        throw MoonshineSttError.audioConversionFailed("Failed to create read buffer")
      }
      do {
        try audioFile.read(into: buffer)
      } catch {
        throw MoonshineSttError.audioConversionFailed("Failed to read audio: \(error.localizedDescription)")
      }

      guard let floatData = buffer.floatChannelData?[0] else {
        throw MoonshineSttError.audioConversionFailed("No audio samples in buffer")
      }
      return Array(UnsafeBufferPointer(start: floatData, count: Int(buffer.frameLength)))
    }

    // Need conversion: use AVAudioConverter for sample rate / channel changes
    guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
      throw MoonshineSttError.audioConversionFailed(
        "Cannot convert from \(sourceFormat.sampleRate) Hz / \(sourceFormat.channelCount) ch to 16 kHz mono"
      )
    }

    // Read entire source into a buffer
    let sourceFrameCount = AVAudioFrameCount(audioFile.length)
    guard let sourceBuffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: sourceFrameCount) else {
      throw MoonshineSttError.audioConversionFailed("Failed to create source buffer")
    }
    do {
      try audioFile.read(into: sourceBuffer)
    } catch {
      throw MoonshineSttError.audioConversionFailed("Failed to read source audio: \(error.localizedDescription)")
    }

    // Calculate output frame count based on sample rate ratio
    let ratio = 16000.0 / sourceFormat.sampleRate
    let outputFrameCount = AVAudioFrameCount(Double(audioFile.length) * ratio)

    guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCount) else {
      throw MoonshineSttError.audioConversionFailed("Failed to create output buffer")
    }

    // Convert using pull model
    var inputConsumed = false
    var conversionError: NSError?
    let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
      if inputConsumed {
        outStatus.pointee = .endOfStream
        return nil
      }
      inputConsumed = true
      outStatus.pointee = .haveData
      return sourceBuffer
    }
    converter.convert(to: outputBuffer, error: &conversionError, withInputFrom: inputBlock)

    if let error = conversionError {
      throw MoonshineSttError.audioConversionFailed("Conversion failed: \(error.localizedDescription)")
    }

    guard let floatData = outputBuffer.floatChannelData?[0] else {
      throw MoonshineSttError.audioConversionFailed("No audio samples after conversion")
    }

    return Array(UnsafeBufferPointer(start: floatData, count: Int(outputBuffer.frameLength)))
  }
}

// MARK: - Error types

/// Moonshine STT error types surfaced to JavaScript.
enum MoonshineSttError: Error, LocalizedError {
  case modelNotLoaded
  case modelLoadFailed(String)
  case transcriptionFailed(String)
  case audioConversionFailed(String)

  var errorDescription: String? {
    switch self {
    case .modelNotLoaded:
      return "Model not loaded. Call loadModel() first."
    case .modelLoadFailed(let detail):
      return "Failed to load model: \(detail)"
    case .transcriptionFailed(let detail):
      return "Transcription failed: \(detail)"
    case .audioConversionFailed(let detail):
      return "Audio conversion failed: \(detail)"
    }
  }
}
