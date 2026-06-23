# Local STT Resources

Platform-specific binaries for local on-device speech-to-text using NVIDIA's Parakeet TDT 0.6B V3 model.

See also: `docs/project/VOICE_AND_AUDIO.md` section "3b. Local STT provider"

## macOS: fluidaudiocli-darwin

Universal binary (arm64 + x64) for CoreML-based transcription.

**Source:** [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio) (open source Swift SDK)

### Building from source

```bash
git clone https://github.com/FluidInference/FluidAudio.git
cd FluidAudio
swift build -c release --arch arm64 --arch x86_64
cp .build/apple/Products/Release/fluidaudiocli ../rebel-app/resources/local-stt/fluidaudiocli-darwin
```

### Dependencies

The `fluidaudiocli` binary requires `ESpeakNG.framework` at runtime for phoneme processing. This framework must be bundled with the app.

**ESpeakNG.framework source:** Extracted from FluidAudio's build artifacts or from the `ESpeakNG.xcframework` in the FluidAudio repo.

To update the framework:
1. Clone FluidAudio: `git clone https://github.com/FluidInference/FluidAudio.git`
2. Copy the macOS framework: `cp -R FluidAudio/Frameworks/ESpeakNG.xcframework/macos-arm64_x86_64/ESpeakNG.framework resources/local-stt/`

### Packaging
- CLI Source: `resources/local-stt/fluidaudiocli-darwin` (committed to git)
- Framework Source: `resources/local-stt/ESpeakNG.framework` (committed to git)
- CLI Packaged: `{app}/Contents/Resources/fluidaudiocli`
- Framework Packaged: `{app}/Contents/Frameworks/ESpeakNG.framework`
- Copied by `forge.config.cjs` Steps 6b and 6c
- RPATH patched to find framework via `install_name_tool`
- Both signed during afterSign hook

## Windows: sherpa-onnx-node

Uses the `sherpa-onnx-node` npm package with ONNX Runtime. Native binaries are copied to `app.asar.unpacked` during packaging via `forge.config.cjs` Step 5d.

No manual setup required.

## Models

Models are downloaded at runtime from HuggingFace (not bundled):

| Platform | Repository | Size |
|----------|------------|------|
| macOS | `FluidInference/parakeet-tdt-0.6b-v3-coreml` | ~482 MB |
| Windows | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` | ~670 MB |

Users download via Settings → Agents & Voice → Voice & Audio → Local (Experimental).
