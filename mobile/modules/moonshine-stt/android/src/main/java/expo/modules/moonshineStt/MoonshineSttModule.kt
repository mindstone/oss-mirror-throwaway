package expo.modules.moonshineStt

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.os.Build
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Expo native module for on-device speech-to-text using Moonshine.
 *
 * Uses reflection to load MoonshineVoice SDK so the module compiles and runs
 * even when the SDK AAR isn't available (e.g. EAS Maven cache miss, older
 * Android versions). Falls back to isAvailable()=false in that case.
 */
class MoonshineSttModule : Module() {
  /** Transcriber instance (MoonshineVoice) — loaded lazily via reflection. */
  private var transcriber: Any? = null
  /** Filesystem path to the currently loaded model directory. */
  private var loadedModelPath: String? = null
  /** Lock for thread-safe access to transcriber state. */
  private val lock = Any()
  /** Cached result of SDK availability check. */
  private val sdkAvailable: Boolean by lazy {
    Build.VERSION.SDK_INT >= 35 && try {
      Class.forName("ai.moonshine.voice.MoonshineVoice")
      true
    } catch (_: ClassNotFoundException) {
      false
    }
  }

  override fun definition() = ModuleDefinition {
    Name("MoonshineStt")

    OnActivityEntersBackground {
      synchronized(lock) {
        transcriber = null
        loadedModelPath = null
      }
    }

    AsyncFunction("isAvailable") {
      sdkAvailable
    }

    AsyncFunction("loadModel") { modelDirPath: String ->
      ensureModelLoaded(modelDirPath)
    }

    AsyncFunction("transcribeAudioFile") { audioFilePath: String ->
      val samples = loadAndConvertAudio(audioFilePath)
      val t = synchronized(lock) {
        transcriber ?: throw Exception("Model not loaded. Call loadModel() first.")
      }
      try {
        val method = t.javaClass.getMethod("transcribe", FloatArray::class.java)
        method.invoke(t, samples) as String
      } catch (e: Exception) {
        throw Exception("Transcription failed: ${e.message}")
      }
    }

    AsyncFunction("isModelLoaded") {
      synchronized(lock) { transcriber != null }
    }

    AsyncFunction("unloadModel") {
      synchronized(lock) {
        transcriber = null
        loadedModelPath = null
      }
    }

    AsyncFunction("getModelPath") {
      synchronized(lock) { loadedModelPath }
    }
  }

  private fun ensureModelLoaded(modelDirPath: String) {
    if (!sdkAvailable) throw Exception("Moonshine SDK not available on this device")

    val cleanPath = if (modelDirPath.startsWith("file://")) {
      modelDirPath.removePrefix("file://")
    } else {
      modelDirPath
    }

    synchronized(lock) {
      if (loadedModelPath == cleanPath && transcriber != null) return
    }

    try {
      // Use reflection: MoonshineVoice.loadFromFiles(path, 5)
      val clazz = Class.forName("ai.moonshine.voice.MoonshineVoice")
      val companion = clazz.getDeclaredField("Companion").get(null)
      val method = companion.javaClass.getMethod("loadFromFiles", String::class.java, Int::class.java)
      val newTranscriber = method.invoke(companion, cleanPath, 5)
      synchronized(lock) {
        transcriber = newTranscriber
        loadedModelPath = cleanPath
      }
    } catch (e: Exception) {
      throw Exception("Failed to load model: ${e.message}")
    }
  }

  private fun loadAndConvertAudio(filePath: String): FloatArray {
    val cleanPath = if (filePath.startsWith("file://")) {
      filePath.removePrefix("file://")
    } else {
      filePath
    }

    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(cleanPath)
    } catch (e: Exception) {
      throw Exception("Audio conversion failed: Cannot open audio file: ${e.message}")
    }

    var audioTrackIndex = -1
    var format: MediaFormat? = null
    for (i in 0 until extractor.trackCount) {
      val trackFormat = extractor.getTrackFormat(i)
      val mime = trackFormat.getString(MediaFormat.KEY_MIME)
      if (mime?.startsWith("audio/") == true) {
        audioTrackIndex = i
        format = trackFormat
        break
      }
    }

    if (audioTrackIndex == -1 || format == null) {
      extractor.release()
      throw Exception("Audio conversion failed: No audio track found in file")
    }

    extractor.selectTrack(audioTrackIndex)

    val sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    val channelCount = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    val mime = format.getString(MediaFormat.KEY_MIME)
      ?: run {
        extractor.release()
        throw Exception("Audio conversion failed: Unknown audio format")
      }

    val decoder: MediaCodec
    try {
      decoder = MediaCodec.createDecoderByType(mime)
      decoder.configure(format, null, null, 0)
      decoder.start()
    } catch (e: Exception) {
      extractor.release()
      throw Exception("Audio conversion failed: Cannot create decoder: ${e.message}")
    }

    val pcmSamples = mutableListOf<Short>()
    val bufferInfo = MediaCodec.BufferInfo()
    var sawInputEos = false
    val timeoutUs = 10_000L
    var remainingIterations = 100_000

    try {
      while (remainingIterations-- > 0) {
        if (!sawInputEos) {
          val inputBufferId = decoder.dequeueInputBuffer(timeoutUs)
          if (inputBufferId >= 0) {
            val inputBuffer = decoder.getInputBuffer(inputBufferId)!!
            val sampleSize = extractor.readSampleData(inputBuffer, 0)
            if (sampleSize < 0) {
              decoder.queueInputBuffer(
                inputBufferId, 0, 0, 0,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM
              )
              sawInputEos = true
            } else {
              val presentationTimeUs = extractor.sampleTime
              decoder.queueInputBuffer(inputBufferId, 0, sampleSize, presentationTimeUs, 0)
              extractor.advance()
            }
          }
        }

        val outputBufferId = decoder.dequeueOutputBuffer(bufferInfo, timeoutUs)
        if (outputBufferId >= 0) {
          val outputBuffer = decoder.getOutputBuffer(outputBufferId)!!
          outputBuffer.position(bufferInfo.offset)
          outputBuffer.limit(bufferInfo.offset + bufferInfo.size)
          val shortBuffer = outputBuffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
          while (shortBuffer.hasRemaining()) {
            pcmSamples.add(shortBuffer.get())
          }
          decoder.releaseOutputBuffer(outputBufferId, false)

          if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            break
          }
        } else if (outputBufferId == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          continue
        }
      }

      if (remainingIterations <= 0) {
        throw Exception("Audio conversion failed: decoding timed out on potentially corrupt file")
      }
    } finally {
      decoder.stop()
      decoder.release()
      extractor.release()
    }

    if (pcmSamples.isEmpty()) {
      throw Exception("Audio conversion failed: No audio samples decoded")
    }

    val monoSamples: ShortArray = if (channelCount > 1) {
      ShortArray(pcmSamples.size / channelCount) { i ->
        var sum = 0L
        for (ch in 0 until channelCount) {
          sum += pcmSamples[i * channelCount + ch]
        }
        (sum / channelCount).toInt().toShort()
      }
    } else {
      pcmSamples.toShortArray()
    }

    val targetRate = 16000
    val resampledSamples: ShortArray = if (sampleRate != targetRate) {
      val ratio = sampleRate.toDouble() / targetRate
      val outputSize = (monoSamples.size / ratio).toInt()
      ShortArray(outputSize) { i ->
        val srcPos = i * ratio
        val srcIndex = srcPos.toInt().coerceIn(0, monoSamples.size - 2)
        val frac = (srcPos - srcIndex).toFloat()
        ((1 - frac) * monoSamples[srcIndex] + frac * monoSamples[srcIndex + 1]).toInt().toShort()
      }
    } else {
      monoSamples
    }

    return FloatArray(resampledSamples.size) { i ->
      resampledSamples[i].toFloat() / 32768f
    }
  }
}
