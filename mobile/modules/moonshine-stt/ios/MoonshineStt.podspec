require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'MoonshineStt'
  s.version        = package['version']
  s.summary        = 'Moonshine local STT Expo module'
  s.description    = 'Expo native module wrapping MoonshineVoice for on-device speech-to-text'
  s.author         = 'Mindstone'
  s.homepage       = 'https://github.com/mindstone/rebel-app'
  s.license        = { type: 'MIT' }
  s.platforms      = { ios: '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/mindstone/rebel-app.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # Moonshine.xcframework (C/C++ core) + MoonshineVoice Swift sources
  # downloaded by EAS pre-install hook from moonshine-swift releases.
  # spm_dependency() was attempted but causes "redefinition of module 'Moonshine'"
  # in EAS builds — the SPM binary target's module.modulemap conflicts with
  # CocoaPods' module system when both define 'module Moonshine'.
  s.vendored_frameworks = 'Frameworks/Moonshine.xcframework'

  s.source_files = '*.{swift,h,m}', 'MoonshineVoice/*.swift'
  s.public_header_files = '*.h'

  s.libraries = 'c++'
end
